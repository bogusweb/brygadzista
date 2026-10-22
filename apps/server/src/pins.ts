import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { isUuid, requireProjectAccess, requireRole, requireRoleOrQueryToken, type AuthEnv } from "./auth.js";
import { config } from "./config.js";
import { detached, sql } from "./db.js";
import { queryTerms } from "./search.js";
import { describeDefect } from "./defect-spec.js";
import { photoFile, projectDir } from "./storage.js";

// The server runs in 768 MB next to indexing, so photos are processed one at a time without libvips' cache.
sharp.cache(false);
sharp.concurrency(1);

export const PIN_KINDS = ["photo", "defect"] as const;
export type PinKind = (typeof PIN_KINDS)[number];

// A defect is open, then fixed and waiting for a check, then closed (#74).
export const DEFECT_STATUSES = ["open", "to_check", "closed"] as const;
export type DefectStatus = (typeof DEFECT_STATUSES)[number];

export const PHOTO_STAGES = ["before", "after"] as const;
export type PhotoStage = (typeof PHOTO_STAGES)[number];

const MAX_NOTE_CHARS = 4000;
const MAX_ROOM_CHARS = 200;
const MAX_ASSIGNEE_CHARS = 200;

export type PinPhoto = { id: string; width: number; height: number; takenAt: Date; stage: PhotoStage };

// What the project says about a defect's spot, with a quote from the page it comes from.
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
  x: number;
  y: number;
  kind: PinKind;
  note: string;
  room: string;
  status: DefectStatus | null;
  assignee: string;
  dueDate: string | null;
  spec: DefectSpec | null;
  authorName: string;
  createdAt: Date;
  updatedAt: Date;
  photos: PinPhoto[];
};

export const pinColumns = sql`
  p.id, p.document_id as "documentId", p.page_no as "pageNo", p.x, p.y, p.kind, p.note, p.room, p.status, p.assignee,
  p.due_date::text as "dueDate", p.spec, p.author_name as "authorName", p.created_at as "createdAt", p.updated_at as "updatedAt"`;

export const pinPhotosJson = sql`
  coalesce((select json_agg(json_build_object('id', ph.id, 'width', ph.width, 'height', ph.height, 'takenAt', ph.taken_at, 'stage', ph.stage)
    order by ph.taken_at) from pin_photos ph where ph.pin_id = p.id), '[]')`;

// The page title comes along, so the phone can name the floor of a defect without signal.
const pinRows = (where: ReturnType<typeof sql>, limit = 10_000) => sql<(Pin & { pageTitle: string | null })[]>`
  select ${pinColumns}, pg.title as "pageTitle", ${pinPhotosJson} as photos
  from pins p left join pages pg on pg.document_id = p.document_id and pg.page_no = p.page_no
  where ${where} order by p.created_at desc limit ${limit}`;

const isDate = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isDay = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const isUnit = (value: unknown): value is number => typeof value === "number" && value >= 0 && value <= 1;

type PinInput = {
  documentId: string;
  pageNo: number;
  x: number;
  y: number;
  kind: PinKind;
  note: string;
  room: string;
  status: DefectStatus | null;
  assignee: string;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
};

const parsePin = (body: Record<string, unknown>): PinInput | string => {
  if (typeof body.documentId !== "string" || !isUuid(body.documentId)) return "Brak dokumentu";
  if (!Number.isInteger(body.pageNo) || (body.pageNo as number) < 1) return "Zły numer strony";
  if (!isUnit(body.x) || !isUnit(body.y)) return "Punkt musi leżeć na stronie";
  const kind = body.kind ?? "photo";
  if (!PIN_KINDS.includes(kind as PinKind)) return "Nieznany rodzaj pinezki";
  const note = body.note ?? "";
  const room = body.room ?? "";
  if (typeof note !== "string" || note.length > MAX_NOTE_CHARS) return `Notatka może mieć najwyżej ${MAX_NOTE_CHARS} znaków`;
  if (typeof room !== "string" || room.length > MAX_ROOM_CHARS) return "Za długa nazwa pomieszczenia";
  if (!isDate(body.createdAt) || !isDate(body.updatedAt)) return "Brak daty";
  // Status, person and deadline belong to defects only; a photo pin keeps none of them.
  const defect = kind === "defect";
  const status = defect ? (body.status ?? "open") : null;
  if (defect && !DEFECT_STATUSES.includes(status as DefectStatus)) return "Nieznany status usterki";
  const assignee = defect ? (body.assignee ?? "") : "";
  if (typeof assignee !== "string" || assignee.length > MAX_ASSIGNEE_CHARS) return "Za długie nazwisko osoby odpowiedzialnej";
  const dueDate = defect ? (body.dueDate ?? null) : null;
  if (dueDate !== null && !isDay(dueDate)) return "Zły termin (RRRR-MM-DD)";
  return {
    documentId: body.documentId,
    pageNo: body.pageNo as number,
    x: body.x,
    y: body.y,
    kind: kind as PinKind,
    note: note.trim(),
    room: room.trim(),
    status: status as DefectStatus | null,
    assignee: assignee.trim(),
    dueDate,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
  };
};

const removePhotoFiles = (projectId: string, photoIds: string[]) =>
  Promise.all(photoIds.flatMap((id) => [photoFile(projectId, id, "full"), photoFile(projectId, id, "thumb")].map((file) => rm(file, { force: true }))));

// Called before a document is deleted: its pins go with it by cascade, their photo files have to be removed by hand.
export const removeDocumentPhotos = async (documentId: string) => {
  const photos = await sql<{ id: string; projectId: string }[]>`
    select ph.id, ph.project_id as "projectId" from pin_photos ph join pins p on p.id = ph.pin_id where p.document_id = ${documentId}`;
  await Promise.all(photos.map((photo) => removePhotoFiles(photo.projectId, [photo.id])));
};

export const removeProjectFiles = (projectId: string) => rm(projectDir(projectId), { recursive: true, force: true });

// Writes under a temporary name first, so an interrupted write never leaves half a photo under the real name.
const writeAtomically = async (file: string, data: Buffer) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.part`, data);
  await rename(`${file}.part`, file);
};

// EXIF orientation is applied and all metadata dropped (GPS included); the stored copy is a JPEG no bigger than needed.
const processPhoto = async (input: Buffer) => {
  const full = await sharp(input, { failOn: "error" })
    .rotate()
    .resize({ width: config.photoMaxEdge, height: config.photoMaxEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const thumb = await sharp(full.data)
    .resize({ width: config.photoThumbEdge, height: config.photoThumbEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();
  return { full: full.data, thumb, width: full.info.width, height: full.info.height };
};

export const pins = new Hono<AuthEnv>();

const projectPin = async (projectId: string, pinId: string) => {
  if (!isUuid(pinId)) return null;
  const [pin] = await sql<{ id: string }[]>`select id from pins where id = ${pinId} and project_id = ${projectId}`;
  return pin ?? null;
};

// Everything the app keeps on the phone for the project: few enough (hundreds) to send whole on every sync.
pins.get("/api/projects/:id/pins", requireRole("app", "admin"), requireProjectAccess(), async (c) =>
  c.json({ pins: await pinRows(sql`p.project_id = ${c.req.param("id")}`) }),
);

// Create or update, keyed by the id the phone generated. The newer `updatedAt` wins, so a phone syncing an old edit late
// does not overwrite a newer one from another phone.
pins.put("/api/projects/:id/pins/:pinId", requireRole("app", "admin"), requireProjectAccess(), async (c) => {
  const projectId = c.req.param("id");
  const pinId = c.req.param("pinId");
  if (!isUuid(pinId)) return c.json({ error: "Zły identyfikator pinezki" }, 400);
  const input = parsePin(await c.req.json<Record<string, unknown>>().catch(() => ({})));
  if (typeof input === "string") return c.json({ error: input }, 400);
  const [page] = await sql`
    select 1 from documents d where d.id = ${input.documentId} and d.project_id = ${projectId}
      and (d.page_count = 0 or ${input.pageNo} <= d.page_count)`;
  if (!page) return c.json({ error: "Nie ma takiej strony w projekcie" }, 400);
  const [other] = await sql`select 1 from pins where id = ${pinId} and project_id <> ${projectId}`;
  if (other) return c.json({ error: "Nie ma takiej pinezki" }, 404);

  const { user } = c.get("principal");
  await sql`
    insert into pins (id, project_id, document_id, page_no, x, y, kind, note, room, status, assignee, due_date, created_by, author_name,
      created_at, updated_at)
    values (${pinId}, ${projectId}, ${input.documentId}, ${input.pageNo}, ${input.x}, ${input.y}, ${input.kind}, ${input.note},
      ${input.room}, ${input.status}, ${input.assignee}, ${input.dueDate}, ${user?.id ?? null}, ${user?.name || user?.email || ""},
      ${input.createdAt}, ${input.updatedAt})
    on conflict (id) do update set document_id = excluded.document_id, page_no = excluded.page_no, x = excluded.x, y = excluded.y,
      kind = excluded.kind, note = excluded.note, room = excluded.room, status = excluded.status, assignee = excluded.assignee,
      due_date = excluded.due_date, updated_at = excluded.updated_at
    where pins.updated_at <= excluded.updated_at`;
  // A new or changed defect description is looked up in the project in the background; the phone sees it on its next sync.
  if (input.kind === "defect") detached(() => describeDefect(pinId));
  const [pin] = await pinRows(sql`p.id = ${pinId}`);
  return c.json(pin);
});

// Deleting what is already gone succeeds too: the phone may retry a delete whose answer it never got.
pins.delete("/api/projects/:id/pins/:pinId", requireRole("app", "admin"), requireProjectAccess(), async (c) => {
  const projectId = c.req.param("id");
  if (!(await projectPin(projectId, c.req.param("pinId")))) return c.body(null, 204);
  const photos = await sql<{ id: string }[]>`select id from pin_photos where pin_id = ${c.req.param("pinId")}`;
  await sql`delete from pins where id = ${c.req.param("pinId")}`;
  await removePhotoFiles(projectId, photos.map((photo) => photo.id));
  return c.body(null, 204);
});

// The body is the image itself (JPEG, PNG, WebP). Uploading the same photo id again answers with the stored photo.
pins.put(
  "/api/projects/:id/pins/:pinId/photos/:photoId",
  requireRole("app", "admin"),
  requireProjectAccess(),
  bodyLimit({
    maxSize: config.maxPhotoBytes,
    onError: (c) => c.json({ error: `Zdjęcie jest za duże (limit ${Math.round(config.maxPhotoBytes / 1024 / 1024)} MB)` }, 413),
  }),
  async (c) => {
    const projectId = c.req.param("id");
    const { pinId, photoId } = c.req.param();
    if (!isUuid(photoId)) return c.json({ error: "Zły identyfikator zdjęcia" }, 400);
    if (!(await projectPin(projectId, pinId))) return c.json({ error: "Nie ma takiej pinezki" }, 404);
    const takenAt = c.req.query("takenAt") ?? new Date().toISOString();
    if (!isDate(takenAt)) return c.json({ error: "Zła data zdjęcia" }, 400);
    const stage = c.req.query("stage") ?? "before";
    if (!PHOTO_STAGES.includes(stage as PhotoStage)) return c.json({ error: "Zły etap zdjęcia" }, 400);
    const [existing] = await sql<PinPhoto[]>`
      select id, width, height, taken_at as "takenAt", stage from pin_photos where id = ${photoId} and pin_id = ${pinId}`;
    if (existing) return c.json(existing);

    const body = Buffer.from(await c.req.arrayBuffer());
    const processed = await processPhoto(body).catch(() => null);
    if (!processed) return c.json({ error: "To nie jest zdjęcie albo plik jest uszkodzony" }, 400);
    await writeAtomically(photoFile(projectId, photoId, "full"), processed.full);
    await writeAtomically(photoFile(projectId, photoId, "thumb"), processed.thumb);
    const [photo] = await sql<PinPhoto[]>`
      insert into pin_photos (id, pin_id, project_id, width, height, bytes, taken_at, stage)
      values (${photoId}, ${pinId}, ${projectId}, ${processed.width}, ${processed.height}, ${processed.full.length}, ${takenAt}, ${stage})
      on conflict (id) do nothing
      returning id, width, height, taken_at as "takenAt", stage`;
    if (!photo) return c.json({ error: "To zdjęcie należy do innej pinezki" }, 409);
    return c.json(photo, 201);
  },
);

pins.delete("/api/projects/:id/photos/:photoId", requireRole("app", "admin"), requireProjectAccess(), async (c) => {
  const projectId = c.req.param("id");
  const photoId = c.req.param("photoId");
  if (!isUuid(photoId)) return c.body(null, 204);
  await sql`delete from pin_photos where id = ${photoId} and project_id = ${projectId}`;
  await removePhotoFiles(projectId, [photoId]);
  return c.body(null, 204);
});

// Like page images, photos accept ?token= because <img src> in the browser cannot send headers.
pins.get("/api/projects/:id/photos/:photoId/image", requireRoleOrQueryToken("app", "admin"), requireProjectAccess(), async (c) => {
  const projectId = c.req.param("id");
  const photoId = c.req.param("photoId");
  const missing = () => c.json({ error: "Nie ma takiego zdjęcia" }, 404);
  if (!isUuid(photoId)) return missing();
  const [photo] = await sql`select 1 from pin_photos where id = ${photoId} and project_id = ${projectId}`;
  if (!photo) return missing();
  const file = photoFile(projectId, photoId, c.req.query("size") === "thumb" ? "thumb" : "full");
  if (!(await stat(file).catch(() => null))) return missing();
  c.header("Content-Type", "image/jpeg");
  // A photo never changes under its id.
  c.header("Cache-Control", "private, max-age=31536000, immutable");
  return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
});

export const photoImagePath = (projectId: string, photoId: string, size: "full" | "thumb" = "full") =>
  `/api/projects/${projectId}/photos/${photoId}/image${size === "thumb" ? "?size=thumb" : ""}`;

export type PinSearch = {
  query?: string | undefined;
  documentId?: string | undefined;
  pageNo?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
};

// For the agent: "zdjęcia instalacji w łazience przed zakryciem" → pins whose note, room or page title hold the words,
// optionally on one page and within dates. Without words every pin in range matches, newest first.
export const searchPins = async (projectId: string, { query = "", documentId, pageNo, from, to, limit = 20 }: PinSearch) => {
  const terms = queryTerms(query);
  const text = sql`to_tsvector('simple', p.note || ' ' || p.room || ' ' || coalesce(pg.title, ''))`;
  const filters = [
    sql`p.project_id = ${projectId}`,
    documentId && isUuid(documentId) ? sql`p.document_id = ${documentId}` : null,
    pageNo ? sql`p.page_no = ${pageNo}` : null,
    from && isDate(from) ? sql`p.created_at >= ${from}` : null,
    // A bare date as the end means the whole of that day.
    to && isDate(to) ? sql`p.created_at < ${/^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to}` : null,
  ].filter((filter) => filter !== null);
  const where = filters.reduce((all, filter) => sql`${all} and ${filter}`);
  const matched = terms.length
    ? sql`(select count(*) from unnest(${terms}::text[]) term where ${text} @@ to_tsquery('simple', term))`
    : sql`0`;
  return sql<(Pin & { pageTitle: string | null; matched: number })[]>`
    select * from (
      select ${pinColumns}, pg.title as "pageTitle", ${matched}::int as matched, ${pinPhotosJson} as photos
      from pins p left join pages pg on pg.document_id = p.document_id and pg.page_no = p.page_no
      where ${where}
    ) found
    where ${terms.length}::int = 0 or matched > 0
    order by matched desc, "createdAt" desc limit ${limit}`;
};
