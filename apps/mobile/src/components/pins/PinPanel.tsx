import { useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { photoImagePath, serverImageSource } from "../../lib/api";
import type { PhotoSize } from "../../lib/api";
import { formatDateTime, pluralPl } from "../../lib/format";
import { localPhotoUri } from "../../lib/photoStore";
import type { ViewPhoto, ViewPin } from "../../lib/pins";
import { useConnection } from "../../lib/settings";
import { colors, radius, spacing } from "../../lib/theme";
import { Button } from "../Button";
import { choosePhotos, takePhoto } from "./pickPhotos";
import type { PickedPhoto } from "./PinsProvider";

// A photo from the phone when there is a copy (taken here, or not uploaded yet), otherwise from the server.
export const usePhotoSource = (projectId: string, photo: ViewPhoto, size: PhotoSize) => {
  const connection = useConnection();
  const local = photo.localUri ?? localPhotoUri(connection, photo.id);
  return local ? { uri: local } : serverImageSource(connection, photoImagePath(projectId, photo.id, size));
};

const PhotoThumb = ({ projectId, photo, onPress }: { projectId: string; photo: ViewPhoto; onPress: () => void }) => {
  const source = usePhotoSource(projectId, photo, "thumb");
  const [failed, setFailed] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Zdjęcie z ${formatDateTime(photo.takenAt)}${photo.pending ? ", czeka na wysłanie" : ""}`}
      onPress={onPress}
      style={({ pressed }) => [styles.thumb, pressed && styles.pressed]}
    >
      {failed ? <Text style={styles.thumbError}>Brak podglądu bez zasięgu</Text> : <Image source={source} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setFailed(true)} />}
      {photo.pending ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>Czeka</Text>
        </View>
      ) : null}
    </Pressable>
  );
};

const PickerButtons = ({ onPicked }: { onPicked: (photos: PickedPhoto[]) => void }) => {
  const [busy, setBusy] = useState(false);
  const pick = (picker: () => Promise<PickedPhoto[]>) => async () => {
    setBusy(true);
    try {
      const photos = await picker();
      if (photos.length) onPicked(photos);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.row}>
      <View style={styles.flex}>
        <Button label="Zrób zdjęcie" onPress={pick(takePhoto)} loading={busy} />
      </View>
      <View style={styles.flex}>
        <Button label="Z galerii" variant="secondary" onPress={pick(choosePhotos)} disabled={busy} />
      </View>
    </View>
  );
};

const pinTitle = (pin: Pick<ViewPin, "room">) => pin.room || "Zdjęcia z budowy";

export const PinDetails = ({
  projectId,
  pin,
  onClose,
  onEdit,
  onDelete,
  onAddPhotos,
  onOpenPhoto,
}: {
  projectId: string;
  pin: ViewPin;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddPhotos: (photos: PickedPhoto[]) => void;
  onOpenPhoto: (photo: ViewPhoto) => void;
}) => (
  <View style={styles.panel}>
    <View style={styles.header}>
      <View style={styles.flex}>
        <Text style={styles.title} numberOfLines={1}>
          {pinTitle(pin)}
        </Text>
        <Text style={styles.meta}>
          {[formatDateTime(pin.createdAt), pin.authorName, pin.photos.length ? pluralPl(pin.photos.length, "zdjęcie", "zdjęcia", "zdjęć") : ""].filter(Boolean).join(" · ")}
        </Text>
      </View>
      <Pressable accessibilityRole="button" onPress={onClose} hitSlop={8} style={styles.textButton}>
        <Text style={styles.textButtonLabel}>Zamknij</Text>
      </Pressable>
    </View>
    {pin.pending ? <Text style={styles.pending}>Zapisane na telefonie, wyślę na serwer, gdy będzie zasięg.</Text> : null}
    {pin.photos.length ? (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs}>
        {pin.photos.map((photo) => (
          <PhotoThumb key={photo.id} projectId={projectId} photo={photo} onPress={() => onOpenPhoto(photo)} />
        ))}
      </ScrollView>
    ) : null}
    {pin.note ? <Text style={styles.note}>{pin.note}</Text> : null}
    <PickerButtons onPicked={onAddPhotos} />
    <View style={styles.row}>
      <View style={styles.flex}>
        <Button label="Edytuj opis" variant="secondary" onPress={onEdit} />
      </View>
      <View style={styles.flex}>
        <Button label="Usuń pinezkę" variant="secondary" onPress={onDelete} />
      </View>
    </View>
  </View>
);

export type PinDraft = { note: string; room: string; photos: PickedPhoto[] };

// New pin: photos first (that is why the contractor is here), then where and what. Editing an existing pin changes only the text.
export const PinEditor = ({
  initial,
  isNew,
  onSave,
  onCancel,
}: {
  initial: PinDraft;
  isNew: boolean;
  onSave: (draft: PinDraft) => void;
  onCancel: () => void;
}) => {
  const [draft, setDraft] = useState(initial);
  const empty = isNew && draft.photos.length === 0 && !draft.note.trim();
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>{isNew ? "Nowe zdjęcie w tym miejscu" : "Opis pinezki"}</Text>
      {isNew ? (
        <>
          {draft.photos.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs}>
              {draft.photos.map((photo) => (
                <Image key={photo.uri} source={{ uri: photo.uri }} style={styles.thumb} resizeMode="cover" />
              ))}
            </ScrollView>
          ) : null}
          <PickerButtons onPicked={(photos) => setDraft((current) => ({ ...current, photos: [...current.photos, ...photos] }))} />
        </>
      ) : null}
      <View style={styles.field}>
        <Text style={styles.label}>Pomieszczenie</Text>
        <TextInput
          value={draft.room}
          onChangeText={(room) => setDraft((current) => ({ ...current, room }))}
          placeholder="np. Łazienka 1.04"
          placeholderTextColor={colors.muted}
          style={styles.input}
          maxLength={200}
          returnKeyType="next"
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Notatka</Text>
        <TextInput
          value={draft.note}
          onChangeText={(note) => setDraft((current) => ({ ...current, note }))}
          placeholder="np. instalacja wodna przed zakryciem"
          placeholderTextColor={colors.muted}
          style={[styles.input, styles.multiline]}
          multiline
          maxLength={4000}
        />
        <Text style={styles.hint}>Możesz podyktować notatkę mikrofonem na klawiaturze.</Text>
      </View>
      <View style={styles.row}>
        <View style={styles.flex}>
          <Button label="Anuluj" variant="secondary" onPress={onCancel} />
        </View>
        <View style={styles.flex}>
          <Button label="Zapisz" onPress={() => onSave(draft)} disabled={empty} />
        </View>
      </View>
    </View>
  );
};

// One photo over the whole drawing; deleting asks first, because a photo from site cannot be taken again.
export const PhotoOverlay = ({
  projectId,
  photo,
  onClose,
  onDelete,
}: {
  projectId: string;
  photo: ViewPhoto;
  onClose: () => void;
  onDelete: () => void;
}) => {
  const source = usePhotoSource(projectId, photo, "full");
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  return (
    <View style={styles.overlay}>
      <View style={styles.overlayBar}>
        <Text style={styles.overlayTitle}>{formatDateTime(photo.takenAt)}</Text>
        <Pressable accessibilityRole="button" onPress={onDelete} style={styles.darkButton}>
          <Text style={styles.darkButtonLabel}>Usuń</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.darkButton}>
          <Text style={styles.darkButtonLabel}>Zamknij</Text>
        </Pressable>
      </View>
      <View style={styles.flex}>
        <Image
          source={source}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
          onLoad={() => setState("loaded")}
          onError={() => setState("error")}
          accessibilityLabel={`Zdjęcie z ${formatDateTime(photo.takenAt)}`}
        />
        {state === "loading" ? <ActivityIndicator style={styles.center} color="#FFFFFF" size="large" /> : null}
        {state === "error" ? (
          <View style={styles.center}>
            <Text style={styles.overlayError}>Nie udało się pobrać zdjęcia. Sprawdź zasięg.</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
};

const THUMB = 88;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  panel: {
    gap: spacing.md,
    padding: spacing.md,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  header: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  title: { fontSize: 18, fontWeight: "600", color: colors.text },
  meta: { fontSize: 14, color: colors.muted, marginTop: 2 },
  pending: { fontSize: 14, lineHeight: 20, color: colors.link },
  note: { fontSize: 16, lineHeight: 22, color: colors.text },
  row: { flexDirection: "row", gap: spacing.sm },
  thumbs: { gap: spacing.sm },
  thumb: { width: THUMB, height: THUMB, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.border, justifyContent: "center" },
  thumbError: { fontSize: 11, color: colors.muted, textAlign: "center", padding: spacing.xs },
  pressed: { opacity: 0.8 },
  badge: { position: "absolute", left: 4, bottom: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: "rgba(28, 28, 26, 0.75)" },
  badgeText: { fontSize: 11, fontWeight: "600", color: "#FFFFFF" },
  field: { gap: spacing.xs },
  label: { fontSize: 14, fontWeight: "600", color: colors.text },
  input: {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.background,
  },
  multiline: { minHeight: 88, textAlignVertical: "top" },
  hint: { fontSize: 13, color: colors.muted },
  textButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.sm },
  textButtonLabel: { fontSize: 16, fontWeight: "600", color: colors.link },
  overlay: { ...StyleSheet.absoluteFill, backgroundColor: "#111110", zIndex: 10 },
  overlayBar: { flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md },
  overlayTitle: { flex: 1, color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  darkButton: { minHeight: 44, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: "#2A2A28", justifyContent: "center" },
  darkButtonLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  center: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", padding: spacing.lg },
  overlayError: { color: "#FFFFFF", fontSize: 16, textAlign: "center" },
});
