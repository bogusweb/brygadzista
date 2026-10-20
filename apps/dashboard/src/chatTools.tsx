import { useRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import type { Api } from "./api";
import { PageImage } from "./PageImage";
import { usePageViewer } from "./pageViewer";

// Mirrors the show_page tool on the server (apps/server/src/agent.ts).
const pageRef = z.object({ documentId: z.string(), pageNo: z.number() });
const showPageParameters = pageRef.extend({ caption: z.string().optional() });
const shownPage = pageRef.extend({ title: z.string().nullable().optional(), caption: z.string().nullable().optional() });

const parseResult = (result: string) => {
  try {
    const parsed = shownPage.safeParse(JSON.parse(result));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const ToolStatus = ({ done, children }: { done: boolean; children: React.ReactNode }) => (
  <p className={`tool-status small${done ? " done" : ""}`} aria-live="polite">
    <span className="tool-dot" aria-hidden="true" />
    {children}
  </p>
);

const ShowPageCard = ({
  api,
  status,
  parameters,
  result,
}: {
  api: Api;
  status: "inProgress" | "executing" | "complete";
  parameters: Partial<z.infer<typeof showPageParameters>>;
  result: string | undefined;
}) => {
  const viewer = usePageViewer();
  if (status !== "complete" || result === undefined) {
    return <div className="page-card skeleton" aria-label="Otwieram stronę projektu" />;
  }
  const page = parseResult(result);
  if (!page) return <ToolStatus done>Nie udało się otworzyć strony {parameters.pageNo ?? ""}</ToolStatus>;
  const caption = page.caption ?? parameters.caption;
  return (
    <figure className="page-card">
      <button
        type="button"
        className="page-card-image"
        onClick={() => viewer.open(page.documentId, page.pageNo)}
        aria-label={`Powiększ stronę ${page.pageNo}`}
      >
        <PageImage className="page-preview" src={api.pageImageUrl(page.documentId, page.pageNo)} alt="" />
      </button>
      <figcaption className="small">
        <strong>
          Str. {page.pageNo}
          {page.title ? ` – ${page.title}` : ""}
        </strong>
        {caption && <span className="page-card-note"> · {caption}</span>}
      </figcaption>
    </figure>
  );
};

export const useChatToolRenderers = (api: Api) => {
  useRenderTool(
    {
      name: "show_page",
      parameters: showPageParameters,
      render: ({ status, parameters, result }) => (
        <ShowPageCard api={api} status={status} parameters={parameters} result={result} />
      ),
    },
    [api],
  );

  useRenderTool(
    {
      name: "search_project",
      parameters: z.object({ query: z.string() }),
      render: ({ status, parameters }) => (
        <ToolStatus done={status === "complete"}>
          {status === "complete" ? "Przeszukano projekt" : "Szukam w projekcie"}
          {parameters.query ? `: „${parameters.query}”` : "…"}
        </ToolStatus>
      ),
    },
    [],
  );

  useRenderTool(
    {
      name: "list_pages",
      parameters: z.object({}),
      render: ({ status }) => (
        <ToolStatus done={status === "complete"}>
          {status === "complete" ? "Przejrzano spis stron" : "Przeglądam spis stron…"}
        </ToolStatus>
      ),
    },
    [],
  );

  useRenderTool(
    {
      name: "read_page",
      parameters: pageRef,
      render: ({ status, parameters }) => (
        <ToolStatus done={status === "complete"}>
          {status === "complete" ? "Przeczytano" : "Czytam"} stronę {parameters.pageNo ?? ""}
        </ToolStatus>
      ),
    },
    [],
  );

  useRenderTool(
    {
      name: "inspect_drawing",
      parameters: pageRef.extend({ question: z.string() }),
      render: ({ status, parameters }) => (
        <ToolStatus done={status === "complete"}>
          {status === "complete" ? "Obejrzano" : "Oglądam"} rysunek na stronie {parameters.pageNo ?? ""}
        </ToolStatus>
      ),
    },
    [],
  );
};
