import { useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { pageImageSource } from "../../lib/api";
import { useConnection } from "../../lib/settings";
import { colors, radius, spacing } from "../../lib/theme";
import { usePageViewer } from "./PageViewer";
import type { ViewedPage } from "./PageViewer";

// A drawing the agent decided to show: thumbnail in the chat, tap for the full-screen zoomable view.
export const PageCard = ({ page }: { page: ViewedPage }) => {
  const connection = useConnection();
  const openPage = usePageViewer();
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  const onPress = () => {
    if (state !== "error") return openPage(page);
    setState("loading");
    setAttempt((value) => value + 1);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Strona ${page.pageNo}${page.title ? `, ${page.title}` : ""}. Otwórz w pełnym ekranie`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.thumbnail}>
        <Image
          key={attempt}
          source={pageImageSource(connection, page.documentId, page.pageNo)}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
          onLoad={() => setState("loaded")}
          onError={() => setState("error")}
        />
        {state === "loading" ? <ActivityIndicator style={styles.center} color={colors.muted} /> : null}
        {state === "error" ? (
          <View style={styles.center}>
            <Text style={styles.errorText}>Nie udało się pobrać rysunku.{"\n"}Dotknij, aby ponowić.</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.meta}>
        <Text style={styles.title} numberOfLines={2}>
          {`Str. ${page.pageNo}${page.title ? ` – ${page.title}` : ""}`}
        </Text>
        {page.caption ? <Text style={styles.caption}>{page.caption}</Text> : null}
        {state !== "error" ? <Text style={styles.hint}>Dotknij, aby powiększyć</Text> : null}
      </View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  pressed: { opacity: 0.85 },
  thumbnail: { aspectRatio: 1.414, backgroundColor: "#FFFFFF", borderBottomWidth: 1, borderBottomColor: colors.border },
  center: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  errorText: { color: colors.danger, fontSize: 14, textAlign: "center" },
  meta: { padding: spacing.md, gap: spacing.xs },
  title: { fontSize: 15, fontWeight: "600", color: colors.text },
  caption: { fontSize: 14, lineHeight: 20, color: colors.text },
  hint: { fontSize: 13, color: colors.muted },
});
