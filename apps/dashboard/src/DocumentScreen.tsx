import { useCallback, useEffect, useState } from "react";
import { ApiError, type Api, type DocumentPage, type PageKind, type ProjectDocument } from "./api";
import { errorMessage, pluralize } from "./format";
import { PageImage } from "./PageImage";
import { routeHref } from "./route";

type Props = { api: Api; projectId: string; documentId: string; onUnauthorized: () => void };

const POLL_MS = 4000;

const kindLabels: Record<PageKind, string> = {
  opis: "Opis",
  rysunek: "Rysunek",
  detal: "Detal",
  zestawienie: "Zestawienie",
  formalne: "Formalne",
  inne: "Inne",
};

export const DocumentScreen = ({ api, projectId, documentId, onUnauthorized }: Props) => {
  const [document, setDocument] = useState<ProjectDocument | null>(null);
  const [pages, setPages] = useState<DocumentPage[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [docs, nextPages] = await Promise.all([api.listDocuments(projectId), api.listPages(documentId)]);
      setDocument(docs.find((doc) => doc.id === documentId) ?? null);
      setPages(nextPages);
      setError(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return onUnauthorized();
      setError(errorMessage(cause));
    }
  }, [api, projectId, documentId, onUnauthorized]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const indexing = document?.status === "queued" || document?.status === "processing";
  useEffect(() => {
    if (!indexing) return;
    const timer = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [indexing, reload]);

  const lastPage = pages?.length ?? 0;
  useEffect(() => {
    if (selected === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
      if (event.key === "ArrowLeft") setSelected((page) => (page && page > 1 ? page - 1 : page));
      if (event.key === "ArrowRight") setSelected((page) => (page && page < lastPage ? page + 1 : page));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, lastPage]);

  const page = pages?.find((candidate) => candidate.pageNo === selected);

  return (
    <section className="stack">
      <nav className="breadcrumbs small">
        <a href={routeHref({ screen: "projects" })}>Projekty</a>
        <span aria-hidden="true">/</span>
        <a href={routeHref({ screen: "project", projectId })}>Dokumenty</a>
      </nav>
      <div className="section-head">
        <h1>{document?.filename ?? "Dokument"}</h1>
        {document && (
          <p className="muted small">
            {pluralize(document.pageCount, "strona", "strony", "stron")}
            {indexing && ` · indeksowanie ${document.indexedPages} z ${document.pageCount}`}
          </p>
        )}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button type="button" className="link" onClick={() => void reload()}>
            Odśwież
          </button>
        </p>
      )}

      {page && (
        <article className="card viewer" aria-label={`Strona ${page.pageNo}`}>
          <div className="viewer-bar">
            <button
              type="button"
              className="button ghost"
              disabled={page.pageNo <= 1}
              onClick={() => setSelected(page.pageNo - 1)}
            >
              Poprzednia
            </button>
            <span className="tabular small">
              Strona {page.pageNo} z {lastPage}
            </span>
            <button
              type="button"
              className="button ghost"
              disabled={page.pageNo >= lastPage}
              onClick={() => setSelected(page.pageNo + 1)}
            >
              Następna
            </button>
            <button type="button" className="button ghost close" onClick={() => setSelected(null)}>
              Zamknij
            </button>
          </div>
          <div className="viewer-body">
            <a href={api.pageImageUrl(documentId, page.pageNo)} target="_blank" rel="noreferrer" className="viewer-image">
              <PageImage
                className="page-full"
                src={api.pageImageUrl(documentId, page.pageNo)}
                alt={`Strona ${page.pageNo}${page.title ? `: ${page.title}` : ""}`}
              />
            </a>
            <div className="viewer-index stack">
              <div>
                {page.kind && <span className="badge">{kindLabels[page.kind]}</span>}
                <h2>{page.title ?? `Strona ${page.pageNo}`}</h2>
              </div>
              {page.indexed ? (
                <>
                  {page.summary && <p>{page.summary}</p>}
                  {page.facts.length > 0 && (
                    <dl className="facts">
                      {page.facts.map((fact, index) => (
                        <div key={index}>
                          <dt className="muted small">{fact.label}</dt>
                          <dd>{fact.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </>
              ) : (
                <p className="muted">
                  Ta strona ma na razie tylko tekst z PDF, bez opisu AI. Opis pojawi się po indeksowaniu z kluczem
                  OpenRouter (przycisk „Indeksuj ponownie” na liście dokumentów).
                </p>
              )}
            </div>
          </div>
        </article>
      )}

      {pages === null ? (
        <ul className="thumbs" aria-busy="true">
          {[0, 1, 2, 3, 4, 5].map((key) => (
            <li key={key} className="thumb skeleton" />
          ))}
        </ul>
      ) : pages.length === 0 ? (
        <div className="card empty">
          <h2>Strony jeszcze się wczytują</h2>
          <p className="muted">Po odczytaniu PDF pojawią się tu miniatury wszystkich stron.</p>
        </div>
      ) : (
        <ul className="thumbs">
          {pages.map((candidate) => (
            <li key={candidate.pageNo}>
              <button
                type="button"
                className={`thumb${candidate.pageNo === selected ? " selected" : ""}`}
                aria-pressed={candidate.pageNo === selected}
                onClick={() => {
                  setSelected(candidate.pageNo);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              >
                <PageImage className="page-thumb" src={api.pageImageUrl(documentId, candidate.pageNo)} alt="" />
                <span className="thumb-caption small">
                  <span className="tabular">{candidate.pageNo}.</span> {candidate.title ?? (candidate.indexed ? "" : "bez opisu")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
