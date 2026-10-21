import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { sql } from "../src/db.js";
import { searchPins } from "../src/pins.js";
import { photoFile } from "../src/storage.js";
import { ADMIN, APP, addMember, createDocument, createProject, createUser, insertPage, login, resetDatabase } from "./helpers.js";

let projectId: string;
let documentId: string;

beforeEach(async () => {
  await resetDatabase();
  projectId = await createProject();
  documentId = await createDocument(projectId, "ready");
  await sql`update documents set page_count = 42 where id = ${documentId}`;
});

afterAll(async () => {
  await sql.end();
});

const pinBody = (fields: Record<string, unknown> = {}) => ({
  documentId,
  pageNo: 12,
  x: 0.25,
  y: 0.75,
  note: "Rury przed zakryciem",
  room: "Łazienka",
  createdAt: "2026-10-20T08:00:00.000Z",
  updatedAt: "2026-10-20T08:00:00.000Z",
  ...fields,
});

const putPin = (pinId: string, body: object, headers: Record<string, string> = APP, project = projectId) =>
  app.request(`/api/projects/${project}/pins/${pinId}`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const photo = (width = 4000, height = 3000) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toBuffer();

const putPhoto = async (pinId: string, photoId: string, body: Uint8Array, query = "?takenAt=2026-10-20T08:01:00.000Z") =>
  app.request(`/api/projects/${projectId}/pins/${pinId}/photos/${photoId}${query}`, {
    method: "PUT",
    headers: { ...APP, "content-type": "image/jpeg" },
    body: new Uint8Array(body),
  });

const listPins = async (headers: Record<string, string> = APP) => {
  const response = await app.request(`/api/projects/${projectId}/pins`, { headers });
  return (await response.json()) as { pins: { id: string; note: string; photos: { id: string; width: number }[] }[] };
};

describe("pins", () => {
  it("creates a pin once, however many times the phone retries", async () => {
    const pinId = randomUUID();

    expect((await putPin(pinId, pinBody())).status).toBe(200);
    expect((await putPin(pinId, pinBody())).status).toBe(200);

    const { pins } = await listPins();
    expect(pins).toEqual([
      expect.objectContaining({ id: pinId, documentId, pageNo: 12, x: 0.25, y: 0.75, kind: "photo", room: "Łazienka", photos: [] }),
    ]);
  });

  it("keeps the newer edit when an older one arrives late", async () => {
    const pinId = randomUUID();
    await putPin(pinId, pinBody({ note: "nowsza", updatedAt: "2026-10-20T10:00:00.000Z" }));

    await putPin(pinId, pinBody({ note: "starsza", updatedAt: "2026-10-20T09:00:00.000Z" }));

    expect((await listPins()).pins[0]!.note).toBe("nowsza");
  });

  it("rejects a point outside the page and a page of another project", async () => {
    expect((await putPin(randomUUID(), pinBody({ x: 1.2 }))).status).toBe(400);
    expect((await putPin(randomUUID(), pinBody({ pageNo: 43 }))).status).toBe(400);
    const otherDocument = await createDocument(await createProject("Inny"), "ready");
    expect((await putPin(randomUUID(), pinBody({ documentId: otherDocument }))).status).toBe(400);
  });

  it("hides pins of projects a contractor is not a member of", async () => {
    const userId = await createUser("ekipa@example.com", "contractor");
    const contractor = await login("ekipa@example.com");
    await putPin(randomUUID(), pinBody());

    expect((await app.request(`/api/projects/${projectId}/pins`, { headers: contractor })).status).toBe(404);
    expect((await putPin(randomUUID(), pinBody(), contractor)).status).toBe(404);

    await addMember(projectId, userId);
    const created = await putPin(randomUUID(), pinBody({ note: "od ekipy" }), contractor);
    expect(await created.json()).toMatchObject({ note: "od ekipy", authorName: "ekipa" });
  });

  it("stores a photo downsized with a thumbnail, once per photo id", async () => {
    const pinId = randomUUID();
    const photoId = randomUUID();
    await putPin(pinId, pinBody());

    const first = await putPhoto(pinId, photoId, await photo());
    const again = await putPhoto(pinId, photoId, await photo());

    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ id: photoId, width: 2560, height: 1920, takenAt: "2026-10-20T08:01:00.000Z" });
    expect(again.status).toBe(200);
    expect((await listPins()).pins[0]!.photos).toEqual([expect.objectContaining({ id: photoId, width: 2560 })]);
    const thumb = await app.request(`/api/projects/${projectId}/photos/${photoId}/image?size=thumb&token=test-app`);
    expect(thumb.status).toBe(200);
    expect(await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()).toMatchObject({ width: 480, height: 360 });
  });

  it("refuses a file that is not an image, and a photo for a missing pin", async () => {
    const pinId = randomUUID();
    await putPin(pinId, pinBody());

    expect((await putPhoto(pinId, randomUUID(), new TextEncoder().encode("to nie jest jpeg"))).status).toBe(400);
    expect((await putPhoto(randomUUID(), randomUUID(), await photo(10, 10))).status).toBe(404);
  });

  it("removes the photo files with the pin, and again with the document", async () => {
    const pinId = randomUUID();
    const photoId = randomUUID();
    await putPin(pinId, pinBody());
    await putPhoto(pinId, photoId, await photo(100, 100));

    const deleted = await app.request(`/api/projects/${projectId}/pins/${pinId}`, { method: "DELETE", headers: APP });
    const again = await app.request(`/api/projects/${projectId}/pins/${pinId}`, { method: "DELETE", headers: APP });

    expect([deleted.status, again.status]).toEqual([204, 204]);
    expect((await listPins()).pins).toEqual([]);
    await expect(stat(photoFile(projectId, photoId, "full"))).rejects.toThrow();

    const secondPin = randomUUID();
    const secondPhoto = randomUUID();
    await putPin(secondPin, pinBody());
    await putPhoto(secondPin, secondPhoto, await photo(100, 100));
    await app.request(`/api/documents/${documentId}`, { method: "DELETE", headers: ADMIN });
    await expect(stat(photoFile(projectId, secondPhoto, "thumb"))).rejects.toThrow();
  });
});

describe("searchPins", () => {
  it("finds photos by inflected words of the note, room and page title, and by date", async () => {
    await insertPage(projectId, documentId, 12, { title: "Rzut parteru" });
    await putPin(randomUUID(), pinBody({ note: "Instalacja wodna przed zakryciem", room: "Łazienka", createdAt: "2026-10-10T09:00:00Z" }));
    await putPin(randomUUID(), pinBody({ note: "Zbrojenie stropu", room: "Salon", createdAt: "2026-10-18T09:00:00Z" }));

    const bathroom = await searchPins(projectId, { query: "instalacji w łazience" });
    const byTitle = await searchPins(projectId, { query: "parter" });
    const octoberTenth = await searchPins(projectId, { from: "2026-10-10", to: "2026-10-10" });

    expect(bathroom.map((pin) => pin.room)).toEqual(["Łazienka"]);
    expect(bathroom[0]).toMatchObject({ pageTitle: "Rzut parteru", pageNo: 12 });
    expect(byTitle).toHaveLength(2);
    expect(octoberTenth.map((pin) => pin.room)).toEqual(["Łazienka"]);
    expect(await searchPins(projectId, { query: "dach" })).toEqual([]);
  });
});
