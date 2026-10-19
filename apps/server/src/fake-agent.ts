import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { randomUUID } from "node:crypto";
import { Observable } from "rxjs";
import { pageImagePath } from "./agent.js";
import { sql } from "./db.js";

// A scripted stand-in for the project agent, used only in development (FAKE_AGENT=1) so the
// dashboard and app chats can be built and tested without an OpenRouter key. It emits the same
// AG-UI events the real agent would: streamed text, server tool calls with results, show_page,
// and, when asked, a render_a2ui call that the runtime's A2UI middleware turns into a surface.

type SamplePage = { documentId: string; pageNo: number; title: string | null };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const lastUserText = (input: RunAgentInput) => {
  const message = [...input.messages].reverse().find((m) => m.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).map((part) => ("text" in part ? part.text : "")).join(" ");
};

const samplePage = async (projectId: string): Promise<SamplePage | null> => {
  const [page] = await sql<SamplePage[]>`
    select p.document_id as "documentId", p.page_no as "pageNo", p.title
    from pages p join documents d on d.id = p.document_id
    where p.project_id = ${projectId}
    order by (p.kind = 'rysunek') desc nulls last, d.created_at, p.page_no limit 1`;
  return page ?? null;
};

const a2uiSurface = (page: SamplePage | null) => ({
  surfaceId: `parametry-${randomUUID().slice(0, 8)}`,
  components: [
    { id: "root", component: "Card", child: "col" },
    { id: "col", component: "Column", children: ["title", "list", "hint"] },
    { id: "title", component: "Text", text: "Zestawienie warstw (dane testowe)", variant: "h3" },
    { id: "list", component: "Column", children: { componentId: "row", path: "/items" } },
    { id: "row", component: "Row", justify: "spaceBetween", children: ["label", "value"] },
    { id: "label", component: "Text", text: { path: "label" } },
    { id: "value", component: "Text", text: { path: "value" }, variant: "h5" },
    {
      id: "hint",
      component: "Text",
      variant: "caption",
      text: page ? `Źródło: str. ${page.pageNo}` : "Brak stron w projekcie",
    },
  ],
  data: {
    items: [
      { label: "Styropian EPS 031", value: "15 cm" },
      { label: "Klej i siatka", value: "2 warstwy" },
      { label: "Tynk silikonowy", value: "1,5 mm" },
    ],
  },
});

export class FakeProjectAgent extends AbstractAgent {
  private projectId: string;

  constructor(projectId: string) {
    super({ agentId: "default", description: "Testowy agent (bez modelu)" });
    this.projectId = projectId;
  }

  // The runtime clones agents per run, and the base clone only copies AG-UI fields.
  override clone() {
    const copy = super.clone() as FakeProjectAgent;
    copy.projectId = this.projectId;
    return copy;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let cancelled = false;
      const emit = (event: BaseEvent) => {
        if (!cancelled) subscriber.next(event);
      };

      // One assistant message per run, like a model turn: tool calls first, then the answer.
      const messageId = randomUUID();

      const streamText = async (text: string) => {
        emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as BaseEvent);
        for (const word of text.split(/(?<= )/)) {
          emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: word } as BaseEvent);
          await pause(25);
        }
        emit({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent);
      };

      const toolCall = async (name: string, args: unknown, result: unknown) => {
        const toolCallId = randomUUID();
        emit({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: name, parentMessageId: messageId } as BaseEvent);
        const json = JSON.stringify(args);
        // Split the arguments so the client sees them stream in, as it would from a model.
        for (let i = 0; i < json.length; i += 40) {
          emit({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: json.slice(i, i + 40) } as BaseEvent);
        }
        emit({ type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent);
        await pause(400);
        emit({
          type: EventType.TOOL_CALL_RESULT,
          messageId: randomUUID(),
          toolCallId,
          role: "tool",
          content: JSON.stringify(result),
        } as BaseEvent);
      };

      const script = async () => {
        emit({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent);
        const question = lastUserText(input);
        const page = await samplePage(this.projectId);
        const wantsTable = /a2ui|tabel|zestaw/i.test(question);

        await toolCall("search_project", { query: question }, { results: page ? [page] : [] });
        if (!page) {
          await streamText(
            "To jest testowy agent (FAKE_AGENT=1). Projekt nie ma jeszcze żadnych stron, więc nie mam czego pokazać. Wgraj PDF i zapytaj ponownie.",
          );
        } else {
          await toolCall("read_page", { documentId: page.documentId, pageNo: page.pageNo }, { title: page.title });
          await toolCall(
            "show_page",
            { documentId: page.documentId, pageNo: page.pageNo, caption: "Testowy podgląd strony" },
            { ...page, caption: "Testowy podgląd strony", imagePath: pageImagePath(page.documentId, page.pageNo) },
          );
          if (wantsTable) await toolCall("render_a2ui", a2uiSurface(page), { status: "rendered" });
          await streamText(
            `To odpowiedź testowego agenta (FAKE_AGENT=1), bez modelu językowego. Na pytanie „${question}” pokazuję przykładową stronę projektu. ` +
              `Źródło: str. ${page.pageNo} – ${page.title ?? "bez tytułu"}`,
          );
        }
        emit({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId } as BaseEvent);
        subscriber.complete();
      };

      script().catch((error: unknown) => subscriber.error(error));
      return () => {
        cancelled = true;
      };
    });
  }
}
