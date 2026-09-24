// Tries DownHere in a real Firefox. Starts Firefox without a window and with
// an empty profile, installs the extension folder as a temporary add-on, then
// downloads files from a small website on this computer and checks where they
// end up. It also chooses folders with the Browse… button; Firefox's save
// dialog is answered by a stand-in that the test puts in its place. Talks to
// Firefox through its Marionette and WebDriver BiDi remote protocols, so
// nothing else needs to be installed.
//
// Needs Firefox 140 or newer. Set FIREFOX to the Firefox program if it isn't
// in the usual place. The profile and the downloads are left in a temporary
// folder, whose path is printed at the end.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect as connectTcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXTENSION_DIR, FOLDER, createReport, listFiles, sleep, startWebsite, waitFor } from './shared.mjs';

const USUAL_FIREFOX = {
  darwin: '/Applications/Firefox.app/Contents/MacOS/firefox',
  win32: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
};
const firefoxPath = process.env.FIREFOX ?? USUAL_FIREFOX[process.platform] ?? 'firefox';
const addonId = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;
// A fixed internal address, so the test can find DownHere's settings page.
const UUID = '0d0d0d0d-1111-4222-8333-444444444444';
const OPTIONS_URL = `moz-extension://${UUID}/options/options.html`;

const work = mkdtempSync(join(tmpdir(), 'downhere-firefox-'));
const downloadsDir = join(work, 'Downloads');
const has = (path) => existsSync(join(downloadsDir, path));
const report = createReport();
const { check } = report;

// ---------------------------------------------------------------------------
// Firefox and its remote protocols
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
    // Let Firefox pick free ports.
    'marionette.port': 0,
  };
  writeFileSync(
    join(profile, 'user.js'),
    Object.entries(prefs)
      .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});\n`)
      .join(''),
  );
  // System access lets the test run code in DownHere's settings page and put
  // the stand-in save dialog in place.
  const firefox = spawn(firefoxPath, [
    '--headless',
    '--no-remote',
    '--profile',
    profile,
    '--marionette',
    '--remote-allow-system-access',
    '--remote-debugging-port=0',
  ]);
  let output = '';
  const collect = (chunk) => {
    output += chunk;
  };
  firefox.stdout.on('data', collect);
  firefox.stderr.on('data', collect);
  firefox.on('error', (error) => {
    output += `\n${error.message}`;
  });
  const marionettePort = () => /Marionette\s+INFO\s+Listening on port (\d+)/.exec(output)?.[1];
  const started = await waitFor(() => /WebDriver BiDi listening/.test(output) && marionettePort(), 60_000);
  if (!started) {
    firefox.kill();
    throw new Error(`Firefox didn't start. Set FIREFOX to the Firefox program.\n${output}`);
  }
  return { firefox, marionettePort: Number(marionettePort()) };
}

// Marionette sends messages as "<length>:<JSON>".
async function connectMarionette(port) {
  const socket = connectTcp(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', () => reject(new Error('Could not connect to Firefox.')));
  });
  const pending = new Map();
  let buffer = Buffer.alloc(0);
  let lastId = 0;
  let onGreeting;
  const greeting = new Promise((resolve) => {
    onGreeting = resolve;
  });
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let colon = buffer.indexOf(':'); colon !== -1; colon = buffer.indexOf(':')) {
      const end = colon + 1 + Number(buffer.subarray(0, colon).toString());
      if (buffer.length < end) return;
      const message = JSON.parse(buffer.subarray(colon + 1, end).toString());
      buffer = buffer.subarray(end);
      if (!Array.isArray(message)) {
        onGreeting();
        continue;
      }
      const [, id, error, result] = message;
      const handlers = pending.get(id);
      pending.delete(id);
      if (error) handlers?.reject(new Error(`${error.error}: ${error.message}`));
      else handlers?.resolve(result);
    }
  });
  await greeting;
  const send = (command, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++lastId;
      pending.set(id, { resolve, reject });
      const data = Buffer.from(JSON.stringify([0, id, command, params]));
      socket.write(Buffer.concat([Buffer.from(`${data.length}:`), data]));
    });
  return { socket, send };
}

async function connectBidi(url) {
  const socket = new WebSocket(url);
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

// Replaces Firefox's save dialog with a stand-in that answers from a list:
// {saveIn: folder} saves under the suggested name, {saveAs: path} as that
// file, {cancel: true} closes the dialog. It records each dialog it shows.
const INSTALL_STAND_IN_DIALOG = `
  const Ci = Components.interfaces;
  const state = (window.downhereTestDialog = { answers: [], dialogs: [] });
  class StandInFilePicker {
    QueryInterface = ChromeUtils.generateQI(['nsIFilePicker']);
    init(browsingContext, title, mode) {
      this.mode = mode;
    }
    appendFilters() {}
    appendFilter() {}
    appendRawFilter() {}
    open(callback) {
      const answer = state.answers.shift() ?? { cancel: true };
      state.dialogs.push({ name: this.defaultString, folder: this.displayDirectory?.path ?? null });
      let result = Ci.nsIFilePicker.returnCancel;
      if (!answer.cancel) {
        const file = Components.classes['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
        file.initWithPath(answer.saveAs ?? PathUtils.join(answer.saveIn, this.defaultString));
        this.file = file;
        result = Ci.nsIFilePicker.returnOK;
      }
      Services.tm.dispatchToMainThread(() =>
        typeof callback === 'function' ? callback(result) : callback.done(result),
      );
    }
  }
  const factory = {
    createInstance: (iid) => new StandInFilePicker().QueryInterface(iid),
    QueryInterface: ChromeUtils.generateQI(['nsIFactory']),
  };
  Components.manager
    .QueryInterface(Ci.nsIComponentRegistrar)
    .registerFactory(
      Components.ID('{5f0cf2a8-6a0e-4b8e-9d3a-2a7c4d1e9b10}'),
      'DownHere test save dialog',
      '@mozilla.org/filepicker;1',
      factory,
    );
`;

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

const requests = [];
const server = await startWebsite(requests);
const site = `http://localhost:${server.address().port}`;
let firefox;
let marionette;
let bidi;
try {
  let marionettePort;
  ({ firefox, marionettePort } = await startFirefox());
  marionette = await connectMarionette(marionettePort);
  const { capabilities } = await marionette.send('WebDriver:NewSession', { webSocketUrl: true });
  console.log(`Firefox ${capabilities.browserVersion}\n`);
  bidi = await connectBidi(capabilities.webSocketUrl);
  const { send, evaluate } = bidi;
  await marionette.send('Marionette:SetContext', { value: 'chrome' });
  const privileged = async (script) => (await marionette.send('WebDriver:ExecuteScript', { script, args: [] })).value;
  await privileged(INSTALL_STAND_IN_DIALOG);
  await send('webExtension.install', { extensionData: { type: 'path', path: EXTENSION_DIR } });

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

  // Collects the settings page's errors, and describes the page when a check
  // about it fails.
  await evaluate(
    optionsTab,
    `window.pageErrors = [];
    addEventListener('error', (event) => pageErrors.push(String(event.message)));
    addEventListener('unhandledrejection', (event) => pageErrors.push(String(event.reason?.message ?? event.reason)));`,
  );
  const optionsLoadedAt = await evaluate(optionsTab, 'performance.timeOrigin');
  const describeSettingsPage = () =>
    evaluate(
      optionsTab,
      `chrome.storage.local.get('rules').then(({ rules }) => JSON.stringify({
        reloaded: performance.timeOrigin !== ${optionsLoadedAt},
        address: location.href,
        state: document.readyState,
        list: document.getElementById('rule-list').innerHTML.slice(0, 400),
        stored: rules,
        errors: window.pageErrors,
      }))`,
    ).catch((error) => error.message);
  const ruleListed = `Boolean(document.querySelector('[data-rule-id="test"] [data-action="edit"]'))`;

  await evaluate(
    optionsTab,
    `chrome.storage.local.set({
      rules: [{ id: 'test', domain: 'localhost', folder: ${JSON.stringify(FOLDER)}, includeSubdomains: true, enabled: true }],
      settings: { enabled: true, conflictAction: 'uniquify', preferSource: 'page' },
    })`,
  );
  const shownAtOnce = await waitFor(() => evaluate(optionsTab, ruleListed), 10_000);
  check('The settings page shows a rule saved elsewhere', shownAtOnce, shownAtOnce ? '' : await describeSettingsPage());
  await send('browsingContext.navigate', { context: pageTab, url: `${site}/page`, wait: 'complete' });

  for (const { name, link, sorted, stays, first = sorted } of CASES) {
    const action = link === 'post' ? 'submit' : 'click';
    await evaluate(pageTab, `document.getElementById(${JSON.stringify(link)}).${action}()`);
    const detail = () => `Downloads folder: ${listFiles(downloadsDir).join(', ') || 'empty'}`;
    if (sorted) {
      check(name, await waitFor(() => has(`${FOLDER}/${sorted}`) && !has(first)), detail());
    } else {
      await waitFor(() => has(stays));
      // Give DownHere time to try, and to clean up after itself.
      await sleep(4000);
      check(name, has(stays) && !has(`${FOLDER}/${stays}`), detail());
    }
  }

  await sleep(1000);
  check('No partly downloaded files are left', !listFiles(downloadsDir).some((path) => path.endsWith('.part')));
  const listed = JSON.parse(
    await evaluate(optionsTab, `chrome.downloads.search({}).then((items) => JSON.stringify(items.map((item) => item.filename)))`),
  );
  const inDownloadsFolder = (path) => path.split(/[\\/]/).slice(-2).join('/');
  const firstCopies = listed.filter((path) =>
    ['Downloads/report.txt', 'Downloads/archive.zip', 'Downloads/secret.txt'].includes(inDownloadsFolder(path)),
  );
  check('The first copies of sorted files are gone from the downloads list', firstCopies.length === 0);

  // -------------------------------------------------------------------------
  // Choosing a folder with Browse…
  // -------------------------------------------------------------------------

  const answer = (...answers) => privileged(`window.downhereTestDialog.answers.push(...${JSON.stringify(answers)})`);
  const dialogs = async () => JSON.parse(await privileged('return JSON.stringify(window.downhereTestDialog.dialogs.splice(0))'));
  const helperFiles = () => listFiles(downloadsDir).filter((path) => path.split('/').pop().startsWith('DownHere - '));
  const helperEntries = async (tab) =>
    JSON.parse(await evaluate(tab, `chrome.downloads.search({ urlRegex: '^blob:moz-extension:' }).then((items) => JSON.stringify(items))`));
  // Clicks a Browse… button and waits until choosing is over.
  const browse = async (tab, button = '#add-browse', field = 'add-folder', hint = 'add-folder-hint') => {
    await evaluate(tab, `document.querySelector(${JSON.stringify(button)}).click()`);
    await waitFor(async () => !(await evaluate(tab, `document.querySelector(${JSON.stringify(button)}).disabled`)));
    return JSON.parse(
      await evaluate(
        tab,
        `JSON.stringify({
          value: document.getElementById(${JSON.stringify(field)}).value,
          hint: document.getElementById(${JSON.stringify(hint)}).textContent,
          error: document.getElementById(${JSON.stringify(hint)}).classList.contains('is-error'),
        })`,
      ),
    );
  };
  const noHelpersLeft = async (name) =>
    check(name, helperFiles().length === 0 && (await helperEntries(optionsTab)).length === 0, `Left: ${helperFiles().join(', ')}`);

  mkdirSync(join(downloadsDir, 'Picked', 'Sub'), { recursive: true });
  await answer({ saveIn: join(downloadsDir, 'Picked', 'Sub') });
  let result = await browse(optionsTab);
  check('Browse…: the chosen folder fills the field', result.value === 'Picked/Sub' && result.hint === 'Saves to Downloads/Picked/Sub', JSON.stringify(result));
  let shown = await dialogs();
  check(
    'Browse…: the save dialog suggests “DownHere - choose this folder.txt” in the Downloads folder',
    shown.length === 1 && shown[0].name === 'DownHere - choose this folder.txt' && shown[0].folder === downloadsDir,
    JSON.stringify(shown),
  );
  await sleep(1000);
  await noHelpersLeft('Browse…: both small files are deleted and gone from the downloads list');

  await answer({ cancel: true });
  result = await browse(optionsTab);
  check('Browse…: closing the dialog keeps the field as it was', result.value === 'Picked/Sub' && !result.error, JSON.stringify(result));
  await noHelpersLeft('Browse…: nothing is left after closing the dialog');

  const outside = join(work, 'Elsewhere');
  mkdirSync(outside);
  await answer({ saveIn: outside });
  result = await browse(optionsTab);
  check('Browse…: a folder outside Downloads is explained', result.error && result.hint.includes(`(${downloadsDir})`), JSON.stringify(result));
  check('Browse…: the small file outside Downloads is deleted', listFiles(outside).length === 0, listFiles(outside).join(', '));

  await answer({ saveIn: downloadsDir });
  result = await browse(optionsTab);
  check('Browse…: the Downloads folder itself is explained', result.error && result.hint.startsWith('The small file was saved directly in your Downloads folder'), JSON.stringify(result));
  await noHelpersLeft('Browse…: nothing is left after choosing the Downloads folder');

  // Firefox asks for every download in this mode, but not for DownHere's second file.
  await privileged(`Services.prefs.setBoolPref('browser.download.useDownloadDir', false)`);
  await dialogs();
  mkdirSync(join(downloadsDir, 'Asked'));
  await answer({ saveIn: join(downloadsDir, 'Asked') });
  result = await browse(optionsTab);
  shown = await dialogs();
  check('Browse… with “Always ask where to save files”: one dialog, and the folder is chosen', result.value === 'Asked' && shown.length === 1, JSON.stringify({ result, shown }));
  await privileged(`Services.prefs.setBoolPref('browser.download.useDownloadDir', true)`);
  await noHelpersLeft('Browse… with “Always ask where to save files”: nothing is left');

  const stillListed = await evaluate(optionsTab, ruleListed);
  if (check('The settings page still lists the rule after choosing folders', stillListed, stillListed ? '' : await describeSettingsPage())) {
    await evaluate(optionsTab, `document.querySelector('[data-rule-id="test"] [data-action="edit"]').click()`);
    mkdirSync(join(downloadsDir, 'Edited'));
    await answer({ saveIn: join(downloadsDir, 'Edited') });
    result = await browse(optionsTab, '[data-action="browse"]', 'edit-folder-test', 'edit-folder-hint-test');
    await evaluate(optionsTab, `document.querySelector('.rule-edit button[type="submit"]').click()`);
    const saved = await waitFor(async () => (await evaluate(optionsTab, `chrome.storage.local.get('rules').then(({ rules }) => rules[0].folder)`)) === 'Edited', 5000);
    check('Browse… while editing a rule fills its field, and saving keeps the folder', result.value === 'Edited' && saved, JSON.stringify(result));
  }

  // The popup's Browse… button opens the settings page with its form in the address.
  await answer({ saveIn: join(downloadsDir, 'Picked', 'Sub') });
  const { context: handoffTab } = await send('browsingContext.create', { type: 'tab' });
  await send('browsingContext.navigate', {
    context: handoffTab,
    url: `${OPTIONS_URL}#browse=1&domain=news.example.org&folder=Old&subdomains=0`,
    wait: 'complete',
  });
  let handedOver;
  await waitFor(async () => {
    handedOver = JSON.parse(
      await evaluate(
        handoffTab,
        `JSON.stringify({
          domain: document.getElementById('add-domain').value,
          folder: document.getElementById('add-folder').value,
          subdomains: document.querySelector('#add-form [name="includeSubdomains"]').checked,
          address: location.hash,
        })`,
      ),
    );
    return handedOver.folder === 'Picked/Sub';
  });
  check(
    'The settings page takes over the popup’s form and opens the dialog',
    handedOver.domain === 'news.example.org' && handedOver.folder === 'Picked/Sub' && !handedOver.subdomains && handedOver.address === '',
    JSON.stringify(handedOver),
  );
  await sleep(500);
  await noHelpersLeft('Nothing is left after choosing from the popup');

  // From a popup that showed a website with a rule, the rule's editor opens.
  mkdirSync(join(downloadsDir, 'From the popup'));
  await answer({ saveIn: join(downloadsDir, 'From the popup') });
  const { context: ruleTab } = await send('browsingContext.create', { type: 'tab' });
  await send('browsingContext.navigate', {
    context: ruleTab,
    url: `${OPTIONS_URL}#browse=1&domain=localhost&folder=Old&subdomains=1&rule=test`,
    wait: 'complete',
  });
  let editedFromPopup = {};
  await waitFor(async () => {
    editedFromPopup = JSON.parse(
      await evaluate(
        ruleTab,
        `JSON.stringify({
          domain: document.getElementById('edit-domain-test')?.value,
          folder: document.getElementById('edit-folder-test')?.value,
          choosing: document.querySelector('[data-action="browse"]')?.disabled,
        })`,
      ),
    );
    return editedFromPopup.folder === 'From the popup' && editedFromPopup.choosing === false;
  });
  check(
    'For a website with a rule, the settings page opens the rule’s editor and fills in the chosen folder',
    editedFromPopup.domain === 'localhost' && editedFromPopup.folder === 'From the popup',
    JSON.stringify(editedFromPopup),
  );
  await sleep(500);
  await noHelpersLeft('Nothing is left after choosing for the rule from the popup');

} catch (error) {
  check('The test ran to the end', false, error.stack);
} finally {
  bidi?.socket.close();
  marionette?.socket.destroy();
  firefox?.kill();
  server.close();
}

console.log('\nRequests the website received:');
for (const request of requests) console.log(`  ${request}`);
report.finish(`Firefox profile and downloads: ${work}`);
