// Chooses the folder for each download while Chrome is naming the file.

import { resolveDownload } from './lib/rules.js';
import { loadState } from './lib/storage.js';

// The listener must be registered synchronously at startup so that Chrome can
// wake this service worker for it. It answers asynchronously (after reading
// the rules), which Chrome only allows when the listener returns exactly
// `true` - an async function would return a Promise instead. Every path ends
// in exactly one suggest() call, so a download is never left waiting.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  chooseLocation(item)
    .catch((error) => {
      console.error('DownHere: could not check the rules for a download.', error);
      return null;
    })
    .then((suggestion) => (suggestion ? suggest(suggestion) : suggest()));
  return true;
});

/** Returns the suggestion for Chrome, or null to leave the download alone. */
async function chooseLocation(item) {
  const { rules, settings } = await loadState();
  const decision = resolveDownload(item, rules, settings, chrome.runtime.id);
  if (decision.action === 'route') {
    return { filename: decision.filename, conflictAction: decision.conflictAction };
  }
  if (decision.reason === 'unsafe-filename') {
    console.warn(
      `DownHere: left "${item.filename}" in the Downloads folder because Chrome ` +
        `doesn't accept that file name inside the "${decision.rule.folder}" folder.`,
    );
  }
  return null;
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    // Show the settings page once so new users can add their first rule.
    chrome.runtime.openOptionsPage().catch(() => {});
  }
});
