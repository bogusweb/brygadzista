import { useRenderTool } from "@copilotkit/react-native/headless";
import { z } from "zod";
import { parseJson, toolLabel } from "../../lib/chat";
import { PageCard } from "./PageCard";
import { ToolStatus } from "./ToolStatus";

const showPageParameters = z.object({
  documentId: z.string(),
  pageNo: z.number(),
  caption: z.string().optional(),
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
      name: "*",
      render: ({ name, status, parameters }: { name: string; status: string; parameters: unknown }) => (
        <ToolStatus label={toolLabel(name, (parameters ?? {}) as Parameters<typeof toolLabel>[1], status === "complete")} done={status === "complete"} />
      ),
    },
    [],
  );
};
