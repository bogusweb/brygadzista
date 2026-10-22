import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { ApiError, type Api, type Project, type ProjectDocument } from "./api";
import { dateFormat, errorMessage, formatBytes, formatDuration, formatUsd, pluralize } from "./format";
import { PageViewerProvider } from "./pageViewer";
import { QuestionsPanel } from "./questions";
import { routeHref } from "./route";
import { BuildingTypeCard } from "./BuildingTypeCard";
import { SiteCard } from "./SiteCard";

type Props = { api: Api; projectId: string; onUnauthorized: () => void };

type Upload = { name: string; size: number; progress: number; cancel: () => void };

const POLL_MS = 3000;

const busyStatuses = new Set<ProjectDocument["status"]>(["uploading", "queued", "processing"]);

const pagesLabel = (count: number) => pluralize(count, "strona", "strony", "stron");

const estimateText = (doc: ProjectDocument) => {
  if (!doc.estimate) return pagesLabel(doc.pageCount);
  const { costUsd, seconds, vision } = doc.estimate;
  const cost = vision ? `koszt ok. ${formatUsd(costUsd)}` : "bez wyszukiwania AI, tylko tekst z PDF";
  return `${pagesLabel(doc.pageCount)} · ${cost} · potrwa ok. ${formatDuration(seconds)}`;
};

const runProgress = (doc: ProjectDocument) =>
  doc.progress ? { done: doc.progress.done, total: doc.progress.total } : { done: doc.indexedPages, total: doc.pageCount };

const statusText = (doc: ProjectDocument) => {
  switch (doc.status) {
    case "uploading":
      return "Wysyłanie pliku…";
    case "awaiting_start":
      return `Czeka na start: ${estimateText(doc)}`;
    case "queued":
      return "W kolejce do indeksowania";
    case "processing": {
      const { done, total } = runProgress(doc);
      if (total === 0) return "Odczytuję strony…";
      const eta = doc.progress ? ` · zostało ok. ${formatDuration(doc.progress.etaSeconds)}` : "";
      return `Indeksowanie: ${done} z ${total}${eta}`;
    }
    case "paused": {
      const { done, total } = runProgress(doc);
      return total > 0 ? `Wstrzymano po ${done} z ${total} stron` : "Wstrzymano";
    }
    case "ready":
      return doc.failedPages
        ? `Gotowy · ${pagesLabel(doc.pageCount)}, ${pluralize(doc.failedPages, "strona", "strony", "stron")} z błędem`
        : `Gotowy · ${pagesLabel(doc.pageCount)}`;
    case "error":
      return "Indeksowanie przerwane";
  }
};

// Resume takes only the pages that are not done, so it is offered whenever some are left: after a pause, an error,
// or failed pages.
const canResume = (doc: ProjectDocument) =>
  doc.status === "paused" || doc.status === "error" || (doc.status === "ready" && (doc.failedPages ?? 0) > 0);

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

  const runAction = async (doc: ProjectDocument, action: (id: string) => Promise<unknown>) => {
    setPendingAction(doc.id);
    try {
      await action(doc.id);
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
        <a className="button" href={routeHref({ screen: "chat", projectId })}>
          Zapytaj agenta
        </a>
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
                    <span className={`small ${doc.status === "error" || doc.status === "paused" || doc.failedPages ? "danger-text" : "muted"}`}>
                      {statusText(doc)} · dodano {dateFormat.format(new Date(doc.createdAt))}
                    </span>
                  </div>
                  <div className="actions">
                    {doc.status === "awaiting_start" && (
                      <button
                        type="button"
                        className="button primary"
                        disabled={pending}
                        onClick={() => void runAction(doc, api.startDocument)}
                      >
                        Rozpocznij indeksowanie
                      </button>
                    )}
                    {canResume(doc) && (
                      <button
                        type="button"
                        className="button primary"
                        disabled={pending}
                        onClick={() => void runAction(doc, api.resumeDocument)}
                      >
                        Wznów indeksowanie
                      </button>
                    )}
                    {!busy && doc.status !== "awaiting_start" && (
                      <button
                        type="button"
                        className="button ghost"
                        disabled={pending}
                        onClick={() => void runAction(doc, api.reindexDocument)}
                      >
                        Indeksuj ponownie
                      </button>
                    )}
                    <button type="button" className="button danger" disabled={pending} onClick={() => void remove(doc)}>
                      Usuń
                    </button>
                  </div>
                </div>
                {doc.status === "processing" && runProgress(doc).total > 0 && (
                  <progress
                    max={runProgress(doc).total}
                    value={runProgress(doc).done}
                    aria-label={`Indeksowanie ${doc.filename}`}
                  />
                )}
                {(doc.status === "error" || doc.status === "paused" || doc.status === "ready") && doc.error && (
                  <p className="error small">{doc.error}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <BuildingTypeCard api={api} projectId={projectId} />
      <SiteCard api={api} projectId={projectId} />

      <PageViewerProvider api={api}>
        <QuestionsPanel api={api} projectId={projectId} onUnauthorized={onUnauthorized} />
      </PageViewerProvider>
    </section>
  );
};
