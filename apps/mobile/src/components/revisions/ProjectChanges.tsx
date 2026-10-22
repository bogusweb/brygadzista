import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { formatDateTime } from "../../lib/format";
import { factLine, KIND_LABELS } from "../../lib/revisions";
import type { PageChange, Revision } from "../../lib/revisions";
import { colors, radius, spacing } from "../../lib/theme";
import { usePageViewer } from "../chat/PageViewer";

const ChangeRow = ({ revision, change }: { revision: Revision; change: PageChange }) => {
  const openPage = usePageViewer();
  const title = [change.drawingNo, change.title].filter(Boolean).join(" · ") || "Strona bez tytułu";
  return (
    <View style={styles.card}>
      <Text style={styles.kind}>{KIND_LABELS[change.kind]}</Text>
      <Text style={styles.title}>{title}</Text>
      {change.facts.map((fact, index) => (
        <Text key={index} style={styles.fact}>
          {factLine(fact)}
        </Text>
      ))}
      {change.facts.length === 0
        ? change.linesAdded.map((line, index) => (
            <Text key={`a${index}`} style={styles.added}>
              + {line}
            </Text>
          ))
        : null}
      {change.facts.length === 0
        ? change.linesRemoved.map((line, index) => (
            <Text key={`r${index}`} style={styles.removed}>
              − {line}
            </Text>
          ))
        : null}
      <View style={styles.links}>
        {change.pageNo !== null ? (
          <Pressable accessibilityRole="link" onPress={() => openPage({ documentId: revision.documentId, pageNo: change.pageNo!, title: `${title} (nowa wersja)` })}>
            <Text style={styles.link}>Nowa, str. {change.pageNo} ›</Text>
          </Pressable>
        ) : null}
        {change.previousPageNo !== null ? (
          <Pressable
            accessibilityRole="link"
            onPress={() => openPage({ documentId: revision.previousId, pageNo: change.previousPageNo!, title: `${title} (poprzednia wersja)` })}
          >
            <Text style={styles.oldLink}>Poprzednia, str. {change.previousPageNo} ›</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
};

// What changed between versions of the project (#72), newest version first, with links to the page in both.
export const ProjectChanges = ({ revisions }: { revisions: Revision[] }) => (
  <FlatList
    data={revisions.flatMap((revision) => [{ revision, change: null as PageChange | null }, ...revision.changes.map((change) => ({ revision, change }))])}
    keyExtractor={(row, index) => `${row.revision.documentId}:${index}`}
    contentContainerStyle={styles.list}
    ListEmptyComponent={<Text style={styles.muted}>Projekt ma jedną wersję. Gdy biuro wgra nową, zobaczysz tu, co się zmieniło.</Text>}
    renderItem={({ item }) =>
      item.change ? (
        <ChangeRow revision={item.revision} change={item.change} />
      ) : (
        <View style={styles.head}>
          <Text style={styles.section}>{item.revision.filename}</Text>
          <Text style={styles.muted}>
            Nowa wersja „{item.revision.previousFilename}” z {formatDateTime(item.revision.createdAt)} ·{" "}
            {item.revision.changedPages ? `zmienione strony: ${item.revision.changedPages}` : "bez zmian w tekście"}. Agent odpowiada z
            nowej wersji.
          </Text>
        </View>
      )
    }
  />
);

const styles = StyleSheet.create({
  list: { padding: spacing.md, gap: spacing.sm },
  head: { gap: spacing.xs, marginTop: spacing.sm },
  section: { fontSize: 17, fontWeight: "600", color: colors.text },
  card: { gap: spacing.xs, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  kind: { fontSize: 12, fontWeight: "600", color: colors.muted, textTransform: "uppercase" },
  title: { fontSize: 16, fontWeight: "600", color: colors.text },
  fact: { fontSize: 15, lineHeight: 21, color: colors.text },
  added: { fontSize: 14, lineHeight: 20, color: "#1D6B35" },
  removed: { fontSize: 14, lineHeight: 20, color: colors.danger, textDecorationLine: "line-through" },
  links: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, marginTop: spacing.xs },
  link: { fontSize: 15, fontWeight: "600", color: colors.link },
  oldLink: { fontSize: 15, color: colors.muted },
  muted: { fontSize: 15, lineHeight: 21, color: colors.muted },
});
