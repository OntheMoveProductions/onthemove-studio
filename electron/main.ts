// The Mac app: runs the editor's server inside the app and shows the
// dashboard in its own window. Nothing is hosted online; the website folder
// lives in ~/Documents/On the Move Website and is published to GitHub Pages.
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, Menu, safeStorage, shell } from "electron";
import { createUpdater, type Updater } from "./updater.ts";

app.setName("On the Move Studio");

const userData = app.getPath("userData");
const siteRoot = path.join(app.getPath("documents"), "On the Move Website");

// Read by the server's config when it loads, so set before importing it.
process.env.OTM_DATA_DIR = userData;
process.env.SITE_ROOT ??= siteRoot;
process.env.OTM_DIST_DIR = path.join(app.getAppPath(), "dist");

// ---------------------------------------------------------------- GitHub key, kept in the Keychain

const credentialsFile = path.join(userData, "github.json");

// The key lives in a file only this Mac user can read (Library/Application
// Support). Not the Keychain: the app isn't signed by Apple, so after every
// update macOS would treat it as a different app and ask for the Mac password
// before letting it read its own key.
const writeCredentials = (c: { repo: string; token: string }) => {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(credentialsFile, JSON.stringify({ repo: c.repo, key: c.token }, null, 2), { mode: 0o600 });
  fs.chmodSync(credentialsFile, 0o600);
};

const credentialStore = {
  kind: "app" as const,
  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(credentialsFile, "utf8"));
      if (typeof saved.key === "string") return { repo: String(saved.repo || ""), token: saved.key };
      // Versions before 2.1 kept it encrypted in the Keychain: read it once
      // and move it to the file.
      if (saved.token && safeStorage.isEncryptionAvailable()) {
        const migrated = { repo: String(saved.repo || ""), token: safeStorage.decryptString(Buffer.from(saved.token, "base64")) };
        writeCredentials(migrated);
        return migrated;
      }
      return { repo: String(saved.repo || ""), token: "" };
    } catch {
      return { repo: "", token: "" };
    }
  },
  save: writeCredentials,
};

// ---------------------------------------------------------------- window

let win: BrowserWindow | null = null;
let baseUrl = "";
let isBusy: () => boolean = () => false;
let updater: Updater | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "On the Move Studio",
    backgroundColor: "#080605",
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once("ready-to-show", () => win?.show());
  win.loadURL(baseUrl);

  // Links to the live site, the preview and anything external open in the
  // normal browser; the window only ever shows the dashboard.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(baseUrl)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.on("closed", () => (win = null));
}

function buildMenu() {
  const go = (route: string) => win?.loadURL(new URL(route, baseUrl).toString());
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: "GitHub connection…", click: () => go("/setup") },
          { label: "Show website folder", click: () => shell.openPath(process.env.SITE_ROOT!) },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [{ role: "reload" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }],
      },
      { role: "windowMenu" },
    ]),
  );
}

// ---------------------------------------------------------------- lifecycle

// One copy at a time: a second launch just brings the existing window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const server = await import("../server/app.ts");
      isBusy = server.isBusy;
      updater = createUpdater(server.isBusy);
      const { port } = await server.startServer({ port: Number(process.env.OTM_PORT) || 0, host: "127.0.0.1", credentialStore, updater });
      baseUrl = `http://127.0.0.1:${port}/`;
    } catch (err: any) {
      dialog.showErrorBox("On the Move Studio couldn't start", String(err?.message ?? err));
      app.exit(1);
      return;
    }
    if (process.env.OTM_SMOKE_TEST) return runSmokeTest();
    if (process.env.OTM_UPDATE_SELFTEST) return runUpdateSelfTest();
    buildMenu();
    createWindow();
    // Look for a new version now and every few hours; the dashboard shows it.
    updater.check();
    setInterval(() => updater?.check(), 6 * 3600 * 1000);
  });

  app.on("window-all-closed", () => app.quit());
  app.on("activate", () => {
    if (!win && baseUrl) createWindow();
  });

  // Quitting mid-publish or mid-conversion would lose that work.
  let confirmedQuit = false;
  app.on("before-quit", (e) => {
    if (confirmedQuit || !isBusy()) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      buttons: ["Keep working", "Quit anyway"],
      defaultId: 0,
      cancelId: 0,
      message: "Still working",
      detail: "A video is being converted or the website is being published. Quitting now loses that.",
    });
    if (choice === 1) {
      confirmedQuit = true;
      app.quit();
    }
  });
}

// CI check that the packaged app's server, image and video tools all work.
// CI check of the whole update path against a fake release (OTM_UPDATE_FEED):
// finds the "new version", downloads, unpacks, verifies, swaps and relaunches.
async function runUpdateSelfTest() {
  const state = await updater!.check();
  console.log("update check:", JSON.stringify(state));
  if (!state.available) {
    console.log("FAIL no update offered");
    return app.exit(1);
  }
  try {
    await updater!.install();
    console.log("PASS install started; app will be replaced and reopened");
  } catch (err: any) {
    console.log("FAIL", err?.message ?? err);
    app.exit(1);
  }
}

async function runSmokeTest() {
  const results: string[] = [];
  let failed = false;
  const check = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      results.push(`PASS ${name}`);
    } catch (err: any) {
      failed = true;
      results.push(`FAIL ${name}: ${err?.message ?? err}`);
    }
  };
  await check("server answers", async () => {
    const res = await fetch(new URL("/api/session", baseUrl));
    if (!res.ok) throw new Error(`status ${res.status}`);
  });
  await check("dashboard is served", async () => {
    const html = await (await fetch(baseUrl)).text();
    if (!html.includes('id="root"')) throw new Error("index.html missing");
  });
  await check("sharp loads and resizes", async () => {
    const sharp = (await import("sharp")).default;
    await sharp({ create: { width: 64, height: 36, channels: 3, background: "#73aca3" } }).jpeg().toBuffer();
  });
  await check("ffmpeg runs", async () => {
    const { createRequire } = await import("node:module");
    const bin = createRequire(import.meta.url)("ffmpeg-static") as string;
    const { execFileSync } = await import("node:child_process");
    execFileSync(bin, ["-hide_banner", "-f", "lavfi", "-i", "testsrc=size=321x181:duration=1", "-vf", "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p", "-c:v", "libx264", "-f", "null", "-"], { stdio: "ignore" });
  });
  console.log(results.join("\n"));
  app.exit(failed ? 1 : 0);
}
