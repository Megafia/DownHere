// Sorts downloads in Firefox.
//
// Firefox has no downloads.onDeterminingFilename, so an extension can't choose
// the folder while a download is being named. Instead DownHere lets each
// download finish where Firefox saves it, downloads the same address again
// into the rule's folder, and deletes the first file only once the second one
// is complete and matches it. Whenever something doesn't work out, the first
// file stays where it is, so a download is never lost.
//
// Firefox can unload the background page between events, so the downloads
// being sorted are kept in storage.session rather than in variables.

import { checkFirefoxName, resolveDownload } from './rules.js';

const JOBS_KEY = 'redownloads';

// Downloads that started longer ago than this are never sorted, in case
// Firefox ever reports downloads from its history as new ones.
const MAX_AGE_MS = 10 * 60 * 1000;

// The cookie stores of normal and private windows. Any other one belongs to a
// container, and downloading again outside it would send the wrong cookies.
const DEFAULT_COOKIE_STORES = new Set(['firefox-default', 'firefox-private']);

// Why a download from a website with a rule stays where it is, for the console.
const SKIP_EXPLANATIONS = {
  'not-repeatable': "a file that a page created itself can't be downloaded again",
  container: "downloads in container tabs aren't downloaded again",
  'unsafe-filename': "its name can't be used inside a folder",
  'unsafe-folder': "Firefox would change the name of the rule's folder",
};

/**
 * Decides whether a Firefox download should be downloaded again into a rule's
 * folder. Works like resolveDownload(), and also skips downloads that can't be
 * repeated faithfully.
 */
export function planRedownload(item, rules, settings) {
  const decision = resolveDownload(item, rules, settings);
  if (decision.action !== 'route') return decision;
  const skip = (reason) => ({ action: 'skip', reason, rule: decision.rule });
  // Includes DownHere's own second downloads.
  if (item.byExtensionId) return skip('extension');
  // A blob: address only works inside the page that created it.
  if (!/^(?:https?|data):/i.test(item.url ?? '')) return skip('not-repeatable');
  if (item.cookieStoreId && !DEFAULT_COOKIE_STORES.has(item.cookieStoreId)) return skip('container');
  // Firefox changes "%" to "_" in the paths extensions give it, which would
  // rename the file or put it into another folder, and refuses paths with some
  // space characters or names ending in ".desktop". Rules made with versions
  // before 0.3.0 can have such folders.
  const parts = decision.filename.split('/');
  if (checkFirefoxName(parts.pop())) return skip('unsafe-filename');
  if (parts.some((part) => checkFirefoxName(part))) return skip('unsafe-folder');
  // Firefox can't ask where to save a file that an extension downloads.
  const conflictAction = decision.conflictAction === 'prompt' ? 'uniquify' : decision.conflictAction;
  return { ...decision, conflictAction };
}

function directoryParts(path) {
  return path.split(/[\\/]/).slice(0, -1);
}

/**
 * True if the first file was saved directly in the Downloads folder. Firefox
 * saves the second download as <Downloads folder>/<rule folder>/<name>, which
 * shows where the Downloads folder is. A first file anywhere else was put
 * there on purpose (for example through "Always ask you where to save files"),
 * so it is left alone.
 */
export function isInDownloadsFolder(firstPath, secondPath, folder) {
  const secondDir = directoryParts(secondPath);
  const downloadsDir = secondDir.slice(0, secondDir.length - folder.split('/').length);
  return downloadsDir.length > 0 && downloadsDir.join('/') === directoryParts(firstPath).join('/');
}

/** True if two finished downloads have the same size and type. */
export function isSameFile(first, second) {
  const size = (item) => (Number.isInteger(item.fileSize) && item.fileSize >= 0 ? item.fileSize : -1);
  if (size(first) === -1 || size(first) !== size(second)) return false;
  return !first.mime || !second.mime || first.mime === second.mime;
}

/**
 * Creates the listeners for downloads.onCreated, onChanged and onErased.
 * `downloads` is the downloads API, `storage` the storage area that keeps the
 * downloads being sorted, and `loadState` returns the rules and settings.
 */
export function createRedownloader({ downloads, storage, loadState, log = console, now = Date.now }) {
  // Events are handled one at a time, so two events about the same download
  // can't interleave.
  let queue = Promise.resolve();
  const enqueue = (task) => {
    queue = queue.then(task).catch((error) => log.error('DownHere: could not sort a download.', error));
    return queue;
  };

  // A job is {id, copyId}: the download being sorted and its second download,
  // or null until that has started.
  async function loadJobs() {
    const stored = await storage.get(JOBS_KEY);
    return Array.isArray(stored[JOBS_KEY]) ? stored[JOBS_KEY] : [];
  }

  async function findJob(downloadId) {
    const jobs = await loadJobs();
    return jobs.find((job) => job.id === downloadId || job.copyId === downloadId) ?? null;
  }

  async function saveJob(job) {
    const jobs = (await loadJobs()).filter((entry) => entry.id !== job.id);
    await storage.set({ [JOBS_KEY]: [...jobs, job] });
  }

  async function dropJob(id) {
    const jobs = await loadJobs();
    const remaining = jobs.filter((job) => job.id !== id);
    if (remaining.length !== jobs.length) await storage.set({ [JOBS_KEY]: remaining });
  }

  async function getDownload(id) {
    const [item] = await downloads.search({ id });
    return item ?? null;
  }

  async function handleCreated(item) {
    const started = Date.parse(item.startTime);
    if (started < now() - MAX_AGE_MS) return;
    const { rules, settings } = await loadState();
    const plan = planRedownload(item, rules, settings);
    if (plan.action !== 'route') {
      const explanation = plan.rule && SKIP_EXPLANATIONS[plan.reason];
      if (explanation) log.warn(`DownHere: left "${item.filename}" where it is because ${explanation}.`);
      return;
    }
    await saveJob({ id: item.id, copyId: null });
    // A small file can be complete before this event is handled.
    const current = await getDownload(item.id);
    if (current?.state === 'complete') await startCopy(item.id);
    else if (current?.state !== 'in_progress') await dropJob(item.id);
  }

  async function handleChanged(delta) {
    const state = delta.state?.current;
    if (state !== 'complete' && state !== 'interrupted') return;
    const job = await findJob(delta.id);
    if (!job) return;
    if (job.id === delta.id) {
      if (state === 'complete') await startCopy(job.id);
      else if (job.copyId === null) await dropJob(job.id);
    } else if (state === 'complete') {
      await finish(job);
    } else {
      // The second download failed or was canceled: keep the first file.
      const first = await getDownload(job.id);
      if (first) log.warn(`DownHere: left "${first.filename}" where it is because downloading it again didn't work.`);
      await discardCopy(job);
    }
  }

  async function handleErased(id) {
    const job = await findJob(id);
    if (job) await dropJob(job.id);
  }

  async function startCopy(id) {
    const job = await findJob(id);
    if (!job || job.id !== id || job.copyId !== null) return;
    const first = await getDownload(id);
    const { rules, settings } = await loadState();
    const plan = first?.state === 'complete' && first.exists ? planRedownload(first, rules, settings) : null;
    if (plan?.action !== 'route') {
      await dropJob(id);
      return;
    }
    let copyId;
    try {
      copyId = await downloads.download({
        url: first.url,
        filename: plan.filename,
        conflictAction: plan.conflictAction,
        saveAs: false,
        ...(first.incognito && { incognito: true }),
        // Some websites only hand out files to visitors coming from their pages.
        ...(first.referrer && { headers: [{ name: 'Referer', value: first.referrer }] }),
      });
    } catch (error) {
      await dropJob(id);
      log.warn(`DownHere: left "${first.filename}" where it is because Firefox couldn't download it again.`, error);
      return;
    }
    await saveJob({ id, copyId });
    const copy = await getDownload(copyId);
    if (copy && !isInDownloadsFolder(first.filename, copy.filename, plan.rule.folder)) {
      log.warn(`DownHere: left "${first.filename}" where it is because it was saved outside the Downloads folder.`);
      await discardCopy({ id, copyId });
    }
  }

  async function finish({ id, copyId }) {
    await dropJob(id);
    const first = await getDownload(id);
    const copy = await getDownload(copyId);
    // If the first file is already gone, the second one simply stays.
    if (copy?.state !== 'complete' || first?.state !== 'complete' || !first.exists) return;
    if (isSameFile(first, copy)) {
      await downloads.removeFile(id);
      await downloads.erase({ id });
    } else {
      // The address gave something else the second time, such as a sign-in page.
      log.warn(`DownHere: left "${first.filename}" where it is because downloading it again gave a different file.`);
      await removeDownload(copyId);
    }
  }

  async function discardCopy({ id, copyId }) {
    await dropJob(id);
    await removeDownload(copyId);
  }

  // Deletes a download's file, finished or not, and removes it from the list.
  async function removeDownload(id) {
    let item = await getDownload(id);
    if (!item) return;
    if (item.state !== 'complete') {
      try {
        // Canceling also deletes what was downloaded so far.
        await downloads.cancel(id);
      } catch {
        // It finished in the meantime.
        item = await getDownload(id);
      }
    }
    if (item?.state === 'complete' && item.exists) await downloads.removeFile(id);
    await downloads.erase({ id });
  }

  return {
    onCreated: (item) => enqueue(() => handleCreated(item)),
    onChanged: (delta) => enqueue(() => handleChanged(delta)),
    onErased: (id) => enqueue(() => handleErased(id)),
  };
}
