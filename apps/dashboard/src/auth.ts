import { useCallback, useState } from "react";

const storageKey = "brygadzista.adminToken";

const readToken = () => {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
};

const writeToken = (token: string | null) => {
  try {
    if (token) localStorage.setItem(storageKey, token);
    else localStorage.removeItem(storageKey);
  } catch {
    // Private mode or blocked storage: the session just won't survive a reload.
  }
};

export const useAdminToken = () => {
  const [token, setToken] = useState(readToken);
  const signIn = useCallback((next: string) => {
    writeToken(next);
    setToken(next);
  }, []);
  const signOut = useCallback(() => {
    writeToken(null);
    setToken(null);
  }, []);
  return { token, signIn, signOut };
};
