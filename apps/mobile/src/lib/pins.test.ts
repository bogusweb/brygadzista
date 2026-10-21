import { describe, expect, it, vi } from "vitest";
import {
  containRect,
  emptyPinState,
  enqueue,
  pageToScreen,
  pinAt,
  randomId,
  screenToPage,
  syncPins,
  visiblePins,
  type Pin,
  type PinFields,
  type PinOp,
  type PinState,
  type PinTransport,
} from "./pins";

const fields = (id: string, note = ""): PinFields => ({
  id,
  documentId: "doc",
  pageNo: 12,
  x: 0.5,
  y: 0.5,
  kind: "photo",
  note,
  room: "",
  createdAt: "2026-10-20T08:00:00.000Z",
  updatedAt: "2026-10-20T08:00:00.000Z",
});

const serverPin = (id: string, note = ""): Pin => ({ ...fields(id, note), authorName: "Jan", photos: [] });

const photoOp = (id: string, pinId: string): PinOp => ({ type: "photo", photo: { id, pinId, takenAt: "2026-10-20T08:01:00.000Z", uri: `file:///${id}.jpg` } });

const apply = (state: PinState, ...ops: PinOp[]) => ops.reduce((current, op) => enqueue(current, op).state, state);

class HttpError extends Error {
  constructor(readonly status?: number) {
    super(`http ${status}`);
  }
}

const memoryStore = (initial: PinState) => {
  let state = initial;
  return { get: () => state, update: (change: (state: PinState) => PinState) => void (state = change(state)) };
};

const transport = (overrides: Partial<PinTransport> = {}): PinTransport => ({
  putPin: vi.fn(async () => undefined),
  deletePin: vi.fn(async () => undefined),
  uploadPhoto: vi.fn(async () => undefined),
  deletePhoto: vi.fn(async () => undefined),
  fetchPins: vi.fn(async () => []),
  ...overrides,
});

describe("visiblePins", () => {
  it("shows a pin made offline, with its photo, as pending", () => {
    const state = apply(emptyPinState, { type: "upsert", pin: fields("a", "rury") }, photoOp("p1", "a"));

    expect(visiblePins(state)).toEqual([
      expect.objectContaining({ id: "a", note: "rury", pending: true, photos: [expect.objectContaining({ id: "p1", localUri: "file:///p1.jpg", pending: true })] }),
    ]);
  });

  it("applies edits and deletions on top of the server's list", () => {
    const state = apply(
      { ...emptyPinState, server: [serverPin("a", "stara"), serverPin("b")] },
      { type: "upsert", pin: fields("a", "nowa") },
      { type: "delete", pinId: "b" },
    );

    expect(visiblePins(state).map((pin) => [pin.id, pin.note, pin.authorName])).toEqual([["a", "nowa", "Jan"]]);
  });
});

describe("enqueue", () => {
  it("keeps one upsert per pin, ahead of its photos", () => {
    const state = apply(emptyPinState, { type: "upsert", pin: fields("a", "1") }, photoOp("p1", "a"), { type: "upsert", pin: fields("a", "2") });

    expect(state.outbox.map((op) => op.type)).toEqual(["upsert", "photo"]);
    expect(state.outbox[0]).toMatchObject({ pin: { note: "2" } });
  });

  it("forgets a pin that never reached the server, and hands back its photos to delete", () => {
    const withPin = apply(emptyPinState, { type: "upsert", pin: fields("a") }, photoOp("p1", "a"));

    const { state, dropped } = enqueue(withPin, { type: "delete", pinId: "a" });

    expect(state.outbox).toEqual([]);
    expect(dropped.map((photo) => photo.id)).toEqual(["p1"]);
  });

  it("sends a delete for a pin the server has", () => {
    const state = apply({ ...emptyPinState, server: [serverPin("a")] }, photoOp("p1", "a"), { type: "delete", pinId: "a" });

    expect(state.outbox).toEqual([{ type: "delete", pinId: "a" }]);
  });

  it("drops a photo removed before it was uploaded instead of sending its deletion", () => {
    const state = apply({ ...emptyPinState, server: [serverPin("a")] }, photoOp("p1", "a"), { type: "deletePhoto", pinId: "a", photoId: "p1" });

    expect(state.outbox).toEqual([]);
  });
});

describe("syncPins", () => {
  it("sends the outbox in order and takes the server's list", async () => {
    const store = memoryStore(apply(emptyPinState, { type: "upsert", pin: fields("a") }, photoOp("p1", "a")));
    const calls: string[] = [];
    const api = transport({
      putPin: vi.fn(async () => void calls.push("pin")),
      uploadPhoto: vi.fn(async () => void calls.push("photo")),
      fetchPins: vi.fn(async () => [serverPin("a")]),
    });

    const result = await syncPins(store, api);

    expect(calls).toEqual(["pin", "photo"]);
    expect(result).toMatchObject({ ok: true, sent: [expect.objectContaining({ id: "p1" })] });
    expect(store.get()).toMatchObject({ outbox: [], server: [expect.objectContaining({ id: "a" })] });
    expect(store.get().syncedAt).not.toBeNull();
  });

  it("stops without losing anything when there is no signal", async () => {
    const store = memoryStore(apply(emptyPinState, { type: "upsert", pin: fields("a") }, photoOp("p1", "a")));
    const api = transport({ uploadPhoto: vi.fn(async () => Promise.reject(new HttpError())) });

    const result = await syncPins(store, api);

    expect(result.ok).toBe(false);
    expect(store.get().outbox.map((op) => op.type)).toEqual(["photo"]);
    expect(api.fetchPins).not.toHaveBeenCalled();
  });

  it("reports and skips a change the server refuses, then carries on", async () => {
    const store = memoryStore(apply(emptyPinState, { type: "upsert", pin: fields("a") }, { type: "upsert", pin: fields("b") }));
    const api = transport({ putPin: vi.fn(async (pin: PinFields) => (pin.id === "a" ? Promise.reject(new HttpError(400)) : undefined)) });

    await syncPins(store, api);

    expect(store.get().outbox).toEqual([]);
    expect(store.get().rejected).toEqual(["pinezka (http 400)"]);
    expect(api.putPin).toHaveBeenCalledTimes(2);
  });

  it("keeps a change queued while the sync was running", async () => {
    const store = memoryStore(apply(emptyPinState, { type: "upsert", pin: fields("a") }));
    const api = transport({
      putPin: vi.fn(async () => {
        store.update((state) => enqueue(state, photoOp("p1", "a")).state);
      }),
      uploadPhoto: vi.fn(async () => Promise.reject(new HttpError(503))),
    });

    await syncPins(store, api);

    expect(store.get().outbox.map((op) => op.type)).toEqual(["photo"]);
  });
});

describe("coordinates", () => {
  const box = { width: 400, height: 800 };
  // A landscape A3 sheet in a portrait box: letterboxed top and bottom.
  const rect = containRect(box, { width: 4200, height: 2970 });

  it("fits the page inside the box", () => {
    expect(rect.x).toBe(0);
    expect(rect.width).toBe(400);
    expect(rect.height).toBeCloseTo(282.86, 1);
    expect(rect.y).toBeCloseTo((800 - 282.86) / 2, 1);
  });

  it("maps a tap to the page and back, also when zoomed and moved", () => {
    const zoom = { scale: 3, translateX: 120, translateY: -60 };
    const page = screenToPage({ x: 250, y: 380 }, box, zoom, rect)!;

    expect(page.x).toBeGreaterThan(0);
    expect(page.x).toBeLessThan(1);
    const back = pageToScreen(page, box, zoom, rect);
    expect(back.x).toBeCloseTo(250);
    expect(back.y).toBeCloseTo(380);
  });

  it("ignores a tap beside the page", () => {
    expect(screenToPage({ x: 200, y: 50 }, box, { scale: 1, translateX: 0, translateY: 0 }, rect)).toBeNull();
  });

  it("finds the pin under a finger", () => {
    const zoom = { scale: 1, translateX: 0, translateY: 0 };
    const toScreen = (point: { x: number; y: number }) => pageToScreen(point, box, zoom, rect);
    const pins = [{ id: "a", x: 0.5, y: 0.5 }, { id: "b", x: 0.55, y: 0.5 }];

    expect(pinAt(pins, { x: 218, y: 400 }, toScreen)?.id).toBe("b");
    expect(pinAt(pins, { x: 50, y: 400 }, toScreen)).toBeNull();
  });
});

it("makes v4 uuids the server accepts", () => {
  expect(randomId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
