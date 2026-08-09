import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempDir(prefix = 'olympus-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

/** Polls `check` until it returns a truthy value. Test-only convenience. */
export async function waitFor(check, { attempts = 50, intervalMs = 100, label = 'condition' } = {}) {
  for (let i = 0; i < attempts; i++) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out in test helper: ${label}`);
}
