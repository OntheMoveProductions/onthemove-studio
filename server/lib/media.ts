import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import sharp from "sharp";
import { HTML_PAGES, TMP_DIR } from "../config.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { deleteSite, moveIntoSite, readSite, sitePath, siteExists, writeSite } from "./files.ts";
import { readPortfolio, slugify } from "./films.ts";

const POSTER_DIR = "assets/img/portfolio";
const VIDEO_DIR = "assets/video";
// GitHub Pages refuses files over 100 MB; stay well under it.
const MAX_VIDEO_BYTES = 90 * 1024 * 1024;

function ffmpegBinary(): string {
  try {
    const p = createRequire(import.meta.url)("ffmpeg-static") as string | null;
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return "ffmpeg";
}
const FFMPEG = ffmpegBinary();

const stamp = () => Date.now().toString(36);
const baseName = (hint: string) => slugify(path.parse(hint).name || hint, []);

// ---------------------------------------------------------------- images

export async function savePoster(tmpFile: string, hint: string): Promise<string> {
  const rel = `${POSTER_DIR}/${baseName(hint)}-${stamp()}.jpg`;
  try {
    const buf = await sharp(tmpFile)
      .rotate()
      .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 84, mozjpeg: true })
      .toBuffer();
    writeSite(rel, buf);
  } catch {
    throw badRequest("That file doesn't look like an image we can use (try JPG, PNG or WebP).");
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
  return rel;
}

export async function grabFrame(videoRel: string, seconds: number, hint: string): Promise<string> {
  if (!videoRel.startsWith(VIDEO_DIR + "/") || !siteExists(videoRel)) throw notFound("Video not found");
  const t = Math.max(0, Number(seconds) || 0);
  const png = await new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(FFMPEG, [
      "-hide_banner", "-loglevel", "error",
      "-ss", t.toFixed(3), "-i", sitePath(videoRel),
      "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    let err = "";
    proc.stdout.on("data", (c) => chunks.push(c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 && chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error(err || "No frame at that time"))));
  });
  const rel = `${POSTER_DIR}/${baseName(hint)}-frame-${stamp()}.jpg`;
  writeSite(rel, await sharp(png).resize({ width: 1920, withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toBuffer());
  return rel;
}

// ---------------------------------------------------------------- video jobs

export type Job = {
  id: string;
  phase: "encoding" | "shrinking" | "done" | "error";
  progress: number;
  output?: string;
  sizeBytes?: number;
  duration?: number;
  error?: string;
};

const jobs = new Map<string, Job>();
const listeners = new Map<string, Set<(job: Job) => void>>();

function emit(job: Job) {
  for (const fn of listeners.get(job.id) ?? []) fn({ ...job });
}

// Videos still being converted; quitting the app would lose them.
export function activeJobs() {
  return [...jobs.values()].filter((j) => j.phase === "encoding" || j.phase === "shrinking").length;
}

export function getJob(id: string) {
  return jobs.get(id);
}

export function subscribe(id: string, fn: (job: Job) => void) {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id)!.add(fn);
  return () => listeners.get(id)?.delete(fn);
}

export function startTranscode(tmpFile: string, hint: string): Job {
  const job: Job = { id: randomUUID(), phase: "encoding", progress: 0 };
  jobs.set(job.id, job);
  const outTmp = path.join(TMP_DIR, `${job.id}.mp4`);
  const rel = `${VIDEO_DIR}/${baseName(hint)}-${stamp()}.mp4`;

  (async () => {
    try {
      await encode(tmpFile, outTmp, job, null);
      let size = fs.statSync(outTmp).size;
      if (size > MAX_VIDEO_BYTES && job.duration) {
        // Second pass at a fixed bitrate that lands under the limit.
        job.phase = "shrinking";
        job.progress = 0;
        emit(job);
        const kbps = Math.floor(((MAX_VIDEO_BYTES * 0.92 * 8) / job.duration) / 1000) - 128;
        if (kbps < 300) throw new Error("This video is too long to host on GitHub Pages at a watchable quality. Trim it or host it on Vimeo/YouTube.");
        await encode(tmpFile, outTmp, job, kbps);
        size = fs.statSync(outTmp).size;
      }
      moveIntoSite(outTmp, rel);
      Object.assign(job, { phase: "done", progress: 1, output: rel, sizeBytes: size });
    } catch (err: any) {
      Object.assign(job, { phase: "error", error: err.message || "Encoding failed" });
      fs.rmSync(outTmp, { force: true });
    } finally {
      fs.rmSync(tmpFile, { force: true });
      emit(job);
      setTimeout(() => {
        jobs.delete(job.id);
        listeners.delete(job.id);
      }, 60 * 60 * 1000);
    }
  })();
  return job;
}

function encode(input: string, output: string, job: Job, videoKbps: number | null): Promise<void> {
  // Long side capped at 1920 so both landscape and vertical (Instagram) cuts fit.
  // Fits inside 1920×1920 without stretching. H.264 needs even dimensions,
  // and source files with an odd width or height (screen recordings, crops)
  // otherwise fail outright, hence force_divisible_by.
  const scale = "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,format=yuv420p";
  const rate = videoKbps
    ? ["-b:v", `${videoKbps}k`, "-maxrate", `${Math.round(videoKbps * 1.5)}k`, "-bufsize", `${videoKbps * 2}k`]
    : ["-crf", "22", "-maxrate", "6M", "-bufsize", "12M"];
  const args = [
    "-hide_banner", "-y", "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", scale,
    "-c:v", "libx264", "-preset", "medium", "-profile:v", "high", ...rate,
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats",
    output,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args);
    let stderr = "";
    proc.stderr.on("data", (c) => {
      stderr += c;
      if (!job.duration) {
        const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(stderr);
        if (m) job.duration = +m[1] * 3600 + +m[2] * 60 + +m[3];
      }
      if (stderr.length > 200_000) stderr = stderr.slice(-50_000);
    });
    let last = 0;
    proc.stdout.on("data", (c) => {
      const m = /out_time_us=(\d+)/.exec(String(c));
      if (m && job.duration) {
        job.progress = Math.min(0.99, Number(m[1]) / 1e6 / job.duration);
        if (Date.now() - last > 400) {
          last = Date.now();
          emit(job);
        }
      }
    });
    proc.on("error", (e) => reject(new Error(`Couldn't start ffmpeg: ${e.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else {
        // Keep the full ffmpeg output for diagnosis; the person only sees a summary.
        const log = path.join(TMP_DIR, "last-encode-error.log");
        fs.writeFileSync(log, `${new Date().toISOString()}\nffmpeg ${args.join(" ")}\n\n${stderr}`);
        console.error(`Video encoding failed; details in ${log}`);
        const line = stderr.trim().split("\n").filter((l) => !/^\s/.test(l)).pop() || "";
        reject(new Error(/Invalid data|could not find codec|moov atom/i.test(stderr) ? "That file isn't a video we can read." : `Encoding failed: ${line}`));
      }
    });
  });
}

// ---------------------------------------------------------------- library

export type MediaFile = { path: string; kind: "image" | "video"; bytes: number; modified: string; usedBy: string[] };

export function listMedia(): MediaFile[] {
  const films = readPortfolio().projects;
  const siteText = [...HTML_PAGES, "assets/css/style.css", "assets/js/main.js"].filter(siteExists).map(readSite).join("\n");
  const out: MediaFile[] = [];
  for (const [dir, kind] of [[POSTER_DIR, "image"], [VIDEO_DIR, "video"]] as const) {
    const abs = sitePath(dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      const rel = `${dir}/${name}`;
      const stat = fs.statSync(path.join(abs, name));
      if (!stat.isFile() || name.startsWith(".")) continue;
      const usedBy = films.filter((f) => f.poster === rel || f.video === rel).map((f) => f.title.en || f.title.cs || f.id);
      if (siteText.includes(name)) usedBy.push("Site design");
      out.push({ path: rel, kind, bytes: stat.size, modified: stat.mtime.toISOString(), usedBy });
    }
  }
  // Posters that live outside the portfolio folder (the original SERRA one).
  for (const f of films) {
    if (f.poster && !f.poster.startsWith(POSTER_DIR + "/") && siteExists(f.poster) && !out.some((m) => m.path === f.poster)) {
      const stat = fs.statSync(sitePath(f.poster));
      out.push({ path: f.poster, kind: "image", bytes: stat.size, modified: stat.mtime.toISOString(), usedBy: [f.title.en || f.id] });
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

export function deleteMedia(rel: string) {
  if (!rel.startsWith(POSTER_DIR + "/") && !rel.startsWith(VIDEO_DIR + "/")) throw badRequest("Only portfolio images and videos can be deleted here.");
  const file = listMedia().find((m) => m.path === rel);
  if (!file) throw notFound("File not found");
  if (file.usedBy.length) throw conflict(`Still used by ${file.usedBy.join(", ")}.`);
  deleteSite(rel);
}
