import { Hono } from "hono";
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
import { MARGIN, createPdf, formatDay, imageRows, photoThumb, planCrop, signatureLines, type Pdf } from "./report-pdf.js";

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

const COLORS: Record<DefectStatus, string> = { open: "#C0392B", to_check: "#B7791F", closed: "#2F7D4A" };

export const describeFilter = (filter: DefectFilter, found: Defect[]) => {
  const parts = [
    filter.statuses?.length ? `status: ${filter.statuses.map((status) => STATUS_LABELS[status].toLowerCase()).join(", ")}` : "",
    filter.assignee?.trim() ? `odpowiedzialny: ${filter.assignee.trim()}` : "",
    filter.pageNo ? `strona: ${found[0]?.pageTitle ?? filter.pageNo}` : "",
  ].filter(Boolean);
  return parts.length ? `Zakres: ${parts.join(" · ")}` : "Zakres: wszystkie usterki";
};

// One defect: title with status, who and when, the description, what the project says, the spot and the photos.
export const defectBlock = async (pdf: Pdf, projectId: string, defect: Defect, index: number) => {
  const { doc, width } = pdf;
  const status = defect.status ?? "open";
  pdf.ensureSpace(120);
  pdf.rule();
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
        image: await photoThumb(projectId, photo.id),
      })),
    )),
  ].flatMap(({ label, image }) => (image === null ? [] : [{ label, image }]));
  doc.moveDown(0.5);
  imageRows(pdf, images);
  doc.moveDown(0.5);
};

export type ProtocolSignature = { role: "contractor" | "investor"; name: string; signedAt: Date; image: Buffer };

export type ProtocolOptions = {
  heading: string;
  scope: string;
  asOf: Date;
  link?: { url: string; qr: Buffer } | undefined;
  signatures?: ProtocolSignature[] | undefined;
};

const SIGNATURE_ROLES = [
  { role: "contractor", label: "Wykonawca" },
  { role: "investor", label: "Inwestor" },
] as const;

const signedAt = (value: Date) =>
  `${formatDay(value)} ${value.toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit" })}`;

// The acceptance protocol: defects with the spot on the drawing and the photos, then the signatures. A saved protocol
// (#82) adds a QR code to its online version and the signatures made with a finger in the app.
export const protocolDocument = async (projectId: string, projectName: string, found: Defect[], options: ProtocolOptions) => {
  const pdf = createPdf(`${options.heading} – ${projectName}`);
  const { doc, width } = pdf;
  if (options.link) {
    doc.image(options.link.qr, MARGIN + width - 80, MARGIN, { fit: [80, 80] });
    doc.font("regular").fontSize(7.5).fillColor("#666666").text("Wersja online", MARGIN + width - 80, MARGIN + 82, { width: 80, align: "center" });
    doc.x = MARGIN;
    doc.y = MARGIN;
  }
  const textWidth = options.link ? width - 96 : width;
  doc.font("bold").fontSize(18).fillColor("#111111").text(options.heading, { width: textWidth });
  doc.font("regular").fontSize(11).fillColor("#333333").text(projectName || "Projekt", { width: textWidth });
  doc.text(`Stan na ${formatDay(options.asOf)}. ${options.scope}`, { width: textWidth });
  const counts = DEFECT_STATUSES.map((status) => `${STATUS_LABELS[status]}: ${found.filter((defect) => defect.status === status).length}`);
  doc.text(`Usterek: ${found.length} (${counts.join(", ")})`, { width: textWidth });
  if (options.link) doc.y = Math.max(doc.y, MARGIN + 100);
  doc.moveDown();
  if (found.length === 0) doc.text("Brak usterek w tym zakresie.");
  for (const [index, defect] of found.entries()) await defectBlock(pdf, projectId, defect, index);
  signatureLines(
    pdf,
    SIGNATURE_ROLES.map(({ role, label }) => {
      const signature = options.signatures?.find((candidate) => candidate.role === role);
      return { label, signature: signature && { image: signature.image, caption: `${signature.name}, ${signedAt(signature.signedAt)}` } };
    }),
  );
  if (options.link) {
    doc.moveDown(2).font("regular").fontSize(8.5).fillColor("#666666").text(`Wersja online: ${options.link.url}`, MARGIN, doc.y, { width, link: options.link.url });
  }
  return pdf.finish();
};

const protocolPdf = (projectId: string, projectName: string, found: Defect[], filter: DefectFilter) =>
  protocolDocument(projectId, projectName, found, { heading: "Protokół odbioru – lista usterek", scope: describeFilter(filter, found), asOf: new Date() });
