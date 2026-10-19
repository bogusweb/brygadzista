import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output } from "ai";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { config } from "./config.js";

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
  const { output } = await generateText({
    model: indexLanguageModel(),
    output: Output.object({ schema: pageIndexSchema }),
    messages: [
      {
        role: "user",
        content: [
          await pageImagePart(imagePath),
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
  });
  return output;
};

export const askAboutPage = async (imagePath: string, question: string): Promise<string> => {
  const { text } = await generateText({
    model: indexLanguageModel(),
    messages: [
      {
        role: "user",
        content: [
          await pageImagePart(imagePath),
          {
            type: "text",
            text:
              "To strona projektu technicznego. Odpowiedz po polsku na pytanie wykonawcy, opierając się wyłącznie na tym, " +
              `co widać na stronie. Jeśli czegoś nie da się odczytać, powiedz to wprost.\n\nPytanie: ${question}`,
          },
        ],
      },
    ],
  });
  return text;
};

// Gemini Embedding 2 is Matryoshka-trained, so a longer vector can be truncated and renormalised.
const fitDimensions = (vector: number[]) => {
  const head = vector.slice(0, config.embeddingDimensions);
  const norm = Math.hypot(...head) || 1;
  return head.map((value) => value / norm);
};

export const embed = async (texts: string[]): Promise<number[][]> => {
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openrouterApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: texts,
      dimensions: config.embeddingDimensions,
      provider: euOnlyRouting(config.embeddingProvider),
    }),
  });
  if (!response.ok) throw new Error(`Embedding ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { data: { index: number; embedding: number[] }[] };
  return body.data.sort((a, b) => a.index - b.index).map((item) => fitDimensions(item.embedding));
};
