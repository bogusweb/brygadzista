import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Account, LoginResult } from "./account";
import { clearOtherAccounts, clearServerData } from "./offlineCache";
import { secureStorage } from "./secureStorage";

// Every request carries the account's session; saved data is kept per account and firm (#91).
export type Connection = { serverUrl: string; token: string; userId: string; tenantId: string | null };

type SettingsValue = {
  ready: boolean;
  connection: Connection | null;
  account: Account | null;
  // The address used last, kept after logging out to prefill the login form.
  serverUrl: string | null;
  lastProjectId: string | null;
  signIn: (serverUrl: string, login: LoginResult) => Promise<void>;
  updateAccount: (account: Account) => Promise<void>;
  signOut: () => Promise<void>;
  rememberProject: (projectId: string) => Promise<void>;
};

// "appToken" held the shared code from before accounts; it is only ever removed now.
const KEYS = { serverUrl: "serverUrl", token: "sessionToken", account: "account", lastProjectId: "lastProjectId", legacyToken: "appToken" } as const;

export const normalizeServerUrl = (url: string) => {
  const trimmed = url.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

// The browser version is served by the server itself under /app, so the server is the page's own origin.
// The dev preview (`pnpm web`) runs elsewhere and still asks for the address.
export const hostedServerUrl = (): string | null =>
  typeof window !== "undefined" && window.location?.pathname?.startsWith("/app") ? window.location.origin : null;

const parseAccount = (saved: string | null): Account | null => {
  try {
    return saved ? (JSON.parse(saved) as Account) : null;
  } catch {
    return null;
  }
};

const SettingsContext = createContext<SettingsValue | null>(null);

export const SettingsProvider = ({ children }: { children: ReactNode }) => {
  const [ready, setReady] = useState(false);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [lastProjectId, setLastProjectId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [savedUrl, savedToken, savedAccount, projectId, legacyToken] = await Promise.all(
        [KEYS.serverUrl, KEYS.token, KEYS.account, KEYS.lastProjectId, KEYS.legacyToken].map((key) => secureStorage.get(key)),
      );
      // A phone that used the shared code logs in with an account once; the code goes.
      if (legacyToken) await secureStorage.remove(KEYS.legacyToken);
      const parsed = parseAccount(savedAccount);
      if (savedUrl && savedToken && parsed) {
        setServerUrl(savedUrl);
        setToken(savedToken);
        setAccount(parsed);
        setLastProjectId(projectId ?? null);
      } else if (savedUrl) {
        setServerUrl(savedUrl);
      }
      setReady(true);
    })();
  }, []);

  const signIn = useCallback(async (url: string, { token: sessionToken, ...next }: LoginResult) => {
    clearOtherAccounts(url, next.user.id);
    await Promise.all([
      secureStorage.set(KEYS.serverUrl, url),
      secureStorage.set(KEYS.token, sessionToken),
      secureStorage.set(KEYS.account, JSON.stringify(next)),
      secureStorage.remove(KEYS.lastProjectId),
    ]);
    setServerUrl(url);
    setToken(sessionToken);
    setAccount(next);
    setLastProjectId(null);
  }, []);

  // A new firm is a different list of projects, so the last opened one is forgotten.
  const updateAccount = useCallback(
    async (next: Account) => {
      if (JSON.stringify(next) === JSON.stringify(account)) return;
      const firmChanged = next.tenant?.id !== account?.tenant?.id;
      await secureStorage.set(KEYS.account, JSON.stringify(next));
      if (firmChanged) {
        await secureStorage.remove(KEYS.lastProjectId);
        setLastProjectId(null);
      }
      setAccount(next);
    },
    [account],
  );

  const signOut = useCallback(async () => {
    if (serverUrl) clearServerData(serverUrl);
    await Promise.all([KEYS.token, KEYS.account, KEYS.lastProjectId].map((key) => secureStorage.remove(key)));
    setToken(null);
    setAccount(null);
    setLastProjectId(null);
  }, [serverUrl]);

  const rememberProject = useCallback(async (projectId: string) => {
    await secureStorage.set(KEYS.lastProjectId, projectId);
    setLastProjectId(projectId);
  }, []);

  // Kept the same object while the account and firm stay, so a refreshed account does not reload every screen.
  const userId = account?.user.id ?? null;
  const tenantId = account?.tenant?.id ?? null;
  const connection = useMemo(
    () => (serverUrl && token && userId ? { serverUrl, token, userId, tenantId } : null),
    [serverUrl, token, userId, tenantId],
  );

  const value = useMemo(
    () => ({ ready, connection, account, serverUrl, lastProjectId, signIn, updateAccount, signOut, rememberProject }),
    [ready, connection, account, serverUrl, lastProjectId, signIn, updateAccount, signOut, rememberProject],
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
