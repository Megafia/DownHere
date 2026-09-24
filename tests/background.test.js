import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

// Just enough of the extension APIs for background.js to start. Chrome has
// downloads.onDeterminingFilename and Firefox doesn't.
function fakeBrowser({ firefox }) {
  const listeners = new Map();
  const event = (name) => ({
    addListener: (listener) => listeners.set(name, [...(listeners.get(name) ?? []), listener]),
    removeListener: (listener) => listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== listener)),
    hasListener: (listener) => (listeners.get(name) ?? []).includes(listener),
  });
  const area = (data) => ({
    get: async (keys) => Object.fromEntries([keys].flat().filter((key) => key in data).map((key) => [key, data[key]])),
    set: async (values) => Object.assign(data, values),
  });
  const openedOptions = [];
  const downloads = {
    onCreated: event('downloads.onCreated'),
    onChanged: event('downloads.onChanged'),
    onErased: event('downloads.onErased'),
    search: async () => [],
  };
  if (!firefox) downloads.onDeterminingFilename = event('downloads.onDeterminingFilename');
  const chrome = {
    downloads,
    storage: {
      local: area({
        rules: [{ id: 'r1', domain: 'example.com', folder: 'Example', includeSubdomains: true, enabled: true }],
        settings: { enabled: true, conflictAction: 'uniquify', preferSource: 'page' },
      }),
      session: area({}),
      onChanged: event('storage.onChanged'),
    },
    runtime: {
      id: 'downhere-id',
      getURL: (path) => `chrome-extension://downhere-id/${path}`,
      OnInstalledReason: { INSTALL: 'install', UPDATE: 'update' },
      onInstalled: event('runtime.onInstalled'),
      openOptionsPage: async () => openedOptions.push(true),
    },
  };
  return { chrome, listeners, openedOptions };
}

let starts = 0;

async function startBackground(browser) {
  const fake = fakeBrowser({ firefox: browser === 'firefox' });
  globalThis.chrome = fake.chrome;
  // A new query string loads a fresh copy of the module every time.
  await import(`../extension/background.js?${browser}-${++starts}`);
  // Let the startup work that runs in the background finish.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return fake;
}

after(() => {
  delete globalThis.chrome;
});

describe('background.js', () => {
  it('answers Chrome while it names a download', async () => {
    const { listeners } = await startBackground('chrome');
    assert.equal(listeners.has('downloads.onCreated'), false);
    const [listener] = listeners.get('downloads.onDeterminingFilename');
    const suggestion = await new Promise((resolve) => {
      assert.equal(listener({ url: 'https://example.com/report.pdf', referrer: '', filename: 'report.pdf' }, resolve), true);
    });
    assert.deepEqual(suggestion, { filename: 'Example/report.pdf', conflictAction: 'uniquify' });
  });

  it('gives DownHere’s own helper files the names it chose (Chrome)', async () => {
    const { chrome, listeners } = await startBackground('chrome');
    const [listener] = listeners.get('downloads.onDeterminingFilename');
    const ask = (item) =>
      new Promise((resolve) => {
        assert.equal(listener({ referrer: '', filename: '1234.txt', ...item }, (...args) => resolve(args)), true);
      });
    const url = 'blob:chrome-extension://downhere-id/1234';
    await chrome.storage.session.set({ helperFile: { url, name: 'DownHere - choose this folder.txt' } });
    assert.deepEqual(await ask({ url, byExtensionId: 'downhere-id' }), [
      { filename: 'DownHere - choose this folder.txt', conflictAction: 'uniquify' },
    ]);
    // Another download of DownHere's, or a stored name for another file: no change.
    assert.deepEqual(await ask({ url: 'blob:chrome-extension://downhere-id/5678', byExtensionId: 'downhere-id' }), []);
    // Other extensions' downloads are sorted by the rules as usual.
    assert.deepEqual(await ask({ url: 'https://example.com/a.pdf', byExtensionId: 'someone-else', filename: 'a.pdf' }), [
      { filename: 'Example/a.pdf', conflictAction: 'uniquify' },
    ]);
  });

  it('downloads files again in Firefox', async () => {
    const { listeners } = await startBackground('firefox');
    for (const name of ['downloads.onCreated', 'downloads.onChanged', 'downloads.onErased']) {
      assert.equal(listeners.get(name)?.length, 1, name);
    }
    assert.equal(listeners.has('storage.onChanged'), false);
  });

  it('opens the settings page after it is installed', async () => {
    const { listeners, openedOptions } = await startBackground('firefox');
    const [onInstalled] = listeners.get('runtime.onInstalled');
    onInstalled({ reason: 'update' });
    assert.equal(openedOptions.length, 0);
    onInstalled({ reason: 'install' });
    assert.equal(openedOptions.length, 1);
  });
});
