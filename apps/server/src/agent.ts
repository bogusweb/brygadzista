import { BuiltInAgent, defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { sql } from "./db.js";
import { agentLanguageModel, askAboutPage } from "./llm.js";
import { searchPages } from "./search.js";
import { pageImage } from "./storage.js";

const SYSTEM_PROMPT = `Jesteś Brygadzistą: asystentem wykonawcy na budowie. Odpowiadasz wyłącznie na podstawie projektu technicznego,
do którego masz dostęp przez narzędzia. Zasady:
- Zanim odpowiesz, wyszukaj informacje w projekcie (search_project, list_pages, read_page). Nie odpowiadaj z pamięci.
- Wymiary, grubości, materiały i oznaczenia podawaj dokładnie tak, jak w projekcie, z jednostkami.
- Każdą odpowiedź kończ źródłem w formacie "Źródło: str. N – tytuł".
- Gdy pytanie dotyczy rysunku, a opis strony nie wystarcza, użyj inspect_drawing, żeby obejrzeć rysunek.
- Gdy wykonawcy przyda się zobaczyć rysunek, wywołaj show_page, żeby wyświetlić mu stronę.
- Jeśli projekt czegoś nie określa, powiedz to wprost i zaproponuj, kogo zapytać (projektant, kierownik budowy).
- Pisz krótko, konkretnie, po polsku, jak do fachowca.`;

const pageRef = z.object({
  documentId: z.string().describe("Id dokumentu z wyników wyszukiwania lub spisu stron"),
  pageNo: z.number().int().min(1).describe("Numer strony w PDF"),
});

const assertPageInProject = async (projectId: string, documentId: string, pageNo: number) => {
  const [page] = await sql<{ title: string | null; summary: string | null; facts: unknown; raw_text: string; kind: string | null }[]>`
    select p.title, p.summary, p.facts, p.raw_text, p.kind from pages p
    where p.project_id = ${projectId} and p.document_id = ${documentId} and p.page_no = ${pageNo}`;
  if (!page) throw new Error(`Nie ma strony ${pageNo} w tym dokumencie`);
  return page;
};

export const pageImagePath = (documentId: string, pageNo: number) => `/api/documents/${documentId}/pages/${pageNo}/image`;

export const createProjectAgent = (projectId: string) =>
  new BuiltInAgent({
    model: agentLanguageModel(),
    prompt: SYSTEM_PROMPT,
    maxSteps: 12,
    tools: [
      defineTool({
        name: "search_project",
        description: "Wyszukuje w projekcie technicznym strony pasujące do pytania (po znaczeniu i po słowach).",
        parameters: z.object({ query: z.string().describe("Czego szukasz, np. 'grubość ocieplenia ścian'") }),
        execute: async ({ query }) => ({ results: await searchPages(projectId, query) }),
      }),
      defineTool({
        name: "list_pages",
        description: "Zwraca spis wszystkich stron projektu z tytułami i rodzajem (opis, rysunek, detal...).",
        parameters: z.object({}),
        execute: async () => ({
          pages: await sql`
            select p.document_id as "documentId", d.filename, p.page_no as "pageNo", p.title, p.kind
            from pages p join documents d on d.id = p.document_id
            where p.project_id = ${projectId} order by d.created_at, p.page_no`,
        }),
      }),
      defineTool({
        name: "read_page",
        description: "Czyta pełny indeks strony: opis, wszystkie odczytane parametry i tekst z PDF.",
        parameters: pageRef,
        execute: async ({ documentId, pageNo }) => {
          const page = await assertPageInProject(projectId, documentId, pageNo);
          return { ...page, raw_text: page.raw_text.slice(0, 8000) };
        },
      }),
      defineTool({
        name: "inspect_drawing",
        description: "Ogląda obraz strony (rysunku) i odpowiada na konkretne pytanie o to, co na nim widać.",
        parameters: pageRef.extend({ question: z.string() }),
        execute: async ({ documentId, pageNo, question }) => {
          await assertPageInProject(projectId, documentId, pageNo);
          return { answer: await askAboutPage(pageImage(documentId, pageNo), question) };
        },
      }),
      defineTool({
        name: "show_page",
        description: "Wyświetla wykonawcy stronę projektu (rysunek) w aplikacji.",
        parameters: pageRef.extend({ caption: z.string().optional().describe("Krótki podpis, co warto zobaczyć") }),
        execute: async ({ documentId, pageNo, caption }) => {
          const page = await assertPageInProject(projectId, documentId, pageNo);
          return { documentId, pageNo, title: page.title, caption, imagePath: pageImagePath(documentId, pageNo) };
        },
      }),
    ],
  });
