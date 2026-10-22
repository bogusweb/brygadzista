// Material schedules (#67): rows of the steel, lintel, window and door tables from the project, with their pages.
// Totals come from the server and count only rows whose numbers it found on the page.

export type ScheduleCategory = "stal" | "nadproza" | "okna" | "drzwi" | "prefabrykaty" | "inne";

export type ScheduleItem = {
  documentId: string;
  pageNo: number;
  category: ScheduleCategory;
  element: string;
  level: string;
  mark: string;
  description: string;
  dimensions: string;
  quantity: number | null;
  unit: string;
  quote: string;
  verified: boolean;
};

export type ScheduleTotal = { category: ScheduleCategory; label: string; unit: string; quantity: number; rows: number };

export type Schedule = {
  status: "ready" | "reading" | "no_model";
  pages: { documentId: string; pageNo: number; title: string | null }[];
  failedPages: number[];
  items: ScheduleItem[];
  totals: ScheduleTotal[];
};

export const CATEGORY_LABELS: Record<ScheduleCategory, string> = {
  stal: "Stal zbrojeniowa",
  nadproza: "Nadproża",
  okna: "Stolarka okienna",
  drzwi: "Stolarka drzwiowa",
  prefabrykaty: "Prefabrykaty",
  inne: "Inne",
};

export const CATEGORIES = Object.keys(CATEGORY_LABELS) as ScheduleCategory[];

// "245,6" the Polish way; built by hand so it looks the same whatever Intl the engine ships.
export const formatQuantity = (value: number) => String(Math.round(value * 1000) / 1000).replace(".", ",");

export const itemLine = (item: ScheduleItem) =>
  [
    item.mark,
    item.description,
    item.dimensions,
    item.quantity === null ? null : `${formatQuantity(item.quantity)} ${item.unit}`.trim(),
    item.element || item.level ? `(${[item.element, item.level].filter(Boolean).join(", ")})` : null,
    `str. ${item.pageNo}`,
    item.verified ? null : "DO SPRAWDZENIA",
  ]
    .filter(Boolean)
    .join(" · ");

// Plain text to send to the wholesaler: per kind the totals, then every row with its page.
export const scheduleText = (schedule: Pick<Schedule, "items" | "totals">, category?: ScheduleCategory) => {
  const lines: string[] = [];
  for (const kind of category ? [category] : CATEGORIES) {
    const items = schedule.items.filter((item) => item.category === kind);
    if (!items.length) continue;
    lines.push(CATEGORY_LABELS[kind].toUpperCase());
    for (const total of schedule.totals.filter((candidate) => candidate.category === kind)) {
      lines.push(`Razem ${total.label}: ${formatQuantity(total.quantity)} ${total.unit}`.trim());
    }
    lines.push(...items.map((item) => `- ${itemLine(item)}`), "");
  }
  return lines.join("\n").trim();
};
