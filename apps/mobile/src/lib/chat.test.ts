import { describe, expect, it } from "vitest";
import type { Message } from "@copilotkit/react-native/headless";
import { describeUnverified, inlineSegments, pageDocuments, type Citation, textBlocks, toChatItems, toolLabel, trimToLastQuestion } from "./chat";

const toolCall = (id: string, name: string, args: object) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

// A turn as the runtime streams it: question, two server tool calls with results, then the answer.
const conversation: Message[] = [
  { id: "u1", role: "user", content: "Jaka grubość ocieplenia?" },
  {
    id: "a1",
    role: "assistant",
    content: "",
    toolCalls: [toolCall("c1", "search_project", { query: "ocieplenie" }), toolCall("c2", "show_page", { documentId: "doc-a", pageNo: 12 })],
  },
  {
    id: "t1",
    role: "tool",
    toolCallId: "c1",
    content: JSON.stringify({ results: [{ documentId: "doc-b", pageNo: 18, title: "Detal" }] }),
  },
  { id: "t2", role: "tool", toolCallId: "c2", content: JSON.stringify({ documentId: "doc-a", pageNo: 12 }) },
  { id: "a2", role: "assistant", content: "EPS 15 cm.\n\nŹródło: str. 12" },
];

describe("toChatItems", () => {
  it("marks citations the server could not back and adds a warning after the answer", () => {
    const checked: Message[] = [
      ...conversation.slice(0, -1),
      { id: "a2", role: "assistant", content: "EPS 15 cm (str. 12), mocowanie na str. 31." },
      {
        id: "cc",
        role: "activity",
        activityType: "citation-check",
        content: {
          cited: [],
          unverified: [
            { pageNo: 31, in: "text" },
            { pageNo: 7, documentId: "doc-a", in: "card" },
          ],
        },
      },
    ] as Message[];

    const items = toChatItems(checked, false);

    expect(items.find((item) => item.id === "a2")).toMatchObject({ kind: "assistant", unverifiedPages: [31] });
    expect(items.at(-1)).toEqual({
      kind: "citations",
      id: "cc",
      unverified: [
        { pageNo: 31, in: "text" },
        { pageNo: 7, documentId: "doc-a", in: "card" },
      ],
    });
    expect(describeUnverified((items.at(-1) as { unverified: Citation[] }).unverified)).toBe("str. 31, str. 7 (na karcie)");
  });

  it("shows nothing for an answer whose citations all check out", () => {
    const checked = [...conversation, { id: "cc", role: "activity", activityType: "citation-check", content: { cited: [], unverified: [] } }] as Message[];
    expect(toChatItems(checked, false).some((item) => item.kind === "citations")).toBe(false);
  });

  it("puts each tool call on its own row, paired with its result", () => {
    const items = toChatItems(conversation, false);
    expect(items.map((item) => item.kind)).toEqual(["user", "tool", "tool", "assistant"]);
    const [, search, show] = items;
    expect(search?.kind === "tool" && search.result?.toolCallId).toBe("c1");
    expect(show?.kind === "tool" && show.toolCall.function.name).toBe("show_page");
  });

  it("shows a thinking row while a run has not produced text yet", () => {
    expect(toChatItems(conversation.slice(0, 1), true).at(-1)?.kind).toBe("thinking");
    expect(toChatItems(conversation, true).at(-1)?.kind).toBe("assistant");
  });
});

describe("trimToLastQuestion", () => {
  it("drops the partial answer of a failed run but keeps the question", () => {
    expect(trimToLastQuestion(conversation).map((message) => message.id)).toEqual(["u1"]);
  });
});

describe("pageDocuments", () => {
  it("learns which document a cited page belongs to from tool calls and results", () => {
    const pages = pageDocuments(conversation);
    expect(pages.get(12)).toBe("doc-a");
    expect(pages.get(18)).toBe("doc-b");
    expect(pages.has(3)).toBe(false);
  });
});

describe("inlineSegments", () => {
  it("turns page citations into links and keeps bold text", () => {
    expect(inlineSegments("**EPS 15 cm**, źródło: str. 12, 14–15")).toEqual([
      { text: "EPS 15 cm", bold: true },
      { text: ", źródło: ", bold: false },
      { text: "str. 12", bold: false, pageNo: 12 },
      { text: ", ", bold: false },
      { text: "14", bold: false, pageNo: 14 },
      { text: "–", bold: false },
      { text: "15", bold: false, pageNo: 15 },
    ]);
  });

  it("leaves text without citations alone", () => {
    expect(inlineSegments("strop 25 cm")).toEqual([{ text: "strop 25 cm", bold: false }]);
  });
});

describe("textBlocks", () => {
  it("recognises bullets and headings and drops blank lines", () => {
    expect(textBlocks("## Ściany\n\n- bloczek 24 cm\n2. EPS 15 cm\nKoniec")).toEqual([
      { type: "heading", text: "Ściany" },
      { type: "bullet", text: "bloczek 24 cm" },
      { type: "bullet", text: "EPS 15 cm" },
      { type: "paragraph", text: "Koniec" },
    ]);
  });
});

describe("toolLabel", () => {
  it("describes what the agent is doing in Polish", () => {
    expect(toolLabel("search_project", { query: "wylewka" }, false)).toBe("Szukam w projekcie: „wylewka”");
    expect(toolLabel("inspect_drawing", { pageNo: 7 }, false)).toBe("Oglądam rysunek, str. 7…");
    expect(toolLabel("read_page", { pageNo: 7 }, true)).toBe("Przeczytałem str. 7");
  });
});
