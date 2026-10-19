import { Redirect, Stack, useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";
import { AgentStatus } from "../../components/AgentStatus";
import { PageViewerProvider } from "../../components/chat/PageViewer";
import { ProjectChat } from "../../components/chat/ProjectChat";
import { ProjectCopilot } from "../../components/ProjectCopilot";
import { useSettings } from "../../lib/settings";
import { colors, spacing } from "../../lib/theme";

const ProjectScreen = () => {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { ready, connection } = useSettings();
  // Opened straight from a link or a reload: settings load asynchronously, and without them there is nothing to talk to.
  if (!ready) return null;
  if (!connection) return <Redirect href="/settings" />;
  return (
    <ProjectCopilot projectId={id}>
      <Stack.Screen options={{ title: name ?? "Projekt" }} />
      <PageViewerProvider>
        <View style={styles.status}>
          <AgentStatus />
        </View>
        <ProjectChat projectId={id} />
      </PageViewerProvider>
    </ProjectCopilot>
  );
};

const styles = StyleSheet.create({
  status: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
});

export default ProjectScreen;
