# DownHere

**Choose which folder downloads are saved to, for each website.**

DownHere is a Chrome extension that sorts your downloads as they happen. Tell it that files from `github.com` belong in
`Downloads/Code/GitHub` and that invoices from your bank belong in `Downloads/Money/Invoices`, and every download from
those sites lands in the right folder without a Save As dialog.

<p align="center">
  <img src="docs/screenshots/popup.png" width="340" alt="The DownHere popup on github.com, set to save downloads in Downloads/Code/GitHub">
</p>

## Features

- **A folder for each website.** Rules like `github.com → Code/GitHub`, including nested folders, which are created
  automatically.
- **Set up in seconds.** Open a site, click the DownHere button, type a folder name, save.
- **Subdomains included if you want them.** One rule for `google.com` can cover `drive.google.com` and
  `mail.google.com`, or you can give each its own folder. When several rules fit, the most specific one wins.
- **Understands where a download really comes from.** Rules match the page you downloaded from as well as the file’s
  own address, before and after redirects (for example, GitHub release files are served from another domain).
- **Your choice when a name is taken.** Keep both files, replace the old one, or be asked.
- **Switch rules off** without deleting them, or pause DownHere entirely.
- **Check before you download.** Paste an address to see which folder it would go to.
- **Back up and restore** your rules and settings as a file.
- **Private.** No accounts, no tracking, no network requests. Light and dark mode.

![DownHere settings page with a list of rules](docs/screenshots/options.png)

## Install

DownHere isn’t in the Chrome Web Store yet. To install it:

1. Download `downhere-<version>.zip` from the [latest release](https://github.com/Megafia/DownHere/releases/latest)
   and unzip it into a folder you’ll keep. Chrome loads the extension from that folder, so don’t delete it.
2. Open `chrome://extensions` in Chrome.
3. Switch on **Developer mode** (top-right corner).
4. Click **Load unpacked** and select the unzipped folder (the one that contains `manifest.json`).
5. Optional: open the puzzle-piece **Extensions** menu next to the address bar and pin DownHere so its button is
   always visible.

To run DownHere from the source code instead, clone this repository and select its `extension` folder in step 4.

DownHere needs Chrome 120 or newer. Other Chromium-based browsers may work too, but haven’t been tested.

## How to use it

**From the toolbar:** open any website, click the DownHere button, type a folder name and click **Save**. From then on,
files you download from that site are saved in that folder inside your Downloads folder. Use `/` for subfolders, for
example `Work/Invoices`.

**On the settings page** (right-click the DownHere button and choose **Options**, or click **All rules and settings**
in the popup) you can add, edit, switch off and delete rules, change settings, check where a download will go, and back
up your rules.

## How rules are matched

- A rule for `example.com` covers `example.com` and `www.example.com`. With **Include subdomains** switched on it also
  covers addresses such as `files.example.com`. You can type or paste a full address; DownHere keeps only the domain.
  Typing `*.example.com` switches on subdomains for you.
- Every download has two addresses: the **page** you were on and the **file’s own address**. DownHere checks the page
  first, then the file’s address before and after any redirects. The first address that has a rule decides the folder.
  In the settings you can make the file’s own address go first instead.
- The page address is the one Chrome records as the download’s referrer. Some websites and links hide it; then only
  the file’s own address is checked. For a download started inside an embedded frame, it is the frame’s address.
- When several rules fit the same address, the most specific one wins: a rule for `docs.example.com` beats one for
  `example.com`.
- Rules that are switched off are skipped. Downloads that match no rule are saved wherever Chrome would normally put
  them.

| Rules | You download… | Saved in |
| --- | --- | --- |
| `github.com` → `Code/GitHub`, with subdomains | a release from a github.com page | `Downloads/Code/GitHub` |
| `google.com` → `Google`, with subdomains | an attachment in mail.google.com | `Downloads/Google` |
| `google.com` → `Google` and `drive.google.com` → `Work/Drive` | a file from drive.google.com | `Downloads/Work/Drive` |
| `reddit.com` → `Memes`, `imgur.com` → `Imgur` | an image stored on imgur.com, from a reddit.com page | `Downloads/Memes` (page first, the default) |

## Settings

- **If the folder already has a file with the same name:** keep both (Chrome adds a number such as `report (1).pdf`),
  replace the existing file, or ask where to save the new one.
- **If the page and the file match different rules:** use the rule for the page (default) or for the file’s own
  address.
- **On / Paused:** the switch at the top of the popup and the settings page turns all rules on or off at once. While
  paused, DownHere doesn’t change any download.

## Good to know

- Chrome only lets extensions save files inside your Downloads folder, the location set in Chrome’s
  **Settings › Downloads**. Your rule folders are created inside it. To use a different base folder, change that
  location in Chrome.
- Use real folders for rules. Newer versions of Chrome don’t follow symbolic links or junctions that lead outside the
  Downloads folder.
- DownHere only chooses the folder. Files keep the name Chrome gives them. A few names, such as `CON.txt` or shortcut
  files ending in `.lnk`, `.url` or `.scf`, aren’t accepted inside folders by every version of Chrome, so DownHere
  leaves those files in the Downloads folder. On Windows, Chrome renames such files first (for example to
  `_CON.txt`), so they are sorted as usual.
- If Chrome is set to ask where to save each file, the save dialog suggests the rule’s folder.
- Files opened from your own computer (`file://` addresses) are never moved.
- Rules only apply in Incognito windows if you allow DownHere in Incognito
  (`chrome://extensions` › DownHere › **Details**).
- While DownHere is on and has a rule switched on, Chrome ignores the folder and file name that other extensions ask
  for when they download something: those downloads are sorted by your rules like any other, or saved in the
  Downloads folder with the name Chrome gives them. Pause DownHere to let other extensions choose again.
- If another extension also watches downloads while Chrome names them (download managers and organizers often do),
  Chrome lets only one of them decide while both are active: the one installed or updated most recently, even for
  downloads it doesn’t change. If DownHere stops sorting your files, check for such an extension.
- On Linux, folder names with non-English characters need a UTF-8 system locale (the default on current
  distributions); otherwise Chrome saves the files in the Downloads folder instead.

## Privacy and permissions

DownHere doesn’t collect, send or share any data. Your rules and settings are stored only in your browser
(`chrome.storage.local`), and the extension contains no code that talks to the network.

| Permission | Why it’s needed |
| --- | --- |
| `downloads` | To choose the folder while Chrome is naming a download. Chrome shows this as “Manage your downloads”. |
| `storage` | To keep your rules and settings. |
| `activeTab` | To read the address of the current tab, only when you click the DownHere button, so the popup can fill in the website. |

## Development

The extension is plain JavaScript with no build step and no dependencies. [Node.js](https://nodejs.org/) 20 or newer
is only needed for the tests and for packaging.

```sh
npm test          # run the unit tests
npm run package   # create dist/downhere-<version>.zip
```

After changing files in `extension/`, click the reload button on DownHere’s card in `chrome://extensions`.

```text
extension/
  manifest.json      Extension manifest (Manifest V3)
  background.js      Service worker: picks the folder for each download
  lib/rules.js       Rule matching and Chrome's path rules (no browser APIs, unit tested)
  lib/storage.js     Reading and saving rules and settings
  lib/ui.js          Shared helpers for the popup and settings page
  popup/             Toolbar popup
  options/           Settings page
  styles/            Shared styles
  icons/             Extension icons
assets/icon.svg      Source of the icons
docs/screenshots/    Images used in this README
scripts/package.mjs  Builds the ZIP for the Chrome Web Store and releases
tests/               Unit tests (Node's built-in test runner)
.github/workflows/   Adds the built ZIP to each GitHub release
```

### Releasing a new version

1. Update `version` in both `extension/manifest.json` and `package.json`, and describe the changes in
   [CHANGELOG.md](CHANGELOG.md) under a heading like `## 0.2.0 – 2026-10-01`. Commit the changes to `main`.
2. Publish a release for the tag `v` + the version, either on GitHub (**Releases** › **Draft a new release**, type
   `v0.2.0` as a new tag on `main`, then **Publish release**) or from the command line:

   ```sh
   git tag -a v0.2.0 -m "DownHere 0.2.0"
   git push origin v0.2.0
   ```

3. The **Release** workflow then runs the tests, builds `downhere-0.2.0.zip` and attaches it to the release (it
   creates the release if you only pushed a tag). If the release has no description, it uses the notes from the
   changelog. It stops with an error if the tag doesn’t match the version in both files.
4. To update the Chrome Web Store listing, upload the same ZIP in the Chrome Web Store Developer Dashboard.

## License

DownHere is released under the [MIT License](LICENSE).
