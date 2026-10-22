// Stand-in for the real server, for building and testing the mobile app without a database or an OpenRouter key.
// The CopilotKit runtime and the tool-calling loop are real; only the language model and the tool data are scripted.
//   pnpm --filter @brygadzista/server mock    → http://localhost:3100, access code "demo"
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { BuiltInAgent, CopilotRuntime, createCopilotEndpoint, defineTool } from "@copilotkit/runtime/v2";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { z } from "zod";
import { A2UI_CATALOG_ID } from "../src/a2ui-catalog.js";
import { a2uiCatalogSchema } from "../src/a2ui-schema.js";
import { audioType, fakeOrganize, fakeTranscript, type DiaryEntry } from "../src/diary-entry.js";
import { STAGE_TEMPLATES, stageTemplate } from "../src/checklist-templates.js";

const PORT = Number(process.env.PORT ?? 3100);
const TOKEN = process.env.APP_TOKEN ?? "demo";
const CHUNK_DELAY_MS = Number(process.env.MOCK_DELAY_MS ?? 60);
const PROJECT = { id: "demo", name: "Hala sportowa – termomodernizacja (dane testowe)", createdAt: "2026-10-19T12:00:00Z", documentCount: 1 };
const DOCUMENT_ID = "doc-demo";
const PAGE_IMAGE = new URL("./mock/page.jpg", import.meta.url);

const PAGES = [
  { pageNo: 3, title: "Opis techniczny – przegrody zewnętrzne", kind: "opis" },
  { pageNo: 12, title: "Rzut parteru", kind: "rysunek" },
  { pageNo: 18, title: "Detal D-3 – cokół i ocieplenie", kind: "detal" },
];

// The pages list the app shows: all 42 pages of the sample PDF, titled where the scripted answers need it.
const ALL_PAGES = Array.from({ length: 42 }, (_, index) => {
  const known = PAGES.find((page) => page.pageNo === index + 1);
  return known ?? { pageNo: index + 1, title: index < 10 ? `Opis techniczny – część ${index + 1}` : `Rysunek ${index + 1}`, kind: index < 10 ? "opis" : "rysunek" };
});

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

const toolCallStep = (toolName: string, input: object): LanguageModelV3StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: `call-${toolName}-${Date.now()}`, toolName, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];

const textParts = (text: string, textId = `text-${Date.now()}`): LanguageModelV3StreamPart[] => [
  { type: "text-start", id: textId },
  ...(text.match(/\S+\s*/g) ?? []).map((delta) => ({ type: "text-delta" as const, id: textId, delta })),
  { type: "text-end", id: textId },
];

const textStep = (text: string): LanguageModelV3StreamPart[] => [
  { type: "stream-start", warnings: [] },
  ...textParts(text),
  { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
];

// A short summary, then the surface. The arguments stream in pieces, as from a model, so the A2UI middleware
// sees the components first and the data model last, the way it does in production.
const surfaceStep = (text: string, surface: object): LanguageModelV3StreamPart[] => {
  const toolCallId = `call-render_a2ui-${Date.now()}`;
  const json = JSON.stringify(surface);
  const chunks = json.match(/[\s\S]{1,60}/g) ?? [];
  return [
    { type: "stream-start", warnings: [] },
    ...textParts(text),
    { type: "tool-input-start", id: toolCallId, toolName: "render_a2ui" },
    ...chunks.map((delta) => ({ type: "tool-input-delta" as const, id: toolCallId, delta })),
    { type: "tool-input-end", id: toolCallId },
    { type: "tool-call", toolCallId, toolName: "render_a2ui", input: json },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
  ];
};

const ANSWER = `Ściany zewnętrzne hali: **bloczek 24 cm** + **styropian EPS 15 cm** (λ = 0,031 W/mK), klejony i kołkowany.

- Wymiary hali w osiach: 16 000 × 10 000 mm.
- Na cokole do wysokości 50 cm zamiast EPS jest XPS 15 cm, szczegół na detalu D-3.

Rzut pokazałem wyżej, powiększ go palcami.

Źródło: str. 12 – Rzut parteru, str. 18 – Detal D-3`;

// Every component of the construction catalog (src/a2ui-catalog.ts) with test values; the materials come through the data model.
const SURFACE = (() => {
  const description = { page: 3, documentId: DOCUMENT_ID };
  const detail = { page: 18, documentId: DOCUMENT_ID };
  return {
    components: [
      { id: "root", component: "Card", child: "col" },
      { id: "col", component: "Column", children: ["title", "params", "materials", "steps", "layers"] },
      { id: "title", component: "Text", text: "Ocieplenie ścian zewnętrznych", variant: "h3" },
      { id: "params", component: "Row", children: ["thickness", "lambda"] },
      { id: "thickness", component: "ParameterCard", label: "Grubość ocieplenia", value: "15", unit: "cm", note: "EPS, na cokole XPS", source: description, weight: 1 },
      { id: "lambda", component: "ParameterCard", label: "Lambda", value: "0,031", unit: "W/(m·K)", source: description, weight: 1 },
      { id: "materials", component: "MaterialList", title: "Materiały na 100 m² ściany", items: { path: "/materials" } },
      {
        id: "steps",
        component: "WorkSteps",
        title: "Kolejność prac",
        steps: [
          { title: "Przygotuj podłoże", detail: "Oczyść i zagruntuj ścianę.", source: description },
          { title: "Przyklej płyty", detail: "Metodą obwodowo-punktową, z przesunięciem spoin." },
          { title: "Zakołkuj i zatop siatkę", detail: "4–6 łączników na m², siatka na zakład 10 cm." },
          { title: "Wykonaj cokół z XPS", detail: "Do wysokości 50 cm, jak na detalu D-3.", source: detail },
        ],
      },
      {
        id: "layers",
        component: "LayerComparison",
        title: "Ściana zewnętrzna i cokół",
        highlight: 0,
        partitions: [
          {
            name: "Ściana zewnętrzna SZ1",
            total: "40,5 cm",
            uValue: "0,18 W/(m²·K)",
            source: description,
            layers: [
              { material: "Tynk silikonowy", thickness: "1,5 mm" },
              { material: "Styropian EPS 031", thickness: "15 cm" },
              { material: "Bloczek betonowy", thickness: "24 cm" },
              { material: "Tynk gipsowy", thickness: "1,5 cm" },
            ],
          },
          {
            name: "Cokół",
            total: "39 cm",
            source: detail,
            layers: [
              { material: "Tynk mozaikowy", thickness: "2 mm" },
              { material: "Polistyren XPS", thickness: "15 cm", note: "do 50 cm nad terenem" },
              { material: "Bloczek betonowy", thickness: "24 cm" },
            ],
          },
        ],
      },
    ],
    data: {
      materials: [
        { name: "Styropian EPS 031, 15 cm", quantity: 105, unit: "m²", note: "z zapasem 5%", source: description },
        { name: "Polistyren XPS, 15 cm", quantity: 8, unit: "m²", source: detail },
        { name: "Klej do styropianu", quantity: 500, unit: "kg" },
        { name: "Siatka z włókna szklanego", quantity: 115, unit: "m²" },
        { name: "Łączniki mechaniczne", quantity: 600, unit: "szt." },
      ],
    },
  };
})();

const SURFACE_SUMMARY = "Zestawienie dla ocieplenia ścian poniżej: parametry, materiały, kolejność prac i warstwy.\n\nŹródło: str. 3 – Opis techniczny, str. 18 – Detal D-3";

// Pins with photos (#70) live in memory: enough to try placing, syncing and finding photos without a database.
type MockPhoto = { id: string; width: number; height: number; takenAt: string; stage: string };
type MockPinFields = { pageNo: number; createdAt: string; updatedAt: string; [field: string]: unknown };
type MockPin = MockPinFields & { id: string; photos: MockPhoto[] };
const pins = new Map<string, MockPin>();
const photoFiles = new Map<string, Buffer>();
const photoPath = (photoId: string) => `/api/projects/${PROJECT.id}/photos/${photoId}/image?size=thumb`;

const PHOTOS_ANSWER = (count: number) =>
  count
    ? `Znalazłem ${count === 1 ? "jedno miejsce" : `${count} miejsca`} ze zdjęciami, miniatury są wyżej. Dotknij, aby zobaczyć je na rysunku.`
    : "Nie ma jeszcze zdjęć z budowy. Otwórz stronę w zakładce „Projekt” i dotknij „Przypnij zdjęcie”.";

// Questions about lists, quantities or layers get an A2UI surface instead of the drawing.
const wantsSurface = (question: string) => /zestaw|materia|warstw|kolejno|a2ui/i.test(question);

const failedOnce = new Set<string>();

// One scripted turn: search, show the drawing, then answer. The step is the number of tool results since the last question.
const scriptedStep = (options: LanguageModelV3CallOptions): LanguageModelV3StreamPart[] => {
  const prompt = options.prompt;
  const lastUser = prompt.findLastIndex((message) => message.role === "user");
  const content = prompt[lastUser]?.content ?? [];
  const question = typeof content === "string" ? content : content.map((part) => ("text" in part ? part.text : "")).join(" ");
  // The first attempt at a question with "awaria" fails, the retry succeeds: enough to exercise the app's error path.
  if (/awaria/i.test(question) && !failedOnce.has(question)) {
    failedOnce.add(question);
    throw new Error("Symulowana awaria modelu");
  }
  const step = prompt.slice(lastUser).filter((message) => message.role === "tool").length;
  if (/zdj[eę]|foto/i.test(question)) return step === 0 ? toolCallStep("search_photos", { query: "" }) : textStep(PHOTOS_ANSWER(pins.size));
  if (step === 0) return toolCallStep("search_project", { query: question });
  if (step === 1 && wantsSurface(question)) return surfaceStep(SURFACE_SUMMARY, { ...SURFACE, surfaceId: `budowa-${Date.now()}` });
  if (step === 1) return toolCallStep("show_page", { documentId: DOCUMENT_ID, pageNo: 12, caption: "Ściany zewnętrzne i wymiary hali" });
  return textStep(ANSWER);
};

const model = new MockLanguageModelV3({
  provider: "mock",
  modelId: "scripted",
  doStream: async (options) => ({
    stream: simulateReadableStream({ chunks: scriptedStep(options), initialDelayInMs: 400, chunkDelayInMs: CHUNK_DELAY_MS }),
  }),
});

const pageRef = z.object({ documentId: z.string(), pageNo: z.number().int().min(1) });
const imagePath = (pageNo: number) => `/api/documents/${DOCUMENT_ID}/pages/${pageNo}/image`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createMockAgent = () =>
  new BuiltInAgent({
    model,
    maxSteps: 12,
    tools: [
      defineTool({
        name: "search_project",
        description: "Wyszukuje w projekcie.",
        parameters: z.object({ query: z.string() }),
        execute: async () => {
          await pause(900);
          return { results: PAGES.map((page) => ({ documentId: DOCUMENT_ID, filename: "projekt.pdf", ...page, snippet: page.title })) };
        },
      }),
      defineTool({
        name: "search_photos",
        description: "Szuka zdjęć z budowy.",
        parameters: z.object({ query: z.string().optional() }),
        execute: async () => {
          await pause(400);
          const found = [...pins.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          return {
            photos: found.map((pin) => ({
              ...pin,
              pageTitle: ALL_PAGES.find((page) => page.pageNo === pin.pageNo)?.title ?? null,
              photos: pin.photos.map((photo) => ({ ...photo, thumbPath: photoPath(photo.id) })),
            })),
          };
        },
      }),
      defineTool({
        name: "show_page",
        description: "Wyświetla stronę.",
        parameters: pageRef.extend({ caption: z.string().optional() }),
        execute: async ({ documentId, pageNo, caption }) => {
          await pause(400);
          const page = PAGES.find((candidate) => candidate.pageNo === pageNo);
          return { documentId, pageNo, title: page?.title ?? null, caption, imagePath: imagePath(pageNo) };
        },
      }),
    ],
  });

const runtime = new CopilotRuntime({
  agents: async () => ({ default: createMockAgent() }),
  a2ui: { injectA2UITool: true, schema: a2uiCatalogSchema, defaultCatalogId: A2UI_CATALOG_ID },
});

const requireToken: MiddlewareHandler = async (c, next) => {
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.query("token");
  if (token !== TOKEN) return c.json({ error: "Brak dostępu" }, 401);
  await next();
};

// Accounts (#91): any e-mail with the password "demo" logs in; the session token is the same demo token. The account
// belongs to two firms so the app's firm switch can be tried; the projects do not change with the firm.
const MOCK_TENANTS = [
  { id: "00000000-0000-4000-8000-000000000001", name: "Budmax (dane testowe)", role: "manager" },
  { id: "00000000-0000-4000-8000-000000000002", name: "Druga firma (dane testowe)", role: "worker" },
];
let mockTenant = MOCK_TENANTS[0]!;
const mockAccount = (email = "demo@example.com") => ({
  user: { id: "00000000-0000-4000-8000-0000000000aa", email, name: email.split("@")[0], role: "user" },
  tenant: mockTenant,
  tenants: MOCK_TENANTS,
});

const app = new Hono();
app.use("/api/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-project-id"] }));
app.post("/api/auth/login", async (c) => {
  const { email, password } = await c.req.json<{ email?: string; password?: string }>();
  if (!email || password !== TOKEN) return c.json({ error: "Nieprawidłowy e-mail lub hasło" }, 401);
  return c.json({ token: TOKEN, ...mockAccount(email) });
});
app.use("/api/*", requireToken);
app.get("/api/auth/me", (c) => c.json(mockAccount()));
app.post("/api/auth/tenant", async (c) => {
  const { tenantId } = await c.req.json<{ tenantId?: string }>();
  const tenant = MOCK_TENANTS.find((candidate) => candidate.id === tenantId);
  if (!tenant) return c.json({ error: "Nie ma takiej firmy" }, 404);
  mockTenant = tenant;
  return c.json(mockAccount());
});
app.post("/api/auth/logout", (c) => c.body(null, 204));
app.route("/", createCopilotEndpoint({ runtime, basePath: "/api/copilotkit" }));
app.get("/api/projects", (c) => c.json([PROJECT]));
app.get("/api/projects/:id/documents", (c) =>
  c.json([{ id: DOCUMENT_ID, filename: "projekt.pdf", pageCount: 42, indexedPages: 42, status: "ready", error: null }]),
);
// Offline search (#51): a few pages carry text the search can find, e.g. "D-3", "ocieplenie", "cokołu".
const PAGE_TEXT: Record<number, { summary: string; keywords: string[]; text: string }> = {
  3: {
    summary: "Opis przegród zewnętrznych: ściany, ocieplenie styropianem grafitowym 15 cm, tynk cienkowarstwowy.",
    keywords: ["ocieplenie", "styropian", "przegrody"],
    text: "Ściany zewnętrzne ocieplić płytami styropianu grafitowego gr. 15 cm, λ = 0,031 W/mK. Tynk silikonowy 1,5 mm.",
  },
  12: {
    summary: "Rzut parteru hali z oznaczeniem stref, wejść i pomieszczeń zaplecza.",
    keywords: ["rzut", "parter", "A-02"],
    text: "Rys. A-02 Rzut parteru. Sala gimnastyczna 24 x 44 m, szatnie, magazyn sprzętu, wejście główne od strony północnej.",
  },
  18: {
    summary: "Detal cokołu: ocieplenie XPS 12 cm do 50 cm nad terenem, opierzenie i izolacja przeciwwodna.",
    keywords: ["cokół", "XPS", "D-3"],
    text: "Detal D-3. Cokół ocieplić płytami XPS gr. 12 cm na wysokość 50 cm ponad poziom terenu. Hydroizolacja masą bitumiczną.",
  },
};
app.get("/api/projects/:id/search-index", (c) =>
  c.json({
    generatedAt: new Date().toISOString(),
    pages: ALL_PAGES.map((page) => ({
      documentId: DOCUMENT_ID,
      filename: "projekt.pdf",
      ...page,
      ...(PAGE_TEXT[page.pageNo] ?? { summary: null, keywords: [], text: page.title }),
    })),
  }),
);
app.get("/api/documents/:id/pages", (c) => c.json(ALL_PAGES.map((page) => ({ ...page, summary: null, facts: null, indexed: true }))));
app.get("/api/documents/:id/pages/:pageNo/image", async (c) => {
  c.header("Content-Type", "image/jpeg");
  return c.body(await readFile(PAGE_IMAGE));
});

app.get("/api/projects/:id/pins", (c) => c.json({ pins: [...pins.values()] }));
app.put("/api/projects/:id/pins/:pinId", async (c) => {
  const body = await c.req.json<MockPinFields>();
  const existing = pins.get(c.req.param("pinId"));
  if (existing && existing.updatedAt > body.updatedAt) return c.json(existing);
  const pin: MockPin = { kind: "photo", authorName: "Demo", ...body, id: c.req.param("pinId"), photos: existing?.photos ?? [] };
  // Defects (#74) get a fixed "what the project says", the way the server adds it after looking the note up.
  if (pin.kind === "defect" && pin.note) pin.spec = MOCK_SPEC;
  pins.set(pin.id, pin);
  return c.json(pin);
});
app.delete("/api/projects/:id/pins/:pinId", (c) => {
  pins.delete(c.req.param("pinId"));
  return c.body(null, 204);
});
// Stored as sent, without the server's resizing; the thumbnail is the same file.
app.put("/api/projects/:id/pins/:pinId/photos/:photoId", async (c) => {
  const pin = pins.get(c.req.param("pinId"));
  if (!pin) return c.json({ error: "Nie ma takiej pinezki" }, 404);
  const photo = {
    id: c.req.param("photoId"),
    width: 0,
    height: 0,
    takenAt: c.req.query("takenAt") ?? new Date().toISOString(),
    stage: c.req.query("stage") ?? "before",
  };
  if (!photoFiles.has(photo.id)) pin.photos.push(photo);
  photoFiles.set(photo.id, Buffer.from(await c.req.arrayBuffer()));
  return c.json(photo, 201);
});
app.delete("/api/projects/:id/photos/:photoId", (c) => {
  pins.forEach((pin) => (pin.photos = pin.photos.filter((photo) => photo.id !== c.req.param("photoId"))));
  photoFiles.delete(c.req.param("photoId"));
  return c.body(null, 204);
});
app.get("/api/projects/:id/photos/:photoId/image", (c) => {
  const file = photoFiles.get(c.req.param("photoId"));
  if (!file) return c.json({ error: "Nie ma takiego zdjęcia" }, 404);
  c.header("Content-Type", "image/jpeg");
  return c.body(new Uint8Array(file));
});
const MOCK_SPEC = {
  found: true,
  statement: "Wg rys. A-02 wejście główne od strony północnej",
  quote: "wejście główne od strony północnej",
  source: { documentId: DOCUMENT_ID, pageNo: 12, title: "Rzut parteru" },
};
app.post("/api/projects/:id/transcribe", async (c) => {
  await pause(800);
  return c.json({ text: "Parapet okna w salonie osadzony za nisko, około 80 cm od podłogi." });
});
// The protocol (#74) as a plain list: the real layout with drawings and photos needs the server.
app.get("/api/projects/:id/defects/protocol.pdf", async (c) => {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
  if (existsSync(font)) doc.font(font);
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  doc.fontSize(18).text("Protokół odbioru – lista usterek (demo)").moveDown();
  const statuses = (c.req.query("status") ?? "").split(",").filter(Boolean);
  const defects = [...pins.values()].filter((pin) => pin.kind === "defect" && (!statuses.length || statuses.includes(String(pin.status))));
  defects.forEach((pin, index) => doc.fontSize(11).text(`${index + 1}. ${pin.room || "Bez pomieszczenia"} · ${pin.status} · ${pin.assignee || "-"}\n${pin.note}`).moveDown(0.5));
  doc.end();
  c.header("Content-Type", "application/pdf");
  return c.body(new Uint8Array(await done));
});
// Daily log (#69): kept in memory, sorted by the same keyword stand-in as FAKE_AGENT=1 after a short delay.
// A typed note with "awaria" fails once, to exercise the error and retry path.
type MockDiaryEntry = {
  id: string;
  clientId: string | null;
  entryDate: string;
  source: "audio" | "text";
  transcript: string;
  entry: DiaryEntry | null;
  status: "queued" | "processing" | "ready" | "error";
  error: string | null;
  edited: boolean;
  authorName: string;
  createdAt: string;
  updatedAt: string;
};
const diaryEntries: MockDiaryEntry[] = [];
const diaryPages = PAGES.slice(1).map((page) => ({ documentId: DOCUMENT_ID, pageNo: page.pageNo, title: page.title }));
const sortDiaryEntry = (entry: MockDiaryEntry) => {
  entry.status = "processing";
  setTimeout(() => {
    if (!entry.transcript) entry.transcript = fakeTranscript();
    if (/awaria/i.test(entry.transcript) && !failedOnce.has(entry.id)) {
      failedOnce.add(entry.id);
      Object.assign(entry, { status: "error", error: "Symulowana awaria modelu. Spróbuj ponownie." });
      return;
    }
    Object.assign(entry, { entry: fakeOrganize(entry.transcript, diaryPages), status: "ready", error: null, edited: false, updatedAt: new Date().toISOString() });
  }, 2500);
};
const findDiaryEntry = (id: string) => diaryEntries.find((entry) => entry.id === id);
app.get("/api/projects/:id/diary", (c) =>
  c.json([...diaryEntries].sort((a, b) => b.entryDate.localeCompare(a.entryDate) || b.createdAt.localeCompare(a.createdAt))),
);
app.post("/api/projects/:id/diary", async (c) => {
  const isJson = c.req.header("content-type")?.startsWith("application/json") ?? false;
  const fields = isJson ? await c.req.json<{ text?: string; date?: string; clientId?: string }>() : { date: c.req.query("date"), clientId: c.req.query("clientId") };
  const existing = fields.clientId ? diaryEntries.find((entry) => entry.clientId === fields.clientId) : undefined;
  if (existing) return c.json(existing, 200);
  if (!isJson && !audioType(c.req.header("content-type"))) return c.json({ error: "Nieobsługiwany format nagrania. Nagraj w aplikacji albo wpisz tekst." }, 415);
  if (isJson && !fields.text?.trim()) return c.json({ error: "Wpis jest pusty" }, 400);
  if (!isJson) await c.req.arrayBuffer();
  const now = new Date().toISOString();
  const entry: MockDiaryEntry = {
    id: `diary-${Date.now()}`,
    clientId: fields.clientId ?? null,
    entryDate: fields.date ?? now.slice(0, 10),
    source: isJson ? "text" : "audio",
    transcript: isJson ? fields.text!.trim() : "",
    entry: null,
    status: "queued",
    error: null,
    edited: false,
    authorName: "demo",
    createdAt: now,
    updatedAt: now,
  };
  diaryEntries.push(entry);
  sortDiaryEntry(entry);
  return c.json(entry, 201);
});
app.patch("/api/diary/:id", async (c) => {
  const entry = findDiaryEntry(c.req.param("id"));
  if (!entry) return c.json({ error: "Nie ma takiego wpisu" }, 404);
  const body = await c.req.json<{ entryDate?: string; transcript?: string; entry?: DiaryEntry }>();
  if (body.entryDate) entry.entryDate = body.entryDate;
  if (body.transcript !== undefined) entry.transcript = body.transcript;
  if (body.entry) Object.assign(entry, { entry: body.entry, edited: true, status: "ready", error: null });
  entry.updatedAt = new Date().toISOString();
  return c.json(entry);
});
app.post("/api/diary/:id/retry", (c) => {
  const entry = findDiaryEntry(c.req.param("id"));
  if (!entry) return c.json({ error: "Nie ma takiego wpisu" }, 404);
  sortDiaryEntry(entry);
  return c.json(entry, 202);
});
app.delete("/api/diary/:id", (c) => {
  const index = diaryEntries.findIndex((entry) => entry.id === c.req.param("id"));
  if (index >= 0) diaryEntries.splice(index, 1);
  return c.body(null, 204);
});
// Stage checklists (#68), kept in memory: the first item of each stage is found on page 3, the rest are "do potwierdzenia".
type MockItem = { id: string; position: number; label: string; ask: string; value: string | null; status: string; checked: boolean;
  note: string | null; checkedAt: string | null; checkedBy: string | null; source: object | null };
type MockChecklist = { id: string; projectId: string; stage: string; title: string; when: string; status: string; error: null;
  createdBy: string; createdAt: string; generatedAt: string; items: MockItem[]; results: object[] };
const checklists = new Map<string, MockChecklist>();
const seenEvents = new Set<string>();
const source = (pageNo: number, quote: string) => ({ documentId: DOCUMENT_ID, pageNo, quote, imagePath: imagePath(pageNo) });
app.get("/api/checklist-templates", (c) =>
  c.json(STAGE_TEMPLATES.map(({ stage, title, when, items }) => ({ stage, title, when, items: items.map((item) => item.label) }))),
);
app.get("/api/projects/:id/checklists", (c) =>
  c.json([...checklists.values()].reverse().map(({ items, results, ...checklist }) => ({
    ...checklist,
    itemCount: items.length,
    checkedCount: items.filter((item) => item.checked).length,
    toConfirmCount: items.filter((item) => item.status === "to_confirm").length,
    lastCompletedAt: (results[0] as { completedAt?: string } | undefined)?.completedAt ?? null,
  }))),
);
app.post("/api/projects/:id/checklists", async (c) => {
  const { stage } = await c.req.json<{ stage?: string }>();
  const template = stage ? stageTemplate(stage) : undefined;
  if (!template) return c.json({ error: "Nieznany etap budowy" }, 400);
  const now = new Date().toISOString();
  const checklist: MockChecklist = {
    id: crypto.randomUUID(), projectId: PROJECT.id, stage: template.stage, title: template.title, when: template.when,
    status: "ready", error: null, createdBy: "Demo", createdAt: now, generatedAt: now, results: [],
    items: template.items.map((item, position) => ({
      id: crypto.randomUUID(), position, label: item.label, ask: item.ask, checked: false, note: null, checkedAt: null, checkedBy: null,
      ...(position === 0
        ? { value: "zgodnie z opisem, str. 3", status: "found", source: source(3, PAGE_TEXT[3]!.text) }
        : { value: null, status: "to_confirm", source: position % 2 ? source(18, PAGE_TEXT[18]!.text) : null }),
    })),
  };
  checklists.set(checklist.id, checklist);
  return c.json(checklist, 202);
});
app.get("/api/checklists/:id", (c) => {
  const checklist = checklists.get(c.req.param("id"));
  return checklist ? c.json(checklist) : c.json({ error: "Nie ma takiej checklisty" }, 404);
});
app.post("/api/checklists/:id/sync", async (c) => {
  const checklist = checklists.get(c.req.param("id"));
  if (!checklist) return c.json({ error: "Nie ma takiej checklisty" }, 404);
  const { events } = await c.req.json<{ events: { id: string; type: string; itemId?: string; checked?: boolean; note?: string | null; at: string }[] }>();
  for (const event of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (seenEvents.has(event.id)) continue;
    seenEvents.add(event.id);
    const item = checklist.items.find((candidate) => candidate.id === event.itemId);
    if (event.type === "check" && item && (!item.checkedAt || item.checkedAt <= event.at)) {
      Object.assign(item, { checked: Boolean(event.checked), note: event.note ?? null, checkedAt: event.at, checkedBy: "Demo" });
    }
    if (event.type === "complete") {
      checklist.results.unshift({ id: event.id, completedAt: event.at, completedBy: "Demo", items: checklist.items.map(({ label, value, status, checked, note }) => ({ label, value, status, checked, note })) });
    }
  }
  return c.json(checklist);
});

// The browser version of the app, when exported (pnpm --filter @brygadzista/mobile export:web): http://localhost:3100/app/
const mobileWebRoot = path.relative(process.cwd(), fileURLToPath(new URL("../../mobile/dist-web", import.meta.url)));
app.get("/app", (c) => c.redirect("/app/"));
app.use("/app/*", serveStatic({ root: mobileWebRoot, rewriteRequestPath: (requestPath) => requestPath.replace(/^\/app/, "") || "/" }));
app.get("/app/*", serveStatic({ root: mobileWebRoot, path: "index.html" }));

serve({ fetch: app.fetch, port: PORT }, () =>
  console.log(`Mock Brygadzisty: http://localhost:${PORT} (dowolny e-mail, hasło "${TOKEN}"). Słowo "awaria" w pytaniu symuluje błąd przy pierwszej próbie, "zestawienie" pokazuje powierzchnię A2UI, "zdjęcia" szuka przypiętych zdjęć.`),
);
