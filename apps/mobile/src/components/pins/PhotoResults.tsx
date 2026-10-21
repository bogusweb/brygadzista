import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { formatDateTime } from "../../lib/format";
import type { PinPhoto } from "../../lib/pins";
import { colors, radius, spacing } from "../../lib/theme";
import { usePageViewer } from "../chat/PageViewer";
import { usePhotoSource } from "./PinPanel";
import { usePins } from "./PinsProvider";

export type FoundPin = {
  id: string;
  documentId: string;
  pageNo: number;
  pageTitle: string | null;
  room: string;
  note: string;
  createdAt: string;
  photos: PinPhoto[];
};

const MAX_THUMBS = 3;

const Thumb = ({ photo }: { photo: PinPhoto }) => {
  const { projectId } = usePins();
  const source = usePhotoSource(projectId, { ...photo, pending: false }, "thumb");
  return <Image source={source} style={styles.thumb} resizeMode="cover" />;
};

// Photos the agent found (search_photos): tapping one opens its page with the pin and all its photos.
export const PhotoResults = ({ pins }: { pins: FoundPin[] }) => {
  const openPage = usePageViewer();
  return (
    <View style={styles.list}>
      {pins.map((pin) => (
        <Pressable
          key={pin.id}
          accessibilityRole="button"
          accessibilityLabel={`${pin.room || "Zdjęcia"}, str. ${pin.pageNo}, ${formatDateTime(pin.createdAt)}. Otwórz na rysunku`}
          onPress={() => openPage({ documentId: pin.documentId, pageNo: pin.pageNo, title: pin.pageTitle, pinId: pin.id })}
          style={({ pressed }) => [styles.card, pressed && styles.pressed]}
        >
          {pin.photos.length ? (
            <View style={styles.thumbs}>
              {pin.photos.slice(0, MAX_THUMBS).map((photo) => (
                <Thumb key={photo.id} photo={photo} />
              ))}
              {pin.photos.length > MAX_THUMBS ? <Text style={styles.more}>+{pin.photos.length - MAX_THUMBS}</Text> : null}
            </View>
          ) : null}
          <Text style={styles.title} numberOfLines={1}>
            {[pin.room, `str. ${pin.pageNo}${pin.pageTitle ? ` – ${pin.pageTitle}` : ""}`].filter(Boolean).join(" · ")}
          </Text>
          <Text style={styles.meta}>{formatDateTime(pin.createdAt)}</Text>
          {pin.note ? (
            <Text style={styles.note} numberOfLines={3}>
              {pin.note}
            </Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  list: { gap: spacing.sm },
  card: { gap: spacing.xs, padding: spacing.sm, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  pressed: { opacity: 0.85 },
  thumbs: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginBottom: spacing.xs },
  thumb: { width: 72, height: 72, borderRadius: radius.md, backgroundColor: colors.border },
  more: { fontSize: 14, fontWeight: "600", color: colors.muted, paddingHorizontal: spacing.xs },
  title: { fontSize: 15, fontWeight: "600", color: colors.text },
  meta: { fontSize: 13, color: colors.muted },
  note: { fontSize: 14, lineHeight: 20, color: colors.text },
});
