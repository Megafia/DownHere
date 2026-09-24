import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRedownloader, isInDownloadsFolder, isSameFile, planRedownload } from '../extension/lib/redownload.js';
import { DEFAULT_SETTINGS } from '../extension/lib/rules.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const OWN_ID = 'downhere@megafia.github.io';

function rule(domain, folder, extra = {}) {
  return { id: `id-${domain}`, domain, folder, includeSubdomains: true, enabled: true, ...extra };
}

const RULES = [rule('example.com', 'Example')];

// Firefox reports downloads with their full path.
function download(extra = {}) {
  return {
    url: 'https://example.com/files/report.pdf',
    referrer: 'https://example.com/downloads',
    filename: '/home/me/Downloads/report.pdf',
    cookieStoreId: 'firefox-default',
    ...extra,
  };
}

// Keeps downloads in memory and behaves like Firefox's downloads API where
// DownHere relies on it.
class FakeDownloads {
  constructor() {
    this.items = new Map();
    this.calls = [];
    this.nextId = 1;
    this.downloadError = null;
  }

  /** Adds a download that has just started and returns it as Firefox reports it. */
  start(extra = {}) {
    const item = {
      ...download(),
      id: this.nextId++,
      mime: 'application/pdf',
      state: 'in_progress',
      exists: true,
      fileSize: -1,
      incognito: false,
      startTime: new Date(NOW - 1000).toISOString(),
      ...extra,
    };
    this.items.set(item.id, item);
    return { ...item };
  }

  /** Finishes a download and returns the change Firefox reports to onChanged. */
  complete(id, extra = { fileSize: 1000 }) {
    Object.assign(this.items.get(id), { state: 'complete', ...extra });
    return { id, state: { previous: 'in_progress', current: 'complete' } };
  }

  fail(id) {
    Object.assign(this.items.get(id), { state: 'interrupted', error: 'NETWORK_FAILED' });
    return { id, state: { previous: 'in_progress', current: 'interrupted' } };
  }

  async search({ id }) {
    const item = this.items.get(id);
    return item ? [{ ...item }] : [];
  }

  async download(options) {
    this.calls.push(['download', options]);
    if (this.downloadError) throw this.downloadError;
    const item = this.start({
      url: options.url,
      referrer: '',
      filename: `/home/me/Downloads/${options.filename}`,
      incognito: Boolean(options.incognito),
      cookieStoreId: options.incognito ? 'firefox-private' : 'firefox-default',
      byExtensionId: OWN_ID,
    });
    return item.id;
  }

  async cancel(id) {
    this.calls.push(['cancel', id]);
    const item = this.items.get(id);
    if (item.state === 'complete') throw new Error(`Download ${id} is already complete`);
    Object.assign(item, { state: 'interrupted', error: 'USER_CANCELED', exists: false });
  }

  async removeFile(id) {
    this.calls.push(['removeFile', id]);
    this.items.get(id).exists = false;
  }

  async erase({ id }) {
    this.calls.push(['erase', id]);
    this.items.delete(id);
    return [id];
  }
}

class FakeStorage {
  constructor() {
    this.data = {};
  }

  async get(key) {
    return key in this.data ? { [key]: structuredClone(this.data[key]) } : {};
  }

  async set(values) {
    Object.assign(this.data, structuredClone(values));
  }
}

function setup({ rules = RULES, settings = DEFAULT_SETTINGS } = {}) {
  const state = { rules, settings };
  const downloads = new FakeDownloads();
  const storage = new FakeStorage();
  const warnings = [];
  const errors = [];
  const log = { warn: (...args) => warnings.push(args), error: (...args) => errors.push(args) };
  // Each call stands for a fresh start of the background page.
  const createRouter = () =>
    createRedownloader({ downloads, storage, loadState: async () => state, log, now: () => NOW });
  const jobs = () => storage.data.redownloads ?? [];
  return { state, downloads, storage, warnings, errors, jobs, createRouter, router: createRouter() };
}

describe('planRedownload', () => {
  it('routes downloads like resolveDownload', () => {
    const plan = planRedownload(download(), RULES, DEFAULT_SETTINGS);
    assert.equal(plan.action, 'route');
    assert.equal(plan.filename, 'Example/report.pdf');
    assert.equal(plan.conflictAction, 'uniquify');
  });

  it('only uses the name from Firefox’s full path', () => {
    const item = download({ filename: 'C:\\Users\\me\\Downloads\\report.pdf' });
    assert.equal(planRedownload(item, RULES, DEFAULT_SETTINGS).filename, 'Example/report.pdf');
  });

  it('skips downloads that can’t be repeated faithfully', () => {
    const reason = (extra) => planRedownload(download(extra), RULES, DEFAULT_SETTINGS).reason;
    assert.equal(reason({ byExtensionId: OWN_ID }), 'extension');
    assert.equal(reason({ url: 'blob:https://example.com/0b7f1e52-4d0c-4a39-9f5e-2c1b8d3a6e10' }), 'not-repeatable');
    assert.equal(reason({ cookieStoreId: 'firefox-container-1' }), 'container');
    assert.equal(reason({ filename: '/home/me/Downloads/50% off.pdf' }), 'unsafe-filename');
  });

  it('sorts data: downloads and downloads from private windows', () => {
    const fromPage = { url: 'data:text/plain,hello', filename: '/home/me/Downloads/hello.txt' };
    assert.equal(planRedownload(download(fromPage), RULES, DEFAULT_SETTINGS).action, 'route');
    const privately = download({ incognito: true, cookieStoreId: 'firefox-private' });
    assert.equal(planRedownload(privately, RULES, DEFAULT_SETTINGS).action, 'route');
  });

  it('keeps both files instead of asking, which Firefox can’t do', () => {
    const plan = (conflictAction) =>
      planRedownload(download(), RULES, { ...DEFAULT_SETTINGS, conflictAction }).conflictAction;
    assert.equal(plan('prompt'), 'uniquify');
    assert.equal(plan('overwrite'), 'overwrite');
  });

  it('passes on the reasons of resolveDownload', () => {
    assert.equal(planRedownload(download(), RULES, { ...DEFAULT_SETTINGS, enabled: false }).reason, 'disabled');
    const other = download({ url: 'https://other.net/a.zip', referrer: 'https://other.net/' });
    assert.equal(planRedownload(other, RULES, DEFAULT_SETTINGS).reason, 'no-rule');
  });
});

describe('isInDownloadsFolder', () => {
  it('works out the Downloads folder from where the second download went', () => {
    assert.equal(isInDownloadsFolder('/home/me/Downloads/a.pdf', '/home/me/Downloads/Example/a.pdf', 'Example'), true);
    assert.equal(isInDownloadsFolder('/home/me/Downloads/a.pdf', '/home/me/Downloads/Work/Bills/a(1).pdf', 'Work/Bills'), true);
    assert.equal(
      isInDownloadsFolder('C:\\Users\\me\\Downloads\\a.pdf', 'C:\\Users\\me\\Downloads\\Example\\a.pdf', 'Example'),
      true,
    );
  });

  it('is false for files saved anywhere else', () => {
    assert.equal(isInDownloadsFolder('/home/me/Desktop/a.pdf', '/home/me/Downloads/Example/a.pdf', 'Example'), false);
    assert.equal(isInDownloadsFolder('/home/me/Downloads/Old/a.pdf', '/home/me/Downloads/Example/a.pdf', 'Example'), false);
    assert.equal(isInDownloadsFolder('/a.pdf', '/Example/a.pdf', 'Deeper/Example'), false);
  });
});

describe('isSameFile', () => {
  it('compares size and type', () => {
    const file = { fileSize: 1000, mime: 'application/pdf' };
    assert.equal(isSameFile(file, { ...file }), true);
    assert.equal(isSameFile(file, { ...file, fileSize: 999 }), false);
    assert.equal(isSameFile(file, { ...file, mime: 'text/html' }), false);
    assert.equal(isSameFile(file, { ...file, mime: '' }), true);
    assert.equal(isSameFile({ fileSize: -1 }, { fileSize: -1 }), false);
  });
});

describe('createRedownloader', () => {
  it('downloads a finished file again into the rule’s folder, then removes the first one', async () => {
    const { downloads, router, jobs, errors } = setup();
    const first = downloads.start();
    await router.onCreated(first);
    assert.deepEqual(downloads.calls, [], 'waits until the first download has finished');

    await router.onChanged(downloads.complete(first.id));
    assert.deepEqual(downloads.calls, [
      [
        'download',
        {
          url: first.url,
          filename: 'Example/report.pdf',
          conflictAction: 'uniquify',
          saveAs: false,
          headers: [{ name: 'Referer', value: first.referrer }],
        },
      ],
    ]);

    const copyId = first.id + 1;
    await router.onChanged(downloads.complete(copyId));
    assert.deepEqual(downloads.calls.slice(1), [
      ['removeFile', first.id],
      ['erase', first.id],
    ]);
    assert.equal(downloads.items.get(copyId).filename, '/home/me/Downloads/Example/report.pdf');
    assert.deepEqual(jobs(), []);
    assert.deepEqual(errors, []);
  });

  it('handles files that finish before their first event is handled', async () => {
    const { downloads, router } = setup();
    const first = downloads.start();
    downloads.complete(first.id);
    await router.onCreated(first);
    assert.equal(downloads.calls[0][0], 'download');
  });

  it('starts only one second download for each file', async () => {
    const { downloads, router } = setup();
    const first = downloads.start();
    const finished = downloads.complete(first.id);
    await Promise.all([router.onCreated(first), router.onChanged(finished), router.onChanged(finished)]);
    assert.equal(downloads.calls.filter(([name]) => name === 'download').length, 1);
  });

  it('keeps the first file when the second download fails', async () => {
    const { downloads, router, jobs } = setup();
    const first = downloads.start();
    await router.onCreated(first);
    await router.onChanged(downloads.complete(first.id));
    const copyId = first.id + 1;
    await router.onChanged(downloads.fail(copyId));
    assert.deepEqual(downloads.calls.slice(1), [
      ['cancel', copyId],
      ['erase', copyId],
    ]);
    assert.equal(downloads.items.get(first.id).exists, true);
    assert.deepEqual(jobs(), []);
  });

  it('keeps the first file when the second download gives something else', async () => {
    const { downloads, router, warnings } = setup();
    const first = downloads.start();
    await router.onCreated(first);
    await router.onChanged(downloads.complete(first.id));
    const copyId = first.id + 1;
    await router.onChanged(downloads.complete(copyId, { fileSize: 5120, mime: 'text/html' }));
    assert.deepEqual(downloads.calls.slice(1), [
      ['removeFile', copyId],
      ['erase', copyId],
    ]);
    assert.equal(downloads.items.get(first.id).exists, true);
    assert.equal(warnings.length, 1);
  });

  it('keeps the first file when Firefox refuses to download it again', async () => {
    const { downloads, router, jobs, warnings } = setup();
    downloads.downloadError = new Error('filename must not contain illegal characters');
    const first = downloads.start();
    await router.onCreated(first);
    await router.onChanged(downloads.complete(first.id));
    assert.deepEqual(
      downloads.calls.map(([name]) => name),
      ['download'],
    );
    assert.deepEqual(jobs(), []);
    assert.equal(warnings.length, 1);
  });

  it('leaves files alone that were saved outside the Downloads folder', async () => {
    const { downloads, router } = setup();
    const first = downloads.start({ filename: '/home/me/Desktop/report.pdf' });
    await router.onCreated(first);
    await router.onChanged(downloads.complete(first.id));
    const copyId = first.id + 1;
    assert.deepEqual(downloads.calls.slice(1), [
      ['cancel', copyId],
      ['erase', copyId],
    ]);
    assert.equal(downloads.items.get(first.id).exists, true);
  });

  it('downloads files from private windows again privately', async () => {
    const { downloads, router } = setup();
    const first = downloads.start({ incognito: true, cookieStoreId: 'firefox-private' });
    await router.onCreated(first);
    await router.onChanged(downloads.complete(first.id));
    assert.equal(downloads.calls[0][1].incognito, true);
  });

  it('ignores downloads without a rule and downloads that started long ago', async () => {
    const { downloads, router, jobs, warnings } = setup();
    await router.onCreated(downloads.start({ url: 'https://other.net/a.zip', referrer: '' }));
    await router.onCreated(downloads.start({ startTime: new Date(NOW - 60 * 60 * 1000).toISOString() }));
    assert.deepEqual(jobs(), []);
    assert.deepEqual(warnings, []);
  });

  it('explains in the console why a download from a website with a rule stays where it is', async () => {
    const { downloads, router, jobs, warnings } = setup();
    await router.onCreated(downloads.start({ url: 'blob:https://example.com/0b7f1e52-4d0c-4a39-9f5e-2c1b8d3a6e10' }));
    await router.onCreated(downloads.start({ byExtensionId: 'someone-else@example.com' }));
    assert.deepEqual(jobs(), []);
    assert.equal(warnings.length, 1, 'downloads by extensions are left alone quietly');
    assert.match(warnings[0][0], /a file that a page created itself can't be downloaded again/);
  });

  it('checks the rules again when the download has finished', async () => {
    const { state, downloads, router, jobs } = setup();
    const first = downloads.start();
    await router.onCreated(first);
    state.settings = { ...DEFAULT_SETTINGS, enabled: false };
    await router.onChanged(downloads.complete(first.id));
    assert.deepEqual(downloads.calls, []);
    assert.deepEqual(jobs(), []);
  });

  it('carries on after Firefox unloads the background page', async () => {
    const { downloads, createRouter } = setup();
    const first = downloads.start();
    await createRouter().onCreated(first);
    await createRouter().onChanged(downloads.complete(first.id));
    await createRouter().onChanged(downloads.complete(first.id + 1));
    assert.deepEqual(
      downloads.calls.map(([name]) => name),
      ['download', 'removeFile', 'erase'],
    );
  });

  it('forgets downloads that fail or are erased before they finish', async () => {
    const { downloads, router, jobs } = setup();
    const failing = downloads.start();
    await router.onCreated(failing);
    await router.onChanged(downloads.fail(failing.id));
    const erased = downloads.start();
    await router.onCreated(erased);
    await router.onErased(erased.id);
    assert.deepEqual(jobs(), []);
    assert.deepEqual(downloads.calls, []);
  });

  it('keeps the second file if the first one is gone by the time it finishes', async () => {
    const { downloads, router } = setup();
    const first = downloads.start();
    await router.onCreated(first);
    await router.onChanged(downloads.complete(first.id));
    downloads.items.get(first.id).exists = false;
    await router.onChanged(downloads.complete(first.id + 1));
    assert.deepEqual(
      downloads.calls.map(([name]) => name),
      ['download'],
    );
    assert.equal(downloads.items.get(first.id + 1).exists, true);
  });
});
