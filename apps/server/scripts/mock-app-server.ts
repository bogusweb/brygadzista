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

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

const toolCallStep = (toolName: string, input: object): LanguageModelV3StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: `call-${toolName}-${Date.now()}`, toolName, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
];

const textStep = (text: string, textId = `text-${Date.now()}`): LanguageModelV3StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: textId },
  ...(text.match(/\S+\s*/g) ?? []).map((delta) => ({ type: "text-delta" as const, id: textId, delta })),
  { type: "text-end", id: textId },
  { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
];

const ANSWER = `Ściany zewnętrzne hali: **bloczek 24 cm** + **styropian EPS 15 cm** (λ = 0,031 W/mK), klejony i kołkowany.

- Wymiary hali w osiach: 16 000 × 10 000 mm.
- Na cokole do wysokości 50 cm zamiast EPS jest XPS 15 cm, szczegół na detalu D-3.

Rzut pokazałem wyżej, powiększ go palcami.

Źródło: str. 12 – Rzut parteru, str. 18 – Detal D-3`;

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

const runtime = new CopilotRuntime({ agents: async () => ({ default: createMockAgent() }) });

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
app.get("/api/documents/:id/pages", (c) => c.json(PAGES.map((page) => ({ ...page, summary: null, facts: null, indexed: true }))));
app.get("/api/documents/:id/pages/:pageNo/image", async (c) => {
  c.header("Content-Type", "image/jpeg");
  return c.body(await readFile(PAGE_IMAGE));
});

serve({ fetch: app.fetch, port: PORT }, () =>
  console.log(`Mock Brygadzisty: http://localhost:${PORT} (kod dostępu "${TOKEN}"). Słowo "awaria" w pytaniu symuluje błąd przy pierwszej próbie.`),
);
