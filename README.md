# On the Move Studio

The editor for the On the Move Productions website. It edits the website's
files on the computer it runs on and publishes them to GitHub Pages. The
website itself stays plain files with no server.

It comes in two forms:

- **The app** (for the studio), for Mac and Windows: a normal app with its
  own window. Nothing to install besides the app.
- **The browser editor** (for development): `npm start`, used in a browser tab.

## The Mac app

### Installing

1. From the latest [Release](https://github.com/OntheMoveProductions/onthemove-studio/releases/latest), download the `.dmg` for the Mac's
   chip (Apple menu → About This Mac):
   - **Chip: Apple M1/M2/M3/M4** → `…-arm64.dmg`
   - **Processor: Intel** → `…-x64.dmg`
2. Open the `.dmg` and drag **On the Move Studio** into Applications.
3. The first time, macOS refuses to open it, because the app isn't signed by a
   paid Apple developer account. Click **Done** (not "Move to Trash"), then go
   to **System Settings → Privacy & Security**, scroll down to the message
   about On the Move Studio, click **Open Anyway** and confirm. After that it
   opens normally.

### Installing on Windows

From the same Release, download `On-the-Move-Studio-…-x64.exe` and open it.
It installs for the current Windows user (no administrator needed), adds a
desktop shortcut and opens the app. The installer isn't signed, so Windows
SmartScreen may warn the first time: **More info → Run anyway**.

### Updates

The app checks for a new version when it opens and every few hours. When
there is one, **Update to …** appears at the bottom of the sidebar: click it,
and the app downloads the new version, closes and reopens on it (about a
minute or two). Because the app downloads it itself, macOS doesn't ask for
"Open Anyway" again, and Windows doesn't show SmartScreen. If the app is somewhere it can't replace itself (for example
a folder the Mac user can't write to), it opens the download page instead.

### First launch

The app asks for the **GitHub repository** (`OntheMoveProductions/onthemove`)
and the **GitHub key** (the fine-grained token). The key is checked with
GitHub, then stored in the app's settings for the current computer user
(on Windows in `%APPDATA%On the Move Studio`); it never leaves the computer. The app
then downloads the website into `Documents/On the Move Website` (a minute or
two) and opens the dashboard.

To change the repository or key later: **On the Move Studio menu → GitHub
connection…**

### Everyday use

- **Films**: add, edit, reorder and remove films. Drop in the master video
  file and it's converted to a web-sized MP4 automatically; pick any frame as
  the poster. Drafts stay in the editor until set to Published. The star marks
  the film shown on the homepage.
- **Pages**: change any text, by clicking it on the page or in the full list.
  Czech and English side by side.
- **Colors**: the brand colors, with a live preview and a readability check.
- **Publish**: shows what changed and puts it live with one button. **Site
  settings** there hold the website's address, the contact form's address and
  the analytics token.

Nothing reaches the live website until Publish is pressed. On every start (and
before every publish) the app first fetches what was published from other
computers, so two people can each publish from their own Mac. If both changed
the site without publishing in between, the app stops and says so instead of
overwriting anything.

Backups of every file the editor overwrites are kept in
`~/Library/Application Support/On the Move Studio/backups` (Windows:
`%APPDATA%On the Move Studioackups`).

### Making a new version (developers)

The app is built on GitHub's machines (`.github/workflows/build.yml`):

```
# bump "version" in package.json, commit, then:
git tag v2.0.1 && git push --tags
```

This builds the Apple Silicon, Intel and Windows versions, checks that the
app's server, image tool and video tool work inside each packaged app, tests
the whole self-update on each (download, install, reopen), and attaches the
`.dmg`, `.zip` and `.exe` files to a GitHub Release. Installed apps pick the
release up by themselves. A test build of one version can be started by hand
under **Actions → Build app → Run workflow**.

Mac build minutes count 10× against the private repository's free 2,000
minutes a month (Windows 2×), so a full build costs roughly 200 of them.

## The browser editor

```
npm install
npm start          # builds the dashboard if needed, serves on :4500
npm run dev        # server with reload + Vite dev server on :5173
npm run typecheck
```

Settings are in `.env` (see `.env.example`): port, an optional password, the
site folder, and the GitHub repository and key used for publishing. Double-
clicking **Start Editor** in the parent folder does the same as `npm start`.

## How it's built

- `server/` is Express + TypeScript. `server/app.ts` (`startServer`) is shared
  by the browser editor (`server/index.ts`) and the Mac app
  (`electron/main.ts`). All writes go through `server/lib/files.ts`
  (path-guarded, atomic, backed up).
- Publishing (`server/lib/publish.ts`) uses isomorphic-git, so no git program
  is needed. Changes are detected by content hash, not by timestamps.
- `client/` is the React dashboard, built by Vite into `dist/`.
- `scripts/build-app.mjs` assembles `build/app` (dashboard, bundled main
  process and server, runtime packages for the target chip), and
  `electron-builder.yml` packages it.
- Site text lives between the `/* STRINGS:BEGIN */` and `/* STRINGS:END */`
  markers in `site/assets/js/i18n.js` as plain JSON; keep the markers if you
  edit that file by hand.
- Films are in `site/assets/data/portfolio.json`, rendered on the site by
  `site/assets/js/portfolio-render.js`.
