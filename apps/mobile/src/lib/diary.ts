// Daily site log (#69). The shape matches the server's diary-entry.ts.
export type DiaryReference = { documentId: string; pageNo: number; title: string | null; note: string };

export type DiaryEntry = {
  summary: string;
  work: string[];
  people: string[];
  deliveries: string[];
  weather: string | null;
  problems: string[];
  references: DiaryReference[];
};

export type DiaryStatus = "queued" | "processing" | "ready" | "error";

export type DiaryNote = {
  id: string;
  clientId: string | null;
  entryDate: string;
  source: "audio" | "text";
  transcript: string;
  entry: DiaryEntry | null;
  status: DiaryStatus;
  error: string | null;
  edited: boolean;
  authorName: string;
  createdAt: string;
  updatedAt: string;
};

export const isSorting = (note: DiaryNote) => note.status === "queued" || note.status === "processing";

const pad = (value: number) => String(value).padStart(2, "0");

// The phone's own calendar day, not UTC: a note recorded at 23:30 belongs to that evening.
export const localDate = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const shiftDate = (isoDate: string, days: number) => {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  return localDate(new Date(year, month - 1, day + days));
};

export const isIsoDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
};

const WEEKDAYS = ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"];

// "21.10.2026 (wtorek)"
export const formatDay = (isoDate: string) => {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(year, month - 1, day).getDay()];
  return `${pad(day)}.${pad(month)}.${year} (${weekday})`;
};

export const dayLabel = (isoDate: string, today = localDate()) => {
  if (isoDate === today) return `Dziś, ${formatDay(isoDate)}`;
  if (isoDate === shiftDate(today, -1)) return `Wczoraj, ${formatDay(isoDate)}`;
  return formatDay(isoDate);
};

// Notes of the same day stay together, newest day first, as the server returns them.
export const groupByDay = (notes: DiaryNote[]) => {
  const days: { date: string; notes: DiaryNote[] }[] = [];
  for (const note of notes) {
    const last = days[days.length - 1];
    if (last?.date === note.entryDate) last.notes.push(note);
    else days.push({ date: note.entryDate, notes: [note] });
  }
  return days;
};

// Lists are edited as text, one item per line.
export const linesToList = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/^\s*[-•*]\s*/, "").trim())
    .filter(Boolean);

export const listToLines = (items: string[]) => items.join("\n");

const section = (title: string, items: string[]) => (items.length ? [`${title}:`, ...items.map((item) => `- ${item}`)] : []);

// The text the site manager pastes into the Elektroniczny Dziennik Budowy (GUNB). There is no integration with EDB:
// the entry there is made, and signed, by a person with the right to make it.
export const edbDraft = (date: string, entries: DiaryEntry[]) => {
  const all = <K extends "work" | "people" | "deliveries" | "problems">(key: K) => entries.flatMap((entry) => entry[key]);
  const weather = entries.map((entry) => entry.weather).filter((value): value is string => Boolean(value));
  const references = [
    ...new Map(entries.flatMap((entry) => entry.references).map((ref) => [`${ref.documentId}:${ref.pageNo}`, ref])).values(),
  ];
  return [
    `Data: ${formatDay(date)}`,
    "",
    ...section("Wykonane roboty", all("work")),
    ...section("Zatrudnienie na budowie", all("people")),
    ...section("Dostawy materiałów", all("deliveries")),
    ...(weather.length ? [`Warunki atmosferyczne: ${weather.join("; ")}`] : []),
    ...section("Uwagi i problemy", all("problems")),
    ...section(
      "Dotyczy dokumentacji projektowej",
      references.map((ref) => `str. ${ref.pageNo}${ref.title ? ` – ${ref.title}` : ""}`),
    ),
  ]
    .join("\n")
    .trim();
};
