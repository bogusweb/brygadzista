import { Link, Redirect, Stack, router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Button } from "../components/Button";
import { fetchProjects } from "../lib/api";
import type { Project } from "../lib/api";
import { pluralPl } from "../lib/format";
import { useSettings } from "../lib/settings";
import { useCachedResource } from "../lib/useCachedResource";
import { colors, radius, spacing } from "../lib/theme";

const documentLabel = (count: number) => pluralPl(count, "dokument", "dokumenty", "dokumentów");

const ProjectRow = ({ project, recent, onPress }: { project: Project; recent: boolean; onPress: () => void }) => (
  <Pressable
    accessibilityRole="button"
    onPress={onPress}
    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
  >
    <View style={styles.rowText}>
      <Text style={styles.rowTitle}>{project.name}</Text>
      <Text style={styles.rowMeta}>
        {documentLabel(project.documentCount)}
        {recent ? " · ostatnio otwierany" : ""}
      </Text>
    </View>
    <Text style={styles.chevron}>›</Text>
  </Pressable>
);

const ProjectList = () => {
  const { lastProjectId, rememberProject } = useSettings();
  // Kept on the phone so a site without signal can still reach the saved drawings.
  const { data: projects, offline, error, reload: load } = useCachedResource("projects", fetchProjects, "Nie udało się pobrać projektów.");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const open = (project: Project) => {
    void rememberProject(project.id);
    router.push({ pathname: "/projects/[id]", params: { id: project.id, name: project.name } });
  };

  if (!projects && !error) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!projects) {
    return (
      <View style={styles.center}>
        <Text style={styles.message}>{error}</Text>
        <Button label="Spróbuj ponownie" onPress={load} />
      </View>
    );
  }

  return (
    <FlatList
      data={projects}
      keyExtractor={(project) => project.id}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
      ListHeaderComponent={
        error ? (
          <Text style={styles.inlineError}>{error}</Text>
        ) : offline ? (
          <Text style={styles.offlineNote}>Brak połączenia z serwerem. Lista projektów z ostatniego połączenia.</Text>
        ) : undefined
      }
      ListEmptyComponent={
        <Text style={styles.message}>Na serwerze nie ma jeszcze projektów. Poproś administratora o dodanie projektu.</Text>
      }
      renderItem={({ item }) => (
        <ProjectRow project={item} recent={item.id === lastProjectId} onPress={() => open(item)} />
      )}
    />
  );
};

const HomeScreen = () => {
  const { ready, connection } = useSettings();

  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (!connection) return <Redirect href="/settings" />;

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/settings" style={styles.headerLink}>
              Ustawienia
            </Link>
          ),
        }}
      />
      <ProjectList />
    </>
  );
};

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg, gap: spacing.md },
  list: { padding: spacing.md, gap: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 64,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rowPressed: { opacity: 0.7 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 17, fontWeight: "600", color: colors.text },
  rowMeta: { fontSize: 14, color: colors.muted },
  chevron: { fontSize: 24, color: colors.muted },
  message: { fontSize: 16, lineHeight: 22, color: colors.muted, textAlign: "center" },
  offlineNote: { fontSize: 15, lineHeight: 21, color: colors.muted, marginBottom: spacing.sm },
  inlineError: { fontSize: 15, color: colors.danger, marginBottom: spacing.sm },
  headerLink: { fontSize: 16, color: colors.accent, fontWeight: "600" },
});

export default HomeScreen;
