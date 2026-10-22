import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, type Api, type Project } from "./api";
import { dateFormat, pluralize } from "./format";
import { routeHref } from "./route";

// `tenantId` limits the list to one firm (an operator sees every firm's projects); `firmNames` labels each project
// with its firm when an operator looks at all of them.
type Props = { api: Api; onUnauthorized: () => void; tenantId: string | null; firmNames: Map<string, string> | null };

const documentLabel = (count: number) => pluralize(count, "dokument", "dokumenty", "dokumentów");

export const ProjectsScreen = ({ api, onUnauthorized, tenantId, firmNames }: Props) => {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const handleError = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) return onUnauthorized();
      setError(cause instanceof Error ? cause.message : "Coś poszło nie tak. Spróbuj ponownie.");
    },
    [onUnauthorized],
  );

  const reload = useCallback(async () => {
    try {
      const all = await api.listProjects();
      setProjects(tenantId ? all.filter((project) => project.tenantId === tenantId) : all);
      setError(null);
    } catch (cause) {
      handleError(cause);
    }
  }, [api, handleError, tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      await api.createProject(name.trim());
      setName("");
      await reload();
    } catch (cause) {
      handleError(cause);
    } finally {
      setCreating(false);
    }
  };

  const remove = async (project: Project) => {
    const confirmed = window.confirm(
      `Usunąć projekt „${project.name}”? Razem z nim znikną ${documentLabel(project.documentCount)} i cały indeks. Tego nie da się cofnąć.`,
    );
    if (!confirmed) return;
    setPendingDelete(project.id);
    try {
      await api.deleteProject(project.id);
      await reload();
    } catch (cause) {
      handleError(cause);
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <section className="stack">
      <div className="section-head">
        <h1>Projekty</h1>
      </div>

      {firmNames ? (
        <p className="card muted">Widzisz budowy wszystkich firm. Żeby założyć nowy projekt, wybierz firmę w nagłówku.</p>
      ) : (
        <form className="card create-form" onSubmit={create}>
          <label className="field grow">
            <span>Nowy projekt</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="np. Dom jednorodzinny, ul. Lipowa 5"
            />
          </label>
          <button type="submit" className="button primary" disabled={creating || !name.trim()}>
            {creating ? "Tworzę…" : "Utwórz projekt"}
          </button>
        </form>
      )}

      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button type="button" className="link" onClick={() => void reload()}>
            Odśwież
          </button>
        </p>
      )}

      {projects === null ? (
        <ul className="list" aria-busy="true">
          {[0, 1, 2].map((key) => (
            <li key={key} className="card row skeleton" />
          ))}
        </ul>
      ) : projects.length === 0 ? (
        <div className="card empty">
          <h2>Nie ma jeszcze projektów</h2>
          <p className="muted">Utwórz pierwszy projekt powyżej, a potem wgraj do niego PDF z projektem technicznym.</p>
        </div>
      ) : (
        <ul className="list">
          {projects.map((project) => (
            <li key={project.id} className="card row">
              <div className="row-main">
                <a className="row-title" href={routeHref({ screen: "project", projectId: project.id })}>
                  {project.name}
                </a>
                <span className="muted small">
                  {firmNames && `${firmNames.get(project.tenantId) ?? "Inna firma"} · `}
                  {documentLabel(project.documentCount)} · utworzono {dateFormat.format(new Date(project.createdAt))}
                </span>
              </div>
              <button
                type="button"
                className="button danger"
                disabled={pendingDelete === project.id}
                onClick={() => void remove(project)}
              >
                {pendingDelete === project.id ? "Usuwam…" : "Usuń projekt"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
