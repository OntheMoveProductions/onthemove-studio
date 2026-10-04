// Combining edits from two computers (three-way: the last version both had,
// this computer's, and GitHub's). Works on the things people edit through the
// editor, not on lines of text: films and categories by id, texts by key and
// language, colors by name, settings by field. When both sides changed the
// very same thing, this computer's version wins and a note says so.

export type Content = Buffer | null; // null = file absent

const GENERATED = /^((index|about|portfolio|contact|404)\.html|work\/[^/]+\.html|sitemap\.xml|robots\.txt)$/;
export const isGenerated = (path: string) => GENERATED.test(path);

const same = (a: Content, b: Content) => (a === null || b === null ? a === b : a.equals(b));
const text = (c: Content) => (c ? c.toString("utf8") : null);
const json = (c: Content) => {
  try {
    return c ? JSON.parse(c.toString("utf8")) : null;
  } catch {
    return undefined;
  }
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Three-way pick for one value. "ours" wins a real conflict.
function pick<T>(b: T, o: T, t: T, onConflict: () => void): T {
  if (eq(o, t)) return o;
  if (eq(o, b)) return t;
  if (eq(t, b)) return o;
  onConflict();
  return o;
}

function mergeRecord(b: any, o: any, t: any, label: string, notes: string[], skip: string[] = []) {
  b ??= {};
  o ??= {};
  t ??= {};
  const out: any = {};
  for (const k of new Set([...Object.keys(t), ...Object.keys(o)])) {
    if (skip.includes(k)) continue;
    const v = pick(b[k], o[k], t[k], () => notes.push(`${label}: both computers changed “${k}”; kept this computer's version.`));
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Lists of objects with an id (films, categories), keeping order.
function mergeById(b: any[] = [], o: any[] = [], t: any[] = [], name: (x: any) => string, kind: string, notes: string[]) {
  const byId = (list: any[]) => new Map(list.map((x) => [x.id, x]));
  const B = byId(b), O = byId(o), T = byId(t);
  const result = new Map<string, any>();
  for (const id of new Set([...T.keys(), ...O.keys(), ...B.keys()])) {
    const bv = B.get(id), ov = O.get(id), tv = T.get(id);
    if (!ov && !tv) continue;
    if (!ov || !tv) {
      const kept = ov ?? tv;
      // Deleted on one side: stays deleted unless the other side changed it since.
      if (bv && eq(kept, bv)) continue;
      if (bv) notes.push(`${kind} “${name(kept)}” was deleted on one computer and edited on the other; it was kept.`);
      result.set(id, kept);
      continue;
    }
    const merged = mergeRecord(bv, ov, tv, `${kind} “${name(ov)}”`, notes, ["updatedAt"]);
    if ("updatedAt" in ov || "updatedAt" in tv) merged.updatedAt = [ov.updatedAt, tv.updatedAt].filter(Boolean).sort().pop();
    result.set(id, merged);
  }
  // Order: whichever side rearranged wins (this computer if both did); new items keep their place.
  const ids = (l: any[]) => l.map((x) => x.id).filter((id) => result.has(id));
  const order = !eq(ids(o), ids(b)) ? ids(o) : ids(t);
  const final = [...order, ...[...result.keys()].filter((id) => !order.includes(id))];
  return final.map((id) => result.get(id));
}

function mergePortfolio(b: Content, o: Content, t: Content, notes: string[]): Buffer | null {
  const [B, O, T] = [json(b) ?? {}, json(o), json(t)];
  if (!O || !T) return null;
  const films = mergeById(B.projects, O.projects, T.projects, (f) => f.title?.en || f.title?.cs || f.id, "Film", notes);
  // Exactly one homepage film: keep this computer's choice if it changed it.
  const featured = films.filter((f) => f.featured);
  if (featured.length > 1) {
    const ours = (O.projects ?? []).find((f: any) => f.featured)?.id;
    const keep = featured.find((f) => f.id === ours) ?? featured[0];
    for (const f of films) f.featured = f === keep;
  }
  const merged = {
    ...T,
    categories: mergeById(B.categories, O.categories, T.categories, (c) => c.name?.en || c.id, "Category", notes),
    projects: films,
  };
  return Buffer.from(JSON.stringify(merged, null, 2) + "\n");
}

const STRINGS = /(\/\* STRINGS:BEGIN \*\/)([\s\S]*?)(\/\* STRINGS:END \*\/)/;

function mergeStrings(b: Content, o: Content, t: Content, notes: string[]): Buffer | null {
  const parse = (c: Content) => {
    const m = c && STRINGS.exec(text(c)!);
    try {
      return m ? JSON.parse(m[2]) : null;
    } catch {
      return null;
    }
  };
  const [B, O, T] = [parse(b) ?? { cs: {}, en: {} }, parse(o), parse(t)];
  if (!O || !T) return null;
  const merged: any = {};
  for (const lang of ["cs", "en"]) {
    merged[lang] = {};
    for (const key of new Set([...Object.keys(T[lang] ?? {}), ...Object.keys(O[lang] ?? {})])) {
      const v = pick(B[lang]?.[key], O[lang]?.[key], T[lang]?.[key], () =>
        notes.push(`Text “${key}” (${lang.toUpperCase()}) was changed on both computers; kept this computer's version.`),
      );
      if (v !== undefined) merged[lang][key] = v;
    }
  }
  // Same layout the editor writes (see strings.ts).
  const block = JSON.stringify(merged, null, 2).replace(/\n/g, "\n  ");
  return Buffer.from(text(t)!.replace(STRINGS, `$1 ${block} $3`));
}

const TOKEN = /(--[\w-]+)(\s*:\s*)(#[0-9a-fA-F]{3,8})/g;

function mergeCss(b: Content, o: Content, t: Content, notes: string[]): Buffer | null {
  if (!o || !t) return null;
  const tokens = (c: Content) => new Map([...(text(c) ?? "").matchAll(TOKEN)].map((m) => [m[1], m[3].toLowerCase()]));
  const B = tokens(b), O = tokens(o);
  const out = text(t)!.replace(TOKEN, (whole, name, sep, value) => {
    const v = pick(B.get(name), O.get(name), value.toLowerCase(), () => notes.push(`Color ${name} was changed on both computers; kept this computer's version.`));
    return v ? `${name}${sep}${value === value.toUpperCase() ? v.toUpperCase() : v}` : whole;
  });
  return Buffer.from(out);
}

function mergeFlatJson(b: Content, o: Content, t: Content, label: string, notes: string[]): Buffer | null {
  const [B, O, T] = [json(b) ?? {}, json(o), json(t)];
  if (!O || !T) return null;
  return Buffer.from(JSON.stringify(mergeRecord(B, O, T, label, notes), null, 2) + "\n");
}

// Returns the merged content (null = delete the file).
export function mergeFile(path: string, b: Content, o: Content, t: Content, notes: string[]): Content {
  if (same(o, t)) return o;
  if (same(o, b)) return t;
  if (same(t, b)) return o;
  if (isGenerated(path)) return t; // rebuilt from the merged content afterwards
  if (o && t) {
    const merged =
      path === "assets/data/portfolio.json"
        ? mergePortfolio(b, o, t, notes)
        : path === "assets/js/i18n.js"
          ? mergeStrings(b, o, t, notes)
          : path === "assets/css/style.css"
            ? mergeCss(b, o, t, notes)
            : path === "assets/data/site.json"
              ? mergeFlatJson(b, o, t, "Site settings", notes)
              : null;
    if (merged) return merged;
  }
  notes.push(`${path} was changed on both computers; kept this computer's version.`);
  return o;
}
