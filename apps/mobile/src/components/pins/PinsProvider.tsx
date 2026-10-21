import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AppState } from "react-native";
import { deletePhoto, deletePin, fetchPins, putPin } from "../../lib/api";
import { readJson, writeJson } from "../../lib/offlineCache";
import { forgetPhoto, keepPhoto, uploadPhoto } from "../../lib/photoStore";
import { emptyPinState, enqueue, randomId, syncPins, visiblePins } from "../../lib/pins";
import type { PinFields, PinOp, PinState, PinTransport, ViewPin } from "../../lib/pins";
import { useConnection } from "../../lib/settings";

export type PickedPhoto = { uri: string; takenAt: string };

type PinsValue = {
  projectId: string;
  pins: ViewPin[];
  // Changes still on the phone only.
  waiting: number;
  syncing: boolean;
  syncedAt: string | null;
  rejected: string[];
  savePin: (pin: PinFields) => void;
  removePin: (pinId: string) => void;
  addPhotos: (pinId: string, photos: PickedPhoto[]) => void;
  removePhoto: (pinId: string, photoId: string) => void;
  clearRejected: () => void;
  sync: () => void;
};

const PinsContext = createContext<PinsValue | null>(null);

export const usePins = () => {
  const value = useContext(PinsContext);
  if (!value) throw new Error("usePins must be used inside PinsProvider");
  return value;
};

const RETRY_MS = 60_000;
// Several quick changes (a pin, then three photos) go out in one round.
const SYNC_DELAY_MS = 800;

// The project's pins and photos on the phone: saved after every change, sent whenever there is signal (at start,
// after a change, when the app comes back to the foreground, and every minute while something is waiting).
export const PinsProvider = ({ projectId, children }: { projectId: string; children: ReactNode }) => {
  const connection = useConnection();
  const storageKey = `pins-${projectId}`;
  const [state, setState] = useState<PinState>(emptyPinState);
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const stateRef = useRef(state);
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const update = useCallback(
    (change: (current: PinState) => PinState) => {
      stateRef.current = change(stateRef.current);
      setState(stateRef.current);
      void writeJson(connection, storageKey, stateRef.current);
    },
    [connection, storageKey],
  );

  const transport = useMemo<PinTransport>(
    () => ({
      putPin: (pin) => putPin(connection, projectId, pin),
      deletePin: (pinId) => deletePin(connection, projectId, pinId),
      uploadPhoto: (photo) => uploadPhoto(connection, projectId, photo),
      deletePhoto: (_pinId, photoId) => deletePhoto(connection, projectId, photoId),
      fetchPins: () => fetchPins(connection, projectId),
    }),
    [connection, projectId],
  );

  const sync = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setSyncing(true);
    try {
      await syncPins({ get: () => stateRef.current, update }, transport);
    } finally {
      running.current = false;
      setSyncing(false);
    }
  }, [transport, update]);

  const syncSoon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void sync(), SYNC_DELAY_MS);
  }, [sync]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await readJson<PinState>(connection, storageKey).catch(() => null);
      if (cancelled) return;
      stateRef.current = { ...emptyPinState, ...saved };
      setState(stateRef.current);
      setLoaded(true);
      void sync();
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, storageKey, sync]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active" && loaded) void sync();
    });
    return () => subscription.remove();
  }, [loaded, sync]);

  const waiting = state.outbox.length;
  useEffect(() => {
    if (!loaded || waiting === 0) return;
    const retry = setInterval(() => void sync(), RETRY_MS);
    return () => clearInterval(retry);
  }, [loaded, waiting, sync]);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const queue = useCallback(
    (op: PinOp) => {
      let dropped: { id: string }[] = [];
      update((current) => {
        const result = enqueue(current, op);
        dropped = result.dropped;
        return result.state;
      });
      dropped.forEach((photo) => forgetPhoto(connection, photo.id));
      syncSoon();
    },
    [connection, update, syncSoon],
  );

  const value = useMemo<PinsValue>(
    () => ({
      projectId,
      pins: visiblePins(state),
      waiting,
      syncing,
      syncedAt: state.syncedAt,
      rejected: state.rejected,
      savePin: (pin) => queue({ type: "upsert", pin }),
      removePin: (pinId) => queue({ type: "delete", pinId }),
      addPhotos: (pinId, photos) =>
        photos.forEach(({ uri, takenAt }) => {
          const id = randomId();
          queue({ type: "photo", photo: { id, pinId, takenAt, uri: keepPhoto(connection, id, uri) } });
        }),
      removePhoto: (pinId, photoId) => {
        queue({ type: "deletePhoto", pinId, photoId });
        forgetPhoto(connection, photoId);
      },
      clearRejected: () => update((current) => ({ ...current, rejected: [] })),
      sync: () => void sync(),
    }),
    [projectId, state, waiting, syncing, queue, connection, update, sync],
  );

  return <PinsContext.Provider value={value}>{children}</PinsContext.Provider>;
};
