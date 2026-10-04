export type Lang = "cs" | "en";
export type Bilingual = { cs: string; en: string };
export type Category = { id: string; name: Bilingual };
export type FilmStatus = "published" | "draft";
export type Film = {
  id: string;
  status: FilmStatus;
  featured: boolean;
  categoryId: string;
  title: Bilingual;
  description: Bilingual;
  year: number | null;
  client: string;
  poster: string;
  video: string;
  updatedAt: string;
};
export type Portfolio = { categories: Category[]; projects: Film[] };
export type FilmInput = Omit<Film, "id" | "updatedAt">;

export type MediaFile = { path: string; kind: "image" | "video"; bytes: number; modified: string; usedBy: string[] };
export type Job = {
  id: string;
  phase: "encoding" | "shrinking" | "done" | "error";
  progress: number;
  output?: string;
  sizeBytes?: number;
  duration?: number;
  error?: string;
};

export type PageFile = string;
export type PageInfo = { file: PageFile; label: string };
export type TextGroup = { id: string; page: PageFile | "site"; label: string; keys: string[] };
export type SiteSettings = { siteUrl: string; formEndpoint: string; analyticsToken: string };
export type Occurrence = { page: PageFile; section: string; kind: "text" | "placeholder" | "aria" | "meta" };
export type StringsIndex = {
  strings: Record<Lang, Record<string, string>>;
  groups: TextGroup[];
  occurrences: Record<string, Occurrence[]>;
  unused: string[];
};

export type Token = { name: string; label: string; role: string };
export type Pair = { fg: string; bg: string; where: string; large?: boolean };
export type Theme = { tokens: Token[]; pairs: Pair[]; current: Record<string, string>; published: Record<string, string> | null };

export type PublishItem = { area: string; text: string };
export type PublishStatus =
  | { state: "not-set-up"; siteRoot: string; canConnect: boolean; pagesProblem?: string | null }
  | {
      state: "ready" | "no-remote";
      siteRoot: string;
      canConnect: boolean;
      pagesProblem?: string | null;
      merged?: string | null;
      remote: string | null;
      branch: string;
      liveUrl: string | null;
      lastPublishedAt: string | null;
      unpushed: number;
      changes: { file: string; state: string }[];
      summary: PublishItem[];
      pending: number;
    };

export type SyncResult = { state: "up-to-date" | "updated" | "merged" | "offline" | "skipped" | "conflict"; message?: string; notes?: string[] };
export type Session = { authRequired: boolean; authed: boolean; setupNeeded?: boolean; sync?: SyncResult | null };
export type SetupInfo = {
  mode: "env" | "app";
  siteReady: boolean;
  siteRoot: string;
  repo: string;
  hasToken: boolean;
  clone: { running: boolean; fraction: number; phase: string; error?: string; done?: boolean };
};

export type AppUpdate = {
  supported: boolean;
  current?: string;
  latest?: string | null;
  available?: boolean;
  phase?: "idle" | "checking" | "downloading" | "installing" | "error";
  progress?: number;
  error?: string | null;
};

export type GithubConnection =
  | { state: "not-configured" }
  | { state: "ok"; repo: string; pagesUrl: string | null; pagesEnabled: boolean }
  | { state: "bad-token" | "no-access" | "offline"; repo: string; message: string };

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: any) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.details);
  return data as T;
}

const get = <T>(url: string) => request<T>("GET", url);
const send = <T>(method: string, url: string, body?: unknown) => request<T>(method, url, body ?? {});

export const api = {
  session: () => get<Session>("/api/session"),
  setup: () => get<SetupInfo>("/api/setup"),
  saveSetup: (repo: string, token: string) => send<{ ok: true; repo: string }>("POST", "/api/setup", { repo, token }),
  sync: () => send<SyncResult>("POST", "/api/publish/sync"),
  appUpdate: () => get<AppUpdate>("/api/app-update"),
  installUpdate: () => send<{ ok: true }>("POST", "/api/app-update/install"),
  login: (password: string) => send("POST", "/api/login", { password }),
  logout: () => send("POST", "/api/logout"),

  films: () => get<Portfolio>("/api/films"),
  film: (id: string) => get<Film>(`/api/films/${encodeURIComponent(id)}`),
  createFilm: (input: Partial<FilmInput>) => send<Film>("POST", "/api/films", input),
  updateFilm: (id: string, input: Partial<FilmInput>) => send<Film>("PUT", `/api/films/${encodeURIComponent(id)}`, input),
  deleteFilm: (id: string) => send("DELETE", `/api/films/${encodeURIComponent(id)}`),
  reorderFilms: (order: string[]) => send<Film[]>("POST", "/api/films/reorder", { order }),

  createCategory: (name: Bilingual) => send<Category>("POST", "/api/categories", { name }),
  updateCategory: (id: string, name: Bilingual) => send<Category>("PUT", `/api/categories/${id}`, { name }),
  deleteCategory: (id: string) => send("DELETE", `/api/categories/${id}`),

  pages: () => get<PageInfo[]>("/api/pages"),
  settings: () => get<SiteSettings>("/api/settings"),
  saveSettings: (s: Partial<SiteSettings>) => send<SiteSettings>("PUT", "/api/settings", s),

  strings: () => get<StringsIndex>("/api/strings"),
  saveStrings: (changes: Record<string, Partial<Bilingual>>) => send<{ version: number }>("PUT", "/api/strings", { changes }),

  theme: () => get<Theme>("/api/theme"),
  saveTheme: (updates: Record<string, string>) => send<{ current: Record<string, string> }>("PUT", "/api/theme", { updates }),

  media: () => get<MediaFile[]>("/api/media"),
  deleteMedia: (path: string) => send("DELETE", `/api/media?path=${encodeURIComponent(path)}`),
  grabFrame: (video: string, time: number, hint: string) => send<{ path: string }>("POST", "/api/media/frame", { video, time, hint }),

  publishStatus: () => get<PublishStatus>("/api/publish"),
  publish: (message?: string) => send<PublishStatus>("POST", "/api/publish", { message }),
  github: (refresh = false) => get<GithubConnection>(`/api/publish/github${refresh ? "?refresh=1" : ""}`),
  connect: () => send<PublishStatus>("POST", "/api/publish/connect"),
};

// XHR rather than fetch: fetch can't report upload progress, and a film
// master can be several gigabytes.
export function uploadFile<T>(url: string, file: File, hint: string, onProgress: (fraction: number) => void) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    const form = new FormData();
    form.append("hint", hint);
    form.append("file", file);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, data?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, "The upload was interrupted. Is the editor still running?"));
    xhr.onabort = () => reject(new ApiError(0, "Upload cancelled."));
    xhr.open("POST", url);
    xhr.send(form);
  });
  return { promise, cancel: () => xhr.abort() };
}

export function watchJob(id: string, onUpdate: (job: Job) => void): () => void {
  const source = new EventSource(`/api/media/jobs/${id}/events`);
  source.onmessage = (e) => {
    const job = JSON.parse(e.data) as Job;
    onUpdate(job);
    if (job.phase === "done" || job.phase === "error") source.close();
  };
  source.onerror = () => {
    // The stream closes normally once the job finishes; only report a drop
    // if we never saw the end.
    source.close();
  };
  return () => source.close();
}

export const previewUrl = (sitePath: string) => (sitePath ? `/preview/${sitePath}` : "");
