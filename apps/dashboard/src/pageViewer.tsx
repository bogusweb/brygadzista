import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Api } from "./api";
import { PageImage } from "./PageImage";

type OpenPage = { documentId: string; pageNo: number };

type PageViewer = { open: (documentId: string, pageNo: number) => void };

const PageViewerContext = createContext<PageViewer | null>(null);

export const usePageViewer = () => {
  const viewer = useContext(PageViewerContext);
  if (!viewer) throw new Error("usePageViewer needs a PageViewerProvider");
  return viewer;
};

// Full-screen page preview shared by the chat's page cards and its "str. N" source links.
export const PageViewerProvider = ({ api, children }: { api: Api; children: ReactNode }) => {
  const [page, setPage] = useState<OpenPage | null>(null);
  const [pageCounts, setPageCounts] = useState<Record<string, number>>({});
  const open = useCallback((documentId: string, pageNo: number) => setPage({ documentId, pageNo }), []);
  const viewer = useMemo(() => ({ open }), [open]);
  const close = () => setPage(null);

  const documentId = page?.documentId;
  useEffect(() => {
    if (!documentId || pageCounts[documentId] !== undefined) return;
    api
      .listPages(documentId)
      .then((pages) => setPageCounts((counts) => ({ ...counts, [documentId]: pages.length })))
      .catch(() => undefined);
  }, [api, documentId, pageCounts]);
  const lastPage = documentId ? pageCounts[documentId] : undefined;
  const step = useCallback(
    (delta: number) =>
      setPage((current) => {
        if (!current) return current;
        const pageNo = current.pageNo + delta;
        if (pageNo < 1 || (lastPage !== undefined && pageNo > lastPage)) return current;
        return { ...current, pageNo };
      }),
    [lastPage],
  );

  useEffect(() => {
    if (!page) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPage(null);
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, step]);

  return (
    <PageViewerContext.Provider value={viewer}>
      {children}
      {page && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={`Strona ${page.pageNo}`} onClick={close}>
          <div className="lightbox-bar" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="button ghost"
              disabled={page.pageNo <= 1}
              onClick={() => step(-1)}
            >
              Poprzednia
            </button>
            <span className="tabular small">
              Strona {page.pageNo}
              {lastPage !== undefined && ` z ${lastPage}`}
            </span>
            <button
              type="button"
              className="button ghost"
              disabled={lastPage !== undefined && page.pageNo >= lastPage}
              onClick={() => step(1)}
            >
              Następna
            </button>
            <a
              className="button ghost"
              href={api.pageImageUrl(page.documentId, page.pageNo)}
              target="_blank"
              rel="noreferrer"
            >
              Otwórz w karcie
            </a>
            <button type="button" className="button primary close" onClick={close} autoFocus>
              Zamknij
            </button>
          </div>
          <div className="lightbox-stage" onClick={(event) => event.stopPropagation()}>
            <PageImage
              key={`${page.documentId}-${page.pageNo}`}
              className="lightbox-image"
              src={api.pageImageUrl(page.documentId, page.pageNo)}
              alt={`Strona ${page.pageNo}`}
            />
          </div>
        </div>
      )}
    </PageViewerContext.Provider>
  );
};
