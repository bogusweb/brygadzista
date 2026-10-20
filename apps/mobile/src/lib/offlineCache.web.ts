import type { Connection } from "./settings";

// expo-file-system has no web implementation, so the browser version always reads pages from the server.
export const offlineSupported = false;

export const cachedPageUri = (_connection: Connection, _documentId: string, _pageNo: number): string | null => null;
export const cachedPageNumbers = (_connection: Connection, _documentId: string) => new Set<number>();
export const cachedDocumentBytes = (_connection: Connection, _documentId: string) => 0;
export const savePage = async (_connection: Connection, _documentId: string, _pageNo: number, _signal?: AbortSignal) => {};
export const removePage = (_connection: Connection, _documentId: string, _pageNo: number) => {};
export const removeDocumentPages = (_connection: Connection, _documentId: string) => {};
export const readJson = async <T>(_connection: Connection, _key: string): Promise<T | null> => null;
export const writeJson = async (_connection: Connection, _key: string, _value: unknown) => {};
