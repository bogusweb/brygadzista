import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { sql } from "../src/db.js";
import { cropPath, designerAnswersPrompt, type DesignerQuestion } from "../src/questions.js";
import { ADMIN, APP, createDocument, createProject, insertPage, makePdf, resetDatabase, writeDocumentPdf } from "./helpers.js";

let projectId: string;
let documentId: string;

beforeEach(async () => {
  await resetDatabase();
  projectId = await createProject();
  documentId = await createDocument(projectId, "ready");
  await insertPage(projectId, documentId, 1, { title: "Opis techniczny", searchText: "Opis techniczny" });
  await insertPage(projectId, documentId, 2, { title: "Detal 3", searchText: "Detal 3 cokół" });
});

afterAll(async () => {
  await sql.end();
});

const json = (body: unknown) => ({ "content-type": "application/json", ...APP, body: JSON.stringify(body) });

const ask = async (body: Record<string, unknown>) => {
  const { body: payload, ...headers } = json(body);
  return app.request(`/api/projects/${projectId}/questions`, { method: "POST", headers, body: payload });
};

const answer = async (id: string, value: string | null) =>
  app.request(`/api/projects/${projectId}/questions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...ADMIN },
    body: JSON.stringify({ answer: value }),
  });

const QUESTION = "Opis podaje styropian 15 cm, a detal 3 na str. 2 pokazuje 12 cm. Którą grubość przyjąć przy cokole?";

describe("designer questions", () => {
  it("are saved with the page and listed newest first", async () => {
    const response = await ask({ documentId, pageNo: 2, question: QUESTION, reason: "opis 15 cm, detal 12 cm", region: { x: 0.5, y: 0.5, width: 0.25, height: 0.25 } });

    expect(response.status).toBe(201);
    const created = (await response.json()) as DesignerQuestion;
    expect(created).toMatchObject({ pageNo: 2, pageTitle: "Detal 3", status: "open", answer: null, question: QUESTION });
    expect(created.region).toEqual({ x: 0.5, y: 0.5, width: 0.25, height: 0.25 });

    await ask({ question: "Kto odbiera izolację przeciwwodną?" });
    const list = (await (await app.request(`/api/projects/${projectId}/questions`, { headers: APP })).json()) as DesignerQuestion[];
    expect(list.map((question) => question.question)).toEqual(["Kto odbiera izolację przeciwwodną?", QUESTION]);
  });

  it("rejects an empty question and a page outside the project", async () => {
    expect((await ask({ question: "  " })).status).toBe(400);
    expect((await ask({ documentId, pageNo: 9, question: QUESTION })).status).toBe(400);
    expect((await ask({ documentId, pageNo: 2, question: QUESTION, region: { x: 0.9, y: 0, width: 0.5, height: 0.5 } })).status).toBe(400);
  });

  it("is answered, filtered by status and opened again when the answer is cleared", async () => {
    const created = (await (await ask({ documentId, pageNo: 2, question: QUESTION })).json()) as DesignerQuestion;

    const answered = (await (await answer(created.id, "Przyjąć 12 cm, jak na detalu.")).json()) as DesignerQuestion;
    expect(answered).toMatchObject({ status: "answered", answer: "Przyjąć 12 cm, jak na detalu." });
    expect(answered.answeredAt).not.toBeNull();

    const open = await app.request(`/api/projects/${projectId}/questions?status=open`, { headers: APP });
    expect(await open.json()).toEqual([]);

    const reopened = (await (await answer(created.id, "")).json()) as DesignerQuestion;
    expect(reopened).toMatchObject({ status: "open", answer: null, answeredAt: null });
  });

  it("puts the answers into the agent's prompt", async () => {
    expect(await designerAnswersPrompt(projectId)).toBe("");
    const created = (await (await ask({ documentId, pageNo: 2, question: QUESTION })).json()) as DesignerQuestion;
    await answer(created.id, "Przyjąć 12 cm, jak na detalu.");

    const prompt = await designerAnswersPrompt(projectId);
    expect(prompt).toContain("[str. 2] Pytanie: Opis podaje styropian 15 cm");
    expect(prompt).toContain("Odpowiedź projektanta");
    expect(prompt).toContain("Przyjąć 12 cm, jak na detalu.");
  });

  it("are not visible from another project", async () => {
    const created = (await (await ask({ question: QUESTION })).json()) as DesignerQuestion;
    const other = await createProject("Inny");
    const response = await app.request(`/api/projects/${other}/questions/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...ADMIN },
      body: JSON.stringify({ answer: "x" }),
    });
    expect(response.status).toBe(404);
  });

  it("are deleted", async () => {
    const created = (await (await ask({ question: QUESTION })).json()) as DesignerQuestion;
    const response = await app.request(`/api/projects/${projectId}/questions/${created.id}`, { method: "DELETE", headers: APP });
    expect(response.status).toBe(204);
    expect(await sql`select 1 from designer_questions`).toHaveLength(0);
  });
});

describe("drawing crop", () => {
  it("cuts the region out of the PDF page at a legible resolution", async () => {
    await writeDocumentPdf(documentId, makePdf(["Opis", "Detal 3"]));
    const region = { x: 0, y: 0, width: 0.5, height: 0.25 };

    const response = await app.request(`${cropPath(documentId, 2, region)}&token=test-app`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    const { width, height } = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    expect(width).toBeGreaterThan(1000);
    expect(Math.abs(width! / height! - (0.5 * 612) / (0.25 * 792))).toBeLessThan(0.05);
  });

  it("without a region returns the whole page and rejects a broken region", async () => {
    await writeDocumentPdf(documentId, makePdf(["Opis", "Detal 3"]));
    expect((await app.request(`${cropPath(documentId, 1, null)}?token=test-app`)).status).toBe(200);
    expect((await app.request(`/api/documents/${documentId}/pages/1/crop?x=0.9&y=0&w=0.5&h=0.5&token=test-app`)).status).toBe(400);
    expect((await app.request(`/api/documents/${documentId}/pages/7/crop?token=test-app`)).status).toBe(404);
  });
});
