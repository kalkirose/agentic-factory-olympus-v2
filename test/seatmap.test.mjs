import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEATS,
  seatDef,
  DEFAULT_MODEL,
  CERTIFICATION_MODEL,
  DEFAULT_EFFORT,
} from '../src/seats/seatmap.mjs';
import { assembleSeatPrompt, correctivePrompt } from '../src/seats/prompt.mjs';
import { claudeSeatCommand, parseClaudeLine } from '../src/seats/claude.mjs';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { verdict: { type: 'string' } },
  required: ['verdict'],
};

test('every seat holds the xhigh effort floor', () => {
  for (const [name, def] of Object.entries(SEATS)) {
    assert.equal(def.effort, DEFAULT_EFFORT, name);
  }
});

test('the certification spine runs on Fable; everything else on the default model', () => {
  const certification = ['verdict-triage', 'fury-verifier', 'eval'];
  for (const [name, def] of Object.entries(SEATS)) {
    const expected = certification.includes(name) ? CERTIFICATION_MODEL : DEFAULT_MODEL;
    assert.equal(def.model, expected, name);
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

test('the corrective prompt names the errors and the same file', () => {
  const prompt = correctivePrompt({
    reportPath: 'r.json',
    schema: SCHEMA,
    errors: [{ path: '$.verdict', message: 'required field missing' }],
  });
  assert.ok(prompt.includes('$.verdict: required field missing'));
  assert.ok(prompt.includes('r.json'));
});

test('the claude argv names the model and blocks tools per policy, never a fallback', () => {
  const judgment = claudeSeatCommand({
    prompt: 'P',
    model: CERTIFICATION_MODEL,
    effort: 'xhigh',
    def: seatDef('fury-verifier'),
  });
  assert.equal(judgment.cmd, 'claude');
  assert.equal(judgment.args.at(-1), 'P');
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
    effort: 'xhigh',
    def: seatDef('dev'),
    resume: 'session-1',
  });
  assert.equal(dev.cmd, 'npx');
  assert.equal(dev.args[0], 'claude');
  assert.ok(!dev.args.includes('--disallowedTools'));
  assert.ok(dev.args.includes('--resume'));
  assert.ok(dev.args.includes('session-1'));
});

test('the stream-json parser maps init, assistant, and result lines', () => {
  const init = parseClaudeLine(
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 's1' }),
  );
  assert.deepEqual(init, { meta: { model: 'claude-opus-5', sessionId: 's1' } });
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
