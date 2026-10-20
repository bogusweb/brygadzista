import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { fetchSearchIndex } from "../../lib/api";
import { createSearcher } from "../../lib/search";
import type { SearchHit } from "../../lib/search";
import { colors, radius, spacing } from "../../lib/theme";
import { useCachedResource } from "../../lib/useCachedResource";
import { usePageViewer } from "../chat/PageViewer";
import type { ViewedPage } from "../chat/PageViewer";

const MIN_QUERY_LENGTH = 2;

const savedAt = (iso: string) =>
  new Date(iso).toLocaleString("pl-PL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

const ResultRow = ({ hit, showFilename, onPress }: { hit: SearchHit; showFilename: boolean; onPress: () => void }) => (
  <Pressable
    accessibilityRole="button"
    accessibilityLabel={`Strona ${hit.page.pageNo}${hit.page.title ? `, ${hit.page.title}` : ""}`}
    onPress={onPress}
    style={({ pressed }) => [styles.result, pressed && styles.pressed]}
  >
    <Text style={styles.resultPage}>
      Str. {hit.page.pageNo}
      {showFilename ? <Text style={styles.resultFile}>{` · ${hit.page.filename}`}</Text> : null}
    </Text>
    {hit.page.title ? (
      <Text style={styles.resultTitle} numberOfLines={2}>
        {hit.page.title}
      </Text>
    ) : null}
    {hit.snippet ? (
      <Text style={styles.resultSnippet} numberOfLines={3}>
        {hit.snippet}
      </Text>
    ) : null}
  </Pressable>
);

// The search over the project's page text (#54). The text is downloaded whenever the project opens with signal
// and kept on the phone, so on site the search answers from that copy.
export const ProjectSearch = ({ projectId, children }: { projectId: string; children: ReactNode }) => {
  const index = useCachedResource(
    `search-index-${projectId}`,
    (connection) => fetchSearchIndex(connection, projectId),
    "Nie udało się pobrać tekstu projektu.",
  );
  const [query, setQuery] = useState("");
  const openPage = usePageViewer();
  const search = useMemo(() => (index.data ? createSearcher(index.data) : null), [index.data]);
  const searching = query.trim().length >= MIN_QUERY_LENGTH;
  const hits = useMemo(() => (search && searching ? search(query) : []), [search, searching, query]);
  const showFilename = useMemo(() => new Set(index.data?.pages.map((page) => page.documentId)).size > 1, [index.data]);
  const sequence = useMemo<ViewedPage[]>(
    () => hits.map(({ page }) => ({ documentId: page.documentId, pageNo: page.pageNo, title: page.title })),
    [hits],
  );

  const status = (() => {
    if (!searching) return null;
    if (!index.data) {
      return index.loading
        ? "Przygotowuję wyszukiwanie…"
        : "Wyszukiwanie zadziała bez zasięgu, gdy raz otworzysz ten projekt z zasięgiem.";
    }
    if (index.offline) return `Bez zasięgu: szukam w kopii z telefonu z ${savedAt(index.data.generatedAt)}.`;
    return null;
  })();

  return (
    <View style={styles.fill}>
      <View style={styles.bar}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Szukaj w projekcie, np. cokół, A-04"
          placeholderTextColor={colors.muted}
          style={styles.input}
          returnKeyType="search"
          autoCorrect={false}
          clearButtonMode="while-editing"
          accessibilityLabel="Szukaj w projekcie"
        />
        {status ? <Text style={styles.status}>{status}</Text> : null}
      </View>
      {searching ? (
        <FlatList
          data={hits}
          keyExtractor={(hit) => `${hit.page.documentId}-${hit.page.pageNo}`}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          ListEmptyComponent={
            index.data ? (
              <Text style={styles.empty}>Nic nie znalazłem. Spróbuj innego słowa albo oznaczenia rysunku.</Text>
            ) : index.loading ? (
              <ActivityIndicator color={colors.accent} />
            ) : undefined
          }
          renderItem={({ item, index: position }) => (
            <ResultRow hit={item} showFilename={showFilename} onPress={() => openPage(sequence[position]!, sequence)} />
          )}
        />
      ) : null}
      {/* The pages stay mounted while searching, so a running download is not stopped. */}
      <View style={[styles.fill, searching && styles.hidden]}>{children}</View>
    </View>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hidden: { display: "none" },
  bar: { gap: spacing.xs, paddingHorizontal: spacing.md, paddingTop: spacing.md },
  input: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: 16,
    color: colors.text,
  },
  status: { fontSize: 13, lineHeight: 18, color: colors.muted },
  list: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  empty: { fontSize: 16, lineHeight: 22, color: colors.muted, textAlign: "center", paddingTop: spacing.lg },
  result: {
    gap: 2,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pressed: { opacity: 0.85 },
  resultPage: { fontSize: 14, fontWeight: "600", color: colors.text },
  resultFile: { fontWeight: "400", color: colors.muted },
  resultTitle: { fontSize: 15, lineHeight: 20, color: colors.text },
  resultSnippet: { fontSize: 14, lineHeight: 20, color: colors.muted },
});
