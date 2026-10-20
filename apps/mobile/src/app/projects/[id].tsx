import { Redirect, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AgentStatus } from "../../components/AgentStatus";
import { PageViewerProvider } from "../../components/chat/PageViewer";
import { ProjectChat } from "../../components/chat/ProjectChat";
import { ProjectPages } from "../../components/pages/ProjectPages";
import { ProjectCopilot } from "../../components/ProjectCopilot";
import { useSettings } from "../../lib/settings";
import { colors, radius, spacing } from "../../lib/theme";

type Tab = "chat" | "pages";

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "Czat" },
  { id: "pages", label: "Projekt" },
];

const TabBar = ({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) => (
  <View style={styles.tabs} accessibilityRole="tablist">
    {TABS.map(({ id, label }) => {
      const selected = id === tab;
      return (
        <Pressable
          key={id}
          accessibilityRole="tab"
          accessibilityState={{ selected }}
          onPress={() => onChange(id)}
          style={[styles.tab, selected && styles.tabSelected]}
        >
          <Text style={[styles.tabLabel, selected && styles.tabLabelSelected]}>{label}</Text>
        </Pressable>
      );
    })}
  </View>
);

const ProjectScreen = () => {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { ready, connection } = useSettings();
  const [tab, setTab] = useState<Tab>("chat");
  // Opened straight from a link or a reload: settings load asynchronously, and without them there is nothing to talk to.
  if (!ready) return null;
  if (!connection) return <Redirect href="/settings" />;
  return (
    <ProjectCopilot projectId={id}>
      <Stack.Screen options={{ title: name ?? "Projekt" }} />
      <PageViewerProvider>
        <View style={styles.top}>
          <TabBar tab={tab} onChange={setTab} />
          {tab === "chat" ? <AgentStatus /> : null}
        </View>
        {/* Both tabs stay mounted: switching to the drawings must not drop the conversation or a running download. */}
        <View style={[styles.pane, tab !== "chat" && styles.hidden]}>
          <ProjectChat projectId={id} />
        </View>
        <View style={[styles.pane, tab !== "pages" && styles.hidden]}>
          <ProjectPages projectId={id} />
        </View>
      </PageViewerProvider>
    </ProjectCopilot>
  );
};

const styles = StyleSheet.create({
  top: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tabs: { flexDirection: "row", padding: 3, borderRadius: radius.md, backgroundColor: colors.border },
  tab: { flex: 1, minHeight: 40, borderRadius: radius.md - 2, alignItems: "center", justifyContent: "center" },
  tabSelected: { backgroundColor: colors.surface },
  tabLabel: { fontSize: 15, fontWeight: "500", color: colors.muted },
  tabLabelSelected: { color: colors.text, fontWeight: "600" },
  pane: { flex: 1 },
  hidden: { display: "none" },
});

export default ProjectScreen;
