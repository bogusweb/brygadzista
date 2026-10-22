import { Hono } from "hono";
import { access } from "node:fs/promises";
import sharp from "sharp";
import { z } from "zod";
import { bearerToken, canAccessProject, principalFromToken, visibleProjects, type Principal } from "./auth.js";
import { sql } from "./db.js";
import { pdfRenderPage } from "./pdf.js";
import { MAX_PAGES_PER_CALL, projectOutline, readPages } from "./project-outline.js";
import { limiters, principalKey } from "./rate-limit.js";
import { searchPages } from "./search.js";
import { documentPdf, pageImage, pageImagePrefix } from "./storage.js";

// MCP server over the construction project (#47): a contractor adds https://…/mcp as a custom connector in Claude
// Desktop or claude.ai and asks their own assistant about the project. Streamable HTTP without sessions: every POST
// carries one JSON-RPC message (or a batch) and gets a JSON answer. The tools only read, and see only the projects the
// token's account sees. The token comes as a Bearer header or, for clients that cannot set headers, as ?token=.

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "brygadzista", title: "Brygadzista: projekt budowy", version: "1.0.0" };

const INSTRUCTIONS = `Narzędzia do projektu technicznego budowy (PDF z opisem i rysunkami). Zacznij od list_projects.
Przy pytaniu o cały dział (rzuty, przekroje, detale, rozdział opisu) użyj get_project_outline, a potem get_pages.
Przy konkretnym parametrze (grubość, klasa betonu, wymiar) użyj search_project. Rysunki często nie mają tekstu:
obejrzyj je get_page_image. Podawaj wartości dokładnie jak w projekcie, z numerem strony PDF jako źródłem.`;

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: Record<string, unknown> };
type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };

class ToolError extends Error {}

const text = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 1) }] });

const projectId = z.string().describe("Id projektu z list_projects");
const documentId = z.string().describe("Id dokumentu (PDF) ze spisu treści albo wyników wyszukiwania");

const IMAGE_LONG_EDGE = 1568;

type Tool<Schema extends z.ZodType> = {
  description: string;
  input: Schema;
  run: (principal: Principal, args: z.infer<Schema>) => Promise<ToolResult>;
};

const tool = <Schema extends z.ZodType>(definition: Tool<Schema>) => definition;

const assertProject = async (principal: Principal, id: string) => {
  if (!(await canAccessProject(principal, id))) throw new ToolError("Nie ma takiego projektu albo brak do niego dostępu");
};

const assertDocument = async (projectId: string, id: string) => {
  const [doc] = await sql`select 1 from documents where id::text = ${id} and project_id = ${projectId}`;
  if (!doc) throw new ToolError("Nie ma takiego dokumentu w tym projekcie");
};

const TOOLS = {
  list_projects: tool({
    description: "Lista projektów budowy dostępnych dla tego konta: id, nazwa, liczba dokumentów PDF.",
    input: z.object({}),
    run: async (principal) =>
      text({
        projects: await sql`
          select p.id, p.name, (select count(*)::int from documents d where d.project_id = p.id) as "documentCount"
          from projects p where ${visibleProjects(principal)} order by p.created_at desc`,
      }),
  }),
  search_project: tool({
    description: "Wyszukuje w projekcie strony pasujące do pytania (po znaczeniu, słowach i oznaczeniach z rysunków).",
    input: z.object({ projectId, query: z.string().min(1).describe("Czego szukasz, np. 'grubość ocieplenia ścian'") }),
    run: async (principal, { projectId, query }) => {
      await assertProject(principal, projectId);
      const results = await searchPages(projectId, query);
      return text(results.length ? { results } : { results, noMatch: true });
    },
  }),
  get_project_outline: tool({
    description:
      "Spis treści projektu: części (opis techniczny z rozdziałami, rzuty, przekroje, elewacje, detale, zestawienia) z zakresami " +
      "stron w PDF. verified=false: strony wyliczone ze spisu w projekcie, nie potwierdzone na samej stronie.",
    input: z.object({ projectId }),
    run: async (principal, { projectId }) => {
      await assertProject(principal, projectId);
      return text({ documents: await projectOutline(projectId) });
    },
  }),
  get_pages: tool({
    description: `Tekst z PDF i podsumowanie kolejnych stron dokumentu, od from do to (najwyżej ${MAX_PAGES_PER_CALL} stron na wywołanie).`,
    input: z.object({
      projectId,
      documentId,
      from: z.number().int().min(1).describe("Pierwsza strona"),
      to: z.number().int().min(1).describe("Ostatnia strona (włącznie)"),
    }),
    run: async (principal, { projectId, documentId, from, to }) => {
      await assertProject(principal, projectId);
      await assertDocument(projectId, documentId);
      const result = await readPages(projectId, documentId, from, Math.max(from, to));
      if (!result.pages.length) throw new ToolError(`Nie ma stron ${from}–${to} w tym dokumencie`);
      return text({ documentId, ...result });
    },
  }),
  get_page_image: tool({
    description: "Obraz strony projektu (rysunku) jako JPEG, żeby go obejrzeć: wymiary, oznaczenia, układ.",
    input: z.object({ projectId, documentId, pageNo: z.number().int().min(1).describe("Numer strony w PDF") }),
    run: async (principal, { projectId, documentId, pageNo }) => {
      await assertProject(principal, projectId);
      await assertDocument(projectId, documentId);
      const [page] = await sql<{ title: string | null }[]>`
        select title from pages where project_id = ${projectId} and document_id::text = ${documentId} and page_no = ${pageNo}`;
      if (!page) throw new ToolError(`Nie ma strony ${pageNo} w tym dokumencie`);
      const stored = await pageImage(documentId, pageNo);
      const file = await access(stored).then(
        () => stored,
        async () => pdfRenderPage(await documentPdf(documentId), pageNo, await pageImagePrefix(documentId, pageNo)),
      );
      const image = await sharp(file).resize(IMAGE_LONG_EDGE, IMAGE_LONG_EDGE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      return {
        content: [
          { type: "text", text: `Strona ${pageNo}${page.title ? `: ${page.title}` : ""}` },
          { type: "image", data: image.toString("base64"), mimeType: "image/jpeg" },
        ],
      };
    },
  }),
};

type ToolName = keyof typeof TOOLS;

export const toolList = () =>
  Object.entries(TOOLS).map(([name, definition]) => {
    const { $schema: _schema, ...inputSchema } = z.toJSONSchema(definition.input) as Record<string, unknown>;
    return { name, description: definition.description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } };
  });

const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });

const callTool = async (principal: Principal, params: Record<string, unknown> | undefined): Promise<ToolResult> => {
  const name = params?.name;
  if (typeof name !== "string" || !(name in TOOLS)) throw new RpcError(-32602, `Nieznane narzędzie: ${String(name)}`);
  const definition = TOOLS[name as ToolName] as Tool<z.ZodType>;
  const args = definition.input.safeParse(params?.arguments ?? {});
  if (!args.success) return { content: [{ type: "text", text: `Złe argumenty: ${z.prettifyError(args.error)}` }], isError: true };
  if (limiters.mcp.hit(principalKey(principal)) !== null) {
    return { content: [{ type: "text", text: "Za dużo wywołań, spróbuj za minutę." }], isError: true };
  }
  try {
    return await definition.run(principal, args.data);
  } catch (error) {
    if (error instanceof ToolError) return { content: [{ type: "text", text: error.message }], isError: true };
    throw error;
  }
};

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

// One JSON-RPC message; notifications (no id) get no answer.
const handle = async (principal: Principal, message: unknown) => {
  const request = message as Partial<JsonRpcRequest> | null;
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return rpcError(null, -32600, "Invalid Request");
  if (request.id === undefined) return null;
  const id = request.id;
  try {
    switch (request.method) {
      case "initialize": {
        const asked = request.params?.protocolVersion;
        const protocolVersion = typeof asked === "string" && SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
        return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: toolList() });
      case "tools/call":
        return rpcResult(id, await callTool(principal, request.params));
      default:
        return rpcError(id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    if (error instanceof RpcError) return rpcError(id, error.code, error.message);
    console.error("mcp: request failed", error);
    return rpcError(id, -32603, "Błąd serwera");
  }
};

export const mcp = new Hono();

const unauthorized = () =>
  new Response(JSON.stringify(rpcError(null, -32001, "Brak dostępu: podaj token w nagłówku Authorization albo w ?token=")), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="brygadzista"' },
  });

mcp.post("/mcp", async (c) => {
  const principal = await principalFromToken(bearerToken(c.req.header("authorization")) ?? c.req.query("token"));
  if (!principal) return unauthorized();
  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) return c.json(rpcError(null, -32700, "Parse error"), 400);
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map((message) => handle(principal, message)))).filter((answer) => answer !== null);
    return answers.length ? c.json(answers) : c.body(null, 202);
  }
  const answer = await handle(principal, body);
  return answer ? c.json(answer) : c.body(null, 202);
});

// No server-initiated stream and no sessions to end.
mcp.on(["GET", "DELETE"], "/mcp", (c) => c.body(null, 405, { allow: "POST" }));
