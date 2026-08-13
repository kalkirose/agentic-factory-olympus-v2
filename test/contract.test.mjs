import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkReportSchema, validateReport, readReport } from '../src/seats/contract.mjs';
import { tempDir, removeDir } from './helpers.mjs';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    count: { type: 'integer' },
    notes: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['high', 'low'] },
        },
        required: ['file', 'severity'],
      },
    },
  },
  required: ['verdict'],
};

test('the fixture schema is inside the flat subset', () => {
  assert.deepEqual(checkReportSchema(SCHEMA), []);
});

test('the shape check rejects constructs outside the subset', () => {
  const cases = [
    [{ type: 'object', additionalProperties: false, properties: {}, allOf: [] }, 'allOf'],
    [{ type: 'object', additionalProperties: false, properties: { a: { $ref: '#/x' } } }, '$ref'],
    [{ type: 'object', properties: {} }, 'additionalProperties'],
    [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          a: {
            type: 'object',
            additionalProperties: false,
            properties: {
              b: { type: 'object', additionalProperties: false, properties: {} },
            },
          },
        },
      },
      'nest',
    ],
    [
      {
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'array', items: { type: 'array', items: { type: 'string' } } } },
      },
      'array items',
    ],
    [
      { type: 'object', additionalProperties: false, properties: {}, required: ['ghost'] },
      'required',
    ],
  ];
  for (const [schema, needle] of cases) {
    const errors = checkReportSchema(schema);
    assert.ok(
      errors.some((e) => e.message.includes(needle)),
      `expected an error naming ${needle}: ${JSON.stringify(errors)}`,
    );
  }
});

test('validateReport accepts a valid report', () => {
  const report = {
    verdict: 'pass',
    count: 2,
    notes: ['a'],
    findings: [{ file: 'x.mjs', line: 3, severity: 'high' }],
  };
  assert.deepEqual(validateReport(SCHEMA, report), []);
});

test('validateReport names every defect with a path', () => {
  const report = {
    count: 'two',
    verdictt: 'pass',
    notes: [1],
    findings: [{ severity: 'medium' }],
  };
  const errors = validateReport(SCHEMA, report);
  const paths = errors.map((e) => e.path);
  assert.ok(paths.includes('$.verdict')); // required missing
  assert.ok(paths.includes('$.count')); // wrong type
  assert.ok(paths.includes('$.verdictt')); // unknown field
  assert.ok(paths.includes('$.notes[0]')); // bad array item
  assert.ok(paths.includes('$.findings[0].file')); // nested required
  assert.ok(paths.includes('$.findings[0].severity')); // enum
});

test('an optional field may be absent — a lane with nothing to report', () => {
  assert.deepEqual(validateReport(SCHEMA, { verdict: 'fail' }), []);
});

test('readReport reports a missing file and bad JSON as validation errors', (t) => {
  const dir = tempDir();
  t.after(() => removeDir(dir));
  const missing = readReport(join(dir, 'none.json'));
  assert.ok(missing.errors[0].message.includes('no report file'));
  // Only the wrote-nothing case is flagged; the corrective brief words it
  // differently from a report that exists and is wrong.
  assert.equal(missing.missing, true);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{nope');
  assert.ok(readReport(bad).errors[0].message.includes('not valid JSON'));
  assert.equal(readReport(bad).missing, undefined);
  const good = join(dir, 'good.json');
  writeFileSync(good, '{"verdict":"pass"}');
  assert.deepEqual(readReport(good).value, { verdict: 'pass' });
});
