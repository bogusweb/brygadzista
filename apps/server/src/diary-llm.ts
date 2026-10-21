import { generateText, Output } from "ai";
import { z } from "zod";
import type { CandidatePage, DiaryEntry } from "./diary-entry.js";
import { agentLanguageModel, callModel } from "./llm.js";

// The voice note goes to the chat model (Gemini hears audio), pinned to the EU and to zero data retention like every call.
export const transcribeAudio = async (audio: Uint8Array, mediaType: string): Promise<string> => {
  const { text } = await callModel("diary transcript", (abortSignal) =>
    generateText({
      model: agentLanguageModel(),
      abortSignal,
      maxRetries: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data: audio, mediaType },
            {
              type: "text",
              text:
                "To nagranie brygadzisty z budowy, podsumowanie dnia pracy. Przepisz dokładnie, co mówi, po polsku, " +
                "z interpunkcją. Liczby zapisuj cyframi. Nie dodawaj komentarzy ani nagłówków. " +
                "Jeśli nagranie jest ciche albo nie ma w nim mowy, zwróć pusty tekst.",
            },
          ],
        },
      ],
    }),
  );
  return text.trim();
};

// What the model returns; references point to the candidate pages by their number in the list, never to made-up pages.
const organizedSchema = z.object({
  summary: z.string().describe("Jedno zdanie: najważniejsze, co zrobiono tego dnia."),
  work: z.array(z.string()).describe("Wykonane prace, każda osobno, w stylu dziennika budowy (np. „Zabetonowano ławy fundamentowe w osiach A–C”)."),
  people: z.array(z.string()).describe("Ludzie na budowie: liczba i branże albo nazwiska, jeśli padły (np. „4 zbrojarzy”)."),
  deliveries: z.array(z.string()).describe("Dostawy: materiał, ilość, dostawca, jeśli padły."),
  weather: z.string().nullable().describe("Pogoda i jej wpływ na prace; null, jeśli nie padło nic o pogodzie."),
  problems: z.array(z.string()).describe("Problemy, braki, przestoje, usterki i to, co trzeba załatwić."),
  references: z
    .array(z.object({ page: z.number().int().describe("Numer z listy stron projektu."), note: z.string().describe("Czego z nagrania dotyczy ta strona.") }))
    .describe("Strony projektu, których dotyczą wykonane prace; tylko z podanej listy i tylko gdy pasują."),
});

export const organizeTranscript = async (transcript: string, pages: CandidatePage[]): Promise<DiaryEntry> => {
  const pageList = pages.length
    ? pages.map((page, index) => `${index + 1}. str. ${page.pageNo}${page.title ? ` – ${page.title}` : ""}`).join("\n")
    : "(brak pasujących stron)";
  const { output } = await callModel("diary entry", (abortSignal) =>
    generateText({
      model: agentLanguageModel(),
      abortSignal,
      maxRetries: 0,
      output: Output.object({ schema: organizedSchema }),
      prompt:
        "Uporządkuj notatkę brygadzisty z dnia pracy na budowie w wpis dziennika. Pisz po polsku, rzeczowo, w formie bezosobowej. " +
        "Wpisuj wyłącznie to, co padło w notatce: niczego nie dopowiadaj ani nie zgaduj. Pustą kategorię zostaw pustą.\n\n" +
        `Strony projektu, które mogą dotyczyć tych prac:\n${pageList}\n\nNotatka:\n${transcript}`,
    }),
  );
  const references = output.references.flatMap(({ page, note }) => {
    const candidate = pages[page - 1];
    return candidate ? [{ ...candidate, note }] : [];
  });
  return { ...output, references: references.slice(0, 10) };
};
