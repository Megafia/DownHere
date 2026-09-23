// Chooses the folder for each download while Chrome is naming the file.

import { isRoutingActive, resolveDownload } from './lib/rules.js';
import { loadState } from './lib/storage.js';

const downloadEvent = chrome.downloads.onDeterminingFilename;
let listenerUpdates = 0;

// Chrome lets the extension that was installed or updated most recently decide
// every download it is told about, even when it answers "no change", and the
// file names other extensions ask for are then ignored. So DownHere only
// listens while it is switched on and has a rule switched on.
//
// The listener is still added synchronously on every start, because Chrome can
// only wake this service worker for events that were registered that way;
// updateListener() removes it again when it isn't needed.
downloadEvent.addListener(onDeterminingFilename);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && ('rules' in changes || 'settings' in changes)) updateListener();
});
updateListener();

async function updateListener() {
  // Only the newest call decides, so an older, slower read can't undo it.
  const current = ++listenerUpdates;
  let needed = true;
  try {
    const { rules, settings } = await loadState();
    needed = isRoutingActive(rules, settings);
  } catch (error) {
    console.error('DownHere: could not read the rules.', error);
  }
  if (current !== listenerUpdates) return;
  const listening = downloadEvent.hasListener(onDeterminingFilename);
  if (needed && !listening) downloadEvent.addListener(onDeterminingFilename);
  if (!needed && listening) downloadEvent.removeListener(onDeterminingFilename);
}

// Chrome only accepts an asynchronous answer when the listener returns exactly
// `true` (an async function would return a Promise instead). Every path ends in
// exactly one suggest() call, so a download is never left waiting.
function onDeterminingFilename(item, suggest) {
  chooseLocation(item)
    .catch((error) => {
      console.error('DownHere: could not check the rules for a download.', error);
      return null;
    })
    .then((suggestion) => (suggestion ? suggest(suggestion) : suggest()));
  return true;
}

/** Returns the suggestion for Chrome, or null to leave the download alone. */
async function chooseLocation(item) {
  const { rules, settings } = await loadState();
  const decision = resolveDownload(item, rules, settings);
  if (decision.action === 'route') {
    return { filename: decision.filename, conflictAction: decision.conflictAction };
  }
  if (decision.reason === 'unsafe-filename') {
    console.warn(
      `DownHere: left "${item.filename}" in the Downloads folder because some versions of Chrome ` +
        `don't accept that file name inside a folder.`,
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
