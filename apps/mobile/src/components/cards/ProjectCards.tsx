import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { KIND_LABELS } from "../../lib/cards";
import type { CardKind, ElementCard } from "../../lib/cards";
import { formatDateTime, pluralPl } from "../../lib/format";
import { colors, radius, spacing } from "../../lib/theme";
import { Button } from "../Button";
import { CardView } from "./CardView";
import { useCards } from "./useCards";

const KINDS: CardKind[] = ["room", "partition"];

const PLACEHOLDERS: Record<CardKind, string> = { room: "np. Łazienka 1.04", partition: "np. Ściana zewnętrzna SZ1, dach" };

const summaryOf = (card: ElementCard) => {
  if (card.status === "generating") return "Zbieram dane z projektu…";
  if (card.status === "error") return card.error ?? "Nie udało się zebrać danych";
  const found = card.fields.filter((field) => field.value).length;
  return [
    `${found} z ${card.fields.length} wartości z projektu`,
    card.kind === "partition" ? pluralPl(card.layers.length, "warstwa", "warstwy", "warstw") : null,
    card.generatedAt ? formatDateTime(card.generatedAt) : null,
  ]
    .filter(Boolean)
    .join(" · ");
};

const NewCard = ({ onCreate, busy }: { onCreate: (kind: CardKind, name: string) => void; busy: boolean }) => {
  const [kind, setKind] = useState<CardKind>("room");
  const [name, setName] = useState("");
  return (
    <View style={styles.card}>
      <Text style={styles.section}>Nowa karta</Text>
      <View style={styles.kinds} accessibilityRole="radiogroup">
        {KINDS.map((option) => (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ selected: kind === option }}
            onPress={() => setKind(option)}
            style={[styles.kind, kind === option && styles.kindSelected]}
          >
            <Text style={[styles.kindLabel, kind === option && styles.kindLabelSelected]}>{KIND_LABELS[option]}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.fieldLabel}>Nazwa jak w projekcie</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder={PLACEHOLDERS[kind]}
        placeholderTextColor={colors.muted}
        style={styles.input}
        returnKeyType="done"
        onSubmitEditing={() => name.trim() && onCreate(kind, name.trim())}
      />
      <Button label="Zbierz dane z projektu" onPress={() => onCreate(kind, name.trim())} loading={busy} disabled={!name.trim()} />
    </View>
  );
};

// Room and partition cards (#71): one screen per place with every value from the project and its page. Cards are saved
// on the phone with their pages; collecting a new one needs the server.
export const ProjectCards = ({ projectId }: { projectId: string }) => {
  const { cards, offline, error, loading, reload, create } = useCards(projectId);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const open = cards?.find((card) => card.id === openId);

  const submit = async (kind: CardKind, name: string, refresh = false) => {
    setBusy(true);
    setCreateError(null);
    try {
      setOpenId(await create(kind, name, refresh));
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : "Nie udało się utworzyć karty.");
    } finally {
      setBusy(false);
    }
  };

  if (open) {
    return (
      <ScrollView contentContainerStyle={styles.list}>
        <Pressable accessibilityRole="button" onPress={() => setOpenId(null)} style={styles.back}>
          <Text style={styles.link}>‹ Wszystkie karty</Text>
        </Pressable>
        {open.status === "ready" ? (
          <CardView card={open} />
        ) : (
          <View style={styles.row}>
            {open.status === "generating" ? <ActivityIndicator color={colors.muted} /> : null}
            <Text style={open.status === "error" ? styles.error : styles.muted}>{summaryOf(open)}</Text>
          </View>
        )}
        {open.status !== "generating" && !offline ? (
          <Button label="Zbierz dane od nowa" variant="secondary" loading={busy} onPress={() => void submit(open.kind, open.name, true)} />
        ) : null}
        {offline ? <Text style={styles.muted}>Bez zasięgu: karta z telefonu.</Text> : null}
      </ScrollView>
    );
  }

  return (
    <FlatList
      data={cards ?? []}
      keyExtractor={(card) => card.id}
      contentContainerStyle={styles.list}
      refreshing={loading && cards !== null}
      onRefresh={() => void reload()}
      ListHeaderComponent={
        <View style={styles.header}>
          {loading && !cards ? <ActivityIndicator color={colors.muted} /> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {offline ? <Text style={styles.muted}>Bez zasięgu: widzisz karty zapisane w telefonie.</Text> : null}
          {offline ? null : <NewCard onCreate={(kind, name) => void submit(kind, name)} busy={busy} />}
          {createError ? <Text style={styles.error}>{createError}</Text> : null}
          {cards?.length ? <Text style={styles.section}>Karty</Text> : null}
        </View>
      }
      ListEmptyComponent={
        cards ? (
          <Text style={styles.muted}>
            Nie ma jeszcze kart. Wpisz pomieszczenie albo przegrodę, a zbiorę z projektu wymiary, warstwy i instalacje ze wskazaniem
            strony. Możesz też poprosić o kartę na czacie.
          </Text>
        ) : undefined
      }
      renderItem={({ item }) => (
        <Pressable accessibilityRole="button" onPress={() => setOpenId(item.id)} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
          <View style={styles.row}>
            <Text style={styles.cardTitle}>{item.name}</Text>
            {item.status === "generating" ? <ActivityIndicator color={colors.muted} /> : null}
          </View>
          <Text style={styles.meta}>
            {KIND_LABELS[item.kind]} · {summaryOf(item)}
          </Text>
        </Pressable>
      )}
    />
  );
};

const styles = StyleSheet.create({
  list: { padding: spacing.md, gap: spacing.sm },
  header: { gap: spacing.sm },
  back: { paddingVertical: spacing.xs, alignSelf: "flex-start" },
  section: { fontSize: 17, fontWeight: "600", color: colors.text },
  card: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  cardTitle: { flex: 1, fontSize: 16, fontWeight: "600", color: colors.text },
  meta: { fontSize: 13, color: colors.muted },
  kinds: { flexDirection: "row", padding: 3, borderRadius: radius.md, backgroundColor: colors.border },
  kind: { flex: 1, minHeight: 40, borderRadius: radius.md - 2, alignItems: "center", justifyContent: "center" },
  kindSelected: { backgroundColor: colors.surface },
  kindLabel: { fontSize: 14, fontWeight: "500", color: colors.muted },
  kindLabelSelected: { color: colors.text, fontWeight: "600" },
  fieldLabel: { fontSize: 14, fontWeight: "600", color: colors.text },
  input: { minHeight: 44, paddingHorizontal: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, fontSize: 16, color: colors.text },
  link: { fontSize: 15, fontWeight: "600", color: colors.link },
  muted: { flexShrink: 1, fontSize: 15, lineHeight: 21, color: colors.muted },
  error: { flexShrink: 1, fontSize: 15, color: colors.danger },
  pressed: { opacity: 0.8 },
});
