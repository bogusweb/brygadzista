import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { sql } from "../src/db.js";
import { ADMIN, APP, createDocument, createProject, createTenant, createUser, login, resetDatabase } from "./helpers.js";

let projectId: string;
let documentId: string;

const json = (method: string, body: unknown, headers: Record<string, string>) => ({
  method,
  body: JSON.stringify(body),
  headers: { ...headers, "content-type": "application/json" },
});

const SIGNATURE = { aspect: 3, strokes: [[[0.1, 0.5], [0.2, 0.3], [0.3, 0.6], [0.4, 0.4]], [[0.5, 0.5], [0.6, 0.2], [0.7, 0.7], [0.8, 0.5]]] };

type View = { id: string; title: string; defectCount: number; openCount: number; url: string; signatures: { role: string; name: string }[] };

const addDefect = (room: string, status: string) =>
  sql`insert into pins (id, project_id, document_id, page_no, x, y, kind, room, note, status, created_at, updated_at)
    values (gen_random_uuid(), ${projectId}, ${documentId}, 1, 0.5, 0.5, 'defect', ${room}, 'Rysa na tynku', ${status}, now(), now())`;

const createProtocol = async (body: Record<string, unknown> = {}) => {
  const response = await app.request(`/api/projects/${projectId}/protocols`, json("POST", body, ADMIN));
  return { response, view: (await response.json()) as View };
};

beforeEach(async () => {
  await resetDatabase();
  projectId = await createProject("Dom w Piławie");
  documentId = await createDocument(projectId, "ready");
  await addDefect("Salon", "open");
  await addDefect("Kuchnia", "closed");
});

afterAll(async () => {
  await sql.end();
});

describe("saved protocol", () => {
  it("freezes the filtered defects and prints them with a QR code", async () => {
    const { response, view } = await createProtocol({ scope: "stage", title: "Odbiór stanu surowego", status: "open,to_check" });
    expect(response.status).toBe(201);
    expect(view).toMatchObject({ title: "Odbiór stanu surowego", defectCount: 1, openCount: 1, signatures: [] });
    expect(view.url).toMatch(/\/p\/bl_/);

    await sql`update pins set status = 'closed'`;
    expect(((await (await app.request(`/api/protocols/${view.id}`, { headers: APP })).json()) as View).openCount).toBe(1);

    const pdf = await app.request(`/api/protocols/${view.id}/protocol.pdf?token=test-app`);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("names a final acceptance by default and is made by owners and managers only", async () => {
    expect((await createProtocol({ scope: "final" })).view.title).toBe("Protokół odbioru końcowego");
    await createUser("brygadzista@example.com", "worker");
    const worker = await login("brygadzista@example.com");
    expect((await app.request(`/api/projects/${projectId}/protocols`, json("POST", {}, worker))).status).toBe(401);
  });

  it("takes a finger signature per side, replaces it when signed again and refuses an empty one", async () => {
    const { view } = await createProtocol();
    const sign = (role: string, body: unknown) => app.request(`/api/protocols/${view.id}/signatures/${role}`, json("PUT", body, APP));
    expect((await sign("investor", { name: "Anna Nowak", signature: SIGNATURE })).status).toBe(200);
    expect((await sign("investor", { name: "Anna Nowak-Kowalska", signature: SIGNATURE })).status).toBe(200);
    expect((await sign("contractor", { name: "", signature: SIGNATURE })).status).toBe(400);
    expect((await sign("contractor", { name: "Jan", signature: { aspect: 3, strokes: [[[0.1, 0.1]]] } })).status).toBe(400);
    expect((await sign("architect", { name: "Jan", signature: SIGNATURE })).status).toBe(404);
    const signed = (await (await app.request(`/api/protocols/${view.id}`, { headers: APP })).json()) as View;
    expect(signed.signatures).toEqual([expect.objectContaining({ role: "investor", name: "Anna Nowak-Kowalska" })]);
  });

  it("is not visible to another firm", async () => {
    const { view } = await createProtocol();
    const other = await createTenant("Inna firma");
    await createUser("szef@inna.pl", "owner", undefined, other);
    const headers = await login("szef@inna.pl");
    expect((await app.request(`/api/protocols/${view.id}`, { headers })).status).toBe(404);
    expect((await app.request(`/api/protocols/${view.id}/signatures/investor`, json("PUT", { name: "X", signature: SIGNATURE }, headers))).status).toBe(404);
  });
});

describe("online version behind the QR code", () => {
  it("shows the protocol and its signatures without logging in, until the link expires or the protocol is deleted", async () => {
    const { view } = await createProtocol();
    await app.request(`/api/protocols/${view.id}/signatures/contractor`, json("PUT", { name: "Jan Kowalski", signature: SIGNATURE }, APP));
    const path = new URL(view.url).pathname;

    const page = await app.request(path);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Salon");
    expect(html).toContain("Jan Kowalski");
    expect(html).toContain("jeszcze nie podpisano");
    const signature = await app.request(`${path}/signatures/contractor`);
    expect(signature.headers.get("content-type")).toBe("image/png");
    expect((await app.request(`${path}/signatures/investor`)).status).toBe(404);
    expect((await app.request(`${path}/protocol.pdf`)).headers.get("content-type")).toBe("application/pdf");
    expect((await app.request(`${path}/photos/00000000-0000-0000-0000-000000000000`)).status).toBe(404);

    expect((await app.request(`/api/protocols/${view.id}`, { method: "DELETE", headers: ADMIN })).status).toBe(204);
    expect((await app.request(path)).status).toBe(404);
  });

  it("does not open a report's link as a protocol", async () => {
    const { view } = await createProtocol();
    const token = new URL(view.url).pathname.split("/p/")[1]!;
    expect((await app.request(`/r/${token}`)).status).toBe(404);
  });
});
