// Publishing = committing the site folder and pushing it to GitHub, done with
// isomorphic-git (git written in JavaScript) so no git program has to be
// installed. Works the same on Windows and inside the Mac app.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import { SITE_ROOT } from "../config.ts";
import { HttpError } from "./errors.ts";
import { deleteSite, readSite, sitePath, siteExists, writeSite } from "./files.ts";
import { bumpVersion, versionIn } from "./cacheBust.ts";
import { isGenerated, mergeFile } from "./merge.ts";
import { regenerate } from "./site-gen.ts";
import { checkConnection, ensurePages, gitAuth, githubConfigured, redact, repoUrl } from "./github.ts";

const dir = SITE_ROOT;
const base = { fs, dir };
const DEFAULT_AUTHOR = { name: "On the Move Studio", email: "studio@onthemove.local" };
const IGNORE = ".DS_Store\nThumbs.db\ndesktop.ini\n*.tmp\n";

function isRepoRoot(): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

async function resolve(ref: string): Promise<string | null> {
  try {
    return await git.resolveRef({ ...base, ref });
  } catch {
    return null;
  }
}

async function currentBranch(): Promise<string> {
  return (await git.currentBranch({ ...base, fullname: false }).catch(() => undefined)) || "main";
}

async function author() {
  const name = await git.getConfig({ ...base, path: "user.name" }).catch(() => undefined);
  const email = await git.getConfig({ ...base, path: "user.email" }).catch(() => undefined);
  return name && email ? { name: String(name), email: String(email) } : DEFAULT_AUTHOR;
}

// The repository the key belongs to is the one to publish to.
async function ensureRemote() {
  if (!githubConfigured() || !isRepoRoot()) return;
  const want = repoUrl();
  const current = await git.getConfig({ ...base, path: "remote.origin.url" }).catch(() => undefined);
  if (current !== want) await git.addRemote({ ...base, remote: "origin", url: want, force: true });
}

// The last published version of a site file, or null if there isn't one.
export async function committedFile(rel: string): Promise<string | null> {
  if (!isRepoRoot()) return null;
  const oid = await resolve("HEAD");
  if (!oid) return null;
  try {
    const { blob } = await git.readBlob({ ...base, oid, filepath: rel.replace(/\\/g, "/") });
    return Buffer.from(blob).toString("utf8");
  } catch {
    return null;
  }
}

type Change = { file: string; state: "added" | "modified" | "deleted" };

// What changed since the last publish, by content. isomorphic-git's own
// status trusts file timestamps rounded to the second, so an edit made in the
// same second as a download or publish that keeps the file's size (null → 2019)
// would go unnoticed and never be published. Here every file is compared by
// its git hash; unchanged files (videos) aren't re-read thanks to a cache
// keyed on the exact timestamp.
const hashCache = new Map<string, { size: number; mtimeMs: number; ino: number; oid: string }>();

function blobHash(file: string, rel: string): string {
  const st = fs.statSync(file);
  const hit = hashCache.get(rel);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.ino === st.ino) return hit.oid;
  const content = fs.readFileSync(file);
  const oid = crypto.createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
  hashCache.set(rel, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, oid });
  return oid;
}

async function headFiles(): Promise<Map<string, string>> {
  const head = await resolve("HEAD");
  return head ? treeFiles(head) : new Map();
}

// path → blob id for every file in a commit.
async function treeFiles(commit: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  await git.walk({
    ...base,
    trees: [git.TREE({ ref: commit })],
    map: async (filepath, [entry]) => {
      if (!entry) return null;
      if ((await entry.type()) === "blob") files.set(filepath, await entry.oid());
      return true;
    },
  });
  return files;
}

async function workingFiles(): Promise<string[]> {
  const out: string[] = [];
  const visit = async (rel: string) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (child === ".git" || (await git.isIgnored({ ...base, filepath: child }))) continue;
      if (d.isDirectory()) await visit(child);
      else if (d.isFile()) out.push(child);
    }
  };
  await visit("");
  return out;
}

async function changedFiles(): Promise<Change[]> {
  const head = await headFiles();
  const work = await workingFiles();
  const changes: Change[] = [];
  for (const file of work) {
    const oid = head.get(file);
    if (!oid) changes.push({ file, state: "added" });
    else if (blobHash(path.join(dir, file), file) !== oid) changes.push({ file, state: "modified" });
  }
  const present = new Set(work);
  for (const file of head.keys()) if (!present.has(file)) changes.push({ file, state: "deleted" });
  return changes.sort((a, b) => a.file.localeCompare(b.file));
}

async function stageAll() {
  for (const c of await changedFiles()) {
    if (c.state === "deleted") await git.remove({ ...base, filepath: c.file });
    else await git.add({ ...base, filepath: c.file });
  }
}

function safeJson(text: string | null) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const STRINGS_BLOCK = /\/\* STRINGS:BEGIN \*\/([\s\S]*?)\/\* STRINGS:END \*\//;

// Turns a list of changed files into what actually changed, in words.
async function describe(changes: Change[]) {
  const items: { area: string; text: string }[] = [];
  const has = (f: string) => changes.some((c) => c.file === f);

  if (has("assets/data/portfolio.json")) {
    const before = safeJson(await committedFile("assets/data/portfolio.json")) ?? { projects: [], categories: [] };
    const after = safeJson(readSite("assets/data/portfolio.json")) ?? { projects: [], categories: [] };
    const title = (p: any) => p.title?.en || p.title?.cs || p.id;
    const beforeById = new Map<string, any>((before.projects ?? []).map((p: any) => [p.id, p]));
    const afterIds = new Set((after.projects ?? []).map((p: any) => p.id));
    for (const p of after.projects ?? []) {
      const old = beforeById.get(p.id);
      if (!old) items.push({ area: "Films", text: `Added “${title(p)}”${p.status === "draft" ? " (draft)" : ""}` });
      else {
        const { updatedAt: _a, ...a } = old;
        const { updatedAt: _b, ...b } = p;
        if (JSON.stringify(a) !== JSON.stringify(b)) items.push({ area: "Films", text: `Edited “${title(p)}”` });
      }
    }
    for (const p of before.projects ?? []) if (!afterIds.has(p.id)) items.push({ area: "Films", text: `Removed “${title(p)}”` });
    const order = (d: any) => (d.projects ?? []).map((p: any) => p.id).filter((id: string) => beforeById.has(id) && afterIds.has(id)).join();
    if (order(before) !== order(after)) items.push({ area: "Films", text: "Changed the order of films" });
    if (JSON.stringify(before.categories) !== JSON.stringify(after.categories))
      items.push({ area: "Films", text: "Changed categories" });
  }

  if (has("assets/js/i18n.js")) {
    const parse = (t: string | null) => safeJson((t && STRINGS_BLOCK.exec(t)?.[1]) ?? null);
    const before = parse(await committedFile("assets/js/i18n.js"));
    const after = parse(readSite("assets/js/i18n.js"));
    if (before && after) {
      const keys = Object.keys(after.cs).filter((k) => before.cs[k] !== after.cs[k] || before.en[k] !== after.en[k]);
      for (const k of keys.slice(0, 12)) items.push({ area: "Text", text: `“${truncate(after.en[k] || after.cs[k])}”` });
      if (keys.length > 12) items.push({ area: "Text", text: `…and ${keys.length - 12} more` });
    } else items.push({ area: "Text", text: "Site text changed" });
  }

  if (has("assets/css/style.css")) {
    const re = /(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g;
    const toMap = (t: string | null) => new Map([...(t ?? "").matchAll(re)].map((m) => [m[1], m[2].toLowerCase()]));
    const before = toMap(await committedFile("assets/css/style.css"));
    const after = toMap(readSite("assets/css/style.css"));
    const changed = [...after].filter(([k, v]) => before.get(k) !== v).map(([k]) => k);
    items.push({ area: "Colors", text: changed.length ? `Changed ${changed.join(", ")}` : "Stylesheet changed" });
  }

  const media = changes.filter((c) => /^assets\/(img\/portfolio|video)\//.test(c.file));
  for (const m of media) {
    const kind = m.file.includes("/video/") ? "video" : "image";
    items.push({ area: "Media", text: `${m.state === "deleted" ? "Removed" : m.state === "added" ? "New" : "Updated"} ${kind} ${path.basename(m.file)}` });
  }

  if (has("assets/data/site.json")) items.push({ area: "Settings", text: "Site address, contact form or analytics" });

  // Derived files (film pages, 404, sitemap) are rebuilt from the changes
  // above, so they aren't listed on their own.
  const known =
    /^(assets\/data\/(portfolio|site)\.json|assets\/js\/i18n\.js|assets\/css\/style\.css|assets\/(img\/portfolio|video)\/.*|(index|about|portfolio|contact|404)\.html|work\/[^/]+\.html|sitemap\.xml|robots\.txt|CNAME|\.gitignore)$/;
  for (const c of changes.filter((c) => !known.test(c.file))) items.push({ area: "Other files", text: `${c.state} ${c.file}` });

  return items;
}

const truncate = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function pagesUrl(remote: string | null): string | null {
  const m = remote && /github\.com[:/]([^/]+)\/([^/.]+?)(\.git)?$/.exec(remote.trim());
  if (!m) return null;
  const [, user, repo] = m;
  return repo.toLowerCase() === `${user.toLowerCase()}.github.io`
    ? `https://${user.toLowerCase()}.github.io/`
    : `https://${user.toLowerCase()}.github.io/${repo}/`;
}

export async function publishStatus() {
  if (!isRepoRoot()) return { state: "not-set-up" as const, siteRoot: SITE_ROOT, canConnect: githubConfigured() };
  await ensureRemote();
  const remote = ((await git.getConfig({ ...base, path: "remote.origin.url" }).catch(() => undefined)) as string | undefined) || null;
  const branch = await currentBranch();
  const headOid = await resolve("HEAD");
  const remoteOid = await resolve(`refs/remotes/origin/${branch}`);
  let unpushed = 0;
  if (headOid && headOid !== remoteOid) {
    for (const c of await git.log({ ...base, ref: "HEAD", depth: 200 })) {
      if (c.oid === remoteOid) break;
      unpushed++;
    }
  }
  const lastPublishedAt = remoteOid
    ? new Date((await git.readCommit({ ...base, oid: remoteOid })).commit.committer.timestamp * 1000).toISOString()
    : null;
  const changes = await changedFiles();
  const summary = await describe(changes);
  return {
    state: remote ? ("ready" as const) : ("no-remote" as const),
    siteRoot: SITE_ROOT,
    canConnect: githubConfigured(),
    remote,
    branch,
    liveUrl: pagesUrl(remote),
    lastPublishedAt,
    unpushed,
    changes,
    summary,
    // Count what a person changed, not files: one text edit also touches all
    // four pages' cache-refresh numbers.
    pending: (summary.length || changes.length) + (changes.length ? 0 : unpushed),
  };
}

let busy = false;
export const isBusy = () => busy;

async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw new HttpError(409, "A publish is already running.");
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

// Brings in what was published from another computer. Only ever moves
// forward to GitHub's version when nothing here would be lost; otherwise it
// says so and leaves everything as it is.
export type SyncResult = { state: "up-to-date" | "updated" | "merged" | "offline" | "skipped" | "conflict"; message?: string; notes?: string[] };

const ASSETS: Record<string, string> = {
  "style.css": "assets/css/style.css",
  "i18n.js": "assets/js/i18n.js",
  "main.js": "assets/js/main.js",
  "portfolio-render.js": "assets/js/portfolio-render.js",
};

async function readBlobOrNull(oid: string | undefined): Promise<Buffer | null> {
  if (!oid) return null;
  const { blob } = await git.readBlob({ ...base, oid });
  return Buffer.from(blob);
}

// Combines this computer's unpublished work with what was published from
// elsewhere, then records it as one merge so the next push goes through.
async function mergeRemote(theirs: string): Promise<SyncResult> {
  if ((await changedFiles()).length) {
    await stageAll();
    await git.commit({ ...base, author: await author(), message: "Unpublished changes from this computer" });
  }
  const ours = (await resolve("HEAD"))!;
  const [baseOid] = await git.findMergeBase({ ...base, oids: [ours, theirs] });
  if (!baseOid) {
    return { state: "conflict", message: "This computer's copy of the website and GitHub's don't share any history, so they can't be combined. Ask for help." };
  }
  const [B, O, T] = await Promise.all([treeFiles(baseOid), treeFiles(ours), treeFiles(theirs)]);
  const notes: string[] = [];
  for (const file of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
    const [b, o, t] = [B.get(file), O.get(file), T.get(file)];
    if (o === t || t === b) continue; // already what this computer has
    const merged = o === b ? await readBlobOrNull(t) : mergeFile(file, await readBlobOrNull(b), await readBlobOrNull(o), await readBlobOrNull(t), notes);
    if (merged === null) {
      if (siteExists(file)) deleteSite(file);
    } else {
      writeSite(file, merged);
    }
  }
  // Pages, film pages and the sitemap are rebuilt from the combined content.
  // The pages may now come from GitHub's side, so any script or stylesheet
  // that ends up different from GitHub's copy gets a version number above
  // both sides', or browsers could keep serving an old copy.
  const page = async (oid: string | undefined) => (await readBlobOrNull(oid))?.toString("utf8") ?? "";
  const [oursIndex, theirsIndex] = await Promise.all([page(O.get("index.html")), page(T.get("index.html"))]);
  for (const [asset, file] of Object.entries(ASSETS)) {
    const theirsContent = await readBlobOrNull(T.get(file));
    const now = siteExists(file) ? fs.readFileSync(sitePath(file)) : null;
    if (!now || (theirsContent && now.equals(theirsContent))) continue;
    bumpVersion(asset, Math.max(versionIn(oursIndex, asset), versionIn(theirsIndex, asset)) + 1);
  }
  regenerate();
  await stageAll();
  await git.commit({
    ...base,
    author: await author(),
    parent: [ours, theirs],
    message: ["Combine with changes published from another computer", "", ...notes.map((n) => `- ${n}`)].join("\n").trim(),
  });
  return {
    state: "merged",
    notes,
    message: notes.length
      ? `Combined with changes published from another computer. ${notes.join(" ")}`
      : "Combined with changes published from another computer.",
  };
}

async function syncInner(): Promise<SyncResult> {
  if (!isRepoRoot() || !githubConfigured()) return { state: "skipped" };
  await ensureRemote();
  const branch = await currentBranch();
  try {
    await git.fetch({ ...base, http, ...gitAuth, remote: "origin", ref: branch, singleBranch: true, tags: false });
  } catch {
    return { state: "offline" };
  }
  const local = await resolve("HEAD");
  const theirs = await resolve(`refs/remotes/origin/${branch}`);
  if (!theirs || local === theirs) return { state: "up-to-date" };
  if (local && (await git.isDescendent({ ...base, oid: local, ancestor: theirs, depth: -1 }))) return { state: "up-to-date" };
  const fastForward = !local || (await git.isDescendent({ ...base, oid: theirs, ancestor: local, depth: -1 }));
  if (!fastForward || (await changedFiles()).length) return mergeRemote(theirs);
  await git.writeRef({ ...base, ref: `refs/heads/${branch}`, value: theirs, force: true });
  await git.checkout({ ...base, ref: branch, force: true });
  return { state: "updated" };
}

export const sync = () => exclusive(syncInner);

export async function publish(message?: string) {
  return exclusive(async () => {
    const before = await publishStatus();
    if (before.state === "not-set-up") throw new HttpError(409, "Publishing isn't set up yet for this site folder.");
    if (before.state === "no-remote") throw new HttpError(409, "This site isn't connected to GitHub yet.");
    const synced = await syncInner();
    if (synced.state === "conflict") throw new HttpError(409, synced.message!);
    // Absolute addresses for link previews and the sitemap need the live URL.
    regenerate(before.liveUrl ?? undefined);
    const now = await publishStatus();
    const branch = now.state === "ready" ? now.branch : "main";
    if (now.state === "ready" && now.changes.length) {
      await stageAll();
      await git.commit({ ...base, author: await author(), message: message?.trim() || autoMessage(now.summary) });
    }
    await push(branch);
    const pagesProblem = await ensurePages(branch);
    return { ...(await publishStatus()), pagesProblem, merged: synced.state === "merged" ? synced.message ?? null : null };
  });
}

async function push(branch: string) {
  try {
    const result = await git.push({ ...base, http, ...gitAuth, remote: "origin", ref: branch });
    if (!result.ok) throw Object.assign(new Error(result.error || "Push failed"), { code: "PushFailed" });
    await git.setConfig({ ...base, path: `branch.${branch}.remote`, value: "origin" });
    await git.setConfig({ ...base, path: `branch.${branch}.merge`, value: `refs/heads/${branch}` });
  } catch (err) {
    throw pushError(err);
  }
}

function pushError(err: any) {
  const status = err?.data?.statusCode;
  const detail = redact(`${err?.code ?? ""} ${status ?? ""} ${err?.message ?? err}`.trim());
  const rejected = err?.code === "PushRejectedError" || /not-fast-forward|rejected|fetch first/i.test(detail);
  const auth = err?.code === "UserCanceledError" || status === 401 || status === 403 || /denied|authentication/i.test(detail);
  return new HttpError(
    502,
    rejected
      ? "GitHub has changes this computer doesn't have (the site was published from another computer, or edited on github.com). Your changes are saved here; ask for help before publishing again."
      : auth
        ? "GitHub refused the key (it may have expired, or lacks permission to change the repository). Your changes are saved here."
        : "Couldn't reach GitHub. Your changes are saved here; check the internet connection and publish again.",
    { detail },
  );
}

// First-time setup when the site folder already exists on this computer:
// turns it into a repository, uploads it to the (empty) GitHub repository the
// key belongs to, and switches on GitHub Pages.
export async function connect() {
  if (!githubConfigured()) throw new HttpError(409, "Add the GitHub repository and key first.");
  const conn = await checkConnection(true);
  if (conn.state !== "ok") throw new HttpError(502, "message" in conn ? conn.message : "GitHub isn't set up.");
  return exclusive(async () => {
    if (!isRepoRoot()) await git.init({ ...base, defaultBranch: "main" });
    if (!siteExists(".gitignore")) writeSite(".gitignore", IGNORE, { backup: false });
    await ensureRemote();
    const branch = await currentBranch();
    let remoteHeads: unknown[];
    try {
      remoteHeads = await git.listServerRefs({ http, ...gitAuth, url: repoUrl(), prefix: "refs/heads/" });
    } catch (err) {
      throw pushError(err);
    }
    const hasHead = !!(await resolve("HEAD"));
    if (remoteHeads.length && !hasHead) {
      throw new HttpError(
        409,
        `The repository ${conn.repo} on GitHub already has files in it. Use a new, empty repository (no README), or ask for help connecting this one.`,
      );
    }
    regenerate(conn.pagesUrl ?? pagesUrl(repoUrl()) ?? undefined);
    if ((await changedFiles()).length || !hasHead) {
      await stageAll();
      await git.commit({ ...base, author: await author(), message: "Publish the website" });
    }
    await push(branch);
    const pagesProblem = await ensurePages(branch);
    return { ...(await publishStatus()), pagesProblem };
  });
}

// First run of the Mac app: downloads the published website from GitHub into
// an empty folder on this computer.
export async function cloneSite(target: string, onProgress?: (fraction: number, phase: string) => void) {
  if (!githubConfigured()) throw new HttpError(409, "Add the GitHub repository and key first.");
  return exclusive(async () => {
    fs.mkdirSync(target, { recursive: true });
    if (fs.readdirSync(target).length) throw new HttpError(409, `The folder ${target} isn't empty.`);
    try {
      await git.clone({
        fs,
        http,
        dir: target,
        url: repoUrl(),
        singleBranch: true,
        ...gitAuth,
        onProgress: (p) => onProgress?.(p.total ? p.loaded / p.total : 0, p.phase),
      });
    } catch (err) {
      fs.rmSync(target, { recursive: true, force: true });
      throw pushError(err);
    }
  });
}

function autoMessage(summary: { area: string; text: string }[]) {
  const areas = [...new Set(summary.map((s) => s.area))];
  const head = areas.length ? `Update ${areas.join(", ").toLowerCase()}` : "Update site";
  return [head, "", ...summary.slice(0, 30).map((s) => `- ${s.area}: ${s.text}`)].join("\n");
}
