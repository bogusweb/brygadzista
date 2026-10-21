import { generateText, Output } from "ai";
import { z } from "zod";
import { agentLanguageModel, callModel } from "./llm.js";

// A page the model may quote: the defect's own drawing first, then pages found by the words of the note.
export type SpecPage = { documentId: string; pageNo: number; title: string | null; text: string };

export type SpecAnswer = { found: boolean; statement: string; quote: string; page: number };

const answerSchema = z.object({
  found: z.boolean().describe("true tylko wtedy, gdy któraś strona wprost określa to, czego dotyczy usterka."),
  statement: z
    .string()
    .describe("Jedno zdanie, co mówi projekt, z numerem rysunku, jeśli jest na stronie, np. „Wg rys. A-05 parapet na wysokości 90 cm”."),
  quote: z.string().describe("Dosłowny fragment tekstu strony, na którym opierasz zdanie; przepisz go bez zmian."),
  page: z.number().int().describe("Numer strony z listy, z której pochodzi cytat."),
});

export const findDefectSpec = async (defect: { note: string; room: string }, pages: SpecPage[]): Promise<SpecAnswer> => {
  const pageList = pages
    .map((page, index) => `--- ${index + 1}. str. ${page.pageNo}${page.title ? ` – ${page.title}` : ""}\n${page.text}`)
    .join("\n\n");
  const { output } = await callModel("defect spec", (abortSignal) =>
    generateText({
      model: agentLanguageModel(),
      abortSignal,
      maxRetries: 0,
      output: Output.object({ schema: answerSchema }),
      prompt:
        "Wykonawca zgłosił usterkę na budowie. Sprawdź w stronach projektu, co projekt mówi o tym elemencie (wymiar, materiał, " +
        "wykonanie), żeby przy odbiorze było jasne, jak powinno być. Opieraj się wyłącznie na tekście stron poniżej. " +
        "Jeśli żadna strona tego nie określa, ustaw found na false i zostaw pozostałe pola puste.\n\n" +
        `Usterka: ${defect.note}${defect.room ? `\nPomieszczenie: ${defect.room}` : ""}\n\nStrony projektu:\n${pageList}`,
    }),
  );
  return output;
};
