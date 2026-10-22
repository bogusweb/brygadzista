import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, RefreshControl, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { formatDay } from "../../lib/defects";
import { cropPath, shareMessage } from "../../lib/questions";
import { answerQuestion, deleteQuestion, fetchQuestions, saveQuestion } from "../../lib/questionsApi";
import type { DesignerQuestion } from "../../lib/questions";
import { useConnection } from "../../lib/settings";
import { shareCrop } from "../../lib/shareCrop";
import { colors, radius, spacing } from "../../lib/theme";
import { Button } from "../Button";
import { usePageViewer } from "../chat/PageViewer";
import { Chip } from "../pins/DefectPanel";
import { confirm } from "../pins/pickPhotos";

// The register of questions to the designer (#73): what is still open, what was answered, and the answer itself,
// which the agent then takes into account.

type Filter = "open" | "answered" | "all";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "open", label: "Otwarte" },
  { value: "answered", label: "Odpowiedziane" },
  { value: "all", label: "Wszystkie" },
];

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : "Coś poszło nie tak.");

const QuestionRow = ({ question, onChange, onRemove }: { question: DesignerQuestion; onChange: (q: DesignerQuestion) => void; onRemove: () => void }) => {
  const connection = useConnection();
  const { id: projectId, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const openPage = usePageViewer();
  const [answer, setAnswer] = useState(question.answer ?? "");
  const [editing, setEditing] = useState(question.status === "open");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveAnswer = () =>
    run(async () => {
      const updated = await answerQuestion(connection, projectId, question.id, answer);
      onChange(updated);
      setEditing(updated.status === "open");
    });

  const remove = async () => {
    if (!(await confirm("Usunąć pytanie?", "Pytanie i odpowiedź znikną z rejestru.", "Usuń"))) return;
    await run(async () => {
      await deleteQuestion(connection, projectId, question.id);
      onRemove();
    });
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={[styles.badge, question.status === "answered" ? styles.badgeAnswered : styles.badgeOpen]}>
          {question.status === "answered" ? "Odpowiedziane" : "Otwarte"}
        </Text>
        <Text style={styles.meta}>
          {formatDay(question.createdAt.slice(0, 10))}
          {question.authorName ? ` · ${question.authorName}` : ""}
        </Text>
      </View>
      <Text style={styles.question}>{question.question}</Text>
      {question.documentId && question.pageNo ? (
        <Text
          accessibilityRole="link"
          style={styles.pageLink}
          onPress={() => openPage({ documentId: question.documentId!, pageNo: question.pageNo!, title: question.pageTitle })}
        >
          str. {question.pageNo}
          {question.pageTitle ? ` · ${question.pageTitle}` : ""}
        </Text>
      ) : null}
      {editing ? (
        <>
          <TextInput
            value={answer}
            onChangeText={setAnswer}
            placeholder="Wpisz odpowiedź projektanta"
            placeholderTextColor={colors.muted}
            multiline
            style={styles.input}
            accessibilityLabel="Odpowiedź projektanta"
          />
          <Button label="Zapisz odpowiedź" onPress={() => void saveAnswer()} loading={busy} disabled={!answer.trim()} />
        </>
      ) : (
        <View style={styles.answer}>
          <Text style={styles.answerLabel}>
            Odpowiedź{question.answeredAt ? ` z ${formatDay(question.answeredAt.slice(0, 10))}` : ""}
          </Text>
          <Text style={styles.answerText}>{question.answer}</Text>
          <Text accessibilityRole="button" style={styles.textButton} onPress={() => setEditing(true)}>
            Popraw odpowiedź
          </Text>
        </View>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.row}>
        {question.status === "open" ? (
          <Text accessibilityRole="button" style={styles.textButton} onPress={() => void Share.share({ message: shareMessage(question, name) })}>
            Wyślij ponownie
          </Text>
        ) : null}
        {question.documentId && question.pageNo ? (
          <Text
            accessibilityRole="button"
            style={styles.textButton}
            onPress={() => void run(() => shareCrop(connection, cropPath(question.documentId!, question.pageNo!, question.region), `str-${question.pageNo}`))}
          >
            Wyślij wycinek
          </Text>
        ) : null}
        <Text accessibilityRole="button" style={[styles.textButton, styles.danger]} onPress={() => void remove()}>
          Usuń
        </Text>
      </View>
    </View>
  );
};

export const ProjectQuestions = ({ projectId }: { projectId: string }) => {
  const connection = useConnection();
  const { name } = useLocalSearchParams<{ name?: string }>();
  const [questions, setQuestions] = useState<DesignerQuestion[] | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setQuestions(await fetchQuestions(connection, projectId));
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [connection, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () => (questions ?? []).filter((question) => filter === "all" || question.status === filter),
    [questions, filter],
  );

  const add = async () => {
    setAdding(true);
    try {
      const created = await saveQuestion(connection, projectId, { question: draft.trim() });
      setQuestions((current) => [created, ...(current ?? [])]);
      setDraft("");
      setFilter("open");
      await Share.share({ message: shareMessage(created, name) });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setAdding(false);
    }
  };

  const replace = (updated: DesignerQuestion) =>
    setQuestions((current) => (current ?? []).map((question) => (question.id === updated.id ? updated : question)));
  const remove = (id: string) => setQuestions((current) => (current ?? []).filter((question) => question.id !== id));

  return (
    <FlatList
      data={shown}
      keyExtractor={(question) => question.id}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={loading && questions !== null} onRefresh={() => void load()} />}
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={styles.intro}>
            Pytania o braki i sprzeczności w projekcie. Asystent przygotowuje je w czacie, a odpowiedzi projektanta bierze pod
            uwagę przy kolejnych pytaniach.
          </Text>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Własne pytanie do projektanta"
            placeholderTextColor={colors.muted}
            multiline
            style={styles.input}
            accessibilityLabel="Nowe pytanie do projektanta"
          />
          <Button label="Zapisz i wyślij" onPress={() => void add()} loading={adding} disabled={!draft.trim()} />
          <View style={styles.chips} accessibilityRole="radiogroup">
            {FILTERS.map((option) => (
              <Chip key={option.value} label={option.label} selected={filter === option.value} onPress={() => setFilter(option.value)} />
            ))}
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      }
      ListEmptyComponent={
        questions === null ? undefined : (
          <Text style={styles.empty}>{filter === "open" ? "Brak otwartych pytań." : "Brak pytań."}</Text>
        )
      }
      renderItem={({ item }) => <QuestionRow question={item} onChange={replace} onRemove={() => remove(item.id)} />}
    />
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.md, gap: spacing.md },
  header: { gap: spacing.sm },
  intro: { fontSize: 14, lineHeight: 20, color: colors.muted },
  chips: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  card: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  cardHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  badge: { fontSize: 12, fontWeight: "700", paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.md, overflow: "hidden" },
  badgeOpen: { color: colors.danger, backgroundColor: colors.dangerBg },
  badgeAnswered: { color: colors.text, backgroundColor: colors.border },
  meta: { fontSize: 13, color: colors.muted },
  question: { fontSize: 16, lineHeight: 22, color: colors.text },
  pageLink: { fontSize: 14, color: colors.link, fontWeight: "600", textDecorationLine: "underline" },
  input: {
    minHeight: 72,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: 15,
    color: colors.text,
    textAlignVertical: "top",
  },
  answer: { gap: spacing.xs, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.background },
  answerLabel: { fontSize: 12, fontWeight: "700", color: colors.muted },
  answerText: { fontSize: 15, lineHeight: 21, color: colors.text },
  row: { flexDirection: "row", gap: spacing.md, flexWrap: "wrap" },
  textButton: { fontSize: 14, fontWeight: "600", color: colors.link, paddingVertical: spacing.xs },
  danger: { color: colors.danger },
  error: { fontSize: 13, color: colors.danger },
  empty: { fontSize: 15, color: colors.muted, textAlign: "center", paddingVertical: spacing.lg },
});
