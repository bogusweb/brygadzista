import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Share, StyleSheet, Text, View } from "react-native";
import { request } from "../../lib/http";
import { CATEGORIES, CATEGORY_LABELS, formatQuantity, scheduleText } from "../../lib/schedules";
import type { Schedule, ScheduleCategory, ScheduleItem } from "../../lib/schedules";
import type { Connection } from "../../lib/settings";
import { colors, radius, spacing } from "../../lib/theme";
import { useCachedResource } from "../../lib/useCachedResource";
import { Button } from "../Button";
import { usePageViewer } from "../chat/PageViewer";

const READING_POLL_MS = 4_000;

const fetchSchedule = (connection: Connection, projectId: string) =>
  request<Schedule>(connection, `/api/projects/${encodeURIComponent(projectId)}/schedules`);

const statusNote = (schedule: Schedule) => {
  if (schedule.status === "reading") return "Odczytuję zestawienia z projektu…";
  if (schedule.status === "no_model") return "Zestawienia nie są jeszcze odczytane na serwerze.";
  if (!schedule.pages.length) return "W projekcie nie ma zestawień materiałów. Ilości trzeba ustalić z projektantem, nie liczę ich na oko z rysunków.";
  return null;
};

const ItemRow = ({ item }: { item: ScheduleItem }) => {
  const openPage = usePageViewer();
  return (
    <View style={[styles.card, !item.verified && styles.unverified]}>
      <View style={styles.row}>
        <Text style={styles.mark}>{item.mark || "–"}</Text>
        <Text style={styles.description}>{[item.description, item.dimensions].filter(Boolean).join(" · ")}</Text>
        <Text style={styles.quantity}>{item.quantity === null ? "–" : `${formatQuantity(item.quantity)} ${item.unit}`}</Text>
      </View>
      {item.element || item.level ? <Text style={styles.meta}>{[item.element, item.level].filter(Boolean).join(", ")}</Text> : null}
      {!item.verified ? <Text style={styles.warning}>Do sprawdzenia: liczby nie zgadzają się z tekstem strony, nie wchodzą do sum.</Text> : null}
      <Pressable
        accessibilityRole="link"
        onPress={() => openPage({ documentId: item.documentId, pageNo: item.pageNo, title: CATEGORY_LABELS[item.category], caption: item.quote || null })}
      >
        <Text style={styles.link}>Projekt, str. {item.pageNo} ›</Text>
      </Pressable>
    </View>
  );
};

// Material schedules (#67): what to order, read from the project's tables, with the page of every row. Kept on the phone.
export const ProjectSchedules = ({ projectId }: { projectId: string }) => {
  const schedule = useCachedResource(`schedules-${projectId}`, (connection) => fetchSchedule(connection, projectId), "Nie udało się pobrać zestawień.");
  const [category, setCategory] = useState<ScheduleCategory | null>(null);
  const { data, reload } = schedule;

  useEffect(() => {
    if (data?.status !== "reading" || schedule.offline) return;
    const timer = setTimeout(() => void reload(), READING_POLL_MS);
    return () => clearTimeout(timer);
  }, [data, reload, schedule.offline]);

  const items = data?.items.filter((item) => !category || item.category === category) ?? [];
  const totals = data?.totals.filter((total) => !category || total.category === category) ?? [];
  const present = CATEGORIES.filter((kind) => data?.items.some((item) => item.category === kind));
  const note = data ? statusNote(data) : null;

  return (
    <FlatList
      data={items}
      keyExtractor={(_, index) => String(index)}
      contentContainerStyle={styles.list}
      refreshing={schedule.loading && data !== null}
      onRefresh={() => void reload()}
      ListHeaderComponent={
        <View style={styles.header}>
          {schedule.loading && !data ? <ActivityIndicator color={colors.muted} /> : null}
          {schedule.error ? <Text style={styles.error}>{schedule.error}</Text> : null}
          {schedule.offline ? <Text style={styles.muted}>Bez zasięgu: zestawienia zapisane w telefonie.</Text> : null}
          {note ? <Text style={styles.muted}>{note}</Text> : null}
          {data?.failedPages.length ? <Text style={styles.error}>Nie udało się odczytać str. {data.failedPages.join(", ")}.</Text> : null}
          {present.length > 1 ? (
            <View style={styles.chips}>
              {[null, ...present].map((kind) => (
                <Pressable
                  key={kind ?? "all"}
                  accessibilityRole="button"
                  accessibilityState={{ selected: category === kind }}
                  onPress={() => setCategory(kind)}
                  style={[styles.chip, category === kind && styles.chipSelected]}
                >
                  <Text style={[styles.chipLabel, category === kind && styles.chipLabelSelected]}>{kind ? CATEGORY_LABELS[kind] : "Wszystko"}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {totals.length ? (
            <View style={styles.card}>
              <Text style={styles.section}>Do zamówienia</Text>
              {totals.map((total) => (
                <View key={`${total.category}|${total.label}|${total.unit}`} style={styles.row}>
                  <Text style={styles.description}>
                    {CATEGORY_LABELS[total.category]}: {total.label}
                  </Text>
                  <Text style={styles.quantity}>
                    {formatQuantity(total.quantity)} {total.unit}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          {items.length ? <Text style={styles.section}>Pozycje z projektu</Text> : null}
        </View>
      }
      renderItem={({ item }) => <ItemRow item={item} />}
      ListFooterComponent={
        items.length && data ? (
          <View style={styles.footer}>
            <Button
              label="Wyślij jako tekst"
              variant="secondary"
              onPress={() => void Share.share({ message: scheduleText(data, category ?? undefined) }).catch(() => undefined)}
            />
          </View>
        ) : undefined
      }
    />
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.md, gap: spacing.sm },
  header: { gap: spacing.sm },
  footer: { marginTop: spacing.md },
  section: { fontSize: 17, fontWeight: "600", color: colors.text },
  card: { gap: spacing.xs, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  unverified: { borderStyle: "dashed" },
  row: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
  mark: { minWidth: 32, fontSize: 15, fontWeight: "700", color: colors.text },
  description: { flex: 1, fontSize: 15, lineHeight: 21, color: colors.text },
  quantity: { fontSize: 15, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] },
  meta: { fontSize: 13, color: colors.muted },
  warning: { fontSize: 13, lineHeight: 18, color: colors.link },
  link: { fontSize: 15, fontWeight: "600", color: colors.link },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  chip: { minHeight: 36, paddingHorizontal: spacing.md, borderRadius: 18, borderWidth: 1, borderColor: colors.border, justifyContent: "center" },
  chipSelected: { backgroundColor: colors.text, borderColor: colors.text },
  chipLabel: { fontSize: 14, color: colors.text },
  chipLabelSelected: { color: colors.surface, fontWeight: "600" },
  muted: { fontSize: 15, lineHeight: 21, color: colors.muted },
  error: { fontSize: 15, color: colors.danger },
});
