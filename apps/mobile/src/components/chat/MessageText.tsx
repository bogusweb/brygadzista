import { Fragment } from "react";
import { StyleSheet, Text, View } from "react-native";
import { inlineSegments, textBlocks } from "../../lib/chat";
import { colors, spacing } from "../../lib/theme";

type Props = { text: string; onOpenPage: (pageNo: number) => void; unverifiedPages?: number[] };

type InlineProps = { line: string; onOpenPage: Props["onOpenPage"]; unverifiedPages?: number[] };

// A citation the server could not back with a tool result (#57) is shown in red with a warning sign.
const Inline = ({ line, onOpenPage, unverifiedPages }: InlineProps) => (
  <>
    {inlineSegments(line).map((segment, index) =>
      segment.pageNo ? (
        <Text
          key={index}
          accessibilityRole="link"
          accessibilityHint={
            unverifiedPages?.includes(segment.pageNo)
              ? `Źródło niepotwierdzone. Otwiera stronę ${segment.pageNo} projektu`
              : `Otwiera stronę ${segment.pageNo} projektu`
          }
          onPress={() => onOpenPage(segment.pageNo!)}
          style={[styles.pageLink, segment.bold && styles.bold, unverifiedPages?.includes(segment.pageNo) && styles.unverified]}
        >
          {segment.text}
          {unverifiedPages?.includes(segment.pageNo) ? " ⚠" : ""}
        </Text>
      ) : (
        <Fragment key={index}>{segment.bold ? <Text style={styles.bold}>{segment.text}</Text> : segment.text}</Fragment>
      ),
    )}
  </>
);

// A deliberately small Markdown subset (paragraphs, bullets, headings, bold) so the chat needs no native
// markdown module and keeps running in Expo Go. Page citations become links to the drawing.
export const MessageText = ({ text, onOpenPage, unverifiedPages }: Props) => (
  <View style={styles.container}>
    {textBlocks(text).map((block, index) =>
      block.type === "bullet" ? (
        <View key={index} style={styles.bulletRow}>
          <Text style={styles.text}>•</Text>
          <Text style={[styles.text, styles.bulletText]}>
            <Inline line={block.text} onOpenPage={onOpenPage} unverifiedPages={unverifiedPages} />
          </Text>
        </View>
      ) : (
        <Text key={index} style={[styles.text, block.type === "heading" && styles.heading]}>
          <Inline line={block.text} onOpenPage={onOpenPage} unverifiedPages={unverifiedPages} />
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
  unverified: { color: colors.danger, textDecorationStyle: "dotted" },
});
