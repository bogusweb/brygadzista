import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentPage } from "../../lib/api";
import { runQueue } from "../../lib/offline";
import { cachedPageNumbers, savePage } from "../../lib/offlineCache";
import { useConnection } from "../../lib/settings";

type Progress = { done: number; failed: number; total: number };

const CONCURRENCY = 3;

// Saves every page of a document on the phone before going on site. Leaving the screen stops it; pages already saved stay.
export const useOfflineDownload = (documentId: string, pages: DocumentPage[]) => {
  const connection = useConnection();
  const controller = useRef<AbortController | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const start = useCallback(async () => {
    const saved = cachedPageNumbers(connection, documentId);
    const missing = pages.filter((page) => !saved.has(page.pageNo));
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setProgress({ done: 0, failed: 0, total: missing.length });
    await runQueue(
      missing,
      async (page) => {
        try {
          await savePage(connection, documentId, page.pageNo, abort.signal);
          setProgress((current) => current && { ...current, done: current.done + 1 });
        } catch {
          if (!abort.signal.aborted) setProgress((current) => current && { ...current, failed: current.failed + 1 });
        }
      },
      { concurrency: CONCURRENCY, signal: abort.signal },
    );
    if (controller.current === abort) controller.current = null;
    if (!abort.signal.aborted) setRunning(false);
  }, [connection, documentId, pages]);

  const stop = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setRunning(false);
  }, []);

  return { running, progress, start, stop };
};
