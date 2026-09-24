// Small DOM helpers shared by the popup and the options page.

import { displayFolder, normalizeFolder } from './rules.js';

const PROPERTIES = new Set(['checked', 'disabled', 'hidden']);

/** The browser DownHere runs in: 'firefox' or 'chrome' (which includes other Chromium browsers). */
export const BROWSER = chrome.runtime.getURL('').startsWith('moz-extension:') ? 'firefox' : 'chrome';

/** Hides the elements marked with a data-browser attribute for the other browser. */
export function showBrowserSpecific(root = document) {
  for (const element of root.querySelectorAll('[data-browser]')) {
    element.hidden = element.dataset.browser !== BROWSER;
  }
}

/**
 * Creates an element. `props` become attributes, except `className`,
 * `dataset` and the boolean properties listed in PROPERTIES. Text children are
 * inserted as text, never parsed as HTML.
 */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'className') element.className = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (PROPERTIES.has(key)) element[key] = Boolean(value);
    else element.setAttribute(key, String(value));
  }
  element.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

/** Shows or clears the error message that belongs to an input. */
export function setFieldError(input, errorElement, message) {
  errorElement.textContent = message || '';
  errorElement.hidden = !message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

/**
 * Updates the line under a folder input: where files will be saved, or what
 * is wrong with the name. Returns true if the folder is valid.
 */
export function updateFolderHint(input, hint) {
  const text = input.value.trim();
  if (text === '') {
    hint.textContent = 'A folder inside your Downloads folder. Use / for subfolders.';
    hint.classList.remove('is-error');
    input.removeAttribute('aria-invalid');
    return false;
  }
  const result = normalizeFolder(text);
  hint.textContent = result.ok ? `Saves to ${displayFolder(result.folder)}` : result.error;
  hint.classList.toggle('is-error', !result.ok);
  if (result.ok) input.removeAttribute('aria-invalid');
  return result.ok;
}

/** Shows a folder error from a failed save and marks the input invalid. */
export function showFolderError(input, hint, message) {
  hint.textContent = message;
  hint.classList.add('is-error');
  input.setAttribute('aria-invalid', 'true');
}

/**
 * The message shown after a rule is added or saved, e.g. describeSavedRule('Saved', rule, settings).
 * It only promises a folder when the rule will actually be used.
 */
export function describeSavedRule(verb, rule, settings) {
  if (!settings.enabled) {
    return `${verb}. DownHere is paused, so the rule for ${rule.domain} isn’t used until you switch DownHere back on.`;
  }
  if (!rule.enabled) return `${verb}. The rule for ${rule.domain} is switched off.`;
  return `${verb}. Downloads from ${rule.domain} will be saved in ${displayFolder(rule.folder)}.`;
}

/** Fills a <datalist> with the folders already used by rules. */
export function fillFolderSuggestions(datalist, rules) {
  const folders = [...new Set(rules.map((rule) => rule.folder))].sort((a, b) => a.localeCompare(b));
  datalist.replaceChildren(...folders.map((folder) => h('option', { value: folder })));
}
