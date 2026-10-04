import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Camera, ExternalLink, ImagePlus, ImageOff, Trash2, Upload, Video as VideoIcon } from "lucide-react";
import { api, previewUrl, uploadFile, watchJob, type Category, type Film, type FilmInput, type Job } from "../api.ts";
import { usePublish } from "../shell.tsx";
import { Button, Field, Notice, SaveBar, Segmented, Switch, formatBytes, timecode, useConfirm, useToast, useUnsavedGuard } from "../ui.tsx";

const BLANK: FilmInput = {
  status: "draft",
  featured: false,
  categoryId: "",
  title: { cs: "", en: "" },
  description: { cs: "", en: "" },
  year: null,
  client: "",
  poster: "",
  video: "",
};

const toInput = (f: Film): FilmInput => {
  const { id: _id, updatedAt: _u, ...rest } = f;
  return rest;
};

type VideoTask =
  | { phase: "uploading"; progress: number; name: string; size: number; cancel: () => void }
  | { phase: "encoding" | "shrinking"; progress: number; name: string; size: number }
  | { phase: "error"; message: string };

export function FilmEditor() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { refresh } = usePublish();

  const [original, setOriginal] = useState<FilmInput | null>(isNew ? BLANK : null);
  const [form, setForm] = useState<FilmInput>(BLANK);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [videoTask, setVideoTask] = useState<VideoTask | null>(null);
  const [posterBusy, setPosterBusy] = useState(false);
  const [stageView, setStageView] = useState<"poster" | "video">("poster");

  useEffect(() => {
    api.films().then((p) => setCategories(p.categories), () => {});
    if (isNew) {
      setOriginal(BLANK);
      setForm(BLANK);
      return;
    }
    api.film(id!).then(
      (f) => {
        setOriginal(toInput(f));
        setForm(toInput(f));
      },
      (e) => setLoadError(e.message),
    );
  }, [id, isNew]);

  const dirty = useMemo(() => !!original && JSON.stringify(original) !== JSON.stringify(form), [original, form]);
  const busyMedia = videoTask !== null && videoTask.phase !== "error";
  const allowNavigation = useUnsavedGuard(dirty || busyMedia, busyMedia ? "A video is still being prepared. Leaving now loses it." : undefined);

  const formRef = useRef(form);
  formRef.current = form;

  const set = <K extends keyof FilmInput>(key: K, value: FilmInput[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setLang = (key: "title" | "description", lang: "cs" | "en", value: string) => setForm((f) => ({ ...f, [key]: { ...f[key], [lang]: value } }));

  const hint = form.title.en || form.title.cs || id || "film";

  // Errors that block publishing; drafts can be saved half-finished.
  const problems = useMemo(() => {
    const p: Partial<Record<"titleCs" | "titleEn" | "category" | "poster" | "year", string>> = {};
    if (form.year !== null && (form.year < 1900 || form.year > 2100)) p.year = "Use a four-digit year.";
    if (!form.title.cs && !form.title.en) p.titleEn = "Give the film a title.";
    if (form.status === "published") {
      if (!form.title.cs) p.titleCs = "Needed to publish.";
      if (!form.title.en) p.titleEn = "Needed to publish.";
      if (!form.categoryId) p.category = "Needed to publish.";
      if (!form.poster) p.poster = "A published film needs a poster.";
    }
    return p;
  }, [form]);

  const save = async () => {
    if (saving || busyMedia) return;
    setSaveError("");
    if (Object.keys(problems).length) {
      setShowErrors(true);
      setSaveError(form.status === "published" ? "A few things are missing before this film can be published. Fill them in, or save it as a draft." : "Give the film a title first.");
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        const created = await api.createFilm(form);
        setOriginal(toInput(created));
        setForm(toInput(created));
        toast(created.status === "draft" ? "Draft saved" : "Film saved");
        allowNavigation();
        navigate(`/films/${created.id}`, { replace: true });
      } else {
        const updated = await api.updateFilm(id!, form);
        setOriginal(toInput(updated));
        setForm(toInput(updated));
        toast("Saved");
      }
      setShowErrors(false);
      refresh();
    } catch (err: any) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const title = original?.title.en || original?.title.cs || "this film";
    if (!(await confirm({ title: `Delete “${title}”?`, body: "It’s removed from the website the next time you publish. Its poster and video files stay under Unused files until you delete them.", confirm: "Delete film", danger: true }))) return;
    try {
      await api.deleteFilm(id!);
      toast("Film deleted");
      refresh();
      allowNavigation();
      navigate("/films");
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  // ---------------------------------------------------------------- media

  const uploadPoster = async (file: File) => {
    setPosterBusy(true);
    try {
      const { promise } = uploadFile<{ path: string }>("/api/media/poster", file, hint, () => {});
      const { path } = await promise;
      set("poster", path);
      setStageView("poster");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setPosterBusy(false);
    }
  };

  const uploadVideo = async (file: File) => {
    const upload = uploadFile<Job>("/api/media/video", file, hint, (progress) =>
      setVideoTask((t) => (t && t.phase === "uploading" ? { ...t, progress } : t)),
    );
    setVideoTask({ phase: "uploading", progress: 0, name: file.name, size: file.size, cancel: upload.cancel });
    try {
      const job = await upload.promise;
      setVideoTask({ phase: "encoding", progress: 0, name: file.name, size: file.size });
      watchJob(job.id, async (j) => {
        if (j.phase === "encoding" || j.phase === "shrinking") {
          setVideoTask({ phase: j.phase, progress: j.progress, name: file.name, size: file.size });
        } else if (j.phase === "error") {
          setVideoTask({ phase: "error", message: j.error || "The video couldn’t be prepared." });
        } else if (j.phase === "done" && j.output) {
          setVideoTask(null);
          set("video", j.output);
          setStageView("video");
          toast(`Video ready · ${formatBytes(j.sizeBytes ?? 0)}`);
          if (!formRef.current.poster && j.duration) {
            try {
              const { path } = await api.grabFrame(j.output, Math.min(j.duration * 0.25, 4), hint);
              setForm((f) => (f.poster ? f : { ...f, poster: path }));
              toast("Took a poster from the video. Pick another frame any time.");
            } catch {}
          }
        }
      });
    } catch (err: any) {
      setVideoTask(err.message === "Upload cancelled." ? null : { phase: "error", message: err.message });
    }
  };

  // ---------------------------------------------------------------- render

  if (loadError)
    return (
      <div className="page">
        <Notice kind="error">
          {loadError} <Link to="/films">Back to films</Link>
        </Notice>
      </div>
    );
  if (!original) return <div className="page" aria-busy="true" />;

  const titleForHead = form.title.en || form.title.cs || (isNew ? "New film" : "Untitled film");
  const err = (k: keyof typeof problems) => (showErrors ? problems[k] : undefined);

  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/films">Films</Link>
        <span aria-hidden>/</span>
        <span>{isNew ? "New" : "Edit"}</span>
      </div>
      <div className="page-head">
        <h1>{titleForHead}</h1>
        {!isNew && original.status === "published" && (
          <a className="btn btn-quiet" href={`/preview/work/${id}.html`} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden /> Preview on site
          </a>
        )}
      </div>

      <div className="editor-grid">
        <section className="editor-media" aria-label="Poster and video">
          <div className="stage-tabs">
            {form.video ? (
              <Segmented
                label="Show"
                value={stageView}
                onChange={setStageView}
                options={[
                  { value: "poster", label: "Poster" },
                  { value: "video", label: "Video" },
                ]}
              />
            ) : (
              <h2 style={{ fontSize: "0.9375rem" }}>Poster</h2>
            )}
            <span className="spacer" />
            {stageView === "poster" && form.poster && (
              <Button size="sm" variant="quiet" icon={<ImageOff aria-hidden />} onClick={() => set("poster", "")}>
                Remove poster
              </Button>
            )}
            {stageView === "video" && form.video && (
              <Button size="sm" variant="quiet" icon={<Trash2 aria-hidden />} onClick={() => (set("video", ""), setStageView("poster"))}>
                Remove video
              </Button>
            )}
          </div>

          {stageView === "video" && form.video ? (
            <FrameGrabber
              video={form.video}
              poster={form.poster}
              onGrab={async (t) => {
                const { path } = await api.grabFrame(form.video, t, hint);
                set("poster", path);
                toast(`Poster set from ${timecode(t)}`);
              }}
            />
          ) : (
            <div className="stage">
              {form.poster ? (
                <img src={previewUrl(form.poster)} alt="Poster" />
              ) : (
                <div className="stage-empty">
                  <ImageOff aria-hidden />
                  <span>No poster yet</span>
                  <span className="faint" style={{ fontSize: "0.75rem" }}>
                    {form.video ? "Upload an image, or switch to Video and pick a frame." : "Upload an image, or add a video and pick a frame from it."}
                  </span>
                </div>
              )}
            </div>
          )}
          {err("poster") && <span className="field-error">{err("poster")}</span>}

          <DropZone accept="image/jpeg,image/png,image/webp" onFile={uploadPoster} busy={posterBusy} icon={<ImagePlus aria-hidden />}>
            <strong>{form.poster ? "Replace poster" : "Upload a poster"}</strong>
            <small>JPG, PNG or WebP. It’s resized for the web automatically; 16:9 looks best.</small>
          </DropZone>

          <VideoPanel task={videoTask} hasVideo={!!form.video} videoPath={form.video} onFile={uploadVideo} onDismiss={() => setVideoTask(null)} />
        </section>

        <section className="form-sections" aria-label="Film details">
          <div className="form-section">
            <h2>On the website</h2>
            <div className="status-row">
              <Segmented
                accent
                label="Status"
                value={form.status}
                onChange={(v) => set("status", v)}
                options={[
                  { value: "draft", label: "Draft" },
                  { value: "published", label: "Published" },
                ]}
              />
              <Switch checked={form.featured} onChange={(v) => set("featured", v)} label="Homepage film" />
            </div>
            <p className="faint" style={{ fontSize: "0.8125rem" }}>
              {form.status === "draft" ? "Drafts are only visible here in the editor." : "Shown on the Work page, with its own page to share."}
              {form.featured && " The homepage’s “From the portfolio” section shows this film; only one film can be there."}
              {form.featured && form.status === "draft" && " While it’s a draft, the homepage keeps showing the previous film."}
            </p>
          </div>

          <div className="form-section">
            <h2>Title</h2>
            <div className="two-col">
              <Field label="Title" lang="CZ" error={err("titleCs")}>
                <input className="input" value={form.title.cs} onChange={(e) => setLang("title", "cs", e.target.value)} aria-invalid={!!err("titleCs")} />
              </Field>
              <Field label="Title" lang="EN" error={err("titleEn")}>
                <input className="input" value={form.title.en} onChange={(e) => setLang("title", "en", e.target.value)} aria-invalid={!!err("titleEn")} />
              </Field>
            </div>
          </div>

          <div className="form-section">
            <h2>Details</h2>
            <div className="three-col">
              <CategoryPicker categories={categories} value={form.categoryId} onChange={(v) => set("categoryId", v)} onCreated={(c) => setCategories((cs) => [...cs, c])} error={err("category")} />
              <Field label="Year" error={err("year")}>
                <input
                  className="input tabular"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder={`e.g. ${new Date().getFullYear()}`}
                  value={form.year ?? ""}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, "").slice(0, 4);
                    set("year", digits ? Number(digits) : null);
                  }}
                  aria-invalid={!!err("year")}
                />
              </Field>
              <Field label="Client" hint="Optional. Shown on the film’s own page.">
                <input className="input" value={form.client} onChange={(e) => set("client", e.target.value)} />
              </Field>
            </div>
            <p className="faint" style={{ fontSize: "0.8125rem" }}>
              The website shows the category and year above the title, e.g. “{categories.find((c) => c.id === form.categoryId)?.name.cs || "Reklama"}{form.year ? ` · ${form.year}` : ""}”.
            </p>
          </div>

          <div className="form-section">
            <h2>Description</h2>
            <div className="two-col">
              <Field label="Description" lang="CZ">
                <textarea className="textarea" rows={5} value={form.description.cs} onChange={(e) => setLang("description", "cs", e.target.value)} />
              </Field>
              <Field label="Description" lang="EN">
                <textarea className="textarea" rows={5} value={form.description.en} onChange={(e) => setLang("description", "en", e.target.value)} />
              </Field>
            </div>
          </div>

          {saveError && <Notice kind="error">{saveError}</Notice>}

          {isNew && !dirty && (
            <div>
              <Button variant="primary" onClick={save} loading={saving}>
                Save draft
              </Button>
            </div>
          )}

          {!isNew && (
            <div className="danger-zone">
              <p>Delete this film from the portfolio.</p>
              <Button variant="danger" icon={<Trash2 aria-hidden />} onClick={remove}>
                Delete film
              </Button>
            </div>
          )}
        </section>
      </div>

      {(dirty || (isNew && saveError)) && (
        <SaveBar
          label={isNew ? "New film, not saved yet" : "Unsaved changes"}
          saving={saving}
          onSave={save}
          onDiscard={() => {
            setForm(original);
            setShowErrors(false);
            setSaveError("");
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function DropZone({ accept, onFile, busy, icon, children }: { accept: string; onFile: (f: File) => void; busy?: boolean; icon: ReactNode; children: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`drop ${over ? "is-over" : ""}`}
      role="button"
      tabIndex={0}
      aria-busy={busy}
      onClick={() => !busy && input.current?.click()}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.current?.click())}
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f && !busy) onFile(f);
      }}
    >
      {busy ? <Upload aria-hidden /> : icon}
      {busy ? <strong>Uploading…</strong> : children}
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function VideoPanel({ task, hasVideo, videoPath, onFile, onDismiss }: { task: VideoTask | null; hasVideo: boolean; videoPath: string; onFile: (f: File) => void; onDismiss: () => void }) {
  if (task && task.phase !== "error") {
    const label = task.phase === "uploading" ? "Uploading" : task.phase === "encoding" ? "Preparing for the web" : "Making it smaller for GitHub";
    return (
      <div className="progress" aria-live="polite">
        <div className="progress-top">
          <strong>{label}</strong>
          <span className="faint">{task.name}</span>
          <span className="tabular">{Math.round(task.progress * 100)}%</span>
        </div>
        <div className={`bar ${task.phase !== "uploading" && task.progress === 0 ? "indeterminate" : ""}`}>
          <i style={{ ["--p" as string]: Math.max(0.02, task.progress) }} />
        </div>
        <span className="faint" style={{ fontSize: "0.75rem" }}>
          {task.phase === "uploading"
            ? `${formatBytes(task.size)} master file. Keep this page open.`
            : "Converting to a web-friendly MP4 (up to 1080p). Long films take a few minutes."}
        </span>
        {task.phase === "uploading" && (
          <div>
            <Button size="sm" variant="quiet" onClick={task.cancel}>
              Cancel upload
            </Button>
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      {task?.phase === "error" && (
        <Notice kind="error">
          {task.message}{" "}
          <button type="button" className="btn btn-sm btn-quiet" onClick={onDismiss}>
            Dismiss
          </button>
        </Notice>
      )}
      <DropZone accept="video/*,.mov,.mp4,.m4v,.mkv" onFile={onFile} icon={<VideoIcon aria-hidden />}>
        <strong>{hasVideo ? "Replace video" : "Add a video"}</strong>
        <small>Drop the master file (MOV, MP4…). It’s converted for the web automatically.</small>
        {hasVideo && (
          <small className="mono" style={{ color: "var(--text-2)" }}>
            {videoPath.split("/").pop()}
          </small>
        )}
      </DropZone>
    </>
  );
}

function FrameGrabber({ video, poster, onGrab }: { video: string; poster: string; onGrab: (t: number) => Promise<void> }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(0);
  const [busy, setBusy] = useState(false);
  return (
    <div className="scrubber">
      <div className="stage">
        <video
          ref={ref}
          src={previewUrl(video)}
          poster={poster ? previewUrl(poster) : undefined}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        />
      </div>
      <div className="scrubber-row">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.04}
          value={t}
          aria-label="Choose a frame"
          onChange={(e) => {
            const v = Number(e.target.value);
            setT(v);
            if (ref.current) {
              ref.current.pause();
              ref.current.currentTime = v;
            }
          }}
        />
        <span className="timecode">{timecode(t)}</span>
        <Button
          size="sm"
          variant="primary"
          icon={<Camera aria-hidden />}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onGrab(ref.current?.currentTime ?? t);
            } finally {
              setBusy(false);
            }
          }}
        >
          Use this frame as poster
        </Button>
      </div>
    </div>
  );
}

function CategoryPicker({ categories, value, onChange, onCreated, error }: { categories: Category[]; value: string; onChange: (v: string) => void; onCreated: (c: Category) => void; error?: string }) {
  const [creating, setCreating] = useState(false);
  const [cs, setCs] = useState("");
  const [en, setEn] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const toast = useToast();

  if (creating)
    return (
      <div className="field" style={{ gridColumn: "1 / -1" }}>
        <span className="field-label">New category</span>
        <div className="two-col">
          <input className="input" placeholder="Czech name" value={cs} onChange={(e) => setCs(e.target.value)} autoFocus aria-label="Category name in Czech" />
          <input className="input" placeholder="English name" value={en} onChange={(e) => setEn(e.target.value)} aria-label="Category name in English" />
        </div>
        {msg && <span className="field-error">{msg}</span>}
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            onClick={async () => {
              if (!cs.trim() || !en.trim()) return setMsg("Fill in both languages.");
              setBusy(true);
              try {
                const c = await api.createCategory({ cs: cs.trim(), en: en.trim() });
                onCreated(c);
                onChange(c.id);
                setCreating(false);
                setCs("");
                setEn("");
                toast("Category added");
              } catch (err: any) {
                setMsg(err.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Add category
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setCreating(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );

  return (
    <Field label="Category" error={error}>
      <select
        className="select"
        value={value}
        aria-invalid={!!error}
        onChange={(e) => (e.target.value === "__new" ? setCreating(true) : onChange(e.target.value))}
      >
        <option value="">Choose…</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name.en}
          </option>
        ))}
        <option value="__new">New category…</option>
      </select>
    </Field>
  );
}
