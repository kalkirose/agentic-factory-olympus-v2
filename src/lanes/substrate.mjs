// The substrate probe: the question the operational-fix route asks this host
// before it spends a layer re-run on it. An env finding says the failure sits
// outside the tree, and the route's answer is to fix the substrate and judge
// the layers again. On a host that is still broken those layers are doomed
// before they start, and a spectrum of them takes an hour to report what a
// socket reports in a second (2026-08-21: one run re-ran two integration
// layers for 1 h 28 m against a wedged host, then parked with evidence the
// daemon could have read at the start).
//
// The probe holds no port list. The stack publishes ephemeral ports, so it
// reads them back from the compose project the run's stack rose as, and then
// asks every published port the same question on both loopback families:
// connect, write a few bytes, read an answer, all inside one bounded deadline.
// The deadline is the probe's own question to a socket, not a clock over a
// run. Nothing here judges a run alive or dead, and no route reads elapsed
// time (ADR-0022).
//
// Two answers are failures, and each is a proof rather than an inference:
//
//   - One family answers and the other accepts the connection and sends
//     nothing back. The port, the bytes and the service are the same on both,
//     so the only difference left is the path through the host. That is the
//     wedged relay this probe was built for: a stale host relay held the
//     IPv6-loopback binds of a dead stack, accepted every connection, relayed
//     nothing, and outlived a restart of the container engine.
//   - No family accepts a connection at all, on a port the stack reports as
//     published. Nothing listens where the stack says it publishes.
//
// Silence on both families is not a failure. A protocol that waits for a
// complete message before it answers anything is silent for an honest reason,
// and a park on that reading would cost the owner a night for a healthy host.
// A family that refuses while the other answers is not a failure either: a
// project may publish on one family by design.
import { createConnection } from 'node:net';
import { runCommand } from './exec.mjs';
import {
  ACTOR,
  WORLD_GATE_NOTE,
  gateAck,
  parkDirective,
  runEvents,
  worldGate,
} from './shared.mjs';

// The check this gate names. Its park states an inference over a live read —
// two loopback families given the same bytes — so it can be wrong about a host
// that publishes on one family for a reason the probe cannot see (ADR-0062).
const SUBSTRATE_GATE = 'substrate-probe';

// The two loopback families, in the order the evidence names them. A refusal
// on one of them is not a verdict, so a host that runs one family stays clean.
export const LOOPBACK = Object.freeze(['127.0.0.1', '::1']);

// What the probe writes. No payload draws an answer from every protocol, so
// this is the one that draws an answer from most: a response from a web
// server, a protocol error from a line-oriented server. What a given port
// makes of it does not matter, because the reading is the comparison between
// two families that got the same bytes.
const PROBE_WRITE = 'GET / HTTP/1.0\r\n\r\n';

// One deadline for one exchange. Every attempt runs at once, so this bounds
// the whole probe as well.
const DEADLINE_MS = 3000;

// The ports one probe asks about. A stack publishes a handful; a stack that
// publishes dozens gets the first of them rather than a probe that outlives
// the re-run it is there to save.
const MAX_PORTS = 12;

// Compose reads the whole project back in one document. The tail limit of the
// ordinary command runner would cut the head off it, so the read declares its
// own.
const PS_OUTPUT_LIMIT = 400_000;

/**
 * The gate the operational-fix route passes before it re-runs a layer.
 * Stamps `substrate-probe` and returns a park directive on a failed probe.
 * @param {object} ctx the stage context
 * @param {{stack: string|null|undefined, composeCommand: string[]|undefined,
 *   cwd: string, io?: object}} opts `io` substitutes the command runner, the
 *   family list and the deadline (tests only).
 * @returns {Promise<object|null>} a park directive, or null when the probe
 *   was clean, had nothing to ask, or could not read the stack
 */
export async function substrateGate(ctx, { stack, composeCommand, cwd, io = {} }) {
  // A project with no stack publishes nothing this probe could ask about, and
  // a host with no compose argv has no stack either. Both leave the route
  // exactly as it was before the probe existed.
  if (!stack || !Array.isArray(composeCommand) || composeCommand.length === 0) return null;
  const acked = gateAck(runEvents(ctx), SUBSTRATE_GATE);
  const result = await probeSubstrate({ stack, composeCommand, cwd, ...io });
  // The probe runs and its answer is stamped whether or not an acknowledgment
  // stands. What the ack changes is whether the run stops; the reading of the
  // host is evidence either way, and the stamp names the ack that let it past.
  ctx.store.append('substrate-probe', {
    actor: ACTOR,
    stack,
    ...result,
    ...(result.state === 'failed' && acked && { acknowledged: acked.seq }),
  });
  if (result.state !== 'failed' || acked) return null;
  return parkDirective('provisioning-gate', {
    ...worldGate(SUBSTRATE_GATE),
    question: `${gateQuestion(result)}\n${WORLD_GATE_NOTE}`,
  });
}

/**
 * Reads the stack's published ports and asks each one of them the same
 * question on both loopback families.
 * @returns {Promise<{state: 'clean'|'failed'|'unread', reason?: string,
 *   addresses?: string[], ports?: number[], attempts?: object[],
 *   failures?: object[]}>} `unread` is a probe that judged nothing: the
 *   caller carries on as it would have without it.
 */
export async function probeSubstrate({
  stack,
  composeCommand,
  cwd,
  run = runCommand,
  addresses = LOOPBACK,
  deadlineMs = DEADLINE_MS,
}) {
  const listed = await run([...composeCommand, '-p', stack, 'ps', '--format', 'json'], {
    cwd,
    outputLimit: PS_OUTPUT_LIMIT,
  });
  if (listed.code !== 0) return { state: 'unread', reason: 'stack-unreadable' };
  const published = publishedPorts(listed.output);
  if (published === null) return { state: 'unread', reason: 'stack-unreadable' };
  if (published.length === 0) return { state: 'unread', reason: 'no-published-ports' };
  const ports = published.slice(0, MAX_PORTS);
  const attempts = await Promise.all(
    ports.flatMap((entry) => addresses.map((address) => attempt(address, entry.port, deadlineMs))),
  );
  const failures = [];
  for (const entry of ports) {
    const mine = attempts.filter((a) => a.port === entry.port);
    const answered = mine.filter((a) => a.state === 'answered');
    const silent = mine.filter((a) => a.state === 'silent');
    if (answered.length > 0 && silent.length > 0) {
      failures.push({ ...entry, reason: 'no-relay', attempts: mine });
    } else if (answered.length === 0 && silent.length === 0) {
      failures.push({ ...entry, reason: 'unreachable', attempts: mine });
    }
  }
  return {
    state: failures.length > 0 ? 'failed' : 'clean',
    addresses: [...addresses],
    ports: ports.map((entry) => entry.port),
    attempts,
    ...(failures.length > 0 && { failures }),
  };
}

// -- reading the stack -------------------------------------------------------

/**
 * The TCP ports a compose project publishes, from its own `ps` document.
 * Compose has written that document both ways — one JSON array, and one JSON
 * object per line — so both are read. Returns null when neither parses: a
 * document nobody can read is not a statement that a stack publishes nothing.
 */
export function publishedPorts(text) {
  const entries = parseDocument(text);
  if (entries === null) return null;
  const ports = new Map();
  for (const entry of entries) {
    const service = entry?.Service ?? entry?.Name ?? null;
    for (const publisher of entry?.Publishers ?? []) {
      const port = Number(publisher?.PublishedPort);
      const protocol = publisher?.Protocol ?? 'tcp';
      if (!Number.isInteger(port) || port <= 0 || protocol !== 'tcp') continue;
      if (!ports.has(port)) ports.set(port, { port, ...(service && { service }) });
    }
  }
  return [...ports.values()].sort((a, b) => a.port - b.port);
}

function parseDocument(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Not one document: the older per-line form, or a runner that wrote
    // something else entirely alongside it.
  }
  const entries = [];
  let parsedALine = false;
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (candidate.length === 0) continue;
    try {
      entries.push(JSON.parse(candidate));
      parsedALine = true;
    } catch {
      // A line that is not JSON is noise around the document, never a service.
    }
  }
  return parsedALine ? entries : null;
}

// -- one attempt -------------------------------------------------------------

/**
 * Connects, writes, and waits for bytes back, inside one deadline.
 * `answered` is the peer sending something; `silent` is a connection that
 * carried nothing back; `refused` is a connection that never opened.
 */
function attempt(address, port, deadlineMs) {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    const socket = createConnection({ host: address, port });
    const finish = (state, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ port, address, state, ...(detail && { detail }) });
    };
    const timer = setTimeout(
      () =>
        finish(
          connected ? 'silent' : 'refused',
          connected ? `no answer in ${deadlineMs} ms` : `no connection in ${deadlineMs} ms`,
        ),
      deadlineMs,
    );
    socket.on('connect', () => {
      connected = true;
      socket.write(PROBE_WRITE);
    });
    socket.on('data', () => finish('answered'));
    socket.on('error', (error) => finish(connected ? 'silent' : 'refused', error.code ?? error.message));
    socket.on('close', () => finish(connected ? 'silent' : 'refused', 'closed without an answer'));
  });
}

// -- what the gate says ------------------------------------------------------

function gateQuestion(result) {
  return (
    "The substrate probe answered no, read before any layer re-run: the run stack's " +
    'published ports do not answer on both loopback families.\n' +
    result.failures.map((failure) => `- ${failureLine(failure)}`).join('\n') +
    '\nRepair the host, then answer to probe again. A stale port relay can hold one ' +
    'loopback family on its own and survive a restart of the container engine. ' +
    'No layer runs against this host until the probe comes back clean.'
  );
}

function failureLine(failure) {
  const where = failure.service ? `port ${failure.port} (${failure.service})` : `port ${failure.port}`;
  const detail = failure.attempts.map((a) => `${a.address} ${attemptWord(a)}`).join(', ');
  const verdict =
    failure.reason === 'no-relay'
      ? 'one loopback family relays and the other does not'
      : 'no loopback family accepted a connection';
  return `${where}: ${verdict} — ${detail}`;
}

function attemptWord(a) {
  if (a.state === 'answered') return 'answered';
  if (a.state === 'silent') return `connected and sent nothing back (${a.detail})`;
  return `refused the connection (${a.detail})`;
}
