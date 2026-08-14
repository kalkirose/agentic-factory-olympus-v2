// Read-only credential probes. An external credential — a payment provider's
// key, a forge token, an API key the suite needs — fails silently until
// something expensive asks it a question. The project config names each one
// and the read-only command that proves it, and the run asks that question at
// the two gates where the next step costs money: the launch gate, before the
// first seat, and the ship gate, before the PR that starts a CI round.
//
// A probe is a yes/no question and its exit code is the whole answer. The
// probe's own output never reaches the ledger or the park text: the process
// holds a credential, and anything it prints can carry one (ADR-0027).
import { runCommand } from './exec.mjs';
import { ACTOR, commandError, parkDirective } from './shared.mjs';

/**
 * Probes every credential the project config declares, in order, and stops at
 * the first one that does not answer yes.
 * @param {object} ctx the stage context
 * @param {object} config the project config
 * @param {{phase: 'launch'|'ship', cwd: string, env?: object}} opts
 * @returns {Promise<object|null>} a park directive, or null when every probe
 *   passed and the caller may spend what comes next
 */
export async function probeCredentials(ctx, config, { phase, cwd, env }) {
  for (const credential of config.credentials ?? []) {
    const directive = await probeOne(ctx, config, credential, { phase, cwd, env });
    if (directive) return directive;
  }
  return null;
}

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
  // command keeps every name a seat would lose (ADR-0023). An absent value is
  // an answer already, and a cheaper one than the round trip.
  const held = { ...process.env, ...env }[variable];
  if (typeof held !== 'string' || held.trim().length === 0) {
    stamp({ ok: false, reason: 'absent' });
    return parkDirective('provisioning-gate', {
      question:
        `The ${name} credential is not on this host: ${variable} is unset at the ${phase} gate. ` +
        'Set it, then answer to probe again.',
    });
  }
  const run = await runCommand(config.commands[probe], { cwd, env });
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
    stamp({ ok: false, reason: 'refused', code: run.code });
    return parkDirective('provisioning-gate', {
      question:
        `The ${name} credential probe answered no at the ${phase} gate: ` +
        `the value in ${variable} does not work (exit ${run.code}). ` +
        'Replace it on this host, run the probe command yourself to confirm, then answer to ' +
        'probe again. The probe output is not recorded here, because it can carry the credential.',
    });
  }
  stamp({ ok: true });
  return null;
}
