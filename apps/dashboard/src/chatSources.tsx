import { CopilotChatAssistantMessage } from "@copilotkit/react-core/v2";
import { createContext, useContext, useMemo, type ComponentProps } from "react";
import { usePageViewer } from "./pageViewer";

// The agent ends answers with "Źródło: str. N – tytuł". Those page references become links
// that open the page in the viewer. A page number alone doesn't say which PDF it is from, so
// the link uses the document the agent last looked at in this conversation.

const SOURCE_HREF = "#strona-";
const pageReference = /\b(str\.\s?)(\d{1,4})\b/g;

export const linkPageReferences = (markdown: string) =>
  markdown.replace(pageReference, (_match, prefix: string, pageNo: string) => `[${prefix}${pageNo}](${SOURCE_HREF}${pageNo})`);

const SourceDocumentContext = createContext<string | null>(null);

type AssistantMessageProps = ComponentProps<typeof CopilotChatAssistantMessage>;
type Message = NonNullable<AssistantMessageProps["messages"]>[number];

const documentIdFromArguments = (json: string) => {
  try {
    const args = JSON.parse(json) as { documentId?: unknown };
    return typeof args.documentId === "string" ? args.documentId : null;
  } catch {
    return null;
  }
};

const lastDocumentId = (messages: Message[], upToId: string) => {
  let documentId: string | null = null;
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) documentId = documentIdFromArguments(call.function.arguments) ?? documentId;
    }
    if (message.id === upToId) break;
  }
  return documentId;
};

const SourceLink = ({ href, children, ...rest }: ComponentProps<"a">) => {
  const documentId = useContext(SourceDocumentContext);
  const viewer = usePageViewer();
  if (href?.startsWith(SOURCE_HREF)) {
    const pageNo = Number(href.slice(SOURCE_HREF.length));
    if (!documentId) return <span>{children}</span>;
    return (
      <button type="button" className="link source-link" onClick={() => viewer.open(documentId, pageNo)}>
        {children}
      </button>
    );
  }
  return (
    <a {...rest} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
};

const markdownComponents = { a: SourceLink };

const SourceMarkdown = ({ content, ...rest }: ComponentProps<typeof CopilotChatAssistantMessage.MarkdownRenderer>) => {
  const linked = useMemo(() => linkPageReferences(content), [content]);
  return <CopilotChatAssistantMessage.MarkdownRenderer {...rest} content={linked} components={markdownComponents} />;
};

// The chat slot expects the full CopilotChatAssistantMessage namespace, so the wrapper carries its parts.
export const makeAssistantMessage = (fallbackDocumentId: string | null) =>
  Object.assign(function AssistantMessageWithSources(props: AssistantMessageProps) {
    const documentId = useMemo(
      () => lastDocumentId(props.messages ?? [], props.message.id) ?? fallbackDocumentId,
      [props.messages, props.message.id],
    );
    return (
      <SourceDocumentContext.Provider value={documentId}>
        <CopilotChatAssistantMessage {...props} markdownRenderer={SourceMarkdown} />
      </SourceDocumentContext.Provider>
    );
  }, CopilotChatAssistantMessage);
