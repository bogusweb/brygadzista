import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import type { ChecklistSourcePage, ScheduleRowFinding } from "../src/llm.js";
import { rowOnPage, schedulesSettled } from "../src/schedules.js";
import { ADMIN, APP, createDocument, createProject, createTenant, createUser, insertPage, login, resetDatabase } from "./helpers.js";

const { embed, readScheduleRows } = vi.hoisted(() => ({
  embed: vi.fn<(texts: string[]) => Promise<number[][]>>(),
  readScheduleRows: vi.fn<(page: ChecklistSourcePage) => Promise<ScheduleRowFinding[]>>(),
}));
vi.mock("../src/llm.js", () => ({ embed, readScheduleRows, agentLanguageModel: vi.fn(), askAboutPage: vi.fn() }));

// The window schedule of the sample PDF (hala Pilawa, rys. 14), as pdftotext -layout gives it.
const WINDOWS_PAGE = `                     ZESTAWIENIE STOLARKI OKIENNEJ
     Symbol na rzucie             O1                    O2
         Rysunek
     Wymiary otworu:             84x142                84x142
                                                                      Okna- współczynnik U=0,9 W/m2*K.
           Ilość:                  52                    52           Drzwi zewnętrzne - współczynnik U=1,3 W/m2*K.
                          3-szybowe ze szkłem   3-szybowe ze szkłem   Przed zamówieniem stolarki należy pobrać wymiary
         Szklenie:           niskoemisyjnym        niskoemisyjnym     otworów okiennych i drzwiowych na budowie.
          Uwagi:                  PCV                 PCV, FIX        Drzwi i okna wyposażone w okucia.`;

const STEEL_PAGE = `ZESTAWIENIE STALI ZBROJENIOWEJ - STROP NAD PARTEREM
Nr  Średnica  Długość [cm]  Liczba [szt.]  Długość całkowita [m]
1   Ø12       420           38             159,60
2   Ø12       215           40             86,00
3   Ø8        110           120            132,00
Stal B500SP`;

const window = (mark: string, quantity: number): ScheduleRowFinding => ({
  category: "okna",
  element: "",
  level: "",
  mark,
  description: "okno PCV 3-szybowe",
  dimensions: "84x142",
  quantity,
  unit: "szt.",
  quote: "Ilość: 52 52",
});

const bar = (mark: string, diameter: number, quantity: number): ScheduleRowFinding => ({
  category: "stal",
  element: "strop nad parterem",
  level: "parter",
  mark,
  description: `pręt Ø${diameter} B500SP`,
  dimensions: "",
  quantity,
  unit: "m",
  quote: "",
});

type Schedule = {
  status: string;
  pages: { pageNo: number }[];
  items: { mark: string; quantity: number | null; verified: boolean; pageNo: number; category: string }[];
  totals: { category: string; label: string; unit: string; quantity: number; rows: number }[];
};

let projectId: string;
let documentId: string;

beforeEach(async () => {
  await resetDatabase();
  embed.mockReset().mockImplementation(async (texts) => texts.map(() => Array.from({ length: config.embeddingDimensions }, () => 0)));
  readScheduleRows.mockReset().mockImplementation(async (page) => {
    if (page.pageNo === 27) return [window("O1", 52), window("O2", 52), { ...window("O3", 12), dimensions: "90x150" }];
    if (page.pageNo === 31) return [bar("1", 12, 159.6), bar("2", 12, 86), bar("3", 8, 132), bar("4", 16, 40)];
    return [];
  });
  config.openrouterApiKey = "test-key";
  projectId = await createProject();
  documentId = await createDocument(projectId, "ready");
  await insertPage(projectId, documentId, 3, { title: "Opis techniczny", searchText: "Opis techniczny. Okna PCV." });
  await insertPage(projectId, documentId, 27, { title: "ZESTAWIENIE STOLARKI (rys. 14)", searchText: WINDOWS_PAGE });
  await insertPage(projectId, documentId, 31, { title: "Strop nad parterem – zbrojenie", searchText: STEEL_PAGE });
});

afterEach(() => {
  config.openrouterApiKey = "";
});

afterAll(async () => {
  await sql.end();
});

const getSchedule = async (query = "", headers: Record<string, string> = APP, project = projectId) => {
  const first = (await (await app.request(`/api/projects/${project}/schedules${query}`, { headers })).json()) as Schedule;
  await schedulesSettled(project);
  return { first, ready: (await (await app.request(`/api/projects/${project}/schedules${query}`, { headers })).json()) as Schedule };
};

describe("rowOnPage", () => {
  it("finds a row's symbol, size and count in a table that lost its spacing", () => {
    expect(rowOnPage({ mark: "O1", dimensions: "84 x 142", quantity: 52 }, WINDOWS_PAGE)).toBe(true);
    expect(rowOnPage({ mark: "1", dimensions: "", quantity: 159.6 }, STEEL_PAGE)).toBe(true);
    expect(rowOnPage({ mark: "O3", dimensions: "84x142", quantity: 52 }, WINDOWS_PAGE)).toBe(false);
    expect(rowOnPage({ mark: "O1", dimensions: "84x142", quantity: 5 }, WINDOWS_PAGE)).toBe(false);
    expect(rowOnPage({ mark: "poz. 2", dimensions: "", quantity: 86 }, STEEL_PAGE)).toBe(true);
  });
});

describe("material schedules", () => {
  it("reads the schedule pages once, and adds up only rows whose numbers are on the page", async () => {
    const { first, ready } = await getSchedule();

    expect(first.status).toBe("reading");
    expect(ready.status).toBe("ready");
    expect(ready.pages.map((page) => page.pageNo)).toEqual([27, 31]);
    expect(readScheduleRows).toHaveBeenCalledTimes(2);
    // The window schedule of the sample project: O1 and O2, 52 each, 84x142.
    expect(ready.items.filter((item) => item.category === "okna").map((item) => [item.mark, item.quantity, item.verified])).toEqual([
      ["O1", 52, true],
      ["O2", 52, true],
      ["O3", 12, false],
    ]);
    expect(ready.totals).toEqual(
      expect.arrayContaining([
        { category: "okna", label: "O1 84x142", unit: "szt.", quantity: 52, rows: 1 },
        { category: "stal", label: "Ø12", unit: "m", quantity: 245.6, rows: 2 },
        { category: "stal", label: "Ø8", unit: "m", quantity: 132, rows: 1 },
      ]),
    );
    expect(ready.totals.some((total) => total.label === "Ø16" || total.label.startsWith("O3"))).toBe(false);

    await getSchedule();
    expect(readScheduleRows).toHaveBeenCalledTimes(2);
  });

  it("filters by kind, element and diameter", async () => {
    await getSchedule();
    const { ready } = await getSchedule("?category=stal&element=strop%20nad%20parterem&mark=%C3%9812");

    expect(ready.items.map((item) => item.mark)).toEqual(["1", "2"]);
    expect(ready.totals).toEqual([{ category: "stal", label: "Ø12", unit: "m", quantity: 245.6, rows: 2 }]);
  });

  it("exports a CSV that Excel in Polish opens in columns", async () => {
    await getSchedule();
    const response = await app.request(`/api/projects/${projectId}/schedules.csv?category=okna`, { headers: APP });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(csv.startsWith("﻿Kategoria;Element;Kondygnacja;Symbol;Opis;Wymiary;Ilość;Jedn.;Strona;Uwagi")).toBe(true);
    expect(csv).toContain("Stolarka okienna;;;O1;okno PCV 3-szybowe;84x142;52;szt.;27;");
    expect(csv).toContain("O3;okno PCV 3-szybowe;90x150;12;szt.;27;do sprawdzenia w projekcie");
  });

  it("says when the project has no schedule or the server cannot read one", async () => {
    const empty = await createProject("Bez zestawień");
    const emptyDoc = await createDocument(empty, "ready");
    await insertPage(empty, emptyDoc, 1, { title: "Opis", searchText: "Opis techniczny." });
    expect((await getSchedule("", APP, empty)).ready).toMatchObject({ status: "ready", pages: [], items: [] });

    config.openrouterApiKey = "";
    const { ready } = await getSchedule();
    expect(ready).toMatchObject({ status: "no_model", items: [] });
    expect(readScheduleRows).not.toHaveBeenCalled();
  });

  it("reads a page again after it is reindexed or refreshed, and records a page that failed", async () => {
    await getSchedule();
    readScheduleRows.mockRejectedValue(new Error("OpenRouter 402"));

    const refresh = await app.request(`/api/projects/${projectId}/schedules/refresh`, { method: "POST", headers: ADMIN });
    expect(refresh.status).toBe(202);
    await schedulesSettled(projectId);
    const failed = (await (await app.request(`/api/projects/${projectId}/schedules`, { headers: APP })).json()) as Schedule & { failedPages: number[] };

    expect(failed.failedPages).toEqual([27, 31]);
    expect(failed.status).toBe("ready");
  });

  it("keeps schedules inside their firm", async () => {
    await getSchedule();
    const otherFirm = await createTenant("Inna firma");
    await createUser("obcy@example.com", "owner", undefined, otherFirm);
    const stranger = await login("obcy@example.com");

    expect((await app.request(`/api/projects/${projectId}/schedules`, { headers: stranger })).status).toBe(404);
    expect((await app.request(`/api/projects/${projectId}/schedules.csv`, { headers: stranger })).status).toBe(404);
    const tenants = await sql`
      select distinct i.tenant_id from schedule_items i where i.project_id = ${projectId}
      except select tenant_id from projects where id = ${projectId}`;
    expect(tenants).toHaveLength(0);
  });
});
