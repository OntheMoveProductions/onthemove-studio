// Where the GitHub repository name and key come from. The browser editor reads
// them from .env; the Mac app swaps in a store backed by the macOS Keychain
// (see electron/main.ts) so the Setup screen can change them at runtime.

export type Credentials = { repo: string; token: string };
export type CredentialStore = {
  kind: "env" | "app";
  load(): Credentials;
  save?(c: Credentials): void;
};

// "owner/name"; a full github.com URL is accepted too.
export function normalizeRepo(raw: string): string {
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(raw.trim());
  return m ? `${m[1]}/${m[2]}` : "";
}

const envStore: CredentialStore = {
  kind: "env",
  load: () => ({ repo: normalizeRepo(process.env.GITHUB_REPO || ""), token: (process.env.GITHUB_TOKEN || "").trim() }),
};

let store: CredentialStore = envStore;
let current: Credentials | null = null;
const creds = () => (current ??= store.load());

export function useCredentialStore(s: CredentialStore) {
  store = s;
  current = null;
}

export const credentialStoreKind = () => store.kind;
export const getRepo = () => creds().repo;
export const getToken = () => creds().token;

// persist=false only changes them in memory, so new details can be tested
// against GitHub before they replace working ones.
export function setCredentials(c: Credentials, persist = true) {
  if (!store.save) throw new Error("GitHub details are set in the editor's .env file here.");
  const next = { repo: normalizeRepo(c.repo), token: c.token.trim() };
  if (persist) store.save(next);
  current = next;
}
