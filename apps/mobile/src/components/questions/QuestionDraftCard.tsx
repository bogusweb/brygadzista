import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Image, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { serverImageSource } from "../../lib/api";
import { cropPath, shareMessage } from "../../lib/questions";
import { saveQuestion } from "../../lib/questionsApi";
import type { DesignerQuestion, QuestionDraft } from "../../lib/questions";
import { useConnection } from "../../lib/settings";
import { shareCrop } from "../../lib/shareCrop";
import { colors, radius, spacing } from "../../lib/theme";
import { Button } from "../Button";

// The agent's draft of a question to the designer (#73). The contractor can edit it, then it is saved in the project's
// register and handed to the system share sheet; the app itself never sends anything.
export const QuestionDraftCard = ({ draft }: { draft: QuestionDraft }) => {
  const connection = useConnection();
  const { id: projectId, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const [text, setText] = useState(draft.question);
  const [saved, setSaved] = useState<DesignerQuestion | null>(null);
  const [busy, setBusy] = useState<"send" | "crop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const crop = cropPath(draft.documentId, draft.pageNo, draft.region);

  const send = async () => {
    setBusy("send");
    setError(null);
    try {
      const question =
        saved ?? (await saveQuestion(connection, projectId, { ...draft, question: text.trim() || draft.question }));
      setSaved(question);
      await Share.share({ message: shareMessage(question, name), title: "Pytanie do projektanta" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się zapisać pytania.");
    } finally {
      setBusy(null);
    }
  };

  const sendCrop = async () => {
    setBusy("crop");
    setError(null);
    try {
      await shareCrop(connection, crop, `str-${draft.pageNo}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się pobrać wycinka.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Pytanie do projektanta</Text>
      <Text style={styles.meta}>
        str. {draft.pageNo}
        {draft.pageTitle ? ` · ${draft.pageTitle}` : ""}
        {draft.reason ? ` · ${draft.reason}` : ""}
      </Text>
      <Image source={serverImageSource(connection, crop)} style={styles.crop} resizeMode="contain" accessibilityLabel={`Wycinek strony ${draft.pageNo}`} />
      <TextInput
        value={text}
        onChangeText={setText}
        editable={!saved}
        multiline
        style={styles.input}
        accessibilityLabel="Treść pytania"
      />
      {saved ? <Text style={styles.saved}>Zapisane w zakładce Pytania. Odpowiedź projektanta wpiszesz tam.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <Button label={saved ? "Wyślij ponownie" : "Zapisz i wyślij"} onPress={() => void send()} loading={busy === "send"} disabled={busy !== null} />
        <Button label="Wyślij wycinek" variant="secondary" onPress={() => void sendCrop()} loading={busy === "crop"} disabled={busy !== null} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  title: { fontSize: 16, fontWeight: "700", color: colors.text },
  meta: { fontSize: 13, color: colors.muted },
  crop: { width: "100%", height: 180, borderRadius: radius.md, backgroundColor: colors.background },
  input: {
    minHeight: 96,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: 15,
    lineHeight: 21,
    color: colors.text,
    textAlignVertical: "top",
  },
  saved: { fontSize: 13, color: colors.muted },
  error: { fontSize: 13, color: colors.danger },
  actions: { gap: spacing.sm },
});
