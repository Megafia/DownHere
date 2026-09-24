// extension/manifest.json works in both Chrome and Firefox, so the extension
// folder can be loaded as it is while developing. The packages leave out the
// keys the other browser needs, which would only cause warnings.

export const BROWSERS = Object.freeze(['chrome', 'firefox']);

/** Returns a copy of `manifest` with only the keys that `browser` uses. */
export function manifestFor(browser, manifest) {
  const result = structuredClone(manifest);
  if (browser === 'chrome') {
    delete result.background.scripts;
    delete result.browser_specific_settings;
  } else if (browser === 'firefox') {
    delete result.background.service_worker;
    delete result.minimum_chrome_version;
  } else {
    throw new Error(`Unknown browser: ${browser}`);
  }
  return result;
}
