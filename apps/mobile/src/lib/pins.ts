// Photos (#70) and defects (#74) pinned to a point on a project page, kept on the phone and synced when there is signal.
// Pure logic only (merging the outbox, sync, coordinates), so it is tested without React Native.

export type PinKind = "photo" | "defect";

// A defect is open, then fixed and waiting for a check, then closed.
export type DefectStatus = "open" | "to_check" | "closed";

// Defect photos from before and after the fix; photo pins only have "before".
export type PhotoStage = "before" | "after";

export type PinPhoto = { id: string; width: number; height: number; takenAt: string; stage: PhotoStage };

// What the project says about a defect's spot, written by the server after it syncs; never sent by the phone.
export type DefectSpec = {
  found: boolean;
  statement: string;
  quote: string;
  source: { documentId: string; pageNo: number; title: string | null } | null;
};

export type Pin = {
  id: string;
  documentId: string;
  pageNo: number;
  // Relative to the page: 0..1 from the left and from the top, so a pin stays put whatever size the page is shown at.
  x: number;
  y: number;
  kind: PinKind;
  note: string;
  room: string;
  // Defects only: null and empty on photo pins.
  status: DefectStatus | null;
  assignee: string;
  dueDate: string | null;
  spec?: DefectSpec | null;
  // From the server, and set by the phone for a pin it creates, so a list can name the floor without signal.
  pageTitle?: string | null;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  photos: PinPhoto[];
};

export type PinFields = Omit<Pin, "photos" | "authorName" | "spec">;

// A photo taken on site and not uploaded yet; `uri` is its copy on the phone.
export type PendingPhoto = { id: string; pinId: string; takenAt: string; uri: string; stage: PhotoStage };

export type PinOp =
  | { type: "upsert"; pin: PinFields }
  | { type: "delete"; pinId: string }
  | { type: "photo"; photo: PendingPhoto }
  | { type: "deletePhoto"; pinId: string; photoId: string };

// `server` is the last list the server sent, `outbox` what was done on the phone since, in order.
export type PinState = { server: Pin[]; outbox: PinOp[]; syncedAt: string | null; rejected: string[] };

export const emptyPinState: PinState = { server: [], outbox: [], syncedAt: null, rejected: [] };

export type ViewPhoto = PinPhoto & { localUri?: string; pending: boolean };
export type ViewPin = Omit<Pin, "photos"> & { photos: ViewPhoto[]; pending: boolean };

const opPinId = (op: PinOp) => (op.type === "upsert" ? op.pin.id : op.type === "photo" ? op.photo.pinId : op.pinId);

// What the contractor sees: the server's pins with everything still waiting in the outbox applied on top.
export const visiblePins = ({ server, outbox }: PinState): ViewPin[] => {
  const pins = new Map<string, ViewPin>(
    server.map((pin) => [pin.id, { ...pin, pending: false, photos: pin.photos.map((photo) => ({ ...photo, pending: false })) }]),
  );
  for (const op of outbox) {
    const pin = pins.get(opPinId(op));
    if (op.type === "upsert") {
      pins.set(op.pin.id, { authorName: "", photos: [], ...pin, ...op.pin, pending: true });
    } else if (op.type === "delete") {
      pins.delete(op.pinId);
    } else if (op.type === "photo" && pin && !pin.photos.some((photo) => photo.id === op.photo.id)) {
      const { id, takenAt, uri, stage = "before" } = op.photo;
      pin.photos = [...pin.photos, { id, takenAt, stage, width: 0, height: 0, localUri: uri, pending: true }];
      pin.pending = true;
    } else if (op.type === "deletePhoto" && pin) {
      pin.photos = pin.photos.filter((photo) => photo.id !== op.photoId);
      pin.pending = true;
    }
  }
  return [...pins.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

const photoOps = (outbox: PinOp[]) => outbox.flatMap((op) => (op.type === "photo" ? [op.photo] : []));

// Adds a change to the outbox, folding it into what is already waiting so the phone never sends work that cancels out.
// `dropped` are photos that will never be uploaded now, so their copies on the phone can go.
export const enqueue = (state: PinState, op: PinOp): { state: PinState; dropped: PendingPhoto[] } => {
  const onServer = (pinId: string) => state.server.some((pin) => pin.id === pinId);
  let outbox = state.outbox;
  if (op.type === "upsert") {
    const index = outbox.findIndex((queued) => queued.type === "upsert" && queued.pin.id === op.pin.id);
    // Replaced in place: a new pin's upsert must stay ahead of its photos.
    outbox = index >= 0 ? outbox.map((queued, i) => (i === index ? op : queued)) : [...outbox, op];
  } else if (op.type === "delete") {
    const kept = outbox.filter((queued) => opPinId(queued) !== op.pinId);
    outbox = onServer(op.pinId) ? [...kept, op] : kept;
  } else if (op.type === "deletePhoto") {
    const queuedPhoto = outbox.some((queued) => queued.type === "photo" && queued.photo.id === op.photoId);
    outbox = queuedPhoto ? outbox.filter((queued) => !(queued.type === "photo" && queued.photo.id === op.photoId)) : [...outbox, op];
  } else {
    outbox = [...outbox, op];
  }
  const remaining = new Set(photoOps(outbox).map((photo) => photo.id));
  return { state: { ...state, outbox }, dropped: photoOps(state.outbox).filter((photo) => !remaining.has(photo.id)) };
};

export type PinTransport = {
  putPin: (pin: PinFields) => Promise<unknown>;
  deletePin: (pinId: string) => Promise<unknown>;
  uploadPhoto: (photo: PendingPhoto) => Promise<unknown>;
  deletePhoto: (pinId: string, photoId: string) => Promise<unknown>;
  fetchPins: () => Promise<Pin[]>;
};

export type PinStore = { get: () => PinState; update: (change: (state: PinState) => PinState) => void };

const statusOf = (error: unknown) => (error instanceof Error ? (error as { status?: number }).status : undefined);

// No answer (no signal, timeout), a busy or broken server, or a lost login: keep the change and try again later.
// Any other answer (400, 404, 413) means the server will never take it, so it leaves the outbox and is reported.
const worthRetrying = (status: number | undefined) => status === undefined || status === 401 || status === 403 || status === 429 || status >= 500;

const describeOp = (op: PinOp) =>
  op.type === "photo" ? "zdjęcie" : op.type === "upsert" ? "pinezka" : op.type === "delete" ? "usunięcie pinezki" : "usunięcie zdjęcia";

const send = (op: PinOp, transport: PinTransport) => {
  switch (op.type) {
    case "upsert":
      return transport.putPin(op.pin);
    case "delete":
      return transport.deletePin(op.pinId);
    case "photo":
      return transport.uploadPhoto(op.photo);
    case "deletePhoto":
      return transport.deletePhoto(op.pinId, op.photoId);
  }
};

export type SyncResult = { ok: boolean; sent: PendingPhoto[] };

// Sends the outbox front to back, then takes the server's list. Changes made while it runs simply wait in the outbox
// for the next round; each sent change is removed by identity, so nothing queued meanwhile is lost.
export const syncPins = async (store: PinStore, transport: PinTransport): Promise<SyncResult> => {
  const sent: PendingPhoto[] = [];
  for (;;) {
    const op = store.get().outbox[0];
    if (!op) break;
    try {
      await send(op, transport);
      if (op.type === "photo") sent.push(op.photo);
    } catch (error) {
      const status = statusOf(error);
      if (worthRetrying(status)) return { ok: false, sent };
      store.update((state) => ({ ...state, rejected: [...state.rejected, `${describeOp(op)} (${error instanceof Error ? error.message : status})`] }));
    }
    store.update((state) => ({ ...state, outbox: state.outbox.filter((queued) => queued !== op) }));
  }
  try {
    const server = await transport.fetchPins();
    store.update((state) => ({ ...state, server, syncedAt: new Date().toISOString() }));
    return { ok: true, sent };
  } catch {
    return { ok: false, sent };
  }
};

export const randomId = () => {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// --- Where a pin sits on screen ---

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type Rect = Point & Size;
// The zoomed page: scaled around the centre of the box, then moved.
export type ZoomTransform = { scale: number; translateX: number; translateY: number };

// The part of the box a page shown with resizeMode="contain" actually covers.
export const containRect = (box: Size, image: Size): Rect => {
  if (!image.width || !image.height || !box.width || !box.height) return { x: 0, y: 0, ...box };
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
};

// A tap on screen to a point on the page (0..1), or null when the tap missed the page.
export const screenToPage = (tap: Point, box: Size, zoom: ZoomTransform, rect: Rect): Point | null => {
  const contentX = box.width / 2 + (tap.x - box.width / 2 - zoom.translateX) / zoom.scale;
  const contentY = box.height / 2 + (tap.y - box.height / 2 - zoom.translateY) / zoom.scale;
  const x = (contentX - rect.x) / rect.width;
  const y = (contentY - rect.y) / rect.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
};

export const pageToScreen = (point: Point, box: Size, zoom: ZoomTransform, rect: Rect): Point => {
  const contentX = rect.x + point.x * rect.width;
  const contentY = rect.y + point.y * rect.height;
  return {
    x: box.width / 2 + zoom.translateX + (contentX - box.width / 2) * zoom.scale,
    y: box.height / 2 + zoom.translateY + (contentY - box.height / 2) * zoom.scale,
  };
};

// The pin under a tap, if one is within reach of a finger.
export const pinAt = <T extends Point>(pins: T[], tap: Point, toScreen: (point: Point) => Point, reach = 28): T | null => {
  let best: { pin: T; distance: number } | null = null;
  for (const pin of pins) {
    const at = toScreen(pin);
    const distance = Math.hypot(at.x - tap.x, at.y - tap.y);
    if (distance <= reach && (!best || distance < best.distance)) best = { pin, distance };
  }
  return best?.pin ?? null;
};

export const pinsOnPage = <T extends { documentId: string; pageNo: number }>(pins: T[], documentId: string, pageNo: number) =>
  pins.filter((pin) => pin.documentId === documentId && pin.pageNo === pageNo);
