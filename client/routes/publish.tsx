import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, CloudUpload, ExternalLink, RefreshCw, Rocket } from "lucide-react";
import { api, type GithubConnection, type PublishItem, type SiteSettings } from "../api.ts";
import { usePublish } from "../shell.tsx";
import { Button, Field, Notice, timeAgo, useToast } from "../ui.tsx";

export function PublishPage() {
  const { status, refresh } = usePublish();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; detail?: string } | null>(null);
  const [pagesProblem, setPagesProblem] = useState<string | null>(null);
  const [github, setGithub] = useState<GithubConnection | null>(null);
  const toast = useToast();

  const [syncProblem, setSyncProblem] = useState<string | null>(null);

  const checkGithub = (refreshCache = false) => api.github(refreshCache).then(setGithub, () => {});
  useEffect(() => {
    checkGithub();
    api.session().then((s) => setSyncProblem(s.sync?.state === "conflict" || s.sync?.state === "merged" ? s.sync.message ?? null : null), () => {});
  }, []);

  if (!status) return <div className="page" aria-busy="true" />;

  if (status.state === "not-set-up" || (status.state === "no-remote" && !status.canConnect))
    return <SetupGuide canConnect={status.canConnect} github={github} onCheck={() => (refresh(), checkGithub(true))} />;

  const areas = groupByArea(status.summary);
  const nothing = status.pending === 0;

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.publish(message);
      setPagesProblem(result.pagesProblem ?? null);
      if (result.state !== "not-set-up" && result.merged) setSyncProblem(result.merged);
      setMessage("");
      toast("Published. GitHub Pages usually updates within a minute.");
      refresh();
    } catch (err: any) {
      setError({ text: err.message, detail: err.details?.detail });
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Publish</h1>
        <Button variant="quiet" icon={<RefreshCw aria-hidden />} onClick={refresh}>
          Check again
        </Button>
      </div>

      {github && "message" in github && (
        <Notice kind="error">{github.message}</Notice>
      )}
      {pagesProblem && <Notice kind="warn">{pagesProblem}</Notice>}
      {syncProblem && <Notice kind="warn">{syncProblem}</Notice>}

      <div className="publish-layout" style={{ marginTop: (github && "message" in github) || pagesProblem || syncProblem ? 20 : 0 }}>
        <section className="panel" aria-labelledby="changes-head">
          <div className="panel-head">
            <h2 id="changes-head">{nothing ? "Everything is live" : "Waiting to go live"}</h2>
          </div>
          <div className="panel-body">
            {nothing ? (
              <div style={{ display: "flex", gap: 12, alignItems: "center", color: "var(--text-2)" }}>
                <CheckCircle2 aria-hidden style={{ color: "var(--accent)" }} />
                The website matches what’s in the editor.
              </div>
            ) : areas.length ? (
              <div className="change-list">
                {areas.map(([area, items]) => (
                  <div className="change-area" key={area}>
                    <h3>{area}</h3>
                    <ul>
                      {items.map((i, n) => (
                        <li key={n}>{i.text}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">
                {status.unpushed} saved update{status.unpushed === 1 ? "" : "s"} still need to be sent to GitHub.
              </p>
            )}
          </div>
        </section>

        <aside className="panel publish-hero" aria-label="Publish">
          <div>
            <div className="big tabular">{status.pending}</div>
            <span className="muted">{status.pending === 1 ? "change to publish" : "changes to publish"}</span>
          </div>
          <Field label="Note for this update" hint="Optional. Leave empty and a summary is written for you.">
            <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. New poster for SERRA" disabled={nothing} />
          </Field>
          <Button variant="primary" icon={<Rocket aria-hidden />} loading={busy} onClick={publish} disabled={nothing || status.state !== "ready"}>
            Publish to the website
          </Button>
          {error && (
            <Notice kind="error">
              {error.text}
              {error.detail && (
                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: "pointer" }}>Technical details</summary>
                  <code className="code">{error.detail}</code>
                </details>
              )}
            </Notice>
          )}
          <dl style={{ margin: 0, display: "grid", gap: 8, fontSize: "0.8125rem" }}>
            <div>
              <dt className="faint">Last published</dt>
              <dd style={{ margin: 0 }}>{timeAgo(status.lastPublishedAt)}</dd>
            </div>
            {status.liveUrl && (
              <div>
                <dt className="faint">Live at</dt>
                <dd style={{ margin: 0 }}>
                  <a href={status.liveUrl} target="_blank" rel="noreferrer">
                    {status.liveUrl.replace(/^https:\/\//, "")} <ExternalLink size={13} aria-hidden style={{ verticalAlign: -2 }} />
                  </a>
                </dd>
              </div>
            )}
            {status.remote && (
              <div>
                <dt className="faint">Repository</dt>
                <dd className="mono" style={{ margin: 0, wordBreak: "break-all" }}>
                  {status.remote.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}
                  {github?.state === "ok" && <span style={{ color: "var(--accent)", fontFamily: "var(--ui)" }}> · connected</span>}
                </dd>
              </div>
            )}
          </dl>
        </aside>
      </div>

      <SettingsPanel />
    </div>
  );
}

function groupByArea(items: PublishItem[]) {
  const map = new Map<string, PublishItem[]>();
  for (const i of items) map.set(i.area, [...(map.get(i.area) ?? []), i]);
  return [...map];
}

function SetupGuide({ canConnect, github, onCheck }: { canConnect: boolean; github: GithubConnection | null; onCheck: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; detail?: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const toast = useToast();
  const { refresh } = usePublish();

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.connect();
      setDone(result.pagesProblem ?? null);
      toast("The website is uploaded. GitHub Pages usually takes a minute or two the first time.");
      refresh();
    } catch (err: any) {
      setError({ text: err.message, detail: err.details?.detail });
    } finally {
      setBusy(false);
    }
  };

  const problem = github && "message" in github ? github.message : null;

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="page-head">
        <h1>Publishing isn’t set up yet</h1>
        <Button icon={<RefreshCw aria-hidden />} onClick={onCheck}>
          Check again
        </Button>
      </div>
      <p className="muted" style={{ marginBottom: 28, maxWidth: "62ch" }}>
        Everything you change here is already saved on this computer. Connecting to GitHub puts the website online; after that, publishing is one button.
      </p>

      {canConnect ? (
        <section className="panel publish-hero" style={{ maxWidth: 560 }} aria-label="Connect">
          <h2>Connect to GitHub</h2>
          <p className="muted">
            Uploads the website to <span className="mono">{github && "repo" in github ? github.repo : "the repository"}</span> and switches on GitHub Pages. This takes a minute.
          </p>
          {problem && <Notice kind="error">{problem}</Notice>}
          {error && (
            <Notice kind="error">
              {error.text}
              {error.detail && (
                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: "pointer" }}>Technical details</summary>
                  <code className="code">{error.detail}</code>
                </details>
              )}
            </Notice>
          )}
          {done && <Notice kind="warn">{done}</Notice>}
          <div>
            <Button variant="primary" icon={<CloudUpload aria-hidden />} loading={busy} onClick={connect} disabled={!!problem}>
              Connect and publish
            </Button>
          </div>
        </section>
      ) : (
        <KeySetup />
      )}
      <SettingsPanel />
    </div>
  );
}

// One-time setup, done by whoever manages the site (not the studio).
function KeySetup() {
  return (
    <ol className="steps">
      <li>
        <div>
          <h3>Create an empty repository on GitHub</h3>
          <p>For example <span className="mono">onthemove-site</span>, public, without a README.</p>
        </div>
      </li>
      <li>
        <div>
          <h3>Make a key for it</h3>
          <p>
            On github.com: Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. Under Repository access choose only that repository. Under Permissions set <b>Contents</b> and <b>Pages</b> to
            “Read and write”. Copy the token.
          </p>
        </div>
      </li>
      <li>
        <div>
          <h3>Put it in the editor’s settings file</h3>
          <p>
            In the <span className="mono">editor</span> folder, copy <span className="mono">.env.example</span> to a file named <span className="mono">.env</span> and fill in these two lines:
            <code className="code">{`GITHUB_REPO=your-name/onthemove-site
GITHUB_TOKEN=github_pat_…`}</code>
            Then close the editor window and open it again with Start Editor. A “Connect and publish” button appears here.
          </p>
        </div>
      </li>
      <li>
        <div>
          <h3>Switch on GitHub Pages (once)</h3>
          <p>
            After connecting, open the repository on github.com: Settings → Pages → Source “Deploy from a branch” → branch <b>main</b>, folder <b>/ (root)</b> → Save. (The key can’t do this
            itself without admin rights, which it’s safer not to have.)
          </p>
        </div>
      </li>
    </ol>
  );
}

function SettingsPanel() {
  const [saved, setSaved] = useState<SiteSettings | null>(null);
  const [form, setForm] = useState<SiteSettings>({ siteUrl: "", formEndpoint: "", analyticsToken: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const { refresh } = usePublish();

  useEffect(() => {
    api.settings().then((s) => (setSaved(s), setForm(s)), () => {});
  }, []);
  if (!saved) return null;
  const dirty = saved.siteUrl !== form.siteUrl || saved.formEndpoint !== form.formEndpoint || saved.analyticsToken !== form.analyticsToken;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const next = await api.saveSettings(form);
      setSaved(next);
      setForm(next);
      toast("Settings saved");
      refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" style={{ marginTop: 28 }} aria-labelledby="settings-head">
      <div className="panel-head">
        <h2 id="settings-head">Site settings</h2>
      </div>
      <form className="panel-body" style={{ display: "grid", gap: 18, maxWidth: 640 }} onSubmit={submit}>
        <Field
          label="Website address"
          hint="The address people type, e.g. onthemove.cz. Publishing it tells GitHub Pages to answer at that address, and it is used for link previews, Google and the sitemap. Leave it empty until the domain points to GitHub; the github.io address is used meanwhile."
        >
          <input className="input" value={form.siteUrl} onChange={(e) => setForm({ ...form, siteUrl: e.target.value })} placeholder="https://onthemove.cz" inputMode="url" spellCheck={false} />
        </Field>
        <Field
          label="Contact form address"
          hint={<>Lets the contact form send messages straight to your inbox. Create a free form at formspree.io and paste its address here (it looks like https://formspree.io/f/…). Leave empty and the form opens the visitor’s email app instead.</>}
        >
          <input className="input" value={form.formEndpoint} onChange={(e) => setForm({ ...form, formEndpoint: e.target.value })} placeholder="https://formspree.io/f/…" inputMode="url" spellCheck={false} />
        </Field>
        <Field
          label="Cloudflare Web Analytics token"
          hint="Counts visitors without cookies, so no consent banner is needed. In Cloudflare: Web Analytics → onthemove.cz → copy the token, or paste the whole snippet. Leave empty for no analytics."
        >
          <input className="input mono" value={form.analyticsToken} onChange={(e) => setForm({ ...form, analyticsToken: e.target.value })} placeholder="e.g. 1a2b3c4d5e6f…" spellCheck={false} autoComplete="off" />
        </Field>
        {error && <Notice kind="error">{error}</Notice>}
        <div>
          <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
            Save settings
          </Button>
        </div>
      </form>
    </section>
  );
}
