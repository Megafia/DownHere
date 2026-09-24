// Tries DownHere in a real Chrome. Starts Chrome without a window and with an
// empty profile, loads the extension folder, then downloads files from a small
// website on this computer and checks where they end up. Without a window,
// Chrome closes every save dialog as soon as it opens, so the Browse… button
// is checked with a closed dialog. Talks to Chrome through its DevTools
// protocol, so nothing else needs to be installed.
//
// Needs Chrome 121 or newer, or Chromium. Set CHROME to the Chrome program if
// it isn't in the usual place. The profile and the downloads are left in a
// temporary folder, whose path is printed at the end.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXTENSION_DIR, FOLDER, createReport, listFiles, sleep, startWebsite, waitFor } from './shared.mjs';

const USUAL_CHROME = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
};
const chromePath = process.env.CHROME ?? USUAL_CHROME[process.platform] ?? 'google-chrome';

const work = mkdtempSync(join(tmpdir(), 'downhere-chrome-'));
const downloadsDir = join(work, 'Downloads');
const has = (path) => existsSync(join(downloadsDir, path));
const report = createReport();
const { check } = report;

// ---------------------------------------------------------------------------
// Chrome and its DevTools protocol
// ---------------------------------------------------------------------------

function startChrome({ loadExtension }) {
  const profile = join(work, 'profile');
  mkdirSync(join(profile, 'Default'), { recursive: true });
  mkdirSync(downloadsDir, { recursive: true });
  writeFileSync(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true },
      // The test page starts several downloads in a row.
      profile: { default_content_setting_values: { automatic_downloads: 1 } },
    }),
  );
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      `--user-data-dir=${profile}`,
      // Chrome can't use its sandbox when it runs as root, as in containers.
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      ...(loadExtension ? [`--load-extension=${EXTENSION_DIR}`] : []),
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
  );
  let output = '';
  chrome.stderr.on('data', (chunk) => {
    output += chunk;
  });

  // Messages go through file descriptors 3 and 4, each ending with a 0 byte.
  const pending = new Map();
  let buffer = Buffer.alloc(0);
  let lastId = 0;
  // Set once Chrome couldn't start or has quit; nothing will answer then.
  let stopped = null;
  const stop = (reason) => {
    stopped ??= reason;
    for (const { reject } of pending.values()) reject(stopped);
    pending.clear();
  };
  chrome.on('error', (error) => {
    output += `\n${error.message}`;
    stop(new Error(`Chrome couldn't start: ${error.message}`));
  });
  chrome.on('exit', (code, signal) => stop(new Error(`Chrome quit (${signal ?? `exit code ${code}`}).`)));
  chrome.stdio[4].on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let end = buffer.indexOf(0); end !== -1; end = buffer.indexOf(0)) {
      const message = JSON.parse(buffer.subarray(0, end).toString());
      buffer = buffer.subarray(end + 1);
      const handlers = pending.get(message.id);
      if (!handlers) continue;
      pending.delete(message.id);
      if (message.error) handlers.reject(new Error(`${handlers.method}: ${message.error.message}`));
      else handlers.resolve(message.result);
    }
  });
  chrome.stdio[3].on('error', () => {});
  const send = (method, params = {}, sessionId = undefined) =>
    new Promise((resolve, reject) => {
      if (stopped) {
        reject(stopped);
        return;
      }
      const id = ++lastId;
      // Don't wait forever for a Chrome that hangs.
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: Chrome didn't answer.`));
      }, 60_000);
      const settle = (settler) => (value) => {
        clearTimeout(timer);
        settler(value);
      };
      pending.set(id, { resolve: settle(resolve), reject: settle(reject), method });
      chrome.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) })}\0`);
    });
  return { chrome, send, output: () => output };
}

// Starts Chrome with DownHere and returns the tab with its settings page.
// Chrome 126 and newer load extensions through the protocol; older versions
// through --load-extension, which newer Chrome versions ignore.
async function startChromeWithDownHere() {
  let browser = startChrome({ loadExtension: false });
  const version = await browser.send('Browser.getVersion').catch((error) => {
    throw new Error(`Chrome didn't start. Set CHROME to the Chrome program.\n${error.message}\n${browser.output()}`);
  });
  try {
    await browser.send('Extensions.loadUnpacked', { path: EXTENSION_DIR });
  } catch {
    browser.chrome.kill();
    await sleep(1000);
    browser = startChrome({ loadExtension: true });
    await browser.send('Browser.getVersion');
  }
  // DownHere opens its settings page by itself when it is installed.
  let optionsTarget;
  await waitFor(async () => {
    const { targetInfos } = await browser.send('Target.getTargets');
    optionsTarget = targetInfos.find(
      (target) => target.type === 'page' && /^chrome-extension:\/\/[a-p]{32}\/options\/options\.html$/.test(target.url),
    );
    return Boolean(optionsTarget);
  }, 15_000);
  return { ...browser, version: version.product, optionsTarget };
}

async function attach(browser, targetId) {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const run = async (expression) => {
    const result = await browser.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(`Script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  };
  return Object.assign(run, { sessionId });
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

// Chrome lets DownHere choose the folder before a file is saved, so every
// download from the website is sorted, and each is downloaded only once.
const CASES = [
  { name: 'An ordinary file is sorted', link: 'plain', sorted: 'report.txt' },
  { name: 'A file behind a redirect is sorted', link: 'redirect', sorted: 'archive.zip' },
  { name: 'A file only for visitors of the page is sorted', link: 'protected', sorted: 'secret.txt' },
  { name: 'A file from a form is sorted', link: 'post', sorted: 'export.csv' },
  { name: 'A file that is different every time is sorted', link: 'random', sorted: 'data.bin' },
  { name: 'A file made by the page is sorted', link: 'blob', sorted: 'blob.txt' },
  { name: 'The same name twice keeps both files', link: 'plain', sorted: 'report (1).txt' },
];

const requests = [];
const server = await startWebsite(requests);
const site = `http://localhost:${server.address().port}`;
let browser;
try {
  browser = await startChromeWithDownHere();
  console.log(`${browser.version}\n`);
  check('The settings page opens after installing', Boolean(browser.optionsTarget));
  if (!browser.optionsTarget) throw new Error(`DownHere’s settings page didn’t open.\n${browser.output()}`);
  const options = await attach(browser, browser.optionsTarget.targetId);
  const extensionUrl = browser.optionsTarget.url.replace('options/options.html', '');

  // Wait until the page has shown the stored rules (none yet).
  await waitFor(() => options(`!document.getElementById('rules-empty').hidden`));
  await options(
    `chrome.storage.local.set({
      rules: [{ id: 'test', domain: 'localhost', folder: ${JSON.stringify(FOLDER)}, includeSubdomains: true, enabled: true }],
      settings: { enabled: true, conflictAction: 'uniquify', preferSource: 'page' },
    })`,
  );
  // Let the background script start listening.
  await sleep(1000);
  const { targetId: pageTarget } = await browser.send('Target.createTarget', { url: `${site}/page` });
  const page = await attach(browser, pageTarget);
  await waitFor(() => page(`location.pathname === '/page' && document.readyState === 'complete'`));

  for (const { name, link, sorted } of CASES) {
    const action = link === 'post' ? 'submit' : 'click';
    await page(`document.getElementById(${JSON.stringify(link)}).${action}()`);
    const ok = await waitFor(() => has(`${FOLDER}/${sorted}`));
    check(name, ok && !has(sorted), `Downloads folder: ${listFiles(downloadsDir).join(', ') || 'empty'}`);
  }
  await sleep(500);
  check('No partly downloaded files are left', !listFiles(downloadsDir).some((path) => path.endsWith('.crdownload')));
  const fileRequests = requests.filter((line) => !/\/page |favicon/.test(line));
  check('Each file was downloaded only once', fileRequests.length === 7, fileRequests.join('\n    '));

  // -------------------------------------------------------------------------
  // Choosing a folder with Browse…
  // -------------------------------------------------------------------------

  const helperFiles = () => listFiles(downloadsDir).filter((path) => path.split('/').pop().startsWith('DownHere - '));
  const helperEntries = async () =>
    JSON.parse(await options(`chrome.downloads.search({ urlRegex: '^blob:chrome-extension:' }).then(JSON.stringify)`));
  const noHelpersLeft = async (name) =>
    check(name, helperFiles().length === 0 && (await helperEntries()).length === 0, `Left: ${helperFiles().join(', ')}`);
  // Records the small files that any DownHere page asks Chrome to save. Each
  // Browse… must ask for exactly one, with a save dialog, which Chrome closes
  // without a window (USER_CANCELED); DownHere then removes it from the list.
  await options(`(() => {
    window.helperDownloads = [];
    const find = (id) => window.helperDownloads.find((entry) => entry.id === id);
    chrome.downloads.onCreated.addListener((item) => {
      if (item.url.startsWith('blob:' + location.origin + '/')) window.helperDownloads.push({ id: item.id });
    });
    chrome.downloads.onChanged.addListener((delta) => {
      if (delta.error && find(delta.id)) find(delta.id).error = delta.error.current;
    });
    chrome.downloads.onErased.addListener((id) => {
      if (find(id)) find(id).erased = true;
    });
  })()`);
  const askedForDialog = async (name) => {
    let asked = [];
    await waitFor(async () => {
      asked = await options('window.helperDownloads');
      return asked.length > 0 && asked.every((entry) => entry.erased);
    }, 5000);
    await options('window.helperDownloads.splice(0)');
    check(name, asked.length === 1 && asked[0].error === 'USER_CANCELED' && asked[0].erased, JSON.stringify(asked));
  };

  // While a rule is on, Chrome lets DownHere name every download, including
  // the small files it saves to find out which folder was chosen.
  const named = await options(`(async () => {
    const { CHECK_FILE_NAME, HELPER_FILE_TEXT, HELPER_KEY } = await import('/lib/folder-picker.js');
    const url = URL.createObjectURL(new Blob([HELPER_FILE_TEXT], { type: 'text/plain' }));
    await chrome.storage.session.set({ [HELPER_KEY]: { url, name: CHECK_FILE_NAME } });
    const id = await chrome.downloads.download({ url, filename: CHECK_FILE_NAME, saveAs: false });
    let item;
    for (let attempt = 0; attempt < 100 && item?.state !== 'complete'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      [item] = await chrome.downloads.search({ id });
    }
    await chrome.downloads.removeFile(id);
    await chrome.downloads.erase({ id });
    await chrome.storage.session.remove(HELPER_KEY);
    return item.filename;
  })()`);
  check('DownHere’s small files keep their names while a rule is on', named === join(downloadsDir, 'DownHere - Downloads folder check.txt'), named);

  await options(`(() => {
    window.helperDownloads.splice(0);
    const field = document.getElementById('add-folder');
    field.value = 'Typed';
    field.dispatchEvent(new Event('input'));
    document.getElementById('add-browse').click();
  })()`);
  await waitFor(async () => !(await options(`document.getElementById('add-browse').disabled`)));
  const closed = JSON.parse(
    await options(
      `JSON.stringify({
        value: document.getElementById('add-folder').value,
        hint: document.getElementById('add-folder-hint').textContent,
        error: document.getElementById('add-folder-hint').classList.contains('is-error'),
      })`,
    ),
  );
  check(
    'Browse…: a closed save dialog leaves the field as it was',
    closed.value === 'Typed' && closed.hint === 'Saves to Downloads/Typed' && !closed.error,
    JSON.stringify(closed),
  );
  await askedForDialog('Browse…: Chrome is asked to open a save dialog');
  await noHelpersLeft('Browse…: nothing is left after the dialog closed');

  // The popup's Browse… button opens the settings page with its form in the address.
  const { targetId: handoffTarget } = await browser.send('Target.createTarget', {
    url: `${extensionUrl}options/options.html#browse=1&domain=news.example.org&folder=Old&subdomains=0`,
  });
  const handoff = await attach(browser, handoffTarget);
  let handedOver;
  await waitFor(async () => {
    handedOver = JSON.parse(
      await handoff(
        `JSON.stringify({
          domain: document.getElementById('add-domain')?.value,
          folder: document.getElementById('add-folder')?.value,
          subdomains: document.querySelector('#add-form [name="includeSubdomains"]')?.checked,
          address: location.hash,
          choosing: document.getElementById('add-browse')?.disabled,
        })`,
      ),
    );
    return handedOver.domain === 'news.example.org' && handedOver.choosing === false;
  });
  check(
    'The settings page takes over the popup’s form for Browse…',
    handedOver.domain === 'news.example.org' && handedOver.folder === 'Old' && !handedOver.subdomains && handedOver.address === '',
    JSON.stringify(handedOver),
  );
  await askedForDialog('The settings page asks Chrome to open the save dialog for the popup’s form');
  await noHelpersLeft('Nothing is left after Browse… from the popup');

  // Opens the popup in a tab. The popup only learns the address of the current
  // tab when someone clicks DownHere's button, so the test tells it: the test
  // website, which has a rule.
  const openPopup = async () => {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const popup = await attach(browser, targetId);
    await browser.send('Page.enable', {}, popup.sessionId);
    await browser.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `if (location.protocol === 'chrome-extension:') {
          chrome.tabs.query = async () => [{ id: 1, url: ${JSON.stringify(`${site}/page`)} }];
        }`,
      },
      popup.sessionId,
    );
    await browser.send('Page.navigate', { url: `${extensionUrl}popup/popup.html` }, popup.sessionId);
    return { popup, popupTarget: targetId };
  };

  // The popup's own Browse… button continues on the settings page with
  // editing the website's rule.
  const earlier = new Set((await browser.send('Target.getTargets')).targetInfos.map((target) => target.targetId));
  const { popup, popupTarget } = await openPopup();
  const popupShowsSite = await waitFor(async () => (await popup(`document.getElementById('site-host')?.textContent`)) === 'localhost');
  await popup(`(() => {
    document.getElementById('folder').value = 'From the popup';
    document.getElementById('browse').click();
  })()`);
  let editTarget;
  await waitFor(async () => {
    const { targetInfos } = await browser.send('Target.getTargets');
    editTarget = targetInfos.find(
      (target) =>
        !earlier.has(target.targetId) &&
        target.targetId !== popupTarget &&
        target.type === 'page' &&
        target.url.startsWith(`${extensionUrl}options/`),
    );
    return Boolean(editTarget);
  });
  let edited = {};
  if (editTarget) {
    const editPage = await attach(browser, editTarget.targetId);
    await waitFor(async () => {
      edited = JSON.parse(
        await editPage(
          `JSON.stringify({
            domain: document.getElementById('edit-domain-test')?.value,
            folder: document.getElementById('edit-folder-test')?.value,
            choosing: document.querySelector('[data-action="browse"]')?.disabled,
          })`,
        ),
      );
      return edited.domain === 'localhost' && edited.choosing === false;
    });
  }
  check(
    'The popup’s Browse… continues on the settings page, editing the site’s rule',
    popupShowsSite && edited.domain === 'localhost' && edited.folder === 'From the popup',
    JSON.stringify({ popupShowsSite, ...edited }),
  );
  await askedForDialog('The popup’s Browse… makes Chrome open a save dialog for the rule');
  await noHelpersLeft('Nothing is left after the popup’s Browse…');

  // Rules made with versions before 0.3.0 can have a folder that only Firefox
  // can't use. Chrome keeps using it, and the rule can still be changed.
  const storedRule = async () =>
    JSON.parse(await options(`chrome.storage.local.get('rules').then(({ rules }) => JSON.stringify(rules.find((rule) => rule.id === 'test')))`));
  await options(
    `chrome.storage.local.get('rules').then(({ rules }) => chrome.storage.local.set({
      rules: rules.map((rule) => (rule.id === 'test' ? { ...rule, folder: '100% Done', includeSubdomains: true } : rule)),
    }))`,
  );
  const { popup: oldPopup } = await openPopup();
  await waitFor(async () => (await oldPopup(`document.getElementById('folder')?.value`)) === '100% Done');
  const oldShown = JSON.parse(
    await oldPopup(
      `JSON.stringify({
        status: document.getElementById('site-status').textContent,
        hint: document.getElementById('folder-hint').textContent,
        error: document.getElementById('folder-hint').classList.contains('is-error'),
      })`,
    ),
  );
  const listWarning = await options(`document.querySelector('[data-rule-id="test"] .hint.is-error')?.textContent ?? ''`);
  check(
    'Chrome keeps using a rule’s folder that only Firefox can’t use',
    oldShown.status === 'Downloads from this site are saved in Downloads/100% Done.' &&
      oldShown.hint === 'Saves to Downloads/100% Done' &&
      !oldShown.error &&
      listWarning === '',
    JSON.stringify({ ...oldShown, listWarning }),
  );
  await oldPopup(`document.getElementById('subdomains').click(); document.getElementById('save').click()`);
  let changed = {};
  const oldSaved = await waitFor(async () => {
    changed = await storedRule();
    return changed.includeSubdomains === false;
  }, 5000);
  check('The popup changes such a rule without changing its folder', oldSaved && changed.folder === '100% Done', JSON.stringify(changed));
} catch (error) {
  check('The test ran to the end', false, error.stack);
} finally {
  browser?.chrome.kill();
  server.close();
}

console.log('\nRequests the website received:');
for (const request of requests) console.log(`  ${request}`);
report.finish(`Chrome profile and downloads: ${work}`);
