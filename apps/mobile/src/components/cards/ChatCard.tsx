import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { KIND_LABELS } from "../../lib/cards";
import type { ElementCard } from "../../lib/cards";
import { offlineSupported } from "../../lib/offlineCache";
import { useConnection } from "../../lib/settings";
import { colors, radius, spacing } from "../../lib/theme";
import { CardView } from "./CardView";
import { rememberCard } from "./useCards";

// A card the agent built: saved on the phone as soon as it shows up in the chat, opened in place.
export const ChatCard = ({ card }: { card: ElementCard }) => {
  const connection = useConnection();
  const [open, setOpen] = useState(false);
  const found = card.fields.filter((field) => field.value).length;

  useEffect(() => {
    void rememberCard(connection, card).catch(() => undefined);
  }, [card, connection]);

  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={styles.head}>
        <Text style={styles.kind}>{KIND_LABELS[card.kind]}</Text>
        <Text style={styles.title}>{card.name}</Text>
        <Text style={styles.meta}>
          {found} z {card.fields.length} wartości z projektu{offlineSupported ? " · zapisana w telefonie" : ""}
        </Text>
        <Text style={styles.link}>{open ? "Zwiń kartę" : "Pokaż kartę ›"}</Text>
      </Pressable>
      {open ? <CardView card={card} /> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  card: { gap: spacing.md, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  head: { gap: 2 },
  kind: { fontSize: 12, fontWeight: "600", color: colors.muted, textTransform: "uppercase" },
  title: { fontSize: 17, fontWeight: "700", color: colors.text },
  meta: { fontSize: 13, color: colors.muted },
  link: { marginTop: spacing.xs, fontSize: 15, fontWeight: "600", color: colors.link },
});
