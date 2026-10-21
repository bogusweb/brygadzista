import { BuiltInAgent, defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { sql } from "./db.js";
import { inspectionImages } from "./drawing.js";
import { agentLanguageModel, askAboutPage } from "./llm.js";
import { listDefects } from "./defects.js";
import { DEFECT_STATUSES, photoImagePath, searchPins } from "./pins.js";
import { searchPages } from "./search.js";

const SYSTEM_PROMPT = `Jesteś Brygadzistą: asystentem wykonawcy na budowie. Odpowiadasz wyłącznie na podstawie projektu technicznego,
do którego masz dostęp przez narzędzia. Zasady:
- Zanim odpowiesz, wyszukaj informacje w projekcie (search_project, list_pages, read_page). Nie odpowiadaj z pamięci.
- Wymiary, grubości, materiały i oznaczenia podawaj dokładnie tak, jak w projekcie, z jednostkami.
- Każdą odpowiedź kończ źródłem w formacie "Źródło: str. N – tytuł".
- Strony mają tylko tekst z PDF, a rysunki często nie mają go wcale: gdy pytanie dotyczy rysunku, użyj inspect_drawing, żeby go obejrzeć.
- Gdy wykonawcy przyda się zobaczyć rysunek, wywołaj show_page, żeby wyświetlić mu stronę.
- search_project zwraca tylko strony, które naprawdę pasują. Gdy zwróci noMatch, spróbuj raz innymi słowami (np. nazwą materiału
  albo oznaczeniem z rysunku); jeśli dalej nic, nie zgaduj.
- Zdjęcia z budowy są przypięte przez ekipę do miejsc na stronach projektu, z datą, pomieszczeniem i notatką. Gdy pytanie
  dotyczy zdjęć („pokaż zdjęcia instalacji w łazience przed zakryciem”), użyj search_photos; aplikacja sama pokaże miniatury.
  Napisz krótko, co znalazłeś (data, pomieszczenie, notatka, strona).
- Usterki i poprawki to pinezki na rzutach ze statusem (otwarta, do sprawdzenia, zamknięta), osobą odpowiedzialną i terminem.
  Na pytania w rodzaju „co jeszcze otwarte u Kowalskiego?” albo „usterki na parterze” użyj search_defects i wypisz je krótko
  (pomieszczenie, opis, osoba, termin, strona). Protokół odbioru w PDF wykonawca pobiera w zakładce Usterki.
- Jeśli projekt czegoś nie określa, powiedz to wprost i zaproponuj, kogo zapytać (projektant, kierownik budowy).
- Pisz krótko, konkretnie, po polsku, jak do fachowca.`;

// Both runtimes inject render_a2ui (A2UI middleware), and both clients render the catalog.
const A2UI_PROMPT = `
Interfejs (render_a2ui): gdy odpowiedź to dane, które wykonawca będzie czytał na budowie, pokaż je jako powierzchnię A2UI
zamiast długiego tekstu, a w tekście napisz tylko jedno-dwa zdania podsumowania i źródło. Używaj komponentów z katalogu budowy:
- ParameterCard: konkretny parametr (grubość, wymiar, klasa betonu, spadek) z jednostką i stroną źródła.
- MaterialList: lista materiałów z ilościami, np. zestawienie na ocieplenie albo zamówienie.
- WorkSteps: kolejne kroki prac, gdy pytanie brzmi „jak wykonać”, „w jakiej kolejności”.
- LayerComparison: warstwy przegród (ściana, strop, dach, podłoga), także porównanie kilku przegród.
Kilka elementów ułóż w Column, a całość możesz zamknąć w Card. W każdym elemencie podawaj source.page (i source.documentId
z wyników narzędzi), żeby wykonawca mógł otworzyć stronę. Wartości bierz wyłącznie z projektu, niczego nie dopisuj.
Na proste pytanie z jedną liczbą wystarczy zwykły tekst albo jedna ParameterCard. Nie używaj A2UI do rozmowy ani do wyjaśnień.
Powierzchnię pokazujesz wyłącznie wywołaniem narzędzia render_a2ui. Nigdy nie wpisuj JSON-a komponentów do tekstu odpowiedzi,
bo wykonawca zobaczy wtedy surowy kod. Nawet gdy pokazujesz powierzchnię, zawsze napisz też krótką odpowiedź tekstem ze źródłem.`;

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
    prompt: SYSTEM_PROMPT + A2UI_PROMPT,
    maxSteps: 12,
    tools: [
      defineTool({
        name: "search_project",
        description: "Wyszukuje w projekcie technicznym strony pasujące do pytania (po znaczeniu i po słowach).",
        parameters: z.object({ query: z.string().describe("Czego szukasz, np. 'grubość ocieplenia ścian'") }),
        execute: async ({ query }) => {
          const results = await searchPages(projectId, query);
          return results.length ? { results } : { results, noMatch: true };
        },
      }),
      defineTool({
        name: "list_pages",
        description: "Zwraca spis wszystkich stron projektu z tytułami (pierwsza linia tekstu strony, puste dla stron bez tekstu).",
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
        description: "Czyta stronę: tytuł i tekst z PDF.",
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
          return { answer: await askAboutPage(await inspectionImages(documentId, pageNo), question) };
        },
      }),
      defineTool({
        name: "search_photos",
        description:
          "Szuka zdjęć z budowy przypiętych do stron projektu: po słowach z notatki, pomieszczenia i tytułu strony, po stronie i po dacie.",
        parameters: z.object({
          query: z.string().optional().describe("Słowa z notatki lub pomieszczenia, np. 'instalacja łazienka'; puste = wszystkie"),
          documentId: z.string().optional(),
          pageNo: z.number().int().min(1).optional().describe("Tylko zdjęcia z tej strony"),
          from: z.string().optional().describe("Od daty (YYYY-MM-DD)"),
          to: z.string().optional().describe("Do daty włącznie (YYYY-MM-DD)"),
        }),
        execute: async (search) => {
          const found = await searchPins(projectId, { ...search, limit: 12 });
          return {
            photos: found.map(({ matched: _matched, updatedAt: _updatedAt, ...pin }) => ({
              ...pin,
              photos: pin.photos.map((photo) => ({ ...photo, thumbPath: photoImagePath(projectId, photo.id, "thumb") })),
            })),
            ...(found.length ? {} : { noMatch: true }),
          };
        },
      }),
      defineTool({
        name: "search_defects",
        description: "Lista usterek i poprawek na rzutach: po statusie, osobie odpowiedzialnej, stronie (kondygnacji) i słowach z opisu.",
        parameters: z.object({
          status: z.array(z.enum(DEFECT_STATUSES)).optional().describe("open = otwarta, to_check = do sprawdzenia, closed = zamknięta"),
          assignee: z.string().optional().describe("Osoba odpowiedzialna, dokładnie jak w usterkach"),
          documentId: z.string().optional(),
          pageNo: z.number().int().min(1).optional().describe("Tylko usterki z tej strony (np. rzutu kondygnacji)"),
          query: z.string().optional().describe("Słowa z opisu, pomieszczenia albo tytułu strony"),
        }),
        execute: async ({ status, ...filter }) => {
          const found = await listDefects(projectId, { ...filter, statuses: status });
          return {
            defects: found.slice(0, 30).map(({ photos, x: _x, y: _y, kind: _kind, updatedAt: _updatedAt, ...defect }) => ({
              ...defect,
              photosBefore: photos.filter((photo) => photo.stage === "before").length,
              photosAfter: photos.filter((photo) => photo.stage === "after").length,
            })),
            total: found.length,
            ...(found.length ? {} : { noMatch: true }),
          };
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
