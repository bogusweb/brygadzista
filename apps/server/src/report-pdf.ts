import { stat } from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { config } from "./config.js";
import { pageImage, photoFile } from "./storage.js";

// What every PDF of the project shares (#74, #81, #84, #82): A4 with Polish fonts, page breaks, rows of images
// with captions, the spot on a drawing, and signature lines.

export const MARGIN = 40;

export const formatDay = (value: Date | string) =>
  new Date(value).toLocaleDateString("pl-PL", { timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", year: "numeric" });

const WEEKDAYS = ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"];

// A calendar day as stored (YYYY-MM-DD): "21.10.2026 (środa)".
export const formatIsoDay = (day: string) => {
  const [year, month, date] = day.split("-");
  return `${date}.${month}.${year} (${WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]})`;
};

export const exists = (file: string) => stat(file).then(() => true, () => false);

export type Pdf = ReturnType<typeof createPdf>;

export const createPdf = (title: string) => {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN, info: { Title: title, Author: "Brygadzista" } });
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
  const rule = () => {
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).strokeColor("#DDDDDD").stroke();
  };
  const finish = () => {
    doc.end();
    return done;
  };
  return { doc, width, bottom, ensureSpace, rule, finish };
};

export type CaptionedImage = { label: string; image: Buffer | string };

// Images side by side with a caption under each, wrapping to the next row and the next page.
export const imageRows = (pdf: Pdf, images: CaptionedImage[], height = 130) => {
  const { doc, width, bottom } = pdf;
  if (images.length === 0) return;
  const fit: [number, number] = [height * 1.35, height];
  pdf.ensureSpace(height + 16);
  let left = MARGIN;
  let top = doc.y;
  for (const { label, image } of images) {
    if (left + fit[0] > MARGIN + width) {
      left = MARGIN;
      top += height + 18;
      if (top + height + 16 > bottom()) {
        doc.addPage();
        top = doc.y;
      }
    }
    doc.image(image, left, top, { fit, align: "center", valign: "center" });
    doc.font("regular").fontSize(8).fillColor("#555555").text(label, left, top + height + 3, { width: fit[0], align: "center" });
    left += fit[0] + 8;
  }
  doc.x = MARGIN;
  doc.y = top + height + 18;
};

// Lines to sign by hand on the printout; a role with a saved signature gets the image above its line instead.
export const signatureLines = (pdf: Pdf, roles: { label: string; signature?: { image: Buffer; caption: string } | undefined }[]) => {
  const { doc, width } = pdf;
  pdf.ensureSpace(110);
  doc.moveDown(2);
  const top = doc.y;
  const column = (width - 40) / 2;
  for (const [i, role] of roles.entries()) {
    const x = MARGIN + (i % 2) * (column + 40);
    const y = top + Math.floor(i / 2) * 90;
    if (role.signature) doc.image(role.signature.image, x, y - 10, { fit: [column, 48] });
    doc.moveTo(x, y + 40).lineTo(x + column, y + 40).strokeColor("#999999").stroke();
    doc.font("regular").fontSize(10).fillColor("#333333").text(role.signature ? `${role.label}: ${role.signature.caption}` : `${role.label} (data i podpis)`, x, y + 46, { width: column });
  }
  doc.x = MARGIN;
};

// The part of the drawing around a spot, with a ring on it, so the reader sees where it is.
export const planCrop = async (documentId: string, pageNo: number, x: number, y: number) => {
  const file = await pageImage(documentId, pageNo);
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

export const photoThumb = async (projectId: string, photoId: string) => {
  const file = await photoFile(projectId, photoId, "thumb");
  return (await exists(file)) ? file : null;
};

// Bullet list under a bold heading; nothing when the list is empty.
export const bulletSection = (pdf: Pdf, title: string, items: string[]) => {
  if (items.length === 0) return;
  const { doc, width } = pdf;
  pdf.ensureSpace(40);
  doc.moveDown(0.4).font("bold").fontSize(11).fillColor("#111111").text(title);
  doc.font("regular").fontSize(10.5).fillColor("#222222");
  for (const item of items) doc.text(`•  ${item}`, MARGIN + 8, doc.y, { width: width - 8 });
  doc.x = MARGIN;
};
