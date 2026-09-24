import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { BROWSERS, manifestFor } from '../scripts/manifests.mjs';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const manifest = readJson('../extension/manifest.json');

describe('manifest', () => {
  it('has the same version as package.json', () => {
    assert.equal(manifest.version, readJson('../package.json').version);
  });

  it('gives Chrome only the keys Chrome uses', () => {
    const chrome = manifestFor('chrome', manifest);
    assert.deepEqual(chrome.background, { service_worker: 'background.js', type: 'module' });
    assert.equal('browser_specific_settings' in chrome, false);
    assert.equal(chrome.minimum_chrome_version, manifest.minimum_chrome_version);
  });

  it('gives Firefox only the keys Firefox uses', () => {
    const firefox = manifestFor('firefox', manifest);
    assert.deepEqual(firefox.background, { scripts: ['background.js'], type: 'module' });
    assert.equal('minimum_chrome_version' in firefox, false);
    assert.deepEqual(firefox.browser_specific_settings, manifest.browser_specific_settings);
  });

  it('keeps everything else and leaves the original alone', () => {
    const before = structuredClone(manifest);
    const browserKeys = ['background', 'browser_specific_settings', 'minimum_chrome_version'];
    const shared = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !browserKeys.includes(key)));
    for (const browser of BROWSERS) assert.deepEqual(shared(manifestFor(browser, manifest)), shared(manifest), browser);
    assert.deepEqual(manifest, before);
    assert.throws(() => manifestFor('safari', manifest), /Unknown browser/);
  });
});
