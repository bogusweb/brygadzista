import { CopilotChat, CopilotKitProvider } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { A2UIDocumentProvider, a2uiCatalog } from "./a2uiCatalog";
import { ApiError, type Api, type Project, type ProjectDocument } from "./api";
import { makeAssistantMessage } from "./chatSources";
import { citationActivityRenderer } from "./citationCheck";
import { useChatToolRenderers } from "./chatTools";
import { errorMessage } from "./format";
import { PageViewerProvider } from "./pageViewer";
import { routeHref } from "./route";

type Props = { api: Api; projectId: string; onUnauthorized: () => void };

const labels = {
  chatInputPlaceholder: "Zapytaj o projekt, np. „Jaka jest grubość ocieplenia ścian?”",
  welcomeMessageText: "Zadaj pytanie o projekt. Agent odpowiada na podstawie zaindeksowanych stron i podaje źródło.",
  chatDisclaimerText: "Agent może się mylić. Sprawdzaj wymiary na wskazanej stronie projektu.",
  assistantMessageToolbarCopyMessageLabel: "Kopiuj",
  assistantMessageToolbarRegenerateLabel: "Odpowiedz ponownie",
  assistantMessageToolbarThumbsUpLabel: "Dobra odpowiedź",
  assistantMessageToolbarThumbsDownLabel: "Zła odpowiedź",
  userMessageToolbarCopyMessageLabel: "Kopiuj",
  userMessageToolbarEditMessageLabel: "Edytuj",
};

// The schema the client sends along is replaced by the server's copy (a2ui.schema in the runtime).
const a2ui = { catalog: a2uiCatalog };
const renderActivityMessages = [citationActivityRenderer];

// CopilotKit's chat switches theme with a "dark" class rather than the media query the dashboard uses.
const darkQuery = "(prefers-color-scheme: dark)";
const usePrefersDark = () =>
  useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(darkQuery);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(darkQuery).matches,
  );

// Tool renderers must be registered under the provider, so they live in a child component.
const ProjectChat = ({ api, projectId, fallbackDocumentId }: { api: Api; projectId: string; fallbackDocumentId: string | null }) => {
  useChatToolRenderers(api, projectId);
  const messageView = useMemo(
    () => ({ assistantMessage: makeAssistantMessage(fallbackDocumentId) }),
    [fallbackDocumentId],
  );
  return <CopilotChat className="chat" labels={labels} messageView={messageView} />;
};

export const ChatScreen = ({ api, projectId, onUnauthorized }: Props) => {
  const [project, setProject] = useState<Project | null>(null);
  const [documents, setDocuments] = useState<ProjectDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [projects, docs] = await Promise.all([api.listProjects(), api.listDocuments(projectId)]);
      setProject(projects.find((candidate) => candidate.id === projectId) ?? null);
      setDocuments(docs);
      setError(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return onUnauthorized();
      setError(errorMessage(cause));
    }
  }, [api, projectId, onUnauthorized]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const headers = useMemo(() => ({ authorization: `Bearer ${api.token}`, "x-project-id": projectId }), [api, projectId]);
  const [chatError, setChatError] = useState<string | null>(null);
  const onError = useCallback(
    ({ error: cause }: { error: Error }) => {
      if (/401|Brak dostępu/.test(cause.message)) return onUnauthorized();
      setChatError("Agent nie odpowiedział. Spróbuj zadać pytanie jeszcze raz.");
    },
    [onUnauthorized],
  );
  const prefersDark = usePrefersDark();
  const indexed = documents?.filter((doc) => doc.indexedPages > 0) ?? [];

  return (
    <section className="stack chat-screen">
      <nav className="breadcrumbs small">
        <a href={routeHref({ screen: "projects" })}>Projekty</a>
        <span aria-hidden="true">/</span>
        <a href={routeHref({ screen: "project", projectId })}>{project?.name ?? "Projekt"}</a>
      </nav>
      <div className="section-head">
        <h1>Czat z agentem</h1>
        {documents && indexed.length === 0 && (
          <p className="muted small">
            Projekt nie ma jeszcze zaindeksowanych stron, więc agent nie znajdzie odpowiedzi.{" "}
            <a href={routeHref({ screen: "project", projectId })}>Wgraj PDF</a>
          </p>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button type="button" className="link" onClick={() => void reload()}>
            Odśwież
          </button>
        </p>
      )}
      {chatError && (
        <p className="error" role="alert">
          {chatError}{" "}
          <button type="button" className="link" onClick={() => setChatError(null)}>
            Ukryj
          </button>
        </p>
      )}
      <CopilotKitProvider
        runtimeUrl="/api/admin/copilotkit"
        headers={headers}
        useSingleEndpoint={false}
        showIntelligenceIndicator={false}
        onError={onError}
        a2ui={a2ui}
        renderActivityMessages={renderActivityMessages}
      >
        <PageViewerProvider api={api}>
          <A2UIDocumentProvider value={indexed[0]?.id ?? null}>
            <div className={`card chat-panel${prefersDark ? " dark" : ""}`}>
              <ProjectChat key={projectId} api={api} projectId={projectId} fallbackDocumentId={indexed[0]?.id ?? null} />
            </div>
          </A2UIDocumentProvider>
        </PageViewerProvider>
      </CopilotKitProvider>
    </section>
  );
};
