// What the Chrome and Firefox tests share: a small website on this computer
// to download from, and helpers to check and report results.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTENSION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');
// The folder of the rule for the test website.
export const FOLDER = 'Sorted/Test';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Checks `condition` until it is true. A condition that fails, for example while a page loads, counts as false. */
export async function waitFor(condition, timeout = 20_000) {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(200)) {
    if (await Promise.resolve().then(condition).catch(() => false)) return true;
  }
  return false;
}

/** All files below `dir`, as paths relative to `root` with "/" separators. */
export function listFiles(root, dir = root) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(root, path) : [relative(root, path).split('\\').join('/')];
  });
}

/** Collects the results of checks and prints them as they come. */
export function createReport() {
  const results = [];
  return {
    check(name, ok, detail = '') {
      results.push(ok);
      console.log(`${ok ? '✔' : '✖'} ${name}${ok || !detail ? '' : `\n    ${detail}`}`);
      return ok;
    },
    skip(name, reason) {
      console.log(`- ${name} (skipped: ${reason})`);
    },
    finish(where) {
      const failed = results.filter((ok) => !ok).length;
      console.log(`\n${results.length - failed} passed, ${failed} failed. ${where}`);
      process.exitCode = failed > 0 ? 1 : 0;
    },
  };
}

// ---------------------------------------------------------------------------
// The test website
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>DownHere test page</title>
<a id="plain" href="/files/report.txt">An ordinary file</a>
<a id="redirect" href="/go/archive.zip">A file behind a redirect</a>
<a id="protected" href="/protected/secret.txt">A file only for visitors of this page</a>
<form id="post" method="post" action="/export"><button>A file from a form</button></form>
<a id="random" href="/random/data.bin">A file that is different every time</a>
<a id="blob" download="blob.txt">A file made by the page</a>
<script>
  const file = new Blob(['made by the page\\n'], { type: 'text/plain' });
  document.getElementById('blob').href = URL.createObjectURL(file);
</script>`;

/**
 * Starts the test website on a free port. `requests` receives a line for each
 * request. Resolves with the server.
 */
export function startWebsite(requests) {
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    requests.push(`${request.method} ${pathname} (Referer: ${request.headers.referer ?? 'none'})`);
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { 'Content-Length': Buffer.byteLength(body), ...headers });
      response.end(body);
    };
    const attachment = (name, body, type = 'application/octet-stream') =>
      send(200, body, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` });

    if (pathname === '/page') return send(200, PAGE, { 'Content-Type': 'text/html; charset=utf-8' });
    if (pathname === '/files/report.txt') return attachment('report.txt', 'Quarterly report\n'.repeat(100), 'text/plain');
    if (pathname === '/go/archive.zip') return send(302, '', { Location: '/files/archive.zip' });
    if (pathname === '/files/archive.zip') return attachment('archive.zip', Buffer.alloc(5000, 7), 'application/zip');
    if (pathname === '/protected/secret.txt') {
      if (!request.headers.referer?.endsWith('/page')) return send(403, 'Forbidden', { 'Content-Type': 'text/plain' });
      return attachment('secret.txt', 'Secret\n', 'text/plain');
    }
    if (pathname === '/export') {
      if (request.method !== 'POST') return send(405, 'Use POST', { Allow: 'POST', 'Content-Type': 'text/plain' });
      return attachment('export.csv', 'a,b\n1,2\n', 'text/csv');
    }
    if (pathname === '/random/data.bin') {
      return attachment('data.bin', Buffer.alloc(1000 + Math.floor(Math.random() * 1000), 1));
    }
    return send(404, 'Not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
