import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCKFILE_VERSION, lockfileGrant, readLockfile } from '../src/lanes/lockfile.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(ROOT, 'test/fixtures/lockfile');

/**
 * One real `pnpm add` of a package on one workspace importer, captured in a
 * throwaway worktree of a monorepo and read back here byte for byte. Every
 * rule the grant states is a rule about what pnpm actually wrote, so the
 * admitting cases run against these bytes and the refusing cases run against
 * one edit of them.
 */
const BEFORE = readFileSync(join(FIXTURES, 'before.pnpm-lock.yaml'), 'utf8');
const AFTER = readFileSync(join(FIXTURES, 'after.pnpm-lock.yaml'), 'utf8');

/** The importer that gained the package, and the package the card would name. */
const IMPORTER = 'apps/storefront';
const ADDED = 'tiny-invariant';
const GRANT = [{ importer: IMPORTER, name: ADDED }];

/** The three lines the install wrote into the importer. */
const ADDED_ENTRY = '      tiny-invariant:\n        specifier: ^1.3.3\n        version: 1.3.3\n';

/**
 * One edit of a fixture, at an anchor the fixture holds exactly once. The
 * count is asserted because a derived fixture built on an ambiguous anchor
 * proves something other than the case it is named for.
 */
function edit(text, find, replacement) {
  assert.equal(text.split(find).length - 1, 1, `the anchor must appear once: ${find.slice(0, 40)}`);
  return text.replace(find, replacement);
}

/** The fixture's install with the added entry taken back out of the importer. */
const NO_ADD = edit(AFTER, ADDED_ENTRY, '');

/** A lockfile small enough to read whole, for the rules about shape. */
const SMALL = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    devDependencies:
      typescript:
        specifier: ^5.9.3
        version: 5.9.3

  apps/web:
    dependencies:
      '@scope/ui':
        specifier: ^2.0.0
        version: 2.0.0(react@18.3.1)

packages:

  '@scope/ui@2.0.0':
    resolution: {integrity: sha512-aaa==}

  typescript@5.9.3:
    resolution: {integrity: sha512-bbb==}

snapshots:

  '@scope/ui@2.0.0(react@18.3.1)': {}

  typescript@5.9.3: {}
`;

test('the reader names every top-level block and the lockfile version', () => {
  const { version, blocks } = readLockfile(BEFORE);
  assert.equal(version, LOCKFILE_VERSION);
  assert.deepEqual(
    [...blocks.keys()],
    [
      'lockfileVersion',
      'settings',
      'overrides',
      'packageExtensionsChecksum',
      'importers',
      'packages',
      'snapshots',
    ],
  );
  assert.equal(blocks.get('importers').line, 16);
  assert.equal(blocks.get('importers').lines[0], 'importers:');
});

test('every line of the file lands in exactly one block', () => {
  const { blocks } = readLockfile(AFTER);
  let held = 0;
  for (const block of blocks.values()) held += block.lines.length;
  assert.equal(held, AFTER.split('\n').length);
});

test('a file that declares no version has none', () => {
  const { version, blocks } = readLockfile('');
  assert.equal(version, null);
  assert.equal(blocks.size, 1);
});

test('a real install of the package the card names is admitted', () => {
  assert.deepEqual(lockfileGrant(BEFORE, AFTER, GRANT), {
    ok: true,
    block: null,
    line: null,
    reason: null,
  });
});

test('a version line may move in an importer the card never named', () => {
  // The install rewrote a peer suffix in another importer. That is pnpm's own
  // output on any install, and the grant holds no version line anywhere.
  assert.notEqual(BEFORE, NO_ADD);
  assert.equal(lockfileGrant(BEFORE, NO_ADD, []).ok, true);
});

test('a snapshots rewrite alone is admitted', () => {
  const rewritten = edit(BEFORE, '  fdir@6.1.1(picomatch@4.0.5):', '  fdir@6.1.1:');
  assert.equal(lockfileGrant(BEFORE, rewritten, []).ok, true);
});

test('a line terminator that changed at checkout is not a dependency', () => {
  const crlf = AFTER.split('\n').join('\r\n');
  assert.equal(lockfileGrant(BEFORE, crlf, GRANT).ok, true);
});

test('an unchanged file answers for no grant', () => {
  assert.equal(lockfileGrant(AFTER, AFTER, GRANT).ok, true);
});

test('a lockfile version the grant does not read is refused naming the block', () => {
  const worktree = edit(AFTER, "lockfileVersion: '9.0'", "lockfileVersion: '10.0'");
  const ahead = lockfileGrant(BEFORE, worktree, GRANT);
  assert.equal(ahead.ok, false);
  assert.equal(ahead.block, 'lockfileVersion');
  assert.match(ahead.reason, /lockfileVersion: the worktree declares 10\.0/);

  const base = edit(BEFORE, "lockfileVersion: '9.0'", "lockfileVersion: '10.0'");
  const behind = lockfileGrant(base, AFTER, GRANT);
  assert.equal(behind.ok, false);
  assert.equal(behind.block, 'lockfileVersion');
  assert.match(behind.reason, /lockfileVersion: the base declares 10\.0/);
});

test('a moved settings value is refused naming settings', () => {
  const moved = edit(AFTER, '  autoInstallPeers: true', '  autoInstallPeers: false');
  const answer = lockfileGrant(BEFORE, moved, GRANT);
  assert.equal(answer.ok, false);
  assert.equal(answer.block, 'settings');
  assert.equal(answer.line, 3);
});

test('a moved override is refused naming overrides', () => {
  const moved = edit(AFTER, '  nanoid@<3.3.17: ^3.3.17', '  nanoid@<3.3.17: ^3.3.18');
  const answer = lockfileGrant(BEFORE, moved, GRANT);
  assert.equal(answer.ok, false);
  assert.equal(answer.block, 'overrides');
});

test('a moved package-extensions checksum is refused naming its block', () => {
  const moved = edit(
    AFTER,
    'packageExtensionsChecksum: sha256-8DngXtv',
    'packageExtensionsChecksum: sha256-0DngXtv',
  );
  const answer = lockfileGrant(BEFORE, moved, GRANT);
  assert.equal(answer.ok, false);
  assert.equal(answer.block, 'packageExtensionsChecksum');
});

test('a top-level block the base does not hold is refused naming it', () => {
  const added = edit(AFTER, '\nimporters:\n', '\ncatalogs:\n  default:\n    zod: ^4.2.0\n\nimporters:\n');
  const answer = lockfileGrant(BEFORE, added, GRANT);
  assert.equal(answer.ok, false);
  assert.equal(answer.block, 'catalogs');
});

test('an added package no grant names is refused naming the importer', () => {
  const answer = lockfileGrant(BEFORE, AFTER, []);
  assert.equal(answer.ok, false);
  assert.equal(answer.block, 'importers');
  assert.equal(answer.reason, `importers: ${IMPORTER} gained ${ADDED}, which the card does not name.`);
  assert.equal(answer.line, 183);
});

test('a grant on another importer does not admit the package', () => {
  const answer = lockfileGrant(BEFORE, AFTER, [{ importer: '.', name: ADDED }]);
  assert.equal(answer.ok, false);
  assert.equal(answer.block, 'importers');
  assert.match(answer.reason, new RegExp(`${IMPORTER} gained ${ADDED}`));
});

test('a package the card names and the importer does not hold is refused', () => {
  const answer = lockfileGrant(BEFORE, NO_ADD, GRANT);
  assert.equal(answer.ok, false);
  assert.equal(answer.block, 'importers');
  assert.equal(
    answer.reason,
    `importers: the card names ${ADDED} on ${IMPORTER}, and that importer does not hold it.`,
  );
});

test('a removed entry is refused naming the importer and the package', () => {
  const answer = lockfileGrant(AFTER, NO_ADD, []);
  assert.equal(answer.ok, false);
  assert.equal(answer.block, 'importers');
  assert.equal(
    answer.reason,
    `importers: ${IMPORTER} no longer holds ${ADDED} under dependencies, and a story removes no dependency.`,
  );
});

test('a moved specifier on an entry that stays is refused', () => {
  const moved = edit(
    AFTER,
    "      '@sentry/sveltekit':\n        specifier: 10.63.0\n",
    "      '@sentry/sveltekit':\n        specifier: 10.64.0\n",
  );
  const answer = lockfileGrant(BEFORE, moved, GRANT);
  assert.equal(answer.ok, false);
  assert.equal(answer.block, 'importers');
  assert.match(answer.reason, /entry for @sentry\/sveltekit moved/);
});

test('an added entry with no specifier is refused', () => {
  const bare = edit(AFTER, '        specifier: ^1.3.3\n', '');
  const answer = lockfileGrant(BEFORE, bare, GRANT);
  assert.equal(answer.ok, false);
  assert.equal(answer.block, 'importers');
  assert.match(answer.reason, /carries no specifier/);
});

test('a moved resolution on a package the base holds is refused naming packages', () => {
  const moved = edit(
    AFTER,
    "  '@acemir/cssom@0.9.31':\n    resolution: {integrity: sha512-ZnR3GSaH",
    "  '@acemir/cssom@0.9.31':\n    resolution: {integrity: sha512-0nR3GSaH",
  );
  const answer = lockfileGrant(BEFORE, moved, GRANT);
  assert.equal(answer.ok, false);
  assert.equal(answer.block, 'packages');
  assert.match(answer.reason, /@acemir\/cssom@0\.9\.31 moved its resolution/);
});

test('a package that moves to another dependency group is refused', () => {
  const moved = edit(SMALL, '    devDependencies:\n      typescript:', '    dependencies:\n      typescript:');
  const answer = lockfileGrant(SMALL, moved, []);
  assert.equal(answer.ok, false);
  assert.equal(answer.block, 'importers');
  assert.match(answer.reason, /no longer holds typescript under devDependencies/);
});

test('a grant names a package the way a card writes it, without the quotes', () => {
  const added = edit(
    SMALL,
    "      '@scope/ui':\n",
    "      '@scope/other':\n        specifier: ^1.0.0\n        version: 1.0.0\n      '@scope/ui':\n",
  );
  const answer = lockfileGrant(SMALL, added, [{ importer: 'apps/web', name: '@scope/other' }]);
  assert.equal(answer.ok, true);
});

test('an importer with no entries carries no dependency and is admitted', () => {
  // A workspace package that declares nothing adds one line to the file and no
  // dependency to the tree. The entries are what the grant holds.
  const added = edit(SMALL, '\npackages:\n', '\n  apps/api: {}\n\npackages:\n');
  assert.equal(lockfileGrant(SMALL, added, []).ok, true);
});
