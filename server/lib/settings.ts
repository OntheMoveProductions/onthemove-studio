import { deleteSite, readSite, siteExists, writeSite } from "./files.ts";
import { badRequest } from "./errors.ts";

const FILE = "assets/data/site.json";

export type SiteSettings = {
  // Public address of the site, e.g. "https://onthemove.cz/". Needed for
  // link previews, the sitemap and search results; empty until known.
  siteUrl: string;
  // Form backend (e.g. a Formspree URL). Empty = the form opens the
  // visitor's email app instead.
  formEndpoint: string;
  // Cloudflare Web Analytics token (cookieless). Empty = no analytics.
  analyticsToken: string;
};

const EMPTY: SiteSettings = { siteUrl: "", formEndpoint: "", analyticsToken: "" };

export function readSettings(): SiteSettings {
  if (!siteExists(FILE)) return { ...EMPTY };
  try {
    return { ...EMPTY, ...JSON.parse(readSite(FILE)) };
  } catch {
    return { ...EMPTY };
  }
}

export function normalizeUrl(url: string): string {
  const u = url.trim();
  if (!u) return "";
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
  } catch {
    throw badRequest("That doesn't look like a web address.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw badRequest("Use an http(s) address.");
  return parsed.origin + parsed.pathname.replace(/\/?$/, "/");
}

export function saveSettings(input: Partial<SiteSettings>): SiteSettings {
  const next = { ...readSettings() };
  if (input.siteUrl !== undefined) next.siteUrl = normalizeUrl(String(input.siteUrl));
  if (input.formEndpoint !== undefined) {
    const e = String(input.formEndpoint).trim();
    if (e && !/^https:\/\/[^\s]+$/i.test(e)) throw badRequest("The form address must start with https://");
    next.formEndpoint = e;
  }
  if (input.analyticsToken !== undefined) {
    // Accepts the bare token or the whole snippet Cloudflare shows.
    const raw = String(input.analyticsToken).trim();
    const t = /"token"\s*:\s*"([^"]+)"/.exec(raw)?.[1] ?? raw;
    if (t && !/^[A-Za-z0-9]{16,64}$/.test(t)) throw badRequest("That doesn't look like a Cloudflare analytics token.");
    next.analyticsToken = t;
  }
  writeSite(FILE, JSON.stringify(next, null, 2) + "\n");
  if (input.siteUrl !== undefined) writeCname(next.siteUrl);
  return next;
}

// GitHub Pages takes its custom domain from a CNAME file in the repository.
// Writing it here (instead of in GitHub's settings page, which commits the
// file on github.com) keeps this computer's copy the only source of changes.
function writeCname(siteUrl: string) {
  const host = siteUrl ? new URL(siteUrl).hostname : "";
  const custom = host && !host.endsWith(".github.io") ? host : "";
  if (custom) {
    if (!siteExists("CNAME") || readSite("CNAME").trim() !== custom) writeSite("CNAME", custom + "\n", { backup: false });
  } else if (siteExists("CNAME")) {
    deleteSite("CNAME");
  }
}
