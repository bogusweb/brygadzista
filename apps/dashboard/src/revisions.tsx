import { useEffect, useState } from "react";
import type { Api, FactChange, PageChange, Revision } from "./api";
import { dateFormat, errorMessage } from "./format";
import { usePageViewer } from "./pageViewer";

// Changes between versions of the project (#72): pages paired by drawing number, with parameters before and after.

const KIND_LABELS: Record<PageChange["kind"], string> = { changed: "Zmieniona", added: "Nowa strona", removed: "Usunięta" };

const factLine = ({ label, before, after }: FactChange) =>
  before && after ? `${label}: było ${before}, jest ${after}` : after ? `${label}: dodano ${after}` : `${label}: usunięto ${before}`;

const ChangeItem = ({ revision, change }: { revision: Revision; change: PageChange }) => {
  const viewer = usePageViewer();
  return (
    <li className="card change">
      <span className="badge">{KIND_LABELS[change.kind]}</span>
      <strong>{[change.drawingNo, change.title].filter(Boolean).join(" · ") || "Strona bez tytułu"}</strong>
      {change.facts.length > 0 && (
        <ul className="change-facts">
          {change.facts.map((fact, index) => (
            <li key={index}>{factLine(fact)}</li>
          ))}
        </ul>
      )}
      {change.facts.length === 0 && (change.linesAdded.length > 0 || change.linesRemoved.length > 0) && (
        <ul className="change-lines small">
          {change.linesAdded.map((line, index) => (
            <li key={`a${index}`} className="added">
              + {line}
            </li>
          ))}
          {change.linesRemoved.map((line, index) => (
            <li key={`r${index}`} className="removed">
              − {line}
            </li>
          ))}
        </ul>
      )}
      <div className="row-actions">
        {change.pageNo !== null && (
          <button type="button" className="link small" onClick={() => viewer.open(revision.documentId, change.pageNo!)}>
            Nowa wersja, str. {change.pageNo}
          </button>
        )}
        {change.previousPageNo !== null && (
          <button type="button" className="link small" onClick={() => viewer.open(revision.previousId, change.previousPageNo!)}>
            Poprzednia wersja, str. {change.previousPageNo}
          </button>
        )}
      </div>
    </li>
  );
};

export const RevisionsPanel = ({ api, projectId, reloadKey }: { api: Api; projectId: string; reloadKey: unknown }) => {
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listRevisions(projectId)
      .then((loaded) => {
        setRevisions(loaded);
        setError(null);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [api, projectId, reloadKey]);

  if (!revisions?.length && !error) return null;
  return (
    <section className="stack revisions">
      <h2>Zmiany między wersjami</h2>
      {error && <p className="error">{error}</p>}
      {revisions?.map((revision) => (
        <div key={revision.documentId} className="stack">
          <p className="muted small">
            „{revision.filename}” to nowa wersja „{revision.previousFilename}” z {dateFormat.format(new Date(revision.createdAt))}:{" "}
            {revision.changedPages ? `zmienione strony: ${revision.changedPages}` : "bez zmian w tekście"}. Agent odpowiada z nowej wersji.
          </p>
          <ul className="list">
            {revision.changes.map((change, index) => (
              <ChangeItem key={index} revision={revision} change={change} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
};
