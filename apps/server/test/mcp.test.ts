import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { sql } from "../src/db.js";
import {
  addMember,
  createDocument,
  createProject,
  createTenant,
  createUser,
  insertPage,
  login,
  makePdf,
  resetDatabase,
  writeDocumentPdf,
} from "./helpers.js";

type RpcAnswer = { id: number; result?: Record<string, unknown>; error?: { code: number; message: string } };
type ToolAnswer = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };

const rpc = async (headers: Record<string, string>, method: string, params?: unknown, url = "/mcp") => {
  const response = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as RpcAnswer | null };
};

const call = async (headers: Record<string, string>, name: string, args: Record<string, unknown> = {}) => {
  const { body } = await rpc(headers, "tools/call", { name, arguments: args });
  return body!.result as ToolAnswer;
};

const json = (answer: ToolAnswer) => JSON.parse(answer.content[0]!.text!) as Record<string, unknown>;

let projectId: string;
let documentId: string;
let otherFirmProject: string;
let owner: Record<string, string>;

beforeEach(async () => {
  await resetDatabase();
  const tenant = await createTenant("Firma A");
  await createUser("szef@a.pl", "owner", undefined, tenant);
  owner = await login("szef@a.pl");
  projectId = await createProject("Hala sportowa", tenant);
  documentId = await createDocument(projectId, "ready");
  await insertPage(projectId, documentId, 1, { title: "Opis techniczny", searchText: "OPIS TECHNICZNY ocieplenie ścian styropian 15 cm" });
  await insertPage(projectId, documentId, 2, { title: "Rzut dachu", searchText: "RYSUNEK: RZUT DACHU" });
  otherFirmProject = await createProject("Cudza budowa", await createTenant("Firma B"));
});

afterAll(async () => {
  await sql.end();
});

describe("MCP endpoint", () => {
  it("needs a token, in the header or in ?token=", async () => {
    const anonymous = await rpc({}, "tools/list");
    expect(anonymous.status).toBe(401);

    const viaQuery = await rpc({}, "tools/list", undefined, `/mcp?token=${owner.authorization!.slice("Bearer ".length)}`);
    expect(viaQuery.status).toBe(200);
  });

  it("answers the handshake and lists read-only tools with JSON schemas", async () => {
    const { body } = await rpc(owner, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(body!.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "brygadzista" } });

    const initialized = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...owner },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(initialized.status).toBe(202);

    const tools = (await rpc(owner, "tools/list")).body!.result!.tools as { name: string; inputSchema: { type: string }; annotations: unknown }[];
    expect(tools.map((tool) => tool.name)).toEqual(["list_projects", "search_project", "get_project_outline", "get_pages", "get_page_image"]);
    expect(tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
    expect(tools[0]!.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });

    expect((await rpc(owner, "resources/list")).body!.error?.code).toBe(-32601);
    expect((await app.request("/mcp", { headers: owner })).status).toBe(405);
  });

  it("lists only the projects of the account's firm, and a worker only theirs", async () => {
    expect(json(await call(owner, "list_projects")).projects).toEqual([{ id: projectId, name: "Hala sportowa", documentCount: 1 }]);

    const [tenant] = await sql<{ tenant_id: string }[]>`select tenant_id from projects where id = ${projectId}`;
    const workerId = await createUser("jan@a.pl", "worker", undefined, tenant!.tenant_id);
    const worker = await login("jan@a.pl");
    expect(json(await call(worker, "list_projects")).projects).toEqual([]);
    await addMember(projectId, workerId);
    expect((json(await call(worker, "list_projects")).projects as unknown[]).length).toBe(1);
  });

  it("reads the outline, pages and search results of the project", async () => {
    const outline = json(await call(owner, "get_project_outline", { projectId })).documents as { outline: { sections: unknown[] } }[];
    expect(outline[0]!.outline.sections.length).toBeGreaterThan(0);

    const pages = json(await call(owner, "get_pages", { projectId, documentId, from: 1, to: 2 }));
    expect((pages.pages as { pageNo: number }[]).map((page) => page.pageNo)).toEqual([1, 2]);

    const search = json(await call(owner, "search_project", { projectId, query: "ocieplenie ścian" }));
    expect((search.results as { pageNo: number }[])[0]?.pageNo).toBe(1);
  });

  it("returns a page image", async () => {
    await writeDocumentPdf(documentId, makePdf(["Opis techniczny", "Rzut dachu"]));
    const answer = await call(owner, "get_page_image", { projectId, documentId, pageNo: 2 });
    expect(answer.content[0]).toEqual({ type: "text", text: "Strona 2: Rzut dachu" });
    expect(answer.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(Buffer.from(answer.content[1]!.data!, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("does not open another firm's project or a document from another project", async () => {
    for (const name of ["get_project_outline", "search_project"]) {
      const answer = await call(owner, name, { projectId: otherFirmProject, query: "dach" });
      expect(answer.isError).toBe(true);
      expect(answer.content[0]!.text).toContain("Nie ma takiego projektu");
    }
    const foreignDocument = await createDocument(otherFirmProject, "ready");
    const answer = await call(owner, "get_pages", { projectId, documentId: foreignDocument, from: 1, to: 1 });
    expect(answer).toMatchObject({ isError: true, content: [{ text: "Nie ma takiego dokumentu w tym projekcie" }] });
  });

  it("reports bad arguments as a tool error and an unknown tool as a protocol error", async () => {
    expect((await call(owner, "get_pages", { projectId })).isError).toBe(true);
    expect((await rpc(owner, "tools/call", { name: "delete_project", arguments: {} })).body!.error?.code).toBe(-32602);
  });
});
