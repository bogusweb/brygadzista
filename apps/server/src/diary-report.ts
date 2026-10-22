import type { DiaryEntry } from "./diary-entry.js";
import { MARGIN, bulletSection, createPdf, formatIsoDay, imageRows, photoThumb, signatureLines, type Pdf } from "./report-pdf.js";
import { describeWeather, type SiteWeather } from "./weather.js";

// The daily log as a PDF (#81): one section per day with the measured weather, the headcount, the work, deliveries
// and problems from every note of that day, and the photos taken on site that day.

export type DiaryDayPhoto = { id: string; takenAt: Date; caption: string };

export type DiaryDay = {
  date: string;
  weather: SiteWeather | null;
  entries: { entry: DiaryEntry; authorName: string }[];
  photos: DiaryDayPhoto[];
};

export type DiaryReportInput = {
  projectId: string;
  projectName: string;
  siteAddress: string | null;
  from: string;
  to: string;
  days: DiaryDay[];
};

const time = (value: Date) => value.toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit" });

// The same team named in two notes of one day ("zbrojarze" in the morning and again after lunch) counts once, with the
// higher number: two notes about the same people must not double them.
export const dayCrew = (entries: DiaryEntry[]) => {
  const teams = new Map<string, { team: string; company: string | null; count: number }>();
  for (const member of entries.flatMap((entry) => entry.crew ?? [])) {
    const key = `${member.team.trim().toLocaleLowerCase("pl")}|${(member.company ?? "").trim().toLocaleLowerCase("pl")}`;
    const known = teams.get(key);
    if (!known || known.count < member.count) teams.set(key, { ...member });
  }
  return [...teams.values()];
};

const crewTable = (pdf: Pdf, crew: ReturnType<typeof dayCrew>) => {
  if (crew.length === 0) return;
  const { doc, width } = pdf;
  pdf.ensureSpace(30 + crew.length * 15);
  doc.moveDown(0.4).font("bold").fontSize(11).fillColor("#111111").text("Obsada");
  doc.font("regular").fontSize(10.5).fillColor("#222222");
  for (const member of crew) {
    const top = doc.y;
    doc.text(member.company ? `${member.team} (${member.company})` : member.team, MARGIN + 8, top, { width: width - 80 });
    doc.text(String(member.count), MARGIN + width - 60, top, { width: 60, align: "right" });
  }
  const total = crew.reduce((sum, member) => sum + member.count, 0);
  const top = doc.y;
  doc.font("bold").text("Razem", MARGIN + 8, top, { width: width - 80 });
  doc.text(String(total), MARGIN + width - 60, top, { width: 60, align: "right" });
  doc.x = MARGIN;
};

const daySection = async (pdf: Pdf, projectId: string, day: DiaryDay) => {
  const { doc, width } = pdf;
  const entries = day.entries.map(({ entry }) => entry);
  pdf.ensureSpace(90);
  pdf.rule();
  doc.moveDown(0.5);
  doc.font("bold").fontSize(14).fillColor("#111111").text(formatIsoDay(day.date));
  const authors = [...new Set(day.entries.map(({ authorName }) => authorName).filter(Boolean))];
  if (authors.length) doc.font("regular").fontSize(9.5).fillColor("#666666").text(`Wpisy: ${authors.join(", ")}`);
  doc.font("regular").fontSize(10.5).fillColor("#1F4E79").text(`Pogoda: ${day.weather ? describeWeather(day.weather) : "brak danych"}`, { width });
  const said = entries.map((entry) => entry.weather).filter((value): value is string => Boolean(value));
  if (said.length) doc.fillColor("#333333").text(`Z notatek: ${said.join("; ")}`, { width });

  crewTable(pdf, dayCrew(entries));
  // People named without a number stay as the note said them, so nothing from the site gets lost.
  const people = dayCrew(entries).length ? [] : entries.flatMap((entry) => entry.people);
  bulletSection(pdf, "Ludzie na budowie", people);
  bulletSection(pdf, "Wykonane roboty", entries.flatMap((entry) => entry.work));
  bulletSection(pdf, "Dostawy materiałów", entries.flatMap((entry) => entry.deliveries));
  bulletSection(pdf, "Uwagi i problemy", entries.flatMap((entry) => entry.problems));
  const references = [
    ...new Map(entries.flatMap((entry) => entry.references).map((ref) => [`${ref.documentId}:${ref.pageNo}`, ref])).values(),
  ];
  bulletSection(pdf, "Dotyczy dokumentacji projektowej", references.map((ref) => `str. ${ref.pageNo}${ref.title ? ` – ${ref.title}` : ""}`));

  const photos = (
    await Promise.all(day.photos.map(async (photo) => ({ label: `${time(photo.takenAt)} · ${photo.caption}`.slice(0, 60), image: await photoThumb(projectId, photo.id) })))
  ).flatMap(({ label, image }) => (image ? [{ label, image }] : []));
  if (photos.length) {
    pdf.ensureSpace(40);
    doc.moveDown(0.4).font("bold").fontSize(11).fillColor("#111111").text("Zdjęcia z budowy");
    doc.moveDown(0.3);
    imageRows(pdf, photos, 110);
  }
  doc.moveDown(0.6);
};

export const diaryReportPdf = async ({ projectId, projectName, siteAddress, from, to, days }: DiaryReportInput) => {
  const pdf = createPdf(`Dziennik budowy – ${projectName}`);
  const { doc } = pdf;
  doc.font("bold").fontSize(18).fillColor("#111111").text("Dziennik budowy");
  doc.font("regular").fontSize(11).fillColor("#333333").text(projectName || "Projekt");
  if (siteAddress) doc.text(siteAddress);
  doc.text(from === to ? `Dzień: ${formatIsoDay(from)}` : `Okres: ${formatIsoDay(from)} – ${formatIsoDay(to)}`);
  doc.moveDown();
  if (days.length === 0) doc.text("Brak wpisów w tym okresie.");
  for (const day of days) await daySection(pdf, projectId, day);
  signatureLines(pdf, [{ label: "Kierownik budowy" }]);
  return pdf.finish();
};
