// Questions to the designer (#73): drafted by the agent, sent by the contractor from the phone, answered here.

export type Region = { x: number; y: number; width: number; height: number };

export type QuestionDraft = {
  documentId: string;
  pageNo: number;
  pageTitle: string | null;
  question: string;
  reason: string;
  region: Region | null;
};

export type DesignerQuestion = {
  id: string;
  documentId: string | null;
  pageNo: number | null;
  pageTitle: string | null;
  region: Region | null;
  question: string;
  reason: string;
  status: "open" | "answered";
  answer: string | null;
  answeredAt: string | null;
  authorName: string;
  createdAt: string;
};

export const cropPath = (documentId: string, pageNo: number, region: Region | null) => {
  const base = `/api/documents/${encodeURIComponent(documentId)}/pages/${pageNo}/crop`;
  if (!region) return base;
  const query = [`x=${region.x.toFixed(4)}`, `y=${region.y.toFixed(4)}`, `w=${region.width.toFixed(4)}`, `h=${region.height.toFixed(4)}`];
  return `${base}?${query.join("&")}`;
};

const pageReference = (question: { pageNo: number | null; pageTitle: string | null }) =>
  question.pageNo ? `str. ${question.pageNo}${question.pageTitle ? ` (${question.pageTitle})` : ""}` : null;

// The message that goes out by mail, WhatsApp or SMS: who asks, about which project and page, and the question.
export const shareMessage = (question: { question: string; pageNo: number | null; pageTitle: string | null }, projectName?: string) => {
  const where = [projectName ? `projekt „${projectName}”` : null, pageReference(question)].filter(Boolean).join(", ");
  return `Dzień dobry,\n\nmam pytanie do projektu${where ? ` (${where})` : ""}:\n\n${question.question.trim()}\n\nPozdrawiam`;
};
