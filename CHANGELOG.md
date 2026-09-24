# Changelog

All notable changes to DownHere are listed here. Version numbers follow [Semantic Versioning](https://semver.org/).

## 0.3.0 – 2026-09-24

- Choose a rule’s folder in your browser’s own save dialog: click **Browse…** next to a folder field on the settings
  page or in the popup, open the folder you want (or create one) and click Save. From the popup, this continues on the
  settings page, because a popup closes as soon as a dialog opens. Browsers don’t tell extensions where a chosen folder
  is, so DownHere saves a small file there and a second one directly in the Downloads folder, works out the folder from
  the two, and deletes both files right away.
- A folder outside the Downloads folder, the Downloads folder itself and folder names that rules can’t use are
  explained instead of being filled in. DownHere only deletes files that are exactly its small files, so a file saved
  under another name in the dialog is left in place, with a warning.
- Folder names for new rules can’t contain `%` or special space characters or end in `.desktop` any more, because
  Firefox changes them. Existing rules keep such a folder and can still be edited. In Firefox, their files now stay in
  the Downloads folder, and the popup, the settings page and the download checker say why. Before, Firefox used a
  folder with `_` instead of `%`, and couldn’t sort the files for the other names at all.
- `npm run test:chrome` tries DownHere in a real Chrome, as `npm run test:firefox` does in Firefox, and both now try
  Browse… too. `npm test` only runs the unit tests again and no longer starts Firefox.

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
