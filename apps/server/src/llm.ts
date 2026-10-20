import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output } from "ai";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { config } from "./config.js";
import { HttpError, parseRetryAfter, withRetry } from "./retry.js";

// Every request is pinned to one EU endpoint, with no fallback and only to providers
// that neither train on nor retain prompts (OpenRouter zero data retention).
export const euOnlyRouting = (endpoint: string) => ({
  order: [endpoint],
  only: [endpoint],
  allow_fallbacks: false,
  data_collection: "deny" as const,
  zdr: true,
});

const openrouter = () =>
  createOpenRouter({ apiKey: config.openrouterApiKey, compatibility: "strict", appName: "Brygadzista" });

export const agentLanguageModel = () =>
  openrouter().chat(config.agentModel, { provider: euOnlyRouting(config.agentProvider) });

const indexLanguageModel = () => openrouter().chat(config.indexModel, { provider: euOnlyRouting(config.indexProvider) });

// Each attempt gets its own timeout, so one hung request cannot hold an indexing worker forever.
const callModel = <T>(label: string, request: (abortSignal: AbortSignal) => Promise<T>) =>
  withRetry(() => request(AbortSignal.timeout(config.llmTimeoutMs)), {
    retries: config.llmMaxRetries,
    baseMs: config.llmRetryBaseMs,
    onRetry: (error, attempt, delayMs) =>
      console.warn(`llm: ${label} attempt ${attempt} failed, retrying in ${Math.round(delayMs)} ms: ${String(error)}`),
  });

const pageImagePart = async (imagePath: string) => ({
  type: "image" as const,
  image: await readFile(imagePath),
  mediaType: "image/jpeg",
});

const pageIndexSchema = z.object({
  title: z.string().describe("Tytuł strony lub rysunku, np. 'Rzut przyziemia – rys. nr 4'"),
  kind: z.enum(["opis", "rysunek", "detal", "zestawienie", "formalne", "inne"]),
  summary: z
    .string()
    .describe("Zwięzły, ale kompletny opis zawartości strony dla wykonawcy: co przedstawia, materiały, technologia, kolejność prac."),
  facts: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .describe("Wszystkie konkretne parametry odczytane ze strony: wymiary, grubości, rzędne, spadki, materiały, oznaczenia, ilości."),
  keywords: z.array(z.string()).describe("Słowa kluczowe, także w różnych formach odmiany."),
});

export type PageIndex = z.infer<typeof pageIndexSchema>;

export const indexPage = async (imagePath: string, rawText: string, pageNo: number): Promise<PageIndex> => {
  const image = await pageImagePart(imagePath);
  const { output } = await callModel(`index page ${pageNo}`, (abortSignal) => generateText({
    model: indexLanguageModel(),
    abortSignal,
    maxRetries: 0,
    output: Output.object({ schema: pageIndexSchema }),
    messages: [
      {
        role: "user",
        content: [
          image,
          {
            type: "text",
            text:
              `To strona ${pageNo} polskiego projektu technicznego budynku. ` +
              "Zindeksuj ją dla asystenta wykonawcy na budowie. Odczytaj z rysunku wszystkie wymiary, opisy warstw, " +
              "materiały i oznaczenia. Nie zgaduj wartości, których nie widać.\n\n" +
              `Tekst wyciągnięty z PDF (może być niepełny dla rysunków):\n${rawText.slice(0, 12000)}`,
          },
        ],
      },
    ],
  }));
  return output;
};

// Large sheets come as an overview plus zoomed tiles, so small dimensions stay legible.
export const askAboutPage = async (imagePaths: string[], question: string): Promise<string> => {
  const images = await Promise.all(imagePaths.map(pageImagePart));
  const layout =
    images.length > 1
      ? `Pierwszy obraz to cały arkusz, kolejne ${images.length - 1} to jego powiększone fragmenty (kafelki od lewej do prawej, ` +
        "od góry do dołu, z niewielkim zakładem). Drobne wymiary odczytuj z kafelków. "
      : "";
  const { text } = await callModel("inspect drawing", (abortSignal) => generateText({
    model: indexLanguageModel(),
    abortSignal,
    maxRetries: 0,
    messages: [
      {
        role: "user",
        content: [
          ...images,
          {
            type: "text",
            text:
              "To strona projektu technicznego. " + layout + "Odpowiedz po polsku na pytanie wykonawcy, opierając się wyłącznie na tym, " +
              `co widać na stronie. Jeśli czegoś nie da się odczytać, powiedz to wprost.\n\nPytanie: ${question}`,
          },
        ],
      },
    ],
  }));
  return text;
};

// Qwen3 Embedding is Matryoshka-trained, so a longer vector can be truncated and renormalised.
const fitDimensions = (vector: number[]) => {
  const head = vector.slice(0, config.embeddingDimensions);
  const norm = Math.hypot(...head) || 1;
  return head.map((value) => value / norm);
};

// One text per request, a few at a time: some endpoints (Vertex) reject array input, and this
// keeps a switch of EMBEDDING_PROVIDER safe.
const EMBED_CONCURRENCY = 4;

const embedOne = async (text: string): Promise<number[]> => {
  const body = await callModel("embed", async (signal) => {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${config.openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: text,
        dimensions: config.embeddingDimensions,
        provider: euOnlyRouting(config.embeddingProvider),
      }),
    });
    if (!response.ok) {
      throw new HttpError(
        `Embedding ${response.status}: ${await response.text()}`,
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    return (await response.json()) as { data: { embedding: number[] }[] };
  });
  const [item] = body.data;
  if (!item) throw new Error("Embedding: pusta odpowiedź");
  return fitDimensions(item.embedding);
};

export const embed = async (texts: string[]): Promise<number[][]> => {
  const vectors: number[][] = new Array(texts.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(EMBED_CONCURRENCY, texts.length) }, async () => {
    for (let i = next++; i < texts.length; i = next++) vectors[i] = await embedOne(texts[i]!);
  });
  await Promise.all(workers);
  return vectors;
};
