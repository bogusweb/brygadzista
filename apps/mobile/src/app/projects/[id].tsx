import { Stack, useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { AgentStatus } from "../../components/AgentStatus";
import { ProjectCopilot } from "../../components/ProjectCopilot";
import { colors, spacing } from "../../lib/theme";

const ProjectScreen = () => {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  return (
    <ProjectCopilot projectId={id}>
      <Stack.Screen options={{ title: name ?? "Projekt" }} />
      <View style={styles.container}>
        <AgentStatus />
        <Text style={styles.placeholder}>Tutaj pojawi się czat z asystentem, który zna ten projekt.</Text>
      </View>
    </ProjectCopilot>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, padding: spacing.md, gap: spacing.lg },
  placeholder: { fontSize: 16, lineHeight: 22, color: colors.text },
});

export default ProjectScreen;
