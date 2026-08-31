// Read-only credential checks. An external credential — a payment provider's
// key, a forge token, an API key the suite needs — fails silently until
// something expensive asks it a question. The project config names each one
// and the read-only command that proves it, and the run asks that question at
// the two gates where the next step costs money: the launch gate, before the
// first seat, and the ship gate, before the PR that starts a CI round.
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
import { cloneDir, fetchClone } from '../isolation/clones.mjs';
import { git } from '../isolation/git.mjs';
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

/**
 * Checks every credential the project config declares: the declared surfaces
 * first, then the live probes, and stops at the first answer that is not yes.
 * @param {object} ctx the stage context
 * @param {object} config the project config
 * @param {{phase: 'launch'|'ship', cwd: string, env?: object, forge?: object,
 *   defaultBranch?: string}} opts `forge` answers for the CI surface; without
 *   one a declared CI surface reads as unproven rather than as wired.
 * @returns {Promise<object|null>} a park directive, or null when every check
 *   passed and the caller may spend what comes next
 */
export async function probeCredentials(
  ctx,
  config,
  { phase, cwd, env, forge = null, defaultBranch = 'main' },
) {
  const gap = await surfaceGate(ctx, config, { phase, env, forge, defaultBranch });
  if (gap) return gap;
  for (const credential of config.credentials ?? []) {
    const directive = await probeOne(ctx, config, credential, { phase, cwd, env });
    if (directive) return directive;
  }
  return null;
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
async function surfaceGate(ctx, config, { phase, env, forge, defaultBranch }) {
  const credentials = config.credentials ?? [];
  if (credentials.length === 0) return null;
  // The operator's standing statement that this gate is wrong about the world.
  // The sweep runs anyway and every gap it finds is still stamped: what the ack
  // changes is whether the run stops, never what the ledger says was read
  // (ADR-0062). It is read once for the whole sweep, because the gate names
  // every gap in one park and is answered as one.
  const acked = gateAck(runEvents(ctx), SURFACE_GATE);
  const held = { ...process.env, ...env };
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
      credential: credential.name,
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
      'A surface list is a declaration the run pinned at launch, so this gate can be ' +
      'wrong about a surface that was deliberately retired since. ' +
      WORLD_GATE_NOTE,
  });
}

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
  const clone = cloneDir(ctx.paths, ctx.project);
  const cache = new Map();
  let fetched = false;
  return async (path) => {
    if (cache.has(path)) return cache.get(path);
    if (!fetched) {
      fetched = true;
      // The launch fetched this clone moments ago; a fetch that fails here
      // leaves the refs where the launch left them rather than failing a gate
      // over the network.
      await fetchClone(clone).catch(() => {});
    }
    let text = null;
    try {
      text = await git(['show', `${branch}:${path}`], { cwd: clone });
    } catch {
      text = null;
    }
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

async function probeOne(ctx, config, { name, env: variable, probe }, { phase, cwd, env }) {
  const stamp = (fields) =>
    ctx.store.append('credential-probe', {
      actor: ACTOR,
      phase,
      credential: name,
      variable,
      ...fields,
    });
  // The probe reads the variable out of the environment it is spawned with —
  // the same environment the suite runs with, whole, because a project-config
  // command keeps every name a seat would lose (ADR-0023). The surface sweep
  // has already answered for the value's presence.
  //
  // The one command in the harness that writes no output file. Every other
  // caller keeps the stream on disk so a record can point at it (ADR-0043);
  // this one is a yes/no question whose exit code is the whole answer, and its
  // output can carry the credential it just asked about. Nothing reads that
  // output, so there is nothing here for a file to make readable — only a key
  // for a file to leave lying about (ADR-0027).
  const run = await runCommand(config.commands[probe], { cwd, env, log: false });
  if (run.code === null) {
    // The probe could not run at all — a defect of this machine, not a verdict
    // about the credential, so it takes the route every unrunnable command
    // takes rather than accusing the key.
    stamp({ ok: false, reason: 'unrunnable' });
    return commandError(
      ctx,
      'probe-command-error',
      `The ${name} credential probe could not run: ${run.error}\n` +
        'Repair the environment, then answer "retry" for one more attempt, or ' +
        '"abandon" to close the run.',
      { credential: name, error: run.error },
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
    return parkDirective('provisioning-gate', {
      ...worldGate(gate),
      question:
        `The ${name} credential probe answered no at the ${phase} gate: ` +
        `the value in ${variable} does not work (exit ${run.code}). ` +
        'Replace it on this host, run the probe command yourself to confirm, then answer to ' +
        'probe again. The probe output is not recorded here, because it can carry the credential.\n' +
        'The verdict is the probe command\'s, so this gate is wrong wherever the command is. ' +
        WORLD_GATE_NOTE,
    });
  }
  stamp({ ok: true });
  return null;
}
