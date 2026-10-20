import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { colors, spacing } from "../../lib/theme";

// One quiet line per tool call, so the contractor sees the agent is working (searching, reading a drawing...).
export const ToolStatus = ({ label, done }: { label: string; done: boolean }) => (
  <View style={styles.row} accessibilityLiveRegion="polite">
    {done ? <Text style={styles.check}>✓</Text> : <ActivityIndicator size="small" color={colors.muted} />}
    <Text style={styles.label} numberOfLines={2}>
      {label}
    </Text>
  </View>
);

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.xs },
  check: { width: 20, textAlign: "center", fontSize: 15, color: colors.muted },
  label: { flex: 1, fontSize: 14, color: colors.muted },
});
