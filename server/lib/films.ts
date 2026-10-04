import { badRequest, conflict, notFound } from "./errors.ts";
import { readSite, siteExists, writeSite } from "./files.ts";

const FILE = "assets/data/portfolio.json";

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
export type Portfolio = { version: 2; categories: Category[]; projects: Film[] };

const bi = (v: any): Bilingual => ({ cs: String(v?.cs ?? "").trim(), en: String(v?.en ?? "").trim() });

function normalizeFilm(raw: any): Film {
  return {
    id: String(raw.id),
    status: raw.status === "draft" ? "draft" : "published",
    featured: !!raw.featured,
    categoryId: String(raw.categoryId ?? ""),
    title: bi(raw.title),
    description: bi(raw.description),
    year: raw.year ? Number(raw.year) : null,
    client: String(raw.client ?? "").trim(),
    poster: String(raw.poster ?? ""),
    video: String(raw.video ?? ""),
    updatedAt: String(raw.updatedAt ?? new Date(0).toISOString()),
  };
}

export function readPortfolio(): Portfolio {
  if (!siteExists(FILE)) return { version: 2, categories: [], projects: [] };
  const raw = JSON.parse(readSite(FILE));
  return {
    version: 2,
    categories: (raw.categories ?? []).map((c: any) => ({ id: String(c.id), name: bi(c.name) })),
    projects: (raw.projects ?? []).map(normalizeFilm),
  };
}

function write(data: Portfolio) {
  // The homepage teaser shows the featured film, so exactly one is featured
  // whenever any film exists; prefer a published one.
  const featured = data.projects.filter((p) => p.featured);
  if (data.projects.length && featured.length !== 1) {
    const keep =
      featured.find((p) => p.status === "published") ??
      featured[0] ??
      data.projects.find((p) => p.status === "published") ??
      data.projects[0];
    for (const p of data.projects) p.featured = p === keep;
  }
  writeSite(FILE, JSON.stringify(data, null, 2) + "\n");
}

export function slugify(text: string, taken: string[]): string {
  const base =
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "film";
  let slug = base;
  for (let n = 2; taken.includes(slug); n++) slug = `${base}-${n}`;
  return slug;
}

// Drafts may be incomplete; a published film must be presentable.
function validate(film: Film, data: Portfolio) {
  const problems: string[] = [];
  if (!film.title.cs && !film.title.en) problems.push("Add a title.");
  if (film.year !== null && (!Number.isInteger(film.year) || film.year < 1900 || film.year > 2100))
    problems.push("Year should be a four-digit year.");
  if (film.categoryId && !data.categories.some((c) => c.id === film.categoryId))
    problems.push("That category no longer exists.");
  if (film.status === "published") {
    if (!film.title.cs || !film.title.en) problems.push("A published film needs a title in both languages.");
    if (!film.categoryId) problems.push("A published film needs a category.");
    if (!film.poster) problems.push("A published film needs a poster.");
  }
  if (problems.length) throw badRequest(problems.join(" "), { problems });
}

type FilmInput = Partial<Omit<Film, "id" | "updatedAt">>;

function applyInput(film: Film, input: FilmInput): Film {
  return normalizeFilm({ ...film, ...input, id: film.id, updatedAt: new Date().toISOString() });
}

export function listFilms() {
  return readPortfolio();
}

export function getFilm(id: string): Film {
  const film = readPortfolio().projects.find((p) => p.id === id);
  if (!film) throw notFound(`No film with id "${id}"`);
  return film;
}

export function createFilm(input: FilmInput): Film {
  const data = readPortfolio();
  const blank = normalizeFilm({ id: "", status: "draft" });
  const draft = applyInput(blank, input);
  draft.id = slugify(draft.title.en || draft.title.cs, data.projects.map((p) => p.id));
  validate(draft, data);
  if (draft.featured) data.projects.forEach((p) => (p.featured = false));
  data.projects.unshift(draft);
  write(data);
  return data.projects.find((p) => p.id === draft.id)!;
}

export function updateFilm(id: string, input: FilmInput): Film {
  const data = readPortfolio();
  const idx = data.projects.findIndex((p) => p.id === id);
  if (idx === -1) throw notFound(`No film with id "${id}"`);
  const next = applyInput(data.projects[idx], input);
  validate(next, data);
  if (next.featured) data.projects.forEach((p) => (p.featured = false));
  data.projects[idx] = next;
  write(data);
  return data.projects[idx];
}

export function deleteFilm(id: string) {
  const data = readPortfolio();
  if (!data.projects.some((p) => p.id === id)) throw notFound(`No film with id "${id}"`);
  data.projects = data.projects.filter((p) => p.id !== id);
  write(data);
}

export function reorderFilms(order: string[]) {
  const data = readPortfolio();
  const ids = data.projects.map((p) => p.id);
  if (order.length !== ids.length || !ids.every((id) => order.includes(id)))
    throw badRequest("Reorder list doesn't match the current films — reload and try again.");
  data.projects = order.map((id) => data.projects.find((p) => p.id === id)!);
  write(data);
  return data.projects;
}

export function createCategory(name: Bilingual): Category {
  const data = readPortfolio();
  const n = bi(name);
  if (!n.cs || !n.en) throw badRequest("Give the category a name in both languages.");
  const cat = { id: slugify(n.cs, data.categories.map((c) => c.id)), name: n };
  data.categories.push(cat);
  write(data);
  return cat;
}

export function updateCategory(id: string, name: Bilingual): Category {
  const data = readPortfolio();
  const cat = data.categories.find((c) => c.id === id);
  if (!cat) throw notFound(`No category "${id}"`);
  const n = bi(name);
  if (!n.cs || !n.en) throw badRequest("Give the category a name in both languages.");
  cat.name = n;
  write(data);
  return cat;
}

export function deleteCategory(id: string) {
  const data = readPortfolio();
  const users = data.projects.filter((p) => p.categoryId === id);
  if (users.length) {
    const names = users.map((p) => p.title.en || p.title.cs);
    throw conflict(`Still used by: ${names.join(", ")}. Move those films to another category first.`, { films: names });
  }
  data.categories = data.categories.filter((c) => c.id !== id);
  write(data);
}
