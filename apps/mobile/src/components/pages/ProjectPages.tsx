import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { fetchDocuments, fetchPages } from "../../lib/api";
import type { DocumentPage, ProjectDocument } from "../../lib/api";
import { formatMegabytes, pluralPl } from "../../lib/format";
import { cachedDocumentBytes, cachedPageNumbers, offlineSupported, removeDocumentPages } from "../../lib/offlineCache";
import { useConnection } from "../../lib/settings";
import { colors, radius, spacing } from "../../lib/theme";
import { useCachedResource } from "../../lib/useCachedResource";
import { Button } from "../Button";
import { usePageViewer } from "../chat/PageViewer";
import { usePins } from "../pins/PinsProvider";
import type { ViewedPage } from "../chat/PageViewer";
import { useOfflineDownload } from "./useOfflineDownload";
import { usePageCacheVersion, usePageImage } from "./usePageImage";

const CELL_GAP = 12;

const pagesLabel = (count: number) => pluralPl(count, "strona", "strony", "stron");

const OfflineNotice = () => (
  <View style={styles.notice}>
    <Text style={styles.noticeText}>Brak połączenia z serwerem. Pokazuję to, co jest zapisane na telefonie.</Text>
  </View>
);

const PageTile = ({ documentId, page, pinCount, onPress }: { documentId: string; page: DocumentPage; pinCount: number; onPress: () => void }) => {
  const image = usePageImage(documentId, page.pageNo);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Strona ${page.pageNo}${page.title ? `, ${page.title}` : ""}${image.saved ? ", zapisana na telefonie" : ""}${pinCount ? `, pinezki ze zdjęciami: ${pinCount}` : ""}`}
      onPress={onPress}
      style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
    >
      <View style={styles.thumbnail}>
        <Image
          source={image.source}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
          resizeMethod="resize"
          onLoad={() => {
            image.onLoad();
            setState("loaded");
          }}
          onError={() => {
            if (!image.onError()) setState("error");
          }}
        />
        {state === "loading" ? <ActivityIndicator style={styles.center} color={colors.muted} /> : null}
        {state === "error" ? (
          <View style={styles.center}>
            <Text style={styles.tileError}>Brak podglądu</Text>
          </View>
        ) : null}
        {pinCount ? (
          <View style={styles.pinBadge}>
            <Text style={styles.savedBadgeText}>{pluralPl(pinCount, "pinezka", "pinezki", "pinezek")}</Text>
          </View>
        ) : null}
        {image.saved ? (
          <View style={styles.savedBadge}>
            <Text style={styles.savedBadgeText}>Na telefonie</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.tileMeta}>
        <Text style={styles.tilePage}>Str. {page.pageNo}</Text>
        {page.title ? (
          <Text style={styles.tileTitle} numberOfLines={2}>
            {page.title}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
};

const OfflinePanel = ({ document, pages }: { document: ProjectDocument; pages: DocumentPage[] }) => {
  const connection = useConnection();
  const version = usePageCacheVersion();
  const { running, progress, start, stop } = useOfflineDownload(document.id, pages);
  const { savedCount, bytes } = useMemo(() => {
    const saved = cachedPageNumbers(connection, document.id);
    return { savedCount: pages.filter((page) => saved.has(page.pageNo)).length, bytes: cachedDocumentBytes(connection, document.id) };
    // version: recount after every save or removal.
  }, [connection, document.id, pages, version]);

  if (!offlineSupported) {
    return <Text style={styles.panelNote}>W przeglądarce strony są zawsze pobierane z serwera. Zapis na telefonie, do pracy bez zasięgu, działa w aplikacji (Expo Go).</Text>;
  }

  const complete = pages.length > 0 && savedCount === pages.length;
  const failed = !running && progress && progress.failed > 0 ? progress.failed : 0;

  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>
        {complete ? "Wszystkie strony są na telefonie" : `Na telefonie: ${savedCount} z ${pages.length} ${pages.length === 1 ? "strony" : "stron"}`}
      </Text>
      <Text style={styles.panelNote}>
        {complete
          ? `Rysunki działają bez zasięgu. Zajmują ${formatMegabytes(bytes)}.`
          : "Pobierz strony przed wyjazdem na budowę, żeby rysunki działały bez zasięgu."}
      </Text>
      {running && progress ? (
        <View style={styles.progressRow}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress.total ? (100 * progress.done) / progress.total : 100}%` }]} />
          </View>
          <Text style={styles.progressText}>
            {progress.done} / {progress.total}
          </Text>
        </View>
      ) : null}
      {failed ? (
        <Text style={styles.panelError}>
          {`Nie udało się pobrać: ${pagesLabel(failed)}. Sprawdź zasięg i spróbuj ponownie.`}
        </Text>
      ) : null}
      {running ? <Button label="Przerwij pobieranie" variant="secondary" onPress={stop} /> : null}
      {!running && !complete ? <Button label={`Pobierz ${pagesLabel(pages.length - savedCount)} na telefon`} onPress={start} /> : null}
      {!running && savedCount > 0 ? (
        <Button label="Usuń zapisane strony z telefonu" variant="secondary" onPress={() => removeDocumentPages(connection, document.id)} />
      ) : null}
    </View>
  );
};

const DocumentPicker = ({
  documents,
  selectedId,
  onSelect,
}: {
  documents: ProjectDocument[];
  selectedId: string;
  onSelect: (id: string) => void;
}) => (
  <View style={styles.chips}>
    {documents.map((document) => {
      const selected = document.id === selectedId;
      return (
        <Pressable
          key={document.id}
          accessibilityRole="button"
          accessibilityState={{ selected }}
          onPress={() => onSelect(document.id)}
          style={[styles.chip, selected && styles.chipSelected]}
        >
          <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]} numberOfLines={1}>
            {document.filename}
          </Text>
        </Pressable>
      );
    })}
  </View>
);

const DocumentPages = ({
  document,
  documents,
  documentsOffline,
  onSelectDocument,
}: {
  document: ProjectDocument;
  documents: ProjectDocument[];
  documentsOffline: boolean;
  onSelectDocument: (id: string) => void;
}) => {
  const pages = useCachedResource(`pages-${document.id}`, (connection) => fetchPages(connection, document.id), "Nie udało się pobrać spisu stron.");
  const openPage = usePageViewer();
  const { pins } = usePins();
  const pinCounts = useMemo(() => {
    const counts = new Map<number, number>();
    pins.forEach((pin) => pin.documentId === document.id && counts.set(pin.pageNo, (counts.get(pin.pageNo) ?? 0) + 1));
    return counts;
  }, [pins, document.id]);
  const sequence = useMemo<ViewedPage[]>(
    () => (pages.data ?? []).map((page) => ({ documentId: document.id, pageNo: page.pageNo, title: page.title })),
    [document.id, pages.data],
  );

  const header = (
    <View style={styles.header}>
      {documents.length > 1 ? <DocumentPicker documents={documents} selectedId={document.id} onSelect={onSelectDocument} /> : null}
      {documentsOffline || pages.offline ? <OfflineNotice /> : null}
      {pages.data && pages.data.length > 0 ? <OfflinePanel document={document} pages={pages.data} /> : null}
    </View>
  );

  if (!pages.data) {
    return (
      <View style={styles.fill}>
        {header}
        <View style={styles.centerBox}>
          {pages.loading ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <>
              <Text style={styles.message}>{pages.error}</Text>
              <Button label="Spróbuj ponownie" onPress={pages.reload} />
            </>
          )}
        </View>
      </View>
    );
  }

  return (
    <FlatList
      data={pages.data}
      keyExtractor={(page) => String(page.pageNo)}
      numColumns={2}
      contentContainerStyle={styles.list}
      ListHeaderComponent={header}
      ListEmptyComponent={
        <Text style={styles.message}>
          {document.status === "ready" ? "Ten dokument nie ma stron." : "Strony tego dokumentu jeszcze się przygotowują. Zajrzyj za chwilę."}
        </Text>
      }
      onRefresh={pages.reload}
      refreshing={pages.loading}
      initialNumToRender={8}
      windowSize={5}
      renderItem={({ item, index }) => (
        <View style={styles.cell}>
          <PageTile documentId={document.id} page={item} pinCount={pinCounts.get(item.pageNo) ?? 0} onPress={() => openPage(sequence[index]!, sequence)} />
        </View>
      )}
    />
  );
};

// The "Projekt" tab: every page of the project's PDFs, with the option to keep them on the phone for sites without signal.
export const ProjectPages = ({ projectId }: { projectId: string }) => {
  const documents = useCachedResource(
    `documents-${projectId}`,
    (connection) => fetchDocuments(connection, projectId),
    "Nie udało się pobrać dokumentów projektu.",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const document = documents.data?.find((candidate) => candidate.id === selectedId) ?? documents.data?.[0];

  if (!documents.data) {
    return (
      <View style={styles.centerBox}>
        {documents.loading ? (
          <ActivityIndicator color={colors.accent} />
        ) : (
          <>
            <Text style={styles.message}>{documents.error}</Text>
            <Button label="Spróbuj ponownie" onPress={documents.reload} />
          </>
        )}
      </View>
    );
  }
  if (!document) {
    return (
      <View style={styles.centerBox}>
        <Text style={styles.message}>W tym projekcie nie ma jeszcze dokumentów.</Text>
      </View>
    );
  }
  return (
    <DocumentPages
      key={document.id}
      document={document}
      documents={documents.data}
      documentsOffline={documents.offline}
      onSelectDocument={setSelectedId}
    />
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Half-width cells keep a lone last page from stretching over the whole row.
  list: { padding: spacing.md - CELL_GAP / 2, paddingBottom: spacing.xl },
  cell: { width: "50%", padding: CELL_GAP / 2 },
  header: { gap: spacing.md, padding: CELL_GAP / 2, paddingBottom: spacing.md },
  centerBox: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg, gap: spacing.md },
  center: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  message: { fontSize: 16, lineHeight: 22, color: colors.muted, textAlign: "center" },
  notice: { padding: spacing.md, borderRadius: radius.md, backgroundColor: "#FDF1E4", borderWidth: 1, borderColor: "#F2C99C" },
  noticeText: { fontSize: 15, lineHeight: 21, color: colors.text },
  panel: { gap: spacing.sm, padding: spacing.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  panelTitle: { fontSize: 17, fontWeight: "600", color: colors.text },
  panelNote: { fontSize: 14, lineHeight: 20, color: colors.muted },
  panelError: { fontSize: 14, lineHeight: 20, color: colors.danger },
  progressRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  progressTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: "hidden" },
  progressFill: { height: 8, backgroundColor: colors.accent },
  progressText: { fontSize: 14, color: colors.muted, fontVariant: ["tabular-nums"] },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    minHeight: 40,
    maxWidth: "100%",
    paddingHorizontal: spacing.md,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    justifyContent: "center",
  },
  chipSelected: { backgroundColor: colors.text, borderColor: colors.text },
  chipLabel: { fontSize: 15, color: colors.text },
  chipLabelSelected: { color: colors.surface, fontWeight: "600" },
  tile: { flex: 1, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" },
  pressed: { opacity: 0.85 },
  thumbnail: { aspectRatio: 1, backgroundColor: "#FFFFFF", borderBottomWidth: 1, borderBottomColor: colors.border },
  tileError: { fontSize: 13, color: colors.muted },
  savedBadge: {
    position: "absolute",
    left: spacing.xs,
    bottom: spacing.xs,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: "rgba(28, 28, 26, 0.75)",
  },
  pinBadge: {
    position: "absolute",
    right: spacing.xs,
    top: spacing.xs,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: colors.accent,
  },
  savedBadgeText: { fontSize: 11, fontWeight: "600", color: "#FFFFFF" },
  tileMeta: { padding: spacing.sm, gap: 2 },
  tilePage: { fontSize: 14, fontWeight: "600", color: colors.text },
  tileTitle: { fontSize: 13, lineHeight: 18, color: colors.muted },
});
