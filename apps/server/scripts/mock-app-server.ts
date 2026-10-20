// Stand-in for the real server, for building and testing the mobile app without a database or an OpenRouter key.
// The CopilotKit runtime and the tool-calling loop are real; only the language model and the tool data are scripted.
//   pnpm --filter @brygadzista/server mock    → http://localhost:3100, access code "demo"
import { serve } from "@hono/node-server";
import { BuiltInAgent, CopilotRuntime, createCopilotEndpoint, defineTool } from "@copilotkit/runtime/v2";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { A2UI_CATALOG_ID } from "../src/a2ui-catalog.js";
import { a2uiCatalogSchema } from "../src/a2ui-schema.js";

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

const app = new Hono();
app.use("/api/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-project-id"] }));
app.use("/api/*", requireToken);
app.route("/", createCopilotEndpoint({ runtime, basePath: "/api/copilotkit" }));
app.get("/api/projects", (c) => c.json([PROJECT]));
app.get("/api/projects/:id/documents", (c) =>
  c.json([{ id: DOCUMENT_ID, filename: "projekt.pdf", pageCount: 42, indexedPages: 42, status: "ready", error: null }]),
);
app.get("/api/documents/:id/pages", (c) => c.json(ALL_PAGES.map((page) => ({ ...page, summary: null, facts: null, indexed: true }))));
app.get("/api/documents/:id/pages/:pageNo/image", async (c) => {
  c.header("Content-Type", "image/jpeg");
  return c.body(await readFile(PAGE_IMAGE));
});

serve({ fetch: app.fetch, port: PORT }, () =>
  console.log(`Mock Brygadzisty: http://localhost:${PORT} (kod dostępu "${TOKEN}"). Słowo "awaria" w pytaniu symuluje błąd przy pierwszej próbie, "zestawienie" pokazuje powierzchnię A2UI.`),
);
