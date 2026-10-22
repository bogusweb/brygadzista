import { Hono, type MiddlewareHandler } from "hono";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { canAccessProject, isUuid, requireProjectAccess, requireRole, type AuthEnv } from "./auth.js";
import { config } from "./config.js";
import { detached, sql, withTenant } from "./db.js";
import { audioType, diaryEntrySchema, fakeOrganize, fakeTranscript, type CandidatePage, type DiaryEntry } from "./diary-entry.js";
import { organizeTranscript, transcribeAudio } from "./diary-llm.js";
import { limiters, rateLimit } from "./rate-limit.js";
import { statusOf } from "./retry.js";
import { codeSearch, lexicalSearch } from "./search.js";
import { diaryAudio } from "./storage.js";

// Daily site log (#69): a voice note (or typed text) becomes a sorted entry of the day. The note is saved first and
// sorted in the background, so the phone gets an answer at once and a failed model call can be retried from the saved audio.

type EntryRow = {
  id: string;
  projectId: string;
  clientId: string | null;
  entryDate: string;
  source: "audio" | "text";
  transcript: string;
  entry: DiaryEntry | null;
  status: "queued" | "processing" | "ready" | "error";
  error: string | null;
  edited: boolean;
  authorName: string;
  createdAt: Date;
  updatedAt: Date;
};

const entryColumns = sql`
  id, project_id as "projectId", client_id as "clientId", entry_date::text as "entryDate", source, transcript, entry,
  status, error, edited, author_name as "authorName", created_at as "createdAt", updated_at as "updatedAt"`;

const entryById = async (id: string) => {
  const [row] = await sql<EntryRow[]>`select ${entryColumns} from diary_entries where id = ${id}`;
  return row ?? null;
};

const isDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

const MAX_TEXT_CHARS = 20_000;
const MAX_CLIENT_ID_CHARS = 100;

class DiaryError extends Error {}

// Lexical and code matches only: they cost nothing, and a note says "ławy" or "A-04" in the project's own words.
const CANDIDATE_PAGES = 8;

const candidatePages = async (projectId: string, transcript: string): Promise<CandidatePage[]> => {
  const [lexical, codes] = await Promise.all([
    lexicalSearch(projectId, transcript, CANDIDATE_PAGES),
    codeSearch(projectId, transcript, CANDIDATE_PAGES / 2),
  ]);
  const ids = [...new Set([...codes.map((row) => row.page_id), ...lexical.filter((row) => row.coverage > 0).map((row) => row.page_id)])];
  if (ids.length === 0) return [];
  const rows = await sql<(CandidatePage & { id: string })[]>`
    select id, document_id as "documentId", page_no as "pageNo", title from pages where id in ${sql(ids.slice(0, CANDIDATE_PAGES))}`;
  const byId = new Map(rows.map(({ id, ...page }) => [id, page]));
  return ids.flatMap((id) => byId.get(id) ?? []);
};

const failureMessage = (error: unknown) => {
  if (error instanceof DiaryError) return error.message;
  const status = statusOf(error);
  if (status === 402 || status === 429) return "Model jest chwilowo niedostępny (limit budżetu albo zapytań). Spróbuj ponownie później.";
  return "Nie udało się uporządkować wpisu. Spróbuj ponownie.";
};

const transcribe = async (row: { id: string; audio_file: string | null; audio_type: string | null }) => {
  if (!row.audio_file || !row.audio_type) throw new DiaryError("Brak nagrania. Wpisz tekst wpisu.");
  if (config.fakeAgent) return fakeTranscript();
  return transcribeAudio(new Uint8Array(await readFile(row.audio_file)), row.audio_type);
};

const sortEntry = async (id: string) => {
  const [row] = await sql<{ id: string; project_id: string; transcript: string; audio_file: string | null; audio_type: string | null }[]>`
    update diary_entries set status = 'processing', error = null where id = ${id}
    returning id, project_id, transcript, audio_file, audio_type`;
  if (!row) return;
  try {
    if (!config.fakeAgent && !config.openrouterApiKey) throw new DiaryError("Serwer nie ma klucza OpenRouter, więc nie przetworzy nagrania.");
    let transcript = row.transcript.trim();
    if (!transcript) {
      transcript = await transcribe(row);
      if (!transcript) throw new DiaryError("Nie słychać mowy w nagraniu. Nagraj jeszcze raz albo wpisz tekst.");
      await sql`update diary_entries set transcript = ${transcript} where id = ${id}`;
    }
    const pages = await candidatePages(row.project_id, transcript);
    const entry = config.fakeAgent ? fakeOrganize(transcript, pages) : await organizeTranscript(transcript, pages);
    await sql`
      update diary_entries set entry = ${sql.json(entry)}, status = 'ready', edited = false, updated_at = now() where id = ${id}`;
  } catch (error) {
    if (!(error instanceof DiaryError)) console.error(`diary: entry ${id} failed`, error);
    await sql`update diary_entries set status = 'error', error = ${failureMessage(error)}, updated_at = now() where id = ${id}`;
  }
};

const inFlight = new Map<string, Promise<void>>();

export const processDiaryEntry = (id: string) => {
  const running = inFlight.get(id);
  if (running) return running;
  const run = sortEntry(id).finally(() => inFlight.delete(id));
  inFlight.set(id, run);
  return run;
};

// Tests wait for the background work this way.
export const diaryIdle = () => Promise.all(inFlight.values()).then(() => undefined);

// Notes cut off by a restart are picked up again, one after another, from the saved audio or text.
export const resumeDiaryEntries = async () => {
  const rows = await sql<{ id: string }[]>`select id from diary_entries where status in ('queued', 'processing') order by created_at`;
  for (const { id } of rows) await processDiaryEntry(id);
};

// Reads the request body up to `maxBytes`; null when it is longer.
export const readLimited = async (body: ReadableStream<Uint8Array>, maxBytes: number) => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const requireEntryAccess: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const id = c.req.param("id") ?? "";
  const [row] = isUuid(id) ? await sql<{ projectId: string }[]>`select project_id as "projectId" from diary_entries where id = ${id}` : [];
  const tenantId = row ? await canAccessProject(c.get("principal"), row.projectId) : null;
  if (!tenantId) return c.json({ error: "Nie ma takiego wpisu" }, 404);
  await withTenant(tenantId, next);
};

const publicEntry = ({ projectId: _projectId, ...row }: EntryRow) => row;

export const diary = new Hono<AuthEnv>();

diary.get("/api/projects/:id/diary", requireRole("app", "admin"), requireProjectAccess(), async (c) => {
  const rows = await sql<EntryRow[]>`
    select ${entryColumns} from diary_entries where project_id = ${c.req.param("id")} order by entry_date desc, created_at desc`;
  return c.json(rows.map(publicEntry));
});

// A voice note (audio/* body, date and clientId in the query) or a typed one (JSON { text, date, clientId }).
diary.post("/api/projects/:id/diary", requireRole("app", "admin"), requireProjectAccess(), rateLimit(limiters.diary), async (c) => {
  const projectId = c.req.param("id");
  const contentType = c.req.header("content-type");
  const isJson = contentType?.startsWith("application/json") ?? false;
  const fields = isJson
    ? await c.req.json<{ text?: unknown; date?: unknown; clientId?: unknown }>().catch(() => ({}) as Record<string, unknown>)
    : { date: c.req.query("date"), clientId: c.req.query("clientId") };
  const date = fields.date ?? new Date().toISOString().slice(0, 10);
  if (!isDate(date)) return c.json({ error: "Nieprawidłowa data wpisu" }, 400);
  const clientId = typeof fields.clientId === "string" && fields.clientId ? fields.clientId.slice(0, MAX_CLIENT_ID_CHARS) : null;

  // The offline queue resends a note whose answer it never got; the first copy stands.
  if (clientId) {
    const [existing] = await sql<EntryRow[]>`
      select ${entryColumns} from diary_entries where project_id = ${projectId} and client_id = ${clientId}`;
    if (existing) return c.json(publicEntry(existing), 200);
  }

  const { user } = c.get("principal");
  const author = user ? user.name || user.email : "";
  if (isJson) {
    const text = "text" in fields && typeof fields.text === "string" ? fields.text.trim() : "";
    if (!text) return c.json({ error: "Wpis jest pusty" }, 400);
    if (text.length > MAX_TEXT_CHARS) return c.json({ error: "Wpis jest za długi" }, 413);
    const [row] = await sql<{ id: string }[]>`
      insert into diary_entries (project_id, client_id, entry_date, source, transcript, author_id, author_name)
      values (${projectId}, ${clientId}, ${date}, 'text', ${text}, ${user?.id ?? null}, ${author}) returning id`;
    // Read the row before processing starts, so the response shows the entry as queued.
    const created = publicEntry((await entryById(row!.id))!);
    detached(() => processDiaryEntry(row!.id));
    return c.json(created, 201);
  }

  const type = audioType(contentType);
  if (!type) return c.json({ error: "Nieobsługiwany format nagrania. Nagraj w aplikacji albo wpisz tekst." }, 415);
  const tooLarge = () => c.json({ error: `Nagranie jest za długie (limit ${Math.round(config.diaryMaxAudioBytes / 1024 / 1024)} MB)` }, 413);
  if (Number(c.req.header("content-length") ?? 0) > config.diaryMaxAudioBytes) return tooLarge();
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "Brak nagrania" }, 400);
  const audio = await readLimited(body, config.diaryMaxAudioBytes);
  if (!audio) return tooLarge();
  if (audio.length === 0) return c.json({ error: "Brak nagrania" }, 400);

  const [row] = await sql<{ id: string }[]>`
    insert into diary_entries (project_id, client_id, entry_date, source, audio_type, author_id, author_name)
    values (${projectId}, ${clientId}, ${date}, 'audio', ${type.mediaType}, ${user?.id ?? null}, ${author}) returning id`;
  const file = diaryAudio(row!.id, type.extension);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, audio);
  await sql`update diary_entries set audio_file = ${file} where id = ${row!.id}`;
  // Read the row before processing starts, so the response shows the entry as queued.
  const created = publicEntry((await entryById(row!.id))!);
  detached(() => processDiaryEntry(row!.id));
  return c.json(created, 201);
});

// Corrections by hand: the date, the transcript or the sorted entry. A corrected entry is not overwritten by the model
// unless the user asks to sort it again.
diary.patch("/api/diary/:id", requireRole("app", "admin"), requireEntryAccess, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ entryDate?: unknown; transcript?: unknown; entry?: unknown }>().catch(() => null);
  if (!body) return c.json({ error: "Nieprawidłowe dane" }, 400);
  if (body.entryDate !== undefined && !isDate(body.entryDate)) return c.json({ error: "Nieprawidłowa data wpisu" }, 400);
  if (body.transcript !== undefined && (typeof body.transcript !== "string" || body.transcript.length > MAX_TEXT_CHARS)) {
    return c.json({ error: "Nieprawidłowy tekst nagrania" }, 400);
  }
  const parsed = body.entry === undefined ? null : diaryEntrySchema.safeParse(body.entry);
  if (parsed && !parsed.success) return c.json({ error: "Nieprawidłowy wpis" }, 400);
  const current = await entryById(id);
  if (current?.status === "processing") return c.json({ error: "Wpis jest właśnie porządkowany, spróbuj za chwilę" }, 409);
  await sql`
    update diary_entries set
      entry_date = coalesce(${body.entryDate === undefined ? null : (body.entryDate as string)}::date, entry_date),
      transcript = coalesce(${typeof body.transcript === "string" ? body.transcript : null}, transcript),
      entry = coalesce(${parsed ? sql.json(parsed.data) : null}, entry),
      edited = edited or ${Boolean(parsed)},
      status = case when ${Boolean(parsed)} then 'ready' else status end,
      error = case when ${Boolean(parsed)} then null else error end,
      updated_at = now()
    where id = ${id}`;
  return c.json(publicEntry((await entryById(id))!));
});

// Sort again: after a failed model call, or after the transcript was corrected by hand.
diary.post("/api/diary/:id/retry", requireRole("app", "admin"), requireEntryAccess, rateLimit(limiters.diary), async (c) => {
  const id = c.req.param("id");
  const [row] = await sql<{ id: string }[]>`
    update diary_entries set status = 'queued', error = null where id = ${id} and status <> 'processing' returning id`;
  if (!row) return c.json({ error: "Wpis jest właśnie porządkowany" }, 409);
  detached(() => processDiaryEntry(id));
  return c.json(publicEntry((await entryById(id))!), 202);
});

diary.delete("/api/diary/:id", requireRole("app", "admin"), requireEntryAccess, async (c) => {
  const [row] = await sql<{ audioFile: string | null }[]>`
    delete from diary_entries where id = ${c.req.param("id")} returning audio_file as "audioFile"`;
  if (row?.audioFile) await rm(row.audioFile, { force: true });
  return c.body(null, 204);
});
