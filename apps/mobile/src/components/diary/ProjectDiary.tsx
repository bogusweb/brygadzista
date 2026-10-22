import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { diaryReportUrl } from "../../lib/api";
import { useConnection } from "../../lib/settings";
import { crewTotal, dayCrew, dayLabel, edbDraft, formatDay, groupByDay, isSorting, localDate, shiftDate } from "../../lib/diary";
import type { DiaryEntry, DiaryNote } from "../../lib/diary";
import type { QueuedNote } from "../../lib/diaryQueue";
import { colors, radius, spacing } from "../../lib/theme";
import { usePageViewer } from "../chat/PageViewer";
import { DiaryRecorder } from "./DiaryRecorder";
import { EdbDraft } from "./EdbDraft";
import { NoteEditor } from "./NoteEditor";
import { useDiary } from "./useDiary";

const time = (iso: string) => new Date(iso).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });

const QueuedRow = ({ note, onRemove }: { note: QueuedNote; onRemove: () => void }) => (
  <View style={[styles.card, styles.queued]}>
    <Text style={styles.cardTitle}>
      {note.kind === "audio" ? "Nagranie" : "Wpis tekstowy"} z {time(note.createdAt)} · {formatDay(note.date)}
    </Text>
    {note.error ? (
      <>
        <Text style={styles.error}>{note.error}</Text>
        <Pressable accessibilityRole="button" onPress={onRemove}>
          <Text style={styles.danger}>Usuń z telefonu</Text>
        </Pressable>
      </>
    ) : (
      <Text style={styles.muted}>Czeka na zasięg. Wyślę je, gdy serwer odpowie.</Text>
    )}
  </View>
);

const counts = (entry: DiaryEntry) =>
  [
    entry.crew?.length ? `obsada: ${crewTotal(entry.crew)} os.` : null,
    entry.work.length ? `prace: ${entry.work.length}` : null,
    entry.deliveries.length ? `dostawy: ${entry.deliveries.length}` : null,
    entry.problems.length ? `problemy: ${entry.problems.length}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

const NoteRow = ({ note, onOpen, onRetry }: { note: DiaryNote; onOpen: () => void; onRetry: () => void }) => {
  if (isSorting(note)) {
    return (
      <View style={[styles.card, styles.row]}>
        <ActivityIndicator color={colors.muted} />
        <Text style={styles.muted}>{note.source === "audio" ? "Przepisuję nagranie i porządkuję wpis…" : "Porządkuję wpis…"}</Text>
      </View>
    );
  }
  if (note.status === "error" || !note.entry) {
    return (
      <View style={styles.card}>
        <Text style={styles.error}>{note.error ?? "Wpis nie jest gotowy."}</Text>
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" onPress={onRetry}>
            <Text style={styles.link}>Spróbuj ponownie</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onOpen}>
            <Text style={styles.link}>Popraw tekst</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  const details = counts(note.entry);
  return (
    <Pressable accessibilityRole="button" onPress={onOpen} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <Text style={styles.cardTitle}>{note.entry.summary || "Wpis dnia"}</Text>
      {details ? <Text style={styles.muted}>{details}</Text> : null}
      {note.entry.weather ? <Text style={styles.muted}>Pogoda: {note.entry.weather}</Text> : null}
      <Text style={styles.meta}>
        {time(note.createdAt)}
        {note.authorName ? ` · ${note.authorName}` : ""}
        {note.edited ? " · poprawiony" : ""}
      </Text>
    </Pressable>
  );
};

type Row =
  | { type: "queued"; note: QueuedNote }
  | { type: "day"; date: string; notes: DiaryNote[] }
  | { type: "note"; note: DiaryNote };

// The project's daily log (#69): the recorder on top, notes waiting for signal, then the days, newest first.
export const ProjectDiary = ({ projectId }: { projectId: string }) => {
  const diary = useDiary(projectId);
  const connection = useConnection();
  const openReport = (from: string, to: string) => void Linking.openURL(diaryReportUrl(connection, projectId, from, to));
  const openPage = usePageViewer();
  const [editing, setEditing] = useState<DiaryNote | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, error, loading, offline } = diary.notes;

  const rows = useMemo<Row[]>(
    () => [
      ...diary.queued.map((note) => ({ type: "queued" as const, note })),
      ...groupByDay(data ?? []).flatMap(({ date, notes }) => [
        { type: "day" as const, date, notes },
        ...notes.map((note) => ({ type: "note" as const, note })),
      ]),
    ],
    [data, diary.queued],
  );

  const retry = (id: string) => {
    setActionError(null);
    diary.retry(id).catch(() => setActionError("Nie udało się ponowić. Sprawdź zasięg."));
  };

  const openDraft = (date: string, notes: DiaryNote[]) => {
    const entries = notes.flatMap((note) => (note.entry && note.status === "ready" ? [note.entry] : []));
    setDraft(edbDraft(date, entries, notes.find((note) => note.siteWeather)?.siteWeather?.text ?? null));
  };

  const renderRow = ({ item }: { item: Row }) => {
    if (item.type === "queued") return <QueuedRow note={item.note} onRemove={() => void diary.removeQueued(item.note.clientId)} />;
    if (item.type === "day") {
      const ready = item.notes.some((note) => note.status === "ready" && note.entry);
      const weather = item.notes.find((note) => note.siteWeather)?.siteWeather;
      const crew = crewTotal(dayCrew(item.notes.flatMap((note) => (note.entry ? [note.entry] : []))));
      return (
        <View style={styles.day}>
          <View style={styles.dayHeader}>
            <Text style={styles.dayTitle}>{dayLabel(item.date)}</Text>
            {ready ? (
              <View style={styles.dayActions}>
                <Pressable accessibilityRole="button" onPress={() => openReport(item.date, item.date)} hitSlop={8}>
                  <Text style={styles.link}>PDF</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => openDraft(item.date, item.notes)} hitSlop={8}>
                  <Text style={styles.link}>Szkic do EDB</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
          {weather || crew ? (
            <Text style={styles.muted}>{[weather ? `Pogoda: ${weather.text}` : null, crew ? `obsada: ${crew} os.` : null].filter(Boolean).join(" · ")}</Text>
          ) : null}
        </View>
      );
    }
    return <NoteRow note={item.note} onOpen={() => setEditing(item.note)} onRetry={() => retry(item.note.id)} />;
  };

  return (
    <>
      <FlatList
        data={rows}
        keyExtractor={(row) => (row.type === "day" ? `day-${row.date}` : row.type === "queued" ? `q-${row.note.clientId}` : row.note.id)}
        renderItem={renderRow}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.header}>
            <DiaryRecorder onRecording={diary.addRecording} onText={diary.addText} />
            {data?.length ? (
              <View style={styles.exportRow}>
                <Text style={styles.muted}>Dziennik PDF:</Text>
                <Pressable accessibilityRole="button" onPress={() => openReport(shiftDate(localDate(), -6), localDate())} hitSlop={8}>
                  <Text style={styles.link}>7 dni</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => openReport(shiftDate(localDate(), -29), localDate())} hitSlop={8}>
                  <Text style={styles.link}>30 dni</Text>
                </Pressable>
              </View>
            ) : null}
            {offline ? <Text style={styles.notice}>Brak połączenia z serwerem. Pokazuję zapisany dziennik.</Text> : null}
            {error && !data ? <Text style={styles.error}>{error}</Text> : null}
            {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.muted} style={styles.empty} />
          ) : (
            <Text style={[styles.muted, styles.empty]}>Nie ma jeszcze wpisów. Nagraj pierwszy dzień.</Text>
          )
        }
      />
      {editing ? (
        <NoteEditor
          note={editing}
          onClose={() => setEditing(null)}
          onSave={(changes) => diary.update(editing.id, changes)}
          onResort={async (transcript) => {
            await diary.update(editing.id, { transcript });
            await diary.retry(editing.id);
          }}
          onDelete={() => diary.remove(editing.id)}
          onOpenReference={(reference) => {
            setEditing(null);
            openPage({ documentId: reference.documentId, pageNo: reference.pageNo, title: reference.title, caption: reference.note });
          }}
        />
      ) : null}
      {draft !== null ? <EdbDraft text={draft} onClose={() => setDraft(null)} /> : null}
    </>
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  header: { gap: spacing.sm, marginBottom: spacing.sm },
  card: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  queued: { borderStyle: "dashed" },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  pressed: { opacity: 0.7 },
  cardTitle: { fontSize: 16, fontWeight: "500", lineHeight: 22, color: colors.text },
  muted: { fontSize: 14, lineHeight: 20, color: colors.muted },
  meta: { fontSize: 13, color: colors.muted },
  error: { fontSize: 14, lineHeight: 20, color: colors.danger },
  notice: { fontSize: 14, color: colors.muted },
  actions: { flexDirection: "row", gap: spacing.lg },
  link: { fontSize: 15, color: colors.link },
  danger: { fontSize: 15, color: colors.danger },
  day: { gap: 2, marginTop: spacing.md },
  dayHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  dayActions: { flexDirection: "row", gap: spacing.lg },
  exportRow: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  dayTitle: { fontSize: 15, fontWeight: "600", color: colors.text },
  empty: { marginTop: spacing.lg, textAlign: "center" },
});
