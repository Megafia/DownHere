import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_SETTINGS,
  addRule,
  buildTargetPath,
  checkFolderName,
  checkPathComponent,
  createBackup,
  displayFolder,
  editRule,
  findRuleForDownload,
  findRuleForHost,
  hostFromUrl,
  hostMatchesRule,
  isReservedWindowsName,
  isRoutingActive,
  mergeRules,
  normalizeDomain,
  normalizeFolder,
  parseBackup,
  removeRule,
  resolveDownload,
  restoreRule,
  sanitizeRules,
  sanitizeSettings,
  setRuleEnabled,
  sortRules,
  toWebAddress,
  validateRuleInput,
} from '../extension/lib/rules.js';

function rule(domain, folder, extra = {}) {
  return { id: `id-${domain}`, domain, folder, includeSubdomains: true, enabled: true, ...extra };
}

function download(extra = {}) {
  return { url: '', finalUrl: '', referrer: '', filename: 'report.pdf', ...extra };
}

describe('normalizeDomain', () => {
  it('accepts bare domains and lowercases them', () => {
    assert.deepEqual(normalizeDomain('GitHub.com'), { ok: true, domain: 'github.com', wildcard: false });
  });

  it('extracts the host from full addresses', () => {
    assert.equal(normalizeDomain('https://docs.example.com/a/b?c=d#e').domain, 'docs.example.com');
    assert.equal(normalizeDomain('http://user:pass@example.com:8080/').domain, 'example.com');
    assert.equal(normalizeDomain('example.com/downloads').domain, 'example.com');
    assert.equal(normalizeDomain('localhost:3000').domain, 'localhost');
  });

  it('treats www. as the bare domain and ignores a trailing dot', () => {
    assert.equal(normalizeDomain('www.example.com').domain, 'example.com');
    assert.equal(normalizeDomain('https://WWW.Example.com./').domain, 'example.com');
  });

  it('keeps www. when only one label would be left', () => {
    assert.equal(normalizeDomain('www.com').domain, 'www.com');
    assert.equal(normalizeDomain('www').domain, 'www');
    assert.equal(hostFromUrl('https://www.com/a'), 'www.com');
  });

  it('reads http:/ and https: without slashes as typos', () => {
    assert.equal(normalizeDomain('http:/example.com').domain, 'example.com');
    assert.equal(normalizeDomain('HTTPS:example.com/page').domain, 'example.com');
    assert.equal(normalizeDomain('localhost:3000').domain, 'localhost');
    assert.equal(normalizeDomain('http:').ok, false);
  });

  it('turns *. and leading-dot prefixes into wildcards', () => {
    assert.deepEqual(normalizeDomain('*.example.com'), { ok: true, domain: 'example.com', wildcard: true });
    assert.deepEqual(normalizeDomain('https://*.example.com/x'), { ok: true, domain: 'example.com', wildcard: true });
    assert.deepEqual(normalizeDomain('.example.com'), { ok: true, domain: 'example.com', wildcard: true });
    assert.equal(normalizeDomain('*.*.example.com').ok, false);
    assert.equal(normalizeDomain('foo.*.com').ok, false);
  });

  it('converts international domains to punycode', () => {
    assert.equal(normalizeDomain('bücher.de').domain, 'xn--bcher-kva.de');
  });

  it('accepts IP addresses', () => {
    assert.equal(normalizeDomain('192.168.1.20').domain, '192.168.1.20');
    assert.equal(normalizeDomain('::1').domain, '[::1]');
    assert.equal(normalizeDomain('http://[::1]:8000/').domain, '[::1]');
  });

  it('rejects input that is not a website domain', () => {
    for (const input of ['', '   ', 'exa mple.com', 'example..com', 'a!b.com', '*.', 'ftp://example.com',
      'chrome://settings', 'file:///C:/x', undefined, null, 42]) {
      const result = normalizeDomain(input);
      assert.equal(result.ok, false, `expected ${String(input)} to be rejected`);
      assert.ok(result.error.length > 0);
    }
  });
});

describe('hostFromUrl', () => {
  it('returns the canonical host of http(s) URLs', () => {
    assert.equal(hostFromUrl('https://www.example.com/file.zip'), 'example.com');
    assert.equal(hostFromUrl('http://Files.Example.com:8080/a'), 'files.example.com');
    assert.equal(hostFromUrl('https://example.com./a'), 'example.com');
  });

  it('uses the creator of blob: and filesystem: URLs', () => {
    assert.equal(hostFromUrl('blob:https://app.example.com/8f14e45f-ceea-467a-9575-7bb4fb2b3a1c'), 'app.example.com');
    assert.equal(hostFromUrl('filesystem:https://example.com/temporary/file.txt'), 'example.com');
    assert.equal(hostFromUrl('blob:null/8f14e45f-ceea-467a-9575-7bb4fb2b3a1c'), '');
    assert.equal(hostFromUrl('blob:chrome-extension://abcdef/8f14e45f'), '');
  });

  it('returns an empty string when there is no website', () => {
    for (const url of ['', undefined, null, 'data:text/plain,hello', 'DATA:,x', 'file:///home/me/a.txt',
      'chrome-extension://abcdefghijklmnop/page.html', 'about:blank', 'not a url', 'ftp://example.com/a',
      'https://exa mple.com/x', 'https://ht!tp://bad', 'https://a..b.com/']) {
      assert.equal(hostFromUrl(url), '', `expected no host for ${String(url)}`);
    }
  });
});

describe('toWebAddress', () => {
  it('adds https:// to addresses typed without a scheme', () => {
    assert.equal(toWebAddress(' example.com/file.zip '), 'https://example.com/file.zip');
    assert.equal(toWebAddress('example.com:8080/file.zip'), 'https://example.com:8080/file.zip');
    assert.equal(toWebAddress('localhost:3000/a'), 'https://localhost:3000/a');
  });

  it('fixes http:/ typos and keeps full addresses', () => {
    assert.equal(toWebAddress('http:/example.com/a'), 'http://example.com/a');
    assert.equal(toWebAddress('https:example.com'), 'https://example.com');
    for (const url of ['https://example.com/a', 'http://x.org', 'blob:https://a.com/1', 'data:,x', 'file:///tmp/a',
      'ftp://x.com/a', '']) {
      assert.equal(toWebAddress(url), url);
    }
    assert.equal(toWebAddress(undefined), '');
  });
});

describe('matching rules to hosts', () => {
  const rules = [
    rule('example.com', 'Example'),
    rule('docs.example.com', 'Docs', { includeSubdomains: false }),
    rule('other.org', 'Other', { includeSubdomains: false }),
    rule('off.example.com', 'Off', { enabled: false }),
  ];

  it('matches the domain itself and, if allowed, its subdomains', () => {
    assert.equal(hostMatchesRule('example.com', rules[0]), true);
    assert.equal(hostMatchesRule('cdn.files.example.com', rules[0]), true);
    assert.equal(hostMatchesRule('other.org', rules[2]), true);
    assert.equal(hostMatchesRule('sub.other.org', rules[2]), false);
  });

  it('does not match look-alike domains', () => {
    assert.equal(hostMatchesRule('notexample.com', rules[0]), false);
    assert.equal(hostMatchesRule('example.com.evil.net', rules[0]), false);
    assert.equal(hostMatchesRule('', rules[0]), false);
  });

  it('prefers the most specific rule', () => {
    assert.equal(findRuleForHost(rules, 'docs.example.com').folder, 'Docs');
    assert.equal(findRuleForHost(rules, 'api.docs.example.com').folder, 'Example');
    assert.equal(findRuleForHost(rules, 'example.com').folder, 'Example');
  });

  it('skips switched-off rules unless asked to include them', () => {
    assert.equal(findRuleForHost(rules, 'off.example.com').folder, 'Example');
    assert.equal(findRuleForHost(rules, 'off.example.com', { includeDisabled: true }).folder, 'Off');
    assert.equal(findRuleForHost(rules, 'unknown.net'), null);
  });
});

describe('findRuleForDownload', () => {
  const rules = [rule('reddit.com', 'Reddit'), rule('imgur.com', 'Imgur'), rule('example.com', 'Example')];

  it('uses the page first by default', () => {
    const item = download({ referrer: 'https://www.reddit.com/r/pics', url: 'https://i.imgur.com/a.png' });
    assert.deepEqual(findRuleForDownload(item, rules), { rule: rules[0], source: 'page', host: 'reddit.com' });
  });

  it('uses the file address first when preferred', () => {
    const item = download({ referrer: 'https://www.reddit.com/r/pics', url: 'https://i.imgur.com/a.png' });
    assert.deepEqual(findRuleForDownload(item, rules, 'file'), { rule: rules[1], source: 'file', host: 'i.imgur.com' });
  });

  it('falls back to the other address when the first has no rule', () => {
    const fromForum = download({ referrer: 'https://forum.net/t/1', url: 'https://example.com/f.zip' });
    assert.equal(findRuleForDownload(fromForum, rules).rule.folder, 'Example');
    const noReferrer = download({ url: 'https://example.com/f.zip' });
    assert.equal(findRuleForDownload(noReferrer, rules, 'page').source, 'file');
    const linkOnly = download({ referrer: 'https://reddit.com/', url: 'https://cdn.net/f.zip' });
    assert.equal(findRuleForDownload(linkOnly, rules, 'file').source, 'page');
  });

  it('checks the address after redirects too', () => {
    const item = download({ url: 'https://short.link/x', finalUrl: 'https://dl.example.com/f.zip' });
    assert.deepEqual(findRuleForDownload(item, rules), { rule: rules[2], source: 'file', host: 'dl.example.com' });
  });

  it('returns null when nothing matches', () => {
    assert.equal(findRuleForDownload(download({ url: 'https://nothing.net/a' }), rules), null);
    assert.equal(findRuleForDownload(download(), rules), null);
  });
});

describe('checkPathComponent', () => {
  it('accepts ordinary names', () => {
    for (const name of ['GitHub', 'Work stuff', 'Photos 2024', 'Ünïcödé', '日本語', 'ok 😀', 'a.b.c', "It's (fine) & #1",
      'Photos~2024', 'x~y~z~long~name', 'a~b', 'report.pdf', 'archive.tar.gz']) {
      assert.equal(checkPathComponent(name, { windowsShortNames: name !== 'a~b' }), '', name);
    }
  });

  it('rejects characters Chrome never allows', () => {
    for (const char of ['"', '*', '/', ':', '<', '>', '?', '\\', '|']) {
      assert.match(checkPathComponent(`a${char}b`), /can’t contain/, char);
    }
  });

  it('rejects control, formatting and non-characters', () => {
    for (const name of ['a\u0000b', 'a\tb', 'a\u007fb', 'a\u0085b', 'a\u200db', 'a\u202eb', 'a\ufeffb', 'a\u00adb',
      'a\ufdd0b', 'a\uffffb', 'a\u{1fffe}b', 'a\u{10ffff}b']) {
      assert.match(checkPathComponent(name), /invisible or unsupported/, JSON.stringify(name));
    }
    assert.match(checkPathComponent('a\ud800b'), /invalid character/);
  });

  it('rejects names starting or ending with spaces, dots or tildes', () => {
    for (const name of [' a', 'a ', '.a', 'a.', '~a', 'a~', '\u00a0a', 'a\u3000', '.', '..']) {
      assert.notEqual(checkPathComponent(name), '', JSON.stringify(name));
    }
  });

  it('rejects names that could be Windows short names when asked to', () => {
    for (const name of ['PROGRA~1', 'a~b', 'ABCDEF~1.TXT', 'x~.y']) {
      assert.match(checkPathComponent(name), /short names/, name);
      assert.equal(checkPathComponent(name, { windowsShortNames: false }), '', name);
    }
    for (const name of ['ABCDEFGH~1', 'A~B.TEXT', 'a~b.c.d', 'a~ b', 'a~b+c']) {
      assert.equal(checkPathComponent(name), '', name);
    }
  });

  it('rejects extensions Windows treats as shortcuts', () => {
    for (const name of ['a.lnk', 'a.LOCAL', 'a.scf', 'a.url', 'a.{20D04FE0-3AEA-1069-A2D8-08002B30309D}']) {
      assert.match(checkPathComponent(name), /doesn’t allow names ending in/, name);
    }
    assert.equal(checkPathComponent('a.lnk.gz'), '');
    assert.equal(checkPathComponent('a.urls'), '');
  });

  it('rejects reserved Windows names', () => {
    for (const name of ['CON', 'con.txt', 'Nul.tar.gz', 'COM1', 'lpt9.log', 'CLOCK$', 'desktop.ini', 'Thumbs.db',
      'CONIN$', 'conout$']) {
      assert.match(checkPathComponent(name), /reserved/, name);
    }
  });
});

describe('isReservedWindowsName', () => {
  it('follows Chrome’s list', () => {
    assert.equal(isReservedWindowsName('con'), true);
    assert.equal(isReservedWindowsName('CON.'), true);
    assert.equal(isReservedWindowsName('con .txt'), false);
    assert.equal(isReservedWindowsName('nul  '), true);
    assert.equal(isReservedWindowsName('com10'), false);
    assert.equal(isReservedWindowsName('com0'), false);
    assert.equal(isReservedWindowsName('console'), false);
    assert.equal(isReservedWindowsName('desktop.ini.bak'), false);
    assert.equal(isReservedWindowsName('conin$.txt'), false);
  });
});

describe('normalizeFolder', () => {
  it('cleans up separators and spaces', () => {
    assert.deepEqual(normalizeFolder('GitHub'), { ok: true, folder: 'GitHub' });
    assert.deepEqual(normalizeFolder('  Work / Invoices  '), { ok: true, folder: 'Work/Invoices' });
    assert.deepEqual(normalizeFolder('Work\\Invoices\\2024'), { ok: true, folder: 'Work/Invoices/2024' });
    assert.deepEqual(normalizeFolder('Work//Invoices/'), { ok: true, folder: 'Work/Invoices' });
    assert.deepEqual(normalizeFolder('./Work/./Invoices/.'), { ok: true, folder: 'Work/Invoices' });
  });

  it('rejects full paths', () => {
    for (const input of ['/Users/me/Documents', '\\\\server\\share', 'C:\\Users\\me', 'c:', 'D:/Files', '~', '~/Docs',
      '~\\Docs']) {
      assert.match(normalizeFolder(input).error, /not a full path/, input);
    }
  });

  it('rejects going up a level and bad names', () => {
    assert.equal(normalizeFolder('a/../b').ok, false);
    assert.equal(normalizeFolder('..').ok, false);
    assert.equal(normalizeFolder('Work/CON').ok, false);
    assert.equal(normalizeFolder('Work:2024').ok, false);
    assert.equal(normalizeFolder('Work/Stuff.').ok, false);
    assert.equal(normalizeFolder('~Stuff').ok, false);
    assert.equal(normalizeFolder('Family 👨‍👩‍👧').ok, false);
  });

  it('rejects empty input', () => {
    for (const input of ['', '   ', '/', './.', undefined, null]) {
      assert.equal(normalizeFolder(input).ok, false, String(input));
    }
  });

  it('limits folder names to 255 bytes', () => {
    assert.equal(normalizeFolder('a'.repeat(255)).ok, true);
    assert.equal(normalizeFolder('a'.repeat(256)).ok, false);
    assert.equal(normalizeFolder('é'.repeat(128)).ok, false);
    assert.equal(checkFolderName('é'.repeat(127)), '');
  });
});

describe('buildTargetPath', () => {
  it('puts Chrome’s file name inside the folder', () => {
    assert.equal(buildTargetPath('Work/Invoices', 'report.pdf'), 'Work/Invoices/report.pdf');
    assert.equal(buildTargetPath('GitHub', '/home/me/Downloads/app.zip'), 'GitHub/app.zip');
    assert.equal(buildTargetPath('GitHub', 'C:\\Users\\me\\Downloads\\app.zip'), 'GitHub/app.zip');
  });

  it('keeps names that are only unusual on Windows', () => {
    assert.equal(buildTargetPath('Stuff', 'a~b.txt'), 'Stuff/a~b.txt');
  });

  it('gives up on names Chrome would refuse instead of renaming them', () => {
    for (const name of ['', 'con.txt', 'shortcut.lnk', 'notes.local', '.hidden', 'trailing.', 'a:b.txt']) {
      assert.equal(buildTargetPath('Stuff', name), '', name);
    }
    assert.equal(buildTargetPath('Stuff', undefined), '');
  });
});

describe('resolveDownload', () => {
  const rules = [rule('example.com', 'Example')];
  const item = download({ url: 'https://example.com/report.pdf' });

  it('routes matching downloads', () => {
    assert.deepEqual(resolveDownload(item, rules, DEFAULT_SETTINGS), {
      action: 'route',
      filename: 'Example/report.pdf',
      conflictAction: 'uniquify',
      rule: rules[0],
      source: 'file',
      host: 'example.com',
    });
  });

  it('passes the chosen conflict action on', () => {
    const settings = { ...DEFAULT_SETTINGS, conflictAction: 'overwrite' };
    assert.equal(resolveDownload(item, rules, settings).conflictAction, 'overwrite');
  });

  it('does nothing while paused', () => {
    const settings = { ...DEFAULT_SETTINGS, enabled: false };
    assert.deepEqual(resolveDownload(item, rules, settings), { action: 'skip', reason: 'disabled' });
  });

  it('leaves local files alone', () => {
    const local = download({ url: 'file:///home/me/report.pdf', referrer: 'https://example.com/' });
    assert.equal(resolveDownload(local, rules, DEFAULT_SETTINGS).reason, 'local-file');
  });

  it('routes downloads started by extensions like any other', () => {
    const fromExtension = { ...item, byExtensionId: 'abcdefghijklmnopabcdefghijklmnop' };
    assert.equal(resolveDownload(fromExtension, rules, DEFAULT_SETTINGS).action, 'route');
  });

  it('explains why a download is skipped', () => {
    const unknown = download({ url: 'https://unknown.net/a.zip' });
    assert.equal(resolveDownload(unknown, rules, DEFAULT_SETTINGS).reason, 'no-rule');
    const unsafe = download({ url: 'https://example.com/x', filename: 'x.lnk' });
    assert.deepEqual(resolveDownload(unsafe, rules, DEFAULT_SETTINGS), {
      action: 'skip',
      reason: 'unsafe-filename',
      rule: rules[0],
    });
  });
});

describe('isRoutingActive', () => {
  it('is true only when switched on with at least one rule switched on', () => {
    const on = rule('a.com', 'A');
    const off = rule('b.com', 'B', { enabled: false });
    assert.equal(isRoutingActive([on, off], DEFAULT_SETTINGS), true);
    assert.equal(isRoutingActive([off], DEFAULT_SETTINGS), false);
    assert.equal(isRoutingActive([], DEFAULT_SETTINGS), false);
    assert.equal(isRoutingActive([on], { ...DEFAULT_SETTINGS, enabled: false }), false);
  });
});

describe('sanitizeSettings', () => {
  it('fills in defaults', () => {
    assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(sanitizeSettings('nonsense'), DEFAULT_SETTINGS);
  });

  it('keeps valid values and replaces invalid ones', () => {
    const settings = sanitizeSettings({
      enabled: false,
      conflictAction: 'prompt',
      preferSource: 'nope',
      ignoreOtherExtensions: true,
    });
    assert.deepEqual(settings, {
      enabled: false,
      conflictAction: 'prompt',
      preferSource: 'page',
    });
  });
});

describe('sanitizeRules', () => {
  it('normalizes rules, drops invalid ones and keeps the first rule per domain', () => {
    const rules = sanitizeRules([
      { id: 'a', domain: 'WWW.Example.com', folder: ' Example / Files ', includeSubdomains: false, enabled: false },
      { id: 'b', domain: 'example.com', folder: 'Duplicate' },
      { id: 'c', domain: 'bad domain', folder: 'X' },
      { id: 'd', domain: 'ok.com', folder: 'C:\\absolute' },
      null,
      'text',
      { domain: '*.cdn.net', folder: 'CDN', includeSubdomains: false },
      { domain: 'plain.org', folder: 'Plain' },
    ]);
    assert.equal(rules.length, 3);
    assert.deepEqual(rules[0], {
      id: 'a',
      domain: 'example.com',
      includeSubdomains: false,
      folder: 'Example/Files',
      enabled: false,
    });
    assert.equal(rules[1].domain, 'cdn.net');
    assert.equal(rules[1].includeSubdomains, true);
    assert.deepEqual({ ...rules[2], id: undefined }, {
      id: undefined,
      domain: 'plain.org',
      includeSubdomains: true,
      folder: 'Plain',
      enabled: true,
    });
    assert.match(rules[2].id, /^[0-9a-f-]{36}$/);
  });

  it('gives every rule a unique id', () => {
    const rules = sanitizeRules([
      { id: 'same', domain: 'a.com', folder: 'A' },
      { id: 'same', domain: 'b.com', folder: 'B' },
      { id: '', domain: 'c.com', folder: 'C' },
      { id: 42, domain: 'd.com', folder: 'D' },
    ]);
    assert.equal(rules[0].id, 'same');
    assert.equal(new Set(rules.map((r) => r.id)).size, 4);
  });

  it('returns an empty list for anything that is not an array', () => {
    assert.deepEqual(sanitizeRules(undefined), []);
    assert.deepEqual(sanitizeRules({ domain: 'a.com', folder: 'A' }), []);
  });
});

describe('editing rules', () => {
  const start = [rule('example.com', 'Example'), rule('other.org', 'Other')];

  it('validates input and reports errors per field', () => {
    assert.deepEqual(validateRuleInput({ domain: 'EXAMPLE.net', folder: 'Net', includeSubdomains: false }, start), {
      ok: true,
      value: { domain: 'example.net', includeSubdomains: false, folder: 'Net' },
    });
    const bad = validateRuleInput({ domain: 'nope nope', folder: '' }, start);
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.domain);
    assert.ok(bad.errors.folder);
    assert.match(validateRuleInput({ domain: 'www.example.com', folder: 'X' }, start).errors.domain, /already/);
    assert.equal(validateRuleInput({ domain: 'example.com', folder: 'X' }, start, 'id-example.com').ok, true);
    assert.equal(validateRuleInput({ domain: '*.new.com', folder: 'X', includeSubdomains: false }, start)
      .value.includeSubdomains, true);
  });

  it('adds rules', () => {
    const result = addRule(start, { domain: 'new.com', folder: 'New', includeSubdomains: true });
    assert.equal(result.ok, true);
    assert.equal(result.rules.length, 3);
    assert.equal(result.rules[2], result.rule);
    assert.equal(result.rule.enabled, true);
    assert.equal(start.length, 2, 'the original list is not changed');
    assert.equal(addRule(start, { domain: 'example.com', folder: 'X' }).ok, false);
  });

  it('edits rules in place', () => {
    const result = editRule(start, 'id-other.org', { domain: 'other.org', folder: 'Renamed', includeSubdomains: false });
    assert.equal(result.ok, true);
    assert.deepEqual(result.rules[1], { ...start[1], folder: 'Renamed', includeSubdomains: false });
    assert.equal(start[1].folder, 'Other');
    assert.equal(editRule(start, 'missing', { domain: 'a.com', folder: 'A' }).ok, false);
    assert.equal(editRule(start, 'id-other.org', { domain: 'example.com', folder: 'A' }).ok, false);
  });

  it('switches rules on and off', () => {
    const result = setRuleEnabled(start, 'id-example.com', false);
    assert.equal(result.rules[0].enabled, false);
    assert.equal(start[0].enabled, true);
    assert.equal(setRuleEnabled(start, 'missing', true).ok, false);
  });

  it('removes rules and can put them back', () => {
    const removed = removeRule(start, 'id-example.com');
    assert.equal(removed.ok, true);
    assert.equal(removed.index, 0);
    assert.deepEqual(removed.rules.map((r) => r.domain), ['other.org']);
    const restored = restoreRule(removed.rules, removed.rule, removed.index);
    assert.deepEqual(restored.rules, start);
    const reused = addRule(removed.rules, { domain: 'example.com', folder: 'New' }).rules;
    assert.equal(restoreRule(reused, removed.rule, removed.index).ok, false);
    assert.equal(removeRule(start, 'missing').ok, false);
  });

  it('merges imported rules', () => {
    const imported = sanitizeRules([
      { domain: 'example.com', folder: 'Imported', includeSubdomains: false, enabled: false },
      { domain: 'fresh.io', folder: 'Fresh' },
    ]);
    const merged = mergeRules(start, imported);
    assert.equal(merged.added, 1);
    assert.equal(merged.updated, 1);
    assert.deepEqual(merged.rules[0], {
      id: 'id-example.com',
      domain: 'example.com',
      includeSubdomains: false,
      folder: 'Imported',
      enabled: false,
    });
    assert.equal(merged.rules[2].domain, 'fresh.io');
    assert.equal(start[0].folder, 'Example');
  });

  it('sorts rules by domain', () => {
    const sorted = sortRules([rule('b.com', 'B'), rule('a.com', 'A'), rule('a.b.com', 'AB')]);
    assert.deepEqual(sorted.map((r) => r.domain), ['a.b.com', 'a.com', 'b.com']);
  });
});

describe('backups', () => {
  const rules = [rule('example.com', 'Example', { includeSubdomains: false }), rule('other.org', 'Other')];
  const settings = { ...DEFAULT_SETTINGS, conflictAction: 'prompt' };

  it('round-trips rules and settings', () => {
    const backup = createBackup(rules, settings, new Date('2026-01-02T03:04:05Z'));
    assert.equal(backup.exportedAt, '2026-01-02T03:04:05.000Z');
    assert.equal('id' in backup.rules[0], false);
    const parsed = parseBackup(JSON.stringify(backup));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.skipped, 0);
    assert.deepEqual(parsed.settings, settings);
    assert.deepEqual(parsed.rules.map(({ id, ...rest }) => rest), rules.map(({ id, ...rest }) => rest));
  });

  it('accepts a plain list of rules', () => {
    const parsed = parseBackup(JSON.stringify([{ domain: 'a.com', folder: 'A' }, { domain: '', folder: 'B' }]));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.rules.length, 1);
    assert.equal(parsed.skipped, 1);
    assert.equal(parsed.settings, null);
  });

  it('rejects files that are not backups', () => {
    for (const text of ['not json', '{}', 'null', '42', '{"rules": "x"}']) {
      assert.equal(parseBackup(text).ok, false, text);
    }
  });
});

describe('displayFolder', () => {
  it('shows folders inside Downloads', () => {
    assert.equal(displayFolder('Work/Invoices'), 'Downloads/Work/Invoices');
    assert.equal(displayFolder(''), 'Downloads');
  });
});
