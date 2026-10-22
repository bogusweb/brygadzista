import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { progress, withPending } from "../../lib/checklists";
import type { Checklist, ChecklistItem, ChecklistResult } from "../../lib/checklists";
import { formatDateTime, pluralPl } from "../../lib/format";
import { colors, radius, spacing } from "../../lib/theme";
import { Button } from "../Button";
import { usePageViewer } from "../chat/PageViewer";
import { confirm } from "../pins/pickPhotos";
import type { useChecklists } from "./useChecklists";

const GENERATING_POLL_MS = 3_000;

type Checklists = ReturnType<typeof useChecklists>;

const Checkbox = ({ checked }: { checked: boolean }) => (
  <View style={[styles.box, checked && styles.boxChecked]}>{checked ? <Text style={styles.tick}>✓</Text> : null}</View>
);

const ItemRow = ({
  item,
  onToggle,
  onNote,
  onOpenSource,
}: {
  item: ChecklistItem;
  onToggle: () => void;
  onNote: (note: string | null) => void;
  onOpenSource: () => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.note ?? "");
  const saveNote = () => {
    setEditing(false);
    const note = draft.trim() || null;
    if (note !== item.note) onNote(note);
  };
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: item.checked }}
        onPress={onToggle}
        style={({ pressed }) => [styles.itemHead, pressed && styles.pressed]}
      >
        <Checkbox checked={item.checked} />
        <View style={styles.itemText}>
          <Text style={[styles.itemLabel, item.checked && styles.itemLabelDone]}>{item.label}</Text>
          {item.value ? <Text style={styles.value}>{item.value}</Text> : null}
          {item.status === "to_confirm" ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>Do potwierdzenia</Text>
            </View>
          ) : null}
        </View>
      </Pressable>
      {item.source ? (
        <Pressable accessibilityRole="link" accessibilityHint="Otwiera stronę projektu" onPress={onOpenSource} style={styles.source}>
          {item.source.quote ? (
            <Text style={styles.quote} numberOfLines={3}>
              „{item.source.quote}”
            </Text>
          ) : null}
          <Text style={styles.link}>{item.status === "found" ? "Projekt" : "Zobacz w projekcie"}, str. {item.source.pageNo} ›</Text>
        </Pressable>
      ) : item.status === "to_confirm" ? (
        <Text style={styles.muted}>Projekt nic o tym nie mówi. Ustal z projektantem lub kierownikiem budowy.</Text>
      ) : null}
      {editing ? (
        <View style={styles.noteEdit}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Notatka do pozycji"
            multiline
            autoFocus
            style={styles.input}
            onBlur={saveNote}
          />
          <Pressable accessibilityRole="button" onPress={saveNote}>
            <Text style={styles.link}>Zapisz notatkę</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable accessibilityRole="button" onPress={() => setEditing(true)}>
          {item.note ? <Text style={styles.note}>{item.note}</Text> : null}
          <Text style={styles.link}>{item.note ? "Zmień notatkę" : "+ Notatka"}</Text>
        </Pressable>
      )}
      {item.checked && (item.checkedBy || item.checkedAt) ? (
        <Text style={styles.meta}>
          {[item.checkedBy ?? "czeka na zasięg", item.checkedAt ? formatDateTime(item.checkedAt) : null].filter(Boolean).join(" · ")}
        </Text>
      ) : null}
    </View>
  );
};

const ResultRow = ({ result }: { result: ChecklistResult }) => {
  const [open, setOpen] = useState(false);
  const { total, checked } = progress(result.items);
  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}>
        <Text style={styles.itemLabel}>
          Zakończona {formatDateTime(result.completedAt)} · {result.completedBy}
        </Text>
        <Text style={styles.meta}>
          Sprawdzone {checked} z {total}
          {result.pending ? " · czeka na zasięg" : ""}
        </Text>
      </Pressable>
      {open
        ? result.items.map((item, index) => (
            <Text key={index} style={styles.resultItem}>
              {item.checked ? "✓" : "✗"} {item.label}
              {item.value ? `: ${item.value}` : ""}
              {item.status === "to_confirm" ? " (do potwierdzenia)" : ""}
              {item.note ? ` · ${item.note}` : ""}
            </Text>
          ))
        : null}
    </View>
  );
};

export const ChecklistView = ({ id, checklists, onBack }: { id: string; checklists: Checklists; onBack: () => void }) => {
  const { details, loadDetail, events, refused, check, complete, dropRefused } = checklists;
  const openPage = usePageViewer();
  const [error, setError] = useState<string | null>(null);
  const loaded = details[id];
  const checklist: Checklist | null = useMemo(() => (loaded ? withPending(loaded.data, events) : null), [loaded, events]);
  const pending = events.filter((event) => event.checklistId === id).length;

  useEffect(() => {
    loadDetail(id).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Nie udało się pobrać checklisty."));
  }, [id, loadDetail]);

  // The server fills the checklist in the background; it is asked again until it is done.
  const generating = checklist?.status === "generating";
  useEffect(() => {
    if (!generating) return;
    const timer = setTimeout(() => void loadDetail(id).catch(() => undefined), GENERATING_POLL_MS);
    return () => clearTimeout(timer);
  }, [generating, id, loadDetail, loaded]);

  const back = (
    <Pressable accessibilityRole="button" onPress={onBack} style={styles.back}>
      <Text style={styles.link}>‹ Wszystkie checklisty</Text>
    </Pressable>
  );

  if (!checklist) {
    return (
      <View style={styles.centered}>
        {back}
        {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.muted} />}
      </View>
    );
  }

  const { total, checked, toConfirm } = progress(checklist.items);
  const finish = async () => {
    const open = total - checked;
    if (
      open > 0 &&
      !(await confirm(
        "Nie wszystko sprawdzone",
        `${pluralPl(open, "pozycja nie jest odhaczona", "pozycje nie są odhaczone", "pozycji nie jest odhaczonych")}. Zakończyć mimo to?`,
        "Zakończ",
      ))
    ) {
      return;
    }
    await complete(id);
  };

  return (
    <FlatList
      data={checklist.status === "ready" ? checklist.items : []}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <View style={styles.header}>
          {back}
          <Text style={styles.title}>{checklist.title}</Text>
          {checklist.when ? <Text style={styles.muted}>{checklist.when}</Text> : null}
          {checklist.status === "ready" ? (
            <Text style={styles.summary}>
              Sprawdzone {checked} z {total}
              {toConfirm ? ` · ${toConfirm} do potwierdzenia` : ""}
              {pending ? ` · ${pluralPl(pending, "zmiana czeka", "zmiany czekają", "zmian czeka")} na zasięg` : ""}
              {loaded?.offline ? " · bez zasięgu" : ""}
            </Text>
          ) : null}
          {generating ? (
            <View style={styles.row}>
              <ActivityIndicator color={colors.muted} />
              <Text style={styles.muted}>Wypełniam checklistę z projektu…</Text>
            </View>
          ) : null}
          {checklist.status === "error" ? <Text style={styles.error}>{checklist.error ?? "Nie udało się wypełnić checklisty."}</Text> : null}
          {refused[id] ? (
            <View style={styles.card}>
              <Text style={styles.error}>Serwer nie przyjął zmian: {refused[id]}</Text>
              <Pressable accessibilityRole="button" onPress={() => void dropRefused(id)}>
                <Text style={styles.danger}>Usuń te zmiany z telefonu</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      }
      renderItem={({ item }) => (
        <ItemRow
          item={item}
          onToggle={() => void check(id, item.id, !item.checked, item.note)}
          onNote={(note) => void check(id, item.id, item.checked, note)}
          onOpenSource={() =>
            item.source &&
            openPage({ documentId: item.source.documentId, pageNo: item.source.pageNo, title: item.label, caption: item.source.quote })
          }
        />
      )}
      ListFooterComponent={
        checklist.status === "ready" ? (
          <View style={styles.footer}>
            <Button label="Zakończ checklistę" onPress={() => void finish()} />
            {checklist.results.length ? <Text style={styles.section}>Zapisane wyniki</Text> : null}
            {checklist.results.map((result) => (
              <ResultRow key={result.id} result={result} />
            ))}
          </View>
        ) : undefined
      }
    />
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.md, gap: spacing.sm },
  header: { gap: spacing.xs, marginBottom: spacing.sm },
  footer: { gap: spacing.sm, marginTop: spacing.md },
  back: { paddingVertical: spacing.xs, alignSelf: "flex-start" },
  centered: { flex: 1, gap: spacing.md, padding: spacing.md },
  title: { fontSize: 22, fontWeight: "700", color: colors.text },
  section: { fontSize: 17, fontWeight: "600", color: colors.text, marginTop: spacing.sm },
  summary: { fontSize: 14, color: colors.muted },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  card: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  itemHead: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
  itemText: { flex: 1, gap: spacing.xs },
  itemLabel: { fontSize: 16, fontWeight: "600", color: colors.text },
  itemLabelDone: { color: colors.muted },
  value: { fontSize: 15, lineHeight: 21, color: colors.text },
  box: { width: 28, height: 28, borderRadius: 6, borderWidth: 2, borderColor: colors.muted, alignItems: "center", justifyContent: "center" },
  boxChecked: { backgroundColor: colors.accent, borderColor: colors.accent },
  tick: { color: colors.accentText, fontSize: 17, fontWeight: "700" },
  badge: { alignSelf: "flex-start", paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.md, backgroundColor: "#FCEFD9" },
  badgeText: { fontSize: 12, fontWeight: "600", color: colors.link },
  source: { gap: 2, paddingLeft: 44 },
  quote: { fontSize: 14, lineHeight: 20, fontStyle: "italic", color: colors.muted },
  link: { fontSize: 15, fontWeight: "600", color: colors.link },
  danger: { fontSize: 15, fontWeight: "600", color: colors.danger },
  note: { fontSize: 15, lineHeight: 21, color: colors.text },
  noteEdit: { gap: spacing.sm },
  input: { minHeight: 60, padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, fontSize: 15, color: colors.text },
  muted: { fontSize: 14, lineHeight: 20, color: colors.muted },
  meta: { fontSize: 13, color: colors.muted },
  error: { fontSize: 15, color: colors.danger },
  resultItem: { fontSize: 14, lineHeight: 20, color: colors.text },
  pressed: { opacity: 0.8 },
});
