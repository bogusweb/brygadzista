import { Fragment } from "react";
import { StyleSheet, Text, View } from "react-native";
import { inlineSegments, textBlocks } from "../../lib/chat";
import { colors, spacing } from "../../lib/theme";

type Props = { text: string; onOpenPage: (pageNo: number) => void };

const Inline = ({ line, onOpenPage }: { line: string; onOpenPage: Props["onOpenPage"] }) => (
  <>
    {inlineSegments(line).map((segment, index) =>
      segment.pageNo ? (
        <Text
          key={index}
          accessibilityRole="link"
          accessibilityHint={`Otwiera stronę ${segment.pageNo} projektu`}
          onPress={() => onOpenPage(segment.pageNo!)}
          style={[styles.pageLink, segment.bold && styles.bold]}
        >
          {segment.text}
        </Text>
      ) : (
        <Fragment key={index}>{segment.bold ? <Text style={styles.bold}>{segment.text}</Text> : segment.text}</Fragment>
      ),
    )}
  </>
);

// A deliberately small Markdown subset (paragraphs, bullets, headings, bold) so the chat needs no native
// markdown module and keeps running in Expo Go. Page citations become links to the drawing.
export const MessageText = ({ text, onOpenPage }: Props) => (
  <View style={styles.container}>
    {textBlocks(text).map((block, index) =>
      block.type === "bullet" ? (
        <View key={index} style={styles.bulletRow}>
          <Text style={styles.text}>•</Text>
          <Text style={[styles.text, styles.bulletText]}>
            <Inline line={block.text} onOpenPage={onOpenPage} />
          </Text>
        </View>
      ) : (
        <Text key={index} style={[styles.text, block.type === "heading" && styles.heading]}>
          <Inline line={block.text} onOpenPage={onOpenPage} />
        </Text>
      ),
    )}
  </View>
);

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  text: { fontSize: 16, lineHeight: 23, color: colors.text },
  heading: { fontWeight: "700" },
  bold: { fontWeight: "700" },
  bulletRow: { flexDirection: "row", gap: spacing.sm, paddingRight: spacing.md },
  bulletText: { flex: 1 },
  pageLink: { color: colors.link, fontWeight: "600", textDecorationLine: "underline" },
});
