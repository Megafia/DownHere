import { CHECK_FILE_NAME, chooseFolder, folderChoiceMessage } from '../lib/folder-picker.js';
import {
  DEFAULT_SETTINGS,
  addRule,
  createBackup,
  displayFolder,
  editRule,
  findRuleForDownload,
  findRuleForHost,
  hostFromUrl,
  mergeRules,
  parseBackup,
  removeRule,
  restoreRule,
  setRuleEnabled,
  sortRules,
  toWebAddress,
} from '../lib/rules.js';
import { loadState, updateSettings, updateState, watchState } from '../lib/storage.js';
import {
  BROWSER,
  describeSavedRule,
  fillFolderSuggestions,
  h,
  setFieldError,
  showBrowserSpecific,
  showFolderError,
  updateFolderHint,
} from '../lib/ui.js';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

const $ = (id) => document.getElementById(id);

let state = { rules: [], settings: { ...DEFAULT_SETTINGS } };
// The rule being edited in place, with the values typed so far:
// {id, domain, folder, includeSubdomains, errors, folderMessage, saving}.
let editing = null;
let refreshCount = 0;
// Set while a delete or an undo is being saved, so they can't overlap.
let busy = false;
// Rules deleted while the current "Undo" message is showing: [{rule, index}].
let undoStack = [];
// What a folder is being chosen for in the save dialog: 'add' for the add
// form, the id of the rule being edited, or null.
let picking = null;
// Resolves once the stored rules have been shown for the first time.
let firstRenderDone;
const firstRender = new Promise((resolve) => {
  firstRenderDone = resolve;
});

// The popup's Browse… button opens this page with the popup's form in the
// address, to choose the folder here: a popup closes when a dialog opens.
const fromPopup = readPopupForm();

showBrowserSpecific();
setUpAddForm();
setUpRuleList();
setUpSettings();
setUpTester();
setUpBackup();
setUpToast();
watchState(refresh);
refresh();
if (fromPopup) firstRender.then(() => continueFromPopup(fromPopup));

async function refresh() {
  // Ignore results that arrive after a newer refresh has started.
  const current = ++refreshCount;
  const next = await loadState();
  if (current !== refreshCount) return;
  state = next;
  render();
}

function render() {
  renderSettings();
  renderRules();
  fillFolderSuggestions($('folder-suggestions'), state.rules);
  firstRenderDone();
}

function applyRules(rules) {
  state = { ...state, rules };
  render();
}

// ---------------------------------------------------------------------------
// Adding rules
// ---------------------------------------------------------------------------

function setUpAddForm() {
  const form = $('add-form');
  const domain = $('add-domain');
  const folder = $('add-folder');
  const folderHint = $('add-folder-hint');
  updateFolderHint(folder, folderHint);

  domain.addEventListener('input', () => setFieldError(domain, $('add-domain-error'), ''));
  folder.addEventListener('input', () => updateFolderHint(folder, folderHint));
  $('add-browse').addEventListener('click', () => browseForFolder('add'));

  let adding = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (adding) return;
    adding = true;
    try {
      const input = {
        domain: domain.value,
        folder: folder.value,
        includeSubdomains: form.elements.includeSubdomains.checked,
      };
      const result = await updateState(({ rules }) => addRule(rules, input));
      if (!result.ok) {
        setFieldError(domain, $('add-domain-error'), result.errors.domain);
        if (result.errors.folder) showFolderError(folder, folderHint, result.errors.folder);
        (result.errors.domain ? domain : folder).focus();
        return;
      }
      applyRules(result.rules);
      form.reset();
      setFieldError(domain, $('add-domain-error'), '');
      updateFolderHint(folder, folderHint);
      domain.focus();
      showToast(describeSavedRule('Added', result.rule, state.settings));
    } finally {
      adding = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Rule list
// ---------------------------------------------------------------------------

function renderRules() {
  const list = $('rule-list');
  if (editing && !state.rules.some((rule) => rule.id === editing.id)) editing = null;

  // Re-rendering replaces the elements, so remember what had focus.
  const active = document.activeElement;
  const focusKey = list.contains(active) ? active.dataset.focusKey : undefined;
  const selection =
    focusKey && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;

  list.replaceChildren(
    ...sortRules(state.rules).map((rule) => (editing?.id === rule.id ? editRow(rule) : ruleRow(rule))),
  );
  $('rules-empty').hidden = state.rules.length > 0;
  $('rule-count').textContent = state.rules.length > 0 ? `(${state.rules.length})` : '';

  if (focusKey) {
    const target = list.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    if (target) {
      target.focus();
      if (selection) target.setSelectionRange(...selection);
    }
  }
}

function ruleRow(rule) {
  return h(
    'li',
    { className: rule.enabled ? 'rule' : 'rule is-off', dataset: { ruleId: rule.id } },
    h(
      'label',
      { className: 'switch', title: rule.enabled ? 'Rule is on' : 'Rule is off' },
      h('input', {
        type: 'checkbox',
        role: 'switch',
        checked: rule.enabled,
        'aria-label': `Use the rule for ${rule.domain}`,
        dataset: { action: 'toggle', focusKey: `toggle:${rule.id}` },
      }),
      h('span', { className: 'switch-track', 'aria-hidden': 'true' }),
    ),
    h(
      'div',
      { className: 'rule-text' },
      h(
        'p',
        { className: 'rule-domain' },
        h('span', { className: 'domain' }, rule.domain),
        rule.includeSubdomains ? h('span', { className: 'tag' }, '+ subdomains') : null,
        rule.enabled ? null : h('span', { className: 'tag tag-off' }, 'off'),
      ),
      h('p', { className: 'rule-folder' }, displayFolder(rule.folder)),
    ),
    h(
      'div',
      { className: 'rule-actions' },
      h(
        'button',
        {
          className: 'btn btn-quiet',
          type: 'button',
          'aria-label': `Edit the rule for ${rule.domain}`,
          dataset: { action: 'edit', focusKey: `edit:${rule.id}` },
        },
        'Edit',
      ),
      h(
        'button',
        {
          className: 'btn btn-quiet btn-danger',
          type: 'button',
          'aria-label': `Delete the rule for ${rule.domain}`,
          dataset: { action: 'delete', focusKey: `delete:${rule.id}` },
        },
        'Delete',
      ),
    ),
  );
}

function editRow(rule) {
  const ids = {
    domain: `edit-domain-${rule.id}`,
    domainError: `edit-domain-error-${rule.id}`,
    folder: `edit-folder-${rule.id}`,
    folderHint: `edit-folder-hint-${rule.id}`,
  };
  const domainInput = h('input', {
    className: 'input',
    id: ids.domain,
    name: 'domain',
    type: 'text',
    value: editing.domain,
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    'aria-describedby': ids.domainError,
    dataset: { focusKey: `edit-domain:${rule.id}` },
  });
  const domainError = h('p', { className: 'error', id: ids.domainError, hidden: true });
  const folderInput = h('input', {
    className: 'input',
    id: ids.folder,
    name: 'folder',
    type: 'text',
    value: editing.folder,
    list: 'folder-suggestions',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': ids.folderHint,
    dataset: { focusKey: `edit-folder:${rule.id}` },
  });
  const folderHint = h('p', { className: 'hint', id: ids.folderHint });
  updateFolderHint(folderInput, folderHint);
  setFieldError(domainInput, domainError, editing.errors.domain);
  // A message from choosing a folder is newer than an error from saving.
  if (editing.folderMessage) showFolderMessage(folderHint, editing.folderMessage);
  else if (editing.errors.folder) showFolderError(folderInput, folderHint, editing.errors.folder);
  const browseButton = h(
    'button',
    {
      className: 'btn',
      type: 'button',
      disabled: picking !== null,
      title: 'Choose the folder in your browser’s save dialog',
      'aria-describedby': ids.folderHint,
      dataset: { action: 'browse', browse: '', focusKey: `edit-browse:${rule.id}` },
    },
    'Browse…',
  );

  const form = h(
    'form',
    { className: 'rule-form rule-edit', novalidate: '', dataset: { ruleId: rule.id } },
    h(
      'div',
      { className: 'field' },
      h('label', { className: 'label', for: ids.domain }, 'Website'),
      domainInput,
      domainError,
    ),
    h(
      'div',
      { className: 'field' },
      h('label', { className: 'label', for: ids.folder }, 'Folder'),
      h('div', { className: 'folder-row' }, folderInput, browseButton),
      folderHint,
    ),
    h(
      'div',
      { className: 'form-footer' },
      h(
        'label',
        { className: 'check' },
        h('input', {
          type: 'checkbox',
          name: 'includeSubdomains',
          checked: editing.includeSubdomains,
          dataset: { focusKey: `edit-subdomains:${rule.id}` },
        }),
        'Include subdomains',
      ),
      h(
        'div',
        { className: 'button-row' },
        h(
          'button',
          { className: 'btn', type: 'button', dataset: { action: 'cancel', focusKey: `edit-cancel:${rule.id}` } },
          'Cancel',
        ),
        h('button', { className: 'btn btn-primary', type: 'submit', dataset: { focusKey: `edit-save:${rule.id}` } }, 'Save'),
      ),
    ),
  );
  return h('li', { className: 'rule is-editing', dataset: { ruleId: rule.id } }, form);
}

function setUpRuleList() {
  const list = $('rule-list');

  list.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    // The second click of a double-click would land on whatever moved under
    // the pointer after the first one, such as the next rule's Delete button.
    if (event.detail > 1) return;
    const id = button.closest('li').dataset.ruleId;
    const { action } = button.dataset;
    if (action === 'edit') startEditing(id);
    // A click with detail 0 comes from the keyboard (Enter or Space).
    else if (action === 'delete') deleteRule(id, { fromKeyboard: event.detail === 0 });
    else if (action === 'cancel') stopEditing(id);
    else if (action === 'browse') browseForFolder(id);
  });

  list.addEventListener('change', (event) => {
    const input = event.target;
    if (input.dataset.action === 'toggle') {
      toggleRule(input.closest('li').dataset.ruleId, input.checked);
    } else if (editing && input.name === 'includeSubdomains') {
      editing.includeSubdomains = input.checked;
    }
  });

  list.addEventListener('input', (event) => {
    const input = event.target;
    if (!editing || (input.name !== 'domain' && input.name !== 'folder')) return;
    editing[input.name] = input.value;
    editing.errors[input.name] = undefined;
    if (input.name === 'domain') {
      setFieldError(input, document.getElementById(`edit-domain-error-${editing.id}`), '');
    } else {
      editing.folderMessage = null;
      updateFolderHint(input, document.getElementById(`edit-folder-hint-${editing.id}`));
    }
  });

  list.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && editing && event.target.closest('form')) {
      event.preventDefault();
      stopEditing(editing.id);
    }
  });

  list.addEventListener('submit', (event) => {
    event.preventDefault();
    saveEdit(event.target.dataset.ruleId);
  });
}

function startEditing(id) {
  const rule = state.rules.find((candidate) => candidate.id === id);
  if (!rule) return;
  editing = {
    id,
    domain: rule.domain,
    folder: rule.folder,
    includeSubdomains: rule.includeSubdomains,
    errors: {},
    folderMessage: null,
  };
  renderRules();
  document.getElementById(`edit-folder-${id}`)?.focus();
}

function stopEditing(id) {
  editing = null;
  renderRules();
  focusRuleButton('edit', id);
}

async function saveEdit(id) {
  if (editing?.id !== id || editing.saving) return;
  const draft = editing;
  draft.saving = true;
  const input = { domain: draft.domain, folder: draft.folder, includeSubdomains: draft.includeSubdomains };
  const result = await updateState(({ rules }) => editRule(rules, id, input));
  draft.saving = false;
  if (!result.ok) {
    if (result.errors.form) {
      editing = null;
      showToast(result.errors.form);
      refresh();
      return;
    }
    if (editing !== draft) return;
    editing.errors = result.errors;
    editing.folderMessage = null;
    renderRules();
    document.getElementById(result.errors.domain ? `edit-domain-${id}` : `edit-folder-${id}`)?.focus();
    return;
  }
  editing = null;
  applyRules(result.rules);
  focusRuleButton('edit', id);
  showToast(describeSavedRule('Saved', result.rule, state.settings));
}

function focusRuleButton(action, id) {
  const button = $('rule-list').querySelector(`[data-focus-key="${CSS.escape(`${action}:${id}`)}"]`);
  button?.focus();
  return Boolean(button);
}

async function toggleRule(id, enabled) {
  const result = await updateState(({ rules }) => setRuleEnabled(rules, id, enabled));
  if (!result.ok) {
    showToast(result.errors.form);
    refresh();
    return;
  }
  applyRules(result.rules);
}

async function deleteRule(id, { fromKeyboard }) {
  if (busy) return;
  busy = true;
  try {
    // Pick where focus should go once the row is gone.
    const sorted = sortRules(state.rules);
    const position = sorted.findIndex((rule) => rule.id === id);
    const neighbor = sorted[position + 1] ?? sorted[position - 1];

    const result = await updateState(({ rules }) => removeRule(rules, id));
    if (!result.ok) {
      showToast(result.errors.form);
      refresh();
      return;
    }
    if (editing?.id === id) editing = null;
    applyRules(result.rules);
    if (!neighbor || !focusRuleButton('delete', neighbor.id)) $('rules-title').focus();

    // Deleting several rules in a row lets one Undo bring them all back.
    const continuing = toastAction === undoDeletes && $('toast').classList.contains('is-visible');
    if (!continuing) undoStack = [];
    undoStack.push({ rule: result.rule, index: result.index });
    const message =
      undoStack.length === 1 ? `Deleted the rule for ${result.rule.domain}.` : `Deleted ${undoStack.length} rules.`;
    showToast(message, { actionLabel: 'Undo', onAction: undoDeletes });
    // Keyboard users couldn't reach the Undo button before it disappears.
    if (fromKeyboard) $('toast-action').focus();
  } finally {
    busy = false;
  }
}

async function undoDeletes() {
  const deleted = undoStack;
  if (deleted.length === 0 || busy) return;
  busy = true;
  try {
    await restoreDeleted(deleted);
  } finally {
    busy = false;
  }
}

async function restoreDeleted(deleted) {
  const result = await updateState(({ rules }) => {
    let next = rules;
    const restored = [];
    const skipped = [];
    // Put rules back in the opposite order they were deleted in.
    for (const { rule, index } of [...deleted].reverse()) {
      const attempt = restoreRule(next, rule, index);
      if (attempt.ok) {
        next = attempt.rules;
        restored.push(rule);
      } else {
        skipped.push(rule);
      }
    }
    return { ok: true, rules: next, restored, skipped };
  });
  undoStack = [];
  applyRules(result.rules);
  const { restored, skipped } = result;
  const parts = [];
  if (restored.length === 1) parts.push(`Restored the rule for ${restored[0].domain}.`);
  if (restored.length > 1) parts.push(`Restored ${restored.length} rules.`);
  if (skipped.length === 1) {
    parts.push(`The rule for ${skipped[0].domain} wasn’t restored because there’s a newer rule for it.`);
  }
  if (skipped.length > 1) {
    parts.push(`${skipped.length} rules weren’t restored because there are newer rules for those websites.`);
  }
  if (restored.length === 0 || !focusRuleButton('edit', restored[restored.length - 1].id)) $('rules-title').focus();
  showToast(parts.join(' '));
}

// ---------------------------------------------------------------------------
// Choosing a folder in the browser's save dialog
// ---------------------------------------------------------------------------

function folderPickerApi() {
  return {
    downloads: chrome.downloads,
    storage: chrome.storage.session,
    locks: navigator.locks,
    extensionId: chrome.runtime.id,
    extensionUrl: chrome.runtime.getURL(''),
  };
}

function showFolderMessage(hint, { text, isError = false }) {
  hint.textContent = text;
  hint.classList.toggle('is-error', isError);
}

// Shows a message under the folder field of the add form ('add') or of the
// rule being edited (its id).
function setFolderMessage(target, message) {
  if (target === 'add') {
    showFolderMessage($('add-folder-hint'), message);
  } else if (editing?.id === target) {
    editing.folderMessage = message;
    const hint = document.getElementById(`edit-folder-hint-${target}`);
    if (hint) showFolderMessage(hint, message);
  }
}

function setBrowseButtonsEnabled(enabled) {
  for (const button of document.querySelectorAll('[data-browse]')) button.disabled = !enabled;
}

/**
 * Lets the person choose the folder for the add form ('add') or for the rule
 * being edited (its id) in the browser's save dialog.
 */
async function browseForFolder(target) {
  if (picking !== null) return;
  picking = target;
  setBrowseButtonsEnabled(false);
  setFolderMessage(target, { text: 'In the save dialog, open the folder you want and click Save.' });
  let slowCheck;
  let result;
  try {
    result = await chooseFolder(folderPickerApi(), {
      onProgress: (step) => {
        if (step !== 'checking') return;
        // Saving the second file only takes this long when the browser asks
        // where to save it.
        slowCheck = setTimeout(() => {
          setFolderMessage(target, {
            text: `Your browser is asking where to save “${CHECK_FILE_NAME}”. Click Save without changing the folder.`,
          });
        }, 1000);
      },
    });
  } catch (error) {
    result = { outcome: 'failed', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(slowCheck);
    picking = null;
    setBrowseButtonsEnabled(true);
  }
  showFolderChoice(target, result);
}

// Puts the chosen folder into the field, or says why no folder was chosen.
function showFolderChoice(target, result) {
  const message = folderChoiceMessage(result);
  const chosen = result.outcome === 'chosen';
  if (target === 'add') {
    const folder = $('add-folder');
    const hint = $('add-folder-hint');
    if (chosen) folder.value = result.folder;
    updateFolderHint(folder, hint);
    if (message) showFolderMessage(hint, { text: message, isError: true });
    (chosen ? folder : $('add-browse')).focus();
    return;
  }
  // The rule may have been deleted in another tab meanwhile.
  if (editing?.id !== target) return;
  if (chosen) {
    editing.folder = result.folder;
    editing.errors.folder = undefined;
  }
  editing.folderMessage = message ? { text: message, isError: true } : null;
  renderRules();
  const focusKey = chosen ? `edit-folder:${target}` : `edit-browse:${target}`;
  $('rule-list').querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
}

/** Reads the popup's form from this page's address and removes it from there. */
function readPopupForm() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get('browse') !== '1') return null;
  // Reloading the page mustn't open the save dialog again.
  history.replaceState(null, '', location.pathname + location.search);
  return {
    ruleId: params.get('rule'),
    domain: params.get('domain') ?? '',
    folder: params.get('folder') ?? '',
    includeSubdomains: params.get('subdomains') !== '0',
  };
}

// Fills in the popup's form here and opens the save dialog for its folder.
function continueFromPopup({ ruleId, ...values }) {
  if (ruleId && state.rules.some((rule) => rule.id === ruleId)) {
    startEditing(ruleId);
    Object.assign(editing, values);
    renderRules();
    document.getElementById(`edit-folder-${ruleId}`)?.scrollIntoView({ block: 'center' });
    browseForFolder(ruleId);
    return;
  }
  $('add-domain').value = values.domain;
  $('add-folder').value = values.folder;
  $('add-form').elements.includeSubdomains.checked = values.includeSubdomains;
  updateFolderHint($('add-folder'), $('add-folder-hint'));
  browseForFolder('add');
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function renderSettings() {
  const { settings } = state;
  $('enabled').checked = settings.enabled;
  $('enabled-text').textContent = settings.enabled ? 'On' : 'Paused';
  $('paused-banner').hidden = settings.enabled;
  $('conflict-action').value = settings.conflictAction;
  for (const radio of document.querySelectorAll('input[name="prefer-source"]')) {
    radio.checked = radio.value === settings.preferSource;
  }
}

function setUpSettings() {
  const save = async (patch) => {
    const result = await updateSettings(patch);
    state = { ...state, settings: result.settings };
    renderSettings();
  };
  $('enabled').addEventListener('change', (event) => save({ enabled: event.target.checked }));
  // Firefox can't ask where to save a file that DownHere downloads again. The
  // setting can still arrive from a Chrome backup; it then keeps both files.
  $('conflict-action').querySelector('option[value="prompt"]').disabled = BROWSER === 'firefox';
  $('conflict-action').addEventListener('change', (event) => save({ conflictAction: event.target.value }));
  for (const radio of document.querySelectorAll('input[name="prefer-source"]')) {
    radio.addEventListener('change', () => save({ preferSource: radio.value }));
  }
}

// ---------------------------------------------------------------------------
// Download checker
// ---------------------------------------------------------------------------

function setUpTester() {
  $('test-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const output = $('test-result');
    const fileUrl = toWebAddress($('test-file').value);
    const pageUrl = toWebAddress($('test-page').value);
    const show = (message, tone) => {
      output.textContent = message;
      output.dataset.tone = tone;
    };

    if (fileUrl === '' && pageUrl === '') {
      show('Enter the address of a file, and optionally the page you download it from.', 'error');
      return;
    }
    for (const [url, label] of [[fileUrl, 'file'], [pageUrl, 'page']]) {
      if (url !== '' && !hostFromUrl(url)) {
        show(`The ${label} address isn’t a valid web address, like https://example.com/file.zip.`, 'error');
        return;
      }
    }

    const { rules, settings } = await loadState();
    if (!settings.enabled) {
      show('DownHere is paused, so it wouldn’t change where this file is saved.', 'neutral');
      return;
    }
    const match = findRuleForDownload({ url: fileUrl, finalUrl: fileUrl, referrer: pageUrl }, rules, settings.preferSource);
    if (match && BROWSER === 'firefox' && /^blob:/i.test(fileUrl)) {
      show(
        'Firefox can’t download files that a page created itself (blob: addresses) a second time, so this file ' +
          'would stay in your usual download folder.',
        'neutral',
      );
      return;
    }
    if (match) {
      const via = match.source === 'page' ? 'the page address' : 'the file address';
      show(
        `This file would be saved in ${displayFolder(match.rule.folder)} ` +
          `(rule for ${match.rule.domain}, matched through ${via}: ${match.host}).`,
        'success',
      );
      return;
    }
    const offRule = [hostFromUrl(pageUrl), hostFromUrl(fileUrl)]
      .map((host) => findRuleForHost(rules, host, { includeDisabled: true }))
      .find(Boolean);
    show(
      'No rule matches, so this file would be saved in your usual download folder.' +
        (offRule ? ` The rule for ${offRule.domain} would match, but it is switched off.` : ''),
      'neutral',
    );
  });
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

function todayStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function setUpBackup() {
  $('export').addEventListener('click', async () => {
    const { rules, settings } = await loadState();
    const json = `${JSON.stringify(createBackup(rules, settings), null, 2)}\n`;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = h('a', { href: url, download: `downhere-backup-${todayStamp()}.json`, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    // Give the download time to start before releasing the file.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    showToast(`Exported ${plural(rules.length, 'rule')} and your settings.`);
  });

  const fileInput = $('import-file');
  $('import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const [file] = fileInput.files;
    // Clear the input so choosing the same file again still triggers "change".
    fileInput.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      showToast('This file is too large to be a DownHere backup.');
      return;
    }
    const backup = parseBackup(await file.text());
    if (!backup.ok) {
      showToast(backup.error);
      return;
    }
    const result = await updateState(({ rules, settings }) => {
      const merged = mergeRules(rules, backup.rules);
      return { ok: true, ...merged, settings: backup.settings ?? settings };
    });
    state = { rules: result.rules, settings: result.settings };
    render();
    const parts = [`Imported ${plural(backup.rules.length, 'rule')} (${result.added} new, ${result.updated} replaced).`];
    if (backup.skipped === 1) parts.push('Skipped 1 invalid or duplicate entry.');
    if (backup.skipped > 1) parts.push(`Skipped ${backup.skipped} invalid or duplicate entries.`);
    if (backup.settings) parts.push('Settings restored.');
    showToast(parts.join(' '));
  });
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer;
let toastAction = null;

function setUpToast() {
  const toast = $('toast');
  $('toast-action').addEventListener('click', () => {
    const action = toastAction;
    hideToast();
    action?.();
  });
  toast.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      hideToast();
    }
  });
  // Keep the message up while the pointer or keyboard focus is on it.
  toast.addEventListener('mouseenter', () => clearTimeout(toastTimer));
  toast.addEventListener('focusin', () => clearTimeout(toastTimer));
  toast.addEventListener('mouseleave', () => scheduleHide(4000));
  toast.addEventListener('focusout', () => scheduleHide(4000));
}

function showToast(message, { actionLabel, onAction } = {}) {
  const action = $('toast-action');
  // Don't leave keyboard focus on an Undo button that is about to disappear.
  if (!actionLabel && $('toast').contains(document.activeElement)) $('rules-title').focus();
  $('toast-message').textContent = message;
  toastAction = actionLabel ? onAction : null;
  action.textContent = actionLabel ?? '';
  action.hidden = !actionLabel;
  $('toast').classList.add('is-visible');
  scheduleHide(actionLabel ? 8000 : 5000);
}

function scheduleHide(delay) {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, delay);
}

function hideToast() {
  clearTimeout(toastTimer);
  const toast = $('toast');
  // Don't leave keyboard focus on a button that is about to disappear.
  if (toast.contains(document.activeElement)) $('rules-title').focus();
  toast.classList.remove('is-visible');
  $('toast-message').textContent = '';
  $('toast-action').hidden = true;
  toastAction = null;
}
