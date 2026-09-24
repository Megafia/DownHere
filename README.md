# DownHere

**Choose which folder downloads are saved to, for each website.**

DownHere is a Chrome and Firefox extension that sorts your downloads as they happen. Tell it that files from
`github.com` belong in `Downloads/Code/GitHub` and that invoices from your bank belong in `Downloads/Money/Invoices`,
and every download from those sites lands in the right folder without a Save As dialog.

<p align="center">
  <img src="docs/screenshots/popup.png" width="340" alt="The DownHere popup on github.com, set to save downloads in Downloads/Code/GitHub">
</p>

## Features

- **A folder for each website.** Rules like `github.com → Code/GitHub`, including nested folders, which are created
  automatically.
- **Set up in seconds.** Open a site, click the DownHere button, type a folder name, save.
- **Or choose the folder in a dialog.** Click **Browse…** to pick or create the folder in your browser’s own save
  dialog instead of typing its name.
- **Subdomains included if you want them.** One rule for `google.com` can cover `drive.google.com` and
  `mail.google.com`, or you can give each its own folder. When several rules fit, the most specific one wins.
- **Understands where a download really comes from.** Rules match the page you downloaded from as well as the file’s
  own address, in Chrome before and after redirects (for example, GitHub release files are served from another
  domain).
- **Your choice when a name is taken.** Keep both files, replace the old one, or be asked.
- **Switch rules off** without deleting them, or pause DownHere entirely.
- **Check before you download.** Paste an address to see which folder it would go to.
- **Back up and restore** your rules and settings as a file, also to move them between Chrome and Firefox.
- **Private.** No accounts, no tracking, and nothing is sent anywhere. Light and dark mode.

![DownHere settings page with a list of rules](docs/screenshots/options.png)

## Install

DownHere isn’t in the Chrome Web Store or on addons.mozilla.org yet.

### Chrome

1. Download `downhere-<version>-chrome.zip` from the [latest release](https://github.com/Megafia/DownHere/releases/latest)
   and unzip it into a folder you’ll keep. Chrome loads the extension from that folder, so don’t delete it.
2. Open `chrome://extensions` in Chrome.
3. Switch on **Developer mode** (top-right corner).
4. Click **Load unpacked** and select the unzipped folder (the one that contains `manifest.json`).
5. Optional: open the puzzle-piece **Extensions** menu next to the address bar and pin DownHere so its button is
   always visible.

To run DownHere from the source code instead, clone this repository and select its `extension` folder in step 4.

DownHere needs Chrome 121 or newer. Other Chromium-based browsers may work too, but haven’t been tested.

### Firefox

Firefox only keeps add-ons installed for good once Mozilla has signed them. Until DownHere is signed, you can load
it for as long as Firefox is open:

1. Download `downhere-<version>-firefox.zip` from the
   [latest release](https://github.com/Megafia/DownHere/releases/latest). There’s no need to unzip it.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on…** and select the ZIP file.
4. Optional: open the puzzle-piece **Extensions** menu in the toolbar, click the gear next to DownHere and choose
   **Pin to Toolbar**.

To run DownHere from the source code instead, clone this repository and select `extension/manifest.json` in step 3.

DownHere needs Firefox 140 or newer. See [In Firefox](#in-firefox) for how it works there.

## How to use it

**From the toolbar:** open any website, click the DownHere button, type a folder name (or click **Browse…** to choose
it in a dialog) and click **Save**. From then on, files you download from that site are saved in that folder inside
your Downloads folder. Use `/` for subfolders, for example `Work/Invoices`.

**On the settings page** (click **All rules and settings** in the popup, or in Chrome right-click the DownHere button
and choose **Options**) you can add, edit, switch off and delete rules, change settings, check where a download will
go, and back up your rules.

### Choosing a folder with Browse…

**Browse…** opens your browser’s save dialog, suggesting a file named `DownHere - choose this folder.txt`. Open the
folder you want, or create a new one, and click **Save**. DownHere fills in the folder, which you can still change
before you save the rule.

Browsers don’t tell extensions where a folder chosen in a folder dialog is, but they do tell them where a download was
saved. So DownHere really saves that small file, and then a second one, `DownHere - Downloads folder check.txt`,
without a dialog, which the browser puts directly in your Downloads folder. The two paths show which folder inside the
Downloads folder you chose. DownHere deletes both files right away and removes them from the downloads list, so you
may only see them there for a moment.

- The folder has to be inside your Downloads folder, because browsers only let extensions save files there. DownHere
  tells you when you choose a folder somewhere else, or the Downloads folder itself.
- The popup closes as soon as a dialog opens, so its **Browse…** button opens the settings page with what you entered
  and shows the dialog there.
- If Chrome is set to ask where to save each file, it also asks about the second file. Click **Save** without changing
  the folder.
- Chrome opens the dialog in your Downloads folder, Firefox in the folder you chose last time.
- If a DownHere page is closed while its save dialog is open, the small file can stay where you saved it. DownHere
  deletes it the next time you use **Browse…**, or you can delete it yourself.

## How rules are matched

- A rule for `example.com` covers `example.com` and `www.example.com`. With **Include subdomains** switched on it also
  covers addresses such as `files.example.com`. You can type or paste a full address; DownHere keeps only the domain.
  Typing `*.example.com` switches on subdomains for you.
- Every download has two addresses: the **page** you were on and the **file’s own address**. DownHere checks the page
  first, then the file’s address before and after any redirects. The first address that has a rule decides the folder.
  In the settings you can make the file’s own address go first instead. Firefox doesn’t tell extensions where a
  redirect led, so there only the file’s address before redirects is checked.
- The page address is the one the browser records as the download’s referrer. Some websites and links hide it; then
  only the file’s own address is checked. For a download started inside an embedded frame, it is the frame’s address.
- When several rules fit the same address, the most specific one wins: a rule for `docs.example.com` beats one for
  `example.com`.
- Rules that are switched off are skipped. Downloads that match no rule are saved wherever the browser would normally
  put them.

| Rules | You download… | Saved in |
| --- | --- | --- |
| `github.com` → `Code/GitHub`, with subdomains | a release from a github.com page | `Downloads/Code/GitHub` |
| `google.com` → `Google`, with subdomains | an attachment in mail.google.com | `Downloads/Google` |
| `google.com` → `Google` and `drive.google.com` → `Work/Drive` | a file from drive.google.com | `Downloads/Work/Drive` |
| `reddit.com` → `Memes`, `imgur.com` → `Imgur` | an image stored on imgur.com, from a reddit.com page | `Downloads/Memes` (page first, the default) |

## Settings

- **If the folder already has a file with the same name:** keep both (the browser adds a number, such as
  `report (1).pdf`), replace the existing file, or ask where to save the new one. Firefox can’t ask, so there “ask”
  keeps both files.
- **If the page and the file match different rules:** use the rule for the page (default) or for the file’s own
  address.
- **On / Paused:** the switch at the top of the popup and the settings page turns all rules on or off at once. While
  paused, DownHere doesn’t change any download.

## Good to know

- Browsers only let extensions save files inside your Downloads folder, the location set in Chrome’s
  **Settings › Downloads** or in Firefox’s **Settings › General › Files and Applications**. Your rule folders are
  created inside it. To use a different base folder, change that location in the browser.
- Files opened from your own computer (`file://` addresses) are never moved.

### In Chrome

- Use real folders for rules. Newer versions of Chrome don’t follow symbolic links or junctions that lead outside the
  Downloads folder.
- DownHere only chooses the folder. Files keep the name Chrome gives them. A few names, such as `CON.txt` or shortcut
  files ending in `.lnk`, `.url` or `.scf`, aren’t accepted inside folders by every version of Chrome, so DownHere
  leaves those files in the Downloads folder. On Windows, Chrome renames such files first (for example to
  `_CON.txt`), so they are sorted as usual.
- If Chrome is set to ask where to save each file, the save dialog suggests the rule’s folder.
- Rules only apply in Incognito windows if you allow DownHere in Incognito
  (`chrome://extensions` › DownHere › **Details**).
- While DownHere is on and has a rule switched on, Chrome ignores the folder and file name that other extensions ask
  for when they download something: those downloads are sorted by your rules like any other, or saved in the
  Downloads folder with the name Chrome gives them. Pause DownHere to let other extensions choose again.
- If another extension also watches downloads while Chrome names them (download managers and organizers often do),
  Chrome lets only one of them decide while both are active: the one installed or updated most recently, even for
  downloads it doesn’t change. If DownHere stops sorting your files, check for such an extension.
- On Linux, folder names with non-English characters need a UTF-8 system locale (the default on current
  distributions); otherwise Chrome saves the files in the Downloads folder instead, and **Browse…** can’t tell which
  folder you chose.

### In Firefox

Firefox doesn’t let extensions choose the folder before a file is saved. So DownHere lets each download from a
website with a rule finish in the Downloads folder, downloads the same address again into the rule’s folder, and
deletes the first copy once the second one has arrived with the same size and type. For a moment you’ll see both in
the downloads list. Each sorted file is downloaded twice, which takes longer for very large files.

Whenever something doesn’t work out, the first copy simply stays in the Downloads folder, so no download is lost.
That’s always the case for:

- files a page creates itself (their address starts with `blob:`), which can’t be downloaded again;
- files you get by sending a form, and links that only work once;
- downloads in container tabs, because downloading them again would send the wrong cookies;
- files you choose a place for yourself, for example with **Always ask you where to save files**;
- files with `%` in their name, which Firefox would rename, and the few names Chrome doesn’t accept either;
- files that other extensions download.

Rules only apply in private windows if DownHere may run there (`about:addons` › DownHere ›
**Run in Private Windows**). If a file from a website with a rule wasn’t sorted and you’d like to know why, open
`about:debugging#/runtime/this-firefox` and click **Inspect** next to DownHere; its console says why.

## Privacy and permissions

DownHere doesn’t collect, send or share any data. Your rules and settings are stored only in your browser
(`storage.local`). In Chrome, the extension makes no network requests at all. In Firefox, it only downloads a file a
second time from the address it came from, as described above.

| Permission | Why it’s needed |
| --- | --- |
| `downloads` | Chrome: to choose the folder while Chrome is naming a download (shown as “Manage your downloads”). Firefox: to download a file again into its folder and remove the first copy (shown as “Download files and read and modify the browser’s download history”). In both, to save and delete the two small files of **Browse…**. |
| `storage` | To keep your rules and settings, in Firefox the downloads being sorted, and in Chrome the names of the small files of **Browse…** while they are saved. |
| `activeTab` | To read the address of the current tab, only when you click the DownHere button, so the popup can fill in the website. |

## Development

The extension is plain JavaScript with no build step and no dependencies. [Node.js](https://nodejs.org/) 20 or newer
is only needed for the tests and for packaging.

```sh
npm test               # run the unit tests
npm run test:chrome    # try DownHere in a real Chrome (needs Chrome 121 or newer)
npm run test:firefox   # try DownHere in a real Firefox (needs Firefox 140 or newer)
npm run package        # create dist/downhere-<version>-chrome.zip and dist/downhere-<version>-firefox.zip
```

`extension/manifest.json` works in both browsers, so the `extension` folder can be loaded as it is (Chrome may warn
about the keys only Firefox uses; the packaged ZIPs leave out the other browser’s keys). After changing
files in `extension/`, click the reload button on DownHere’s card in `chrome://extensions`, or **Reload** next to
DownHere in Firefox’s `about:debugging#/runtime/this-firefox`.

`npm run test:chrome` and `npm run test:firefox` start the browser without a window and with a new, empty profile, so
your own browser isn’t touched. They download files from a small website on your computer and try **Browse…**. Set
`CHROME` or `FIREFOX` to the browser program if it isn’t found. Without a window, Chrome closes every save dialog right
away, so the Chrome test tries **Browse…** with a closed dialog; the Firefox test answers Firefox’s save dialog with a
stand-in.

```text
extension/
  manifest.json         Extension manifest (Manifest V3, for Chrome and Firefox)
  background.js         Background script: picks the folder for each download
  lib/rules.js          Rule matching and Chrome's path rules (no browser APIs, unit tested)
  lib/redownload.js     Firefox: downloads a file again into its folder (unit tested)
  lib/folder-picker.js  Browse…: works out the folder chosen in the save dialog (unit tested)
  lib/storage.js        Reading and saving rules and settings
  lib/ui.js             Shared helpers for the popup and settings page
  popup/                Toolbar popup
  options/              Settings page
  styles/               Shared styles
  icons/                Extension icons
assets/icon.svg         Source of the icons
docs/screenshots/       Images used in this README
scripts/                Packaging (package.mjs, manifests.mjs) and the browser tests (browser-tests/)
tests/                  Unit tests (Node's built-in test runner)
.github/workflows/      Runs all tests on every push (test.yml) and adds the ZIPs to each release (release.yml)
```

### Releasing a new version

1. Update `version` in both `extension/manifest.json` and `package.json`, and describe the changes in
   [CHANGELOG.md](CHANGELOG.md) under a heading like `## 0.3.0 – 2026-10-01`. Commit the changes to `main`.
2. Publish a release for the tag `v` + the version, either on GitHub (**Releases** › **Draft a new release**, type
   `v0.3.0` as a new tag on `main`, then **Publish release**) or from the command line:

   ```sh
   git tag -a v0.3.0 -m "DownHere 0.3.0"
   git push origin v0.3.0
   ```

3. The **Release** workflow then runs the tests, builds `downhere-0.3.0-chrome.zip` and `downhere-0.3.0-firefox.zip`
   and attaches them to the release (it creates the release if you only pushed a tag). If the release has no
   description, it uses the notes from the changelog. It stops with an error if the tag doesn’t match the version in
   both files.
4. To update the Chrome Web Store listing, upload the Chrome ZIP in the Chrome Web Store Developer Dashboard. For
   Firefox, upload the Firefox ZIP on [addons.mozilla.org](https://addons.mozilla.org/developers/) to have it signed,
   either listed there or for sharing yourself. The add-on ID in `manifest.json` (`downhere@megafia.github.io`) can’t
   change once it has been submitted.

## License

DownHere is released under the [MIT License](LICENSE).
