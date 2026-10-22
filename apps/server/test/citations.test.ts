import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/client";
import { firstValueFrom, Observable, toArray } from "rxjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { CITATION_ACTIVITY_TYPE, cardCitations, checkCitations, citationCheck, historyPages, textCitations, toolPages } from "../src/citations.js";
import { ADMIN, createDocument, createProject, insertPage, resetDatabase } from "./helpers.js";

const DOC = "doc-1";

describe("citations", () => {
  it("reads page numbers, lists and ranges from the answer text", () => {
    expect(textCitations("Źródło: str. 12 – Rzut przyziemia")).toEqual([12]);
    expect(textCitations("Patrz str. 3, 5 i 7 oraz strony 9-11.").sort((a, b) => a - b)).toEqual([3, 5, 7, 9, 10, 11]);
    expect(textCitations("Na stronie 4 jest detal.")).toEqual([4]);
    expect(textCitations("Grubość 15 cm, klasa C20/25.")).toEqual([]);
  });

  it("finds source.page anywhere in an A2UI surface", () => {
    const args = {
      surfaceId: "s",
      components: [
        { id: "a", component: "ParameterCard", source: { page: 7, documentId: DOC } },
        { id: "b", component: "WorkSteps", steps: [{ title: "x", source: { page: 9 } }] },
      ],
      data: { materials: [{ name: "EPS", source: { page: 11, documentId: DOC } }] },
    };
    expect(cardCitations(args)).toEqual([{ pageNo: 7, documentId: DOC }, { pageNo: 9 }, { pageNo: 11, documentId: DOC }]);
  });

  it("takes pages only from tools that return page content", () => {
    expect(toolPages("search_project", { query: "x" }, { results: [{ documentId: DOC, pageNo: 4, title: "t" }] })).toEqual([
      { documentId: DOC, pageNo: 4 },
    ]);
    expect(toolPages("read_page", { documentId: DOC, pageNo: 5 }, { title: "t", raw_text: "..." })).toEqual([{ documentId: DOC, pageNo: 5 }]);
    expect(toolPages("get_pages", { documentId: DOC, from: 2, to: 3 }, { documentId: DOC, pages: [{ pageNo: 2 }, { pageNo: 3 }] })).toEqual([
      { documentId: DOC, pageNo: 2 },
      { documentId: DOC, pageNo: 3 },
    ]);
    expect(toolPages("list_pages", {}, { pages: [{ documentId: DOC, pageNo: 1 }] })).toEqual([]);
    expect(toolPages("read_page", { documentId: DOC, pageNo: 99 }, "Error: Nie ma strony 99 w tym dokumencie")).toEqual([]);
  });

  it("flags citations no tool returned; a card naming another document does not count", () => {
    const seen = [{ documentId: DOC, pageNo: 4 }];
    const check = checkCitations(seen, "Źródło: str. 4, a także str. 31", [
      { components: [{ source: { page: 4, documentId: "doc-2" } }, { source: { page: 4, documentId: DOC } }] },
    ]);
    expect(check.cited).toHaveLength(4);
    expect(check.unverified).toEqual([
      { pageNo: 31, in: "text" },
      { pageNo: 4, documentId: "doc-2", in: "card" },
    ]);
  });

  it("counts pages from earlier tool results of the conversation", () => {
    const messages = [
      { id: "1", role: "user", content: "Jaka grubość?" },
      {
        id: "2",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", type: "function", function: { name: "read_page", arguments: JSON.stringify({ documentId: DOC, pageNo: 8 }) } }],
      },
      { id: "3", role: "tool", toolCallId: "c1", content: JSON.stringify({ title: "Detal" }) },
    ] as Message[];
    expect(historyPages(messages)).toEqual([{ documentId: DOC, pageNo: 8 }]);
  });
});

// Plays a fixed list of events, like a model run would.
class ScriptedAgent extends AbstractAgent {
  constructor(private events: BaseEvent[]) {
    super({ agentId: "default" });
  }

  run(): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      this.events.forEach((event) => subscriber.next(event));
      subscriber.complete();
    });
  }
}

const input = { threadId: "t", runId: "r1", messages: [], tools: [], context: [], state: {}, forwardedProps: {} } as RunAgentInput;

const tool = (id: string, name: string, args: unknown, result: unknown) =>
  [
    { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: JSON.stringify(args) },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
    { type: EventType.TOOL_CALL_RESULT, messageId: `m-${id}`, toolCallId: id, content: JSON.stringify(result) },
  ] as BaseEvent[];

const run = (events: BaseEvent[]) =>
  firstValueFrom(
    citationCheck(input, new ScriptedAgent([{ type: EventType.RUN_STARTED, threadId: "t", runId: "r1" } as BaseEvent, ...events,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r1" } as BaseEvent])).pipe(toArray()),
  );

const answer = (text: string) =>
  [
    { type: EventType.TEXT_MESSAGE_START, messageId: "a", role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a", delta: text.slice(0, 10) },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a", delta: text.slice(10) },
    { type: EventType.TEXT_MESSAGE_END, messageId: "a" },
  ] as BaseEvent[];

describe("citation check in a run", () => {
  it("adds the check right before the run finishes", async () => {
    const events = await run([
      ...tool("c1", "search_project", { query: "ocieplenie" }, { results: [{ documentId: DOC, pageNo: 4, title: "Opis", snippet: "" }] }),
      ...tool("c2", "render_a2ui", { surfaceId: "s", components: [{ id: "p", component: "ParameterCard", source: { page: 6, documentId: DOC } }] }, { status: "rendered" }),
      ...answer("Grubość 15 cm. Źródło: str. 4 – Opis"),
    ]);

    const activity = events.at(-2) as BaseEvent & { activityType: string; content: unknown; messageId: string };
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(activity).toMatchObject({ type: EventType.ACTIVITY_SNAPSHOT, activityType: CITATION_ACTIVITY_TYPE, messageId: "citation-check-r1" });
    expect(activity.content).toEqual({
      cited: [
        { pageNo: 4, in: "text" },
        { pageNo: 6, documentId: DOC, in: "card" },
      ],
      unverified: [{ pageNo: 6, documentId: DOC, in: "card" }],
    });
  });

  it("adds nothing when the answer cites no page", async () => {
    const events = await run(answer("Nie wiem, projekt tego nie określa."));
    expect(events.some((event) => event.type === EventType.ACTIVITY_SNAPSHOT)).toBe(false);
  });
});

describe("citation check over HTTP", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    config.fakeAgent = false;
    await sql.end();
  });

  it("streams the check after the agent's answer", async () => {
    config.fakeAgent = true;
    const projectId = await createProject();
    const documentId = await createDocument(projectId, "ready");
    await insertPage(projectId, documentId, 3, { title: "Opis techniczny", searchText: "Opis techniczny" });

    const response = await app.request("/api/admin/copilotkit/agent/default/run", {
      method: "POST",
      headers: { ...ADMIN, "x-project-id": projectId, "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "t1",
        runId: "r1",
        messages: [{ id: "u1", role: "user", content: "Co jest w opisie?" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      }),
    });

    const stream = await response.text();
    const check = stream
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; activityType?: string; content?: unknown })
      .find((event) => event.type === EventType.ACTIVITY_SNAPSHOT && event.activityType === CITATION_ACTIVITY_TYPE);
    expect(check?.content).toEqual({ cited: [{ pageNo: 3, in: "text" }], unverified: [] });
  });
});
