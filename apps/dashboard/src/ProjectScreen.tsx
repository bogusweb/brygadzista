import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { ApiError, type Api, type Project, type ProjectDocument } from "./api";
import { dateFormat, errorMessage, formatBytes, pluralize } from "./format";
import { routeHref } from "./route";

type Props = { api: Api; projectId: string; onUnauthorized: () => void };

type Upload = { name: string; size: number; progress: number; cancel: () => void };

const POLL_MS = 3000;

const busyStatuses = new Set<ProjectDocument["status"]>(["uploading", "queued", "processing"]);

const pagesLabel = (count: number) => pluralize(count, "strona", "strony", "stron");

const statusText = (doc: ProjectDocument) => {
  switch (doc.status) {
    case "uploading":
      return "Wysyłanie pliku…";
    case "queued":
      return "W kolejce do indeksowania";
    case "processing":
      return doc.pageCount > 0 ? `Indeksowanie: ${doc.indexedPages} z ${doc.pageCount}` : "Odczytuję strony…";
    case "ready":
      return `Gotowy · ${pagesLabel(doc.pageCount)}`;
    case "error":
      return "Indeksowanie przerwane";
  }
};

const isPdf = (file: File) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

export const ProjectScreen = ({ api, projectId, onUnauthorized }: Props) => {
  const [project, setProject] = useState<Project | null>(null);
  const [documents, setDocuments] = useState<ProjectDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleError = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) return onUnauthorized();
      setError(errorMessage(cause));
    },
    [onUnauthorized],
  );

  const reload = useCallback(async () => {
    try {
      const [projects, docs] = await Promise.all([api.listProjects(), api.listDocuments(projectId)]);
      setProject(projects.find((candidate) => candidate.id === projectId) ?? null);
      setDocuments(docs);
      setError(null);
    } catch (cause) {
      handleError(cause);
    }
  }, [api, projectId, handleError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const indexing = documents?.some((doc) => busyStatuses.has(doc.status)) ?? false;
  useEffect(() => {
    if (!indexing) return;
    const timer = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [indexing, reload]);

  const send = async (file: File) => {
    if (!isPdf(file)) {
      setError(`„${file.name}” nie jest plikiem PDF. Wybierz plik z rozszerzeniem .pdf.`);
      return;
    }
    setError(null);
    const { done, cancel } = api.uploadDocument(projectId, file, (progress) =>
      setUpload((current) => (current ? { ...current, progress } : current)),
    );
    setUpload({ name: file.name, size: file.size, progress: 0, cancel });
    try {
      await done;
    } catch (cause) {
      handleError(cause);
    } finally {
      setUpload(null);
      await reload();
    }
  };

  const pickFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void send(file);
  };

  const dropFile = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file && !upload) void send(file);
  };

  const reindex = async (doc: ProjectDocument) => {
    setPendingAction(doc.id);
    try {
      await api.reindexDocument(doc.id);
      await reload();
    } catch (cause) {
      handleError(cause);
    } finally {
      setPendingAction(null);
    }
  };

  const remove = async (doc: ProjectDocument) => {
    const confirmed = window.confirm(
      `Usunąć dokument „${doc.filename}”? Agent przestanie z niego korzystać, a indeks stron zniknie. Tego nie da się cofnąć.`,
    );
    if (!confirmed) return;
    setPendingAction(doc.id);
    try {
      await api.deleteDocument(doc.id);
      await reload();
    } catch (cause) {
      handleError(cause);
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <section className="stack">
      <nav className="breadcrumbs small">
        <a href={routeHref({ screen: "projects" })}>Projekty</a>
      </nav>
      <div className="section-head">
        <h1>{project?.name ?? "Projekt"}</h1>
      </div>

      <div
        className={`card dropzone${dragging ? " dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={dropFile}
      >
        {upload ? (
          <div className="upload">
            <div className="upload-head">
              <span className="row-title">{upload.name}</span>
              <span className="muted small tabular">
                {Math.round(upload.progress * 100)}% z {formatBytes(upload.size)}
              </span>
            </div>
            <progress max={1} value={upload.progress} aria-label={`Wysyłanie ${upload.name}`} />
            <div>
              <button type="button" className="button ghost" onClick={upload.cancel}>
                Anuluj wysyłanie
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="row-main">
              <span className="row-title">Wgraj projekt techniczny</span>
              <span className="muted small">Przeciągnij tu plik PDF albo wybierz go z dysku. Duże pliki też przejdą.</span>
            </div>
            <button type="button" className="button primary" onClick={() => fileInput.current?.click()}>
              Wybierz PDF
            </button>
          </>
        )}
        <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={pickFile} />
      </div>

      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button type="button" className="link" onClick={() => void reload()}>
            Odśwież
          </button>
        </p>
      )}

      {documents === null ? (
        <ul className="list" aria-busy="true">
          {[0, 1].map((key) => (
            <li key={key} className="card row skeleton" />
          ))}
        </ul>
      ) : documents.length === 0 ? (
        <div className="card empty">
          <h2>Brak dokumentów</h2>
          <p className="muted">Wgraj PDF powyżej. Po wysłaniu każda strona zostanie opisana i trafi do indeksu agenta.</p>
        </div>
      ) : (
        <ul className="list">
          {documents.map((doc) => {
            const busy = busyStatuses.has(doc.status);
            const pending = pendingAction === doc.id;
            return (
              <li key={doc.id} className="card doc">
                <div className="row">
                  <div className="row-main">
                    {doc.pageCount > 0 ? (
                      <a className="row-title" href={routeHref({ screen: "document", projectId, documentId: doc.id })}>
                        {doc.filename}
                      </a>
                    ) : (
                      <span className="row-title">{doc.filename}</span>
                    )}
                    <span className={`small ${doc.status === "error" ? "danger-text" : "muted"}`}>
                      {statusText(doc)} · dodano {dateFormat.format(new Date(doc.createdAt))}
                    </span>
                  </div>
                  <div className="actions">
                    {!busy && (
                      <button type="button" className="button ghost" disabled={pending} onClick={() => void reindex(doc)}>
                        Indeksuj ponownie
                      </button>
                    )}
                    <button type="button" className="button danger" disabled={pending} onClick={() => void remove(doc)}>
                      Usuń
                    </button>
                  </div>
                </div>
                {doc.status === "processing" && doc.pageCount > 0 && (
                  <progress
                    max={doc.pageCount}
                    value={doc.indexedPages}
                    aria-label={`Indeksowanie ${doc.filename}`}
                  />
                )}
                {doc.status === "error" && doc.error && <p className="error small">{doc.error}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
