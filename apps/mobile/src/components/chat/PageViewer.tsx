import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { ImageSourcePropType } from "react-native";
import { ActivityIndicator, Image, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import {
  GestureDetector,
  GestureHandlerRootView,
  useExclusiveGestures,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { containRect, pageToScreen, pinAt, pinsOnPage, randomId, screenToPage } from "../../lib/pins";
import { STATUS_COLORS, assigneesOf } from "../../lib/defects";
import type { DefectStatus, PinFields, PinKind, Point, Size, ViewPhoto, ViewPin } from "../../lib/pins";
import { colors, radius, spacing } from "../../lib/theme";
import { usePageImage } from "../pages/usePageImage";
import { confirm } from "../pins/pickPhotos";
import { DefectDetails, DefectEditor } from "../pins/DefectPanel";
import { PhotoOverlay, PinDetails, PinEditor } from "../pins/PinPanel";
import { usePins } from "../pins/PinsProvider";

// `pinId` opens the page with that pin's photos showing (e.g. from a photo the agent found).
export type ViewedPage = { documentId: string; pageNo: number; title?: string | null; caption?: string | null; pinId?: string };

// `sequence` is the list the page was opened from (e.g. all pages of a document), for flipping to the previous or next page.
type OpenPage = (page: ViewedPage, sequence?: ViewedPage[]) => void;

const PageViewerContext = createContext<OpenPage | null>(null);

export const usePageViewer = () => {
  const open = useContext(PageViewerContext);
  if (!open) throw new Error("usePageViewer must be used inside PageViewerProvider");
  return open;
};

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const DOUBLE_TAP_SCALE = 3;

const clamp = (value: number, min: number, max: number) => {
  "worklet";
  return Math.min(Math.max(value, min), max);
};

type PageTap = { point: Point | null; pin: ViewPin | null };

const MARKER = 30;

const DEFECT_SYMBOLS: Record<DefectStatus, string> = { open: "!", to_check: "?", closed: "✓" };

// A photo pin shows how many photos it has; a defect its status, by colour and symbol.
const markerLook = (pin: ViewPin | null) => {
  if (!pin) return { label: "+", color: undefined };
  if (pin.kind === "defect") return { label: DEFECT_SYMBOLS[pin.status ?? "open"], color: STATUS_COLORS[pin.status ?? "open"] };
  return { label: String(pin.photos.length || "•"), color: undefined };
};

// A pin on the drawing. It sits inside the zoomed layer, so it follows the page, and is scaled back to keep its size.
const PinMarker = ({ pin, at, selected, counterScale }: { pin: ViewPin | null; at: Point; selected: boolean; counterScale: ReturnType<typeof useAnimatedStyle> }) => {
  const { label, color } = markerLook(pin);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.marker,
        { left: at.x - MARKER / 2, top: at.y - MARKER / 2 },
        color ? { backgroundColor: color, borderRadius: 6 } : null,
        selected && styles.markerSelected,
        pin?.pending && styles.markerPending,
        counterScale,
      ]}
    >
      <Text style={styles.markerLabel}>{label}</Text>
    </Animated.View>
  );
};

const sourceUri = (source: ImageSourcePropType) =>
  typeof source === "object" && source !== null && "uri" in source ? source.uri : undefined;

const usePinLayer = (scale: SharedValue<number>) => useAnimatedStyle(() => ({ transform: [{ scale: 1 / scale.value }] }));

// A1 drawings need real zoom: pinch around the fingers, drag when zoomed in, double tap to zoom in or back out.
// A single tap picks a pin, or places a new one while `placing`.
const ZoomableImage = ({
  page,
  onLoadStateChange,
  pins,
  selectedId,
  draft,
  onTap,
}: {
  page: ViewedPage;
  onLoadStateChange: (state: "loaded" | "error") => void;
  pins: ViewPin[];
  selectedId: string | null;
  draft: Point | null;
  onTap: (tap: PageTap) => void;
}) => {
  const image = usePageImage(page.documentId, page.pageNo);
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<Size>({ width: 0, height: 0 });
  const rect = useMemo(() => containRect(box, natural), [box, natural]);
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const start = useSharedValue({ scale: 1, x: 0, y: 0 });

  // Keeps the image edge from leaving the screen once zoomed.
  const clampTranslation = (x: number, y: number, s: number) => {
    "worklet";
    const maxX = (width.value * (s - 1)) / 2;
    const maxY = (height.value * (s - 1)) / 2;
    return { x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
  };

  const pinch = usePinchGesture({
    onActivate: () => {
      start.value = { scale: scale.value, x: translateX.value, y: translateY.value };
    },
    onUpdate: (event) => {
      const next = clamp(start.value.scale * event.scale, MIN_SCALE, MAX_SCALE);
      // Keep the point under the fingers where it is: focal offset from the centre, scaled by the zoom change.
      const focalX = event.focalX - width.value / 2;
      const focalY = event.focalY - height.value / 2;
      const ratio = next / start.value.scale;
      const moved = clampTranslation(focalX - (focalX - start.value.x) * ratio, focalY - (focalY - start.value.y) * ratio, next);
      scale.value = next;
      translateX.value = moved.x;
      translateY.value = moved.y;
    },
  });

  const pan = usePanGesture({
    maxPointers: 2,
    onActivate: () => {
      start.value = { scale: scale.value, x: translateX.value, y: translateY.value };
    },
    onUpdate: (event) => {
      const moved = clampTranslation(start.value.x + event.translationX, start.value.y + event.translationY, scale.value);
      translateX.value = moved.x;
      translateY.value = moved.y;
    },
  });

  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    onActivate: (event) => {
      if (scale.value > MIN_SCALE) {
        scale.value = withTiming(MIN_SCALE);
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        return;
      }
      const focalX = event.x - width.value / 2;
      const focalY = event.y - height.value / 2;
      const moved = clampTranslation(-focalX * (DOUBLE_TAP_SCALE - 1), -focalY * (DOUBLE_TAP_SCALE - 1), DOUBLE_TAP_SCALE);
      scale.value = withTiming(DOUBLE_TAP_SCALE);
      translateX.value = withTiming(moved.x);
      translateY.value = withTiming(moved.y);
    },
  });

  const singleTap = useTapGesture({
    runOnJS: true,
    onActivate: (event) => {
      const zoom = { scale: scale.value, translateX: translateX.value, translateY: translateY.value };
      const tap = { x: event.x, y: event.y };
      const pin = pinAt(pins, tap, (point) => pageToScreen(point, box, zoom, rect));
      onTap({ pin, point: natural.width ? screenToPage(tap, box, zoom, rect) : null });
    },
  });

  const zoomAndDrag = useSimultaneousGestures(pinch, pan);
  const gesture = useExclusiveGestures(doubleTap, singleTap, zoomAndDrag);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }));
  const counterScale = usePinLayer(scale);
  const inContent = (point: Point) => ({ x: rect.x + point.x * rect.width, y: rect.y + point.y * rect.height });

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={styles.zoomArea}
        collapsable={false}
        onLayout={(event) => {
          const { width: layoutWidth, height: layoutHeight } = event.nativeEvent.layout;
          width.value = layoutWidth;
          height.value = layoutHeight;
          setBox({ width: layoutWidth, height: layoutHeight });
        }}
      >
        <Animated.View style={[StyleSheet.absoluteFill, animatedStyle]}>
          <Image
            source={image.source}
            style={StyleSheet.absoluteFill}
            resizeMode="contain"
            onLoad={(event) => {
              image.onLoad();
              onLoadStateChange("loaded");
              const { width: imageWidth, height: imageHeight } = event.nativeEvent.source ?? {};
              if (imageWidth && imageHeight) setNatural({ width: imageWidth, height: imageHeight });
              // The browser does not always report the size on load.
              else if (sourceUri(image.source)) Image.getSize(sourceUri(image.source)!, (w, h) => setNatural({ width: w, height: h }), () => undefined);
            }}
            onError={() => {
              if (!image.onError()) onLoadStateChange("error");
            }}
            accessibilityLabel={`Strona ${page.pageNo}${page.title ? `: ${page.title}` : ""}`}
          />
          {natural.width
            ? pins.map((pin) => <PinMarker key={pin.id} pin={pin} at={inContent(pin)} selected={pin.id === selectedId} counterScale={counterScale} />)
            : null}
          {natural.width && draft ? <PinMarker pin={null} at={inContent(draft)} selected counterScale={counterScale} /> : null}
        </Animated.View>
      </View>
    </GestureDetector>
  );
};

type Neighbours = { onPrevious: (() => void) | null; onNext: (() => void) | null };

type Mode =
  | { type: "view" }
  | { type: "placing"; kind: PinKind }
  | { type: "new"; kind: PinKind; point: Point }
  | { type: "details"; pinId: string }
  | { type: "edit"; pinId: string };

const pinFields = ({ photos: _photos, pending: _pending, authorName: _authorName, spec: _spec, ...fields }: ViewPin): PinFields => fields;

const PageViewerModal = ({ page, onClose, onPrevious, onNext }: { page: ViewedPage; onClose: () => void } & Neighbours) => {
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const { projectId, pins: allPins, savePin, removePin, addPhotos, removePhoto } = usePins();
  const openPage = usePageViewer();
  const assignees = useMemo(() => assigneesOf(allPins), [allPins]);
  const pins = useMemo(() => pinsOnPage(allPins, page.documentId, page.pageNo), [allPins, page.documentId, page.pageNo]);
  const [mode, setMode] = useState<Mode>(page.pinId ? { type: "details", pinId: page.pinId } : { type: "view" });
  const [openPhoto, setOpenPhoto] = useState<ViewPhoto | null>(null);
  const retry = () => {
    setLoadState("loading");
    setAttempt((value) => value + 1);
  };

  const shownPin = mode.type === "details" || mode.type === "edit" ? pins.find((pin) => pin.id === mode.pinId) : undefined;
  // The pin may vanish under an open panel (deleted on another phone and synced).
  const current: Mode = (mode.type === "details" || mode.type === "edit") && !shownPin ? { type: "view" } : mode;

  const onTap = ({ point, pin }: PageTap) => {
    if (current.type === "placing") {
      if (point) setMode({ type: "new", kind: current.kind, point });
    } else if (current.type === "view" || current.type === "details") {
      setMode(pin ? { type: "details", pinId: pin.id } : { type: "view" });
    }
  };

  const deletePin = async (pin: ViewPin) => {
    const photos = pin.photos.length ? ` i ${pin.photos.length === 1 ? "jego zdjęcie" : "wszystkie jego zdjęcia"}` : "";
    const confirmed =
      pin.kind === "defect"
        ? await confirm("Usunąć usterkę?", `Usterka${photos ? " ze zdjęciami" : ""} zniknie z listy całej ekipy i z protokołu.`, "Usuń")
        : await confirm("Usunąć pinezkę?", `Usuniesz to miejsce${photos} dla całej ekipy.`, "Usuń");
    if (!confirmed) return;
    removePin(pin.id);
    setMode({ type: "view" });
  };

  const deletePhoto = async (pin: ViewPin, photo: ViewPhoto) => {
    if (!(await confirm("Usunąć zdjęcie?", "Zdjęcie zniknie dla całej ekipy.", "Usuń"))) return;
    removePhoto(pin.id, photo.id);
    setOpenPhoto(null);
  };

  const newPin = (point: Point, kind: PinKind, text: { note: string; room: string; assignee?: string; dueDate?: string | null }) => {
    const now = new Date().toISOString();
    const id = randomId();
    const defect = kind === "defect";
    savePin({
      id,
      documentId: page.documentId,
      pageNo: page.pageNo,
      pageTitle: page.title ?? null,
      x: point.x,
      y: point.y,
      kind,
      note: text.note.trim(),
      room: text.room.trim(),
      status: defect ? "open" : null,
      assignee: defect ? (text.assignee ?? "").trim() : "",
      dueDate: defect ? (text.dueDate ?? null) : null,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  };

  const panel = (() => {
    if (current.type === "new" && current.kind === "defect") {
      return (
        <DefectEditor
          projectId={projectId}
          isNew
          assignees={assignees}
          initial={{ note: "", room: "", assignee: "", dueDate: null, photos: [] }}
          onCancel={() => setMode({ type: "view" })}
          onSave={(draft) => {
            const id = newPin(current.point, "defect", draft);
            addPhotos(id, draft.photos, "before");
            setMode({ type: "details", pinId: id });
          }}
        />
      );
    }
    if (current.type === "edit" && shownPin?.kind === "defect") {
      return (
        <DefectEditor
          projectId={projectId}
          isNew={false}
          assignees={assignees}
          initial={{ note: shownPin.note, room: shownPin.room, assignee: shownPin.assignee, dueDate: shownPin.dueDate, photos: [] }}
          onCancel={() => setMode({ type: "details", pinId: shownPin.id })}
          onSave={(draft) => {
            savePin({
              ...pinFields(shownPin),
              note: draft.note.trim(),
              room: draft.room.trim(),
              assignee: draft.assignee.trim(),
              dueDate: draft.dueDate,
              updatedAt: new Date().toISOString(),
            });
            setMode({ type: "details", pinId: shownPin.id });
          }}
        />
      );
    }
    if (current.type === "details" && shownPin?.kind === "defect") {
      return (
        <DefectDetails
          projectId={projectId}
          pin={shownPin}
          onClose={() => setMode({ type: "view" })}
          onEdit={() => setMode({ type: "edit", pinId: shownPin.id })}
          onDelete={() => void deletePin(shownPin)}
          onSetStatus={(status) => savePin({ ...pinFields(shownPin), status, updatedAt: new Date().toISOString() })}
          onAddPhotos={(photos, stage) => addPhotos(shownPin.id, photos, stage)}
          onOpenPhoto={setOpenPhoto}
          onOpenSource={({ source }) => source && openPage({ documentId: source.documentId, pageNo: source.pageNo, title: source.title })}
        />
      );
    }
    if (current.type === "new") {
      return (
        <PinEditor
          isNew
          initial={{ note: "", room: "", photos: [] }}
          onCancel={() => setMode({ type: "view" })}
          onSave={(draft) => {
            const id = newPin(current.point, "photo", draft);
            addPhotos(id, draft.photos);
            setMode({ type: "details", pinId: id });
          }}
        />
      );
    }
    if (current.type === "edit" && shownPin) {
      return (
        <PinEditor
          isNew={false}
          initial={{ note: shownPin.note, room: shownPin.room, photos: [] }}
          onCancel={() => setMode({ type: "details", pinId: shownPin.id })}
          onSave={(draft) => {
            savePin({ ...pinFields(shownPin), note: draft.note.trim(), room: draft.room.trim(), updatedAt: new Date().toISOString() });
            setMode({ type: "details", pinId: shownPin.id });
          }}
        />
      );
    }
    if (current.type === "details" && shownPin) {
      return (
        <PinDetails
          projectId={projectId}
          pin={shownPin}
          onClose={() => setMode({ type: "view" })}
          onEdit={() => setMode({ type: "edit", pinId: shownPin.id })}
          onDelete={() => void deletePin(shownPin)}
          onAddPhotos={(photos) => addPhotos(shownPin.id, photos)}
          onOpenPhoto={setOpenPhoto}
        />
      );
    }
    return null;
  })();

  return (
    <GestureHandlerRootView style={styles.modalRoot}>
      <SafeAreaView style={styles.modalRoot} edges={["top", "bottom"]}>
        <KeyboardAvoidingView style={styles.modalRoot} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.topBar}>
            <View style={styles.titleBox}>
              <Text style={styles.title} numberOfLines={1}>
                {`Str. ${page.pageNo}${page.title ? ` – ${page.title}` : ""}`}
              </Text>
              {page.caption ? (
                <Text style={styles.caption} numberOfLines={2}>
                  {page.caption}
                </Text>
              ) : null}
            </View>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.closeButton} hitSlop={8}>
              <Text style={styles.closeLabel}>Zamknij</Text>
            </Pressable>
          </View>
          <View style={styles.imageArea}>
            <ZoomableImage
              key={attempt}
              page={page}
              onLoadStateChange={setLoadState}
              pins={pins}
              selectedId={shownPin?.id ?? null}
              draft={current.type === "new" ? current.point : null}
              onTap={onTap}
            />
            {loadState === "loading" ? <ActivityIndicator style={styles.overlay} color="#FFFFFF" size="large" /> : null}
            {loadState === "error" ? (
              <View style={styles.overlay}>
                <Text style={styles.errorText}>
                  Nie udało się pobrać rysunku. Sprawdź zasięg albo zapisz strony na telefonie w zakładce „Projekt”.
                </Text>
                <Pressable accessibilityRole="button" onPress={retry} style={styles.retryButton}>
                  <Text style={styles.retryLabel}>Ponów</Text>
                </Pressable>
              </View>
            ) : null}
            {current.type === "placing" ? (
              <View style={styles.placingBanner} pointerEvents="none">
                <Text style={styles.placingText}>
                  {current.kind === "defect" ? "Stuknij miejsce usterki na rysunku" : "Stuknij miejsce na rysunku, gdzie robisz zdjęcie"}
                </Text>
              </View>
            ) : null}
          </View>
          {panel ?? (
            <>
              <View style={styles.pager}>
                {current.type === "placing" ? (
                  <PagerButton label="Anuluj" onPress={() => setMode({ type: "view" })} />
                ) : (
                  <>
                    {onPrevious || onNext ? <PagerButton label="‹" onPress={onPrevious} narrow /> : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Przypnij zdjęcie"
                      disabled={loadState !== "loaded"}
                      onPress={() => setMode({ type: "placing", kind: "photo" })}
                      style={[styles.pinButton, loadState !== "loaded" && styles.pagerDisabled]}
                    >
                      <Text style={styles.pinButtonLabel}>+ Zdjęcie</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Zgłoś usterkę"
                      disabled={loadState !== "loaded"}
                      onPress={() => setMode({ type: "placing", kind: "defect" })}
                      style={[styles.pinButton, styles.defectButton, loadState !== "loaded" && styles.pagerDisabled]}
                    >
                      <Text style={styles.pinButtonLabel}>+ Usterka</Text>
                    </Pressable>
                    {onPrevious || onNext ? <PagerButton label="›" onPress={onNext} narrow /> : null}
                  </>
                )}
              </View>
              <Text style={styles.hint}>
                {pins.length
                  ? "Stuknij pinezkę, aby zobaczyć zdjęcia lub usterkę. Rozsuń palce, aby powiększyć."
                  : "Rozsuń palce, aby powiększyć. Stuknij dwa razy, aby przybliżyć lub wrócić."}
              </Text>
            </>
          )}
          {openPhoto && shownPin ? (
            <PhotoOverlay projectId={projectId} photo={openPhoto} onClose={() => setOpenPhoto(null)} onDelete={() => void deletePhoto(shownPin, openPhoto)} />
          ) : null}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </GestureHandlerRootView>
  );
};

const PagerButton = ({ label, onPress, narrow = false }: { label: string; onPress: (() => void) | null; narrow?: boolean }) => (
  <Pressable
    accessibilityRole="button"
    accessibilityLabel={label === "‹" ? "Poprzednia strona" : label === "›" ? "Następna strona" : label}
    accessibilityState={{ disabled: !onPress }}
    disabled={!onPress}
    onPress={onPress ?? undefined}
    style={[styles.pagerButton, narrow && styles.pagerNarrow, !onPress && styles.pagerDisabled]}
  >
    <Text style={[styles.closeLabel, narrow && styles.arrowLabel]}>{label}</Text>
  </Pressable>
);

const samePage = (a: ViewedPage, b: ViewedPage) => a.documentId === b.documentId && a.pageNo === b.pageNo;

export const PageViewerProvider = ({ children }: { children: ReactNode }) => {
  const [viewing, setViewing] = useState<{ sequence: ViewedPage[]; index: number } | null>(null);
  const open = useCallback<OpenPage>((page, sequence) => {
    const index = sequence?.findIndex((candidate) => samePage(candidate, page)) ?? -1;
    setViewing(sequence && index >= 0 ? { sequence, index } : { sequence: [page], index: 0 });
  }, []);
  const close = useCallback(() => setViewing(null), []);
  const page = viewing ? viewing.sequence[viewing.index] : undefined;
  const step = (delta: number) => () => setViewing((current) => current && { ...current, index: current.index + delta });

  return (
    <PageViewerContext.Provider value={open}>
      {children}
      <Modal visible={page !== undefined} animationType="fade" onRequestClose={close} supportedOrientations={["portrait", "landscape"]}>
        {viewing && page ? (
          <PageViewerModal
            key={`${page.documentId}:${page.pageNo}`}
            page={page}
            onClose={close}
            onPrevious={viewing.index > 0 ? step(-1) : null}
            onNext={viewing.index < viewing.sequence.length - 1 ? step(1) : null}
          />
        ) : null}
      </Modal>
    </PageViewerContext.Provider>
  );
};

const styles = StyleSheet.create({
  modalRoot: { flex: 1, backgroundColor: "#111110" },
  topBar: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  titleBox: { flex: 1, gap: 2 },
  title: { color: "#FFFFFF", fontSize: 17, fontWeight: "600" },
  caption: { color: "#C9C8C2", fontSize: 14 },
  closeButton: { minHeight: 44, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: "#2A2A28", justifyContent: "center" },
  closeLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  imageArea: { flex: 1, overflow: "hidden" },
  zoomArea: { flex: 1, backgroundColor: "#FFFFFF" },
  overlay: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.lg },
  errorText: { color: colors.text, fontSize: 16, textAlign: "center" },
  retryButton: { minHeight: 44, paddingHorizontal: spacing.lg, borderRadius: radius.md, backgroundColor: colors.accent, justifyContent: "center" },
  retryLabel: { color: colors.accentText, fontSize: 16, fontWeight: "600" },
  pager: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  pagerButton: { flex: 1, minHeight: 48, borderRadius: radius.md, backgroundColor: "#2A2A28", alignItems: "center", justifyContent: "center" },
  pagerNarrow: { flex: 0, width: 56 },
  arrowLabel: { fontSize: 26, lineHeight: 30 },
  pagerDisabled: { opacity: 0.35 },
  pinButton: { flex: 1, minHeight: 48, borderRadius: radius.md, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  pinButtonLabel: { color: colors.accentText, fontSize: 16, fontWeight: "600" },
  defectButton: { backgroundColor: STATUS_COLORS.open },
  placingBanner: { position: "absolute", top: spacing.sm, left: spacing.md, right: spacing.md, padding: spacing.sm, borderRadius: radius.md, backgroundColor: "rgba(17, 17, 16, 0.85)" },
  placingText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600", textAlign: "center" },
  marker: {
    position: "absolute",
    width: MARKER,
    height: MARKER,
    borderRadius: MARKER / 2,
    borderWidth: 2,
    borderColor: "#FFFFFF",
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000000",
    shadowOpacity: 0.35,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  markerSelected: { backgroundColor: colors.text },
  // Not on the server yet.
  markerPending: { opacity: 0.7 },
  markerLabel: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
  hint: { color: "#C9C8C2", fontSize: 13, textAlign: "center", padding: spacing.sm },
});
