import crypto from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import multer from "multer";
import { ADMIN_PASSWORD, DIST_DIR, SESSION_SECRET, SITE_ROOT, TMP_DIR } from "./config.ts";
import { HttpError, badRequest } from "./lib/errors.ts";
import * as films from "./lib/films.ts";
import * as media from "./lib/media.ts";
import { cloneSite, connect, isBusy as publishBusy, publish, publishStatus, sync, type SyncResult } from "./lib/publish.ts";
import { checkConnection, githubConfigured, resetConnectionCache } from "./lib/github.ts";
import { credentialStoreKind, getRepo, getToken, setCredentials, useCredentialStore, type CredentialStore } from "./lib/credentials.ts";
import { buildIndex, editablePages, readStrings, saveStrings } from "./lib/strings.ts";
import { checkTheme, readTheme, saveTheme } from "./lib/theme.ts";
import { readSettings, saveSettings } from "./lib/settings.ts";
import { regenerate } from "./lib/site-gen.ts";

declare module "express-session" {
  interface SessionData {
    authed?: boolean;
  }
}

// Provided by the Mac app (electron/updater.ts); absent in the browser editor.
export type AppUpdater = { status(): unknown; check(): Promise<unknown>; install(): Promise<void> };
export type ServerOptions = { port: number; host: string; credentialStore?: CredentialStore; updater?: AppUpdater };

// The site folder exists on this computer (the Mac app downloads it on first run).
const siteReady = () => fs.existsSync(path.join(SITE_ROOT, "index.html"));

// Refuse to work on a broken site rather than failing on someone's first save.
function checkSite() {
  readStrings();
  checkTheme();
  films.readPortfolio();
  regenerate();
}

let lastSync: SyncResult | null = null;
function syncInBackground() {
  if (!siteReady() || !githubConfigured()) return;
  sync().then(
    (r) => {
      lastSync = r;
      if (r.state === "updated") regenerate();
    },
    () => {},
  );
}

type CloneProgress = { running: boolean; fraction: number; phase: string; error?: string; done?: boolean };
let cloneProgress: CloneProgress = { running: false, fraction: 0, phase: "" };

// Something is still being written; quitting now would lose it.
export const isBusy = () => publishBusy() || media.activeJobs() > 0 || cloneProgress.running;

export function startServer(opts: ServerOptions): Promise<{ port: number; close: () => void }> {
  if (opts.credentialStore) useCredentialStore(opts.credentialStore);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  if (siteReady()) checkSite();
  syncInBackground();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(
    session({
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax", maxAge: 14 * 24 * 3600 * 1000 },
    }),
  );

  const authRequired = !!ADMIN_PASSWORD;
  const isAuthed = (req: Request) => !authRequired || req.session.authed === true;

  function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (isAuthed(req)) return next();
    if (req.path.startsWith("/api/") || req.baseUrl.startsWith("/api")) return res.status(401).json({ error: "Please sign in." });
    res.status(401).send("Please sign in to the editor first.");
  }

  // ---------------------------------------------------------------- session

  const setupNeeded = () => !siteReady() || (credentialStoreKind() === "app" && !githubConfigured());

  app.get("/api/session", (req, res) => res.json({ authRequired, authed: isAuthed(req), setupNeeded: setupNeeded(), sync: lastSync }));

  app.post("/api/login", (req, res) => {
    const given = Buffer.from(String(req.body?.password ?? ""));
    const expected = Buffer.from(ADMIN_PASSWORD);
    const ok = authRequired && given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) return res.status(401).json({ error: "That password isn't right." });
    req.session.regenerate(() => {
      req.session.authed = true;
      res.json({ ok: true });
    });
  });

  app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));

  // ---------------------------------------------------------------- preview of the real site

  app.use(
    "/preview",
    requireAuth,
    express.static(SITE_ROOT, {
      etag: false,
      lastModified: false,
      setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
    }),
  );

  // ---------------------------------------------------------------- API

  const api = express.Router();
  api.use(requireAuth);

  const wrap =
    (fn: (req: Request, res: Response) => unknown) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await fn(req, res);
        if (result !== undefined && !res.headersSent) res.json(result);
      } catch (err) {
        next(err);
      }
    };

  const param = (req: Request, name: string) => String(req.params[name]);

  // ---- first-run setup (the Mac app). The key is never sent back to the browser.

  api.get(
    "/setup",
    wrap(() => ({ mode: credentialStoreKind(), siteReady: siteReady(), siteRoot: SITE_ROOT, repo: getRepo(), hasToken: !!getToken(), clone: cloneProgress })),
  );

  api.post(
    "/setup",
    wrap(async (req) => {
      if (credentialStoreKind() !== "app") throw badRequest("Here, GitHub details are set in the editor's .env file.");
      const repo = String(req.body?.repo ?? "");
      const token = String(req.body?.token ?? "") || getToken();
      const previous = { repo: getRepo(), token: getToken() };
      // Try the new details first; keep the old ones if GitHub refuses them.
      setCredentials({ repo, token }, false);
      resetConnectionCache();
      const conn = githubConfigured() ? await checkConnection(true) : null;
      if (!conn || conn.state !== "ok") {
        setCredentials(previous, false);
        resetConnectionCache();
        if (!conn) throw badRequest("Enter the repository as owner/name, and the key.");
        throw new HttpError(502, "message" in conn ? conn.message : "GitHub isn't reachable.");
      }
      setCredentials({ repo, token });
      if (!siteReady() && !cloneProgress.running) {
        cloneProgress = { running: true, fraction: 0, phase: "Connecting" };
        // git's own phase names ("Compressing objects 100%") describe GitHub's
        // side and sit at 100% while the actual download runs; show plain
        // words and a percentage only where it means something.
        const friendly = (phase: string, fraction: number) =>
          /Receiving/i.test(phase)
            ? { phase: "Downloading", fraction }
            : /Resolving|workdir|Updating|Analyzing/i.test(phase)
              ? { phase: "Unpacking", fraction }
              : { phase: "Downloading", fraction: 0 };
        cloneSite(SITE_ROOT, (fraction, phase) => (cloneProgress = { running: true, ...friendly(phase, fraction) })).then(
          () => {
            checkSite();
            cloneProgress = { running: false, fraction: 1, phase: "Done", done: true };
          },
          (err) => (cloneProgress = { running: false, fraction: 0, phase: "", error: err.message }),
        );
      }
      return { ok: true, repo: conn.repo };
    }),
  );

  // ---- app updates (Mac app only)
  api.get("/app-update", wrap(() => opts.updater?.status() ?? { supported: false }));
  api.post("/app-update/check", wrap(() => opts.updater?.check() ?? { supported: false }));
  api.post(
    "/app-update/install",
    wrap(async () => {
      if (!opts.updater) throw badRequest("Updates are installed through the Mac app.");
      await opts.updater.install();
      return { ok: true };
    }),
  );

  // Everything below needs the site folder.
  api.use((_req, res, next) => (siteReady() ? next() : res.status(409).json({ error: "The website hasn't been set up on this computer yet.", setup: true })));

  // Content changes also rebuild everything derived from them (film pages,
  // page titles and link previews, sitemap).
  const mutate = (fn: (req: Request, res: Response) => unknown) =>
    wrap(async (req, res) => {
      const result = await fn(req, res);
      regenerate();
      return result;
    });

  api.get("/pages", wrap(() => editablePages()));

  api.get("/films", wrap(() => films.listFilms()));
  api.get("/films/:id", wrap((req) => films.getFilm(param(req, "id"))));
  api.post("/films", mutate((req) => films.createFilm(req.body ?? {})));
  api.post("/films/reorder", mutate((req) => films.reorderFilms(req.body?.order ?? [])));
  api.put("/films/:id", mutate((req) => films.updateFilm(param(req, "id"), req.body ?? {})));
  api.delete("/films/:id", mutate((req) => (films.deleteFilm(param(req, "id")), { ok: true })));

  api.post("/categories", mutate((req) => films.createCategory(req.body?.name)));
  api.put("/categories/:id", mutate((req) => films.updateCategory(param(req, "id"), req.body?.name)));
  api.delete("/categories/:id", mutate((req) => (films.deleteCategory(param(req, "id")), { ok: true })));

  api.get("/strings", wrap(() => buildIndex()));
  api.put("/strings", mutate((req) => saveStrings(req.body?.changes ?? {})));

  api.get("/theme", wrap(() => readTheme()));
  api.put("/theme", mutate((req) => saveTheme(req.body?.updates ?? {})));

  const upload = (maxBytes: number) =>
    multer({
      storage: multer.diskStorage({
        destination: TMP_DIR,
        filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).slice(0, 10)}`),
      }),
      limits: { fileSize: maxBytes, files: 1 },
    }).single("file");

  api.get("/media", wrap(() => media.listMedia()));
  api.delete("/media", wrap((req) => (media.deleteMedia(String(req.query.path ?? "")), { ok: true })));

  api.post(
    "/media/poster",
    upload(60 * 1024 * 1024),
    wrap(async (req) => {
      if (!req.file) throw badRequest("No image received.");
      return { path: await media.savePoster(req.file.path, String(req.body?.hint || req.file.originalname)) };
    }),
  );

  api.post(
    "/media/frame",
    wrap(async (req) => ({ path: await media.grabFrame(String(req.body?.video ?? ""), Number(req.body?.time ?? 0), String(req.body?.hint ?? "poster")) })),
  );

  api.post(
    "/media/video",
    upload(20 * 1024 * 1024 * 1024),
    wrap((req) => {
      if (!req.file) throw badRequest("No video received.");
      return media.startTranscode(req.file.path, String(req.body?.hint || req.file.originalname));
    }),
  );

  api.get(
    "/media/jobs/:id",
    wrap((req) => media.getJob(param(req, "id")) ?? Promise.reject(new HttpError(404, "That encoding job has expired."))),
  );

  api.get("/media/jobs/:id/events", (req, res) => {
    const job = media.getJob(param(req, "id"));
    if (!job) return res.status(404).end();
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (j: media.Job) => res.write(`data: ${JSON.stringify(j)}\n\n`);
    send(job);
    if (job.phase === "done" || job.phase === "error") return res.end();
    const unsubscribe = media.subscribe(job.id, (j) => {
      send(j);
      if (j.phase === "done" || j.phase === "error") res.end();
    });
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  api.get("/settings", wrap(() => readSettings()));
  api.put("/settings", mutate((req) => saveSettings(req.body ?? {})));

  api.get("/publish", wrap(() => publishStatus()));
  api.post("/publish", wrap((req) => publish(req.body?.message)));
  api.get("/publish/github", wrap((req) => checkConnection(req.query.refresh === "1")));
  api.post("/publish/connect", wrap(() => connect()));
  api.post(
    "/publish/sync",
    wrap(async () => {
      lastSync = await sync();
      if (lastSync.state === "updated") regenerate();
      return lastSync;
    }),
  );

  app.use("/api", api);
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      return res.status(413).json({ error: err.code === "LIMIT_FILE_SIZE" ? "That file is too large." : err.message });
    }
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || "Something went wrong.", details: err.details });
  });

  // ---------------------------------------------------------------- the dashboard app

  if (fs.existsSync(path.join(DIST_DIR, "index.html"))) {
    app.use(express.static(DIST_DIR, { index: false }));
    app.get("/{*splat}", (_req, res) => res.sendFile(path.join(DIST_DIR, "index.html")));
  } else {
    app.get("/", (_req, res) =>
      res.status(503).send("The dashboard hasn't been built yet. Run <code>npm run build</code> in the editor folder."),
    );
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(opts.port, opts.host, () => {
      resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() });
    });
    server.on("error", reject);
  });
}
