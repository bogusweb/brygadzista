import { Hono } from "hono";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isUuid, requireDocumentAccess, requireProjectAccess, requireRole, requireRoleOrQueryToken, type AuthEnv } from "./auth.js";
import { sql } from "./db.js";
import { pdfPageSize, pdfRenderPage, pdfRenderRegion } from "./pdf.js";
import { documentDir, documentPdf, pageImage, pageImagePrefix } from "./storage.js";

// Questions to the designer (#73). When the project is silent or contradicts itself, the agent drafts a question with
// the page and a crop of the drawing; the contractor sends it from the phone (mail, WhatsApp, SMS; the app never
// sends anything itself) and writes the answer back here. Answered questions go into the agent's prompt.

export const QUESTION_STATUSES = ["open", "answered"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

// Part of the sheet as fractions of its width and height, so it does not depend on the image size.
export const regionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().gt(0).max(1),
    height: z.number().gt(0).max(1),
  })
  .refine((region) => region.x + region.width <= 1.0001 && region.y + region.height <= 1.0001, "Wycinek wychodzi poza arkusz");

export type Region = z.infer<typeof regionSchema>;

export type DesignerQuestion = {
  id: string;
  documentId: string | null;
  pageNo: number | null;
  pageTitle: string | null;
  region: Region | null;
  question: string;
  reason: string;
  status: QuestionStatus;
  answer: string | null;
  answeredAt: string | null;
  authorName: string;
  createdAt: string;
  updatedAt: string;
};

const columns = sql`q.id, q.document_id as "documentId", q.page_no as "pageNo", pg.title as "pageTitle", q.region, q.question,
  q.reason, q.status, q.answer, q.answered_at as "answeredAt", q.author_name as "authorName", q.created_at as "createdAt",
  q.updated_at as "updatedAt"`;

export const listQuestions = (projectId: string, status?: QuestionStatus) =>
  sql<DesignerQuestion[]>`
    select ${columns} from designer_questions q
      left join pages pg on pg.document_id = q.document_id and pg.page_no = q.page_no
    where q.project_id = ${projectId} ${status ? sql`and q.status = ${status}` : sql``}
    order by q.created_at desc`;

const questionById = async (projectId: string, id: string) => {
  const [question] = await sql<DesignerQuestion[]>`
    select ${columns} from designer_questions q
      left join pages pg on pg.document_id = q.document_id and pg.page_no = q.page_no
    where q.project_id = ${projectId} and q.id = ${id}`;
  return question;
};

const MAX_ANSWERS_IN_PROMPT = 30;
const ANSWER_CHARS = 600;

// Answers the designer gave, for the agent's prompt: they settle what the project left open, so they come first.
export const designerAnswersPrompt = async (projectId: string) => {
  const answered = await sql<{ question: string; answer: string; pageNo: number | null; answeredAt: Date }[]>`
    select question, answer, page_no as "pageNo", answered_at as "answeredAt" from designer_questions
    where project_id = ${projectId} and status = 'answered' and answer is not null
    order by answered_at desc limit ${MAX_ANSWERS_IN_PROMPT}`;
  if (!answered.length) return "";
  const lines = answered.map(
    (row) =>
      `- ${row.pageNo ? `[str. ${row.pageNo}] ` : ""}Pytanie: ${row.question.slice(0, ANSWER_CHARS)}\n  Odpowiedź projektanta ` +
      `(${row.answeredAt.toISOString().slice(0, 10)}): ${row.answer.slice(0, ANSWER_CHARS)}`,
  );
  return `

Odpowiedzi projektanta na wcześniejsze pytania wykonawcy. Rozstrzygają to, czego projekt nie określał albo w czym był
sprzeczny; gdy pytanie dotyczy tych miejsc, odpowiadaj zgodnie z nimi i napisz, że to ustalenie z projektantem (z datą):
${lines.join("\n")}`;
};

export const cropPath = (documentId: string, pageNo: number, region: Region | null) => {
  const base = `/api/documents/${documentId}/pages/${pageNo}/crop`;
  if (!region) return base;
  const query = new URLSearchParams({
    x: region.x.toFixed(4),
    y: region.y.toFixed(4),
    w: region.width.toFixed(4),
    h: region.height.toFixed(4),
  });
  return `${base}?${query}`;
};

const POINTS_PER_INCH = 72;
const CROP_LONG_EDGE_PX = 1600;
const MAX_CROP_DPI = 300;

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

// A crop is rendered from the PDF at a resolution that keeps small dimensions legible, then cached.
export const renderCrop = async (documentId: string, pageNo: number, region: Region | null) => {
  const pdf = await documentPdf(documentId);
  if (!region) {
    const image = await pageImage(documentId, pageNo);
    return (await exists(image)) ? image : pdfRenderPage(pdf, pageNo, await pageImagePrefix(documentId, pageNo));
  }
  const key = [region.x, region.y, region.width, region.height].map((value) => value.toFixed(4)).join("_");
  const prefix = path.join(await documentDir(documentId), "crops", `page-${pageNo}-${key}`);
  if (await exists(`${prefix}.jpg`)) return `${prefix}.jpg`;
  const size = await pdfPageSize(pdf, pageNo);
  const longEdgeInches = Math.max(region.width * size.width, region.height * size.height) / POINTS_PER_INCH;
  const dpi = Math.max(72, Math.min(MAX_CROP_DPI, Math.round(CROP_LONG_EDGE_PX / longEdgeInches)));
  const scale = dpi / POINTS_PER_INCH;
  await mkdir(path.dirname(prefix), { recursive: true });
  return pdfRenderRegion(pdf, pageNo, prefix, {
    dpi,
    x: Math.round(region.x * size.width * scale),
    y: Math.round(region.y * size.height * scale),
    width: Math.max(1, Math.round(region.width * size.width * scale)),
    height: Math.max(1, Math.round(region.height * size.height * scale)),
  });
};

const MAX_TEXT = 4000;

const createBody = z.object({
  documentId: z.string().refine(isUuid).optional(),
  pageNo: z.number().int().min(1).optional(),
  region: regionSchema.nullable().optional(),
  question: z.string().trim().min(1).max(MAX_TEXT),
  reason: z.string().trim().max(MAX_TEXT).optional(),
});

const updateBody = z.object({
  question: z.string().trim().min(1).max(MAX_TEXT).optional(),
  answer: z.string().trim().max(MAX_TEXT).nullable().optional(),
});

const parseRegion = (query: Record<string, string>) => {
  if (query.x === undefined) return { region: null };
  const parsed = regionSchema.safeParse({ x: Number(query.x), y: Number(query.y), width: Number(query.w), height: Number(query.h) });
  return parsed.success ? { region: parsed.data } : { error: "Zły wycinek strony" };
};

export const questions = new Hono<AuthEnv>();

questions.get("/api/projects/:id/questions", requireRole("app", "admin"), requireProjectAccess(), async (c) => {
  const status = c.req.query("status");
  if (status && !QUESTION_STATUSES.includes(status as QuestionStatus)) return c.json({ error: "Nieznany status" }, 400);
  return c.json(await listQuestions(c.req.param("id"), status as QuestionStatus | undefined));
});

questions.post("/api/projects/:id/questions", requireRole("app", "admin"), requireProjectAccess(), async (c) => {
  const projectId = c.req.param("id");
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Wpisz treść pytania" }, 400);
  const { documentId, pageNo, region, question, reason } = parsed.data;
  if (documentId) {
    const [page] = await sql`select 1 from pages where project_id = ${projectId} and document_id = ${documentId} and page_no = ${pageNo ?? 1}`;
    if (!page) return c.json({ error: "Nie ma takiej strony w projekcie" }, 400);
  }
  const { user } = c.get("principal");
  const [row] = await sql<{ id: string }[]>`
    insert into designer_questions (project_id, document_id, page_no, region, question, reason, created_by, author_name)
    values (${projectId}, ${documentId ?? null}, ${documentId ? (pageNo ?? 1) : null}, ${region ? sql.json(region) : null},
      ${question}, ${reason ?? ""}, ${user?.id ?? null}, ${user ? user.name || user.email : ""})
    returning id`;
  return c.json(await questionById(projectId, row!.id), 201);
});

// An answer marks the question answered; clearing it opens the question again.
questions.patch("/api/projects/:id/questions/:questionId", requireRole("app", "admin"), requireProjectAccess(), async (c) => {
  const projectId = c.req.param("id");
  const questionId = c.req.param("questionId");
  if (!isUuid(questionId)) return c.json({ error: "Nie ma takiego pytania" }, 404);
  const parsed = updateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Złe dane pytania" }, 400);
  const { question, answer } = parsed.data;
  const answerChange =
    answer === undefined
      ? sql``
      : answer
        ? sql`, answer = ${answer}, status = 'answered', answered_at = coalesce(answered_at, now())`
        : sql`, answer = null, status = 'open', answered_at = null`;
  const [row] = await sql`
    update designer_questions set updated_at = now() ${question ? sql`, question = ${question}` : sql``} ${answerChange}
    where project_id = ${projectId} and id = ${questionId} returning id`;
  if (!row) return c.json({ error: "Nie ma takiego pytania" }, 404);
  return c.json(await questionById(projectId, questionId));
});

questions.delete("/api/projects/:id/questions/:questionId", requireRole("app", "admin"), requireProjectAccess(), async (c) => {
  const questionId = c.req.param("questionId");
  if (!isUuid(questionId)) return c.json({ error: "Nie ma takiego pytania" }, 404);
  const [row] = await sql`delete from designer_questions where project_id = ${c.req.param("id")} and id = ${questionId} returning id`;
  return row ? c.body(null, 204) : c.json({ error: "Nie ma takiego pytania" }, 404);
});

// The crop that goes along with a question; ?token= lets the phone download it for sharing.
questions.get("/api/documents/:id/pages/:pageNo/crop", requireRoleOrQueryToken("app", "admin"), requireDocumentAccess(), async (c) => {
  const documentId = c.req.param("id");
  const pageNo = Number(c.req.param("pageNo"));
  const parsed = parseRegion(c.req.query());
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const [page] = await sql`select 1 from pages where document_id = ${documentId} and page_no = ${pageNo}`;
  if (!Number.isInteger(pageNo) || !page) return c.json({ error: "Nie ma takiej strony" }, 404);
  const file = await renderCrop(documentId, pageNo, parsed.region);
  return c.body(new Uint8Array(await readFile(file)), 200, {
    "content-type": "image/jpeg",
    "cache-control": "private, max-age=86400",
  });
});
