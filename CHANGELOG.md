# Changelog

All notable changes to DownHere are listed here. Version numbers follow [Semantic Versioning](https://semver.org/).

## 0.1.0 – 2026-09-23

First release.

- Save downloads from chosen websites into folders inside the Downloads folder, including nested folders.
- Rules match the page a download comes from and the file’s own address (before and after redirects), with or
  without subdomains. The most specific rule wins.
- Toolbar popup to choose the folder for the current website.
- Settings page to add, edit, switch off and delete rules (with undo).
- Settings for file name conflicts and page-or-file priority, plus a switch to pause DownHere.
- DownHere only listens to downloads while it is on and has a rule switched on, so it doesn’t get in the way of
  other extensions the rest of the time.
- Download checker that shows which folder an address would go to.
- Backup and restore of rules and settings as a JSON file.
- Folder names are checked against Chrome’s rules while you type.
