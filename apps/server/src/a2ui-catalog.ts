import { DataBindingSchema, DynamicNumberSchema, DynamicStringSchema } from "@a2ui/web_core/v0_9";
import { z } from "zod3";

// Construction components the agent can put on an A2UI surface, on top of the basic catalog
// (Card, Column, Row, Text...). This file is the contract shared by the server, which sends the
// schema to the model (a2ui.schema in the runtime), and the dashboard, which renders the
// components (apps/dashboard/src/a2uiCatalog.tsx). A2UI's binder reads zod v3 schemas, so they
// use the zod3 alias rather than the server's zod 4.

export const A2UI_CATALOG_ID = "https://brygadzista.app/a2ui/budowa/v1";

const source = z
  .object({
    page: z.number().int().min(1).describe("Numer strony w PDF, z której pochodzi informacja"),
    documentId: z.string().optional().describe("Id dokumentu z wyników narzędzi (search_project, read_page)"),
  })
  .describe("Źródło w projekcie. Podawaj zawsze, gdy znasz stronę.");

// A list is either written inline or bound to an array in the surface's data model.
const listOf = <T extends z.ZodTypeAny>(item: T, description: string) =>
  z.union([z.array(item), DataBindingSchema]).describe(description);

const material = z.object({
  name: z.string().describe("Materiał, np. 'Styropian EPS 031' albo 'Pustak ceramiczny 25 cm'"),
  quantity: z.union([z.string(), z.number()]).optional().describe("Ilość, np. 42 albo '42,5'"),
  unit: z.string().optional().describe("Jednostka, np. 'm²', 'm³', 'szt.', 'kg'"),
  note: z.string().optional().describe("Uwagi, np. klasa, wymiar, gdzie użyć"),
  source: source.optional(),
});

const step = z.object({
  title: z.string().describe("Co zrobić, krótko, np. 'Przyklej płyty styropianu'"),
  detail: z.string().optional().describe("Szczegóły: wymiary, materiał, na co uważać"),
  source: source.optional(),
});

const layer = z.object({
  material: z.string().describe("Materiał warstwy, np. 'Tynk cementowo-wapienny'"),
  thickness: z.string().optional().describe("Grubość z jednostką, np. '1,5 cm' albo '250 mm'"),
  note: z.string().optional(),
});

const partition = z.object({
  name: z.string().describe("Nazwa przegrody, np. 'Ściana zewnętrzna SZ1' albo 'Strop nad parterem'"),
  layers: z.array(layer).min(1).describe("Warstwy od zewnątrz (albo od góry) do wewnątrz"),
  total: z.string().optional().describe("Łączna grubość, np. '45 cm'"),
  uValue: z.string().optional().describe("Współczynnik U, np. '0,18 W/(m²·K)'"),
  source: source.optional(),
});

export const a2uiCatalogDefinitions = {
  ParameterCard: {
    description:
      "Jeden parametr z projektu: nazwa, wartość z jednostką i źródło. Do pytań o konkretny wymiar, grubość, klasę, spadek. Kilka parametrów ułóż w Column.",
    props: z.object({
      label: DynamicStringSchema.describe("Nazwa parametru, np. 'Grubość ocieplenia ścian'"),
      value: DynamicStringSchema.describe("Wartość bez jednostki, np. '15' albo 'C25/30'"),
      unit: DynamicStringSchema.optional().describe("Jednostka, np. 'cm', 'mm', '%'"),
      note: DynamicStringSchema.optional().describe("Krótkie doprecyzowanie, np. 'styropian grafitowy EPS 031'"),
      source: source.optional(),
    }),
  },
  MaterialList: {
    description:
      "Lista materiałów z ilościami (zestawienie, zamówienie, co kupić). Ilości tylko z projektu; jeśli projekt ich nie podaje, pomiń quantity.",
    props: z.object({
      title: DynamicStringSchema.optional().describe("Tytuł, np. 'Materiały na ocieplenie ścian'"),
      items: listOf(material, "Pozycje listy albo {path} do tablicy w modelu danych"),
    }),
  },
  WorkSteps: {
    description: "Kolejne kroki prac (technologia wykonania, kolejność robót), numerowane od 1.",
    props: z.object({
      title: DynamicStringSchema.optional().describe("Tytuł, np. 'Montaż okien w warstwie ocieplenia'"),
      steps: listOf(step, "Kroki w kolejności wykonania albo {path} do tablicy w modelu danych"),
    }),
  },
  LayerComparison: {
    description:
      "Układ warstw jednej lub kilku przegród (ściana, strop, dach, podłoga) obok siebie, do porównania. Warstwy od zewnątrz do wewnątrz.",
    props: z.object({
      title: DynamicStringSchema.optional().describe("Tytuł, np. 'Ściany zewnętrzne: SZ1 i SZ2'"),
      partitions: listOf(partition, "Przegrody (1–4) albo {path} do tablicy w modelu danych"),
      highlight: DynamicNumberSchema.optional().describe("Indeks przegrody (od 0) do wyróżnienia"),
    }),
  },
};

export type A2UISource = z.infer<typeof source>;
export const a2uiItemSchemas = { source, material, step, partition };
