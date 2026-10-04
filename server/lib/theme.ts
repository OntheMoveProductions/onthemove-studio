import { badRequest } from "./errors.ts";
import { readSite, writeSite } from "./files.ts";
import { bumpVersion } from "./cacheBust.ts";
import { committedFile } from "./publish.ts";

const FILE = "assets/css/style.css";

export const TOKENS = [
  { name: "--cream-1", label: "Cream", role: "Light page background, text on dark" },
  { name: "--cream-2", label: "Peach cream", role: "Alternate light background" },
  { name: "--accent", label: "Turquoise", role: "Accent on dark backgrounds, highlights" },
  { name: "--accent-dim", label: "Turquoise (hover)", role: "Hover state for accent elements" },
  { name: "--accent-dim-onlight", label: "Turquoise on light", role: "Accent text on cream backgrounds" },
  { name: "--wine", label: "Wine", role: "Team section background" },
  { name: "--black", label: "Black", role: "Dark page background, body text on light" },
  { name: "--black-2", label: "Black, raised", role: "Cards on dark backgrounds" },
  { name: "--black-3", label: "Black, raised twice", role: "Nested surfaces on dark" },
] as const;

export type TokenName = (typeof TOKENS)[number]["name"];
export type Palette = Record<TokenName, string>;

// Text/background pairs the site actually renders, so contrast is checked
// where it matters rather than for every combination.
export const PAIRS: { fg: TokenName; bg: TokenName; where: string; large?: boolean }[] = [
  { fg: "--black", bg: "--cream-1", where: "Body text on cream sections" },
  { fg: "--black", bg: "--cream-2", where: "Body text on peach sections" },
  { fg: "--cream-1", bg: "--black", where: "Text on black sections" },
  { fg: "--cream-1", bg: "--wine", where: "Text on the wine team section" },
  { fg: "--cream-1", bg: "--black-2", where: "Text on dark cards" },
  { fg: "--accent", bg: "--black", where: "Turquoise labels on black" },
  { fg: "--accent-dim-onlight", bg: "--cream-1", where: "Turquoise text on cream" },
  { fg: "--black", bg: "--accent", where: "Button text on turquoise", large: true },
];

const HEX = /^#[0-9a-f]{6}$/i;
const decl = (name: string) =>
  new RegExp(`(${name.replace(/-/g, "\\-")}\\s*:\\s*)(#[0-9A-Fa-f]{3,8})(\\s*;)`);

function parse(css: string): Palette {
  const out = {} as Palette;
  for (const t of TOKENS) {
    const m = decl(t.name).exec(css);
    if (!m) throw new Error(`style.css is missing ${t.name}`);
    out[t.name] = expand(m[2]);
  }
  return out;
}

function expand(hex: string) {
  const h = hex.toLowerCase();
  return h.length === 4 ? "#" + [...h.slice(1)].map((c) => c + c).join("") : h.slice(0, 7);
}

// Throws if style.css is missing a token; run at startup as a sanity check.
export function checkTheme() {
  parse(readSite(FILE));
}

export async function readTheme() {
  const current = parse(readSite(FILE));
  let published: Palette | null = null;
  const committed = await committedFile(FILE);
  if (committed) {
    try {
      published = parse(committed);
    } catch {
      published = null;
    }
  }
  return { tokens: TOKENS, pairs: PAIRS, current, published };
}

// Replaces only the hex value on each declaration line, so the comments that
// sit beside several tokens in style.css survive.
export function saveTheme(updates: Partial<Palette>) {
  let css = readSite(FILE);
  for (const [name, value] of Object.entries(updates)) {
    if (!TOKENS.some((t) => t.name === name)) throw badRequest(`${name} isn't an editable color`);
    if (!HEX.test(String(value))) throw badRequest(`${value} isn't a valid color (use #RRGGBB)`);
    const re = decl(name);
    const m = re.exec(css);
    if (!m) throw new Error(`style.css is missing ${name}`);
    // Keep the file's existing uppercase/lowercase style.
    const v = m[2] === m[2].toUpperCase() ? String(value).toUpperCase() : String(value).toLowerCase();
    css = css.replace(re, `$1${v}$3`);
  }
  writeSite(FILE, css);
  return { version: bumpVersion("style.css"), current: parse(css) };
}
