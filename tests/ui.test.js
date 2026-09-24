import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ui.js finds out which browser it runs in when it is loaded, so each browser
// gets its own copy of the module.
async function loadUi(browser) {
  const scheme = browser === 'firefox' ? 'moz-extension' : 'chrome-extension';
  globalThis.chrome = { runtime: { getURL: (path) => `${scheme}://downhere/${path}` } };
  try {
    return await import(`../extension/lib/ui.js?${browser}`);
  } finally {
    delete globalThis.chrome;
  }
}

const chromeUi = await loadUi('chrome');
const firefoxUi = await loadUi('firefox');
const ON = { enabled: true };
const rule = (folder, extra = {}) => ({ id: 'a', domain: 'a.com', folder, includeSubdomains: true, enabled: true, ...extra });

describe('describeSavedRule', () => {
  it('promises the folder when the rule is used', () => {
    for (const ui of [chromeUi, firefoxUi]) {
      assert.equal(ui.describeSavedRule('Saved', rule('Work'), ON), 'Saved. Downloads from a.com will be saved in Downloads/Work.');
    }
  });

  it('says when a rule isn’t used', () => {
    assert.match(chromeUi.describeSavedRule('Saved', rule('Work'), { enabled: false }), /DownHere is paused/);
    assert.equal(chromeUi.describeSavedRule('Added', rule('Work', { enabled: false }), ON), 'Added. The rule for a.com is switched off.');
  });

  it('keeps using a folder that only Firefox can’t use in Chrome, and says in Firefox that files stay put', () => {
    assert.equal(chromeUi.describeSavedRule('Saved', rule('100% Done'), ON), 'Saved. Downloads from a.com will be saved in Downloads/100% Done.');
    const warning =
      'Saved. Folder names can’t contain %, because Firefox changes it to _. Until you choose another folder, ' +
      'downloads for this rule stay in your usual download folder.';
    assert.equal(firefoxUi.describeSavedRule('Saved', rule('100% Done'), ON), warning);
    // Switching the rule or DownHere back on wouldn't help.
    assert.equal(firefoxUi.describeSavedRule('Saved', rule('100% Done', { enabled: false }), ON), warning);
    assert.equal(firefoxUi.describeSavedRule('Saved', rule('100% Done'), { enabled: false }), warning);
  });
});

describe('firefoxFolderWarning', () => {
  it('only warns in Firefox, about folders it would change', () => {
    assert.equal(chromeUi.firefoxFolderWarning('Links.desktop'), '');
    assert.equal(firefoxUi.firefoxFolderWarning('Work/Invoices'), '');
    assert.match(firefoxUi.firefoxFolderWarning('Work/Links.desktop'), /^Names ending in “\.desktop” aren’t allowed/);
  });
});
