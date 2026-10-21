import { Hono } from "hono";
import { stat } from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { isUuid, requireProjectAccess, requireRole, requireRoleOrQueryToken, type AuthEnv } from "./auth.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { audioType } from "./diary-entry.js";
import { transcribeAudio } from "./diary-llm.js";
import { readLimited } from "./diary.js";
import { DEFECT_STATUSES, pinColumns, pinPhotosJson, type DefectStatus, type Pin } from "./pins.js";
import { limiters, rateLimit } from "./rate-limit.js";
import { statusOf } from "./retry.js";
import { queryTerms } from "./search.js";
import { pageImage, photoFile } from "./storage.js";

// Defects and fixes pinned to the drawings (#74): a filtered list for the agent and the acceptance protocol as a PDF,
// plus speech to text for reporting a defect by voice.

export const STATUS_LABELS: Record<DefectStatus, string> = { open: "Otwarta", to_check: "Do sprawdzenia", closed: "Zamknięta" };

export type DefectFilter = {
  statuses?: DefectStatus[] | undefined;
  assignee?: string | undefined;
  documentId?: string | undefined;
  pageNo?: number | undefined;
  query?: string | undefined;
};

export type Defect = Pin & { pageTitle: string | null };

// In the order of the drawings, so a walk through the building follows the list.
export const listDefects = async (projectId: string, { statuses, assignee, documentId, pageNo, query = "" }: DefectFilter) => {
  const terms = queryTerms(query);
  const filters = [
    sql`p.project_id = ${projectId}`,
    sql`p.kind = 'defect'`,
    statuses?.length ? sql`p.status in ${sql(statuses)}` : null,
    assignee?.trim() ? sql`lower(p.assignee) = ${assignee.trim().toLowerCase()}` : null,
    documentId && isUuid(documentId) ? sql`p.document_id = ${documentId}` : null,
    pageNo ? sql`p.page_no = ${pageNo}` : null,
    terms.length
      ? sql`to_tsvector('simple', p.note || ' ' || p.room || ' ' || p.assignee || ' ' || coalesce(pg.title, '')) @@ to_tsquery('simple', ${terms.join(" | ")})`
      : null,
  ].filter((filter) => filter !== null);
  const where = filters.reduce((all, filter) => sql`${all} and ${filter}`);
  return sql<Defect[]>`
    select ${pinColumns}, pg.title as "pageTitle", ${pinPhotosJson} as photos
    from pins p join documents d on d.id = p.document_id
      left join pages pg on pg.document_id = p.document_id and pg.page_no = p.page_no
    where ${where}
    order by d.created_at, p.page_no, p.created_at`;
};

export const parseStatuses = (value: string | undefined) =>
  (value ?? "").split(",").filter((status): status is DefectStatus => DEFECT_STATUSES.includes(status as DefectStatus));

export const defects = new Hono<AuthEnv>();

// A spoken defect becomes the text of its description; the phone puts it in the field to check before saving.
defects.post("/api/projects/:id/transcribe", requireRole("app", "admin"), requireProjectAccess(), rateLimit(limiters.diary), async (c) => {
  const type = audioType(c.req.header("content-type"));
  if (!type) return c.json({ error: "Nieobsługiwany format nagrania. Wpisz opis ręcznie." }, 415);
  const body = c.req.raw.body;
  const audio = body ? await readLimited(body, config.diaryMaxAudioBytes) : null;
  if (!audio) return c.json({ error: "Nagranie jest za długie albo puste" }, 413);
  if (audio.length === 0) return c.json({ error: "Brak nagrania" }, 400);
  if (config.fakeAgent) return c.json({ text: "Parapet okna w salonie osadzony za nisko, około 80 cm od podłogi." });
  if (!config.openrouterApiKey) return c.json({ error: "Serwer nie ma klucza OpenRouter, więc nie przepisze nagrania." }, 503);
  try {
    const text = await transcribeAudio(
      new Uint8Array(audio),
      type.mediaType,
      "To nagranie wykonawcy z budowy: opis usterki albo poprawki do zrobienia.",
    );
    return c.json({ text });
  } catch (error) {
    const status = statusOf(error);
    console.error("defects: transcription failed", error);
    return c.json({ error: status === 402 || status === 429 ? "Model jest chwilowo niedostępny. Wpisz opis ręcznie." : "Nie udało się przepisać nagrania." }, 502);
  }
});

// The protocol for the investor, filtered like the list in the app. ?token= works too, so the phone can open it in a browser.
defects.get("/api/projects/:id/defects/protocol.pdf", requireRoleOrQueryToken("app", "admin"), requireProjectAccess(), async (c) => {
  const projectId = c.req.param("id");
  const pageNo = Number(c.req.query("pageNo"));
  const filter: DefectFilter = {
    statuses: parseStatuses(c.req.query("status")),
    assignee: c.req.query("assignee"),
    documentId: c.req.query("documentId"),
    pageNo: Number.isInteger(pageNo) && pageNo > 0 ? pageNo : undefined,
  };
  const [project] = await sql<{ name: string }[]>`select name from projects where id = ${projectId}`;
  const found = await listDefects(projectId, filter);
  const pdf = await protocolPdf(projectId, project?.name ?? "", found, filter);
  const day = new Date().toISOString().slice(0, 10);
  c.header("Content-Type", "application/pdf");
  c.header("Content-Disposition", `inline; filename="protokol-usterek-${day}.pdf"`);
  c.header("Cache-Control", "no-store");
  return c.body(new Uint8Array(pdf));
});

// --- The protocol PDF ---

const MARGIN = 40;
const IMAGE_HEIGHT = 130;
const COLORS: Record<DefectStatus, string> = { open: "#C0392B", to_check: "#B7791F", closed: "#2F7D4A" };

const formatDay = (value: Date | string) =>
  new Date(value).toLocaleDateString("pl-PL", { timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", year: "numeric" });

const exists = (file: string) => stat(file).then(() => true, () => false);

// The part of the drawing around the defect, with a ring on the spot, so the investor sees where it is.
export const planCrop = async (documentId: string, pageNo: number, x: number, y: number) => {
  const file = pageImage(documentId, pageNo);
  if (!(await exists(file))) return null;
  const { width = 0, height = 0 } = await sharp(file).metadata();
  if (!width || !height) return null;
  const side = Math.round(Math.min(width, height) * 0.35);
  const left = Math.min(Math.max(Math.round(x * width - side / 2), 0), Math.max(width - side, 0));
  const top = Math.min(Math.max(Math.round(y * height - side / 2), 0), Math.max(height - side, 0));
  const crop = { left, top, width: Math.min(side, width), height: Math.min(side, height) };
  const ring = Math.max(Math.round(crop.width * 0.06), 8);
  const marker = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${crop.width}" height="${crop.height}">` +
      `<circle cx="${x * width - left}" cy="${y * height - top}" r="${ring}" fill="none" stroke="#E0301E" stroke-width="${Math.max(ring / 3, 3)}"/></svg>`,
  );
  return sharp(file).extract(crop).composite([{ input: marker }]).resize({ width: 400 }).jpeg({ quality: 70 }).toBuffer();
};

const photoImage = async (projectId: string, photoId: string) => {
  const file = photoFile(projectId, photoId, "thumb");
  return (await exists(file)) ? file : null;
};

const describeFilter = (filter: DefectFilter, found: Defect[]) => {
  const parts = [
    filter.statuses?.length ? `status: ${filter.statuses.map((status) => STATUS_LABELS[status].toLowerCase()).join(", ")}` : "",
    filter.assignee?.trim() ? `odpowiedzialny: ${filter.assignee.trim()}` : "",
    filter.pageNo ? `strona: ${found[0]?.pageTitle ?? filter.pageNo}` : "",
  ].filter(Boolean);
  return parts.length ? `Zakres: ${parts.join(" · ")}` : "Zakres: wszystkie usterki";
};

const protocolPdf = async (projectId: string, projectName: string, found: Defect[], filter: DefectFilter) => {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN, info: { Title: `Protokół odbioru – ${projectName}`, Author: "Brygadzista" } });
  doc.registerFont("regular", path.join(config.pdfFontDir, "DejaVuSans.ttf"));
  doc.registerFont("bold", path.join(config.pdfFontDir, "DejaVuSans-Bold.ttf"));
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const width = doc.page.width - MARGIN * 2;
  const bottom = () => doc.page.height - MARGIN;
  const ensureSpace = (height: number) => {
    if (doc.y + height > bottom()) doc.addPage();
  };

  doc.font("bold").fontSize(18).text("Protokół odbioru – lista usterek");
  doc.font("regular").fontSize(11).fillColor("#333333").text(projectName || "Projekt");
  doc.text(`Stan na ${formatDay(new Date())}. ${describeFilter(filter, found)}`);
  const counts = DEFECT_STATUSES.map((status) => `${STATUS_LABELS[status]}: ${found.filter((defect) => defect.status === status).length}`);
  doc.text(`Usterek: ${found.length} (${counts.join(", ")})`);
  doc.moveDown();
  if (found.length === 0) doc.text("Brak usterek w tym zakresie.");

  for (const [index, defect] of found.entries()) {
    const status = defect.status ?? "open";
    ensureSpace(120);
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).strokeColor("#DDDDDD").stroke();
    doc.moveDown(0.5);
    doc.font("bold").fontSize(13).fillColor("#111111").text(`${index + 1}. ${defect.room || defect.pageTitle || `Strona ${defect.pageNo}`}  `, { continued: true });
    doc.fillColor(COLORS[status]).text(STATUS_LABELS[status]);
    const meta = [
      `${defect.pageTitle ?? "Strona"} (str. ${defect.pageNo})`,
      defect.assignee ? `Odpowiedzialny: ${defect.assignee}` : "Odpowiedzialny: nie wskazano",
      defect.dueDate ? `Termin: ${formatDay(defect.dueDate)}` : "",
      `Zgłoszono ${formatDay(defect.createdAt)}${defect.authorName ? ` (${defect.authorName})` : ""}`,
    ].filter(Boolean);
    doc.font("regular").fontSize(10).fillColor("#555555").text(meta.join(" · "), { width });
    if (defect.note) doc.moveDown(0.3).fontSize(11).fillColor("#111111").text(defect.note, { width });
    if (defect.spec?.found) {
      doc.moveDown(0.3).font("bold").fontSize(10).fillColor("#1F4E79").text("W projekcie: ", { continued: true });
      doc.font("regular").text(`${defect.spec.statement} – „${defect.spec.quote}”${defect.spec.source ? ` (str. ${defect.spec.source.pageNo})` : ""}`, { width });
    }

    const images = [
      { label: "Miejsce na rzucie", image: await planCrop(defect.documentId, defect.pageNo, defect.x, defect.y) },
      ...(await Promise.all(
        defect.photos.map(async (photo) => ({
          label: `${photo.stage === "after" ? "Po" : "Przed"} · ${formatDay(photo.takenAt)}`,
          image: await photoImage(projectId, photo.id),
        })),
      )),
    ].flatMap(({ label, image }) => (image === null ? [] : [{ label, image }]));
    let left = MARGIN;
    doc.moveDown(0.5);
    if (images.length) ensureSpace(IMAGE_HEIGHT + 16);
    let top = doc.y;
    for (const { label, image } of images) {
      const fit: [number, number] = [IMAGE_HEIGHT * 1.35, IMAGE_HEIGHT];
      if (left + fit[0] > MARGIN + width) {
        left = MARGIN;
        top += IMAGE_HEIGHT + 18;
        if (top + IMAGE_HEIGHT + 16 > bottom()) {
          doc.addPage();
          top = doc.y;
        }
      }
      doc.image(image, left, top, { fit, align: "center", valign: "center" });
      doc.font("regular").fontSize(8).fillColor("#555555").text(label, left, top + IMAGE_HEIGHT + 3, { width: fit[0], align: "center" });
      left += fit[0] + 8;
    }
    doc.x = MARGIN;
    doc.y = images.length ? top + IMAGE_HEIGHT + 18 : doc.y;
    doc.moveDown(0.5);
  }

  ensureSpace(110);
  doc.moveDown(2);
  const signatureTop = doc.y;
  const column = (width - 40) / 2;
  for (const [i, role] of ["Wykonawca", "Inwestor"].entries()) {
    const x = MARGIN + i * (column + 40);
    doc.moveTo(x, signatureTop + 40).lineTo(x + column, signatureTop + 40).strokeColor("#999999").stroke();
    doc.font("regular").fontSize(10).fillColor("#333333").text(`${role} (data i podpis)`, x, signatureTop + 46, { width: column });
  }
  doc.end();
  return done;
};
