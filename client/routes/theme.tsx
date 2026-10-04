import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { api, type PageFile, type Theme } from "../api.ts";
import { usePublish } from "../shell.tsx";
import { Button, Notice, SaveBar, Segmented, useToast, useUnsavedGuard } from "../ui.tsx";

// WCAG 2 relative luminance / contrast ratio.
function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const isHex = (v: string) => /^#[0-9a-f]{6}$/i.test(v);

const PAGES: { value: PageFile; label: string }[] = [
  { value: "index.html", label: "Home" },
  { value: "about.html", label: "About" },
  { value: "portfolio.html", label: "Work" },
  { value: "contact.html", label: "Contact" },
];

export function ThemePage() {
  const [theme, setTheme] = useState<Theme | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [text, setText] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState<PageFile>("index.html");
  const frame = useRef<HTMLIFrameElement>(null);
  const toast = useToast();
  const { refresh } = usePublish();

  const load = () =>
    api.theme().then((t) => {
      setTheme(t);
      setDraft(t.current);
      setText(t.current);
    }, (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const changed = theme ? Object.keys(draft).filter((k) => draft[k].toLowerCase() !== theme.current[k].toLowerCase()) : [];
  const dirty = changed.length > 0;
  useUnsavedGuard(dirty);

  const differsFromPublished = !!theme?.published && Object.keys(draft).some((k) => theme.published![k] && draft[k].toLowerCase() !== theme.published![k].toLowerCase());

  // Live preview: override the tokens inside the preview page.
  const applyPreview = () => {
    const d = frame.current?.contentDocument;
    if (!d?.head) return;
    let style = d.getElementById("otm-theme-preview");
    if (!style) {
      style = d.createElement("style");
      style.id = "otm-theme-preview";
      d.head.appendChild(style);
    }
    style.textContent = `:root{${Object.entries(draft).map(([k, v]) => `${k}:${v}`).join(";")}}`;
  };
  useEffect(applyPreview, [draft]);

  const setColor = (name: string, value: string) => {
    setText((t) => ({ ...t, [name]: value }));
    if (isHex(value)) setDraft((d) => ({ ...d, [name]: value.toLowerCase() }));
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.saveTheme(Object.fromEntries(changed.map((k) => [k, draft[k]])));
      await load();
      toast("Colors saved");
      refresh();
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const pairs = useMemo(
    () =>
      theme?.pairs.map((p) => {
        const ratio = contrast(draft[p.fg] ?? "#000000", draft[p.bg] ?? "#ffffff");
        const need = p.large ? 3 : 4.5;
        return { ...p, ratio, pass: ratio >= need, need };
      }) ?? [],
    [theme, draft],
  );
  const failing = pairs.filter((p) => !p.pass).length;

  return (
    <div className="page" style={{ maxWidth: "none" }}>
      <div className="page-head">
        <h1>Colors</h1>
        {differsFromPublished && (
          <Button
            variant="quiet"
            icon={<RotateCcw aria-hidden />}
            onClick={() => {
              setDraft({ ...draft, ...theme!.published! });
              setText({ ...text, ...theme!.published! });
            }}
          >
            Back to the live colors
          </Button>
        )}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {theme && (
        <div className="theme-layout">
          <div style={{ display: "grid", gap: 20 }}>
            <section className="panel" aria-labelledby="tokens-head">
              <div className="panel-head">
                <h2 id="tokens-head">Brand colors</h2>
              </div>
              <div className="panel-body" style={{ paddingTop: 4, paddingBottom: 6 }}>
                {theme.tokens.map((t) => (
                  <div key={t.name} className={`swatch-row ${changed.includes(t.name) ? "changed" : ""}`}>
                    <label className="swatch" style={{ background: draft[t.name] }}>
                      <input type="color" value={draft[t.name]} onChange={(e) => setColor(t.name, e.target.value)} aria-label={`Pick ${t.label}`} />
                    </label>
                    <div className="swatch-label">
                      <strong>{t.label}</strong>
                      <span>{t.role}</span>
                    </div>
                    <input
                      className="input"
                      value={text[t.name] ?? ""}
                      maxLength={7}
                      spellCheck={false}
                      onChange={(e) => setColor(t.name, e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`)}
                      onBlur={() => setText((x) => ({ ...x, [t.name]: draft[t.name] }))}
                      aria-invalid={!isHex(text[t.name] ?? "")}
                      aria-label={`${t.label} hex value`}
                    />
                  </div>
                ))}
              </div>
            </section>

            <section className="panel" aria-labelledby="contrast-head">
              <div className="panel-head">
                <h2 id="contrast-head">Readability</h2>
                <span className={`ratio ${failing ? "fail" : "pass"}`}>{failing ? `${failing} too faint` : "All readable"}</span>
              </div>
              <div className="panel-body" style={{ paddingTop: 4, paddingBottom: 6 }}>
                {pairs.map((p) => (
                  <div className="contrast-row" key={p.fg + p.bg}>
                    <div className="contrast-sample" style={{ background: draft[p.bg], color: draft[p.fg] }} aria-hidden>
                      Aa
                    </div>
                    <div className="contrast-where">
                      {p.where}
                      <span>{p.pass ? "Easy to read" : `Needs at least ${p.need}:1 to be readable`}</span>
                    </div>
                    <div className={`ratio ${p.pass ? "pass" : "fail"}`}>
                      <b className="tabular">{p.ratio.toFixed(1)}:1</b>
                      {p.pass ? "Pass" : "Fail"}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="theme-preview" aria-label="Preview">
            <Segmented<PageFile> label="Preview page" value={page} onChange={setPage} options={PAGES} />
            <div className="visual-frame">
              <iframe ref={frame} src={`/preview/${page}`} title="Color preview" onLoad={applyPreview} />
            </div>
          </section>
        </div>
      )}

      {dirty && (
        <SaveBar
          label={`${changed.length} color${changed.length > 1 ? "s" : ""} changed${failing ? ` · ${failing} hard to read` : ""}`}
          saving={saving}
          onSave={save}
          onDiscard={() => {
            setDraft(theme!.current);
            setText(theme!.current);
          }}
        />
      )}
    </div>
  );
}
