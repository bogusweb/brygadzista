import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
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
import { SafeAreaView } from "react-native-safe-area-context";
import { pageImageSource } from "../../lib/api";
import { useConnection } from "../../lib/settings";
import { colors, radius, spacing } from "../../lib/theme";

export type ViewedPage = { documentId: string; pageNo: number; title?: string | null; caption?: string | null };

const PageViewerContext = createContext<((page: ViewedPage) => void) | null>(null);

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

// A1 drawings need real zoom: pinch around the fingers, drag when zoomed in, double tap to zoom in or back out.
const ZoomableImage = ({ page, onLoadStateChange }: { page: ViewedPage; onLoadStateChange: (state: "loaded" | "error") => void }) => {
  const connection = useConnection();
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

  const zoomAndDrag = useSimultaneousGestures(pinch, pan);
  const gesture = useExclusiveGestures(doubleTap, zoomAndDrag);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={styles.zoomArea}
        collapsable={false}
        onLayout={(event) => {
          width.value = event.nativeEvent.layout.width;
          height.value = event.nativeEvent.layout.height;
        }}
      >
        <Animated.View style={[StyleSheet.absoluteFill, animatedStyle]}>
          <Image
            source={pageImageSource(connection, page.documentId, page.pageNo)}
            style={StyleSheet.absoluteFill}
            resizeMode="contain"
            onLoad={() => onLoadStateChange("loaded")}
            onError={() => onLoadStateChange("error")}
            accessibilityLabel={`Strona ${page.pageNo}${page.title ? `: ${page.title}` : ""}`}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
};

const PageViewerModal = ({ page, onClose }: { page: ViewedPage; onClose: () => void }) => {
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    setLoadState("loading");
    setAttempt((value) => value + 1);
  };

  return (
    <GestureHandlerRootView style={styles.modalRoot}>
      <SafeAreaView style={styles.modalRoot} edges={["top", "bottom"]}>
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
          <ZoomableImage key={attempt} page={page} onLoadStateChange={setLoadState} />
          {loadState === "loading" ? <ActivityIndicator style={styles.overlay} color="#FFFFFF" size="large" /> : null}
          {loadState === "error" ? (
            <View style={styles.overlay}>
              <Text style={styles.errorText}>Nie udało się pobrać rysunku. Sprawdź zasięg.</Text>
              <Pressable accessibilityRole="button" onPress={retry} style={styles.retryButton}>
                <Text style={styles.retryLabel}>Ponów</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
        <Text style={styles.hint}>Rozsuń palce, aby powiększyć. Stuknij dwa razy, aby przybliżyć lub wrócić.</Text>
      </SafeAreaView>
    </GestureHandlerRootView>
  );
};

export const PageViewerProvider = ({ children }: { children: ReactNode }) => {
  const [page, setPage] = useState<ViewedPage | null>(null);
  const open = useCallback((next: ViewedPage) => setPage(next), []);
  const close = useCallback(() => setPage(null), []);

  return (
    <PageViewerContext.Provider value={open}>
      {children}
      <Modal visible={page !== null} animationType="fade" onRequestClose={close} supportedOrientations={["portrait", "landscape"]}>
        {page ? <PageViewerModal page={page} onClose={close} /> : null}
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
  hint: { color: "#C9C8C2", fontSize: 13, textAlign: "center", padding: spacing.sm },
});
