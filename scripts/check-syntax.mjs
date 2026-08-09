#!/usr/bin/env node
// Runs `node --check` over every source file. Exit 1 on the first failure.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['bin', 'src', 'scripts', 'test'];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(mjs|js)$/.test(name)) yield p;
  }
}

let count = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    count++;
  }
}
console.log(`syntax ok: ${count} files`);
