import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { replacePageFacts, sql } from "../src/db.js";
import { pairPages } from "../src/revisions.js";
import { searchPages } from "../src/search.js";
import { ADMIN, APP, createDocument, createProject, createTenant, createUser, insertPage, login, makePdf, resetDatabase } from "./helpers.js";

const { embed } = vi.hoisted(() => ({ embed: vi.fn<(texts: string[]) => Promise<number[][]>>() }));
vi.mock("../src/llm.js", () => ({ embed, agentLanguageModel: vi.fn(), askAboutPage: vi.fn() }));

type Change = {
  kind: string;
  pageNo: number | null;
  previousPageNo: number | null;
  drawingNo: string | null;
  facts: { label: string; before: string | null; after: string | null }[];
  linesAdded: string[];
  linesRemoved: string[];
  imagePath: string | null;
  previousImagePath: string | null;
};
type Revision = { documentId: string; previousId: string; filename: string; changedPages: number; changes: Change[] };

let projectId: string;
let oldDoc: string;
let newDoc: string;

const page = async (documentId: string, pageNo: number, text: string, drawingNo: string | null = null) => {
  const id = await insertPage(projectId, documentId, pageNo, { title: text.split("\n")[0], searchText: text, indexed: true });
  await sql`update pages set drawing_no = ${drawingNo} where id = ${id}`;
  await sql.begin((tx) => replacePageFacts(tx, id, projectId, text));
};

const revisionOf = async (previousId: string, status = "ready") => {
  const [doc] = await sql<{ id: string }[]>`
    insert into documents (project_id, filename, status, revision_of) values (${projectId}, 'projekt-rev1.pdf', ${status}, ${previousId})
    returning id`;
  return doc!.id;
};

beforeEach(async () => {
  await resetDatabase();
  embed.mockReset();
  config.openrouterApiKey = "";
  projectId = await createProject();
  oldDoc = await createDocument(projectId, "ready");
  await page(oldDoc, 1, "Opis techniczny\nOcieplenie ścian styropian gr. 12 cm");
  await page(oldDoc, 2, "Wieniec W1\nzbrojenie 4 pręty Ø12 mm", "A-03");
  await page(oldDoc, 3, "Rzut parteru\nOkno O3 wysokość 150 cm", "A-04");
  await page(oldDoc, 4, "Detal cokołu\nstyrodur 10 cm");
  newDoc = await revisionOf(oldDoc);
  await page(newDoc, 1, "Opis techniczny\nOcieplenie ścian styropian gr. 15 cm");
  await page(newDoc, 2, "Rzut parteru\nOkno O3 wysokość 150 cm", "A-04");
  await page(newDoc, 3, "Wieniec W1\nzbrojenie 4 pręty Ø16 mm", "A-03");
  await page(newDoc, 4, "Detal 5 – attyka\nobróbka blacharska");
});

afterAll(async () => {
  await sql.end();
});

describe("pairPages", () => {
  it("pairs by drawing number, then title, then page number, and keeps the rest as added or removed", () => {
    const old = [
      { pageNo: 1, title: "Opis", drawingNo: null },
      { pageNo: 2, title: "Wieniec", drawingNo: "A-03" },
      { pageNo: 3, title: "Rzut parteru (rys. 4)", drawingNo: null },
      { pageNo: 9, title: "Stara strona", drawingNo: "A-99" },
    ];
    const fresh = [
      { pageNo: 1, title: "Inny tytuł", drawingNo: null },
      { pageNo: 2, title: "Rzut parteru (rys. 5)", drawingNo: null },
      { pageNo: 5, title: "Wieniec zmieniony", drawingNo: "a 03" },
      { pageNo: 6, title: "Nowa", drawingNo: "A-10" },
    ];

    expect(pairPages(old, fresh).map(({ before, after }) => [before?.pageNo ?? null, after?.pageNo ?? null])).toEqual([
      [2, 5],
      [3, 2],
      [1, 1],
      [null, 6],
      [9, null],
    ]);
  });
});

describe("versions of a document", () => {
  it("lists what changed: values, moved sheets, new and removed pages, with both versions' pages", async () => {
    const response = await app.request(`/api/documents/${newDoc}/changes`, { headers: APP });
    expect(response.status).toBe(200);
    const { changes } = (await response.json()) as Revision;

    const byNew = (pageNo: number | null) => changes.find((change) => change.pageNo === pageNo)!;
    expect(byNew(1)).toMatchObject({
      kind: "changed",
      previousPageNo: 1,
      facts: [{ label: expect.stringContaining("styropian"), before: "12 cm", after: "15 cm" }],
      linesAdded: ["Ocieplenie ścian styropian gr. 15 cm"],
      linesRemoved: ["Ocieplenie ścian styropian gr. 12 cm"],
      imagePath: `/api/documents/${newDoc}/pages/1/image`,
      previousImagePath: `/api/documents/${oldDoc}/pages/1/image`,
    });
    expect(byNew(3)).toMatchObject({ kind: "changed", previousPageNo: 2, drawingNo: "A-03" });
    expect(byNew(3).linesAdded).toEqual(["zbrojenie 4 pręty Ø16 mm"]);
    // The sheet A-04 moved from page 3 to 2 without changes, so it is not listed.
    expect(changes.some((change) => change.drawingNo === "A-04")).toBe(false);
    expect(byNew(4)).toMatchObject({ kind: "changed", previousPageNo: 4 });
    expect(changes).toHaveLength(3);

    const revisions = (await (await app.request(`/api/projects/${projectId}/revisions`, { headers: APP })).json()) as Revision[];
    expect(revisions).toMatchObject([{ documentId: newDoc, previousId: oldDoc, changedPages: 3 }]);
  });

  it("answers from the newest version once it is indexed, and from the old one until then", async () => {
    const hits = await searchPages(projectId, "ocieplenie ścian styropian");
    expect(hits.map((hit) => hit.documentId)).toEqual([newDoc]);

    await sql`update documents set status = 'processing' where id = ${newDoc}`;
    expect((await searchPages(projectId, "ocieplenie ścian styropian")).map((hit) => hit.documentId)).toContain(oldDoc);
    expect((await app.request(`/api/documents/${newDoc}/changes`, { headers: APP })).status).toBe(404);
  });

  it("marks the old and new versions in the document list", async () => {
    const documents = (await (await app.request(`/api/projects/${projectId}/documents`, { headers: APP })).json()) as {
      id: string;
      revisionOf: string | null;
      supersededBy: string | null;
    }[];

    expect(documents.find((doc) => doc.id === oldDoc)).toMatchObject({ revisionOf: null, supersededBy: newDoc });
    expect(documents.find((doc) => doc.id === newDoc)).toMatchObject({ revisionOf: oldDoc, supersededBy: null });
  });

  it("uploads a new version only of a document of the same project", async () => {
    const upload = (revisionOf: string) =>
      app.request(`/api/projects/${projectId}/documents?filename=rev.pdf&autostart=0&revisionOf=${revisionOf}`, {
        method: "PUT",
        body: makePdf(["Opis techniczny"]),
        headers: ADMIN,
      });
    const other = await createDocument(await createProject("Inny"), "ready");

    expect((await upload(other)).status).toBe(400);
    expect((await upload("nie-uuid")).status).toBe(400);
    const response = await upload(oldDoc);
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const [row] = await sql<{ revisionOf: string }[]>`select revision_of as "revisionOf" from documents where id = ${id}`;
    expect(row!.revisionOf).toBe(oldDoc);
  });

  it("keeps changes inside their firm", async () => {
    const otherFirm = await createTenant("Inna firma");
    await createUser("obcy@example.com", "owner", undefined, otherFirm);
    const stranger = await login("obcy@example.com");

    expect((await app.request(`/api/documents/${newDoc}/changes`, { headers: stranger })).status).toBe(404);
    expect((await app.request(`/api/projects/${projectId}/revisions`, { headers: stranger })).status).toBe(404);
  });
});
