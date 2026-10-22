// Versions of the project (#72): a new PDF uploaded as a version of a document, with what changed against the old one.

export type FactChange = { label: string; before: string | null; after: string | null };

export type PageChange = {
  kind: "changed" | "added" | "removed";
  pageNo: number | null;
  previousPageNo: number | null;
  title: string | null;
  drawingNo: string | null;
  facts: FactChange[];
  linesAdded: string[];
  linesRemoved: string[];
};

export type Revision = {
  documentId: string;
  filename: string;
  previousId: string;
  previousFilename: string;
  createdAt: string;
  changedPages: number;
  changes: PageChange[];
};

export const seenRevisionsKey = (projectId: string) => `revisions-seen-${projectId}`;

// Versions the crew has not opened yet, for the notice above the tabs.
export const unseenRevisions = (revisions: Revision[] | null, seen: string[] | null) =>
  (revisions ?? []).filter((revision) => !(seen ?? []).includes(revision.documentId));

export const KIND_LABELS: Record<PageChange["kind"], string> = { changed: "Zmieniona", added: "Nowa strona", removed: "Usunięta" };

export const factLine = ({ label, before, after }: FactChange) =>
  before && after ? `${label}: było ${before}, jest ${after}` : after ? `${label}: dodano ${after}` : `${label}: usunięto ${before}`;
