import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EDITOR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envFile = path.join(EDITOR_ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const SITE_ROOT = path.resolve(process.env.SITE_ROOT || path.join(EDITOR_ROOT, "..", "site"));
// The Mac app keeps backups and temporary files in ~/Library/Application
// Support (OTM_DATA_DIR) and the dashboard inside the app (OTM_DIST_DIR).
export const DATA_DIR = path.resolve(process.env.OTM_DATA_DIR || EDITOR_ROOT);
export const BACKUP_DIR = path.join(DATA_DIR, "backups");
export const TMP_DIR = path.join(DATA_DIR, ".tmp");
export const DIST_DIR = path.resolve(process.env.OTM_DIST_DIR || path.join(EDITOR_ROOT, "dist"));

export const PORT = Number(process.env.PORT) || 4500;
// Bind to loopback unless explicitly told otherwise: with no password set,
// anyone who can reach the port can edit the site.
export const HOST = process.env.HOST || "127.0.0.1";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
export const SESSION_SECRET = process.env.SESSION_SECRET || "otm-local-" + EDITOR_ROOT;

export const HTML_PAGES =["index.html", "about.html", "portfolio.html", "contact.html"] as const;
export type PageFile = (typeof HTML_PAGES)[number];


