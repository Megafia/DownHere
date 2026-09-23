import {
  DEFAULT_SETTINGS,
  addRule,
  displayFolder,
  editRule,
  findRuleForHost,
  hostFromUrl,
  removeRule,
  restoreRule,
  setRuleEnabled,
} from '../lib/rules.js';
import { loadState, updateSettings, updateState, watchState } from '../lib/storage.js';
import { fillFolderSuggestions, h, setFieldError, showFolderError, updateFolderHint } from '../lib/ui.js';

const $ = (id) => document.getElementById(id);

let state = { rules: [], settings: { ...DEFAULT_SETTINGS } };
// Canonical host of the current tab, or "" if it isn't a website.
let siteHost = '';
// The rule the form edits, or null when saving creates a new rule.
let formRuleId = null;
// Set once the person types into the form, so outside changes don't wipe it.
let formTouched = false;
let lastDeleted = null;
let refreshCount = 0;

setUpControls();
init();

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    siteHost = hostFromUrl(tab?.url ?? '');
  } catch {
    siteHost = '';
  }
  await refresh({ resetForm: true });
  if (siteHost) $('folder').focus();
  watchState(() => refresh({ resetForm: !formTouched }));
}

async function refresh(options) {
  // Ignore results that arrive after a newer refresh has started.
  const current = ++refreshCount;
  const next = await loadState();
  if (current !== refreshCount) return;
  state = next;
  render(options);
}

function render({ resetForm }) {
  const { rules, settings } = state;
  $('enabled').checked = settings.enabled;
  $('enabled-text').textContent = settings.enabled ? 'On' : 'Paused';
  fillFolderSuggestions($('folder-suggestions'), rules);

  $('no-site').hidden = siteHost !== '';
  $('site').hidden = siteHost === '';
  if (!siteHost) return;

  // The rule shown in the form may be switched off; the active one decides.
  const shown = findRuleForHost(rules, siteHost, { includeDisabled: true });
  const active = findRuleForHost(rules, siteHost);
  $('site-host').textContent = siteHost;

  const status = $('site-status');
  if (!settings.enabled) {
    status.replaceChildren('DownHere is paused. Downloads go to Chrome’s usual download folder.');
  } else if (active) {
    status.replaceChildren('Downloads from this site are saved in ', h('strong', {}, displayFolder(active.folder)), '.');
  } else {
    status.replaceChildren('Downloads from this site go to Chrome’s usual download folder.');
  }

  $('rule-off').hidden = !shown || shown.enabled;
  $('rule-off-text').textContent = shown && !shown.enabled ? `The rule for ${shown.domain} is switched off.` : '';

  const editedRuleGone = formRuleId !== null && !rules.some((rule) => rule.id === formRuleId);
  if (resetForm || editedRuleGone) fillForm(shown);
}

function fillForm(rule) {
  formRuleId = rule ? rule.id : null;
  formTouched = false;
  $('folder').value = rule ? rule.folder : '';
  $('domain').value = rule ? rule.domain : siteHost;
  $('subdomains').checked = rule ? rule.includeSubdomains : true;
  $('save').textContent = rule ? 'Save changes' : 'Save';
  $('delete-rule').hidden = !rule;
  setFieldError($('domain'), $('domain-error'), '');
  updateFolderHint($('folder'), $('folder-hint'));
}

function showMessage(text, { undo = false, tone = 'success' } = {}) {
  $('message').textContent = text;
  $('message-box').dataset.tone = tone;
  $('undo').hidden = !undo;
  if (!undo) lastDeleted = null;
}

function setUpControls() {
  const folder = $('folder');
  const domain = $('domain');

  for (const input of [folder, domain, $('subdomains')]) {
    input.addEventListener('input', () => {
      formTouched = true;
    });
  }
  folder.addEventListener('input', () => updateFolderHint(folder, $('folder-hint')));
  domain.addEventListener('input', () => setFieldError(domain, $('domain-error'), ''));

  $('enabled').addEventListener('change', async (event) => {
    const result = await updateSettings({ enabled: event.target.checked });
    state = { ...state, settings: result.settings };
    render({ resetForm: false });
  });

  $('rule-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const ruleId = formRuleId;
    const input = { domain: domain.value, folder: folder.value, includeSubdomains: $('subdomains').checked };
    const result = await updateState(({ rules }) => (ruleId ? editRule(rules, ruleId, input) : addRule(rules, input)));
    if (!result.ok) {
      if (result.errors.form) {
        showMessage(result.errors.form, { tone: 'error' });
        await refresh({ resetForm: true });
        return;
      }
      setFieldError(domain, $('domain-error'), result.errors.domain);
      if (result.errors.folder) showFolderError(folder, $('folder-hint'), result.errors.folder);
      (result.errors.folder ? folder : domain).focus();
      return;
    }
    state = { ...state, rules: result.rules };
    render({ resetForm: true });
    showMessage(`Saved. Downloads from ${result.rule.domain} go to ${displayFolder(result.rule.folder)}.`);
  });

  $('delete-rule').addEventListener('click', async () => {
    const ruleId = formRuleId;
    if (!ruleId) return;
    const result = await updateState(({ rules }) => removeRule(rules, ruleId));
    if (!result.ok) {
      showMessage(result.errors.form, { tone: 'error' });
      await refresh({ resetForm: true });
      return;
    }
    state = { ...state, rules: result.rules };
    render({ resetForm: true });
    lastDeleted = { rule: result.rule, index: result.index };
    showMessage(`Deleted the rule for ${result.rule.domain}.`, { undo: true });
    folder.focus();
  });

  $('undo').addEventListener('click', async () => {
    if (!lastDeleted) return;
    const { rule, index } = lastDeleted;
    const result = await updateState(({ rules }) => restoreRule(rules, rule, index));
    if (!result.ok) {
      showMessage(result.errors.form, { tone: 'error' });
      return;
    }
    state = { ...state, rules: result.rules };
    render({ resetForm: true });
    showMessage(`Restored the rule for ${rule.domain}.`);
    folder.focus();
  });

  $('turn-on').addEventListener('click', async () => {
    const rule = findRuleForHost(state.rules, siteHost, { includeDisabled: true });
    if (!rule) return;
    const result = await updateState(({ rules }) => setRuleEnabled(rules, rule.id, true));
    if (!result.ok) {
      showMessage(result.errors.form, { tone: 'error' });
      return;
    }
    state = { ...state, rules: result.rules };
    render({ resetForm: !formTouched });
    showMessage(`Switched on the rule for ${rule.domain}.`);
    folder.focus();
  });

  $('open-options').addEventListener('click', async () => {
    await chrome.runtime.openOptionsPage();
    window.close();
  });
}
