import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { isSorting } from "../../lib/diary";
import type { DiaryEntry } from "../../lib/diary";
import { deleteDiaryNote, fetchDiary, retryDiaryNote, sendDiaryAudio, sendDiaryText, updateDiaryNote } from "../../lib/diaryApi";
import { discardRecording, keepRecording, readRecording, recordingFormat } from "../../lib/diaryAudio";
import { flushQueue, newClientId } from "../../lib/diaryQueue";
import type { QueuedNote } from "../../lib/diaryQueue";
import { readJson, writeJson } from "../../lib/offlineCache";
import { useConnection } from "../../lib/settings";
import type { Connection } from "../../lib/settings";
import { useCachedResource } from "../../lib/useCachedResource";

// One queue for all projects of the firm, so a note recorded in one project still goes out from another.
const QUEUE_KEY = "diary-queue";
const SORTING_POLL_MS = 3_000;
const FLUSH_RETRY_MS = 30_000;

const sendNote = async (connection: Connection, note: QueuedNote) => {
  if (note.kind === "text") {
    await sendDiaryText(connection, note.projectId, { text: note.text, date: note.date, clientId: note.clientId });
    return;
  }
  const audio = await readRecording(note.audioUri).catch(() => {
    throw Object.assign(new Error("Nagranie zniknęło z telefonu."), { status: 410 });
  });
  await sendDiaryAudio(connection, note.projectId, { audio, mediaType: note.mediaType, date: note.date, clientId: note.clientId });
};

export const useDiary = (projectId: string) => {
  const connection = useConnection();
  const notes = useCachedResource(`diary-${projectId}`, (current) => fetchDiary(current, projectId), "Nie udało się pobrać dziennika.");
  const { reload } = notes;
  const [queue, setQueue] = useState<QueuedNote[] | null>(null);
  const queueRef = useRef<QueuedNote[]>([]);
  const flushing = useRef(false);

  const changeQueue = useCallback(
    async (change: (current: QueuedNote[]) => QueuedNote[]) => {
      queueRef.current = change(queueRef.current);
      setQueue(queueRef.current);
      await writeJson(connection, QUEUE_KEY, queueRef.current);
    },
    [connection],
  );

  const flush = useCallback(async () => {
    if (flushing.current || queueRef.current.length === 0) return;
    flushing.current = true;
    try {
      const { sent, remaining } = await flushQueue(queueRef.current, (note) => sendNote(connection, note));
      const sentIds = new Set(sent.map((note) => note.clientId));
      const updated = new Map(remaining.map((note) => [note.clientId, note]));
      await changeQueue((current) =>
        current.filter((note) => !sentIds.has(note.clientId)).map((note) => updated.get(note.clientId) ?? note),
      );
      sent.forEach((note) => note.kind === "audio" && discardRecording(note.audioUri));
      if (sent.length > 0) await reload();
    } finally {
      flushing.current = false;
    }
  }, [changeQueue, connection, reload]);

  useEffect(() => {
    void (async () => {
      queueRef.current = (await readJson<QueuedNote[]>(connection, QUEUE_KEY).catch(() => null)) ?? [];
      setQueue(queueRef.current);
      await flush();
    })();
  }, [connection, flush]);

  // Back in range: the app coming to the front is the usual moment, and a timer covers a phone left open on site.
  const waiting = queue?.some((note) => !note.error) ?? false;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => state === "active" && void flush());
    const timer = waiting ? setInterval(() => void flush(), FLUSH_RETRY_MS) : undefined;
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [flush, waiting]);

  // The server sorts a note in the background; the list is asked again until it is done.
  const sorting = notes.data?.some(isSorting) ?? false;
  useEffect(() => {
    if (!sorting) return;
    const timer = setTimeout(() => void reload(), SORTING_POLL_MS);
    return () => clearTimeout(timer);
  }, [notes.data, reload, sorting]);

  const enqueue = useCallback(
    async (note: QueuedNote) => {
      await changeQueue((current) => [...current, note]);
      await flush();
    },
    [changeQueue, flush],
  );

  const addRecording = useCallback(
    async ({ uri, durationMillis }: { uri: string; durationMillis: number }, date: string) =>
      enqueue({
        kind: "audio",
        clientId: newClientId(),
        projectId,
        date,
        createdAt: new Date().toISOString(),
        audioUri: await keepRecording(uri),
        mediaType: recordingFormat.mediaType,
        durationMillis,
      }),
    [enqueue, projectId],
  );

  const addText = useCallback(
    (text: string, date: string) =>
      enqueue({ kind: "text", clientId: newClientId(), projectId, date, createdAt: new Date().toISOString(), text }),
    [enqueue, projectId],
  );

  const removeQueued = useCallback(
    async (clientId: string) => {
      const note = queueRef.current.find((candidate) => candidate.clientId === clientId);
      await changeQueue((current) => current.filter((candidate) => candidate.clientId !== clientId));
      if (note?.kind === "audio") discardRecording(note.audioUri);
    },
    [changeQueue],
  );

  const update = useCallback(
    async (id: string, changes: { entryDate?: string; transcript?: string; entry?: DiaryEntry }) => {
      await updateDiaryNote(connection, id, changes);
      await reload();
    },
    [connection, reload],
  );

  const retry = useCallback(
    async (id: string) => {
      await retryDiaryNote(connection, id);
      await reload();
    },
    [connection, reload],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteDiaryNote(connection, id);
      await reload();
    },
    [connection, reload],
  );

  return {
    notes,
    queued: (queue ?? []).filter((note) => note.projectId === projectId),
    addRecording,
    addText,
    removeQueued,
    flush,
    update,
    retry,
    remove,
  };
};
