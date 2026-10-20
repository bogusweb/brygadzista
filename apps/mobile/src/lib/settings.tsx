import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { secureStorage } from "./secureStorage";

export type Connection = { serverUrl: string; token: string };

type SettingsValue = {
  ready: boolean;
  connection: Connection | null;
  lastProjectId: string | null;
  saveConnection: (connection: Connection) => Promise<void>;
  clearConnection: () => Promise<void>;
  rememberProject: (projectId: string) => Promise<void>;
};

const KEYS = { serverUrl: "serverUrl", token: "appToken", lastProjectId: "lastProjectId" } as const;

export const normalizeServerUrl = (url: string) => {
  const trimmed = url.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

// The browser version is served by the server itself under /app, so the server is the page's own origin.
// The dev preview (`pnpm web`) runs elsewhere and still asks for the address.
export const hostedServerUrl = (): string | null =>
  typeof window !== "undefined" && window.location?.pathname?.startsWith("/app") ? window.location.origin : null;

const SettingsContext = createContext<SettingsValue | null>(null);

export const SettingsProvider = ({ children }: { children: ReactNode }) => {
  const [ready, setReady] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [lastProjectId, setLastProjectId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [serverUrl, token, projectId] = await Promise.all(
        [KEYS.serverUrl, KEYS.token, KEYS.lastProjectId].map((key) => secureStorage.get(key)),
      );
      if (serverUrl && token) setConnection({ serverUrl, token });
      setLastProjectId(projectId ?? null);
      setReady(true);
    })();
  }, []);

  const saveConnection = useCallback(async (next: Connection) => {
    await secureStorage.set(KEYS.serverUrl, next.serverUrl);
    await secureStorage.set(KEYS.token, next.token);
    setConnection(next);
  }, []);

  const clearConnection = useCallback(async () => {
    await Promise.all(Object.values(KEYS).map((key) => secureStorage.remove(key)));
    setConnection(null);
    setLastProjectId(null);
  }, []);

  const rememberProject = useCallback(async (projectId: string) => {
    await secureStorage.set(KEYS.lastProjectId, projectId);
    setLastProjectId(projectId);
  }, []);

  const value = useMemo(
    () => ({ ready, connection, lastProjectId, saveConnection, clearConnection, rememberProject }),
    [ready, connection, lastProjectId, saveConnection, clearConnection, rememberProject],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
};

export const useSettings = () => {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings must be used inside SettingsProvider");
  return value;
};

export const useConnection = () => {
  const { connection } = useSettings();
  if (!connection) throw new Error("Brak konfiguracji serwera");
  return connection;
};
