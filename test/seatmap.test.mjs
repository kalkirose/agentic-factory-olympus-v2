import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEATS,
  seatDef,
  seatExecutesSuite,
  DEFAULT_MODEL,
  CERTIFICATION_MODEL,
  FALLBACK_MODEL,
  DEFAULT_EFFORT,
} from '../src/seats/seatmap.mjs';
import { assembleSeatPrompt, correctivePrompt, ONE_TURN_RULE } from '../src/seats/prompt.mjs';
import { claudeSeatCommand, parseClaudeLine } from '../src/seats/claude.mjs';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { verdict: { type: 'string' } },
  required: ['verdict'],
};

// The ids are pinned as literals on purpose: a seat map that quietly moved to
// another model or a lower effort would still agree with its own constants.
const CERTIFICATION_SEATS = ['verdict-triage', 'fury-verifier', 'eval'];

test('seats run Claude Opus 5 at xhigh, except the certification spine', () => {
  assert.equal(DEFAULT_MODEL, 'claude-opus-5');
  assert.equal(DEFAULT_EFFORT, 'xhigh');
  for (const [name, def] of Object.entries(SEATS)) {
    const expected = CERTIFICATION_SEATS.includes(name) ? 'claude-fable-5-1' : 'claude-opus-5';
    assert.equal(def.model, expected, name);
    assert.equal(def.effort, CERTIFICATION_SEATS.includes(name) ? 'high' : 'xhigh', name);
  }
});

test('the certification spine runs Claude Fable 5.1', () => {
  assert.equal(CERTIFICATION_MODEL, 'claude-fable-5-1');
  assert.notEqual(CERTIFICATION_MODEL, DEFAULT_MODEL);
  for (const name of CERTIFICATION_SEATS) {
    assert.equal(seatDef(name).model, CERTIFICATION_MODEL, name);
  }
});

// Opus 5 is what a refused certification seat degrades to. A seat already on
// Opus 5 has nothing below it, which is why the substitute and the default
// name the same id.
test('Claude Opus 5 is the substitute for a refused certification seat', () => {
  assert.equal(FALLBACK_MODEL, 'claude-opus-5');
  assert.equal(FALLBACK_MODEL, DEFAULT_MODEL);
  for (const name of CERTIFICATION_SEATS) {
    assert.notEqual(seatDef(name).model, FALLBACK_MODEL, name);
  }
});

test('web tools and Explore subagents go to the named seats only', () => {
  for (const [name, def] of Object.entries(SEATS)) {
    assert.equal(def.web, ['spec-birth', 'dev', 'repair-dev'].includes(name), `web: ${name}`);
    assert.equal(def.explore, ['dev', 'repair-dev'].includes(name) ? 2 : 0, `explore: ${name}`);
  }
});

test('an unknown seat is an error, never a default', () => {
  assert.throws(() => seatDef('minos'), /unknown seat/);
});

// The machine's secrets follow this flag and nothing else, so the seats that
// carry it are a policy statement, not an implementation detail.
test('only the seats that run the project suite are marked as executing it', () => {
  for (const [name, def] of Object.entries(SEATS)) {
    const expected = ['dev', 'repair-dev', 'suite'].includes(name);
    assert.equal(def.executesSuite, expected, name);
    assert.equal(seatExecutesSuite(name), expected, name);
  }
  // Fail closed: a name the map does not hold gets no credentials.
  assert.equal(seatExecutesSuite('minos'), false);
});

test('the prompt carries both blocks, the report path, and the policy lines', () => {
  const prompt = assembleSeatPrompt({
    seat: 'spec-gate',
    def: seatDef('spec-gate'),
    reportPath: '/runs/r1/reports/spec-gate.json',
    schema: SCHEMA,
    roleBlock: 'ROLE: check the born spec against the card.',
  });
  assert.ok(prompt.includes('You are the spec-gate seat'));
  assert.ok(prompt.includes('/runs/r1/reports/spec-gate.json'));
  assert.ok(prompt.includes('"verdict"'));
  assert.ok(prompt.includes('Do not use web tools.'));
  assert.ok(prompt.includes('Do not spawn subagents.'));
  assert.ok(prompt.endsWith('ROLE: check the born spec against the card.'));
  const dev = assembleSeatPrompt({
    seat: 'dev',
    def: seatDef('dev'),
    reportPath: 'r.json',
    schema: SCHEMA,
    roleBlock: 'ROLE',
  });
  assert.ok(dev.includes('Web search is allowed'));
  assert.ok(dev.includes('at most 2 read-only Explore subagents'));
});

// A headless session ends when the model stops and the machine kills whatever
// the seat left running, so a seat that backgrounds a command and waits for it
// loses the command and the report together. Every seat is told, not just the
// seats that happen to run long gates.
test('every seat prompt carries the one-turn execution rule', () => {
  for (const seat of Object.keys(SEATS)) {
    const prompt = assembleSeatPrompt({
      seat,
      def: seatDef(seat),
      reportPath: 'r.json',
      schema: SCHEMA,
      roleBlock: 'ROLE',
    });
    assert.ok(prompt.includes(ONE_TURN_RULE), seat);
  }
  assert.ok(ONE_TURN_RULE.includes('synchronously'));
  assert.ok(ONE_TURN_RULE.includes('Do not put work in the background'));
  assert.ok(ONE_TURN_RULE.includes('Do not arm a watcher'));
  assert.ok(ONE_TURN_RULE.includes('wait for an event from outside your own turn'));
  assert.ok(ONE_TURN_RULE.includes('Write your report before you stop'));
});

test('the corrective prompt names the errors and the same file', () => {
  const prompt = correctivePrompt({
    reportPath: 'r.json',
    schema: SCHEMA,
    errors: [{ path: '$.verdict', message: 'required field missing' }],
  });
  assert.ok(prompt.includes('$.verdict: required field missing'));
  assert.ok(prompt.includes('r.json'));
  // A malformed report is not the missing-report case; the rule stays out.
  assert.ok(!prompt.includes(ONE_TURN_RULE));
});

test('a corrective for a missing report names that cause and restates the rule', () => {
  const prompt = correctivePrompt({
    reportPath: 'r.json',
    schema: SCHEMA,
    missing: true,
    errors: [{ path: '$', message: 'no report file at r.json' }],
  });
  assert.ok(prompt.includes('ended with no report file'));
  assert.ok(prompt.includes('no report file at r.json'));
  assert.ok(prompt.includes(ONE_TURN_RULE));
  assert.ok(prompt.includes('write your JSON report to this file before you stop: r.json'));
});

test('the claude argv names the model and blocks tools per policy, never a fallback', () => {
  const judgment = claudeSeatCommand({
    prompt: 'P',
    model: CERTIFICATION_MODEL,
    effort: 'high',
    def: seatDef('fury-verifier'),
  });
  assert.equal(judgment.cmd, 'claude');
  assert.equal(judgment.args.at(-1), 'P');
  // The prompt is a trailing positional and `--disallowedTools` takes a
  // variadic value list, so a boolean flag has to close the list. Without it
  // the list eats the prompt and the seat dies at argument parsing.
  assert.equal(judgment.args.at(-2), '--dangerously-skip-permissions');
  assert.ok(judgment.args.includes('--model'));
  assert.ok(judgment.args.includes(CERTIFICATION_MODEL));
  assert.ok(judgment.args.includes('stream-json'));
  const disallowed = judgment.args.slice(judgment.args.indexOf('--disallowedTools'));
  assert.ok(disallowed.includes('WebSearch'));
  assert.ok(disallowed.includes('WebFetch'));
  assert.ok(disallowed.includes('Task'));
  assert.ok(!judgment.args.some((a) => a.includes('fallback')));
  const dev = claudeSeatCommand({
    claudeCommand: ['npx', 'claude'],
    prompt: 'P',
    model: DEFAULT_MODEL,
    effort: 'high',
    def: seatDef('dev'),
    resume: 'session-1',
  });
  assert.equal(dev.cmd, 'npx');
  assert.equal(dev.args[0], 'claude');
  assert.ok(!dev.args.includes('--disallowedTools'));
  assert.ok(dev.args.includes('--resume'));
  assert.ok(dev.args.includes('session-1'));
  // A resumed session id is one value, not a list, and still may not sit
  // between the last flag and the prompt.
  assert.equal(dev.args.at(-1), 'P');
  assert.equal(dev.args.at(-2), '--dangerously-skip-permissions');
});

test('the stream-json parser maps init, assistant, and result lines', () => {
  const init = parseClaudeLine(
    JSON.stringify({ type: 'system', subtype: 'init', model: DEFAULT_MODEL, session_id: 's1' }),
  );
  assert.deepEqual(init, { meta: { model: DEFAULT_MODEL, sessionId: 's1' } });
  const note = parseClaudeLine(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'reading the spec' }] },
    }),
  );
  assert.equal(note.note, 'reading the spec');
  const result = parseClaudeLine(
    JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 1.25 }),
  );
  assert.equal(result.cost, 1.25);
  assert.equal(result.meta.outcome, 'success');
  assert.equal(parseClaudeLine('narration, not JSON'), null);
  assert.equal(parseClaudeLine(''), null);
});

// The two lines below keep the shape of a real rejected stream: a rate-limit
// event at status `rejected`, then a synthetic assistant message standing in
// for the answer. The result event that follows them calls itself `success`
// and the exit code varies with how the CLI was invoked, so neither can carry
// this decision.
test('a rejected rate-limit event marks the model unavailable, with its reset', () => {
  const rejected = parseClaudeLine(
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        resetsAt: 1786557600,
        rateLimitType: 'seven_day_overage_included',
        overageStatus: 'rejected',
        isUsingOverage: false,
      },
      session_id: 's1',
    }),
  );
  assert.deepEqual(rejected, { meta: { unavailable: 'rate-limit', resetsAt: 1786557600 } });
});

test('the synthetic rejection message marks the model unavailable and keeps its text', () => {
  const synthetic = parseClaudeLine(
    JSON.stringify({
      type: 'assistant',
      message: {
        model: '<synthetic>',
        role: 'assistant',
        stop_reason: 'stop_sequence',
        content: [{ type: 'text', text: 'You have reached your limit. Switch models to continue.' }],
      },
      error: 'rate_limit',
      is_api_error_message: true,
      session_id: 's1',
    }),
  );
  assert.equal(synthetic.meta.unavailable, 'rate-limit');
  assert.ok(synthetic.note.startsWith('You have reached your limit'));
});

test('a healthy stream never marks a model unavailable', () => {
  // The same event type rides a healthy stream at status `allowed`.
  const allowed = parseClaudeLine(
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', resetsAt: 1786557600 },
      session_id: 's1',
    }),
  );
  assert.equal(allowed, null);
  const warning = parseClaudeLine(
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', resetsAt: 1786557600 },
    }),
  );
  assert.equal(warning, null);
  // An ordinary assistant turn carries no error field at all.
  const turn = parseClaudeLine(
    JSON.stringify({
      type: 'assistant',
      message: { model: DEFAULT_MODEL, content: [{ type: 'text', text: 'reading the diff' }] },
    }),
  );
  assert.equal(turn.note, 'reading the diff');
  assert.equal(turn.meta, undefined);
  // A different API error is not a rate limit and must not degrade the seat.
  const overloaded = parseClaudeLine(
    JSON.stringify({
      type: 'assistant',
      message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: overloaded' }] },
      error: 'overloaded',
      is_api_error_message: true,
    }),
  );
  assert.equal(overloaded.meta, undefined);
  // The rate-limit copy alone, without the structured markers, is just text.
  const copy = parseClaudeLine(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: "You've reached your limit, the user said" }] },
    }),
  );
  assert.equal(copy.meta, undefined);
  // The result event of a rejected stream still calls itself a success.
  const result = parseClaudeLine(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 429,
      total_cost_usd: 0,
    }),
  );
  assert.equal(result.meta.unavailable, undefined);
});
