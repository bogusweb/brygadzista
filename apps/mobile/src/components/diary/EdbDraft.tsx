import { setStringAsync } from "expo-clipboard";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, radius, spacing } from "../../lib/theme";
import { Button } from "../Button";

// The day's text for the Elektroniczny Dziennik Budowy, to copy and paste there. The entry in EDB is made and signed
// by the site manager; the app only drafts it.
export const EdbDraft = ({ text, onClose }: { text: string; onClose: () => void }) => {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const copy = async () => {
    const ok = await setStringAsync(text).catch(() => false);
    setCopied(ok ? "yes" : "failed");
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Text style={styles.title}>Szkic do EDB</Text>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
            <Text style={styles.link}>Zamknij</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.hint}>
            Tekst do wklejenia w Elektronicznym Dzienniku Budowy (GUNB). Sprawdź go przed wpisem: wpis w EDB robi i podpisuje
            kierownik budowy.
          </Text>
          <Text selectable style={styles.draft}>
            {text}
          </Text>
          <Button label={copied === "yes" ? "Skopiowano" : "Kopiuj tekst"} onPress={() => void copy()} />
          {copied === "failed" ? <Text style={styles.error}>Nie udało się skopiować. Zaznacz tekst i skopiuj go ręcznie.</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { fontSize: 18, fontWeight: "600", color: colors.text },
  content: { padding: spacing.md, gap: spacing.md },
  hint: { fontSize: 14, lineHeight: 20, color: colors.muted },
  draft: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: 15,
    lineHeight: 22,
    color: colors.text,
  },
  error: { fontSize: 14, color: colors.danger },
  link: { fontSize: 16, color: colors.link },
});
