import { useCallback, useState } from "react";

// The key predates accounts: it now holds either a session token or the operator token.
const tokenKey = "brygadzista.adminToken";
// The firm an operator outside any firm is looking at; empty means every firm.
const operatorTenantKey = "brygadzista.operatorTenant";

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string | null) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Private mode or blocked storage: the choice just won't survive a reload.
  }
};

export const useStoredToken = () => {
  const [token, setToken] = useState(() => read(tokenKey));
  const signIn = useCallback((next: string) => {
    write(tokenKey, next);
    setToken(next);
  }, []);
  const signOut = useCallback(() => {
    write(tokenKey, null);
    write(operatorTenantKey, null);
    setToken(null);
  }, []);
  return { token, signIn, signOut };
};

export const useOperatorTenant = () => {
  const [tenantId, setTenantId] = useState(() => read(operatorTenantKey));
  const choose = useCallback((next: string | null) => {
    write(operatorTenantKey, next);
    setTenantId(next);
  }, []);
  return [tenantId, choose] as const;
};
