// Defects and fixes on the drawings (#74): filtering, deadlines and the protocol query. Pure logic, tested without React Native.
import type { DefectStatus, Pin } from "./pins";

export const STATUS_LABELS: Record<DefectStatus, string> = { open: "Otwarta", to_check: "Do sprawdzenia", closed: "Zamknięta" };

export const STATUS_COLORS: Record<DefectStatus, string> = { open: "#C0392B", to_check: "#B7791F", closed: "#2F7D4A" };

export const DEFECT_STATUSES: DefectStatus[] = ["open", "to_check", "closed"];

// "Active" is what a walk round the site is about: open and waiting for a check.
export type StatusFilter = DefectStatus | "active" | "all";

export type DefectFilter = { status: StatusFilter; assignee: string | null; page: string | null };

export const emptyFilter: DefectFilter = { status: "active", assignee: null, page: null };

type DefectLike = Pick<Pin, "kind" | "status" | "assignee" | "documentId" | "pageNo" | "pageTitle" | "createdAt" | "dueDate">;

// One drawing usually is one floor, so the page stands in for the floor ("kondygnacja").
export const pageKey = (pin: Pick<Pin, "documentId" | "pageNo">) => `${pin.documentId}:${pin.pageNo}`;

export const pageLabel = (pin: Pick<Pin, "pageNo" | "pageTitle">) => pin.pageTitle || `Strona ${pin.pageNo}`;

export const sameAssignee = (a: string, b: string) => a.trim().toLocaleLowerCase("pl") === b.trim().toLocaleLowerCase("pl");

const statusMatches = (status: DefectStatus | null, filter: StatusFilter) =>
  filter === "all" || (filter === "active" ? status !== "closed" : status === filter);

// The defects in the order of the drawings, oldest first on each, so the list follows a walk through the building.
export const filterDefects = <T extends DefectLike>(pins: T[], filter: DefectFilter) =>
  pins
    .filter((pin) => pin.kind === "defect")
    .filter((pin) => statusMatches(pin.status, filter.status))
    .filter((pin) => filter.assignee === null || sameAssignee(pin.assignee, filter.assignee))
    .filter((pin) => filter.page === null || pageKey(pin) === filter.page)
    .sort((a, b) => a.documentId.localeCompare(b.documentId) || a.pageNo - b.pageNo || a.createdAt.localeCompare(b.createdAt));

// People named on defects, each once whatever the spelling of capitals, for picking instead of typing.
export const assigneesOf = (pins: DefectLike[]) => {
  const names = new Map<string, string>();
  for (const pin of pins) {
    const name = pin.assignee.trim();
    if (pin.kind === "defect" && name && !names.has(name.toLocaleLowerCase("pl"))) names.set(name.toLocaleLowerCase("pl"), name);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b, "pl"));
};

export const pagesOf = (pins: DefectLike[]) => {
  const pages = new Map<string, { key: string; label: string; documentId: string; pageNo: number; count: number }>();
  for (const pin of pins.filter((candidate) => candidate.kind === "defect")) {
    const key = pageKey(pin);
    const page = pages.get(key) ?? { key, label: pageLabel(pin), documentId: pin.documentId, pageNo: pin.pageNo, count: 0 };
    page.count += 1;
    pages.set(key, page);
  }
  return [...pages.values()].sort((a, b) => a.documentId.localeCompare(b.documentId) || a.pageNo - b.pageNo);
};

const pad = (value: number) => String(value).padStart(2, "0");

// A day as the server stores it (YYYY-MM-DD), in the phone's own calendar.
export const toDay = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const daysFrom = (today: Date, days: number) => {
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  return toDay(date);
};

// "30.10" this year, "30.10.2027" otherwise.
export const formatDay = (day: string, today = new Date()) => {
  const [year, month, date] = day.split("-");
  return `${date}.${month}${Number(year) === today.getFullYear() ? "" : `.${year}`}`;
};

export const isOverdue = (pin: Pick<Pin, "status" | "dueDate">, today = new Date()) =>
  pin.status !== "closed" && pin.dueDate !== null && pin.dueDate < toDay(today);

// Accepts what people type on site: 30.10, 30.10.2026 or 2026-10-30. Null when it is not a date.
export const parseDay = (text: string, today = new Date()): string | null => {
  const value = text.trim();
  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const polish = value.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\.?$/);
  const [year, month, day] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : polish
      ? [Number(polish[3] ?? today.getFullYear()), Number(polish[2]), Number(polish[1])]
      : [0, 0, 0];
  if (!year) return null;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? toDay(date) : null;
};

// The protocol is filtered like the list on screen.
export const protocolQuery = (filter: DefectFilter) => {
  const params: string[] = [];
  if (filter.status !== "all") params.push(`status=${filter.status === "active" ? "open,to_check" : filter.status}`);
  if (filter.assignee !== null) params.push(`assignee=${encodeURIComponent(filter.assignee)}`);
  if (filter.page !== null) {
    const [documentId, pageNo] = filter.page.split(":");
    params.push(`documentId=${documentId}`, `pageNo=${pageNo}`);
  }
  return params.join("&");
};
