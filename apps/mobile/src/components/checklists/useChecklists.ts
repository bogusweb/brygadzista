import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { createChecklist, fetchChecklist, fetchChecklists, fetchTemplates, syncChecklist } from "../../lib/checklistApi";
import { syncEvents } from "../../lib/checklists";
import type { Checklist, ChecklistEvent, ChecklistQueue } from "../../lib/checklists";
import { loadWithFallback } from "../../lib/offline";
import { readJson, writeJson } from "../../lib/offlineCache";
import { randomId } from "../../lib/pins";
import { useConnection } from "../../lib/settings";
import { useCachedResource } from "../../lib/useCachedResource";

// One queue for all projects of the firm, so a tick made in one project still goes out from another.
const QUEUE_KEY = "checklist-queue";
const FLUSH_RETRY_MS = 30_000;
const EMPTY_QUEUE: ChecklistQueue = { events: [], refused: {} };

const detailKey = (id: string) => `checklist-${id}`;

export const useChecklists = (projectId: string) => {
  const connection = useConnection();
  const summaries = useCachedResource(`checklists-${projectId}`, (current) => fetchChecklists(current, projectId), "Nie udało się pobrać checklist.");
  const templates = useCachedResource(
    `checklist-templates-${projectId}`,
    (current) => fetchTemplates(current, projectId),
    "Nie udało się pobrać etapów budowy.",
  );
  const reloadSummaries = summaries.reload;
  const [details, setDetails] = useState<Record<string, { data: Checklist; offline: boolean }>>({});
  const [queue, setQueue] = useState<ChecklistQueue | null>(null);
  const queueRef = useRef<ChecklistQueue>(EMPTY_QUEUE);
  const flushing = useRef(false);

  const keepDetail = useCallback(
    async (checklist: Checklist, offline = false) => {
      setDetails((current) => ({ ...current, [checklist.id]: { data: checklist, offline } }));
      if (!offline) await writeJson(connection, detailKey(checklist.id), checklist).catch(() => undefined);
    },
    [connection],
  );

  const loadDetail = useCallback(
    async (id: string) => {
      const { data, offline } = await loadWithFallback(() => fetchChecklist(connection, id), {
        read: () => readJson<Checklist>(connection, detailKey(id)),
        write: (value) => writeJson(connection, detailKey(id), value),
      });
      await keepDetail(data, offline);
      return data;
    },
    [connection, keepDetail],
  );

  const changeQueue = useCallback(
    async (change: (current: ChecklistQueue) => ChecklistQueue) => {
      queueRef.current = change(queueRef.current);
      setQueue(queueRef.current);
      await writeJson(connection, QUEUE_KEY, queueRef.current);
    },
    [connection],
  );

  const flush = useCallback(async () => {
    if (flushing.current || queueRef.current.events.length === 0) return;
    flushing.current = true;
    try {
      const { sent, refused, fresh } = await syncEvents(
        queueRef.current.events,
        (id, events) => syncChecklist(connection, id, events),
        queueRef.current.refused,
      );
      const sentIds = new Set(sent);
      await changeQueue((current) => ({
        events: current.events.filter((event) => !sentIds.has(event.id)),
        refused: { ...current.refused, ...Object.fromEntries(refused) },
      }));
      await Promise.all(fresh.map((checklist) => keepDetail(checklist)));
      if (sent.length > 0) await reloadSummaries();
    } finally {
      flushing.current = false;
    }
  }, [changeQueue, connection, keepDetail, reloadSummaries]);

  useEffect(() => {
    void (async () => {
      queueRef.current = (await readJson<ChecklistQueue>(connection, QUEUE_KEY).catch(() => null)) ?? EMPTY_QUEUE;
      setQueue(queueRef.current);
      await flush();
    })();
  }, [connection, flush]);

  // Back in range: the app coming to the front is the usual moment, and a timer covers a phone left open on site.
  const waiting = queue?.events.some((event) => !queue.refused[event.checklistId]) ?? false;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => state === "active" && void flush());
    const timer = waiting ? setInterval(() => void flush(), FLUSH_RETRY_MS) : undefined;
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [flush, waiting]);

  const enqueue = useCallback(
    async (event: ChecklistEvent) => {
      await changeQueue((current) => ({ ...current, events: [...current.events, event] }));
      await flush();
    },
    [changeQueue, flush],
  );

  const check = useCallback(
    (checklistId: string, itemId: string, checked: boolean, note: string | null) =>
      enqueue({ id: randomId(), checklistId, type: "check", itemId, checked, note, at: new Date().toISOString() }),
    [enqueue],
  );

  const complete = useCallback(
    (checklistId: string) => enqueue({ id: randomId(), checklistId, type: "complete", at: new Date().toISOString(), by: "Ty" }),
    [enqueue],
  );

  const create = useCallback(
    async (stage: string) => {
      const checklist = await createChecklist(connection, projectId, stage);
      await keepDetail(checklist);
      await reloadSummaries();
      return checklist.id;
    },
    [connection, keepDetail, projectId, reloadSummaries],
  );

  // Changes the server will never take (the checklist was deleted) are dropped on the user's word, not silently.
  const dropRefused = useCallback(
    (checklistId: string) =>
      changeQueue((current) => {
        const { [checklistId]: _dropped, ...refused } = current.refused;
        return { events: current.events.filter((event) => event.checklistId !== checklistId), refused };
      }),
    [changeQueue],
  );

  return {
    summaries,
    templates,
    details,
    loadDetail,
    events: queue?.events ?? [],
    refused: queue?.refused ?? {},
    check,
    complete,
    create,
    dropRefused,
    flush,
  };
};
