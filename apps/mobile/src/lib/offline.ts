export type Loaded<T> = { data: T; offline: boolean };

export type JsonStore<T> = { read: () => Promise<T | null>; write: (value: T) => Promise<void> };

// Server errors carry an HTTP status; a missing status means the request never got an answer (no signal, timeout).
const isUnreachable = (error: unknown) => error instanceof Error && (error as { status?: number }).status === undefined;

// Every fresh answer is saved; on site without signal the last saved copy stands in, flagged as offline.
export const loadWithFallback = async <T>(fetcher: () => Promise<T>, store: JsonStore<T>): Promise<Loaded<T>> => {
  try {
    const data = await fetcher();
    await store.write(data).catch(() => undefined);
    return { data, offline: false };
  } catch (error) {
    if (!isUnreachable(error)) throw error;
    const saved = await store.read().catch(() => null);
    if (saved === null) throw error;
    return { data: saved, offline: true };
  }
};

// One folder per server, so switching servers never mixes up projects that happen to share ids.
export const serverFolderName = (serverUrl: string) =>
  serverUrl
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[^a-z0-9.-]+/gi, "_")
    .replace(/^_+|_+$/g, "");

// Saved data belongs to one account in one firm (#91): server / user / firm, so another account or firm on the same
// phone never reads it. Logging out removes the server's folder, logging in as someone else removes the others' ones.
export const scopeFolders = ({ serverUrl, userId, tenantId }: { serverUrl: string; userId: string; tenantId: string | null }) => [
  serverFolderName(serverUrl),
  userFolderName(userId),
  `firm-${tenantId ?? "none"}`,
];

export const userFolderName = (userId: string) => `user-${userId}`;

// Browser storage keeps the same scopes as key prefixes.
export const storagePrefix = (folders: string[]) => `brygadzista:${folders.join(":")}:`;

// Keys saved on this server by anyone but the given account, including data from before accounts.
export const isForeignKey = (key: string, serverUrl: string, userId: string | null) => {
  const server = storagePrefix([serverFolderName(serverUrl)]);
  return key.startsWith(server) && (userId === null || !key.startsWith(storagePrefix([serverFolderName(serverUrl), userFolderName(userId)])));
};

export const pageFileName = (pageNo: number) => `${pageNo}.jpg`;

export const pageNoFromFileName = (name: string) => {
  const match = /^(\d+)\.jpg$/.exec(name);
  return match ? Number(match[1]) : null;
};

// Runs downloads a few at a time; stops taking new ones once the signal aborts.
export const runQueue = async <T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  { concurrency, signal }: { concurrency: number; signal?: AbortSignal },
) => {
  let next = 0;
  const lane = async () => {
    while (next < items.length && !signal?.aborted) {
      const item = items[next++]!;
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
};

// Saved pages change from several places (the viewer, the chat, a bulk download); screens subscribe to redraw their badges.
const listeners = new Set<() => void>();
let pageCacheVersion = 0;

export const subscribePageCache = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getPageCacheVersion = () => pageCacheVersion;

export const notifyPageCacheChanged = () => {
  pageCacheVersion += 1;
  listeners.forEach((listener) => listener());
};
