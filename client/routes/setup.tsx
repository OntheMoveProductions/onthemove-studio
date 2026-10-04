import { useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, KeyRound } from "lucide-react";
import { api, type SetupInfo } from "../api.ts";
import { Button, Field, Notice, useToast } from "../ui.tsx";

// Connecting the app to GitHub. On first launch it also downloads the website
// into ~/Documents/On the Move Website before the dashboard opens.
export function SetupPage({ firstRun, onDone }: { firstRun?: boolean; onDone?: () => void }) {
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [repo, setRepo] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const poll = useRef<number | null>(null);

  const load = () =>
    api.setup().then((i) => {
      setInfo(i);
      setRepo((r) => r || i.repo);
      return i;
    });

  useEffect(() => {
    load().then((i) => i.clone.running && watchClone());
    return () => {
      if (poll.current) window.clearInterval(poll.current);
    };
  }, []);

  function watchClone() {
    if (poll.current) return;
    poll.current = window.setInterval(async () => {
      const i = await load();
      if (i.clone.running) return;
      window.clearInterval(poll.current!);
      poll.current = null;
      if (i.clone.error) setError(i.clone.error);
      else if (i.siteReady) onDone?.();
    }, 700);
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.saveSetup(repo.trim(), token.trim());
      setToken("");
      const i = await load();
      if (i.clone.running) watchClone();
      else if (firstRun) onDone?.();
      else toast("GitHub connection saved");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <div className="page" aria-busy="true" />;

  const downloading = info.clone.running;
  const body = (
    <>
      {downloading ? (
        <div className="progress" aria-live="polite">
          <div className="progress-top">
            <strong>{info.clone.phase === "Unpacking" ? "Unpacking the website" : "Downloading the website"}</strong>
            {info.clone.fraction > 0 && <span className="tabular">{Math.round(info.clone.fraction * 100)}%</span>}
          </div>
          <div className={`bar ${info.clone.fraction === 0 ? "indeterminate" : ""}`}>
            <i style={{ ["--p" as string]: Math.max(0.02, info.clone.fraction) }} />
          </div>
          <span className="faint" style={{ fontSize: "0.75rem" }}>
            Into {info.siteRoot}. The videos make this take a minute or two.
          </span>
        </div>
      ) : info.mode === "env" ? (
        <Notice>
          Here, the GitHub repository and key are set in the editor’s <span className="mono">.env</span> file{info.repo ? <> (currently <span className="mono">{info.repo}</span>)</> : null}.
        </Notice>
      ) : (
        <form onSubmit={submit} style={{ display: "grid", gap: 16 }}>
          <Field label="GitHub repository" hint="As owner/name, e.g. OntheMoveProductions/onthemove. The full github.com address works too.">
            <input className="input mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" spellCheck={false} autoComplete="off" required />
          </Field>
          <Field
            label="GitHub key"
            hint={
              info.hasToken
                ? "A key is already saved. Leave this empty to keep it, or paste a new one to replace it."
                : "The fine-grained token made for this website (starts with github_pat_). It’s stored in this Mac’s Keychain."
            }
          >
            <input
              className="input mono"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={info.hasToken ? "••••••••  (saved)" : "github_pat_…"}
              autoComplete="off"
              required={!info.hasToken}
            />
          </Field>
          {error && <Notice kind="error">{error}</Notice>}
          <div>
            <Button type="submit" variant="primary" icon={<KeyRound aria-hidden />} loading={busy}>
              {firstRun && !info.siteReady ? "Connect and download the website" : "Save"}
            </Button>
          </div>
        </form>
      )}
      {!downloading && error && info.mode === "env" && <Notice kind="error">{error}</Notice>}
    </>
  );

  if (firstRun)
    return (
      <div className="login">
        <div style={{ width: "min(480px, 100%)", display: "grid", gap: 18 }}>
          <img src="/logo.png" alt="" style={{ width: 48, height: "auto" }} />
          <h1>Welcome to On the Move Studio</h1>
          <p className="muted">
            {info.siteReady
              ? "Connect to GitHub so the Publish button can put changes on the website."
              : "Connect to GitHub once. The website is then downloaded to this Mac, and you can start editing."}
          </p>
          {body}
        </div>
      </div>
    );

  return (
    <div className="page" style={{ maxWidth: 640 }}>
      <div className="page-head">
        <h1>GitHub connection</h1>
      </div>
      {info.siteReady && info.repo && info.hasToken && (
        <p className="muted" style={{ marginBottom: 20, display: "flex", gap: 8, alignItems: "center" }}>
          <CheckCircle2 size={17} aria-hidden style={{ color: "var(--accent)" }} /> Publishing to <span className="mono">{info.repo}</span>
        </p>
      )}
      {body}
    </div>
  );
}
