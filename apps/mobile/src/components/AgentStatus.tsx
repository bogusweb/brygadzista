import { CopilotKitCoreRuntimeConnectionStatus, useCopilotKit } from "@copilotkit/react-native/headless";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, spacing } from "../lib/theme";

const LABELS: Record<CopilotKitCoreRuntimeConnectionStatus, string> = {
  [CopilotKitCoreRuntimeConnectionStatus.Connected]: "Asystent połączony",
  [CopilotKitCoreRuntimeConnectionStatus.Connecting]: "Łączę z asystentem…",
  [CopilotKitCoreRuntimeConnectionStatus.Disconnected]: "Asystent rozłączony",
  [CopilotKitCoreRuntimeConnectionStatus.Error]: "Nie można połączyć z asystentem",
};

const DOT_COLORS: Record<CopilotKitCoreRuntimeConnectionStatus, string> = {
  [CopilotKitCoreRuntimeConnectionStatus.Connected]: "#2E9D57",
  [CopilotKitCoreRuntimeConnectionStatus.Connecting]: colors.accent,
  [CopilotKitCoreRuntimeConnectionStatus.Disconnected]: colors.muted,
  [CopilotKitCoreRuntimeConnectionStatus.Error]: colors.danger,
};

export const AgentStatus = () => {
  const { copilotkit } = useCopilotKit();
  const [status, setStatus] = useState(copilotkit.runtimeConnectionStatus);

  useEffect(() => {
    setStatus(copilotkit.runtimeConnectionStatus);
    const subscription = copilotkit.subscribe({
      onRuntimeConnectionStatusChanged: ({ status: next }) => setStatus(next),
    });
    return () => subscription.unsubscribe();
  }, [copilotkit]);

  return (
    <View style={styles.row} accessibilityLiveRegion="polite">
      <View style={[styles.dot, { backgroundColor: DOT_COLORS[status] }]} />
      <Text style={styles.label}>{LABELS[status]}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  label: { fontSize: 15, color: colors.muted },
});
