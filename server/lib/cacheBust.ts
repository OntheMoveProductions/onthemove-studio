import { HTML_PAGES } from "../config.ts";
import { readSite, writeSite } from "./files.ts";

// Every page loads assets as `name?v=N`; after rewriting an asset the number
// goes up on all four pages together so browsers fetch the new file.
const versionRe = (asset: string) => {
  const esc = asset.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`(${esc}\\?v=)(\\d+)`, "g");
};

// The highest ?v= number an HTML text uses for this asset (0 if none).
export function versionIn(html: string, asset: string): number {
  return Math.max(0, ...[...html.matchAll(versionRe(asset))].map((m) => Number(m[2])));
}

// atLeast: when combining two computers' work, the new number must be above
// what either side ever published.
export function bumpVersion(asset: string, atLeast = 0): number {
  const re = versionRe(asset);
  const texts = new Map<string, string>();
  const versions = new Set<number>();
  for (const page of HTML_PAGES) {
    const text = readSite(page);
    for (const m of text.matchAll(re)) versions.add(Number(m[2]));
    texts.set(page, text);
  }
  if (versions.size === 0) return 0;
  const next = Math.max(Math.max(...versions) + 1, atLeast);
  for (const [page, text] of texts) {
    const updated = text.replace(re, `$1${next}`);
    if (updated !== text) writeSite(page, updated);
  }
  return next;
}
