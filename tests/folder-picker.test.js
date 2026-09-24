import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHECK_FILE_NAME,
  CHOOSE_FILE_NAME,
  HELPER_FILE_TEXT,
  HELPER_KEY,
  chooseFolder,
  folderChoiceMessage,
  folderFromSavedFiles,
  helperFileName,
  isHelperDownload,
} from '../extension/lib/folder-picker.js';

const EXTENSION = { extensionId: 'downhere@example', extensionUrl: 'chrome-extension://abcdefgh/' };
const HELPER_BYTES = new TextEncoder().encode(HELPER_FILE_TEXT).length;

describe('folderFromSavedFiles', () => {
  const downloads = '/home/me/Downloads';
  const check = `${downloads}/${CHECK_FILE_NAME}`;
  const chosen = (folder) => `${folder}/${CHOOSE_FILE_NAME}`;

  it('returns the chosen folder inside the Downloads folder', () => {
    assert.deepEqual(folderFromSavedFiles(chosen(`${downloads}/Work`), check), { outcome: 'chosen', folder: 'Work' });
    assert.deepEqual(folderFromSavedFiles(chosen(`${downloads}/Work/Invoices/2026`), check), {
      outcome: 'chosen',
      folder: 'Work/Invoices/2026',
    });
  });

  it('keeps names exactly as they are', () => {
    // A decomposed "é", as macOS reports it, stays decomposed.
    const name = 'Cafe\u0301 & Co (old) [1]';
    assert.deepEqual(folderFromSavedFiles(chosen(`${downloads}/${name}`), check), { outcome: 'chosen', folder: name });
  });

  it('recognizes the Downloads folder itself', () => {
    assert.deepEqual(folderFromSavedFiles(chosen(downloads), check), { outcome: 'downloads-folder' });
  });

  it('rejects folders outside the Downloads folder', () => {
    for (const folder of ['/home/me', '/home/me/Documents', '/home/me/Downloads2/Work', '/tmp', '/']) {
      assert.deepEqual(
        folderFromSavedFiles(chosen(folder), check),
        { outcome: 'outside', downloadsFolder: downloads },
        folder,
      );
    }
  });

  it('treats paths as case-sensitive outside Windows', () => {
    assert.equal(folderFromSavedFiles(chosen('/home/me/downloads/Work'), check).outcome, 'outside');
  });

  it('handles a Downloads folder at the root', () => {
    assert.deepEqual(folderFromSavedFiles(chosen('/Work'), `/${CHECK_FILE_NAME}`), { outcome: 'chosen', folder: 'Work' });
    assert.deepEqual(folderFromSavedFiles(chosen('/'), `/${CHECK_FILE_NAME}`), { outcome: 'downloads-folder' });
  });

  it('ignores repeated separators', () => {
    assert.deepEqual(folderFromSavedFiles(chosen('/home//me/Downloads/Work/'), check), { outcome: 'chosen', folder: 'Work' });
  });

  it('handles Windows paths, ignoring case', () => {
    const windowsCheck = `C:\\Users\\Me\\Downloads\\${CHECK_FILE_NAME}`;
    assert.deepEqual(folderFromSavedFiles(`C:\\Users\\Me\\Downloads\\Work\\Invoices\\${CHOOSE_FILE_NAME}`, windowsCheck), {
      outcome: 'chosen',
      folder: 'Work/Invoices',
    });
    assert.deepEqual(folderFromSavedFiles(`c:\\users\\me\\DOWNLOADS\\Work\\${CHOOSE_FILE_NAME}`, windowsCheck), {
      outcome: 'chosen',
      folder: 'Work',
    });
    assert.deepEqual(folderFromSavedFiles(`C:\\Users\\Me\\Downloads\\${CHOOSE_FILE_NAME}`, windowsCheck), {
      outcome: 'downloads-folder',
    });
    assert.deepEqual(folderFromSavedFiles(`D:\\Users\\Me\\Downloads\\Work\\${CHOOSE_FILE_NAME}`, windowsCheck), {
      outcome: 'outside',
      downloadsFolder: 'C:\\Users\\Me\\Downloads',
    });
  });

  it('handles a Windows drive and a network share as the Downloads folder', () => {
    assert.deepEqual(folderFromSavedFiles(`D:\\Music\\${CHOOSE_FILE_NAME}`, `D:\\${CHECK_FILE_NAME}`), {
      outcome: 'chosen',
      folder: 'Music',
    });
    assert.deepEqual(folderFromSavedFiles(`E:\\Music\\${CHOOSE_FILE_NAME}`, `D:\\${CHECK_FILE_NAME}`), {
      outcome: 'outside',
      downloadsFolder: 'D:\\',
    });
    const share = '\\\\server\\files\\Downloads';
    assert.deepEqual(folderFromSavedFiles(`${share}\\Work\\${CHOOSE_FILE_NAME}`, `${share}\\${CHECK_FILE_NAME}`), {
      outcome: 'chosen',
      folder: 'Work',
    });
    assert.deepEqual(folderFromSavedFiles(`\\\\other\\files\\Downloads\\Work\\${CHOOSE_FILE_NAME}`, `${share}\\${CHECK_FILE_NAME}`), {
      outcome: 'outside',
      downloadsFolder: share,
    });
  });

  it('rejects folder names that rules can’t use', () => {
    for (const name of [' Music', 'Music.', 'Notes: 2026', 'a\\b', 'CON', 'PROGRA~1', 'x'.repeat(256)]) {
      const result = folderFromSavedFiles(chosen(`${downloads}/Work/${name}`), check);
      assert.equal(result.outcome, 'invalid', name);
      assert.ok(result.error.length > 0, name);
    }
  });
});

describe('folderChoiceMessage', () => {
  it('says nothing when a folder was chosen or the dialog was closed', () => {
    assert.equal(folderChoiceMessage({ outcome: 'chosen', folder: 'Work' }), '');
    assert.equal(folderChoiceMessage({ outcome: 'cancelled' }), '');
  });

  it('explains every other outcome', () => {
    const outcomes = [
      { outcome: 'busy' },
      { outcome: 'downloads-folder' },
      { outcome: 'outside', downloadsFolder: '/home/me/Downloads' },
      { outcome: 'invalid', error: 'Folder names can’t contain the character :' },
      { outcome: 'check-failed' },
      { outcome: 'no-path' },
      { outcome: 'failed', error: 'FILE_ACCESS_DENIED' },
      { outcome: 'failed', error: 'Something broke' },
    ];
    for (const result of outcomes) assert.ok(folderChoiceMessage(result).length > 20, result.outcome);
    assert.match(folderChoiceMessage(outcomes[2]), /\(\/home\/me\/Downloads\)/);
    assert.match(folderChoiceMessage(outcomes[3]), /character :/);
    assert.match(folderChoiceMessage(outcomes[4]), new RegExp(CHECK_FILE_NAME));
    assert.match(folderChoiceMessage(outcomes[6]), /couldn’t save a file in that folder \(FILE_ACCESS_DENIED\)/);
    assert.match(folderChoiceMessage(outcomes[7]), /Something broke/);
  });
});

describe('helper downloads', () => {
  const helper = (extra = {}) => ({ byExtensionId: EXTENSION.extensionId, url: 'blob:chrome-extension://abcdefgh/1234', ...extra });

  it('recognizes DownHere’s own helper files', () => {
    assert.equal(isHelperDownload(helper(), EXTENSION), true);
    assert.equal(isHelperDownload(helper({ byExtensionId: 'someone-else' }), EXTENSION), false);
    assert.equal(isHelperDownload(helper({ byExtensionId: undefined }), EXTENSION), false);
    assert.equal(isHelperDownload(helper({ url: 'https://example.com/file.txt' }), EXTENSION), false);
    assert.equal(isHelperDownload(helper({ url: 'blob:https://example.com/1234' }), EXTENSION), false);
    assert.equal(isHelperDownload(helper({ url: 'blob:chrome-extension://other/1234' }), EXTENSION), false);
  });

  it('gives a helper file the name DownHere chose for it', async () => {
    const data = {};
    const storage = { get: async (key) => (key in data ? { [key]: data[key] } : {}) };
    assert.equal(await helperFileName(storage, 'blob:x/1'), '');
    data[HELPER_KEY] = { url: 'blob:x/1', name: CHOOSE_FILE_NAME };
    assert.equal(await helperFileName(storage, 'blob:x/1'), CHOOSE_FILE_NAME);
    assert.equal(await helperFileName(storage, 'blob:x/2'), '');
    data[HELPER_KEY] = { url: 'blob:x/1', name: CHECK_FILE_NAME };
    assert.equal(await helperFileName(storage, 'blob:x/1'), CHECK_FILE_NAME);
    // Only ever one of the two known names.
    data[HELPER_KEY] = { url: 'blob:x/1', name: '../evil.exe' };
    assert.equal(await helperFileName(storage, 'blob:x/1'), '');
  });
});

// Behaves like the downloads API of Chrome or Firefox where DownHere relies on
// it. Save dialogs are answered from `answers`: {saveIn: folder}, {saveAs:
// path}, {cancel: true}, {fail: 'ERROR'} or {noPath: true}.
class FakeBrowser {
  constructor({ firefox = false, askWhereToSave = false, downloadsDir = '/home/me/Downloads', sep = '/' } = {}) {
    this.firefox = firefox;
    this.askWhereToSave = askWhereToSave;
    this.downloadsDir = downloadsDir;
    this.sep = sep;
    this.answers = [];
    this.dialogs = [];
    this.downloadCalls = [];
    this.items = new Map();
    this.files = new Map();
    this.nextId = 1;
    this.session = {};
    this.lockHeld = false;
    const event = () => {
      const listeners = new Set();
      return {
        listeners,
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
        emit: (value) => listeners.forEach((listener) => listener(value)),
      };
    };
    this.onChanged = event();
    this.onErased = event();
    const browser = this;
    this.api = {
      ...EXTENSION,
      extensionUrl: 'blob-origin://test/',
      downloads: {
        download: (options) => browser.download(options),
        search: async (query) => browser.search(query),
        removeFile: async (id) => browser.removeFile(id),
        erase: async ({ id }) => browser.erase(id),
        cancel: async (id) => browser.cancel(id),
        onChanged: this.onChanged,
        onErased: this.onErased,
      },
      storage: {
        get: async (key) => (key in browser.session ? { [key]: structuredClone(browser.session[key]) } : {}),
        set: async (values) => Object.assign(browser.session, structuredClone(values)),
        remove: async (key) => delete browser.session[key],
      },
      locks: {
        request: async (name, options, callback) => {
          if (browser.lockHeld) return callback(null);
          browser.lockHeld = true;
          try {
            return await callback({ name });
          } finally {
            browser.lockHeld = false;
          }
        },
      },
    };
  }

  /** Adds a download that is already in the list, such as a leftover. */
  add(extra) {
    const item = { id: this.nextId++, byExtensionId: EXTENSION.extensionId, state: 'complete', exists: true, ...extra };
    this.items.set(item.id, item);
    if (item.state === 'complete' && item.exists) this.files.set(item.filename, item.fileSize);
    return item.id;
  }

  uniqueName(folder, name) {
    const dot = name.lastIndexOf('.');
    for (let n = 0; ; n += 1) {
      const candidate = n === 0 ? name : `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
      const path = `${folder}${this.sep}${candidate}`;
      if (!this.files.has(path)) return path;
    }
  }

  // What a save dialog returns: a path, 'cancel', 'open' (it stays open) or {fail}.
  answerDialog(name) {
    this.dialogs.push(name);
    const answer = this.answers.shift() ?? { cancel: true };
    if (answer.cancel) return 'cancel';
    if (answer.open) return 'open';
    if (answer.fail) return answer;
    if (answer.noPath) return { noPath: true };
    return answer.saveAs ?? `${answer.saveIn}${this.sep}${name}`;
  }

  finish(id, outcome) {
    const item = this.items.get(id);
    if (!item) return;
    if (outcome === 'cancel') {
      Object.assign(item, { state: 'interrupted', error: 'USER_CANCELED' });
    } else if (outcome.fail) {
      Object.assign(item, { state: 'interrupted', error: outcome.fail });
    } else {
      const path = outcome.noPath ? `${this.downloadsDir}${this.sep}hidden-${id}.txt` : outcome;
      this.files.set(path, HELPER_BYTES);
      Object.assign(item, { state: 'complete', filename: outcome.noPath ? '' : path, realPath: path, exists: true, fileSize: HELPER_BYTES });
    }
    this.onChanged.emit({ id, state: { previous: 'in_progress', current: item.state } });
  }

  async download({ url, filename, saveAs, conflictAction }) {
    this.downloadCalls.push({ url, filename, saveAs, conflictAction, helper: structuredClone(this.session[HELPER_KEY]) });
    const needsDialog = saveAs || (!this.firefox && this.askWhereToSave);
    const silentPath = () => this.uniqueName(this.downloadsDir, filename);
    if (this.firefox) {
      // Firefox shows the dialog before the download exists.
      const outcome = needsDialog ? this.answerDialog(filename) : silentPath();
      if (outcome === 'cancel') throw new Error('Download canceled by the user');
      const id = this.add({ url, state: 'in_progress', filename: '', exists: false, fileSize: -1 });
      setTimeout(() => this.finish(id, outcome), 0);
      return id;
    }
    // Chrome creates the download first and asks later.
    const id = this.add({ url, state: 'in_progress', filename: '', exists: false, fileSize: -1 });
    if (needsDialog) {
      setTimeout(() => {
        const outcome = this.answerDialog(filename);
        if (outcome !== 'open') this.finish(id, outcome);
      }, 0);
    }
    // A file saved without a dialog can be complete before download() returns.
    else this.finish(id, silentPath());
    return id;
  }

  search({ id, urlRegex }) {
    const items = [...this.items.values()].filter(
      (item) => (id === undefined || item.id === id) && (urlRegex === undefined || new RegExp(urlRegex).test(item.url)),
    );
    return items.map((item) => ({ ...item }));
  }

  removeFile(id) {
    const item = this.items.get(id);
    if (item?.state !== 'complete' || !this.files.has(item.realPath ?? item.filename)) throw new Error('No file');
    this.files.delete(item.realPath ?? item.filename);
    item.exists = false;
  }

  erase(id) {
    if (this.items.delete(id)) this.onErased.emit(id);
  }

  cancel(id) {
    const item = this.items.get(id);
    if (item?.state !== 'in_progress') throw new Error('Not in progress');
    Object.assign(item, { state: 'interrupted', error: 'USER_CANCELED' });
  }
}

function assertCleanedUp(browser) {
  assert.deepEqual([...browser.items.values()], [], 'downloads list');
  assert.deepEqual([...browser.files.keys()], [], 'files');
  assert.equal(HELPER_KEY in browser.session, false, 'storage.session');
  assert.equal(browser.onChanged.listeners.size, 0, 'onChanged listeners');
  assert.equal(browser.onErased.listeners.size, 0, 'onErased listeners');
}

describe('chooseFolder', () => {
  for (const firefox of [false, true]) {
    const name = firefox ? 'Firefox' : 'Chrome';

    it(`${name}: returns the folder chosen in the save dialog and deletes both files`, async () => {
      const browser = new FakeBrowser({ firefox });
      browser.answers.push({ saveIn: '/home/me/Downloads/Work/Invoices' });
      const steps = [];
      const result = await chooseFolder(browser.api, { onProgress: (step) => steps.push(step) });
      assert.deepEqual(result, { outcome: 'chosen', folder: 'Work/Invoices' });
      assert.deepEqual(steps, ['choosing', 'checking']);
      assert.deepEqual(browser.dialogs, [CHOOSE_FILE_NAME]);
      const [choose, check] = browser.downloadCalls;
      assert.match(choose.url, /^blob:/);
      assert.deepEqual(choose, {
        url: choose.url,
        filename: CHOOSE_FILE_NAME,
        saveAs: true,
        conflictAction: 'uniquify',
        // Stored before the download starts, for Chrome's onDeterminingFilename.
        helper: { url: choose.url, name: CHOOSE_FILE_NAME },
      });
      assert.deepEqual(check, {
        url: check.url,
        filename: CHECK_FILE_NAME,
        saveAs: false,
        conflictAction: 'uniquify',
        helper: { url: check.url, name: CHECK_FILE_NAME },
      });
      assert.notEqual(check.url, choose.url);
      assertCleanedUp(browser);
    });

    it(`${name}: does nothing more when the dialog is closed`, async () => {
      const browser = new FakeBrowser({ firefox });
      browser.answers.push({ cancel: true });
      const steps = [];
      assert.deepEqual(await chooseFolder(browser.api, { onProgress: (step) => steps.push(step) }), {
        outcome: 'cancelled',
      });
      assert.deepEqual(steps, ['choosing']);
      assert.equal(browser.downloadCalls.length, 1);
      assertCleanedUp(browser);
    });

    it(`${name}: deletes the file when the folder is outside the Downloads folder`, async () => {
      const browser = new FakeBrowser({ firefox });
      browser.answers.push({ saveIn: '/home/me/Documents' });
      assert.deepEqual(await chooseFolder(browser.api), { outcome: 'outside', downloadsFolder: '/home/me/Downloads' });
      assertCleanedUp(browser);
    });

    it(`${name}: recognizes the Downloads folder itself`, async () => {
      const browser = new FakeBrowser({ firefox });
      browser.answers.push({ saveIn: '/home/me/Downloads' });
      assert.deepEqual(await chooseFolder(browser.api), { outcome: 'downloads-folder' });
      assertCleanedUp(browser);
    });

    it(`${name}: finds the Downloads folder when the second file’s name is taken`, async () => {
      const browser = new FakeBrowser({ firefox });
      const taken = `/home/me/Downloads/${CHECK_FILE_NAME}`;
      browser.files.set(taken, 10);
      browser.answers.push({ saveIn: '/home/me/Downloads/Work' });
      assert.deepEqual(await chooseFolder(browser.api), { outcome: 'chosen', folder: 'Work' });
      // Only DownHere's own files are deleted.
      assert.deepEqual([...browser.files.keys()], [taken]);
      browser.files.clear();
      assertCleanedUp(browser);
    });

    it(`${name}: reports a file that couldn’t be saved`, async () => {
      const browser = new FakeBrowser({ firefox });
      browser.answers.push({ fail: 'FILE_ACCESS_DENIED' });
      assert.deepEqual(await chooseFolder(browser.api), { outcome: 'failed', error: 'FILE_ACCESS_DENIED' });
      assertCleanedUp(browser);
    });
  }

  it('Chrome: handles a browser that asks where to save every file', async () => {
    const browser = new FakeBrowser({ askWhereToSave: true });
    browser.answers.push({ saveIn: '/home/me/Downloads/Work' }, { saveIn: '/home/me/Downloads' });
    assert.deepEqual(await chooseFolder(browser.api), { outcome: 'chosen', folder: 'Work' });
    assert.deepEqual(browser.dialogs, [CHOOSE_FILE_NAME, CHECK_FILE_NAME]);
    assertCleanedUp(browser);
  });

  it('Chrome: explains a closed second dialog', async () => {
    const browser = new FakeBrowser({ askWhereToSave: true });
    browser.answers.push({ saveIn: '/home/me/Downloads/Work' }, { cancel: true });
    assert.deepEqual(await chooseFolder(browser.api), { outcome: 'check-failed' });
    assertCleanedUp(browser);
  });

  it('Chrome: reports a path that the browser couldn’t tell', async () => {
    const browser = new FakeBrowser();
    browser.answers.push({ noPath: true });
    assert.deepEqual(await chooseFolder(browser.api), { outcome: 'no-path' });
    assertCleanedUp(browser);
  });

  it('works with Windows paths', async () => {
    const browser = new FakeBrowser({ downloadsDir: 'C:\\Users\\Me\\Downloads', sep: '\\' });
    browser.answers.push({ saveIn: 'C:\\Users\\Me\\Downloads\\Work' });
    assert.deepEqual(await chooseFolder(browser.api), { outcome: 'chosen', folder: 'Work' });
    assertCleanedUp(browser);
  });

  it('lets only one folder be chosen at a time', async () => {
    const browser = new FakeBrowser();
    browser.lockHeld = true;
    assert.deepEqual(await chooseFolder(browser.api), { outcome: 'busy' });
    assert.equal(browser.downloadCalls.length, 0);
  });

  it('reports errors from the downloads API', async () => {
    const browser = new FakeBrowser();
    browser.api.downloads.download = async () => {
      throw new Error('Invalid filename');
    };
    assert.deepEqual(await chooseFolder(browser.api), { outcome: 'failed', error: 'Invalid filename' });
    assertCleanedUp(browser);
  });

  it('treats a download removed from the list during the dialog as closed', async () => {
    const browser = new FakeBrowser();
    browser.answers.push({ open: true });
    const download = browser.api.downloads.download;
    browser.api.downloads.download = async (options) => {
      const id = await download(options);
      setTimeout(() => browser.erase(id), 5);
      return id;
    };
    assert.deepEqual(await chooseFolder(browser.api), { outcome: 'cancelled' });
    assertCleanedUp(browser);
  });

  it('removes helper files left behind earlier, and nothing else', async () => {
    const browser = new FakeBrowser();
    const blob = (n) => `blob:blob-origin://test/${n}`;
    const downloads = '/home/me/Downloads';
    // Left behind: a saved helper file and a closed dialog.
    browser.add({ url: blob(1), filename: `${downloads}/Work/${CHOOSE_FILE_NAME}`, fileSize: HELPER_BYTES });
    browser.add({ url: blob(2), filename: `${downloads}/DownHere - choose this folder (2).txt`, fileSize: HELPER_BYTES });
    browser.add({ url: blob(3), filename: `${downloads}/DownHere - Downloads folder check(1).txt`, fileSize: HELPER_BYTES });
    browser.add({ url: blob(4), filename: '', state: 'interrupted', error: 'USER_CANCELED', exists: false, fileSize: -1 });
    // Not DownHere's helper files, or still in use.
    const kept = [
      browser.add({ url: blob(5), filename: `${downloads}/Renamed in the dialog.txt`, fileSize: HELPER_BYTES }),
      browser.add({ url: blob(6), filename: `${downloads}/Work/${CHOOSE_FILE_NAME}.bak`, fileSize: HELPER_BYTES }),
      browser.add({ url: blob(7), filename: `${downloads}/${CHOOSE_FILE_NAME}x`, fileSize: HELPER_BYTES }),
      browser.add({ url: blob(8), filename: `${downloads}/Other/${CHOOSE_FILE_NAME}`, fileSize: HELPER_BYTES + 1 }),
      browser.add({ url: blob(9), filename: `${downloads}/${CHECK_FILE_NAME}`, fileSize: HELPER_BYTES, byExtensionId: 'other' }),
      browser.add({ url: 'https://example.com/a', filename: `${downloads}/${CHECK_FILE_NAME}`, fileSize: HELPER_BYTES }),
      browser.add({ url: blob(10), filename: '', state: 'in_progress', exists: false, fileSize: -1 }),
    ];
    browser.answers.push({ cancel: true });
    assert.deepEqual(await chooseFolder(browser.api), { outcome: 'cancelled' });
    assert.deepEqual([...browser.items.keys()], kept);
    assert.deepEqual(
      [...browser.files.keys()],
      [
        `${downloads}/Renamed in the dialog.txt`,
        `${downloads}/Work/${CHOOSE_FILE_NAME}.bak`,
        `${downloads}/${CHOOSE_FILE_NAME}x`,
        `${downloads}/Other/${CHOOSE_FILE_NAME}`,
        `${downloads}/${CHECK_FILE_NAME}`,
      ],
    );
  });
});
