import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, Film as FilmIcon, GripVertical, ImageOff, LayoutGrid, Pencil, Plus, Rows3, Search, Star, Trash2, Video, X } from "lucide-react";
import { api, previewUrl, type Category, type Film, type MediaFile, type Portfolio } from "../api.ts";
import { usePublish } from "../shell.tsx";
import { Button, Field, Notice, Segmented, formatBytes, timeAgo, useConfirm, useToast } from "../ui.tsx";

type View = "grid" | "table";
type StatusFilter = "all" | "published" | "draft";

const readView = (): View => {
  try {
    return localStorage.getItem("films-view") === "table" ? "table" : "grid";
  } catch {
    return "grid";
  }
};

export function FilmsPage() {
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>(readView);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [category, setCategory] = useState("all");
  const [activeId, setActiveId] = useState<string | null>(null);
  const toast = useToast();
  const { refresh } = usePublish();
  const navigate = useNavigate();

  const load = () => api.films().then(setData, (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("films-view", view);
    } catch {}
  }, [view]);

  const catName = (id: string) => data?.categories.find((c) => c.id === id)?.name.en ?? "";
  const filtering = query.trim() !== "" || status !== "all" || category !== "all";
  const visible = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.projects.filter(
      (f) =>
        (status === "all" || f.status === status) &&
        (category === "all" || f.categoryId === category) &&
        (!q || [f.title.cs, f.title.en, f.client].some((s) => s.toLowerCase().includes(q))),
    );
  }, [data, query, status, category]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = async (e: DragEndEvent) => {
    setActiveId(null);
    if (!data || !e.over || e.active.id === e.over.id) return;
    const ids = data.projects.map((p) => p.id);
    const next = arrayMove(data.projects, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    const before = data;
    setData({ ...data, projects: next });
    try {
      await api.reorderFilms(next.map((p) => p.id));
      toast("Order saved");
      refresh();
    } catch (err: any) {
      setData(before);
      toast(err.message, "error");
    }
  };

  const feature = async (film: Film) => {
    if (film.featured) return;
    try {
      await api.updateFilm(film.id, { featured: true });
      await load();
      toast(`“${film.title.en || film.title.cs}” is now the homepage film`);
      refresh();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const counts = data
    ? { all: data.projects.length, published: data.projects.filter((p) => p.status === "published").length, draft: data.projects.filter((p) => p.status === "draft").length }
    : null;

  return (
    <div className="page">
      <div className="page-head">
        <h1>
          Films
          {counts && <span className="count tabular">{counts.all}</span>}
        </h1>
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => navigate("/films/new")}>
          New film
        </Button>
      </div>

      {error && <Notice kind="error">{error}</Notice>}

      <div className="films-layout">
        <section aria-label="Film list">
          {data && data.projects.length > 0 && (
            <div className="toolbar">
              <div className="search">
                <Search aria-hidden />
                <input className="input" type="search" placeholder="Search films" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search films" />
              </div>
              <Segmented<StatusFilter>
                label="Filter by status"
                value={status}
                onChange={setStatus}
                options={[
                  { value: "all", label: "All" },
                  { value: "published", label: <>Published <span className="faint tabular">{counts?.published}</span></> },
                  { value: "draft", label: <>Drafts <span className="faint tabular">{counts?.draft}</span></> },
                ]}
              />
              {data.categories.length > 1 && (
                <select className="select" style={{ width: "auto", height: 36, borderRadius: 99 }} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
                  <option value="all">All categories</option>
                  {data.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name.en}
                    </option>
                  ))}
                </select>
              )}
              <span className="spacer" />
              <Segmented<View>
                label="Layout"
                value={view}
                onChange={setView}
                options={[
                  { value: "grid", label: <><LayoutGrid aria-hidden /> Grid</>, title: "Poster grid" },
                  { value: "table", label: <><Rows3 aria-hidden /> List</>, title: "Detailed list" },
                ]}
              />
            </div>
          )}

          {!data && !error && <SkeletonGrid />}

          {data && data.projects.length === 0 && (
            <div className="empty">
              <FilmIcon aria-hidden />
              <h2>Your first film goes here</h2>
              <p>Add a film with its poster and video. Save it as a draft while you work on it; it only appears on the website once you publish it.</p>
              <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => navigate("/films/new")}>
                New film
              </Button>
            </div>
          )}

          {data && data.projects.length > 0 && visible.length === 0 && (
            <div className="empty">
              <h2>No films match</h2>
              <p>Nothing matches these filters.</p>
              <Button onClick={() => (setQuery(""), setStatus("all"), setCategory("all"))}>Clear filters</Button>
            </div>
          )}

          {data && visible.length > 0 && (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
              <SortableContext items={visible.map((f) => f.id)} strategy={view === "grid" ? rectSortingStrategy : verticalListSortingStrategy} disabled={filtering}>
                {view === "grid" ? (
                  <div className="film-grid">
                    {visible.map((f) => (
                      <FilmCard key={f.id} film={f} category={catName(f.categoryId)} onFeature={() => feature(f)} sortable={!filtering} />
                    ))}
                  </div>
                ) : (
                  <FilmTable films={visible} catName={catName} onFeature={feature} sortable={!filtering} />
                )}
              </SortableContext>
              <DragOverlay>
                {activeId && view === "grid" && data.projects.find((f) => f.id === activeId) ? (
                  <FilmCardBody film={data.projects.find((f) => f.id === activeId)!} category={catName(data.projects.find((f) => f.id === activeId)!.categoryId)} overlay />
                ) : null}
              </DragOverlay>
            </DndContext>
          )}

          {data && data.projects.length > 1 && (
            <p className="faint" style={{ marginTop: 18, fontSize: "0.8125rem" }}>
              {filtering ? "Clear the filters to change the order." : "Drag films by their handle to set the order they appear in on the website."}
            </p>
          )}
        </section>

        <aside className="rail" aria-label="Categories and files">
          {data && <CategoriesPanel data={data} onChange={load} />}
          <UnusedMediaPanel />
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- grid

function FilmCard({ film, category, onFeature, sortable }: { film: Film; category: string; onFeature: () => void; sortable: boolean }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: film.id, disabled: !sortable });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div ref={setNodeRef} style={style} className={isDragging ? "is-dragging" : ""}>
      <FilmCardBody
        film={film}
        category={category}
        actions={
          <>
            <button type="button" className={`btn btn-sm btn-icon ${film.featured ? "is-on" : ""}`} onClick={onFeature} title={film.featured ? "This is the homepage film" : "Show on the homepage"} aria-pressed={film.featured}>
              <Star aria-hidden fill={film.featured ? "currentColor" : "none"} />
              <span className="sr-only">{film.featured ? "Homepage film" : "Make homepage film"}</span>
            </button>
            {sortable && (
              <button type="button" ref={setActivatorNodeRef} className="btn btn-sm btn-icon drag-handle" title="Drag to reorder" {...attributes} {...listeners}>
                <GripVertical aria-hidden />
                <span className="sr-only">Reorder {film.title.en}</span>
              </button>
            )}
          </>
        }
      />
    </div>
  );
}

function FilmCardBody({ film, category, actions, overlay }: { film: Film; category: string; actions?: ReactNode; overlay?: boolean }) {
  const title = film.title.en || film.title.cs || "Untitled film";
  return (
    <article className={`film-card ${film.status === "draft" ? "is-draft" : ""} ${overlay ? "is-overlay" : ""}`}>
      <Link to={`/films/${film.id}`} aria-label={`Edit ${title}`}>
        <div className="film-thumb">
          {film.poster ? (
            <img src={previewUrl(film.poster)} alt="" loading="lazy" />
          ) : (
            <div className="no-poster">
              <div>
                <ImageOff aria-hidden />
                No poster yet
              </div>
            </div>
          )}
          <div className="thumb-badges">
            {film.featured && (
              <span className="chip featured">
                <Star aria-hidden fill="currentColor" /> Homepage
              </span>
            )}
            {film.status === "draft" && <span className="chip draft">Draft</span>}
          </div>
        </div>
      </Link>
      {actions && <div className="thumb-actions">{actions}</div>}
      <div className="film-meta">
        <Link to={`/films/${film.id}`} className="film-title" tabIndex={-1}>
          {title}
        </Link>
        <span className="film-sub">{[category, film.year, film.client].filter(Boolean).join(" · ") || "No category yet"}</span>
      </div>
    </article>
  );
}

function SkeletonGrid() {
  return (
    <div className="film-grid" aria-busy="true" aria-label="Loading films">
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ display: "grid", gap: 10 }}>
          <div className="skeleton" style={{ aspectRatio: "16/9" }} />
          <div className="skeleton" style={{ height: 16, width: "60%" }} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- table

function FilmTable({ films, catName, onFeature, sortable }: { films: Film[]; catName: (id: string) => string; onFeature: (f: Film) => void; sortable: boolean }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th className="handle-cell">
            <span className="sr-only">Order</span>
          </th>
          <th className="thumb-cell">
            <span className="sr-only">Poster</span>
          </th>
          <th>Title</th>
          <th className="hide-sm">Category</th>
          <th className="num hide-sm">Year</th>
          <th>Status</th>
          <th className="hide-sm">Video</th>
          <th className="hide-sm">Edited</th>
          <th>
            <span className="sr-only">Homepage</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {films.map((f) => (
          <FilmRow key={f.id} film={f} category={catName(f.categoryId)} onFeature={() => onFeature(f)} sortable={sortable} />
        ))}
      </tbody>
    </table>
  );
}

function FilmRow({ film, category, onFeature, sortable }: { film: Film; category: string; onFeature: () => void; sortable: boolean }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: film.id, disabled: !sortable });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition, position: "relative", zIndex: isDragging ? 2 : undefined, background: isDragging ? "var(--ink-2)" : undefined };
  return (
    <tr ref={setNodeRef} style={style}>
      <td className="handle-cell">
        {sortable && (
          <button type="button" ref={setActivatorNodeRef} className="icon-toggle drag-handle" title="Drag to reorder" {...attributes} {...listeners}>
            <GripVertical aria-hidden />
            <span className="sr-only">Reorder {film.title.en}</span>
          </button>
        )}
      </td>
      <td className="thumb-cell">
        <div className="film-thumb">{film.poster ? <img src={previewUrl(film.poster)} alt="" loading="lazy" /> : null}</div>
      </td>
      <td className="title-cell">
        <Link to={`/films/${film.id}`}>{film.title.en || film.title.cs || "Untitled film"}</Link>
        {film.title.cs && film.title.cs !== film.title.en && <span className="faint">{film.title.cs}</span>}
      </td>
      <td className="hide-sm muted">{category || <span className="faint">None</span>}</td>
      <td className="num tabular hide-sm muted">{film.year ?? ""}</td>
      <td>
        <span className={`status ${film.status}`}>{film.status === "published" ? "Published" : "Draft"}</span>
      </td>
      <td className="hide-sm">{film.video ? <Video aria-label="Has video" size={17} className="muted" /> : <span className="faint">Poster only</span>}</td>
      <td className="hide-sm faint">{timeAgo(film.updatedAt)}</td>
      <td>
        <button type="button" className="icon-toggle" aria-pressed={film.featured} onClick={onFeature} title={film.featured ? "This is the homepage film" : "Show on the homepage"}>
          <Star aria-hidden fill={film.featured ? "currentColor" : "none"} />
          <span className="sr-only">{film.featured ? "Homepage film" : "Make homepage film"}</span>
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------- categories

function CategoriesPanel({ data, onChange }: { data: Portfolio; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const { refresh } = usePublish();
  const count = (id: string) => data.projects.filter((p) => p.categoryId === id).length;

  const remove = async (c: Category) => {
    const n = count(c.id);
    if (n > 0) {
      toast(`“${c.name.en}” is used by ${n} film${n > 1 ? "s" : ""}. Move ${n > 1 ? "them" : "it"} to another category first.`, "error");
      return;
    }
    if (!(await confirm({ title: `Delete “${c.name.en}”?`, confirm: "Delete category", danger: true }))) return;
    try {
      await api.deleteCategory(c.id);
      toast("Category deleted");
      onChange();
      refresh();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  return (
    <section className="panel" aria-labelledby="cat-head">
      <div className="panel-head">
        <h2 id="cat-head">Categories</h2>
        {!adding && (
          <Button size="sm" variant="quiet" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
            Add
          </Button>
        )}
      </div>
      <div className="panel-body" style={{ paddingTop: 6, paddingBottom: 10 }}>
        {data.categories.length === 0 && !adding && <p className="muted" style={{ padding: "8px 0" }}>Categories group films, like “Advertisement” or “Short film”. The category shows above each film’s title on the website.</p>}
        {data.categories.map((c) =>
          editing === c.id ? (
            <CategoryForm
              key={c.id}
              initial={c.name}
              submitLabel="Save"
              onCancel={() => setEditing(null)}
              onSubmit={async (name) => {
                await api.updateCategory(c.id, name);
                setEditing(null);
                toast("Category renamed");
                onChange();
                refresh();
              }}
            />
          ) : (
            <div className="cat-row" key={c.id}>
              <div className="cat-names">
                <strong>{c.name.en}</strong>
                <span>{c.name.cs}</span>
              </div>
              <span className="cat-count tabular" title="Films in this category">
                {count(c.id)}
              </span>
              <Button size="sm" variant="quiet" iconOnly icon={<Pencil aria-hidden />} onClick={() => setEditing(c.id)}>
                Rename {c.name.en}
              </Button>
              <Button size="sm" variant="quiet" iconOnly icon={<Trash2 aria-hidden />} onClick={() => remove(c)}>
                Delete {c.name.en}
              </Button>
            </div>
          ),
        )}
        {adding && (
          <CategoryForm
            submitLabel="Add category"
            onCancel={() => setAdding(false)}
            onSubmit={async (name) => {
              await api.createCategory(name);
              setAdding(false);
              toast("Category added");
              onChange();
              refresh();
            }}
          />
        )}
      </div>
    </section>
  );
}

function CategoryForm({ initial, submitLabel, onSubmit, onCancel }: { initial?: { cs: string; en: string }; submitLabel: string; onSubmit: (n: { cs: string; en: string }) => Promise<void>; onCancel: () => void }) {
  const [cs, setCs] = useState(initial?.cs ?? "");
  const [en, setEn] = useState(initial?.en ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!cs.trim() || !en.trim()) return setError("Fill in both languages.");
    setBusy(true);
    try {
      await onSubmit({ cs: cs.trim(), en: en.trim() });
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <form className="cat-form" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <Field label="Name" lang="CZ">
        <input className="input" value={cs} onChange={(e) => setCs(e.target.value)} autoFocus placeholder="Reklama" />
      </Field>
      <Field label="Name" lang="EN" error={error}>
        <input className="input" value={en} onChange={(e) => setEn(e.target.value)} placeholder="Advertisement" />
      </Field>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button size="sm" variant="quiet" icon={<X aria-hidden />} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" icon={<Check aria-hidden />} loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- unused files

function UnusedMediaPanel() {
  const [files, setFiles] = useState<MediaFile[] | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const { refresh } = usePublish();
  const load = () => api.media().then((all) => setFiles(all.filter((m) => m.usedBy.length === 0)), () => setFiles([]));
  useEffect(() => {
    load();
  }, []);

  if (!files || files.length === 0) return null;
  const total = files.reduce((n, f) => n + f.bytes, 0);

  const remove = async (f: MediaFile) => {
    if (!(await confirm({ title: "Delete this file?", body: `${f.path.split("/").pop()} isn’t used by any film. A backup copy is kept in the editor’s backups folder.`, confirm: "Delete file", danger: true }))) return;
    try {
      await api.deleteMedia(f.path);
      toast("File deleted");
      load();
      refresh();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  return (
    <section className="panel" aria-labelledby="media-head">
      <div className="panel-head">
        <h2 id="media-head">Unused files</h2>
        <span className="faint tabular" style={{ fontSize: "0.75rem" }}>
          {formatBytes(total)}
        </span>
      </div>
      <div className="panel-body" style={{ paddingTop: 6, paddingBottom: 10 }}>
        <p className="faint" style={{ fontSize: "0.75rem", paddingBottom: 6 }}>
          Old posters and videos no film uses anymore. They still get uploaded with the site until you delete them.
        </p>
        {files.map((f) => (
          <div className="media-row" key={f.path}>
            {f.kind === "image" ? (
              <img className="media-thumb" src={previewUrl(f.path)} alt="" loading="lazy" />
            ) : (
              <span className="media-thumb">
                <Video aria-hidden />
              </span>
            )}
            <div className="media-name">
              <span className="mono" title={f.path}>
                {f.path.split("/").pop()}
              </span>
              <span className="faint">{formatBytes(f.bytes)}</span>
            </div>
            <Button size="sm" variant="quiet" iconOnly icon={<Trash2 aria-hidden />} onClick={() => remove(f)}>
              Delete {f.path}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
