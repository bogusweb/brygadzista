import { Redirect, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AgentStatus } from "../../components/AgentStatus";
import { ProjectCards } from "../../components/cards/ProjectCards";
import { PageViewerProvider } from "../../components/chat/PageViewer";
import { ProjectChat } from "../../components/chat/ProjectChat";
import { ProjectChecklists } from "../../components/checklists/ProjectChecklists";
import { ProjectDefects } from "../../components/defects/ProjectDefects";
import { ProjectDiary } from "../../components/diary/ProjectDiary";
import { ProjectPages } from "../../components/pages/ProjectPages";
import { ProjectSearch } from "../../components/pages/ProjectSearch";
import { PinsProvider } from "../../components/pins/PinsProvider";
import { ProjectCopilot } from "../../components/ProjectCopilot";
import { useSettings } from "../../lib/settings";
import { colors, radius, spacing } from "../../lib/theme";

type Tab = "chat" | "pages" | "defects" | "checklists" | "diary";

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "Czat" },
  { id: "pages", label: "Projekt" },
  { id: "defects", label: "Usterki" },
  { id: "checklists", label: "Odbiory" },
  { id: "diary", label: "Dziennik" },
];

type PagesView = "drawings" | "cards";

const PAGES_VIEWS: { id: PagesView; label: string }[] = [
  { id: "drawings", label: "Strony" },
  { id: "cards", label: "Karty" },
];

const TabBar = <T extends string>({ tabs, tab, onChange }: { tabs: { id: T; label: string }[]; tab: T; onChange: (tab: T) => void }) => (
  <View style={styles.tabs} accessibilityRole="tablist">
    {tabs.map(({ id, label }) => {
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
  const [pagesView, setPagesView] = useState<PagesView>("drawings");
  // Opened straight from a link or a reload: settings load asynchronously, and without them there is nothing to talk to.
  if (!ready) return null;
  if (!connection) return <Redirect href="/settings" />;
  return (
    <ProjectCopilot projectId={id}>
      <Stack.Screen options={{ title: name ?? "Projekt" }} />
      <PinsProvider projectId={id}>
        <PageViewerProvider>
          <View style={styles.top}>
            <TabBar tabs={TABS} tab={tab} onChange={setTab} />
            {tab === "pages" ? <TabBar tabs={PAGES_VIEWS} tab={pagesView} onChange={setPagesView} /> : null}
            {tab === "chat" ? <AgentStatus /> : null}
          </View>
          {/* All tabs stay mounted: switching to the drawings must not drop the conversation, a running download or a recording. */}
          <View style={[styles.pane, tab !== "chat" && styles.hidden]}>
            <ProjectChat projectId={id} />
          </View>
          <View style={[styles.pane, (tab !== "pages" || pagesView !== "drawings") && styles.hidden]}>
            <ProjectSearch projectId={id}>
              <ProjectPages projectId={id} />
            </ProjectSearch>
          </View>
          <View style={[styles.pane, (tab !== "pages" || pagesView !== "cards") && styles.hidden]}>
            <ProjectCards projectId={id} />
          </View>
          <View style={[styles.pane, tab !== "defects" && styles.hidden]}>
            <ProjectDefects projectId={id} />
          </View>
          <View style={[styles.pane, tab !== "checklists" && styles.hidden]}>
            <ProjectChecklists projectId={id} />
          </View>
          <View style={[styles.pane, tab !== "diary" && styles.hidden]}>
            <ProjectDiary projectId={id} />
          </View>
        </PageViewerProvider>
      </PinsProvider>
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
  tabLabel: { fontSize: 14, fontWeight: "500", color: colors.muted },
  tabLabelSelected: { color: colors.text, fontWeight: "600" },
  pane: { flex: 1 },
  hidden: { display: "none" },
});

export default ProjectScreen;
