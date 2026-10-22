// Stage checklists (#78). The shapes match the server's checklists.ts; ticking works without signal and syncs later.

export type ItemStatus = "found" | "to_confirm";

export type ChecklistSource = { documentId: string; pageNo: number; quote: string | null; imagePath: string };

export type ChecklistItem = {
  id: string;
  position: number;
  label: string;
  ask: string;
  value: string | null;
  status: ItemStatus;
  source: ChecklistSource | null;
  checked: boolean;
  note: string | null;
  checkedAt: string | null;
  checkedBy: string | null;
};

export type ResultItem = { label: string; value: string | null; status: ItemStatus; pageNo?: number | null; checked: boolean; note: string | null; checkedBy?: string | null };

export type ChecklistResult = { id: string; completedAt: string; completedBy: string; items: ResultItem[]; pending?: boolean };

export type ChecklistStatus = "generating" | "ready" | "error";

export type Checklist = {
  id: string;
  projectId: string;
  stage: string;
  title: string;
  when: string | null;
  status: ChecklistStatus;
  error: string | null;
  createdBy: string;
  createdAt: string;
  items: ChecklistItem[];
  results: ChecklistResult[];
};

export type ChecklistSummary = {
  id: string;
  stage: string;
  title: string;
  status: ChecklistStatus;
  createdBy: string;
  createdAt: string;
  itemCount: number;
  checkedCount: number;
  toConfirmCount: number;
  lastCompletedAt: string | null;
};

export type StageTemplate = { stage: string; title: string; when: string; items: string[] };

// What the phone remembers until the server confirms it. The id makes a resend harmless: the server applies each event once.
export type ChecklistEvent =
  | { id: string; checklistId: string; type: "check"; itemId: string; checked: boolean; note: string | null; at: string }
  | { id: string; checklistId: string; type: "complete"; at: string; by: string };

// Checklists whose changes the server refused for good, with its reason; their events stay until the user drops them.
export type ChecklistQueue = { events: ChecklistEvent[]; refused: Record<string, string> };

// The server's view with the phone's unsent changes laid on top, the latest change of an item winning as on the server.
export const withPending = (checklist: Checklist, events: ChecklistEvent[]): Checklist => {
  const mine = events.filter((event) => event.checklistId === checklist.id).sort((a, b) => a.at.localeCompare(b.at));
  if (mine.length === 0) return checklist;
  const items = checklist.items.map((item) => ({ ...item }));
  const results = [...checklist.results];
  for (const event of mine) {
    if (event.type === "check") {
      const item = items.find((candidate) => candidate.id === event.itemId);
      if (item && (!item.checkedAt || item.checkedAt <= event.at)) {
        Object.assign(item, { checked: event.checked, note: event.note, checkedAt: event.at, checkedBy: null });
      }
    } else {
      results.unshift({ id: event.id, completedAt: event.at, completedBy: event.by, items: items.map(snapshot), pending: true });
    }
  }
  return { ...checklist, items, results };
};

const snapshot = ({ label, value, status, source, checked, note, checkedBy }: ChecklistItem): ResultItem => ({
  label,
  value,
  status,
  pageNo: source?.pageNo ?? null,
  checked,
  note,
  checkedBy,
});

export const progress = (items: Pick<ChecklistItem, "checked" | "status">[]) => ({
  total: items.length,
  checked: items.filter((item) => item.checked).length,
  toConfirm: items.filter((item) => item.status === "to_confirm").length,
});

// The list counts from the server, corrected by ticks that have not gone out yet.
export const summaryWithPending = (summary: ChecklistSummary, cached: Checklist | null, events: ChecklistEvent[]): ChecklistSummary => {
  if (!cached || !events.some((event) => event.checklistId === summary.id)) return summary;
  const merged = withPending(cached, events);
  return {
    ...summary,
    checkedCount: progress(merged.items).checked,
    lastCompletedAt: merged.results[0]?.completedAt ?? summary.lastCompletedAt,
  };
};

// What the sync endpoint takes: the event without the phone's own bookkeeping.
export const toSyncEvent = (event: ChecklistEvent) =>
  event.type === "check"
    ? { id: event.id, type: event.type, itemId: event.itemId, checked: event.checked, note: event.note, at: event.at }
    : { id: event.id, type: event.type, at: event.at };

// Groups events by checklist, keeping their order, so each checklist goes out in one request.
export const batches = (events: ChecklistEvent[]) => {
  const byChecklist = new Map<string, ChecklistEvent[]>();
  for (const event of events) byChecklist.set(event.checklistId, [...(byChecklist.get(event.checklistId) ?? []), event]);
  return [...byChecklist].map(([checklistId, list]) => ({ checklistId, events: list }));
};

// Server errors carry an HTTP status; a missing status means no answer at all, so the changes wait for signal.
const isUnreachable = (error: unknown) => error instanceof Error && (error as { status?: number }).status === undefined;

// Rate limit, server trouble, and a checklist still being filled all pass with time.
const isTemporary = (status: number) => status === 408 || status === 409 || status === 429 || status >= 500;

export type SyncOutcome = { sent: string[]; refused: Map<string, string>; fresh: Checklist[]; offline: boolean };

// One request per checklist; stops at the first sign of no signal. Changes the server refuses for good (the checklist
// was deleted, the item is gone) are reported with the reason, so the user can read it and drop them.
export const syncEvents = async (
  events: ChecklistEvent[],
  send: (checklistId: string, events: ChecklistEvent[]) => Promise<Checklist>,
  refused: Record<string, string> = {},
): Promise<SyncOutcome> => {
  const outcome: SyncOutcome = { sent: [], refused: new Map(), fresh: [], offline: false };
  for (const batch of batches(events)) {
    if (refused[batch.checklistId]) continue;
    try {
      outcome.fresh.push(await send(batch.checklistId, batch.events));
      outcome.sent.push(...batch.events.map((event) => event.id));
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (isUnreachable(error) || (status !== undefined && isTemporary(status))) {
        outcome.offline = true;
        break;
      }
      outcome.refused.set(batch.checklistId, error instanceof Error ? error.message : "Serwer odrzucił zmiany.");
    }
  }
  return outcome;
};
