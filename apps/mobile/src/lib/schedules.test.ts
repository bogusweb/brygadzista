import { describe, expect, it } from "vitest";
import { scheduleText } from "./schedules";
import type { ScheduleItem } from "./schedules";

const item = (fields: Partial<ScheduleItem>): ScheduleItem => ({
  documentId: "d1",
  pageNo: 27,
  category: "okna",
  element: "",
  level: "",
  mark: "O1",
  description: "okno PCV",
  dimensions: "84x142",
  quantity: 52,
  unit: "szt.",
  quote: "",
  verified: true,
  ...fields,
});

describe("scheduleText", () => {
  it("lists totals and rows per kind, with pages and rows to check", () => {
    const text = scheduleText({
      items: [
        item({}),
        item({ mark: "O3", quantity: 12, verified: false }),
        item({ category: "stal", mark: "1", description: "pręt Ø12", dimensions: "", quantity: 159.6, unit: "m", element: "strop nad parterem", pageNo: 31 }),
      ],
      totals: [
        { category: "okna", label: "O1 84x142", unit: "szt.", quantity: 52, rows: 1 },
        { category: "stal", label: "Ø12", unit: "m", quantity: 159.6, rows: 1 },
      ],
    });

    expect(text).toBe(
      [
        "STAL ZBROJENIOWA",
        "Razem Ø12: 159,6 m",
        "- 1 · pręt Ø12 · 159,6 m · (strop nad parterem) · str. 31",
        "",
        "STOLARKA OKIENNA",
        "Razem O1 84x142: 52 szt.",
        "- O1 · okno PCV · 84x142 · 52 szt. · str. 27",
        "- O3 · okno PCV · 84x142 · 12 szt. · str. 27 · DO SPRAWDZENIA",
      ].join("\n"),
    );
  });
});
