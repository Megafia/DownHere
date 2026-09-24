// Rule matching and download path logic for DownHere.
//
// This module has no chrome.* dependencies, so the service worker, the
// extension pages and the Node test runner can all share it.

export const CONFLICT_ACTIONS = Object.freeze(['uniquify', 'overwrite', 'prompt']);
export const PREFER_SOURCES = Object.freeze(['page', 'file']);

export const DEFAULT_SETTINGS = Object.freeze({
  // Master switch. When false, DownHere doesn't touch any download.
  enabled: true,
  // What the browser should do when a routed file's name is already taken.
  conflictAction: 'uniquify',
  // Which address wins when the page and the file match different rules.
  preferSource: 'page',
});

// ---------------------------------------------------------------------------
// Hosts and domains
// ---------------------------------------------------------------------------

const DOMAIN_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
const IPV6_PATTERN = /^\[[0-9a-f:.]+\]$/;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
// "*.example.com" or ".example.com", optionally after a scheme.
const WILDCARD_PATTERN = /^((?:[a-z][a-z0-9+.-]*:\/\/)?)\*?\./i;

// Lowercases a host name and drops a trailing dot and a leading "www.", so
// "WWW.Example.com." and "example.com" are treated as the same site. "www." is
// kept when only one label would remain ("www.com" isn't the same as "com").
function canonicalHost(hostname) {
  let host = hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('www.') && host.indexOf('.', 4) !== -1) host = host.slice(4);
  return host;
}

// Chrome's URL parser keeps some hosts that aren't real domain names (it
// escapes spaces as %20, for example), so check the result explicitly.
function isValidHost(host) {
  return DOMAIN_PATTERN.test(host) || IPV6_PATTERN.test(host);
}

/**
 * Returns the canonical host of an http(s) URL, or "" if it has none.
 * blob: and filesystem: URLs report the host of the page that created them.
 */
export function hostFromUrl(url) {
  // data: URLs never have a host and can be megabytes long, so skip parsing.
  if (typeof url !== 'string' || url === '' || /^data:/i.test(url)) return '';
  let parsed;
  try {
    parsed = new URL(url);
    if (parsed.protocol === 'blob:' || parsed.protocol === 'filesystem:') {
      // Browsers report the creator as the origin; other parsers only keep it
      // in the path ("blob:https://example.com/<id>").
      parsed = new URL(parsed.origin !== 'null' ? parsed.origin : parsed.pathname);
    }
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  const host = canonicalHost(parsed.hostname);
  return isValidHost(host) ? host : '';
}

/**
 * Turns an address typed by a person into a URL: "example.com/file.zip" and
 * "localhost:3000/file.zip" get "https://", and "http:/example.com" is read as
 * "http://example.com".
 */
export function toWebAddress(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value === '' || SCHEME_PATTERN.test(value) || /^(?:blob|data|file|filesystem):/i.test(value)) return value;
  const typo = /^(https?):\/*/i.exec(value);
  if (typo) return `${typo[1]}://${value.slice(typo[0].length)}`;
  return `https://${value}`;
}

function parseHostname(text) {
  if (SCHEME_PATTERN.test(text)) {
    try {
      const url = new URL(text);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : null;
    } catch {
      return null;
    }
  }
  // Bare IPv6 addresses such as "::1" only parse inside brackets.
  for (const candidate of [`http://${text}`, `http://[${text}]`]) {
    try {
      return new URL(candidate).hostname;
    } catch {
      // Try the next form.
    }
  }
  return null;
}

/**
 * Normalizes what someone typed as a rule's domain. Accepts bare domains
 * ("example.com"), full addresses ("https://www.example.com/page") and
 * wildcards ("*.example.com" or ".example.com", reported through `wildcard`).
 *
 * @returns {{ok: true, domain: string, wildcard: boolean} | {ok: false, error: string}}
 */
export function normalizeDomain(input) {
  let text = typeof input === 'string' ? input.trim() : '';
  if (text === '') {
    return { ok: false, error: 'Enter a website domain, like example.com.' };
  }
  // "http:/example.com" and "https:example.com" are typos, not "host:port".
  text = text.replace(/^https?:\/?(?!\/)/i, '');
  // Chrome can't parse "*" in a host name, so strip the wildcard first.
  const wildcard = WILDCARD_PATTERN.exec(text);
  if (wildcard) text = wildcard[1] + text.slice(wildcard[0].length);
  const hostname = parseHostname(text);
  const domain = hostname === null ? '' : canonicalHost(hostname);
  if (!isValidHost(domain)) {
    return { ok: false, error: 'That doesn’t look like a website domain. Try something like example.com.' };
  }
  return { ok: true, domain, wildcard: wildcard !== null };
}

/** True if `host` (as returned by hostFromUrl) is covered by `rule`. */
export function hostMatchesRule(host, rule) {
  if (!host) return false;
  return host === rule.domain || (rule.includeSubdomains && host.endsWith(`.${rule.domain}`));
}

/**
 * Finds the rule for a host. When several rules cover it, the most specific
 * domain wins, so a rule for "docs.example.com" beats one for "example.com".
 */
export function findRuleForHost(rules, host, { includeDisabled = false } = {}) {
  let best = null;
  for (const rule of rules) {
    if (!includeDisabled && !rule.enabled) continue;
    if (!hostMatchesRule(host, rule)) continue;
    if (!best || rule.domain.length > best.domain.length) best = rule;
  }
  return best;
}

/**
 * Picks the rule for a download. The page it came from (the referrer) and the
 * file's own address (before and after redirects) are checked in the order
 * given by `preferSource`; the first address with a matching rule decides.
 *
 * @returns {{rule: object, source: 'page' | 'file', host: string} | null}
 */
export function findRuleForDownload(item, rules, preferSource = DEFAULT_SETTINGS.preferSource) {
  const page = [['page', item.referrer]];
  const file = [['file', item.url], ['file', item.finalUrl]];
  const order = preferSource === 'file' ? [...file, ...page] : [...page, ...file];
  for (const [source, url] of order) {
    const host = hostFromUrl(url);
    if (!host) continue;
    const rule = findRuleForHost(rules, host);
    if (rule) return { rule, source, host };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Folder and file names
//
// Chrome only accepts a suggested download path if every part of it passes
// net::IsSafePortablePathComponent(). Anything else is silently ignored and
// the file lands in the Downloads folder instead, so the checks below mirror
// Chrome's rules to catch problems while the user is still typing. They apply
// in Firefox too, so rules and backups work in both browsers.
// ---------------------------------------------------------------------------

const ALWAYS_ILLEGAL = new Set(['"', '*', '/', ':', '<', '>', '?', '\\', '|']);
const CONTROL_CHAR = /\p{Cc}/u;
const FORMAT_CHAR = /\p{Cf}/u;
const WHITESPACE_CHAR = /\p{White_Space}/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SHORT_NAME_BREAKERS = /[\p{White_Space}"/:+|<>=;?,*]/u;
// Firefox's downloads API turns these space characters into ordinary spaces,
// and drops the line and paragraph separators.
const FIREFOX_SPACES = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f]/u;
// Firefox treats these as Linux desktop shortcuts. The shortcut extensions
// Chrome rejects too are in SHELL_EXTENSIONS.
const FIREFOX_SHORTCUT = /\.desktop$/i;
const SHELL_EXTENSIONS = new Set(['local', 'lnk', 'scf', 'url']);
const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul', 'clock$',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);
const RESERVED_FILE_NAMES = new Set(['desktop.ini', 'thumbs.db', 'conin$', 'conout$']);
const MAX_FOLDER_NAME_BYTES = 255;

function asciiLowerCase(text) {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function isNoncharacter(codePoint) {
  return (codePoint >= 0xfdd0 && codePoint <= 0xfdef) || (codePoint & 0xfffe) === 0xfffe;
}

function describeCodePoint(char) {
  return `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

// Windows can refuse names that look like 8.3 short names (e.g. "PROGRA~1").
function couldBeWindowsShortName(name) {
  if (name.length > 12 || !name.includes('~') || SHORT_NAME_BREAKERS.test(name)) return false;
  const firstDot = name.indexOf('.');
  if (firstDot === -1) return name.length <= 8;
  if (firstDot !== name.lastIndexOf('.')) return false;
  return firstDot > 0 && firstDot <= 8 && firstDot + 4 >= name.length;
}

/** Mirrors base::IsReservedNameOnWindows(), which Chrome applies on every OS. */
export function isReservedWindowsName(name) {
  const trimmed = asciiLowerCase(name).replace(/[ .]+$/, '');
  const beforeFirstDot = trimmed.split('.', 1)[0];
  return (
    RESERVED_DEVICE_NAMES.has(trimmed) ||
    RESERVED_DEVICE_NAMES.has(beforeFirstDot) ||
    RESERVED_FILE_NAMES.has(trimmed)
  );
}

/**
 * Checks one component of a download path the way Chrome does.
 * Returns an explanation of the problem, or "" when the name is fine.
 *
 * `windowsShortNames` applies a rule Chrome only enforces on Windows. It is
 * on by default so that folder rules keep working on every computer.
 */
export function checkPathComponent(name, { windowsShortNames = true } = {}) {
  if (typeof name !== 'string' || name === '') return 'Folder names can’t be empty.';
  if (name === '.' || name === '..') return 'A folder can’t be named “.” or “..”.';
  if (LONE_SURROGATE.test(name)) return 'This name contains an invalid character.';
  for (const char of name) {
    if (ALWAYS_ILLEGAL.has(char)) return `Folder names can’t contain the character ${char}`;
    if (CONTROL_CHAR.test(char) || FORMAT_CHAR.test(char) || isNoncharacter(char.codePointAt(0))) {
      return `This name contains an invisible or unsupported character (${describeCodePoint(char)}).`;
    }
  }
  const chars = Array.from(name);
  for (const edge of [chars[0], chars[chars.length - 1]]) {
    if (edge === '.' || edge === '~' || WHITESPACE_CHAR.test(edge)) {
      return 'Folder names can’t start or end with a space, a dot (.) or a tilde (~).';
    }
  }
  if (windowsShortNames && couldBeWindowsShortName(name)) {
    return `Windows doesn’t allow short names with a tilde like “${name}”. Make it longer or remove the ~.`;
  }
  const lastDot = name.lastIndexOf('.');
  const extension = lastDot === -1 ? '' : asciiLowerCase(name.slice(lastDot + 1));
  if (SHELL_EXTENSIONS.has(extension) || (extension.startsWith('{') && extension.endsWith('}'))) {
    return `Names ending in “.${name.slice(lastDot + 1)}” aren’t allowed.`;
  }
  if (isReservedWindowsName(name)) return `“${name}” is a reserved name on Windows.`;
  return '';
}

/**
 * Explains what Firefox's downloads API would change in a name, or returns ""
 * when it keeps the name as it is. Firefox changes "%" to "_", so a file would
 * be saved in a differently named folder, and rejects some space characters
 * and names ending in ".desktop", to which it would add ".download".
 */
export function checkFirefoxName(name) {
  if (name.includes('%')) return 'Folder names can’t contain %, because Firefox changes it to _.';
  const space = FIREFOX_SPACES.exec(name)?.[0];
  if (space) return `This name contains a special space or line break (${describeCodePoint(space)}). Use an ordinary space.`;
  if (FIREFOX_SHORTCUT.test(name)) {
    return `Names ending in “${name.slice(name.lastIndexOf('.'))}” aren’t allowed, because Firefox adds “.download” to them.`;
  }
  return '';
}

/** Explains why Firefox can't save files in a rule's folder such as "Work/100%", or returns "". */
export function checkFirefoxFolder(folder) {
  for (const part of folder.split('/')) {
    const problem = checkFirefoxName(part);
    if (problem) return problem;
  }
  return '';
}

/**
 * Checks one folder name typed by the user. Returns "" when it is fine.
 * `portable: false` allows names that only Firefox can't use, which rules
 * made before version 0.3.0 may have.
 */
export function checkFolderName(name, { portable = true } = {}) {
  const problem = checkPathComponent(name, { windowsShortNames: true }) || (portable ? checkFirefoxName(name) : '');
  if (problem) return problem;
  if (new TextEncoder().encode(name).length > MAX_FOLDER_NAME_BYTES) {
    return `The folder name “${Array.from(name).slice(0, 20).join('')}…” is too long.`;
  }
  return '';
}

/**
 * Normalizes a folder typed by the user into a relative path such as
 * "Work/Invoices". Backslashes are accepted as separators, and spaces around
 * each folder name are removed. `portable` is passed on to checkFolderName().
 *
 * @returns {{ok: true, folder: string} | {ok: false, error: string}}
 */
export function normalizeFolder(input, { portable = true } = {}) {
  const text = typeof input === 'string' ? input.trim() : '';
  const emptyError = 'Enter a folder name, like Work or Work/Invoices.';
  if (text === '') return { ok: false, error: emptyError };
  if (/^(?:[a-z]:|[\\/]|~(?:[\\/]|$))/i.test(text)) {
    return {
      ok: false,
      error: 'Use a folder inside Downloads, like Work/Invoices, not a full path. ' +
        'Browsers don’t let extensions save anywhere else.',
    };
  }
  const parts = text
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '.');
  if (parts.length === 0) return { ok: false, error: emptyError };
  for (const part of parts) {
    const problem = checkFolderName(part, { portable });
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true, folder: parts.join('/') };
}

/**
 * Like normalizeFolder(), but lets a rule that is being edited keep its folder
 * (`current`) even if only Firefox can't use it (see checkFolderName()).
 */
export function normalizeRuleFolder(input, current) {
  const result = normalizeFolder(input);
  if (result.ok || current === undefined) return result;
  const kept = normalizeFolder(input, { portable: false });
  return kept.ok && kept.folder === current ? kept : result;
}

/** How a folder is shown to people: "Downloads/Work/Invoices". */
export function displayFolder(folder) {
  return folder ? `Downloads/${folder}` : 'Downloads';
}

/**
 * Joins a rule's folder with the file name the browser proposed (Firefox
 * reports a full path, of which only the name is used). Returns "" when Chrome
 * would reject the file name inside a suggested path; the download is then
 * left alone rather than renamed.
 */
export function buildTargetPath(folder, proposedFilename) {
  const name = String(proposedFilename ?? '').split(/[\\/]/).pop();
  if (!name || checkPathComponent(name, { windowsShortNames: false })) return '';
  return `${folder}/${name}`;
}

// ---------------------------------------------------------------------------
// Deciding what to do with a download
// ---------------------------------------------------------------------------

/**
 * True when DownHere has something to do: it is switched on and at least one
 * rule is switched on.
 */
export function isRoutingActive(rules, settings) {
  return settings.enabled && rules.some((rule) => rule.enabled);
}

/**
 * Decides where a download should go.
 *
 * @param {object} item The chrome.downloads.DownloadItem being named.
 * @returns {{action: 'route', filename: string, conflictAction: string, rule: object, source: string, host: string}
 *   | {action: 'skip', reason: string, rule?: object}}
 */
export function resolveDownload(item, rules, settings) {
  if (!settings.enabled) return { action: 'skip', reason: 'disabled' };
  // Chrome ignores suggestions for files opened from the computer.
  if (/^file:/i.test(item.url ?? '')) return { action: 'skip', reason: 'local-file' };
  const match = findRuleForDownload(item, rules, settings.preferSource);
  if (!match) return { action: 'skip', reason: 'no-rule' };
  const filename = buildTargetPath(match.rule.folder, item.filename);
  if (!filename) return { action: 'skip', reason: 'unsafe-filename', rule: match.rule };
  return { action: 'route', filename, conflictAction: settings.conflictAction, ...match };
}

// ---------------------------------------------------------------------------
// Stored data
// ---------------------------------------------------------------------------

function newRuleId() {
  return globalThis.crypto.randomUUID();
}

/** Returns valid settings, filling anything missing or invalid with defaults. */
export function sanitizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const pick = (key, isValid) => (isValid(value[key]) ? value[key] : DEFAULT_SETTINGS[key]);
  return {
    enabled: pick('enabled', (entry) => typeof entry === 'boolean'),
    conflictAction: pick('conflictAction', (entry) => CONFLICT_ACTIONS.includes(entry)),
    preferSource: pick('preferSource', (entry) => PREFER_SOURCES.includes(entry)),
  };
}

/**
 * Returns the valid rules from stored or imported data, normalized and with
 * one rule per domain (the first one wins). Every rule gets a unique id.
 */
export function sanitizeRules(raw) {
  if (!Array.isArray(raw)) return [];
  const seenDomains = new Set();
  const seenIds = new Set();
  const rules = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const domain = normalizeDomain(entry.domain);
    // Keep rules whose folder only Firefox can't use (see checkFolderName()).
    const folder = normalizeFolder(entry.folder, { portable: false });
    if (!domain.ok || !folder.ok || seenDomains.has(domain.domain)) continue;
    seenDomains.add(domain.domain);
    const hasUsableId = typeof entry.id === 'string' && entry.id !== '' && !seenIds.has(entry.id);
    const id = hasUsableId ? entry.id : newRuleId();
    seenIds.add(id);
    rules.push({
      id,
      domain: domain.domain,
      includeSubdomains:
        typeof entry.includeSubdomains === 'boolean' ? entry.includeSubdomains || domain.wildcard : true,
      folder: folder.folder,
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
    });
  }
  return rules;
}

/** Sorts rules alphabetically by domain for display. */
export function sortRules(rules) {
  return [...rules].sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
}

/**
 * Validates a rule typed into a form. `editingId` is the rule being edited,
 * which may keep its own domain and folder.
 *
 * @returns {{ok: true, value: {domain: string, includeSubdomains: boolean, folder: string}}
 *   | {ok: false, errors: {domain?: string, folder?: string}}}
 */
export function validateRuleInput(input, rules, editingId = null) {
  const errors = {};
  const domain = normalizeDomain(input.domain);
  const folder = normalizeRuleFolder(input.folder, rules.find((rule) => rule.id === editingId)?.folder);
  if (!domain.ok) {
    errors.domain = domain.error;
  } else if (rules.some((rule) => rule.domain === domain.domain && rule.id !== editingId)) {
    errors.domain = `There’s already a rule for ${domain.domain}.`;
  }
  if (!folder.ok) errors.folder = folder.error;
  if (errors.domain || errors.folder) return { ok: false, errors };
  return {
    ok: true,
    value: {
      domain: domain.domain,
      includeSubdomains: Boolean(input.includeSubdomains) || domain.wildcard,
      folder: folder.folder,
    },
  };
}

export function addRule(rules, input) {
  const result = validateRuleInput(input, rules);
  if (!result.ok) return result;
  const rule = { id: newRuleId(), ...result.value, enabled: true };
  return { ok: true, rule, rules: [...rules, rule] };
}

export function editRule(rules, id, input) {
  const index = rules.findIndex((rule) => rule.id === id);
  if (index === -1) return { ok: false, errors: { form: 'This rule no longer exists.' } };
  const result = validateRuleInput(input, rules, id);
  if (!result.ok) return result;
  const rule = { ...rules[index], ...result.value };
  return { ok: true, rule, rules: rules.map((existing) => (existing.id === id ? rule : existing)) };
}

export function setRuleEnabled(rules, id, enabled) {
  if (!rules.some((rule) => rule.id === id)) {
    return { ok: false, errors: { form: 'This rule no longer exists.' } };
  }
  return {
    ok: true,
    rules: rules.map((rule) => (rule.id === id ? { ...rule, enabled: Boolean(enabled) } : rule)),
  };
}

export function removeRule(rules, id) {
  const index = rules.findIndex((rule) => rule.id === id);
  if (index === -1) return { ok: false, errors: { form: 'This rule no longer exists.' } };
  return { ok: true, rule: rules[index], index, rules: rules.filter((rule) => rule.id !== id) };
}

/** Puts back a rule removed by removeRule(), unless its domain was reused. */
export function restoreRule(rules, rule, index) {
  if (rules.some((existing) => existing.domain === rule.domain)) {
    return { ok: false, errors: { form: `A new rule for ${rule.domain} was added in the meantime.` } };
  }
  const next = rules.filter((existing) => existing.id !== rule.id);
  next.splice(Math.min(Math.max(index, 0), next.length), 0, rule);
  return { ok: true, rules: next };
}

/**
 * Merges imported rules into the current ones. A rule for a domain that
 * already has one replaces its folder and switches.
 */
export function mergeRules(rules, imported) {
  const next = rules.map((rule) => ({ ...rule }));
  let added = 0;
  let updated = 0;
  for (const incoming of imported) {
    const existing = next.find((rule) => rule.domain === incoming.domain);
    const fields = {
      includeSubdomains: incoming.includeSubdomains,
      folder: incoming.folder,
      enabled: incoming.enabled,
    };
    if (existing) {
      Object.assign(existing, fields);
      updated += 1;
    } else {
      next.push({ id: newRuleId(), domain: incoming.domain, ...fields });
      added += 1;
    }
  }
  return { rules: next, added, updated };
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export const BACKUP_FORMAT = 'downhere-backup';

export function createBackup(rules, settings, now = new Date()) {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: now.toISOString(),
    settings: sanitizeSettings(settings),
    rules: rules.map(({ domain, includeSubdomains, folder, enabled }) => ({
      domain,
      includeSubdomains,
      folder,
      enabled,
    })),
  };
}

/**
 * Reads a backup file's text. Accepts the object written by createBackup()
 * or a plain array of rules.
 *
 * @returns {{ok: true, rules: object[], settings: object | null, skipped: number}
 *   | {ok: false, error: string}}
 */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file isn’t a DownHere backup (it isn’t valid JSON).' };
  }
  const rawRules = Array.isArray(data) ? data : data && typeof data === 'object' ? data.rules : undefined;
  if (!Array.isArray(rawRules)) {
    return { ok: false, error: 'This file doesn’t contain any DownHere rules.' };
  }
  const rules = sanitizeRules(rawRules);
  const hasSettings = !Array.isArray(data) && data.settings && typeof data.settings === 'object';
  return {
    ok: true,
    rules,
    settings: hasSettings ? sanitizeSettings(data.settings) : null,
    skipped: rawRules.length - rules.length,
  };
}
