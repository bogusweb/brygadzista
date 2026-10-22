import type { CardKind, ElementCard } from "./cards";
import { request } from "./http";
import type { Connection } from "./settings";

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/cards`;

export const fetchCards = (connection: Connection, projectId: string) => request<ElementCard[]>(connection, projectPath(projectId));

export const fetchCard = (connection: Connection, id: string) => request<ElementCard>(connection, `/api/cards/${encodeURIComponent(id)}`);

// Collecting values from the project runs on the server; the answer is the card, usually still "generating".
export const requestCard = (connection: Connection, projectId: string, kind: CardKind, name: string, refresh = false) =>
  request<ElementCard>(connection, projectPath(projectId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, name, refresh }),
  });
