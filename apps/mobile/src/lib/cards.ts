// Cards of a room or a partition (#71): values from the project with their pages, built on the server
// (from the Karty screen or by the agent in the chat) and kept on the phone for work without signal.

export type CardKind = "room" | "partition";
export type CardStatus = "generating" | "ready" | "error";
export type ValueStatus = "found" | "to_confirm";

export type CardSource = { documentId: string; pageNo: number; quote: string | null; imagePath: string };

export type CardField = { key: string; label: string; value: string | null; status: ValueStatus; source: CardSource | null };

export type CardLayer = { material: string; thickness: string | null; status: ValueStatus; source: CardSource | null };

export type ElementCard = {
  id: string;
  projectId: string;
  kind: CardKind;
  name: string;
  status: CardStatus;
  error: string | null;
  fields: CardField[];
  layers: CardLayer[];
  missing: string[];
  createdBy: string;
  createdAt: string;
  generatedAt: string | null;
};

export const KIND_LABELS: Record<CardKind, string> = { room: "Pomieszczenie", partition: "Przegroda" };

export const cardsKey = (projectId: string) => `cards-${projectId}`;

// Same order as the server's list: rooms, then partitions, by name.
const order = (a: ElementCard, b: ElementCard) =>
  a.kind === b.kind ? a.name.localeCompare(b.name, "pl", { sensitivity: "base" }) : a.kind === "room" ? -1 : 1;

// A card the agent built in the chat joins the saved list, replacing an older copy of itself.
export const withCard = (cards: ElementCard[] | null, card: ElementCard) =>
  [...(cards ?? []).filter((saved) => saved.id !== card.id), card].sort(order);

// Pages the card cites, once each, so they can be saved with it and opened without signal.
export const cardPages = (card: ElementCard) => {
  const pages = new Map<string, { documentId: string; pageNo: number }>();
  for (const { source } of [...card.fields, ...card.layers]) {
    if (source) pages.set(`${source.documentId}:${source.pageNo}`, { documentId: source.documentId, pageNo: source.pageNo });
  }
  return [...pages.values()];
};

export const layerLine = (layer: CardLayer) => (layer.thickness ? `${layer.material} – ${layer.thickness}` : layer.material);
