import { CopilotKitProvider } from "@copilotkit/react-native/headless";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { authHeaders, copilotRuntimeUrl } from "../lib/api";
import { useConnection } from "../lib/settings";

const ReconnectContext = createContext<() => void>(() => {});

// Remounting the provider is the one reliable way to retry the runtime handshake after it failed (e.g. no signal on site).
export const useReconnectCopilot = () => useContext(ReconnectContext);

// The headless entry keeps chat UI natives (react-native-streamdown, bottom sheet) out of the bundle,
// so the app runs in Expo Go; the chat itself is our own, on useAgent.
export const ProjectCopilot = ({ projectId, children }: { projectId: string; children: ReactNode }) => {
  const connection = useConnection();
  const [attempt, setAttempt] = useState(0);
  const reconnect = useCallback(() => setAttempt((value) => value + 1), []);
  const headers = useMemo(() => authHeaders(connection, projectId), [connection, projectId]);
  return (
    <ReconnectContext.Provider value={reconnect}>
      <CopilotKitProvider key={`${projectId}:${attempt}`} runtimeUrl={copilotRuntimeUrl(connection)} headers={headers}>
        {children}
      </CopilotKitProvider>
    </ReconnectContext.Provider>
  );
};
