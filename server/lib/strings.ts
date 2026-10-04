import fs from "node:fs";
import { HTML_PAGES, type PageFile } from "../config.ts";
import { badRequest } from "./errors.ts";
import { readSite, sitePath, writeSite } from "./files.ts";
import { bumpVersion } from "./cacheBust.ts";

const FILE = "assets/js/i18n.js";
const BLOCK = /(\/\* STRINGS:BEGIN \*\/)([\s\S]*?)(\/\* STRINGS:END \*\/)/;

export type Lang = "cs" | "en";
export type Strings = Record<Lang, Record<string, string>>;

export function readStrings(): Strings {
  const m = BLOCK.exec(readSite(FILE));
  if (!m) throw new Error(`${FILE} is missing its /* STRINGS:BEGIN */ … /* STRINGS:END */ markers`);
  const data = JSON.parse(m[2]) as Strings;
  if (!data.cs || !data.en) throw new Error(`${FILE}: STRINGS must contain "cs" and "en"`);
  return data;
}

export function saveStrings(changes: Record<string, Partial<Record<Lang, string>>>): { version: number } {
  const current = readStrings();
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in current.cs)) throw badRequest(`Unknown text key: ${key}`);
    for (const lang of ["cs", "en"] as const) {
      const v = value[lang];
      if (v === undefined) continue;
      if (typeof v !== "string" || !v.trim()) throw badRequest(`"${key}" (${lang.toUpperCase()}) can't be empty`);
      current[lang][key] = v.trim();
    }
  }
  const text = readSite(FILE);
  const json = JSON.stringify(current, null, 2).replace(/\n/g, "\n  ");
  const next = text.replace(BLOCK, `$1 ${json} $3`);
  JSON.parse(BLOCK.exec(next)![2]);
  writeSite(FILE, next);
  return { version: bumpVersion("i18n.js") };
}

// ---- Where each key appears, so the list view can group text the way a
// person thinks about the site ("About page › Values") rather than by key.

export type Occurrence = { page: string; section: string; kind: "text" | "placeholder" | "aria" | "meta" };
export type TextGroup = { id: string; page: string; label: string; keys: string[] };

const ATTRS: [string, Occurrence["kind"]][] = [
  ["data-i18n", "text"],
  ["data-i18n-placeholder", "placeholder"],
  ["data-i18n-aria-label", "aria"],
];

const PAGE_LABEL: Record<PageFile, string> = {
  "index.html": "Home",
  "about.html": "About",
  "portfolio.html": "Work",
  "contact.html": "Contact",
};

export function pageLabel(p: PageFile) {
  return PAGE_LABEL[p];
}

// The four hand-built pages plus the generated ones that carry their own
// text: one film page stands in for all of them (they share the same
// labels), and the 404 page.
export function editablePages(): { file: string; label: string }[] {
  const pages: { file: string; label: string }[] = HTML_PAGES.map((file) => ({ file, label: pageLabel(file) }));
  const workDir = sitePath("work");
  const film = fs.existsSync(workDir) ? fs.readdirSync(workDir).find((n) => n.endsWith(".html")) : undefined;
  if (film) pages.push({ file: `work/${film}`, label: "Film page" });
  if (fs.existsSync(sitePath("404.html"))) pages.push({ file: "404.html", label: "Not found" });
  return pages;
}

export function buildIndex() {
  const strings = readStrings();
  const groups: TextGroup[] = [];
  const byId = new Map<string, TextGroup>();
  const seen = new Set<string>();
  const occurrences: Record<string, Occurrence[]> = {};

  const add = (groupId: string, page: TextGroup["page"], label: string, key: string, occ: Occurrence) => {
    (occurrences[key] ||= []).push(occ);
    if (seen.has(key)) return;
    seen.add(key);
    let g = byId.get(groupId);
    if (!g) {
      g = { id: groupId, page, label, keys: [] };
      byId.set(groupId, g);
      groups.push(g);
    }
    g.keys.push(key);
  };

  const pages = editablePages();
  for (const { file: page, label: pageName } of pages) {
    const html = readSite(page);
    const generated = !(HTML_PAGES as readonly string[]).includes(page);
    for (const attr of ["data-title-key", "data-desc-key"]) {
      const m = new RegExp(`${attr}="([^"]+)"`).exec(html);
      if (m) add(generated ? `${page}#all` : `${page}#meta`, page, generated ? pageName : "Browser tab & search results", m[1], { page, section: "meta", kind: "meta" });
    }

    // Walk tags in document order, tracking the current landmark/section.
    let section = "top";
    let sectionIndex = 0;
    // Anything before <header> (the skip link) belongs with the navigation.
    let sectionLabel = "Navigation";
    let sectionGroupId = "site#nav";
    let sectionPage: TextGroup["page"] = "site";
    let depth = 0;
    let sectionDepth = -1;
    const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
    const VOID = new Set(["img", "input", "br", "hr", "meta", "link", "source", "area", "col", "wbr"]);
    for (const m of html.matchAll(tagRe)) {
      const [, closing, rawName, attrs, selfClose] = m;
      const name = rawName.toLowerCase();
      if (name === "script" || name === "style") continue;
      if (closing) {
        depth--;
        if (depth < sectionDepth) {
          sectionDepth = -1;
          section = "between";
          sectionGroupId = `${page}#s${sectionIndex}-after`;
          sectionLabel = "Page content";
          sectionPage = page;
        }
        continue;
      }
      const isVoid = VOID.has(name) || selfClose === "/";
      // Only the site-wide header/footer; a film page has its own <header>.
      const landmark = name === "header" ? /site-header/.test(attrs) : name === "footer" ? /site-footer/.test(attrs) : name === "section" || name === "form";
      if (landmark) {
        if (sectionDepth === -1 || name !== "form") {
          sectionIndex++;
          sectionDepth = depth + (isVoid ? 0 : 1);
          if (name === "header") {
            [sectionGroupId, sectionLabel, sectionPage] = ["site#nav", "Navigation", "site"];
          } else if (name === "footer") {
            [sectionGroupId, sectionLabel, sectionPage] = ["site#footer", "Footer", "site"];
          } else {
            const cls = /class="([^"]*)"/.exec(attrs)?.[1] ?? "";
            sectionGroupId = `${page}#s${sectionIndex}`;
            sectionLabel = labelFromClass(cls, name);
            sectionPage = page;
          }
          section = sectionGroupId;
        }
      }
      for (const [attr, kind] of ATTRS) {
        const km = new RegExp(`\\s${attr}="([^"]+)"`).exec(attrs);
        if (!km) continue;
        // Generated pages get one group each: every film page shares these texts.
        if (generated && sectionPage !== "site") add(`${page}#all`, page, page.startsWith("work/") ? "Every film page" : pageName, km[1], { page, section, kind });
        else add(sectionGroupId, sectionPage, sectionLabel, km[1], { page, section, kind });
      }
      if (!isVoid) depth++;
    }
  }

  // Sections are labelled by their first heading's text where they have one.
  for (const g of groups) {
    if (!g.id.includes("#s")) continue;
    if (g.keys.some((k) => k.startsWith("form."))) g.label = "Contact form & details";
    else if (g.keys.some((k) => k.startsWith("marquee."))) g.label = "Scrolling ticker";
    else if (g.keys.some((k) => /\.bio\.p1$/.test(k))) g.label = "Bios";
    else if (g.keys.includes("hero.slogan")) g.label = "Hero";
    else {
      const headingKey = g.keys.find((k) => /\.(heading|title)$/.test(k));
      if (headingKey && strings.en[headingKey]) g.label = strings.en[headingKey];
    }
  }

  // Keys used only from JavaScript (form messages) or not at all.
  const jsText = ["assets/js/main.js", "assets/js/portfolio-render.js"]
    .filter((f) => fs.existsSync(sitePath(f)))
    .map(readSite)
    .join("\n");
  const scripted: string[] = [];
  const unused: string[] = [];
  // Film-page labels only appear when a film has that detail (a year, a
  // client, a next film), so they belong to the film pages either way.
  const filmPage = pages.find((p) => p.file.startsWith("work/"));
  for (const key of Object.keys(strings.cs)) {
    if (seen.has(key)) continue;
    if (key.startsWith("film.")) {
      const id = filmPage ? `${filmPage.file}#all` : "film#all";
      let g = groups.find((x) => x.id === id);
      if (!g) groups.push((g = { id, page: filmPage?.file ?? "film", label: "Every film page", keys: [] }));
      g.keys.push(key);
      continue;
    }
    const prefix = key.split(".").slice(0, 2).join(".");
    if (jsText.includes(`"${key}"`) || jsText.includes(`"${prefix}.`)) scripted.push(key);
    else unused.push(key);
  }
  if (scripted.length) groups.push({ id: "site#messages", page: "site", label: "Messages & button labels", keys: scripted });

  // Site-wide groups first, then pages in nav order.
  const order = (g: TextGroup) => (g.page === "site" ? -1 : pages.findIndex((p) => p.file === g.page));
  groups.sort((a, b) => order(a) - order(b));

  return { strings, groups, occurrences, unused };
}

function labelFromClass(cls: string, tag: string): string {
  if (/\bhero\b/.test(cls)) return "Hero";
  if (/page-hero/.test(cls)) return "Page intro";
  if (/contact-cta/.test(cls)) return "Call to action";
  if (tag === "form") return "Form";
  return "Section";
}
