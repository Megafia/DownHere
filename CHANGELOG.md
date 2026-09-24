# Changelog

All notable changes to DownHere are listed here. Version numbers follow [Semantic Versioning](https://semver.org/).

## 0.2.1 – 2026-09-24

- Firefox: a rule whose folder name contains `%` no longer saves files in a folder with `_` instead. Firefox changes
  `%` to `_`, so such files now stay in the Downloads folder.
- Firefox: rules whose folder name contains a special space (such as a no-break space) or ends in `.desktop` are now
  explained. Firefox refuses such folders, so their files stayed in the Downloads folder without a word.
- New rules can’t use such folder names any more. Existing rules keep them, also when restored from a backup, keep
  working in Chrome, and can still be edited; in Firefox, the popup, the settings page, the download checker and the
  message after saving say that their files stay in the usual download folder.
- Folder suggestions only offer folders that new rules can use.
- The release workflow uses versions of GitHub’s checkout and Node.js actions that no longer run on the retired
  Node.js 20.

## 0.2.0 – 2026-09-24

First release.

- Works in Chrome 121 and newer and in Firefox 140 and newer. Each release contains a ZIP for each browser.
- Save downloads from chosen websites into folders inside the Downloads folder, including nested folders.
- Rules match the page a download comes from and the file’s own address (in Chrome before and after redirects), with
  or without subdomains. When several rules fit the same address, the most specific one wins.
- Toolbar popup to choose the folder for the current website.
- Settings page to add, edit, switch off and delete rules (with undo).
- Settings for file name conflicts and page-or-file priority, plus a switch to pause DownHere.
- In Chrome, DownHere only listens to downloads while it is on and has a rule switched on, so it doesn’t get in the
  way of other extensions the rest of the time.
- Firefox doesn’t let extensions choose a download’s folder in advance, so there DownHere downloads each file from a
  website with a rule a second time into the rule’s folder, and deletes the first copy once both match. Downloads
  that can’t be repeated, such as files a page creates itself or gets from a form, stay where Firefox saved them.
- Download checker that shows which folder an address would go to.
- Backup and restore of rules and settings as a JSON file, which also works between Chrome and Firefox.
- Folder names are checked while you type, so that rules work in both browsers.
