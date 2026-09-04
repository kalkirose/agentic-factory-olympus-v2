// Read-only credential checks. An external credential — a payment provider's
// key, a forge token, an API key the suite needs — fails silently until
// something expensive asks it a question. The project config names each one
// and the read-only command that proves it, and the question is asked at the
// launch door, before a slot, a workspace or a stack exists (ADR-0068), and
// again at the ship gate, before the PR that starts a CI round.
//
// The door is the cheap place because of the cache. A pass carries
// `validUntil` and the fingerprint of the value it proved, both on the
// instance ledger, and a door that finds a live pass for the same value asks
// the service nothing. A value that moved has a different fingerprint and
// misses the cache by construction, which is the whole rule: a credential is
// re-probed when it changes or when its answer ages out, and never otherwise.
//
// The gates inside a run stay, and they are guards rather than admissions: the
// door proved every declared credential before the run existed, so what these
// can still catch is a value that moved while the run was in flight. Their
// text says so.
//
// The gate has two halves. The first is parity: a credential is wired on every
// surface that will need it, not just on the one this host can see. A key that
// works here and is absent from CI answers yes at both gates and fails after a
// request is open, which is the most expensive place left to learn it. So the
// sweep reads every declared surface, names every gap it found in one park,
// and the owner wires all of them in one pass. The harness writes no secret
// anywhere, on any surface.
//
// The second half is the probe itself: a yes/no question whose exit code is
// the whole answer. The probe's own output never reaches the ledger or the
// park text, because the process holds a credential and anything it prints can
// carry one (ADR-0027).
import { readBranchFile } from '../isolation/clones.mjs';
import { readEvents } from '../ledger/ledger.mjs';
import { DEFAULT_PROBE_TIMEOUT_MS, parseProjectConfig } from '../config/project.mjs';
import { listRunEvents } from '../telemetry/readers.mjs';
import {
  declaredNames,
  declaredStore,
  fingerprint,
  lastFingerprints,
  readCredentials,
} from '../daemon/credentials.mjs';
import { runCommand } from './exec.mjs';
import {
  ACTOR,
  WORLD_GATE_NOTE,
  commandError,
  gateAck,
  parkDirective,
  runEvents,
  worldGate,
} from './shared.mjs';

// How long one green probe stands for the value it proved. A day: long enough
// that a burst of launches asks the service once, short enough that a
// credential a service retires is re-read the next day without anybody saying
// so. The key is the value's fingerprint, so the window never covers a value
// that changed (ADR-0068).
const PROBE_CACHE_MS = 24 * 60 * 60 * 1000;

/**
 * Checks every credential the project config declares: the declared surfaces
 * first, then the live probes, and stops at the first answer that is not yes.
 * @param {object} ctx the stage context, or the launch door's own: `paths`,
 *   `project`, `store` (where the stamps land) and `instanceStore`. A context
 *   with no `runId` is the door, which reads no acknowledgments.
 * @param {object} config the project config the caller is judged under
 * @param {{phase: 'launch'|'ship', cwd: string, env?: object, forge?: object,
 *   defaultBranch?: string, surfaceCredentials?: Array<object>|null,
 *   now?: number}} opts `forge` answers for the CI surface; without
 *   one a declared CI surface reads as unproven rather than as wired. `env` is
 *   the run's own environment; the machine's stored credential values are read
 *   here and ride in front of it. `surfaceCredentials` replaces the declared
 *   set the parity half reads, for a caller whose question is about the
 *   world's config rather than the blob it pinned (ADR-0068); the probe half
 *   always reads the caller's own config, because a probe names a command in
 *   it. `readCache` lets a green probe of the same value stand for this one:
 *   the launch door takes it, and the gates inside a run never do, because a
 *   run's gate exists to catch the value that moved under it. `now` is the
 *   clock the cache reads.
 * @returns {Promise<object|null>} a park directive, or null when every check
 *   passed and the caller may spend what comes next
 */
export async function probeCredentials(
  ctx,
  config,
  {
    phase,
    cwd,
    env,
    forge = null,
    defaultBranch = 'main',
    surfaceCredentials = null,
    readCache = false,
    now = Date.now(),
  },
) {
  const credentials = config.credentials ?? [];
  const surfaces = surfaceCredentials ?? credentials;
  if (credentials.length === 0 && surfaces.length === 0) return null;
  // The machine's store, read here rather than inherited from the window that
  // started the daemon. A value the owner replaced an hour ago is the value
  // this gate asks the service about (ADR-0064). A home that declares no store
  // reads nothing, records nothing, and the gate holds what it always held.
  const store = declaredStore(ctx.paths);
  const names = declaredNames({ credentials: [...credentials, ...surfaces] });
  const fresh = readCredentials(store, names);
  recordRead(ctx, store, fresh.records);
  const held = { ...process.env, ...env, ...fresh.values };
  const gap = await surfaceGate(ctx, surfaces, {
    phase,
    held,
    forge,
    defaultBranch,
    world: surfaceCredentials !== null,
  });
  if (gap) return gap;
  const cache = readCache ? probeCache(ctx, now) : new Map();
  for (const credential of credentials) {
    const directive = await probeOne(ctx, config, credential, {
      phase,
      cwd,
      env: { ...env, ...fresh.values },
      held,
      cache,
      now,
    });
    if (directive) return directive;
  }
  return null;
}

/**
 * One refused credential gate, said as a launch refusal rather than as a park.
 *
 * The door has no run to hold, so it has nothing to offer an acknowledgment
 * against and nothing to answer `retry` on: the console fixes the world and
 * launches again, and that costs a slot, a workspace and a stack less than a
 * run parked at readiness did (ADR-0068). The evidence is the gate's own, and
 * the fingerprint rides it, so a reader of the instance ledger can tell a dead
 * credential from a value somebody replaced badly (ADR-0064).
 * @param {object} directive the park directive `probeCredentials` returned
 * @returns {{message: string, detail: object}}
 */
export function credentialRefusal(directive) {
  const park = directive.park;
  const detail = park.detail ?? {};
  if (detail.gate === SURFACE_GATE) {
    return {
      message:
        'these credential surfaces are not wired, read from the default branch at the launch ' +
        `door:\n${(detail.gaps ?? []).map((gap) => `- ${surfaceLine(gap)}`).join('\n')}\n` +
        'Wire every one of them, then launch again. The harness writes no secret on any surface.',
      detail,
    };
  }
  if (typeof detail.gate === 'string' && detail.gate.startsWith(`${PROBE_GATE}:`)) {
    return {
      message:
        `the ${detail.credential} credential probe answered no at the launch door: the value ` +
        `in ${detail.variable} does not work. ${detail.history ?? ''}Replace it on this host, ` +
        'run the probe command yourself to confirm, then launch again. The probe output is not ' +
        'recorded, because it can carry the credential.',
      detail,
    };
  }
  // The probe did not answer — it could not run, or it ran past its bound and
  // was killed. The park text is already the whole account of it, minus the
  // options a door cannot offer.
  return { message: `${park.question.split('\n')[0]} Repair it, then launch again.`, detail };
}

/**
 * The project config the world holds, read from the default branch of the
 * project's bare clone: the file the next launch will read and the file CI
 * runs under. Null when it cannot be read or does not parse, and the caller
 * falls back to the config it already has, because a gate that could not look
 * states no judgment about what it did not see.
 * @param {object} ctx a context carrying `paths`, `project` and a payload with
 *   `configPath`
 * @param {string} branch the default branch
 */
export async function worldConfig(ctx, branch) {
  const path = ctx.payload?.configPath;
  if (typeof path !== 'string' || path.length === 0) return null;
  // The same reader the door uses, with the two choices a lane makes
  // differently: the clone exists already, because this run launched from it,
  // and a fetch that fails leaves the refs where the launch left them rather
  // than failing a gate over the network.
  const read = await readBranchFile(ctx.paths, ctx.project, {
    branch,
    path,
    fetch: 'best-effort',
  });
  if (read.error !== undefined) return null;
  try {
    return parseProjectConfig(read.text, `${branch}:${path}`, { launch: true });
  } catch {
    return null;
  }
}

/**
 * One read-only ask of one credential's probe, with nothing stamped either
 * way. It is what an external wait polls with (ADR-0069): a service that is
 * down answers no every ten minutes for as long as it is down, and a stamp per
 * poll would bury the run's own ledger in a hundred copies of one fact. The
 * caller stamps the answer it acts on, which is the green that ends the wait.
 *
 * @param {object} config the project config the run judges under
 * @param {{name: string, probe: string}} credential the declared credential
 * @param {{cwd: string, env?: object}} opts where the probe command runs
 * @returns {Promise<{ok: boolean, code: number|null, error?: string}>}
 *   `code === null` is a probe that could not run or ran past its bound, which
 *   is a defect of this machine and never a verdict about the credential — so
 *   it answers no and the wait carries on asking.
 */
export async function askProbe(config, credential, { cwd, env }) {
  const argv = config.commands?.[credential.probe];
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, code: null, error: `no command named ${credential.probe}` };
  }
  // No output file, for the reason the gate's own probe keeps none: the stream
  // can carry the credential it just asked about (ADR-0027).
  const run = await runCommand(argv, {
    cwd,
    env,
    log: false,
    timeoutMs: config.probes?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  });
  return { ok: run.code === 0, code: run.code, ...(run.error && { error: run.error }) };
}

/**
 * One credential's probe, asked by name, with the machine's stored values in
 * front of the copy this process inherited (ADR-0064). It is what the
 * deferred-proof watcher asks with: there is no run behind it, so there is no
 * run environment either, and the credential store is the whole of what the
 * command needs.
 * @param {ReturnType<import('../daemon/home.mjs').homePaths>} paths
 * @param {object} config the project config the default branch holds
 * @param {string} name the declared credential's name
 * @param {{cwd: string}} opts where the probe command runs
 */
export async function askDeclaredProbe(paths, config, name, { cwd }) {
  const credential = (config.credentials ?? []).find((entry) => entry.name === name);
  if (!credential) return { ok: false, code: null, error: `no credential named ${name}` };
  const fresh = readCredentials(declaredStore(paths), declaredNames(config));
  return askProbe(config, credential, { cwd, env: fresh.values });
}

/**
 * Every live probe pass on the instance ledger, keyed by variable and by the
 * fingerprint of the value that passed. The door that finds its value here
 * asks the service nothing: the answer is this project's, it is about this
 * exact value, and it has not aged out (ADR-0068). The instance ledger and not
 * a run's, because the cache is the instance's memory of what the world
 * answered, and it outlives every run that read it.
 */
function probeCache(ctx, now) {
  const cache = new Map();
  const at = new Date(now).toISOString();
  for (const e of readEvents(ctx.paths.instanceLedger)) {
    if (e.event !== 'credential-probe' || e.ok !== true) continue;
    if (e.project !== ctx.project) continue;
    if (typeof e.variable !== 'string' || typeof e.fingerprint !== 'string') continue;
    if (typeof e.validUntil !== 'string' || e.validUntil <= at) continue;
    cache.set(`${e.variable}:${e.fingerprint}`, e);
  }
  return cache;
}

/**
 * What this read found, against what the instance last recorded.
 *
 * A variable whose fingerprint moved stamps one `credential-rotated`: the
 * password changed on this host, and this is the moment the harness first saw
 * it. A variable no record covers stamps its fingerprint instead, so the read
 * after this one has something to compare against. Both are quiet, and a
 * variable that reads the same as last time stamps nothing at all.
 */
function recordRead(ctx, store, records) {
  if (records.length === 0) return;
  const known = lastFingerprints(readEvents(ctx.paths.instanceLedger));
  const unseen = [];
  for (const record of records) {
    const to = record.fingerprint ?? null;
    if (!known.has(record.name)) {
      unseen.push(record);
      continue;
    }
    const from = known.get(record.name);
    if (from === to) continue;
    ctx.instanceStore?.append('credential-rotated', {
      actor: ACTOR,
      project: ctx.project,
      name: record.name,
      from,
      to,
      source: record.source,
    });
  }
  if (unseen.length > 0) {
    ctx.instanceStore?.append('credential-fingerprints', {
      actor: ACTOR,
      project: ctx.project,
      store: store.kind,
      variables: unseen,
    });
  }
}

// The two gates here, by the check each one names. Both state a judgment about
// the world rather than a refusal the world gave: the first compares a
// declaration the run pinned at launch against the surfaces as they now stand,
// and the second reports what a command the project declared made of a value.
// Either can be wrong about the world in a way no retry can move, so either
// takes an acknowledgment (ADR-0062).
const SURFACE_GATE = 'credential-surface';
const PROBE_GATE = 'credential-probe';

// -- surface parity ----------------------------------------------------------

/**
 * Every declared surface of every declared credential, read in one pass. One
 * park names all of the gaps: a gate that reported them one at a time would
 * cost the owner a wiring round per surface, and each round ends in the same
 * place as the last.
 */
async function surfaceGate(ctx, credentials, { phase, held, forge, defaultBranch, world }) {
  if (credentials.length === 0) return null;
  // The operator's standing statement that this gate is wrong about the world.
  // The sweep runs anyway and every gap it finds is still stamped: what the ack
  // changes is whether the run stops, never what the ledger says was read
  // (ADR-0062). It is read once for the whole sweep, because the gate names
  // every gap in one park and is answered as one.
  const acked = gateAck(runEvents(ctx), SURFACE_GATE);
  const wantsCi = credentials.some((credential) => credential.ci);
  const secrets = wantsCi ? await ciSecretNames(forge) : { names: [], read: true };
  const workflowOf = workflowReader(ctx, defaultBranch);
  const gaps = [];
  for (const credential of credentials) {
    const missing = [];
    const value = held[credential.env];
    if (typeof value !== 'string' || value.trim().length === 0) {
      missing.push({ surface: 'host', name: credential.env });
    }
    const ci = credential.ci;
    if (ci) {
      if (!secrets.read) {
        missing.push({ surface: 'ci-secret', name: ci.secret, reason: 'unreadable' });
      } else if (!secrets.names.includes(ci.secret)) {
        missing.push({ surface: 'ci-secret', name: ci.secret });
      }
      for (const path of ci.workflows) {
        const text = await workflowOf(path);
        if (text === null) {
          missing.push({ surface: 'workflow', name: path, secret: ci.secret, reason: 'absent' });
        } else if (!referencesSecret(text, ci.secret)) {
          missing.push({ surface: 'workflow', name: path, secret: ci.secret });
        }
      }
    }
    ctx.store.append('credential-surface', {
      actor: ACTOR,
      phase,
      project: ctx.project,
      credential: credential.name,
      // Which declaration this read judged: the world's, read from the default
      // branch, or the blob the caller pinned. A ship asks about the CI that
      // will run, so it reads the world (ADR-0068).
      ...(world && { source: 'default-branch' }),
      ok: missing.length === 0,
      ...(missing.length > 0 && { missing }),
      // The record of a read that found gaps and stopped nothing names the
      // acknowledgment that let the run past, so the two never have to be
      // matched up by hand.
      ...(missing.length > 0 && acked && { acknowledged: acked.seq }),
    });
    for (const gap of missing) gaps.push({ credential: credential.name, ...gap });
  }
  if (gaps.length === 0 || acked) return null;
  return parkDirective('provisioning-gate', {
    ...worldGate(SURFACE_GATE),
    question:
      `These credential surfaces are not wired, read at the ${phase} gate:\n` +
      gaps.map((gap) => `- ${surfaceLine(gap)}`).join('\n') +
      '\nWire every one of them, then answer to read them again. ' +
      'The harness writes no secret on any surface.\n' +
      (world
        ? 'The surface list was read from the default branch, so it is the world as it ' +
          'stands and not the blob this run pinned. '
        : 'A surface list is a declaration the run pinned at launch, so this gate can be ' +
          'wrong about a surface that was deliberately retired since. ') +
      GUARD_NOTE +
      WORLD_GATE_NOTE,
    detail: { gate: SURFACE_GATE, gaps },
  });
}

// What a gate inside a run is for, said at the gate. The launch door proves
// every declared credential before a run exists (ADR-0068), so a gate that
// stops a live run is answering a question about a value that moved since.
const GUARD_NOTE =
  'The launch door proved every declared credential before this run existed, so ' +
  'what this gate found is a change since that read. ';

/**
 * The names of the repository's CI secrets, and whether they could be read at
 * all. Names only: the forge serves no values, and the harness asks for none.
 * A list nobody could read is not a statement that a secret is missing, so it
 * comes back as unread and every declared secret reads as unproven.
 */
async function ciSecretNames(forge) {
  if (!forge || typeof forge.ciSecrets !== 'function') return { names: [], read: false };
  try {
    const names = await forge.ciSecrets();
    if (!Array.isArray(names)) return { names: [], read: false };
    return { names, read: true };
  } catch {
    return { names: [], read: false };
  }
}

/**
 * Reads a workflow file from the default branch in the project's bare clone.
 * The default branch is the authority: it is the file the forge will run, and
 * the run's own tree can say anything. Each path is read once per gate, and a
 * file that is not there comes back as null.
 */
function workflowReader(ctx, branch) {
  const cache = new Map();
  return async (path) => {
    if (cache.has(path)) return cache.get(path);
    // The one reader of the default branch, with the two choices a lane makes:
    // the clone exists already, because this run launched from it, and a fetch
    // that fails leaves the refs where the launch left them rather than
    // failing a gate over the network (ADR-0068). Each path is read once per
    // gate, so the fetch it carries is one per workflow file and not one per
    // credential surface.
    const read = await readBranchFile(ctx.paths, ctx.project, {
      branch,
      path,
      fetch: 'best-effort',
    });
    const text = read.error === undefined ? read.text : null;
    cache.set(path, text);
    return text;
  };
}

/** True when a workflow reads the named secret. The name is one identifier. */
function referencesSecret(text, name) {
  return new RegExp(`secrets\\.${name}(?![A-Za-z0-9_])`).test(text);
}

function surfaceLine(gap) {
  if (gap.surface === 'host') return `${gap.credential}: ${gap.name} is not on this host`;
  if (gap.surface === 'ci-secret') {
    return gap.reason === 'unreadable'
      ? `${gap.credential}: the repository's secret list could not be read, so ${gap.name} is unproven there`
      : `${gap.credential}: the repository holds no secret named ${gap.name}`;
  }
  return gap.reason === 'absent'
    ? `${gap.credential}: ${gap.name} is not on the default branch, so nothing there reads ${gap.secret}`
    : `${gap.credential}: ${gap.name} does not reference secrets.${gap.secret}`;
}

// -- the live probe ----------------------------------------------------------

async function probeOne(
  ctx,
  config,
  { name, env: variable, probe },
  { phase, cwd, env, held, cache, now },
) {
  // The value this probe carries, named without being revealed. Every answer
  // carries it, so a refusal is tied to the exact value the service refused and
  // a later reader can tell a dead credential from a stale copy (ADR-0064).
  const mark = fingerprint(held[variable]);
  const stamp = (fields) =>
    ctx.store.append('credential-probe', {
      actor: ACTOR,
      phase,
      project: ctx.project,
      credential: name,
      variable,
      ...(mark !== null && { fingerprint: mark }),
      ...fields,
    });
  // A pass this instance already holds for this exact value, still inside its
  // window. The service was asked and it answered; asking again inside a day
  // buys nothing and costs a round trip per credential per launch (ADR-0068).
  // Only the door reads the cache. A gate inside a run is there to catch a
  // value that moved while the run was in flight, and one that stood on a
  // day-old answer would catch nothing at all. The answer is stamped either
  // way, so the ledger says what every gate read.
  const cached = mark === null ? undefined : cache?.get(`${variable}:${mark}`);
  if (cached) {
    stamp({ ok: true, cached: cached.seq, validUntil: cached.validUntil });
    return null;
  }
  // The probe reads the variable out of the environment it is spawned with —
  // the same environment the suite runs with, whole, because a project-config
  // command keeps every name a seat would lose (ADR-0023), and with the
  // machine's stored value in front of the inherited copy (ADR-0064). The
  // surface sweep has already answered for the value's presence.
  //
  // The one command in the harness that writes no output file. Every other
  // caller keeps the stream on disk so a record can point at it (ADR-0043);
  // this one is a yes/no question whose exit code is the whole answer, and its
  // output can carry the credential it just asked about. Nothing reads that
  // output, so there is nothing here for a file to make readable — only a key
  // for a file to leave lying about (ADR-0027).
  const run = await runCommand(config.commands[probe], {
    cwd,
    env,
    log: false,
    // A probe that never returns holds whatever is awaiting it, and at the
    // door that is the control drain with the frontier sweep behind it. The
    // bound is the project's, because the project wrote the command (ADR-0068).
    timeoutMs: config.probes?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  });
  if (run.code === null) {
    // The probe did not answer: it could not run at all, or it ran past its
    // bound and was killed. Either way this is a defect of this machine and
    // not a verdict about the credential, so it takes the route every
    // unrunnable command takes rather than accusing the key. Nothing is
    // cached either way — only an answer of yes is worth standing on later.
    const timedOut = run.timedOut === true;
    stamp({ ok: false, reason: timedOut ? 'timeout' : 'unrunnable' });
    return commandError(
      ctx,
      timedOut ? 'probe-timeout' : 'probe-command-error',
      (timedOut
        ? `The ${name} credential probe did not answer: it ${run.error}, and was killed.\n`
        : `The ${name} credential probe could not run: ${run.error}\n`) +
        GUARD_NOTE +
        'Repair the environment, then answer "retry" for one more attempt, or ' +
        '"abandon" to close the run.',
      { credential: name, error: run.error, ...(timedOut && { timedOut: true }) },
    );
  }
  if (run.code !== 0) {
    // Per credential, not per probe run: an acknowledgment of one credential's
    // probe says nothing about another's, and the key carries the name so it
    // cannot spread (ADR-0062).
    const gate = `${PROBE_GATE}:${name}`;
    const acked = gateAck(runEvents(ctx), gate);
    stamp({ ok: false, reason: 'refused', code: run.code, ...(acked && { acknowledged: acked.seq }) });
    if (acked) return null;
    // Which of the two refusals this is. It rides the detail as well as the
    // question, because the door renders its own refusal from the detail and
    // the diagnosis is the most useful sentence either reader gets.
    const history = historyLine(ctx, variable, mark);
    return parkDirective('provisioning-gate', {
      ...worldGate(gate),
      question:
        `The ${name} credential probe answered no at the ${phase} gate: ` +
        `the value in ${variable} does not work (exit ${run.code}). ` +
        history +
        'Replace it on this host, run the probe command yourself to confirm, then answer to ' +
        'probe again. The probe output is not recorded here, because it can carry the credential.\n' +
        GUARD_NOTE +
        'The verdict is the probe command\'s, so this gate is wrong wherever the command is. ' +
        WORLD_GATE_NOTE,
      detail: {
        gate,
        credential: name,
        variable,
        ...(mark !== null && { fingerprint: mark }),
        ...(history.length > 0 && { history }),
      },
    });
  }
  // The window this pass stands for, on the record beside the value it proved.
  // A later gate reads it off the instance ledger and asks the service nothing
  // while it holds (ADR-0068).
  stamp({ ok: true, validUntil: new Date(now + PROBE_CACHE_MS).toISOString() });
  return null;
}

/**
 * Which of the two failures this is, in one sentence.
 *
 * A refused probe has two causes and they take opposite repairs. Either the
 * value on this host is the one that passed before, and the service has stopped
 * accepting it, so the credential itself has to be replaced at the service.
 * Or the value moved since the last pass, and the new one is refused, so what
 * was placed on this host is what to look at. The last passing probe of this
 * variable, in any run of this project, says which (ADR-0064). Nothing before
 * the first recorded pass, where the park says what it always said.
 */
function historyLine(ctx, variable, mark) {
  const passed = lastPass(ctx, variable);
  if (passed === null || mark === null) return '';
  const day = String(passed.ts).slice(0, 10);
  return passed.fingerprint === mark
    ? `The stored value is unchanged since it last passed on ${day}; the service now refuses it; ` +
        'the credential itself needs replacing. '
    : `The stored value changed since it last passed on ${day}; the new value is refused; ` +
        'check the value placed on this host. ';
}

/**
 * The newest probe of this variable that answered yes, over every run of this
 * project, live and archived. A pass is a fact about the value and the service,
 * not about the run that asked, so the run that recorded it does not matter.
 */
function lastPass(ctx, variable) {
  let newest = null;
  for (const { events } of listRunEvents(ctx.paths, { project: ctx.project })) {
    for (const e of events) {
      if (e.event !== 'credential-probe' || e.ok !== true) continue;
      if (e.variable !== variable || typeof e.fingerprint !== 'string') continue;
      if (newest === null || e.ts > newest.ts) newest = e;
    }
  }
  return newest;
}
