import { CopilotKitProvider } from "@copilotkit/react-native/headless";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { authHeaders, copilotRuntimeUrl } from "../lib/api";
import { useConnection } from "../lib/settings";

// The headless entry keeps chat UI natives (react-native-streamdown, bottom sheet) out of the bundle,
// so the app still runs in Expo Go until the chat lands.
export const ProjectCopilot = ({ projectId, children }: { projectId: string; children: ReactNode }) => {
  const connection = useConnection();
  const headers = useMemo(() => authHeaders(connection, projectId), [connection, projectId]);
  return (
    <CopilotKitProvider key={projectId} runtimeUrl={copilotRuntimeUrl(connection)} headers={headers}>
      {children}
    </CopilotKitProvider>
  );
};
