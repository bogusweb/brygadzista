import { Pressable, StyleSheet, Text, View } from "react-native";
import { KIND_LABELS, layerLine } from "../../lib/cards";
import type { CardSource, ElementCard, ValueStatus } from "../../lib/cards";
import { colors, radius, spacing } from "../../lib/theme";
import { usePageViewer } from "../chat/PageViewer";

const ToConfirm = () => (
  <View style={styles.badge}>
    <Text style={styles.badgeText}>Do potwierdzenia</Text>
  </View>
);

const SourceLink = ({ source, title, status }: { source: CardSource; title: string; status: ValueStatus }) => {
  const openPage = usePageViewer();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityHint="Otwiera stronę projektu"
      onPress={() => openPage({ documentId: source.documentId, pageNo: source.pageNo, title, caption: source.quote })}
      style={styles.source}
    >
      {source.quote ? (
        <Text style={styles.quote} numberOfLines={3}>
          „{source.quote}”
        </Text>
      ) : null}
      <Text style={styles.link}>{status === "found" ? "Projekt" : "Zobacz w projekcie"}, str. {source.pageNo} ›</Text>
    </Pressable>
  );
};

// One room or partition with every value and its page; a value the project does not give says so outright.
export const CardView = ({ card }: { card: ElementCard }) => (
  <View style={styles.body}>
    <View style={styles.head}>
      <Text style={styles.kind}>{KIND_LABELS[card.kind]}</Text>
      <Text style={styles.title}>{card.name}</Text>
    </View>
    {card.kind === "partition" ? (
      <View style={styles.block}>
        <Text style={styles.section}>Warstwy</Text>
        {card.layers.length ? (
          card.layers.map((layer, index) => (
            <View key={index} style={styles.row}>
              <Text style={styles.value}>
                {index + 1}. {layerLine(layer)}
              </Text>
              {layer.status === "to_confirm" ? <ToConfirm /> : null}
              {layer.source ? <SourceLink source={layer.source} title={card.name} status={layer.status} /> : null}
            </View>
          ))
        ) : (
          <Text style={styles.missing}>Projekt nie opisuje warstw tej przegrody. Ustal je z projektantem.</Text>
        )}
      </View>
    ) : null}
    <View style={styles.block}>
      {card.fields.map((field) => (
        <View key={field.key} style={styles.row}>
          <Text style={styles.label}>{field.label}</Text>
          {field.value ? <Text style={styles.value}>{field.value}</Text> : <Text style={styles.missing}>Brak danych w projekcie</Text>}
          {field.value && field.status === "to_confirm" ? <ToConfirm /> : null}
          {field.source ? <SourceLink source={field.source} title={`${card.name}: ${field.label}`} status={field.status} /> : null}
        </View>
      ))}
    </View>
  </View>
);

const styles = StyleSheet.create({
  body: { gap: spacing.md },
  head: { gap: 2 },
  kind: { fontSize: 13, fontWeight: "600", color: colors.muted, textTransform: "uppercase" },
  title: { fontSize: 22, fontWeight: "700", color: colors.text },
  block: { gap: spacing.sm },
  section: { fontSize: 17, fontWeight: "600", color: colors.text },
  row: { gap: spacing.xs, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  label: { fontSize: 14, fontWeight: "600", color: colors.muted },
  value: { fontSize: 16, lineHeight: 22, color: colors.text },
  missing: { fontSize: 15, lineHeight: 21, color: colors.muted },
  badge: { alignSelf: "flex-start", paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.md, backgroundColor: "#FCEFD9" },
  badgeText: { fontSize: 12, fontWeight: "600", color: colors.link },
  source: { gap: 2 },
  quote: { fontSize: 14, lineHeight: 20, fontStyle: "italic", color: colors.muted },
  link: { fontSize: 15, fontWeight: "600", color: colors.link },
});
