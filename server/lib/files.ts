import fs from "node:fs";
import path from "node:path";
import { BACKUP_DIR, SITE_ROOT } from "../config.ts";

export function sitePath(rel: string): string {
  const resolved = path.resolve(SITE_ROOT, rel);
  if (resolved !== SITE_ROOT && !resolved.startsWith(SITE_ROOT + path.sep)) {
    throw new Error(`Refusing to touch a path outside the site folder: ${rel}`);
  }
  return resolved;
}

export const siteExists = (rel: string) => fs.existsSync(sitePath(rel));
export const readSite = (rel: string) => fs.readFileSync(sitePath(rel), "utf8");

export function backup(rel: string): void {
  const abs = sitePath(rel);
  if (!fs.existsSync(abs)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(abs, path.join(BACKUP_DIR, `${rel.replace(/[\\/]/g, "_")}.${stamp}`));
}

// Generated files (film pages, sitemap) skip the backup: they're rebuilt
// from other files and would only fill the backups folder with noise.
export function writeSite(rel: string, content: string | Buffer, opts: { backup?: boolean } = {}): void {
  const abs = sitePath(rel);
  if (opts.backup !== false) backup(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, abs);
}

// Moves a finished file (upload, transcode output) into the site. rename can
// fail across drives, so fall back to copy + delete.
export function moveIntoSite(src: string, rel: string): void {
  const abs = sitePath(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    fs.renameSync(src, abs);
  } catch {
    fs.copyFileSync(src, abs);
    fs.rmSync(src, { force: true });
  }
}

export function deleteSite(rel: string): void {
  backup(rel);
  fs.rmSync(sitePath(rel), { force: true });
}
