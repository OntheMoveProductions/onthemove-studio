import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, MousePointerClick, Rows3, Search, X } from "lucide-react";
import { api, type Lang, type PageFile, type PageInfo, type StringsIndex } from "../api.ts";
import { usePublish } from "../shell.tsx";
import { Button, Notice, SaveBar, Segmented, useToast, useUnsavedGuard } from "../ui.tsx";

const DEFAULT_PAGES: PageInfo[] = [
  { file: "index.html", label: "Home" },
  { file: "about.html", label: "About" },
  { file: "portfolio.html", label: "Work" },
  { file: "contact.html", label: "Contact" },
];

type Pending = Record<string, Partial<Record<Lang, string>>>;
type Mode = "visual" | "list";

const KIND_LABEL = { text: "", placeholder: "Placeholder in an empty field", aria: "Read aloud by screen readers", meta: "Browser tab / search results" } as const;

export function PagesPage() {
  const [index, setIndex] = useState<StringsIndex | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending>({});
  const [mode, setMode] = useState<Mode>("visual");
  const [page, setPage] = useState<PageFile>("index.html");
  const [pages, setPages] = useState<PageInfo[]>(DEFAULT_PAGES);
  const [lang, setLang] = useState<Lang>("cs");
  const [saving, setSaving] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const toast = useToast();
  const { refresh } = usePublish();

  const load = () => api.strings().then(setIndex, (e) => setError(e.message));
  useEffect(() => {
    load();
    api.pages().then(setPages, () => {});
  }, []);

  const value = useCallback(
    (key: string, l: Lang) => pending[key]?.[l] ?? index?.strings[l][key] ?? "",
    [pending, index],
  );

  const changedKeys = useMemo(
    () => (index ? Object.keys(pending).filter((k) => (["cs", "en"] as Lang[]).some((l) => pending[k][l] !== undefined && pending[k][l] !== index.strings[l][k])) : []),
    [pending, index],
  );
  const dirty = changedKeys.length > 0;
  useUnsavedGuard(dirty);

  const edit = useCallback((key: string, l: Lang, v: string) => setPending((p) => ({ ...p, [key]: { ...p[key], [l]: v } })), []);

  const save = async () => {
    if (!index) return;
    const empties = changedKeys.filter((k) => !value(k, "cs").trim() || !value(k, "en").trim());
    if (empties.length) {
      toast("Some texts are empty. Every text needs both a Czech and an English version.", "error");
      return;
    }
    setSaving(true);
    try {
      const changes = Object.fromEntries(changedKeys.map((k) => [k, { cs: value(k, "cs"), en: value(k, "en") }]));
      await api.saveStrings(changes);
      await load();
      setPending({});
      setFrameKey((k) => k + 1);
      toast(`${changedKeys.length} text${changedKeys.length > 1 ? "s" : ""} saved`);
      refresh();
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setPending({});
    setFrameKey((k) => k + 1);
  };

  return (
    <div className="page" style={{ maxWidth: mode === "visual" ? "none" : undefined }}>
      <div className="page-head" style={{ marginBottom: 16 }}>
        <h1>Pages</h1>
      </div>

      <div className="pages-bar">
        <Segmented<Mode>
          label="Editing mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "visual", label: <><MousePointerClick aria-hidden /> On the page</> },
            { value: "list", label: <><Rows3 aria-hidden /> All text</> },
          ]}
        />
        {mode === "visual" && (
          <>
            <Segmented<PageFile> label="Page" value={page} onChange={setPage} options={pages.map((p) => ({ value: p.file, label: p.label }))} />
            <span className="spacer" />
            <Segmented<Lang>
              label="Language shown"
              value={lang}
              onChange={setLang}
              options={[
                { value: "cs", label: "Čeština" },
                { value: "en", label: "English" },
              ]}
            />
          </>
        )}
      </div>

      {error && <Notice kind="error">{error}</Notice>}
      {!index && !error && <div className="skeleton" style={{ height: 480 }} />}

      {index && mode === "visual" && (
        <VisualEditor key={`${page}-${frameKey}`} page={page} pages={pages} lang={lang} index={index} pending={pending} value={value} edit={edit} />
      )}
      {index && mode === "list" && <TextList pages={pages} index={index} value={value} edit={edit} changed={new Set(changedKeys)} />}

      {dirty && (
        <SaveBar label={`${changedKeys.length} text${changedKeys.length > 1 ? "s" : ""} changed`} saving={saving} onSave={save} onDiscard={discard} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- visual editor

const EDIT_ATTRS = ["data-i18n", "data-i18n-placeholder", "data-i18n-aria-label"] as const;
const keyOf = (el: Element) => {
  for (const a of EDIT_ATTRS) if (el.hasAttribute(a)) return { key: el.getAttribute(a)!, attr: a };
  return null;
};

const FRAME_CSS = `
  [data-otm-edit] { cursor: text; outline: 1px dashed transparent; outline-offset: 4px; border-radius: 2px; transition: outline-color .15s; }
  [data-otm-edit]:hover { outline-color: rgba(115,172,163,.9); }
  [data-otm-edit].otm-dirty { outline: 1px dashed #e2b664; }
  [data-otm-edit].otm-active { outline: 2px solid #73aca3; outline-offset: 4px; }
  [data-otm-edit][contenteditable] { caret-color: #73aca3; }
  html { scroll-behavior: auto !important; }
  /* The slogan normally fades in and out with the match; keep it readable while editing. */
  .hero-slogan { opacity: 1 !important; animation: none !important; -webkit-mask-image: none !important; mask-image: none !important;
    background: none !important; color: #fffbf4 !important; -webkit-text-fill-color: #fffbf4 !important; }
`;

type Selection = { key: string; attr: (typeof EDIT_ATTRS)[number]; el: HTMLElement };

function VisualEditor({
  page,
  pages,
  lang,
  index,
  pending,
  value,
  edit,
}: {
  page: PageFile;
  pages: PageInfo[];
  lang: Lang;
  index: StringsIndex;
  pending: Pending;
  value: (k: string, l: Lang) => string;
  edit: (k: string, l: Lang, v: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [sel, setSel] = useState<Selection | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const latest = useRef({ value, edit, lang });
  latest.current = { value, edit, lang };

  const doc = () => frame.current?.contentDocument ?? null;
  const appliedLang = useRef<Lang | null>(null);

  // Paint the current language plus any unsaved edits into the page.
  const paint = useCallback(() => {
    const d = doc();
    const win = frame.current?.contentWindow as any;
    if (!d || !win?.otmI18n) return;
    // applyLang rewrites every text on the page, so only run it when the
    // language actually changes; otherwise it would wipe what is being typed.
    if (appliedLang.current !== lang) {
      win.otmI18n.applyLang(lang);
      appliedLang.current = lang;
    }
    for (const el of d.querySelectorAll<HTMLElement>("[data-otm-edit]")) {
      const k = keyOf(el);
      if (!k) continue;
      const v = latest.current.value(k.key, lang);
      // Leave the element being typed into alone so the caret doesn't jump.
      if (k.attr === "data-i18n" && d.activeElement !== el) el.textContent = v;
      if (k.attr === "data-i18n-placeholder") el.setAttribute("placeholder", v);
      if (k.attr === "data-i18n-aria-label") el.setAttribute("aria-label", v);
      const changed = (["cs", "en"] as Lang[]).some((l) => pending[k.key]?.[l] !== undefined && pending[k.key]?.[l] !== index.strings[l][k.key]);
      el.classList.toggle("otm-dirty", changed);
    }
  }, [lang, pending, index]);

  useEffect(() => {
    if (ready) paint();
  }, [ready, paint]);

  const place = useCallback(() => {
    if (!sel || !frame.current) return setPos(null);
    const fr = frame.current.getBoundingClientRect();
    const r = sel.el.getBoundingClientRect();
    const W = 360;
    const H = 300;
    let top = fr.top + r.bottom + 12;
    if (top + H > window.innerHeight - 12) top = Math.max(12, fr.top + r.top - H - 12);
    const left = Math.min(Math.max(12, fr.left + r.left), window.innerWidth - W - 12);
    setPos({ top, left });
  }, [sel]);

  useEffect(() => {
    place();
    const win = frame.current?.contentWindow;
    if (!sel || !win) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    win.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      win.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [sel, place]);

  const select = useCallback((next: Selection | null, point?: { x: number; y: number }) => {
    setSel((prev) => {
      if (prev && prev.el !== next?.el) {
        prev.el.classList.remove("otm-active");
        prev.el.removeAttribute("contenteditable");
      }
      return next;
    });
    if (!next) return;
    next.el.classList.add("otm-active");
    if (next.attr === "data-i18n" && !next.el.children.length) {
      next.el.setAttribute("contenteditable", "plaintext-only");
      next.el.focus({ preventScroll: true });
      // Put the caret where the person clicked, not at the start.
      const d = next.el.ownerDocument;
      const sel = d.getSelection();
      const pos = point && (d as any).caretPositionFromPoint?.(point.x, point.y);
      const range = pos ? d.createRange() : point ? d.caretRangeFromPoint?.(point.x, point.y) : null;
      if (pos && range) range.setStart(pos.offsetNode, pos.offset);
      if (range && sel && next.el.contains(range.startContainer)) {
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }, []);

  const onLoad = () => {
    const d = doc();
    if (!d) return;
    const style = d.createElement("style");
    style.textContent = FRAME_CSS;
    d.head.appendChild(style);
    d.documentElement.classList.add("page-ready");
    for (const a of EDIT_ATTRS) d.querySelectorAll(`[${a}]`).forEach((el) => el.setAttribute("data-otm-edit", ""));

    // Capture phase so the site's own handlers (links, language toggle,
    // menu, form) never run while editing.
    d.addEventListener(
      "click",
      (e) => {
        const target = e.target as Element;
        const editable = target.closest("[data-otm-edit]") as HTMLElement | null;
        if (editable || target.closest("a, button, form, input, textarea")) {
          e.preventDefault();
          e.stopPropagation();
        }
        if (editable) {
          const k = keyOf(editable)!;
          select({ ...k, el: editable }, { x: e.clientX, y: e.clientY });
        } else select(null);
      },
      true,
    );
    d.addEventListener("submit", (e) => e.preventDefault(), true);

    d.addEventListener("input", (e) => {
      const el = e.target as HTMLElement;
      const k = el.hasAttribute?.("data-otm-edit") ? keyOf(el) : null;
      if (!k || k.attr !== "data-i18n") return;
      const text = (el.textContent ?? "").replace(/\s+/g, " ");
      latest.current.edit(k.key, latest.current.lang, text);
      // The same text can appear more than once on a page (repeated buttons, the ticker).
      d.querySelectorAll<HTMLElement>(`[data-i18n="${CSS.escape(k.key)}"]`).forEach((other) => other !== el && (other.textContent = text));
    });

    d.addEventListener("keydown", (e) => {
      const el = e.target as HTMLElement;
      if (!el.hasAttribute?.("contenteditable")) return;
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        el.blur();
        if (e.key === "Escape") select(null);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }));
      }
    });

    setReady(true);
  };

  const occ = sel ? index.occurrences[sel.key] ?? [] : [];
  const pagesUsing = [...new Set(occ.map((o) => pages.find((p) => p.file === o.page)?.label))].filter(Boolean);
  const kind = sel ? (sel.attr === "data-i18n-placeholder" ? "placeholder" : sel.attr === "data-i18n-aria-label" ? "aria" : "text") : "text";

  return (
    <>
      <p className="hint-strip" style={{ marginBottom: 10 }}>
        Click any text on the page to change it. Press Enter when you’re done with a line. Nothing goes live until you save and publish.
      </p>
      <div className="visual-frame">
        <iframe ref={frame} src={`/preview/${page}`} title="Page preview" onLoad={onLoad} />
      </div>
      {sel && pos && (
        <div className="inspector" style={{ top: pos.top, left: pos.left }} role="dialog" aria-label="Edit text">
          <div className="inspector-head">
            <span className="where">
              {KIND_LABEL[kind] || "Text"}
              {pagesUsing.length > 1 && ` · on ${pagesUsing.join(", ")}`}
            </span>
            <Button size="sm" variant="quiet" iconOnly icon={<X aria-hidden />} onClick={() => select(null)}>
              Close
            </Button>
          </div>
          {(["cs", "en"] as Lang[]).map((l) => (
            <label className="field" key={l}>
              <span className="field-label">
                {l === "cs" ? "Czech" : "English"}
                {l === lang && <span className="lang">SHOWN</span>}
              </span>
              <textarea
                className="textarea autosize"
                value={value(sel.key, l)}
                onChange={(e) => {
                  edit(sel.key, l, e.target.value);
                  if (l === lang && sel.attr === "data-i18n") {
                    doc()
                      ?.querySelectorAll<HTMLElement>(`[data-i18n="${CSS.escape(sel.key)}"]`)
                      .forEach((el) => (el.textContent = e.target.value));
                  }
                }}
                aria-invalid={!value(sel.key, l).trim()}
              />
            </label>
          ))}
          {!value(sel.key, "cs").trim() || !value(sel.key, "en").trim() ? (
            <span className="field-error">Both languages need text.</span>
          ) : null}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- list

type Scope = "all" | "site" | PageFile;

function TextList({ pages, index, value, edit, changed }: { pages: PageInfo[]; index: StringsIndex; value: (k: string, l: Lang) => string; edit: (k: string, l: Lang, v: string) => void; changed: Set<string> }) {
  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  const flagOf = (k: string) => {
    const cs = value(k, "cs").trim();
    const en = value(k, "en").trim();
    if (!cs || !en) return "Missing a language";
    if (cs === en && cs.split(" ").length > 3) return "Same text in both languages";
    return null;
  };

  const q = query.trim().toLowerCase();
  const groups = index.groups
    .filter((g) => scope === "all" || g.page === scope)
    .map((g) => ({
      ...g,
      keys: g.keys.filter(
        (k) =>
          (!q || value(k, "cs").toLowerCase().includes(q) || value(k, "en").toLowerCase().includes(q)) &&
          (!onlyFlagged || flagOf(k)),
      ),
    }))
    .filter((g) => g.keys.length);
  const flaggedCount = Object.keys(index.strings.cs).filter((k) => !index.unused.includes(k) && flagOf(k)).length;
  const pageLabel = (p: string) => (p === "site" ? "Every page" : pages.find((x) => x.file === p)?.label ?? p);

  return (
    <div>
      <div className="toolbar">
        <div className="search">
          <Search aria-hidden />
          <input className="input" type="search" placeholder="Find text" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find text" />
        </div>
        <Segmented<Scope>
          label="Show"
          value={scope}
          onChange={setScope}
          options={[{ value: "all", label: "All" }, { value: "site", label: "Every page" }, ...pages.map((p) => ({ value: p.file as Scope, label: p.label }))]}
        />
        <span className="spacer" />
        {flaggedCount > 0 && (
          <Segmented<"all" | "flagged">
            label="Filter"
            value={onlyFlagged ? "flagged" : "all"}
            onChange={(v) => setOnlyFlagged(v === "flagged")}
            options={[
              { value: "all", label: "Everything" },
              { value: "flagged", label: <><AlertTriangle aria-hidden /> Needs a look <span className="faint tabular">{flaggedCount}</span></> },
            ]}
          />
        )}
      </div>

      {groups.length === 0 && (
        <div className="empty">
          <h2>No text matches</h2>
          <p>Try a different word, or switch back to all pages.</p>
        </div>
      )}

      <div className="text-cols" aria-hidden>
        <span>Czech</span>
        <span>English</span>
      </div>
      <div className="text-groups">
        {groups.map((g) => (
          <section key={g.id} className="text-group" aria-labelledby={`g-${g.id}`}>
            <h2 id={`g-${g.id}`}>
              {g.label} <span className="faint">{pageLabel(g.page)}</span>
            </h2>
            {g.keys.map((k) => {
              const kinds = [...new Set((index.occurrences[k] ?? []).map((o) => o.kind))];
              const where = [...new Set((index.occurrences[k] ?? []).map((o) => pageLabel(o.page)))];
              const flag = flagOf(k);
              return (
                <div className={`text-row ${changed.has(k) ? "is-dirty" : ""}`} key={k}>
                  {(["cs", "en"] as Lang[]).map((l) => (
                    <textarea
                      key={l}
                      className="textarea autosize"
                      rows={1}
                      value={value(k, l)}
                      onChange={(e) => edit(k, l, e.target.value)}
                      aria-label={`${l === "cs" ? "Czech" : "English"}: ${index.strings.en[k]}`}
                      aria-invalid={!value(k, l).trim()}
                    />
                  ))}
                  {(kinds.some((x) => x !== "text") || flag || (g.page !== "site" && where.length > 1)) && (
                    <div className="text-row-meta">
                      {kinds.filter((x) => x !== "text").map((x) => (
                        <span key={x}>{KIND_LABEL[x]}</span>
                      ))}
                      {g.page !== "site" && where.length > 1 && <span>Also on {where.filter((w) => w !== pageLabel(g.page)).join(", ")}</span>}
                      {flag && (
                        <span className="flag">
                          <AlertTriangle aria-hidden /> {flag}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
