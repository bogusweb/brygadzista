import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { text, toMaterials, toPartitions, toSource, toSteps } from "../../lib/a2ui";
import type { A2UISource, CatalogComponent } from "../../lib/a2ui";
import { colors, radius, spacing } from "../../lib/theme";
import { useOpenSourcePage } from "./sourcePage";
import type { ComponentRenderer } from "./sourcePage";

// Native renderers for the construction catalog. The props and the descriptions the model reads live on the server
// (apps/server/src/a2ui-catalog.ts); the dashboard draws the same components for the web (apps/dashboard/src/a2uiCatalog.tsx).

const SourceLink = ({ source }: { source: A2UISource }) => {
  const openPage = useOpenSourcePage();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Otwórz stronę ${source.page}`}
      hitSlop={10}
      onPress={() => openPage(source.page, source.documentId)}
    >
      <Text style={styles.link}>{`str. ${source.page}`}</Text>
    </Pressable>
  );
};

// A quiet line under a value: an optional note and the page it came from.
const Meta = ({ note, source }: { note?: string; source?: A2UISource }) =>
  note || source ? (
    <View style={styles.meta}>
      {note ? <Text style={styles.metaText}>{note}</Text> : null}
      {source ? <SourceLink source={source} /> : null}
    </View>
  ) : null;

const Block = ({ title, children }: { title: string; children: ReactNode }) => (
  <View style={styles.block}>
    {title ? (
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
    ) : null}
    {children}
  </View>
);

const Empty = () => <Text style={styles.metaText}>Brak pozycji.</Text>;

const ParameterCard: ComponentRenderer = (props) => (
  <View style={styles.parameter}>
    <Text style={styles.label}>{text(props.label)}</Text>
    <Text style={styles.value}>
      {text(props.value)}
      {text(props.unit) ? <Text style={styles.unit}>{` ${text(props.unit)}`}</Text> : null}
    </Text>
    <Meta note={text(props.note) || undefined} source={toSource(props.source)} />
  </View>
);

const MaterialList: ComponentRenderer = (props) => {
  const items = toMaterials(props.items);
  return (
    <Block title={text(props.title)}>
      {items.length === 0 ? (
        <Empty />
      ) : (
        items.map((item, index) => (
          <View key={index} style={[styles.row, index > 0 && styles.rowDivider]}>
            <View style={styles.rowMain}>
              <Text style={styles.rowText}>{item.name}</Text>
              <Meta note={item.note} source={item.source} />
            </View>
            {item.quantity !== undefined ? <Text style={styles.quantity}>{`${item.quantity}${item.unit ? ` ${item.unit}` : ""}`}</Text> : null}
          </View>
        ))
      )}
    </Block>
  );
};

const WorkSteps: ComponentRenderer = (props) => {
  const steps = toSteps(props.steps);
  return (
    <Block title={text(props.title)}>
      {steps.length === 0 ? (
        <Empty />
      ) : (
        steps.map((step, index) => (
          <View key={index} style={styles.step}>
            <View style={styles.stepNo} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
              <Text style={styles.stepNoText}>{index + 1}</Text>
            </View>
            <View style={styles.rowMain} accessibilityLabel={`Krok ${index + 1}`}>
              <Text style={styles.stepTitle}>{step.title}</Text>
              {step.detail ? <Text style={styles.rowText}>{step.detail}</Text> : null}
              <Meta source={step.source} />
            </View>
          </View>
        ))
      )}
    </Block>
  );
};

// On a phone the partitions sit one under another, each with its layers from the outside in.
const LayerComparison: ComponentRenderer = (props) => {
  const partitions = toPartitions(props.partitions);
  const highlight = typeof props.highlight === "number" ? props.highlight : -1;
  return (
    <Block title={text(props.title)}>
      {partitions.length === 0 ? (
        <Empty />
      ) : (
        partitions.map((partition, index) => {
          const summary = [partition.total && `razem ${partition.total}`, partition.uValue && `U = ${partition.uValue}`].filter(Boolean).join(" · ");
          return (
            <View key={index} style={[styles.partition, index === highlight && styles.highlight]}>
              <Text style={styles.stepTitle}>{partition.name}</Text>
              <Meta note={summary || undefined} source={partition.source} />
              <Text style={styles.caption}>Warstwy od zewnątrz do wewnątrz</Text>
              {partition.layers.map((layer, layerIndex) => (
                <View key={layerIndex} style={[styles.row, layerIndex > 0 && styles.rowDivider]}>
                  <View style={styles.rowMain}>
                    <Text style={styles.rowText}>{layer.material}</Text>
                    {layer.note ? <Text style={styles.metaText}>{layer.note}</Text> : null}
                  </View>
                  {layer.thickness ? <Text style={styles.quantity}>{layer.thickness}</Text> : null}
                </View>
              ))}
            </View>
          );
        })
      )}
    </Block>
  );
};

export const CATALOG_RENDERERS: Record<CatalogComponent, ComponentRenderer> = { ParameterCard, MaterialList, WorkSteps, LayerComparison };

const styles = StyleSheet.create({
  block: { gap: spacing.sm },
  title: { fontSize: 16, lineHeight: 22, fontWeight: "700", color: colors.text },
  parameter: { gap: 2, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.background },
  label: { fontSize: 13, lineHeight: 18, color: colors.muted },
  value: { fontSize: 24, lineHeight: 30, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
  unit: { fontSize: 16, fontWeight: "500", color: colors.muted },
  meta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: spacing.sm },
  metaText: { fontSize: 13, lineHeight: 18, color: colors.muted },
  link: { fontSize: 13, lineHeight: 18, fontWeight: "600", color: colors.link, textDecorationLine: "underline" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, paddingVertical: spacing.sm },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowMain: { flex: 1, gap: 2 },
  rowText: { fontSize: 15, lineHeight: 21, color: colors.text },
  quantity: { fontSize: 15, lineHeight: 21, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"], textAlign: "right" },
  step: { flexDirection: "row", gap: spacing.md, paddingVertical: spacing.xs },
  stepNo: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent },
  stepNoText: { fontSize: 14, fontWeight: "700", color: colors.accentText, fontVariant: ["tabular-nums"] },
  stepTitle: { fontSize: 15, lineHeight: 21, fontWeight: "600", color: colors.text },
  partition: { gap: spacing.xs, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  highlight: { borderColor: colors.accent, borderWidth: 2 },
  caption: { fontSize: 12, lineHeight: 16, color: colors.muted, marginTop: spacing.xs },
});
