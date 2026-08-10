// The command center's own read-only server: one node:http server rooted at
// the daemon home. GET only — every command goes through the console. The
// daemon does not know this server exists; the files on disk are the only
// interface. Routes:
//   GET /              the page
//   GET /snapshot.json the derived snapshot the page renders
//   GET /state/...     raw store files under the daemon home, path-guarded;
//                      a directory answers as a JSON listing
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { homePaths } from '../daemon/home.mjs';
import { buildSnapshot } from './snapshot.mjs';

const PAGE_URL = new URL('./page.html', import.meta.url);

const CONTENT_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/**
 * Creates the server for one daemon home. The caller listens; tests bind
 * port 0.
 * @param {string} home
 */
export function createCenterServer(home) {
  const root = resolve(home);
  const paths = homePaths(root);
  return createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') {
        return send(res, 405, 'text/plain; charset=utf-8', 'GET only — the center displays, never commands\n');
      }
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/') {
        return send(res, 200, 'text/html; charset=utf-8', readFileSync(PAGE_URL));
      }
      if (pathname === '/snapshot.json') {
        const snapshot = await buildSnapshot(paths);
        return send(res, 200, CONTENT_TYPES['.json'], JSON.stringify(snapshot));
      }
      if (pathname === '/state' || pathname.startsWith('/state/')) {
        return serveState(res, root, pathname.slice('/state'.length));
      }
      return send(res, 404, 'text/plain; charset=utf-8', 'not found\n');
    } catch (error) {
      send(res, 500, 'text/plain; charset=utf-8', `error: ${error.message}\n`);
    }
  });
}

function serveState(res, root, relative) {
  const target = resolve(root, relative.replace(/^[/\\]+/, ''));
  if (!within(target, root)) {
    return send(res, 403, 'text/plain; charset=utf-8', 'outside the daemon home\n');
  }
  if (!existsSync(target)) {
    return send(res, 404, 'text/plain; charset=utf-8', 'not found\n');
  }
  // The guard holds through symlinks: the resolved real path must also sit
  // under the home root.
  const real = realpathSync(target);
  if (!within(real, realpathSync(root))) {
    return send(res, 403, 'text/plain; charset=utf-8', 'outside the daemon home\n');
  }
  if (statSync(real).isDirectory()) {
    const entries = readdirSync(real, { withFileTypes: true })
      .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return send(res, 200, CONTENT_TYPES['.json'], JSON.stringify(entries));
  }
  const type = CONTENT_TYPES[extname(real)] ?? 'application/octet-stream';
  return send(res, 200, type, readFileSync(real));
}

function within(target, root) {
  return target === root || target.startsWith(root + sep);
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  });
  res.end(body);
}
