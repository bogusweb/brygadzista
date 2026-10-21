import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { localDate, shiftDate } from "../../lib/diary";
import { recordingFormat } from "../../lib/diaryAudio";
import { colors, radius, spacing } from "../../lib/theme";
import { Button } from "../Button";
import { MAX_RECORDING_SECONDS, useDiaryRecorder } from "./useDiaryRecorder";
import type { FinishedRecording } from "./useDiaryRecorder";

const clock = (millis: number) => {
  const seconds = Math.floor(millis / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const DayChoice = ({ date, onChange }: { date: string; onChange: (date: string) => void }) => {
  const today = localDate();
  const options = [
    { date: today, label: "Dziś" },
    { date: shiftDate(today, -1), label: "Wczoraj" },
  ];
  return (
    <View style={styles.days} accessibilityRole="radiogroup">
      {options.map((option) => {
        const selected = option.date === date;
        return (
          <Pressable
            key={option.date}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.date)}
            style={[styles.day, selected && styles.daySelected]}
          >
            <Text style={[styles.dayLabel, selected && styles.dayLabelSelected]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
};

type Props = {
  onRecording: (recording: FinishedRecording, date: string) => Promise<void>;
  onText: (text: string, date: string) => Promise<void>;
};

// Half a minute of talking after work becomes the day's entry. Typing is there for a browser without recording,
// a noisy site, or a correction.
export const DiaryRecorder = ({ onRecording, onText }: Props) => {
  const [date, setDate] = useState(localDate);
  const [typing, setTyping] = useState(!recordingFormat.supported);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const finished = useCallback(
    (recording: FinishedRecording) => {
      setSaveError(null);
      onRecording(recording, date).catch(() => setSaveError("Nie udało się zapisać nagrania na telefonie. Spróbuj jeszcze raz."));
    },
    [date, onRecording],
  );
  const recorder = useDiaryRecorder(finished);

  const saveText = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onText(text.trim(), date);
      setText("");
    } catch {
      setSaveError("Nie udało się zapisać wpisu. Spróbuj jeszcze raz.");
    } finally {
      setSaving(false);
    }
  };

  const error = recorder.error ?? saveError;
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Wpis dnia</Text>
      <DayChoice date={date} onChange={setDate} />
      {typing ? (
        <View style={styles.typing}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder="Np. zalaliśmy ławy, przyszła dostawa bloczków, padało od 14"
            placeholderTextColor={colors.muted}
            style={styles.input}
            accessibilityLabel="Tekst wpisu dnia"
          />
          <Button label="Uporządkuj wpis" onPress={() => void saveText()} loading={saving} disabled={!text.trim()} />
        </View>
      ) : (
        <View style={styles.recorder}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={recorder.recording ? "Zakończ nagranie" : "Nagraj podsumowanie dnia"}
            onPress={() => void (recorder.recording ? recorder.stop() : recorder.start())}
            disabled={recorder.starting}
            style={({ pressed }) => [styles.mic, recorder.recording && styles.micRecording, pressed && styles.pressed]}
          >
            {recorder.starting ? (
              <ActivityIndicator color={colors.accentText} />
            ) : (
              <View style={recorder.recording ? styles.stopIcon : styles.recordIcon} />
            )}
          </Pressable>
          <Text style={styles.hint}>
            {recorder.recording
              ? `Nagrywam ${clock(recorder.durationMillis)} / ${clock(MAX_RECORDING_SECONDS * 1000)}. Dotknij, żeby zakończyć.`
              : "Dotknij i powiedz, co dziś zrobiliście: prace, ludzie, dostawy, pogoda, problemy."}
          </Text>
        </View>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {recordingFormat.supported ? (
        <Pressable accessibilityRole="button" onPress={() => setTyping(!typing)} disabled={recorder.recording}>
          <Text style={styles.link}>{typing ? "Nagraj zamiast pisać" : "Wpisz zamiast nagrywać"}</Text>
        </Pressable>
      ) : (
        <Text style={styles.hint}>Ta przeglądarka nie nagrywa w formacie, który rozumie model. Wpisz tekst albo nagraj w aplikacji.</Text>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { fontSize: 17, fontWeight: "600", color: colors.text },
  days: { flexDirection: "row", gap: spacing.sm },
  day: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: "center",
  },
  daySelected: { backgroundColor: colors.text, borderColor: colors.text },
  dayLabel: { fontSize: 15, color: colors.text },
  dayLabelSelected: { color: colors.surface, fontWeight: "600" },
  recorder: { alignItems: "center", gap: spacing.md },
  mic: { width: 88, height: 88, borderRadius: 44, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  micRecording: { backgroundColor: colors.danger },
  recordIcon: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.accentText },
  stopIcon: { width: 26, height: 26, borderRadius: 4, backgroundColor: colors.accentText },
  pressed: { transform: [{ scale: 0.96 }] },
  hint: { fontSize: 14, lineHeight: 20, color: colors.muted, textAlign: "center" },
  typing: { gap: spacing.sm },
  input: {
    minHeight: 120,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: 16,
    lineHeight: 22,
    color: colors.text,
    textAlignVertical: "top",
  },
  error: { fontSize: 14, color: colors.danger },
  link: { fontSize: 15, color: colors.link, textAlign: "center", paddingVertical: spacing.xs },
});
