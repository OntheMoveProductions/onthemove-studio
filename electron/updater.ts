// In-app updates. The app isn't signed by Apple, so the usual Electron updater
// (which insists on Apple signatures) can't be used. This one checks the
// latest GitHub release, then:
// - Mac: downloads the zip for this Mac's chip, unpacks it with ditto, checks
//   its code signature, then quits, swaps the app in place and reopens it.
//   Files the app downloads itself aren't marked as "from the internet", so
//   macOS doesn't ask for "Open Anyway" again.
// - Windows: downloads the installer, runs it silently and quits; the
//   installer replaces the app and starts it again.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { app, shell } from "electron";

const run = promisify(execFile);
const WINDOWS = process.platform === "win32";

export const RELEASES_REPO = "OntheMoveProductions/onthemove-studio";
const FEED = process.env.OTM_UPDATE_FEED || `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;

export type UpdateState = {
  supported: boolean;
  current: string;
  latest: string | null;
  available: boolean;
  phase: "idle" | "checking" | "downloading" | "installing" | "error";
  progress: number;
  error: string | null;
  releaseUrl: string | null;
};

// "v2.10.0" > "v2.9.3"
export function isNewer(candidate: string, current: string) {
  const parts = (v: string) => v.replace(/^v/, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

const INSTALL_SCRIPT = `#!/bin/bash
# Waits for the old app to quit, swaps in the new one, reopens it.
PID="$1"; TARGET="$2"; NEW="$3"
for i in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
BACKUP="$TARGET.previous"
rm -rf "$BACKUP"
if mv "$TARGET" "$BACKUP" && mv "$NEW" "$TARGET"; then
  rm -rf "$BACKUP"
elif [ -d "$BACKUP" ] && [ ! -d "$TARGET" ]; then
  mv "$BACKUP" "$TARGET"
fi
open "$TARGET"
`;

export function createUpdater(isBusy: () => boolean) {
  const supported = ((process.platform === "darwin" || WINDOWS) && app.isPackaged) || !!process.env.OTM_UPDATE_FEED;
  const state: UpdateState = {
    supported,
    current: app.getVersion(),
    latest: null,
    available: false,
    phase: "idle",
    progress: 0,
    error: null,
    releaseUrl: null,
  };
  let assetUrl: string | null = null;

  async function check(): Promise<UpdateState> {
    if (!supported || state.phase === "downloading" || state.phase === "installing") return { ...state };
    state.phase = "checking";
    try {
      const res = await fetch(FEED, { headers: { Accept: "application/vnd.github+json", "User-Agent": "on-the-move-studio" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const release = await res.json();
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      // Mac: the zip of the app for this chip. Windows: the installer.
      const asset = (release.assets ?? []).find((a: any) => a.name.endsWith(WINDOWS ? "-x64.exe" : `-${arch}.zip`));
      state.latest = String(release.tag_name ?? "").replace(/^v/, "") || null;
      state.releaseUrl = release.html_url ?? null;
      assetUrl = asset?.browser_download_url ?? null;
      state.available = !!(state.latest && assetUrl && isNewer(state.latest, state.current));
      state.phase = "idle";
      state.error = null;
    } catch (err: any) {
      // Offline or GitHub unreachable: try again at the next check. The
      // reason is kept for diagnosis; the dashboard only shows real updates.
      state.phase = "idle";
      state.error = `Update check failed: ${err?.cause?.code ?? err?.message ?? err}`;
    }
    return { ...state };
  }

  async function install(): Promise<void> {
    if (!state.available || !assetUrl) throw new Error("There's no update to install.");
    if (state.phase === "downloading" || state.phase === "installing") return;
    if (isBusy()) throw new Error("Wait until the video conversion or publish has finished, then install the update.");
    const bundle = path.resolve(process.execPath, "..", "..", "..");
    if (!WINDOWS) {
      try {
        if (!bundle.endsWith(".app")) throw new Error("not running from an app bundle");
        fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
      } catch {
        if (state.releaseUrl) shell.openExternal(state.releaseUrl);
        throw new Error("This Mac doesn't let the app replace itself where it's installed. The download page has been opened instead.");
      }
    }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), "otm-update-"));
    try {
      state.phase = "downloading";
      state.progress = 0;
      state.error = null;
      // A download that stops receiving data (dropped Wi-Fi) fails after a
      // minute instead of hanging forever.
      const idle = new AbortController();
      let idleTimer = setTimeout(() => idle.abort(), 60_000);
      const res = await fetch(assetUrl, { headers: { "User-Agent": "on-the-move-studio" }, signal: idle.signal });
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`);
      const total = Number(res.headers.get("content-length")) || 0;
      const zip = path.join(work, WINDOWS ? "setup.exe" : "update.zip");
      const out = fs.createWriteStream(zip);
      let received = 0;
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => idle.abort(), 60_000);
        received += chunk.length;
        if (total) state.progress = received / total;
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      }
      clearTimeout(idleTimer);
      await new Promise<void>((r, j) => out.end((err?: Error | null) => (err ? j(err) : r())));
      if (total && received !== total) throw new Error("The download was incomplete.");

      state.phase = "installing";
      if (WINDOWS) {
        // The installer replaces the app quietly (/S) and starts it again
        // (--force-run) once this copy has quit.
        spawn(zip, ["/S", "--force-run"], { detached: true, stdio: "ignore" }).unref();
        setTimeout(() => app.exit(0), 300);
        return;
      }
      const unpacked = path.join(work, "unpacked");
      await run("ditto", ["-x", "-k", zip, unpacked]);
      const name = fs.readdirSync(unpacked).find((n) => n.endsWith(".app"));
      if (!name) throw new Error("The update file didn't contain the app.");
      const fresh = path.join(unpacked, name);
      await run("xattr", ["-dr", "com.apple.quarantine", fresh]).catch(() => {});
      // A broken download would fail here, before anything is replaced.
      await run("codesign", ["--verify", "--deep", "--strict", fresh]);

      const script = path.join(work, "install.sh");
      fs.writeFileSync(script, INSTALL_SCRIPT, { mode: 0o755 });
      spawn("/bin/bash", [script, String(process.pid), bundle, fresh], { detached: true, stdio: "ignore" }).unref();
      setTimeout(() => app.exit(0), 300);
    } catch (err: any) {
      state.phase = "error";
      const reason = err?.name === "AbortError" ? "the download stopped. Check the internet connection and try again." : (err?.message ?? err);
      state.error = `The update couldn't be installed: ${reason}`;
      fs.rmSync(work, { recursive: true, force: true });
      throw new Error(state.error);
    }
  }

  return { status: () => ({ ...state }), check, install };
}

export type Updater = ReturnType<typeof createUpdater>;
