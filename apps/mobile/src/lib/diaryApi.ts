import type { DiaryEntry, DiaryNote } from "./diary";
import { request } from "./http";
import type { Connection } from "./settings";

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
