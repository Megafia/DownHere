// Chooses the folder for each download. Chrome lets DownHere answer while it
// names the file. Firefox can't, so there DownHere downloads the file again
// into the rule's folder instead (see lib/redownload.js).

import { createRedownloader } from './lib/redownload.js';
import { isRoutingActive, resolveDownload } from './lib/rules.js';
import { loadState } from './lib/storage.js';

const downloadEvent = chrome.downloads.onDeterminingFilename;
let listenerUpdates = 0;

if (downloadEvent) {
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
} else {
  // Firefox also only wakes this background page for listeners that were
  // added synchronously when it started.
  const redownloader = createRedownloader({ downloads: chrome.downloads, storage: chrome.storage.session, loadState });
  chrome.downloads.onCreated.addListener(redownloader.onCreated);
  chrome.downloads.onChanged.addListener(redownloader.onChanged);
  chrome.downloads.onErased.addListener(redownloader.onErased);
}

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
