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
import {
  describeSavedRule,
  fillFolderSuggestions,
  firefoxFolderWarning,
  h,
  setFieldError,
  showFolderError,
  updateFolderHint,
} from '../lib/ui.js';

const $ = (id) => document.getElementById(id);

let state = { rules: [], settings: { ...DEFAULT_SETTINGS } };
// Canonical host of the current tab, or "" if it isn't a website.
let siteHost = '';
// The rule the form edits, or null when saving creates a new rule.
let formRuleId = null;
// Set once the person types into the form, so outside changes don't wipe it.
let formTouched = false;
// Rules deleted while the current "Undo" message is showing: [{rule, index}].
let undoStack = [];
// Set while a save or delete is being written, so repeated clicks are ignored.
let busy = false;
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
    status.replaceChildren('DownHere is paused, so it doesn’t change where downloads are saved.');
  } else if (active && firefoxFolderWarning(active.folder)) {
    status.replaceChildren(
      'Downloads from this site stay in your usual download folder, because Firefox would change the name of ',
      h('strong', {}, displayFolder(active.folder)),
      '.',
    );
  } else if (active) {
    status.replaceChildren('Downloads from this site are saved in ', h('strong', {}, displayFolder(active.folder)), '.');
  } else {
    status.replaceChildren('Downloads from this site go to your usual download folder.');
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
  updateFolderHint($('folder'), $('folder-hint'), rule?.folder);
}

function showMessage(text, { undo = false, tone = 'success' } = {}) {
  $('message').textContent = text;
  $('message-box').dataset.tone = tone;
  $('undo').hidden = !undo;
  if (!undo) undoStack = [];
}

function setUpControls() {
  const folder = $('folder');
  const domain = $('domain');

  for (const input of [folder, domain, $('subdomains')]) {
    input.addEventListener('input', () => {
      formTouched = true;
    });
  }
  folder.addEventListener('input', () =>
    updateFolderHint(folder, $('folder-hint'), state.rules.find((rule) => rule.id === formRuleId)?.folder),
  );
  domain.addEventListener('input', () => setFieldError(domain, $('domain-error'), ''));

  $('enabled').addEventListener('change', async (event) => {
    const result = await updateSettings({ enabled: event.target.checked });
    state = { ...state, settings: result.settings };
    render({ resetForm: false });
  });

  $('rule-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    try {
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
      showMessage(describeSavedRule('Saved', result.rule, state.settings));
    } finally {
      busy = false;
    }
  });

  $('delete-rule').addEventListener('click', async (event) => {
    // The second click of a double-click would hit the next rule that appears
    // in the same place (for example the rule for the parent domain).
    if (event.detail > 1 || busy) return;
    const ruleId = formRuleId;
    if (!ruleId) return;
    busy = true;
    try {
      const result = await updateState(({ rules }) => removeRule(rules, ruleId));
      if (!result.ok) {
        showMessage(result.errors.form, { tone: 'error' });
        await refresh({ resetForm: true });
        return;
      }
      state = { ...state, rules: result.rules };
      render({ resetForm: true });
      // Deleting several rules in a row lets one Undo bring them all back.
      const stack = $('undo').hidden ? [] : undoStack;
      stack.push({ rule: result.rule, index: result.index });
      const count = stack.length;
      showMessage(count === 1 ? `Deleted the rule for ${result.rule.domain}.` : `Deleted ${count} rules.`, { undo: true });
      undoStack = stack;
      // A click with detail 0 comes from the keyboard (Enter or Space).
      (event.detail === 0 ? $('undo') : folder).focus();
    } finally {
      busy = false;
    }
  });

  $('undo').addEventListener('click', async () => {
    if (busy || undoStack.length === 0) return;
    const deleted = undoStack;
    busy = true;
    try {
      const result = await updateState(({ rules }) => {
        let next = rules;
        const restored = [];
        // Put rules back in the opposite order they were deleted in.
        for (const { rule, index } of [...deleted].reverse()) {
          const attempt = restoreRule(next, rule, index);
          if (attempt.ok) {
            next = attempt.rules;
            restored.push(rule);
          }
        }
        return { ok: true, rules: next, restored };
      });
      state = { ...state, rules: result.rules };
      render({ resetForm: true });
      const { restored } = result;
      const missing = deleted.length - restored.length;
      if (restored.length === 0) {
        showMessage('Nothing was restored because there are newer rules for those websites.', { tone: 'error' });
      } else {
        showMessage(
          (restored.length === 1 ? `Restored the rule for ${restored[0].domain}.` : `Restored ${restored.length} rules.`) +
            (missing > 0 ? ` ${missing} couldn’t be restored because there are newer rules for those websites.` : ''),
        );
      }
      folder.focus();
    } finally {
      busy = false;
    }
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
