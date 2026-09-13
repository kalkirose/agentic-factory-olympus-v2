# The lockfile grant's fixture

One real dependency install, captured as the two files the grant compares.

`before.pnpm-lock.yaml` and `after.pnpm-lock.yaml` are pnpm's own output, not
written by hand. The grant states rules about what pnpm actually writes, so the
case that says a real install is admitted has to run against real bytes.
`before.package.json` and `after.package.json` are the gaining importer's
manifest on each side, which is the file a spec declares beside the lockfile.

## How they were made

In a throwaway workspace outside this repository, deleted afterwards, with pnpm
10 and node 22:

1. A root `package.json` (`@example/root`, private, one dev dependency) and a
   `pnpm-workspace.yaml` with `packages: ['apps/*', 'packages/*']`, one
   `overrides` entry and one `packageExtensions` entry. The last two are what
   make the file carry an `overrides` block and a `packageExtensionsChecksum`,
   which are two of the top-level blocks the grant holds byte for byte.
2. Three importers: `apps/web`, `apps/api` and `packages/shared`, with a handful
   of small public packages between them. Two of the three depend on a package
   that carries a peer dependency, and the peer is auto-installed.
3. `pnpm install --lockfile-only`, captured as `before`.
4. `pnpm add <the peer, pinned> --filter @example/web --lockfile-only`, captured
   as `after`.

## What the shapes are for

The install writes the named entry into one importer, and it rewrites the peer
suffix on the `version:` line of a second importer that the card never named.
That second rewrite is the reason the grant holds no `version:` line anywhere:
holding them would refuse pnpm's own output. It also adds a `packages` entry and
`snapshots` entries, and leaves every other top-level block alone, which is the
whole of what the grant admits.

The refusing cases in `test/lockfile.test.mjs` are one edit of these bytes each,
at an anchor the file holds exactly once.
