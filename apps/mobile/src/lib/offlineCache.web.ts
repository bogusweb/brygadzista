import { isForeignKey, scopeFolders, storagePrefix } from "./offline";
import type { Connection } from "./settings";

// expo-file-system has no web implementation, so the browser version always reads pages from the server.
export const offlineSupported = false;

export const cachedPageUri = (_connection: Connection, _documentId: string, _pageNo: number): string | null => null;
export const cachedPageNumbers = (_connection: Connection, _documentId: string) => new Set<number>();
export const cachedDocumentBytes = (_connection: Connection, _documentId: string) => 0;
export const savePage = async (_connection: Connection, _documentId: string, _pageNo: number, _signal?: AbortSignal) => {};
export const removePage = (_connection: Connection, _documentId: string, _pageNo: number) => {};
export const removeDocumentPages = (_connection: Connection, _documentId: string) => {};
// Lists and the search index are small enough for localStorage, so search keeps working when the signal drops.
// A full or blocked storage only means no saved copy.
const storageKey = (connection: Connection, key: string) => `${storagePrefix(scopeFolders(connection))}${key}`;

export const readJson = async <T>(connection: Connection, key: string): Promise<T | null> => {
  try {
    const saved = globalThis.localStorage?.getItem(storageKey(connection, key));
    return saved ? (JSON.parse(saved) as T) : null;
  } catch {
    return null;
  }
};

export const writeJson = async (connection: Connection, key: string, value: unknown) => {
  try {
    globalThis.localStorage?.setItem(storageKey(connection, key), JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled.
  }
};

const removeKeys = (serverUrl: string, userId: string | null) => {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => key !== null);
    keys.filter((key) => isForeignKey(key, serverUrl, userId)).forEach((key) => storage.removeItem(key));
  } catch {
    // Storage disabled: nothing was saved either.
  }
};

export const clearServerData = (serverUrl: string) => removeKeys(serverUrl, null);

export const clearOtherAccounts = (serverUrl: string, userId: string) => removeKeys(serverUrl, userId);
