import { Platform } from "react-native";
import type { ImageSourcePropType } from "react-native";
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

const getJson = async <T>(connection: Connection, path: string): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${connection.serverUrl}${path}`, {
      headers: authHeaders(connection),
      signal: controller.signal,
    });
    if (!response.ok) throw new ApiError(messageForStatus(response.status), response.status);
    return (await response.json()) as T;
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

export const fetchProjects = (connection: Connection) => getJson<Project[]>(connection, "/api/projects");

export const copilotRuntimeUrl = ({ serverUrl }: Connection) => `${serverUrl}/api/copilotkit`;

export const fetchDocuments = (connection: Connection, projectId: string) =>
  getJson<ProjectDocument[]>(connection, `/api/projects/${encodeURIComponent(projectId)}/documents`);

export const fetchPages = (connection: Connection, documentId: string) =>
  getJson<DocumentPage[]>(connection, `/api/documents/${encodeURIComponent(documentId)}/pages`);

export const pageImagePath = (documentId: string, pageNo: number) =>
  `/api/documents/${encodeURIComponent(documentId)}/pages/${pageNo}/image`;

// Native images send the token as a header; the browser's <img> cannot, so the web preview uses the query fallback.
export const pageImageSource = (connection: Connection, documentId: string, pageNo: number): ImageSourcePropType => {
  const uri = `${connection.serverUrl}${pageImagePath(documentId, pageNo)}`;
  return Platform.OS === "web"
    ? { uri: `${uri}?token=${encodeURIComponent(connection.token)}` }
    : { uri, headers: authHeaders(connection) };
};
