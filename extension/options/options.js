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
} from '../lib/rules.js';
import { loadState, updateSettings, updateState, watchState } from '../lib/storage.js';
import { fillFolderSuggestions, h, setFieldError, showFolderError, updateFolderHint } from '../lib/ui.js';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

const $ = (id) => document.getElementById(id);

let state = { rules: [], settings: { ...DEFAULT_SETTINGS } };
// The rule being edited in place, with the values typed so far:
// {id, domain, folder, includeSubdomains, errors}.
let editing = null;
let refreshCount = 0;

setUpAddForm();
setUpRuleList();
setUpSettings();
setUpTester();
setUpBackup();
setUpToast();
watchState(refresh);
refresh();

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

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
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
    updateFolderHint(folder, folderHint);
    domain.focus();
    showToast(`Added. Downloads from ${result.rule.domain} will be saved in ${displayFolder(result.rule.folder)}.`);
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
  if (editing.errors.folder) showFolderError(folderInput, folderHint, editing.errors.folder);

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
      folderInput,
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
        h('button', { className: 'btn', type: 'button', dataset: { action: 'cancel' } }, 'Cancel'),
        h('button', { className: 'btn btn-primary', type: 'submit' }, 'Save'),
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
    const id = button.closest('li').dataset.ruleId;
    if (button.dataset.action === 'edit') startEditing(id);
    else if (button.dataset.action === 'delete') deleteRule(id);
    else if (button.dataset.action === 'cancel') stopEditing(id);
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
  if (editing?.id !== id) return;
  const input = { domain: editing.domain, folder: editing.folder, includeSubdomains: editing.includeSubdomains };
  const result = await updateState(({ rules }) => editRule(rules, id, input));
  if (!result.ok) {
    if (result.errors.form) {
      editing = null;
      showToast(result.errors.form);
      refresh();
      return;
    }
    if (editing?.id !== id) return;
    editing.errors = result.errors;
    renderRules();
    document.getElementById(result.errors.domain ? `edit-domain-${id}` : `edit-folder-${id}`)?.focus();
    return;
  }
  editing = null;
  applyRules(result.rules);
  focusRuleButton('edit', id);
  showToast(`Saved. Downloads from ${result.rule.domain} will be saved in ${displayFolder(result.rule.folder)}.`);
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

async function deleteRule(id) {
  // Pick where keyboard focus should go once the row is gone.
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
  showToast(`Deleted the rule for ${result.rule.domain}.`, {
    actionLabel: 'Undo',
    onAction: () => undoDelete(result.rule, result.index),
  });
}

async function undoDelete(rule, index) {
  const result = await updateState(({ rules }) => restoreRule(rules, rule, index));
  if (!result.ok) {
    showToast(result.errors.form);
    return;
  }
  applyRules(result.rules);
  focusRuleButton('edit', rule.id);
  showToast(`Restored the rule for ${rule.domain}.`);
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
  $('ignore-extensions').checked = settings.ignoreOtherExtensions;
}

function setUpSettings() {
  const save = async (patch) => {
    const result = await updateSettings(patch);
    state = { ...state, settings: result.settings };
    renderSettings();
  };
  $('enabled').addEventListener('change', (event) => save({ enabled: event.target.checked }));
  $('conflict-action').addEventListener('change', (event) => save({ conflictAction: event.target.value }));
  for (const radio of document.querySelectorAll('input[name="prefer-source"]')) {
    radio.addEventListener('change', () => save({ preferSource: radio.value }));
  }
  $('ignore-extensions').addEventListener('change', (event) => save({ ignoreOtherExtensions: event.target.checked }));
}

// ---------------------------------------------------------------------------
// Download checker
// ---------------------------------------------------------------------------

// Lets people paste "example.com/file.zip" without typing https://.
function withScheme(text) {
  return text === '' || /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
}

function setUpTester() {
  $('test-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const output = $('test-result');
    const fileUrl = withScheme($('test-file').value.trim());
    const pageUrl = withScheme($('test-page').value.trim());
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
        show(`The ${label} address isn’t a valid web address (it should start with http:// or https://).`, 'error');
        return;
      }
    }

    const { rules, settings } = await loadState();
    if (!settings.enabled) {
      show('DownHere is paused, so this file would be saved in Chrome’s usual download folder.', 'neutral');
      return;
    }
    const match = findRuleForDownload({ url: fileUrl, finalUrl: fileUrl, referrer: pageUrl }, rules, settings.preferSource);
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
      'No rule matches, so this file would be saved in Chrome’s usual download folder.' +
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
  // Keep the message up while the pointer or keyboard focus is on it.
  toast.addEventListener('mouseenter', () => clearTimeout(toastTimer));
  toast.addEventListener('focusin', () => clearTimeout(toastTimer));
  toast.addEventListener('mouseleave', () => scheduleHide(4000));
  toast.addEventListener('focusout', () => scheduleHide(4000));
}

function showToast(message, { actionLabel, onAction } = {}) {
  const action = $('toast-action');
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
  $('toast').classList.remove('is-visible');
  $('toast-message').textContent = '';
  $('toast-action').hidden = true;
  toastAction = null;
}
