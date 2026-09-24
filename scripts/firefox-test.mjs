// Tries DownHere in a real Firefox. Starts Firefox without a window and with
// an empty profile, installs the extension folder as a temporary add-on, then
// downloads files from a small website on this computer and checks where they
// end up. Talks to Firefox through its WebDriver BiDi remote protocol, so
// nothing else needs to be installed.
//
// Needs Firefox 140 or newer. Set FIREFOX to the Firefox program if it isn't
// in the usual place. The profile and the downloads are left in a temporary
// folder, whose path is printed at the end.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const USUAL_FIREFOX = {
  darwin: '/Applications/Firefox.app/Contents/MacOS/firefox',
  win32: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
};
const firefoxPath = process.env.FIREFOX ?? USUAL_FIREFOX[process.platform] ?? 'firefox';
const extensionDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const addonId = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;
// A fixed internal address, so the test can find DownHere's settings page.
const UUID = '0d0d0d0d-1111-4222-8333-444444444444';
const OPTIONS_URL = `moz-extension://${UUID}/options/options.html`;
const FOLDER = 'Sorted/Test';

const work = mkdtempSync(join(tmpdir(), 'downhere-firefox-'));
const downloadsDir = join(work, 'Downloads');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const has = (path) => existsSync(join(downloadsDir, path));

function listDownloads(dir = downloadsDir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listDownloads(path) : [relative(downloadsDir, path).split('\\').join('/')];
  });
}

async function waitFor(condition, timeout = 20_000) {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(200)) {
    if (condition()) return true;
  }
  return false;
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

function startWebsite(requests) {
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

// ---------------------------------------------------------------------------
// Firefox and its remote protocol
// ---------------------------------------------------------------------------

async function startFirefox() {
  const profile = join(work, 'profile');
  mkdirSync(profile);
  mkdirSync(downloadsDir);
  const prefs = {
    'browser.download.dir': downloadsDir,
    'browser.download.folderList': 2,
    'browser.download.useDownloadDir': true,
    'browser.download.always_ask_before_handling_new_types': false,
    'browser.download.start_downloads_in_tmp_dir': false,
    'extensions.webextensions.uuids': JSON.stringify({ [addonId]: UUID }),
  };
  writeFileSync(
    join(profile, 'user.js'),
    Object.entries(prefs)
      .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});\n`)
      .join(''),
  );
  const port = 9300 + Math.floor(Math.random() * 500);
  // System access lets the test run code in DownHere's settings page.
  const firefox = spawn(firefoxPath, [
    '--headless',
    '--no-remote',
    '--profile',
    profile,
    '--remote-allow-system-access',
    `--remote-debugging-port=${port}`,
  ]);
  let output = '';
  firefox.stderr.on('data', (chunk) => {
    output += chunk;
  });
  firefox.on('error', (error) => {
    output += `\n${error.message}`;
  });
  const started = await waitFor(() => /WebDriver BiDi listening/.test(output), 30_000);
  if (!started) {
    firefox.kill();
    throw new Error(`Firefox didn't start. Set FIREFOX to the Firefox program.\n${output}`);
  }
  return { firefox, port };
}

async function connect(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('Could not connect to Firefox.'));
  });
  const pending = new Map();
  let lastId = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const handlers = pending.get(message.id);
    if (!handlers) return;
    pending.delete(message.id);
    if (message.type === 'error') handlers.reject(new Error(`${message.error}: ${message.message}`));
    else handlers.resolve(message.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++lastId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (context, expression) => {
    const result = await send('script.evaluate', { expression, target: { context }, awaitPromise: true });
    if (result.type === 'exception') throw new Error(`Script failed: ${result.exceptionDetails.text}`);
    return result.result.value;
  };
  return { socket, send, evaluate };
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

// `sorted` files must end up in the rule's folder and nowhere else; files that
// `stay` must stay in the Downloads folder without a copy in the rule's folder.
const CASES = [
  { name: 'An ordinary file is sorted', link: 'plain', sorted: 'report.txt' },
  { name: 'A file behind a redirect is sorted', link: 'redirect', sorted: 'archive.zip' },
  { name: 'A file only for visitors of the page is sorted', link: 'protected', sorted: 'secret.txt' },
  { name: 'A file from a form stays in Downloads', link: 'post', stays: 'export.csv' },
  { name: 'A file that is different every time stays in Downloads', link: 'random', stays: 'data.bin' },
  { name: 'A file made by the page stays in Downloads', link: 'blob', stays: 'blob.txt' },
  { name: 'The same name twice keeps both files', link: 'plain', sorted: 'report(1).txt', first: 'report.txt' },
];

const results = [];
function check(name, ok) {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `\n    Downloads folder: ${listDownloads().join(', ') || 'empty'}`}`);
}

const requests = [];
const server = await startWebsite(requests);
const site = `http://localhost:${server.address().port}`;
let firefox;
let socket;
try {
  let port;
  ({ firefox, port } = await startFirefox());
  let send;
  let evaluate;
  ({ socket, send, evaluate } = await connect(port));
  await send('session.new', { capabilities: {} });
  await send('webExtension.install', { extensionData: { type: 'path', path: extensionDir } });

  // DownHere opens its settings page by itself when it is installed.
  let optionsTab;
  let pageTab;
  for (let attempt = 0; attempt < 50 && !optionsTab; attempt += 1) {
    const { contexts } = await send('browsingContext.getTree');
    optionsTab = contexts.find((context) => context.url === OPTIONS_URL)?.context;
    pageTab = contexts.find((context) => !context.url.startsWith('moz-extension:'))?.context;
    if (!optionsTab) await sleep(200);
  }
  check('The settings page opens after installing', Boolean(optionsTab));
  if (!optionsTab) throw new Error('DownHere’s settings page didn’t open.');
  pageTab ??= (await send('browsingContext.create', { type: 'tab' })).context;

  await evaluate(
    optionsTab,
    `chrome.storage.local.set({
      rules: [{ domain: 'localhost', folder: ${JSON.stringify(FOLDER)}, includeSubdomains: true, enabled: true }],
      settings: { enabled: true, conflictAction: 'uniquify', preferSource: 'page' },
    })`,
  );
  await send('browsingContext.navigate', { context: pageTab, url: `${site}/page`, wait: 'complete' });

  for (const { name, link, sorted, stays, first = sorted } of CASES) {
    const action = link === 'post' ? 'submit' : 'click';
    await evaluate(pageTab, `document.getElementById(${JSON.stringify(link)}).${action}()`);
    if (sorted) {
      check(name, await waitFor(() => has(`${FOLDER}/${sorted}`) && !has(first)));
    } else {
      await waitFor(() => has(stays));
      // Give DownHere time to try, and to clean up after itself.
      await sleep(4000);
      check(name, has(stays) && !has(`${FOLDER}/${stays}`));
    }
  }

  await sleep(1000);
  check('No partly downloaded files are left', !listDownloads().some((path) => path.endsWith('.part')));
  const listed = JSON.parse(
    await evaluate(optionsTab, `chrome.downloads.search({}).then((items) => JSON.stringify(items.map((item) => item.filename)))`),
  );
  const inDownloadsFolder = (path) => path.split(/[\\/]/).slice(-2).join('/');
  const firstCopies = listed.filter((path) =>
    ['Downloads/report.txt', 'Downloads/archive.zip', 'Downloads/secret.txt'].includes(inDownloadsFolder(path)),
  );
  check('The first copies of sorted files are gone from the downloads list', firstCopies.length === 0);
} finally {
  socket?.close();
  firefox?.kill();
  server.close();
}

console.log('\nRequests the website received:');
for (const request of requests) console.log(`  ${request}`);
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed. Firefox profile and downloads: ${work}`);
process.exitCode = failed > 0 ? 1 : 0;
