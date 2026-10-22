import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { crewToLines, isIsoDate, linesToCrew, linesToList, listToLines } from "../../lib/diary";
import type { DiaryEntry, DiaryNote, DiaryReference } from "../../lib/diary";
import { ApiError } from "../../lib/api";
import { colors, radius, spacing } from "../../lib/theme";
import { Button } from "../Button";

const EMPTY_ENTRY: DiaryEntry = { summary: "", work: [], people: [], crew: [], deliveries: [], weather: null, problems: [], references: [] };

type Draft = { date: string; summary: string; work: string; people: string; crew: string; deliveries: string; weather: string; problems: string };

const draftOf = (note: DiaryNote): Draft => {
  const entry = note.entry ?? EMPTY_ENTRY;
  return {
    date: note.entryDate,
    summary: entry.summary,
    work: listToLines(entry.work),
    people: listToLines(entry.people),
    crew: crewToLines(entry.crew ?? []),
    deliveries: listToLines(entry.deliveries),
    weather: entry.weather ?? "",
    problems: listToLines(entry.problems),
  };
};

const Field = ({
  label,
  value,
  onChange,
  multiline = false,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  hint?: string;
}) => (
  <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput
      value={value}
      onChangeText={onChange}
      multiline={multiline}
      accessibilityLabel={label}
      style={[styles.input, multiline && styles.multiline]}
    />
    {hint ? <Text style={styles.hint}>{hint}</Text> : null}
  </View>
);

type Props = {
  note: DiaryNote;
  onClose: () => void;
  onSave: (changes: { entryDate: string; entry: DiaryEntry }) => Promise<void>;
  onResort: (transcript: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onOpenReference: (reference: DiaryReference) => void;
};

// The model's entry is a draft: everything in it can be corrected by hand, and the transcript can be fixed and sorted again.
export const NoteEditor = ({ note, onClose, onSave, onResort, onDelete, onOpenReference }: Props) => {
  const [draft, setDraft] = useState(() => draftOf(note));
  const [transcript, setTranscript] = useState(note.transcript);
  const [busy, setBusy] = useState<"save" | "resort" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (key: keyof Draft) => (value: string) => setDraft((current) => ({ ...current, [key]: value }));

  const run = async (kind: "save" | "resort" | "delete", action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Nie udało się. Sprawdź zasięg i spróbuj ponownie.");
    } finally {
      setBusy(null);
    }
  };

  const save = () => {
    if (!isIsoDate(draft.date)) {
      setError("Data w formacie RRRR-MM-DD, np. 2026-10-21.");
      return;
    }
    const entry: DiaryEntry = {
      summary: draft.summary.trim(),
      work: linesToList(draft.work),
      people: linesToList(draft.people),
      crew: linesToCrew(draft.crew),
      deliveries: linesToList(draft.deliveries),
      weather: draft.weather.trim() || null,
      problems: linesToList(draft.problems),
      references: note.entry?.references ?? [],
    };
    void run("save", () => onSave({ entryDate: draft.date, entry }));
  };

  const references = note.entry?.references ?? [];
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Text style={styles.title}>Wpis dnia</Text>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
            <Text style={styles.link}>Zamknij</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Field label="Data" value={draft.date} onChange={set("date")} hint="RRRR-MM-DD" />
          <Field label="Podsumowanie" value={draft.summary} onChange={set("summary")} multiline />
          <Field label="Wykonane prace" value={draft.work} onChange={set("work")} multiline hint="Każda praca w osobnej linii." />
          <Field
            label="Obsada"
            value={draft.crew}
            onChange={set("crew")}
            multiline
            hint="Liczba i ekipa w osobnej linii, np. „4 zbrojarze (Stal-Bud)”."
          />
          <Field label="Ludzie na budowie" value={draft.people} onChange={set("people")} multiline />
          <Field label="Dostawy" value={draft.deliveries} onChange={set("deliveries")} multiline />
          <Field label="Pogoda" value={draft.weather} onChange={set("weather")} />
          <Field label="Problemy i braki" value={draft.problems} onChange={set("problems")} multiline />
          {references.length ? (
            <View style={styles.field}>
              <Text style={styles.label}>Dotyczy projektu</Text>
              {references.map((reference) => (
                <Pressable
                  key={`${reference.documentId}:${reference.pageNo}`}
                  accessibilityRole="button"
                  onPress={() => onOpenReference(reference)}
                  style={({ pressed }) => [styles.reference, pressed && styles.pressed]}
                >
                  <Text style={styles.referencePage}>
                    Str. {reference.pageNo}
                    {reference.title ? ` – ${reference.title}` : ""}
                  </Text>
                  <Text style={styles.hint}>{reference.note}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button label="Zapisz zmiany" onPress={save} loading={busy === "save"} disabled={busy !== null} />

          <View style={styles.divider} />
          <Field
            label={note.source === "audio" ? "Tekst nagrania" : "Tekst wpisu"}
            value={transcript}
            onChange={setTranscript}
            multiline
            hint="Popraw, jeśli model źle usłyszał, i uporządkuj wpis od nowa. Zmiany w polach wyżej zostaną zastąpione."
          />
          <Button
            label="Uporządkuj ponownie"
            variant="secondary"
            onPress={() => void run("resort", () => onResort(transcript.trim()))}
            loading={busy === "resort"}
            disabled={busy !== null || !transcript.trim()}
          />
          {confirmDelete ? (
            <View style={styles.confirm}>
              <Text style={styles.hint}>Usunąć ten wpis razem z nagraniem? Tego nie da się cofnąć.</Text>
              <Button label="Usuń wpis" onPress={() => void run("delete", onDelete)} loading={busy === "delete"} disabled={busy !== null} />
              <Button label="Zostaw" variant="secondary" onPress={() => setConfirmDelete(false)} />
            </View>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => setConfirmDelete(true)}>
              <Text style={styles.danger}>Usuń wpis</Text>
            </Pressable>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { fontSize: 18, fontWeight: "600", color: colors.text },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  field: { gap: spacing.xs },
  label: { fontSize: 14, fontWeight: "600", color: colors.text },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: 16,
    lineHeight: 22,
    color: colors.text,
  },
  multiline: { minHeight: 88, textAlignVertical: "top" },
  hint: { fontSize: 13, lineHeight: 18, color: colors.muted },
  reference: { padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  referencePage: { fontSize: 15, fontWeight: "500", color: colors.link },
  pressed: { opacity: 0.7 },
  error: { fontSize: 14, color: colors.danger },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  confirm: { gap: spacing.sm },
  link: { fontSize: 16, color: colors.link },
  danger: { fontSize: 15, color: colors.danger, textAlign: "center", paddingVertical: spacing.sm },
});
