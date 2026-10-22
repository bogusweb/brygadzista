import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { summaryWithPending } from "../../lib/checklists";
import type { ChecklistSummary, StageTemplate } from "../../lib/checklists";
import { formatDateTime } from "../../lib/format";
import { colors, radius, spacing } from "../../lib/theme";
import { ChecklistView } from "./ChecklistView";
import { useChecklists } from "./useChecklists";

// Stage checklists (#78): what to check before a stage is covered up, filled from the project with the page to look at.
// Ticking works without signal; filling a new checklist needs the server.

const SummaryRow = ({ summary, waiting, onPress }: { summary: ChecklistSummary; waiting: number; onPress: () => void }) => (
  <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
    <View style={styles.titleRow}>
      <Text style={styles.cardTitle}>{summary.title}</Text>
      {summary.status === "generating" ? <ActivityIndicator color={colors.muted} /> : null}
    </View>
    <Text style={styles.meta}>
      {summary.status === "generating"
        ? "Wypełniam z projektu…"
        : summary.status === "error"
          ? "Nie udało się wypełnić"
          : [
              `sprawdzone ${summary.checkedCount} z ${summary.itemCount}`,
              summary.toConfirmCount ? `${summary.toConfirmCount} do potwierdzenia` : null,
              summary.lastCompletedAt ? `zakończona ${formatDateTime(summary.lastCompletedAt)}` : null,
              waiting ? "zmiany czekają na zasięg" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
    </Text>
  </Pressable>
);

const StagePicker = ({ templates, onPick, busy }: { templates: StageTemplate[]; onPick: (stage: string) => void; busy: string | null }) => (
  <View style={styles.picker}>
    <Text style={styles.section}>Nowa checklista</Text>
    {templates.map((template) => (
      <Pressable
        key={template.stage}
        accessibilityRole="button"
        disabled={busy !== null}
        onPress={() => onPick(template.stage)}
        style={({ pressed }) => [styles.card, pressed && styles.pressed, busy !== null && styles.disabled]}
      >
        <View style={styles.titleRow}>
          <Text style={styles.cardTitle}>{template.title}</Text>
          {busy === template.stage ? <ActivityIndicator color={colors.muted} /> : null}
        </View>
        <Text style={styles.meta}>
          {template.when} · {template.items.length} pozycji
        </Text>
      </Pressable>
    ))}
  </View>
);

export const ProjectChecklists = ({ projectId }: { projectId: string }) => {
  const checklists = useChecklists(projectId);
  const { summaries, templates, details, events, create } = checklists;
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (openId) return <ChecklistView id={openId} checklists={checklists} onBack={() => setOpenId(null)} />;

  const pick = async (stage: string) => {
    setCreating(stage);
    setError(null);
    try {
      setOpenId(await create(stage));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nie udało się utworzyć checklisty.");
    } finally {
      setCreating(null);
    }
  };

  const offline = summaries.offline || templates.offline;
  return (
    <FlatList
      data={summaries.data ?? []}
      keyExtractor={(summary) => summary.id}
      contentContainerStyle={styles.list}
      refreshing={summaries.loading && summaries.data !== null}
      onRefresh={() => void summaries.reload()}
      ListHeaderComponent={
        <View style={styles.header}>
          {summaries.loading && !summaries.data ? <ActivityIndicator color={colors.muted} /> : null}
          {summaries.error ? <Text style={styles.error}>{summaries.error}</Text> : null}
          {offline ? <Text style={styles.muted}>Bez zasięgu: widzisz ostatnio pobrane checklisty. Odhaczanie działa, zmiany wyślę później.</Text> : null}
          {summaries.data?.length ? <Text style={styles.section}>Checklisty budowy</Text> : null}
        </View>
      }
      ListEmptyComponent={
        summaries.data ? (
          <Text style={styles.muted}>
            Nie ma jeszcze checklist. Wybierz etap poniżej, a uzupełnię pozycje danymi z projektu ze wskazaniem strony.
          </Text>
        ) : undefined
      }
      renderItem={({ item }) => (
        <SummaryRow
          summary={summaryWithPending(item, details[item.id]?.data ?? null, events)}
          waiting={events.filter((event) => event.checklistId === item.id).length}
          onPress={() => setOpenId(item.id)}
        />
      )}
      ListFooterComponent={
        <View style={styles.footer}>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {templates.data ? (
            offline ? (
              <Text style={styles.muted}>Nową checklistę wypełnię z projektu, gdy wróci zasięg.</Text>
            ) : (
              <StagePicker templates={templates.data} onPick={(stage) => void pick(stage)} busy={creating} />
            )
          ) : templates.error ? (
            <Text style={styles.error}>{templates.error}</Text>
          ) : null}
        </View>
      }
    />
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.md, gap: spacing.sm },
  header: { gap: spacing.sm },
  footer: { gap: spacing.sm, marginTop: spacing.md },
  picker: { gap: spacing.sm },
  section: { fontSize: 17, fontWeight: "600", color: colors.text },
  card: { gap: 4, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  cardTitle: { flex: 1, fontSize: 16, fontWeight: "600", color: colors.text },
  meta: { fontSize: 13, color: colors.muted },
  muted: { fontSize: 15, lineHeight: 21, color: colors.muted },
  error: { fontSize: 15, color: colors.danger },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.5 },
});
