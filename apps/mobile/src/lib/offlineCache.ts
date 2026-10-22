import { Directory, File, Paths } from "expo-file-system";
import { authHeaders, pageImagePath } from "./api";
import { notifyPageCacheChanged, pageFileName, pageNoFromFileName, scopeFolders, serverFolderName, userFolderName } from "./offline";
import type { Connection } from "./settings";

// Drawings live in the document directory, not the cache one: the system may empty the cache exactly when the phone is on site.
export const offlineSupported = true;

const serverRoot = (serverUrl: string) => new Directory(Paths.document, "offline", serverFolderName(serverUrl));
const serverDir = (connection: Connection) => new Directory(Paths.document, "offline", ...scopeFolders(connection));
const documentDir = (connection: Connection, documentId: string) => new Directory(serverDir(connection), "pages", documentId);
const pageFile = (connection: Connection, documentId: string, pageNo: number) =>
  new File(documentDir(connection, documentId), pageFileName(pageNo));
const jsonFile = (connection: Connection, key: string) => new File(serverDir(connection), "data", `${key}.json`);

export const cachedPageUri = (connection: Connection, documentId: string, pageNo: number) => {
  const file = pageFile(connection, documentId, pageNo);
  return file.exists ? file.uri : null;
};

export const cachedPageNumbers = (connection: Connection, documentId: string) => {
  const dir = documentDir(connection, documentId);
  if (!dir.exists) return new Set<number>();
  const numbers = dir.list().map((entry) => (entry instanceof File ? pageNoFromFileName(entry.name) : null));
  return new Set(numbers.filter((pageNo): pageNo is number => pageNo !== null));
};

export const cachedDocumentBytes = (connection: Connection, documentId: string) => {
  const dir = documentDir(connection, documentId);
  return dir.exists ? (dir.size ?? 0) : 0;
};

const inFlight = new Map<string, Promise<void>>();

// Downloads into a temporary name first, so a dropped connection never leaves half an image that looks saved.
export const savePage = (connection: Connection, documentId: string, pageNo: number, signal?: AbortSignal) => {
  const target = pageFile(connection, documentId, pageNo);
  if (target.exists) return Promise.resolve();
  const running = inFlight.get(target.uri);
  if (running) return running;
  const download = (async () => {
    const dir = documentDir(connection, documentId);
    dir.create({ intermediates: true, idempotent: true });
    const partial = new File(dir, `${pageNo}.part`);
    await File.downloadFileAsync(`${connection.serverUrl}${pageImagePath(documentId, pageNo)}`, partial, {
      headers: authHeaders(connection),
      idempotent: true,
      signal,
    });
    await partial.move(target, { overwrite: true });
    notifyPageCacheChanged();
  })().finally(() => inFlight.delete(target.uri));
  inFlight.set(target.uri, download);
  return download;
};

export const removePage = (connection: Connection, documentId: string, pageNo: number) => {
  const file = pageFile(connection, documentId, pageNo);
  if (!file.exists) return;
  file.delete();
  notifyPageCacheChanged();
};

export const removeDocumentPages = (connection: Connection, documentId: string) => {
  const dir = documentDir(connection, documentId);
  if (!dir.exists) return;
  dir.delete();
  notifyPageCacheChanged();
};

export const readJson = async <T>(connection: Connection, key: string): Promise<T | null> => {
  const file = jsonFile(connection, key);
  return file.exists ? (JSON.parse(await file.text()) as T) : null;
};

export const writeJson = async (connection: Connection, key: string, value: unknown) => {
  const file = jsonFile(connection, key);
  file.parentDirectory.create({ intermediates: true, idempotent: true });
  if (!file.exists) file.create();
  await file.write(JSON.stringify(value));
};

// Logging out leaves nothing of this server on the phone.
export const clearServerData = (serverUrl: string) => {
  const root = serverRoot(serverUrl);
  if (root.exists) root.delete();
  notifyPageCacheChanged();
};

// Logging in keeps only this account's data: other accounts' folders and the files from before accounts go.
export const clearOtherAccounts = (serverUrl: string, userId: string) => {
  const root = serverRoot(serverUrl);
  if (!root.exists) return;
  for (const entry of root.list()) if (entry.name !== userFolderName(userId)) entry.delete();
  notifyPageCacheChanged();
};
