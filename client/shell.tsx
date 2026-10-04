import { createContext, useCallback, useContext, useEffect, useState, type FormEvent } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Clapperboard, Download, ExternalLink, Palette, Rocket, ScanEye, Type } from "lucide-react";
import { api, type AppUpdate, type PublishStatus, type Session } from "./api.ts";
import { SetupPage } from "./routes/setup.tsx";
import { Button, ConfirmProvider, Field, Notice, ToastProvider, useConfirm, useToast } from "./ui.tsx";

type PublishCtx = { status: PublishStatus | null; refresh: () => void };
const PublishContext = createContext<PublishCtx>({ status: null, refresh: () => {} });
export const usePublish = () => useContext(PublishContext);

export function AppShell() {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<PublishStatus | null>(null);
  const location = useLocation();

  useEffect(() => {
    api.session().then(setSession, () => setSession({ authRequired: false, authed: true }));
  }, []);

  const refresh = useCallback(() => {
    api.publishStatus().then(setStatus, () => {});
  }, []);

  useEffect(() => {
    if (session?.authed && !session.setupNeeded) refresh();
  }, [session, refresh, location.pathname]);

  if (!session) return null;
  if (!session.authed) return <Login onDone={() => setSession({ ...session, authed: true })} />;
  // First launch of the Mac app: connect to GitHub and download the site first.
  if (session.setupNeeded)
    return (
      <ToastProvider>
        <SetupPage firstRun onDone={() => api.session().then(setSession)} />
      </ToastProvider>
    );

  const pending = status && status.state !== "not-set-up" ? status.pending : 0;
  const liveUrl = status && status.state !== "not-set-up" ? status.liveUrl : null;

  return (
    <ToastProvider>
      <ConfirmProvider>
        <PublishContext.Provider value={{ status, refresh }}>
          <div className="shell">
            <nav className="sidebar" aria-label="Sections">
              <NavLink to="/films" className="brand" aria-label="On the Move Studio, films">
                <img src="/logo.png" alt="" />
                <span className="brand-name">
                  On the Move
                  <small>Studio</small>
                </span>
              </NavLink>
              <NavLink to="/films" className="nav-link" aria-label="Films" title="Films">
                <Clapperboard aria-hidden />
                <span>Films</span>
              </NavLink>
              <NavLink to="/pages" className="nav-link" aria-label="Pages" title="Pages">
                <Type aria-hidden />
                <span>Pages</span>
              </NavLink>
              <NavLink to="/theme" className="nav-link" aria-label="Colors" title="Colors">
                <Palette aria-hidden />
                <span>Colors</span>
              </NavLink>
              <NavLink to="/publish" className="nav-link" aria-label={pending ? `Publish, ${pending} unpublished` : "Publish"} title="Publish">
                <Rocket aria-hidden />
                <span>Publish</span>
                {pending > 0 && (
                  <span className="nav-badge tabular" aria-label={`${pending} unpublished changes`}>
                    {pending}
                  </span>
                )}
              </NavLink>
              <div className="sidebar-foot">
                <UpdateBanner />
                <a className="nav-link" href="/preview/index.html" target="_blank" rel="noreferrer" aria-label="Preview site" title="Preview site">
                  <ScanEye aria-hidden />
                  <span>Preview site</span>
                </a>
                {liveUrl && (
                  <a className="nav-link" href={liveUrl} target="_blank" rel="noreferrer" aria-label="Live site" title="Live site">
                    <ExternalLink aria-hidden />
                    <span>Live site</span>
                  </a>
                )}
              </div>
            </nav>
            <main className="main" id="main">
              <Outlet />
            </main>
          </div>
        </PublishContext.Provider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.login(password);
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form onSubmit={submit}>
        <img src="/logo.png" alt="" />
        <h1>On the Move Studio</h1>
        {error && <Notice kind="error">{error}</Notice>}
        <Field label="Password">
          <input className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        <Button type="submit" variant="primary" loading={busy}>
          Sign in
        </Button>
      </form>
    </div>
  );
}

// Shown in the Mac app when a newer version has been released.
function UpdateBanner() {
  const [u, setU] = useState<AppUpdate | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  useEffect(() => {
    const load = () => api.appUpdate().then(setU, () => {});
    load();
    const t = window.setInterval(load, 30 * 60 * 1000);
    return () => window.clearInterval(t);
  }, []);

  // Follow the download until the app quits and reopens.
  useEffect(() => {
    if (u?.phase !== "downloading" && u?.phase !== "installing") return;
    const t = window.setInterval(() => api.appUpdate().then(setU, () => {}), 800);
    return () => window.clearInterval(t);
  }, [u?.phase]);

  if (!u?.supported || !(u.available || u.phase === "downloading" || u.phase === "installing")) return null;

  const working = u.phase === "downloading" || u.phase === "installing";
  const install = async () => {
    const ok = await confirm({
      title: `Update to version ${u.latest}?`,
      body: "The app downloads the new version, closes, and opens again in a minute. Unsaved changes on the current screen are lost, so save first.",
      confirm: "Update now",
    });
    if (!ok) return;
    setU({ ...u, phase: "downloading", progress: 0 });
    try {
      await api.installUpdate();
    } catch (err: any) {
      toast(err.message, "error");
      api.appUpdate().then(setU, () => {});
    }
  };

  return (
    <button type="button" className="update-banner" onClick={install} disabled={working} title={`Version ${u.latest} is available`}>
      <Download aria-hidden />
      <span>
        {working ? (u.phase === "installing" ? "Installing…" : `Downloading… ${Math.round((u.progress ?? 0) * 100)}%`) : <>Update to {u.latest}</>}
      </span>
    </button>
  );
}
