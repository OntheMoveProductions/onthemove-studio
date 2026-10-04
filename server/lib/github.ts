// Talks to GitHub with the stored key, so publishing never depends on the
// computer being signed in to GitHub or on anyone using a terminal.
import { getRepo, getToken } from "./credentials.ts";

export const githubConfigured = () => !!(getToken() && getRepo());
// OTM_GIT_BASE points at a local git server in tests.
const gitBase = () => (process.env.OTM_GIT_BASE || "https://github.com").replace(/\/$/, "");
export const repoUrl = () => (getRepo() ? `${gitBase()}/${getRepo()}.git` : "");

// For isomorphic-git: answers its sign-in request with the key, and gives up
// instead of retrying when GitHub refuses it.
export const gitAuth = {
  onAuth: () => ({ username: "x-access-token", password: getToken() }),
  onAuthFailure: () => ({ cancel: true }),
};

// Strips the key out of anything that might be shown or logged.
export function redact(text: string): string {
  const token = getToken();
  if (!token) return text;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return text.split(token).join("***").split(basic).join("***");
}

export function resetConnectionCache() {
  cache = null;
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "on-the-move-studio",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

export type Connection =
  | { state: "not-configured" }
  | { state: "ok"; repo: string; pagesUrl: string | null; pagesEnabled: boolean }
  | { state: "bad-token" | "no-access" | "offline"; repo: string; message: string };

let cache: { at: number; value: Connection } | null = null;

export async function checkConnection(force = false): Promise<Connection> {
  if (!githubConfigured()) return { state: "not-configured" };
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.value;
  let value: Connection;
  try {
    const repo = await api("GET", `/repos/${getRepo()}`);
    if (repo.status === 401) {
      value = { state: "bad-token", repo: getRepo(), message: "GitHub didn't accept the key. It may have expired, or been deleted; make a new one." };
    } else if (repo.status === 404 || repo.status === 403) {
      value = {
        state: "no-access",
        repo: getRepo(),
        message: `The key works, but it can't reach the repository ${getRepo()}. Check the name, and that the key was given access to that repository.`,
      };
    } else if (repo.status !== 200) {
      value = { state: "offline", repo: getRepo(), message: `GitHub answered with an unexpected error (${repo.status}).` };
    } else {
      const pages = await api("GET", `/repos/${getRepo()}/pages`);
      value = {
        state: "ok",
        repo: getRepo(),
        pagesEnabled: pages.status === 200,
        pagesUrl: pages.status === 200 ? pages.data?.html_url ?? null : null,
      };
    }
  } catch {
    value = { state: "offline", repo: getRepo(), message: "Couldn't reach GitHub. Check the internet connection." };
  }
  cache = { at: Date.now(), value };
  return value;
}

// Switches GitHub Pages on for the repository (serving the main branch's
// root). Returns null on success, or a sentence saying what to do by hand.
export async function ensurePages(branch: string): Promise<string | null> {
  if (!githubConfigured()) return null;
  try {
    const existing = await api("GET", `/repos/${getRepo()}/pages`);
    if (existing.status === 200) return null;
    const created = await api("POST", `/repos/${getRepo()}/pages`, { source: { branch, path: "/" } });
    cache = null;
    if (created.status === 201 || created.status === 409) return null;
    if (created.status === 422 && /private|plan/i.test(JSON.stringify(created.data)))
      return "GitHub Pages isn't available for private repositories on a free account. Make the repository public in its settings.";
    return "The site is uploaded. One last step, once: on github.com open the repository → Settings → Pages → Source “Deploy from a branch” → branch main, folder / (root) → Save. The site appears a minute later.";
  } catch {
    return "The site was uploaded, but GitHub couldn't be reached to switch on GitHub Pages. Try publishing again later.";
  }
}
