import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./api";
import { loadWithFallback } from "./offline";
import { readJson, writeJson } from "./offlineCache";
import { useConnection } from "./settings";
import type { Connection } from "./settings";

type State<T> = { data: T | null; offline: boolean; error: string | null; loading: boolean };

// Server data that should still be there without signal: the last good answer is kept on the phone under `key`.
export const useCachedResource = <T>(key: string, fetcher: (connection: Connection) => Promise<T>, fallbackError: string) => {
  const connection = useConnection();
  const [state, setState] = useState<State<T>>({ data: null, offline: false, error: null, loading: true });

  const load = useCallback(async () => {
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const { data, offline } = await loadWithFallback(() => fetcher(connection), {
        read: () => readJson<T>(connection, key),
        write: (value) => writeJson(connection, key, value),
      });
      setState({ data, offline, error: null, loading: false });
    } catch (caught) {
      const error = caught instanceof ApiError ? caught.message : fallbackError;
      setState((previous) => ({ ...previous, error, loading: false }));
    }
    // fetcher is a module-level function at every call site, so key and connection decide when to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, key]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, reload: load };
};
