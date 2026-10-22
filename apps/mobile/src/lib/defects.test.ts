import { describe, expect, it } from "vitest";
import { assigneesOf, daysFrom, emptyFilter, filterDefects, formatDay, isOverdue, pagesOf, parseDay, protocolFields, protocolQuery } from "./defects";
import type { Pin } from "./pins";

const defect = (fields: Partial<Pin>): Pin => ({
  id: fields.room ?? "x",
  documentId: "doc",
  pageNo: 5,
  pageTitle: "Rzut parteru",
  x: 0.5,
  y: 0.5,
  kind: "defect",
  note: "",
  room: "",
  status: "open",
  assignee: "",
  dueDate: null,
  authorName: "",
  createdAt: "2026-10-21T08:00:00.000Z",
  updatedAt: "2026-10-21T08:00:00.000Z",
  photos: [],
  ...fields,
});

const PINS = [
  defect({ room: "Salon", assignee: "Kowalski" }),
  defect({ room: "Kuchnia", status: "closed", assignee: "Nowak" }),
  defect({ room: "Sypialnia", status: "to_check", pageNo: 6, pageTitle: "Rzut piętra", assignee: "kowalski" }),
  defect({ room: "Łazienka", kind: "photo", status: null }),
];

const rooms = (pins: Pin[]) => pins.map((pin) => pin.room);

describe("filterDefects", () => {
  it("shows open and to-check defects by default, never photo pins", () => {
    expect(rooms(filterDefects(PINS, emptyFilter))).toEqual(["Salon", "Sypialnia"]);
    expect(rooms(filterDefects(PINS, { ...emptyFilter, status: "all" }))).toEqual(["Salon", "Kuchnia", "Sypialnia"]);
    expect(rooms(filterDefects(PINS, { ...emptyFilter, status: "closed" }))).toEqual(["Kuchnia"]);
  });

  it("filters by person whatever the capitals, and by drawing", () => {
    expect(rooms(filterDefects(PINS, { ...emptyFilter, assignee: "KOWALSKI" }))).toEqual(["Salon", "Sypialnia"]);
    expect(rooms(filterDefects(PINS, { status: "all", assignee: null, page: "doc:6" }))).toEqual(["Sypialnia"]);
  });
});

describe("assignees and pages", () => {
  it("lists each person once and each drawing with its count", () => {
    expect(assigneesOf(PINS)).toEqual(["Kowalski", "Nowak"]);
    expect(pagesOf(PINS)).toEqual([
      { key: "doc:5", label: "Rzut parteru", documentId: "doc", pageNo: 5, count: 2 },
      { key: "doc:6", label: "Rzut piętra", documentId: "doc", pageNo: 6, count: 1 },
    ]);
  });
});

describe("deadlines", () => {
  const today = new Date(2026, 9, 21, 15, 0);

  it("counts days in the phone's calendar and across months", () => {
    expect(daysFrom(today, 0)).toBe("2026-10-21");
    expect(daysFrom(today, 14)).toBe("2026-11-04");
  });

  it("reads what people type and refuses impossible days", () => {
    expect(parseDay("30.10", today)).toBe("2026-10-30");
    expect(parseDay("3.1.2027", today)).toBe("2027-01-03");
    expect(parseDay("2026-11-02", today)).toBe("2026-11-02");
    expect(parseDay("31.11", today)).toBeNull();
    expect(parseDay("jutro", today)).toBeNull();
  });

  it("marks a missed deadline only while the defect is not closed", () => {
    expect(isOverdue({ status: "open", dueDate: "2026-10-20" }, today)).toBe(true);
    expect(isOverdue({ status: "open", dueDate: "2026-10-21" }, today)).toBe(false);
    expect(isOverdue({ status: "closed", dueDate: "2026-10-01" }, today)).toBe(false);
    expect(formatDay("2026-10-30", today)).toBe("30.10");
    expect(formatDay("2027-01-03", today)).toBe("03.01.2027");
  });
});

describe("protocolQuery", () => {
  it("asks the server for the same defects as the list shows", () => {
    expect(protocolQuery(emptyFilter)).toBe("status=open,to_check");
    expect(protocolQuery({ status: "all", assignee: "Jan Kowalski", page: "doc:6" })).toBe("assignee=Jan%20Kowalski&documentId=doc&pageNo=6");
  });
});

describe("protocolFields", () => {
  it("turns the on-screen filter into the fields of a saved protocol", () => {
    expect(protocolFields(emptyFilter)).toEqual({ status: "open,to_check" });
    expect(protocolFields({ status: "all", assignee: "Jan", page: "doc-1:3" })).toEqual({ assignee: "Jan", documentId: "doc-1", pageNo: 3 });
  });
});
