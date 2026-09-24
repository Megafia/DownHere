// Lets people choose a rule's folder in the browser's own save dialog.
//
// Browsers only let extensions save files inside the Downloads folder, and
// they don't tell extensions where that folder is. A web page can open a
// folder dialog, but never learns where the chosen folder is. So DownHere
// asks the browser to save a small text file with its save dialog, in which
// the person opens the folder they want and clicks Save. Then it saves a
// second small file without a dialog, which the browser puts directly into
// the Downloads folder. The full paths of the two files show which folder
// inside the Downloads folder was chosen. Both files are deleted right away.
//
// In Chrome, the extension that watches downloads names every download,
// including DownHere's own, so background.js gives these files their names
// through helperFileName().

import { checkFolderName, normalizeFolder } from './rules.js';

export const CHOOSE_FILE_NAME = 'DownHere - choose this folder.txt';
export const CHECK_FILE_NAME = 'DownHere - Downloads folder check.txt';

// What the files say, in case one is ever left behind.
export const HELPER_FILE_TEXT =
  'DownHere saved this file to find out which folder you chose for a rule.\n' +
  'It deletes the file right away. If it is still here, you can delete it.\n';
const HELPER_FILE_BYTES = new TextEncoder().encode(HELPER_FILE_TEXT).length;

// storage.session key for the helper file being saved: {url, name}.
export const HELPER_KEY = 'helperFile';

// Only one folder can be chosen at a time, across all DownHere pages.
const LOCK_NAME = 'downhere-folder-picker';

// A helper file name, possibly with the number a browser adds when the name
// is taken: "name (1).txt" in Chrome, "name(1).txt" in Firefox.
const HELPER_FILE_PATTERN = new RegExp(
  `^(?:${[CHOOSE_FILE_NAME, CHECK_FILE_NAME].map((name) => escapeRegExp(name.slice(0, -4))).join('|')})` +
    ' ?(?:\\(\\d+\\))?\\.txt$',
);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error?.message ?? error);
}

/**
 * True if a download is one of DownHere's own helper files. `extensionUrl` is
 * chrome.runtime.getURL(''); the files are saved from blob: addresses that the
 * extension's pages create.
 */
export function isHelperDownload(item, { extensionId, extensionUrl }) {
  return item.byExtensionId === extensionId && typeof item.url === 'string' && item.url.startsWith(`blob:${extensionUrl}`);
}

/** The name for the helper file saved from `url`, or "" if there is none. */
export async function helperFileName(storage, url) {
  const { [HELPER_KEY]: helper } = await storage.get(HELPER_KEY);
  const known = helper?.name === CHOOSE_FILE_NAME || helper?.name === CHECK_FILE_NAME;
  return known && helper.url === url ? helper.name : '';
}

// ---------------------------------------------------------------------------
// Working out the folder
// ---------------------------------------------------------------------------

/**
 * Works out the rule folder from where the two helper files were saved:
 * `chosenPath` is the file saved with the dialog, and `checkPath` the file
 * saved without it, directly in the Downloads folder. Both are full paths, as
 * the downloads API reports them.
 *
 * @returns {{outcome: 'chosen', folder: string}
 *   | {outcome: 'downloads-folder'}
 *   | {outcome: 'outside', downloadsFolder: string}
 *   | {outcome: 'invalid', error: string}}
 */
export function folderFromSavedFiles(chosenPath, checkPath) {
  // Full paths start with "/" everywhere but on Windows.
  const windows = !checkPath.startsWith('/');
  const directoryParts = (path) =>
    path
      .split(windows ? /[\\/]/ : '/')
      // Keep the first part ("" for "/" and for network paths, or "C:"), and
      // skip the empty ones that repeated separators leave.
      .filter((part, index) => index === 0 || part !== '')
      .slice(0, -1);
  const downloadsParts = directoryParts(checkPath);
  const chosenParts = directoryParts(chosenPath);
  // Windows ignores upper and lower case in paths.
  const same = windows ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
  const inside =
    downloadsParts.length > 0 &&
    downloadsParts.length <= chosenParts.length &&
    downloadsParts.every((part, index) => same(part, chosenParts[index]));
  if (!inside) return { outcome: 'outside', downloadsFolder: parentFolder(checkPath, windows) };

  const parts = chosenParts.slice(downloadsParts.length);
  if (parts.length === 0) return { outcome: 'downloads-folder' };
  for (const part of parts) {
    const problem = checkFolderName(part);
    if (problem) return { outcome: 'invalid', error: problem };
  }
  const folder = parts.join('/');
  // A rule keeps what normalizeFolder() makes of its folder, which must still
  // be the same folder.
  const normalized = normalizeFolder(folder);
  if (!normalized.ok || normalized.folder !== folder) {
    return { outcome: 'invalid', error: normalized.ok ? 'Its name would change.' : normalized.error };
  }
  return { outcome: 'chosen', folder };
}

// The folder a file is in, as the operating system writes it.
function parentFolder(path, windows) {
  const folder = path.slice(0, Math.max(path.lastIndexOf('/'), windows ? path.lastIndexOf('\\') : -1));
  if (folder === '') return '/';
  return windows && /^[a-z]:$/i.test(folder) ? `${folder}\\` : folder;
}

/**
 * What to tell the person after choosing a folder didn't work out. Returns ""
 * for a chosen folder or a closed dialog.
 */
export function folderChoiceMessage(result) {
  switch (result.outcome) {
    case 'busy':
      return 'A save dialog for choosing a folder is already open in another DownHere tab.';
    case 'downloads-folder':
      return (
        'That’s your Downloads folder itself. Choose a folder inside it (the dialog can also create one), ' +
        'or type a folder name.'
      );
    case 'outside':
      return (
        `That folder isn’t inside your Downloads folder (${result.downloadsFolder}). ` +
        'Browsers only let extensions save files there.'
      );
    case 'invalid':
      return `DownHere can’t use that folder. ${result.error}`;
    case 'check-failed':
      return (
        'DownHere couldn’t find your Downloads folder, because its second small file wasn’t saved. ' +
        `Try again, and if you’re asked where to save “${CHECK_FILE_NAME}”, just click Save.`
      );
    case 'no-path':
      return (
        'Your browser didn’t tell DownHere where it saved the file. On Linux, this happens with folder names ' +
        'that have letters like é or ü when the system doesn’t use UTF-8.'
      );
    case 'failed':
      return /^FILE_/.test(result.error)
        ? `The browser couldn’t save a file in that folder (${result.error}).`
        : `Choosing a folder didn’t work (${result.error}). You can type the folder name instead.`;
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Saving the helper files
// ---------------------------------------------------------------------------

/**
 * Lets the person choose a folder in the browser's save dialog and works out
 * where it is inside the Downloads folder. `api` holds what this needs from
 * the browser: {downloads, storage (storage.session), locks (navigator.locks),
 * extensionId, extensionUrl}. `onProgress` is told when the save dialog opens
 * ('choosing') and when the second file is being saved ('checking').
 *
 * @returns {Promise<object>} One of the results of folderFromSavedFiles(), or
 *   {outcome: 'cancelled' | 'busy' | 'check-failed' | 'no-path'}, or
 *   {outcome: 'failed', error: string}.
 */
export function chooseFolder(api, { onProgress = () => {} } = {}) {
  return api.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
    if (!lock) return { outcome: 'busy' };
    await removeLeftovers(api);
    const helpers = new HelperFiles(api);
    try {
      onProgress('choosing');
      const chosen = await helpers.save(CHOOSE_FILE_NAME, { saveAs: true });
      if (chosen.cancelled) return { outcome: 'cancelled' };
      if (chosen.error) return { outcome: 'failed', error: chosen.error };
      onProgress('checking');
      const check = await helpers.save(CHECK_FILE_NAME, { saveAs: false });
      // A browser set to ask where to save every file shows a dialog for this
      // one too.
      if (!check.item) return { outcome: 'check-failed' };
      // Chrome on Linux reports no path when a name can't be converted to the
      // system's character set.
      if (!chosen.item.filename || !check.item.filename) return { outcome: 'no-path' };
      return folderFromSavedFiles(chosen.item.filename, check.item.filename);
    } catch (error) {
      return { outcome: 'failed', error: messageOf(error) };
    } finally {
      await helpers.removeAll();
    }
  });
}

// Saves helper files, waits for them and deletes them again.
class HelperFiles {
  constructor(api) {
    this.api = api;
    this.ids = [];
    // Downloads being waited for: [{id, check}].
    this.waiters = [];
    this.onChanged = (delta) => this.recheck(delta.id);
    this.onErased = (id) => this.recheck(id);
    // Listen before anything is saved, so no change can be missed.
    api.downloads.onChanged.addListener(this.onChanged);
    api.downloads.onErased.addListener(this.onErased);
  }

  recheck(id) {
    for (const waiter of this.waiters) {
      if (waiter.id === id) waiter.check();
    }
  }

  /**
   * Saves a helper file and waits until it is saved or has failed.
   * Returns {item} for a saved file, {cancelled: true} if the save dialog was
   * closed, or {error}.
   */
  async save(name, { saveAs }) {
    const url = URL.createObjectURL(new Blob([HELPER_FILE_TEXT], { type: 'text/plain' }));
    try {
      await this.api.storage.set({ [HELPER_KEY]: { url, name } });
      let id;
      try {
        id = await this.api.downloads.download({ url, filename: name, saveAs, conflictAction: 'uniquify' });
      } catch (error) {
        // Firefox reports a closed save dialog as an error.
        if (/cancel/i.test(messageOf(error))) return { cancelled: true };
        return { error: messageOf(error) };
      }
      this.ids.push(id);
      const item = await this.waitUntilDone(id);
      if (item?.state === 'complete') return { item };
      // Chrome reports a closed save dialog as an interrupted download. A
      // download that was removed from the list meanwhile counts as closed too.
      if (!item || item.error === 'USER_CANCELED') return { cancelled: true };
      return { error: item.error || 'INTERRUPTED' };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Resolves with the download once it is no longer in progress, or with
  // null if it was removed from the list.
  waitUntilDone(id) {
    return new Promise((resolve, reject) => {
      const waiter = {
        id,
        check: () =>
          this.api.downloads.search({ id }).then(
            ([item]) => {
              if (item?.state === 'in_progress') return;
              this.waiters = this.waiters.filter((entry) => entry !== waiter);
              resolve(item ?? null);
            },
            (error) => {
              this.waiters = this.waiters.filter((entry) => entry !== waiter);
              reject(error);
            },
          ),
      };
      this.waiters.push(waiter);
      waiter.check();
    });
  }

  // Deletes the helper files and removes them from the downloads list.
  async removeAll() {
    this.api.downloads.onChanged.removeListener(this.onChanged);
    this.api.downloads.onErased.removeListener(this.onErased);
    try {
      await this.api.storage.remove(HELPER_KEY);
    } catch {
      // Only needed while a file is being saved.
    }
    for (const id of this.ids) await removeHelperDownload(this.api.downloads, id);
  }
}

async function removeHelperDownload(downloads, id) {
  try {
    const [item] = await downloads.search({ id });
    if (!item) return;
    if (item.state === 'in_progress') await downloads.cancel(id);
    else if (item.state === 'complete' && item.exists) await downloads.removeFile(id);
    await downloads.erase({ id });
  } catch {
    // The file or the list entry may already be gone.
  }
}

/**
 * Deletes helper files that were left behind, for example because a DownHere
 * page was closed while its save dialog was open. Runs before a folder is
 * chosen, and only deletes files that are exactly helper files.
 */
async function removeLeftovers(api) {
  let items;
  try {
    items = await api.downloads.search({ urlRegex: `^blob:${escapeRegExp(api.extensionUrl)}` });
  } catch {
    return;
  }
  for (const item of items) {
    if (!isHelperDownload(item, api) || item.state === 'in_progress') continue;
    const name = String(item.filename ?? '').split(/[\\/]/).pop();
    const isHelperFile = item.state === 'complete' && item.fileSize === HELPER_FILE_BYTES && HELPER_FILE_PATTERN.test(name);
    // A saved file with another name was renamed in the dialog, so leave it.
    if (item.state === 'complete' && !isHelperFile) continue;
    try {
      if (isHelperFile && item.exists) await api.downloads.removeFile(item.id);
      await api.downloads.erase({ id: item.id });
    } catch {
      // Try again next time.
    }
  }
}
