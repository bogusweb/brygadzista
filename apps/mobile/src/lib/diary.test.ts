import { describe, expect, it, vi } from "vitest";
import { dayLabel, edbDraft, groupByDay, isIsoDate, linesToList, shiftDate } from "./diary";
import type { DiaryEntry, DiaryNote } from "./diary";
import { flushQueue } from "./diaryQueue";
import type { QueuedNote } from "./diaryQueue";

const entry = (fields: Partial<DiaryEntry> = {}): DiaryEntry => ({
  summary: "",
  work: [],
  people: [],
  deliveries: [],
  weather: null,
  problems: [],
  references: [],
  ...fields,
});

const note = (id: string, entryDate: string): DiaryNote => ({
  id,
  clientId: null,
  entryDate,
  source: "text",
  transcript: "",
  entry: entry(),
  status: "ready",
  error: null,
  edited: false,
  authorName: "",
  createdAt: `${entryDate}T16:00:00Z`,
  updatedAt: `${entryDate}T16:00:00Z`,
});

describe("dates", () => {
  it("moves across month ends", () => {
    expect(shiftDate("2026-11-01", -1)).toBe("2026-10-31");
  });

  it("checks that the date exists", () => {
    expect(isIsoDate("2026-10-21")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("21.10.2026")).toBe(false);
  });

  it("names today and yesterday", () => {
    expect(dayLabel("2026-10-21", "2026-10-21")).toBe("Dziś, 21.10.2026 (środa)");
    expect(dayLabel("2026-10-20", "2026-10-21")).toBe("Wczoraj, 20.10.2026 (wtorek)");
    expect(dayLabel("2026-10-12", "2026-10-21")).toBe("12.10.2026 (poniedziałek)");
  });
});

describe("groupByDay", () => {
  it("keeps notes of one day together in server order", () => {
    const days = groupByDay([note("a", "2026-10-21"), note("b", "2026-10-21"), note("c", "2026-10-20")]);
    expect(days.map((day) => [day.date, day.notes.map((n) => n.id)])).toEqual([
      ["2026-10-21", ["a", "b"]],
      ["2026-10-20", ["c"]],
    ]);
  });
});

describe("linesToList", () => {
  it("drops bullets and empty lines", () => {
    expect(linesToList("- Zalano ławy\n\n• Przyjęto bloczki \n")).toEqual(["Zalano ławy", "Przyjęto bloczki"]);
  });
});

describe("edbDraft", () => {
  it("lays out the day under the headings of a site log entry", () => {
    const text = edbDraft("2026-10-21", [
      entry({
        work: ["Zabetonowano ławy fundamentowe w osiach A–C"],
        people: ["4 zbrojarzy", "2 betoniarzy"],
        deliveries: ["Bloczki betonowe, 2 palety"],
        weather: "Opady deszczu od 14:00",
        problems: ["Brak stali na wieniec"],
        references: [{ documentId: "d", pageNo: 7, title: "Rzut fundamentów", note: "ławy" }],
      }),
    ]);
    expect(text).toBe(
      [
        "Data: 21.10.2026 (środa)",
        "",
        "Wykonane roboty:",
        "- Zabetonowano ławy fundamentowe w osiach A–C",
        "Zatrudnienie na budowie:",
        "- 4 zbrojarzy",
        "- 2 betoniarzy",
        "Dostawy materiałów:",
        "- Bloczki betonowe, 2 palety",
        "Warunki atmosferyczne: Opady deszczu od 14:00",
        "Uwagi i problemy:",
        "- Brak stali na wieniec",
        "Dotyczy dokumentacji projektowej:",
        "- str. 7 – Rzut fundamentów",
      ].join("\n"),
    );
  });

  it("joins several notes of a day and leaves out empty headings", () => {
    const ref = { documentId: "d", pageNo: 7, title: null, note: "" };
    const text = edbDraft("2026-10-21", [
      entry({ work: ["Szalowanie"], references: [ref] }),
      entry({ work: ["Zbrojenie"], references: [ref] }),
    ]);
    expect(text).toBe(["Data: 21.10.2026 (środa)", "", "Wykonane roboty:", "- Szalowanie", "- Zbrojenie", "Dotyczy dokumentacji projektowej:", "- str. 7"].join("\n"));
  });
});

const queued = (clientId: string): QueuedNote => ({
  kind: "text",
  clientId,
  projectId: "p",
  date: "2026-10-21",
  createdAt: "2026-10-21T16:00:00Z",
  text: "Zalaliśmy ławy",
});

const httpError = (status: number, message = "Błąd") => Object.assign(new Error(message), { status });

describe("flushQueue", () => {
  it("sends everything when the server answers", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await flushQueue([queued("a"), queued("b")], send);
    expect(result.sent.map((n) => n.clientId)).toEqual(["a", "b"]);
    expect(result.remaining).toEqual([]);
  });

  it("stops at no signal and keeps the rest in order", async () => {
    const send = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Network request failed"));
    const result = await flushQueue([queued("a"), queued("b"), queued("c")], send);
    expect(result.sent.map((n) => n.clientId)).toEqual(["a"]);
    expect(result.remaining.map((n) => n.clientId)).toEqual(["b", "c"]);
    expect(result.remaining.every((n) => !n.error)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("waits out a rate limit like no signal", async () => {
    const send = vi.fn().mockRejectedValue(httpError(429));
    const result = await flushQueue([queued("a")], send);
    expect(result.remaining).toEqual([queued("a")]);
  });

  it("marks a note the server refuses for good and goes on with the next", async () => {
    const send = vi.fn().mockRejectedValueOnce(httpError(415, "Nieobsługiwany format nagrania")).mockResolvedValueOnce(undefined);
    const result = await flushQueue([queued("a"), queued("b")], send);
    expect(result.remaining).toEqual([{ ...queued("a"), error: "Nieobsługiwany format nagrania" }]);
    expect(result.sent.map((n) => n.clientId)).toEqual(["b"]);
  });

  it("does not resend a refused note", async () => {
    const send = vi.fn();
    await flushQueue([{ ...queued("a"), error: "Za długie" }], send);
    expect(send).not.toHaveBeenCalled();
  });
});
