import { Platform } from "react-native";
import type { ImageSourcePropType } from "react-native";
import type { Pin, PinFields } from "./pins";
import type { SearchIndex } from "./search";
import type { Connection } from "./settings";

export type Project = { id: string; name: string; createdAt: string; documentCount: number };
export type ProjectDocument = { id: string; filename: string; pageCount: number | null; status: string };
export type DocumentPage = { pageNo: number; title: string | null; kind: string | null };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;

const messageForStatus = (status: number) => {
  if (status === 401 || status === 403) return "Nieprawidłowy kod dostępu.";
  if (status === 404) return "Pod tym adresem nie ma serwera Brygadzisty.";
  if (status >= 500) return "Serwer ma problem. Spróbuj za chwilę.";
  return `Serwer odpowiedział błędem ${status}.`;
};

export const authHeaders = ({ token }: Connection, projectId?: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  ...(projectId ? { "x-project-id": projectId } : {}),
});

const request = async (connection: Connection, path: string, init: { method?: string; body?: string } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${connection.serverUrl}${path}`, {
      method: init.method ?? "GET",
      headers: { ...authHeaders(connection), ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body,
      signal: controller.signal,
    });
    if (!response.ok) throw new ApiError(await errorMessage(response), response.status);
    return response;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      controller.signal.aborted
        ? "Serwer nie odpowiada. Sprawdź zasięg i adres."
        : "Nie udało się połączyć z serwerem. Sprawdź zasięg i adres.",
    );
  } finally {
    clearTimeout(timer);
  }
};

// A refused change (bad page, photo too large) carries the server's own explanation; the rest get a generic one.
const errorMessage = async (response: Response) => {
  if (response.status === 400 || response.status === 409 || response.status === 413) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (body?.error) return body.error;
  }
  return messageForStatus(response.status);
};

const getJson = async <T>(connection: Connection, path: string): Promise<T> => (await (await request(connection, path)).json()) as T;

export const fetchProjects = (connection: Connection) => getJson<Project[]>(connection, "/api/projects");

export const copilotRuntimeUrl = ({ serverUrl }: Connection) => `${serverUrl}/api/copilotkit`;

export const fetchDocuments = (connection: Connection, projectId: string) =>
  getJson<ProjectDocument[]>(connection, `/api/projects/${encodeURIComponent(projectId)}/documents`);

export const fetchPages = (connection: Connection, documentId: string) =>
  getJson<DocumentPage[]>(connection, `/api/documents/${encodeURIComponent(documentId)}/pages`);

// The text of every page in the project, kept on the phone for searching without signal.
export const fetchSearchIndex = (connection: Connection, projectId: string) =>
  getJson<SearchIndex>(connection, `/api/projects/${encodeURIComponent(projectId)}/search-index`);

export const pageImagePath = (documentId: string, pageNo: number) =>
  `/api/documents/${encodeURIComponent(documentId)}/pages/${pageNo}/image`;

// Native images send the token as a header; the browser's <img> cannot, so the web preview uses the query fallback.
export const pageImageSource = (connection: Connection, documentId: string, pageNo: number): ImageSourcePropType =>
  serverImageSource(connection, pageImagePath(documentId, pageNo));

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

export const fetchPins = async (connection: Connection, projectId: string) =>
  (await getJson<{ pins: Pin[] }>(connection, `${projectPath(projectId)}/pins`)).pins;

export const putPin = (connection: Connection, projectId: string, { id, ...pin }: PinFields) =>
  request(connection, `${projectPath(projectId)}/pins/${id}`, { method: "PUT", body: JSON.stringify(pin) });

export const deletePin = (connection: Connection, projectId: string, pinId: string) =>
  request(connection, `${projectPath(projectId)}/pins/${pinId}`, { method: "DELETE" });

export const deletePhoto = (connection: Connection, projectId: string, photoId: string) =>
  request(connection, `${projectPath(projectId)}/photos/${photoId}`, { method: "DELETE" });

export const photoUploadUrl = ({ serverUrl }: Connection, projectId: string, pinId: string, photoId: string, takenAt: string) =>
  `${serverUrl}${projectPath(projectId)}/pins/${pinId}/photos/${photoId}?takenAt=${encodeURIComponent(takenAt)}`;

export type PhotoSize = "full" | "thumb";

export const photoImagePath = (projectId: string, photoId: string, size: PhotoSize) =>
  `${projectPath(projectId)}/photos/${photoId}/image${size === "thumb" ? "?size=thumb" : ""}`;

// Same as page images: a header on native, the query token in the browser. `path` may already carry a query.
export const serverImageSource = (connection: Connection, path: string): ImageSourcePropType => {
  const uri = `${connection.serverUrl}${path}`;
  return Platform.OS === "web"
    ? { uri: `${uri}${uri.includes("?") ? "&" : "?"}token=${encodeURIComponent(connection.token)}` }
    : { uri, headers: authHeaders(connection) };
};
