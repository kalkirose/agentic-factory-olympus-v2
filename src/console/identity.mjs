// Who a console command came from. The stamp used to be `console:<user>`, and
// one machine runs more than one operator session: two sessions under one
// login stamped the same name, so a ledger could not say which of them
// answered a park. The stamp is now `console:<user>:<id>`, where the id names
// the session and stays the same for every command that session runs.
//
// The id is derived, never configured, because an identity that needs setup is
// an identity nobody has on the night it is needed. Three sources, in order:
//
//   1. `OLYMPUS_CONSOLE_ID` — the operator's own label, used as written. The
//      cure for every case below, and the only way to name a session.
//   2. The terminal's session variable, when the terminal sets one. Every
//      child of that window inherits it, so a wrapper process between the
//      shell and this binary changes nothing.
//   3. The parent process id: the shell that ran the command.
//
// Failure modes of the derived id, both cured by the override: an operating
// system reuses a pid, so a shell started after another one exited can inherit
// its id (two sessions, one stamp, separated in time); and where no session
// variable exists, a wrapper that spawns a fresh process per invocation
// (`npm run`, a `.cmd` shim) is the parent, so one session stamps a new id per
// command. Where nothing at all is derivable the stamp falls back to
// `console:<user>` — the old stamp is worse than a session id and better than
// a refused command or an invented one.
import { userInfo } from 'node:os';
import { createHash } from 'node:crypto';

const OVERRIDE = 'OLYMPUS_CONSOLE_ID';
// The variables a terminal sets once per window and passes to every child:
// Windows Terminal and the macOS terminals. Both hold a value unique to the
// window, which is exactly the scope of one operator session.
const SESSION_VARS = ['WT_SESSION', 'TERM_SESSION_ID'];
const ID_LENGTH = 8;
const LABEL_MAX = 16;

/**
 * The actor stamp a console command carries.
 * @param {{env?: object, username?: string, ppid?: number}} [source]
 * @returns {string} `console:<user>:<id>`, or `console:<user>` when this host
 *   offers no session identity at all.
 */
export function consoleActor(source = {}) {
  const user = source.username ?? userInfo().username;
  const id = sessionId(source);
  return id === null ? `console:${user}` : `console:${user}:${id}`;
}

/**
 * The session half of the stamp, or null when nothing here identifies one.
 * @param {{env?: object, ppid?: number}} [source]
 */
export function sessionId({ env = process.env, ppid = process.ppid } = {}) {
  const label = readLabel(env[OVERRIDE]);
  if (label !== null) return label;
  for (const name of SESSION_VARS) {
    const value = env[name];
    // The name rides into the digest: two terminals that happen to hand out
    // the same string stay two sessions.
    if (typeof value === 'string' && value.trim().length > 0) {
      return digest(`${name}=${value.trim()}`);
    }
  }
  return Number.isInteger(ppid) && ppid > 0 ? digest(`ppid=${ppid}`) : null;
}

/**
 * An operator's label, reduced to what an actor stamp can carry. The stamp is
 * read by eye and matched by machine, so whitespace, colons and everything
 * else outside a short word is dropped rather than escaped; a label with
 * nothing left counts as unset and the derivation continues behind it.
 */
function readLabel(value) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, LABEL_MAX);
  return clean.length > 0 ? clean : null;
}

function digest(seed) {
  return createHash('sha256').update(seed).digest('hex').slice(0, ID_LENGTH);
}
