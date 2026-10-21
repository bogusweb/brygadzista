import { ApiError, authHeaders } from "./api";
import type { DiaryEntry, DiaryNote } from "./diary";
import type { Connection } from "./settings";

const TIMEOUT_MS = 30_000;

const messageForStatus = async (response: Response) => {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (body?.error) return body.error;
  if (response.status === 401 || response.status === 403) return "Nieprawidłowy kod dostępu.";
  return `Serwer odpowiedział błędem ${response.status}.`;
};

// A missing status on the error means the request never got an answer (no signal), which the offline queue waits out.
const request = async <T>(connection: Connection, path: string, init: RequestInit = {}): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${connection.serverUrl}${path}`, {
      ...init,
      headers: { ...authHeaders(connection), ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });
  } catch {
    throw new ApiError("Nie udało się połączyć z serwerem. Sprawdź zasięg.");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new ApiError(await messageForStatus(response), response.status);
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
};

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/diary`;
const notePath = (id: string) => `/api/diary/${encodeURIComponent(id)}`;

export const fetchDiary = (connection: Connection, projectId: string) => request<DiaryNote[]>(connection, projectPath(projectId));

export const sendDiaryText = (connection: Connection, projectId: string, note: { text: string; date: string; clientId: string }) =>
  request<DiaryNote>(connection, projectPath(projectId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(note),
  });

export const sendDiaryAudio = (
  connection: Connection,
  projectId: string,
  note: { audio: Blob | ArrayBuffer | Uint8Array; mediaType: string; date: string; clientId: string },
) =>
  request<DiaryNote>(connection, `${projectPath(projectId)}?date=${note.date}&clientId=${encodeURIComponent(note.clientId)}`, {
    method: "POST",
    headers: { "content-type": note.mediaType },
    body: note.audio as BodyInit,
  });

export const updateDiaryNote = (
  connection: Connection,
  id: string,
  changes: { entryDate?: string; transcript?: string; entry?: DiaryEntry },
) =>
  request<DiaryNote>(connection, notePath(id), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(changes),
  });

export const retryDiaryNote = (connection: Connection, id: string) =>
  request<DiaryNote>(connection, `${notePath(id)}/retry`, { method: "POST" });

export const deleteDiaryNote = (connection: Connection, id: string) => request<void>(connection, notePath(id), { method: "DELETE" });
