import { useRenderTool } from "@copilotkit/react-native/headless";
import { z } from "zod";
import { parseJson, toolLabel } from "../../lib/chat";
import { PhotoResults } from "../pins/PhotoResults";
import type { FoundPin } from "../pins/PhotoResults";
import type { QuestionDraft } from "../../lib/questions";
import { QuestionDraftCard } from "../questions/QuestionDraftCard";
import { PageCard } from "./PageCard";
import { ToolStatus } from "./ToolStatus";

const showPageParameters = z.object({
  documentId: z.string(),
  pageNo: z.number(),
  caption: z.string().optional(),
});

const searchPhotosParameters = z.object({
  query: z.string().optional(),
  documentId: z.string().optional(),
  pageNo: z.number().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const draftQuestionParameters = z.object({
  documentId: z.string(),
  pageNo: z.number(),
  question: z.string(),
  reason: z.string().optional(),
});

type ShowPageResult = { documentId: string; pageNo: number; title?: string | null; caption?: string };

// The project tools all run on the server; the app only draws their calls.
export const useChatToolRenderers = () => {
  useRenderTool(
    {
      name: "show_page",
      parameters: showPageParameters,
      render: ({ status, parameters, result }) => {
        if (status !== "complete") return <ToolStatus label={toolLabel("show_page", parameters, false)} done={false} />;
        const shown = parseJson(result) as ShowPageResult | undefined;
        if (!shown?.documentId) return <ToolStatus label={`Nie udało się pokazać str. ${parameters.pageNo}`} done />;
        return <PageCard page={{ ...shown, caption: shown.caption ?? parameters.caption }} />;
      },
    },
    [],
  );

  useRenderTool(
    {
      name: "search_photos",
      parameters: searchPhotosParameters,
      render: ({ status, parameters, result }) => {
        const label = toolLabel("search_photos", parameters, status === "complete");
        if (status !== "complete") return <ToolStatus label={label} done={false} />;
        const found = (parseJson(result) as { photos?: FoundPin[] } | undefined)?.photos ?? [];
        return found.length ? <PhotoResults pins={found} /> : <ToolStatus label={label} done />;
      },
    },
    [],
  );

  useRenderTool(
    {
      name: "draft_designer_question",
      parameters: draftQuestionParameters,
      render: ({ status, result }) => {
        if (status !== "complete") return <ToolStatus label={toolLabel("draft_designer_question", {}, false)} done={false} />;
        const draft = (parseJson(result) as { draft?: QuestionDraft } | undefined)?.draft;
        if (!draft) return <ToolStatus label="Nie udało się przygotować pytania" done />;
        return <QuestionDraftCard draft={draft} />;
      },
    },
    [],
  );

  useRenderTool(
    {
      name: "*",
      render: ({ name, status, parameters }: { name: string; status: string; parameters: unknown }) => (
        <ToolStatus label={toolLabel(name, (parameters ?? {}) as Parameters<typeof toolLabel>[1], status === "complete")} done={status === "complete"} />
      ),
    },
    [],
  );
};
