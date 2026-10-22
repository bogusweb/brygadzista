import type { Message, ToolCall, ToolMessage } from "@copilotkit/react-native/headless";
import { A2UI_ACTIVITY_TYPE, A2UI_TOOL_NAMES, parseSurfaceActivity } from "./a2ui";
import type { SurfaceActivity } from "./a2ui";

// The server checks the pages an answer cites against the pages its tools returned (#57) and sends the result as
// an activity after the answer.
export const CITATION_ACTIVITY_TYPE = "citation-check";

export type Citation = { pageNo: number; documentId?: string; in: "text" | "card" };

const isCitation = (value: unknown): value is Citation =>
  !!value && typeof value === "object" && typeof (value as Citation).pageNo === "number" && ["text", "card"].includes((value as Citation).in);

export const parseCitationCheck = (content: unknown): Citation[] | null => {
  const unverified = (content as { unverified?: unknown } | null)?.unverified;
  return Array.isArray(unverified) ? unverified.filter(isCitation) : null;
};

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; unverifiedPages?: number[] }
  | { kind: "citations"; id: string; unverified: Citation[] }
  | { kind: "tool"; id: string; toolCall: ToolCall; result?: ToolMessage }
  | { kind: "surface"; id: string; activity: SurfaceActivity }
  | { kind: "thinking"; id: string };

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("")
      : "";

// Flattens the AG-UI message list into rows: text bubbles, one row per tool call paired with its result, and A2UI
// surfaces. The render_a2ui call itself gets no row, its surface (or build status) stands in for it.
export const toChatItems = (messages: readonly Message[], isRunning: boolean): ChatItem[] => {
  const results = new Map<string, ToolMessage>();
  for (const message of messages) if (message.role === "tool") results.set(message.toolCallId, message);

  const items: ChatItem[] = [];
  for (const message of messages) {
    if (message.role === "user") items.push({ kind: "user", id: message.id, text: textOf(message.content) });
    if (message.role === "activity" && message.activityType === A2UI_ACTIVITY_TYPE) {
      const activity = parseSurfaceActivity(message.content);
      if (activity) items.push({ kind: "surface", id: message.id, activity });
    }
    if (message.role === "activity" && message.activityType === CITATION_ACTIVITY_TYPE) {
      const unverified = parseCitationCheck(message.content);
      if (unverified?.length) {
        markUnverified(items, unverified);
        items.push({ kind: "citations", id: message.id, unverified });
      }
    }
    if (message.role !== "assistant") continue;
    const text = textOf(message.content);
    if (text.trim()) items.push({ kind: "assistant", id: message.id, text });
    for (const toolCall of message.toolCalls ?? [])
      if (!A2UI_TOOL_NAMES.has(toolCall.function.name))
        items.push({ kind: "tool", id: `${message.id}:${toolCall.id}`, toolCall, result: results.get(toolCall.id) });
  }
  if (isRunning && items.at(-1)?.kind !== "assistant" && items.at(-1)?.kind !== "surface") items.push({ kind: "thinking", id: "thinking" });
  return items;
};

// The check covers the answer since the last question, so its text citations are marked there.
const markUnverified = (items: ChatItem[], unverified: Citation[]) => {
  const pages = unverified.filter((citation) => citation.in === "text").map((citation) => citation.pageNo);
  for (let i = items.length - 1; i >= 0 && items[i]!.kind !== "user"; i--) {
    const item = items[i]!;
    if (item.kind === "assistant" && pages.length) items[i] = { ...item, unverifiedPages: pages };
  }
};

export const describeUnverified = (unverified: Citation[]) =>
  unverified.map((citation) => `str. ${citation.pageNo}${citation.in === "card" ? " (na karcie)" : ""}`).join(", ");

// After a failed run the history may end with half an answer; drop everything after the last question so a retry starts clean.
export const trimToLastQuestion = (messages: readonly Message[]): Message[] => {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  return lastUser === -1 ? [...messages] : messages.slice(0, lastUser + 1);
};

export const parseJson = (value: string | undefined): unknown => {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

type ToolArgs = { query?: string; pageNo?: number; question?: string };

export const toolLabel = (name: string, args: ToolArgs, done: boolean) => {
  const page = args.pageNo ? `str. ${args.pageNo}` : "stronę";
  switch (name) {
    case "search_project":
      return done ? `Przeszukałem projekt${args.query ? `: „${args.query}”` : ""}` : `Szukam w projekcie${args.query ? `: „${args.query}”` : "…"}`;
    case "get_project_outline":
      return done ? "Przejrzałem spis treści projektu" : "Przeglądam spis treści projektu…";
    case "get_pages":
      return done ? "Przeczytałem strony" : "Czytam strony…";
    case "list_pages":
      return done ? "Przejrzałem spis stron" : "Przeglądam spis stron…";
    case "read_page":
      return done ? `Przeczytałem ${page}` : `Czytam ${page}…`;
    case "inspect_drawing":
      return done ? `Obejrzałem rysunek, ${page}` : `Oglądam rysunek, ${page}…`;
    case "show_page":
      return done ? `Pokazuję ${page}` : `Przygotowuję ${page}…`;
    case "search_photos":
      return done ? `Przejrzałem zdjęcia z budowy${args.query ? `: „${args.query}”` : ""}` : "Szukam zdjęć z budowy…";
    default:
      return done ? "Gotowe" : "Pracuję…";
  }
};

export type PageRef = { documentId: string; pageNo: number };

const isPageRef = (value: unknown): value is PageRef =>
  !!value &&
  typeof value === "object" &&
  typeof (value as PageRef).documentId === "string" &&
  typeof (value as PageRef).pageNo === "number";

// The answer cites pages as "str. N" without a document id, so we learn which document each page belongs to
// from the tool calls of the conversation (search hits, pages read or shown). The latest mention wins.
export const pageDocuments = (messages: readonly Message[]) => {
  const byPage = new Map<number, string>();
  const remember = (value: unknown) => {
    if (isPageRef(value)) byPage.set(value.pageNo, value.documentId);
  };
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.toolCalls ?? []) remember(parseJson(call.function.arguments));
    if (message.role === "tool") {
      const result = parseJson(textOf(message.content));
      remember(result);
      const listed = (result as { results?: unknown[]; pages?: unknown[] } | undefined) ?? {};
      for (const entry of [...(listed.results ?? []), ...(listed.pages ?? [])]) remember(entry);
    }
  }
  return byPage;
};

export type TextSegment = { text: string; bold?: boolean; pageNo?: number };

// "str. 12", "str. 12, 14", "str. 12-14" → one tappable segment per page number.
const PAGE_CITATION = /(str\.\s*)(\d+(?:\s*(?:,|i|oraz|[-–])\s*\d+)*)/gi;

const splitPages = (text: string, bold: boolean): TextSegment[] => {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(PAGE_CITATION)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index), bold });
    // The first link carries the "str." prefix so the tap target is not just one or two digits.
    let prefix = match[1]!;
    for (const [value] of match[2]!.matchAll(/\d+|\D+/g)) {
      if (/^\d+$/.test(value)) {
        segments.push({ text: prefix + value, bold, pageNo: Number(value) });
        prefix = "";
      } else segments.push({ text: value, bold });
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), bold });
  return segments;
};

// Inline formatting the agent uses: **bold** and page citations. Anything else stays plain text.
export const inlineSegments = (line: string): TextSegment[] =>
  line.split(/(\*\*[^*]+\*\*)/g).flatMap((chunk) => {
    if (!chunk) return [];
    const bold = chunk.startsWith("**") && chunk.endsWith("**") && chunk.length > 4;
    return splitPages(bold ? chunk.slice(2, -2) : chunk, bold);
  });

export type Block = { type: "paragraph" | "bullet" | "heading"; text: string };

export const textBlocks = (text: string): Block[] =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (bullet) return { type: "bullet", text: bullet[1]! };
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) return { type: "heading", text: heading[1]! };
      return { type: "paragraph", text: line };
    });
