// Reads and writes DownHere's rules and settings in chrome.storage.local.

import { sanitizeRules, sanitizeSettings } from './rules.js';

const LOCK_NAME = 'downhere-storage';

/** Loads the current rules and settings, cleaned up and with defaults applied. */
export async function loadState() {
  const stored = await chrome.storage.local.get(['rules', 'settings']);
  return {
    rules: sanitizeRules(stored.rules),
    settings: sanitizeSettings(stored.settings),
  };
}

/**
 * Applies a change to the stored state. `change` receives the latest state and
 * returns a result object; its `rules` and/or `settings` are saved unless
 * `ok` is false. The popup and the options page can be open at the same time,
 * so the read-change-write runs under a lock shared by all extension pages.
 */
export function updateState(change) {
  return navigator.locks.request(LOCK_NAME, async () => {
    const result = change(await loadState());
    if (result.ok === false) return result;
    const updates = {};
    if (result.rules) updates.rules = result.rules;
    if (result.settings) updates.settings = result.settings;
    if (Object.keys(updates).length > 0) await chrome.storage.local.set(updates);
    return result;
  });
}

/** Saves a partial settings change such as `{enabled: false}`. */
export function updateSettings(patch) {
  return updateState(({ settings }) => ({
    ok: true,
    settings: sanitizeSettings({ ...settings, ...patch }),
  }));
}

/** Calls `callback` whenever the rules or settings change anywhere. */
export function watchState(callback) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && ('rules' in changes || 'settings' in changes)) callback();
  });
}
