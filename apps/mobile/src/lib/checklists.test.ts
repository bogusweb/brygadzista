import { describe, expect, it } from "vitest";
import { batches, progress, summaryWithPending, syncEvents, toSyncEvent, withPending } from "./checklists";
import type { Checklist, ChecklistEvent, ChecklistItem, ChecklistSummary } from "./checklists";

// api.ts pulls in react-native; an Error with a status is all the sync looks at.
const apiError = (message: string, status?: number) => Object.assign(new Error(message), { status });

const item = (id: string, fields: Partial<ChecklistItem> = {}): ChecklistItem => ({
  id,
  position: 0,
  label: `Pozycja ${id}`,
  ask: "",
  value: null,
  status: "found",
  source: null,
  checked: false,
  note: null,
  checkedAt: null,
  checkedBy: null,
  ...fields,
});

const checklist = (id: string, items: ChecklistItem[]): Checklist => ({
  id,
  projectId: "p",
  stage: "fundamenty",
  title: "Fundamenty",
  when: null,
  status: "ready",
  error: null,
  createdBy: "Jan",
  createdAt: "2026-10-22T08:00:00.000Z",
  items,
  results: [],
});

const tick = (checklistId: string, itemId: string, at: string, checked = true, note: string | null = null): ChecklistEvent => ({
  id: `${itemId}-${at}`,
  checklistId,
  type: "check",
  itemId,
  checked,
  note,
  at,
});

describe("withPending", () => {
  it("lays unsent ticks over the server's view", () => {
    const merged = withPending(checklist("c", [item("a"), item("b")]), [tick("c", "a", "2026-10-22T09:00:00.000Z", true, "ok")]);
    expect(merged.items.map((i) => [i.checked, i.note])).toEqual([
      [true, "ok"],
      [false, null],
    ]);
  });

  it("keeps a newer change from the server over an older one from the phone", () => {
    const server = checklist("c", [item("a", { checked: false, checkedAt: "2026-10-22T10:00:00.000Z", checkedBy: "Ola" })]);
    expect(withPending(server, [tick("c", "a", "2026-10-22T09:00:00.000Z")]).items[0]!.checked).toBe(false);
  });

  it("applies the phone's changes in the order they were made", () => {
    const events = [tick("c", "a", "2026-10-22T09:05:00.000Z", false), tick("c", "a", "2026-10-22T09:00:00.000Z", true)];
    expect(withPending(checklist("c", [item("a")]), events).items[0]!.checked).toBe(false);
  });

  it("ignores events of other checklists", () => {
    const base = checklist("c", [item("a")]);
    expect(withPending(base, [tick("other", "a", "2026-10-22T09:00:00.000Z")])).toBe(base);
  });

  it("shows a completion that has not gone out yet, with the items as they were", () => {
    const events: ChecklistEvent[] = [
      tick("c", "a", "2026-10-22T09:00:00.000Z"),
      { id: "done", checklistId: "c", type: "complete", at: "2026-10-22T09:01:00.000Z", by: "Ty" },
    ];
    const [result] = withPending(checklist("c", [item("a"), item("b")]), events).results;
    expect(result).toMatchObject({ id: "done", pending: true, completedBy: "Ty" });
    expect(progress(result!.items)).toEqual({ total: 2, checked: 1, toConfirm: 0 });
  });
});

describe("summaryWithPending", () => {
  const summary: ChecklistSummary = {
    id: "c",
    stage: "fundamenty",
    title: "Fundamenty",
    status: "ready",
    createdBy: "Jan",
    createdAt: "",
    itemCount: 2,
    checkedCount: 0,
    toConfirmCount: 0,
    lastCompletedAt: null,
  };

  it("counts ticks waiting for signal", () => {
    const cached = checklist("c", [item("a"), item("b")]);
    expect(summaryWithPending(summary, cached, [tick("c", "b", "2026-10-22T09:00:00.000Z")]).checkedCount).toBe(1);
  });

  it("stays as the server said without a cached copy", () => {
    expect(summaryWithPending(summary, null, [tick("c", "b", "2026-10-22T09:00:00.000Z")])).toBe(summary);
  });
});

describe("sync", () => {
  it("sends only what the server reads", () => {
    expect(toSyncEvent({ id: "x", checklistId: "c", type: "complete", at: "t", by: "Ty" })).toEqual({ id: "x", type: "complete", at: "t" });
    expect(toSyncEvent(tick("c", "a", "t"))).toEqual({ id: "a-t", type: "check", itemId: "a", checked: true, note: null, at: "t" });
  });

  it("groups events per checklist in order", () => {
    const events = [tick("c1", "a", "1"), tick("c2", "b", "2"), tick("c1", "c", "3")];
    expect(batches(events).map((batch) => [batch.checklistId, batch.events.map((event) => (event.type === "check" ? event.itemId : event.id))])).toEqual([
      ["c1", ["a", "c"]],
      ["c2", ["b"]],
    ]);
  });

  it("stops at no signal and keeps the rest", async () => {
    const sent: string[] = [];
    const outcome = await syncEvents([tick("c1", "a", "1"), tick("c2", "b", "2")], async (id) => {
      sent.push(id);
      throw apiError("Nie udało się połączyć z serwerem.");
    });
    expect(sent).toEqual(["c1"]);
    expect(outcome).toMatchObject({ sent: [], offline: true });
  });

  it("treats a busy server as no signal", async () => {
    const outcome = await syncEvents([tick("c1", "a", "1")], async () => {
      throw apiError("Serwer ma problem.", 503);
    });
    expect(outcome.offline).toBe(true);
    expect(outcome.refused.size).toBe(0);
  });

  it("reports a checklist the server refuses for good and carries on with the next", async () => {
    const outcome = await syncEvents([tick("gone", "a", "1"), tick("c2", "b", "2")], async (id) => {
      if (id === "gone") throw apiError("Nie ma takiej checklisty", 404);
      return checklist(id, []);
    });
    expect(outcome.refused.get("gone")).toBe("Nie ma takiej checklisty");
    expect(outcome.sent).toEqual(["b-2"]);
    expect(outcome.fresh.map((fresh) => fresh.id)).toEqual(["c2"]);
  });

  it("skips checklists already refused", async () => {
    const outcome = await syncEvents([tick("gone", "a", "1")], async () => checklist("gone", []), { gone: "usunięta" });
    expect(outcome.sent).toEqual([]);
  });
});
