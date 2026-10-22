import { Redirect, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AgentStatus } from "../../components/AgentStatus";
import { ProjectCards } from "../../components/cards/ProjectCards";
import { ProjectSchedules } from "../../components/schedules/ProjectSchedules";
import { PageViewerProvider } from "../../components/chat/PageViewer";
import { ProjectChat } from "../../components/chat/ProjectChat";
import { ProjectChecklists } from "../../components/checklists/ProjectChecklists";
import { ProjectDefects } from "../../components/defects/ProjectDefects";
import { ProjectDiary } from "../../components/diary/ProjectDiary";
import { ProjectPages } from "../../components/pages/ProjectPages";
import { ProjectSearch } from "../../components/pages/ProjectSearch";
import { PinsProvider } from "../../components/pins/PinsProvider";
import { ProjectCopilot } from "../../components/ProjectCopilot";
import { ProjectQuestions } from "../../components/questions/ProjectQuestions";
import { ProjectChanges } from "../../components/revisions/ProjectChanges";
import { readJson, writeJson } from "../../lib/offlineCache";
import { fetchRevisions } from "../../lib/revisionApi";
import { seenRevisionsKey, unseenRevisions } from "../../lib/revisions";
import { useCachedResource } from "../../lib/useCachedResource";
import { useConnection, useSettings } from "../../lib/settings";
import { colors, radius, spacing } from "../../lib/theme";

type Tab = "chat" | "pages" | "defects" | "checklists" | "diary" | "questions";

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "Czat" },
  { id: "pages", label: "Projekt" },
  { id: "defects", label: "Usterki" },
  { id: "checklists", label: "Odbiory" },
  { id: "diary", label: "Dziennik" },
  { id: "questions", label: "Pytania" },
];

type PagesView = "drawings" | "cards" | "schedules" | "changes";

const PAGES_VIEWS: { id: PagesView; label: string }[] = [
  { id: "drawings", label: "Strony" },
  { id: "cards", label: "Karty" },
  { id: "schedules", label: "Zestawienia" },
];

const CHANGES_VIEW: { id: PagesView; label: string } = { id: "changes", label: "Zmiany" };

// New versions of the project (#72): the list of changes, and a notice until the crew opens it.
const useRevisions = (projectId: string) => {
  const connection = useConnection();
  const revisions = useCachedResource(`revisions-${projectId}`, (current) => fetchRevisions(current, projectId), "Nie udało się pobrać wersji projektu.");
  const [seen, setSeen] = useState<string[] | null>(null);

  useEffect(() => {
    void readJson<string[]>(connection, seenRevisionsKey(projectId))
      .catch(() => null)
      .then((saved) => setSeen(saved ?? []));
  }, [connection, projectId]);

  const markSeen = useCallback(() => {
    const all = (revisions.data ?? []).map((revision) => revision.documentId);
    setSeen(all);
    void writeJson(connection, seenRevisionsKey(projectId), all);
  }, [connection, projectId, revisions.data]);

  return { revisions: revisions.data ?? [], unseen: seen === null ? [] : unseenRevisions(revisions.data, seen), markSeen };
};

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
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={[styles.tabLabel, selected && styles.tabLabelSelected]}>
            {label}
          </Text>
        </Pressable>
      );
    })}
  </View>
);

const ProjectScreen = () => {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { ready, connection } = useSettings();
  // Opened straight from a link or a reload: settings load asynchronously, and without them there is nothing to talk to.
  if (!ready) return null;
  if (!connection) return <Redirect href="/settings" />;
  return <ProjectTabs id={id} name={name} />;
};

const ProjectTabs = ({ id, name }: { id: string; name?: string }) => {
  const [tab, setTab] = useState<Tab>("chat");
  const [pagesView, setPagesView] = useState<PagesView>("drawings");
  const { revisions, unseen, markSeen } = useRevisions(id);
  const pagesViews = revisions.length ? [...PAGES_VIEWS, CHANGES_VIEW] : PAGES_VIEWS;
  const showChanges = () => {
    setTab("pages");
    setPagesView("changes");
    markSeen();
  };
  return (
    <ProjectCopilot projectId={id}>
      <Stack.Screen options={{ title: name ?? "Projekt" }} />
      <PinsProvider projectId={id}>
        <PageViewerProvider>
          <View style={styles.top}>
            <TabBar tabs={TABS} tab={tab} onChange={setTab} />
            {tab === "pages" ? (
              <TabBar tabs={pagesViews} tab={pagesView} onChange={(view) => (view === "changes" ? showChanges() : setPagesView(view))} />
            ) : null}
            {unseen.length ? (
              <Pressable accessibilityRole="button" onPress={showChanges} style={styles.notice}>
                <Text style={styles.noticeText}>
                  Nowa wersja projektu: {unseen[0]!.filename}
                  {unseen[0]!.changedPages ? ` · zmienione strony: ${unseen[0]!.changedPages}` : ""}. Zobacz zmiany ›
                </Text>
              </Pressable>
            ) : null}
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
          <View style={[styles.pane, (tab !== "pages" || pagesView !== "schedules") && styles.hidden]}>
            <ProjectSchedules projectId={id} />
          </View>
          <View style={[styles.pane, (tab !== "pages" || pagesView !== "changes") && styles.hidden]}>
            <ProjectChanges revisions={revisions} />
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
          <View style={[styles.pane, tab !== "questions" && styles.hidden]}>
            <ProjectQuestions projectId={id} />
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
  notice: { padding: spacing.sm, borderRadius: radius.md, backgroundColor: "#FCEFD9" },
  noticeText: { fontSize: 14, lineHeight: 20, fontWeight: "600", color: colors.link },
  pane: { flex: 1 },
  hidden: { display: "none" },
});

export default ProjectScreen;
