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

// Embeddings may be served outside the EU (owner's decision), but never by a provider that keeps data.
const embeddingRouting = () =>
  config.embeddingProvider ? euOnlyRouting(config.embeddingProvider) : { data_collection: "deny" as const, zdr: true };

const openrouter = () =>
  createOpenRouter({ apiKey: config.openrouterApiKey, compatibility: "strict", appName: "Brygadzista" });

export const agentLanguageModel = () =>
  openrouter().chat(config.agentModel, { provider: euOnlyRouting(config.agentProvider) });

const visionLanguageModel = () => openrouter().chat(config.visionModel, { provider: euOnlyRouting(config.visionProvider) });

// Each attempt gets its own timeout, so one hung request cannot hold an indexing worker forever.
export const callModel = <T>(label: string, request: (abortSignal: AbortSignal) => Promise<T>) =>
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

// Large sheets come as an overview plus zoomed tiles, so small dimensions stay legible.
export const askAboutPage = async (imagePaths: string[], question: string): Promise<string> => {
  const images = await Promise.all(imagePaths.map(pageImagePart));
  const layout =
    images.length > 1
      ? `Pierwszy obraz to cały arkusz, kolejne ${images.length - 1} to jego powiększone fragmenty (kafelki od lewej do prawej, ` +
        "od góry do dołu, z niewielkim zakładem). Drobne wymiary odczytuj z kafelków. "
      : "";
  const { text } = await callModel("inspect drawing", (abortSignal) => generateText({
    model: visionLanguageModel(),
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

export type ChecklistSourcePage = { documentId: string; pageNo: number; title: string | null; text: string };

export type ChecklistFinding = { value: string; documentId: string; pageNo: number; quote: string };

const findingSchema = z.object({
  found: z.boolean(),
  value: z.string(),
  documentId: z.string(),
  pageNo: z.number().int(),
  quote: z.string(),
});

// Reads one checklist value from the project pages the search found (#68). Text only: a value that is only on a drawing
// comes back as not found, and the item stays "do potwierdzenia". The caller verifies the quote against the page.
export const readChecklistValue = async (ask: string, pages: ChecklistSourcePage[]): Promise<ChecklistFinding | null> => {
  const context = pages
    .map((page) => `### dokument ${page.documentId}, strona ${page.pageNo}${page.title ? ` – ${page.title}` : ""}\n${page.text}`)
    .join("\n\n");
  const { output } = await callModel("checklist value", (abortSignal) => generateText({
    model: agentLanguageModel(),
    abortSignal,
    maxRetries: 0,
    output: Output.object({ schema: findingSchema }),
    prompt:
      "Wypełniasz checklistę wykonawcy na budowie danymi z projektu technicznego. Poniżej fragmenty stron projektu.\n" +
      `Znajdź: ${ask}.\n` +
      "Zasady: wartość podaj dokładnie tak, jak w projekcie, z jednostkami i oznaczeniami. quote to dosłowny, krótki cytat " +
      "(jedno zdanie lub wiersz) ze strony, na której to jest, przepisany bez zmian. Podaj documentId i pageNo tej strony. " +
      "Jeśli strony tego nie określają, ustaw found na false i zostaw pozostałe pola puste (pageNo 0). Niczego nie zgaduj.\n\n" +
      context,
  }));
  return output.found && output.value.trim() ? { value: output.value.trim(), documentId: output.documentId, pageNo: output.pageNo, quote: output.quote.trim() } : null;
};

export type LayerFinding = { material: string; thickness: string; documentId: string; pageNo: number; quote: string };

const layersSchema = z.object({
  layers: z.array(z.object({ material: z.string(), thickness: z.string(), documentId: z.string(), pageNo: z.number().int(), quote: z.string() })),
});

// Reads the layers of one partition (wall, roof, floor) from the pages the search found (#71), outside to inside.
// The caller checks each quote against its page, the same way as for checklist values.
export const readLayers = async (name: string, pages: ChecklistSourcePage[]): Promise<LayerFinding[]> => {
  const context = pages
    .map((page) => `### dokument ${page.documentId}, strona ${page.pageNo}${page.title ? ` – ${page.title}` : ""}\n${page.text}`)
    .join("\n\n");
  const { output } = await callModel("partition layers", (abortSignal) => generateText({
    model: agentLanguageModel(),
    abortSignal,
    maxRetries: 0,
    output: Output.object({ schema: layersSchema }),
    prompt:
      `Przygotowujesz kartę przegrody „${name}” dla ekipy na budowie. Poniżej fragmenty stron projektu technicznego.\n` +
      "Wypisz warstwy tej przegrody od zewnątrz do wewnątrz (albo od góry do dołu): material to materiał warstwy, thickness " +
      "grubość z jednostką dokładnie jak w projekcie (pusta, gdy projekt jej nie podaje). quote to dosłowny, krótki cytat ze " +
      "strony, na której jest ta warstwa, przepisany bez zmian; podaj documentId i pageNo tej strony. Pomiń warstwy innych " +
      "przegród. Jeśli strony nie opisują warstw tej przegrody, zwróć pustą listę. Niczego nie zgaduj.\n\n" +
      context,
  }));
  return output.layers.filter((layer) => layer.material.trim());
};

// Gemini Embedding is Matryoshka-trained, so a longer vector can be truncated and renormalised.
const fitDimensions = (vector: number[]) => {
  const head = vector.slice(0, config.embeddingDimensions);
  const norm = Math.hypot(...head) || 1;
  return head.map((value) => value / norm);
};

// One text per request, a few at a time: some endpoints (Vertex) reject array input, and this
// keeps a switch of EMBEDDING_PROVIDER safe.
const EMBED_CONCURRENCY = 4;

type EmbeddingInput = string | { content: { type: "image_url"; image_url: { url: string } }[] };

const requestEmbedding = async (label: string, input: EmbeddingInput): Promise<number[]> => {
  const body = await callModel(label, async (signal) => {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${config.openrouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: typeof input === "string" ? input : [input],
        dimensions: config.embeddingDimensions,
        provider: embeddingRouting(),
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

const embedOne = (text: string) => requestEmbedding("embed", text);

// The page image goes into the same vector space as the text (Gemini Embedding 2 is multimodal),
// so a question can find a drawing even when the PDF has no text layer.
export const embedImage = async (imagePath: string): Promise<number[]> => {
  const url = `data:image/jpeg;base64,${(await readFile(imagePath)).toString("base64")}`;
  return requestEmbedding("embed image", { content: [{ type: "image_url", image_url: { url } }] });
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
