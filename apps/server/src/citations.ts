import { EventType, type AbstractAgent, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";

// Citation check (#57). The prompt asks the agent to end every answer with "Źródło: str. N", and A2UI cards carry
// source.page, but nothing made sure the page was actually one the tools returned. The server now remembers the pages
// that came back from the tools (in this run and earlier in the conversation, which the model also saw) and, when the
// answer is finished, sends the clients an activity with every cited page and the ones it could not back up.

export const CITATION_ACTIVITY_TYPE = "citation-check";

export type PageRef = { documentId: string; pageNo: number };
export type Citation = { pageNo: number; documentId?: string; in: "text" | "card" };
export type CitationCheck = { cited: Citation[]; unverified: Citation[] };

// Tools whose result is the content of a page. A listing of titles or the outline only says a page exists.
const CONTENT_TOOLS = new Set([
  "search_project",
  "read_page",
  "get_pages",
  "inspect_drawing",
  "show_page",
  "search_photos",
  "search_defects",
]);

const isPageRef = (value: unknown): value is PageRef =>
  !!value &&
  typeof value === "object" &&
  typeof (value as PageRef).documentId === "string" &&
  typeof (value as PageRef).pageNo === "number";

const parse = (json: string | undefined): unknown => {
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

const isError = (result: unknown) =>
  typeof result === "string" || (!!result && typeof result === "object" && "error" in result && !("results" in result));

// Pages a content tool returned: the page it was asked about (read_page, inspect_drawing) and every page in its result.
export const toolPages = (name: string, args: unknown, result: unknown): PageRef[] => {
  if (!CONTENT_TOOLS.has(name) || result === undefined || isError(result)) return [];
  const pages: PageRef[] = [];
  if (isPageRef(args)) pages.push(args);
  if (isPageRef(result)) pages.push(result);
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    const documentId = typeof record.documentId === "string" ? record.documentId : undefined;
    for (const key of ["results", "pages", "photos", "defects"]) {
      const list = record[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (isPageRef(entry)) pages.push(entry);
        // get_pages names the document once for the whole run of pages.
        else if (documentId && entry && typeof entry === "object" && typeof (entry as PageRef).pageNo === "number") {
          pages.push({ documentId, pageNo: (entry as PageRef).pageNo });
        }
      }
    }
  }
  return pages.map(({ documentId, pageNo }) => ({ documentId, pageNo }));
};

// "str. 12", "str. 12, 14", "str. 12-14", "strona 7", "stronie 7", "strony 3 i 5".
const PAGE_CITATION = /\b(?:str\.|stron(?:a|ie|y|ę|ach))\s*(\d{1,4}(?:\s*(?:,|i|oraz|[-–])\s*\d{1,4})*)/gi;
const MAX_RANGE = 20;

export const textCitations = (text: string): number[] => {
  const pages = new Set<number>();
  for (const match of text.matchAll(PAGE_CITATION)) {
    const list = match[1]!;
    for (const part of list.split(/\s*(?:,|\bi\b|\boraz\b)\s*/)) {
      const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part.trim());
      if (range) {
        const [from, to] = [Number(range[1]), Number(range[2])];
        if (to >= from && to - from <= MAX_RANGE) for (let page = from; page <= to; page++) pages.add(page);
        continue;
      }
      if (/^\d+$/.test(part.trim())) pages.add(Number(part.trim()));
    }
  }
  return [...pages];
};

// Every source.page in the arguments of render_a2ui, wherever the component keeps it (cards, list items, steps, layers).
export const cardCitations = (args: unknown): { pageNo: number; documentId?: string }[] => {
  const found: { pageNo: number; documentId?: string }[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const source = record.source as { page?: unknown; documentId?: unknown } | undefined;
    if (source && typeof source === "object" && typeof source.page === "number") {
      found.push({ pageNo: source.page, ...(typeof source.documentId === "string" ? { documentId: source.documentId } : {}) });
    }
    Object.values(record).forEach(walk);
  };
  walk(args);
  return found;
};

// A text citation names only a page number, so it counts when any document had that page; a card that names its
// document must match it exactly.
export const checkCitations = (seen: PageRef[], text: string, cards: unknown[]): CitationCheck => {
  const pageNos = new Set(seen.map((page) => page.pageNo));
  const keys = new Set(seen.map((page) => `${page.documentId}:${page.pageNo}`));
  const cited: Citation[] = [
    ...textCitations(text).map((pageNo) => ({ pageNo, in: "text" as const })),
    ...cards.flatMap(cardCitations).map((card) => ({ ...card, in: "card" as const })),
  ];
  const unique = [...new Map(cited.map((citation) => [`${citation.in}:${citation.documentId ?? ""}:${citation.pageNo}`, citation])).values()];
  const backed = (citation: Citation) =>
    citation.documentId ? keys.has(`${citation.documentId}:${citation.pageNo}`) : pageNos.has(citation.pageNo);
  return { cited: unique, unverified: unique.filter((citation) => !backed(citation)) };
};

const textOf = (content: Message["content"]) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => ("text" in part ? part.text : "")).join("") : "";

// Pages the tools returned earlier in the conversation, which the model can still quote from.
export const historyPages = (messages: Message[]): PageRef[] => {
  const calls = new Map<string, { name: string; args: unknown }>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) calls.set(call.id, { name: call.function.name, args: parse(call.function.arguments) });
    }
  }
  return messages.flatMap((message) => {
    if (message.role !== "tool") return [];
    const call = calls.get(message.toolCallId);
    return call ? toolPages(call.name, call.args, parse(textOf(message.content))) : [];
  });
};

const A2UI_TOOL = "render_a2ui";

// AG-UI middleware on the project agent: it watches the run's events and, just before RUN_FINISHED, adds the check.
export const citationCheck = (input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> =>
  new Observable<BaseEvent>((subscriber) => {
    const seen = historyPages(input.messages);
    const calls = new Map<string, { name: string; args: string }>();
    const cards: unknown[] = [];
    let text = "";

    const finish = () => {
      const check = checkCitations(seen, text, cards);
      if (!check.cited.length) return;
      subscriber.next({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: `citation-check-${input.runId}`,
        activityType: CITATION_ACTIVITY_TYPE,
        content: check,
        replace: true,
      } as BaseEvent);
    };

    const subscription = next.run(input).subscribe({
      next: (event) => {
        switch (event.type) {
          case EventType.TEXT_MESSAGE_CONTENT:
            text += (event as BaseEvent & { delta: string }).delta;
            break;
          case EventType.TOOL_CALL_START: {
            const start = event as BaseEvent & { toolCallId: string; toolCallName: string };
            calls.set(start.toolCallId, { name: start.toolCallName, args: "" });
            break;
          }
          case EventType.TOOL_CALL_ARGS: {
            const args = event as BaseEvent & { toolCallId: string; delta: string };
            const call = calls.get(args.toolCallId);
            if (call) call.args += args.delta;
            break;
          }
          case EventType.TOOL_CALL_END: {
            const call = calls.get((event as BaseEvent & { toolCallId: string }).toolCallId);
            if (call?.name === A2UI_TOOL) cards.push(parse(call.args));
            break;
          }
          case EventType.TOOL_CALL_RESULT: {
            const result = event as BaseEvent & { toolCallId: string; content: string };
            const call = calls.get(result.toolCallId);
            if (call) seen.push(...toolPages(call.name, parse(call.args), parse(result.content)));
            break;
          }
          case EventType.RUN_FINISHED:
            finish();
            break;
        }
        subscriber.next(event);
      },
      error: (error) => subscriber.error(error),
      complete: () => subscriber.complete(),
    });
    return () => subscription.unsubscribe();
  });
