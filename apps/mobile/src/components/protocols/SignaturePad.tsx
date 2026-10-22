import { useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import Svg, { Path } from "react-native-svg";
import { colors, radius, spacing } from "../../lib/theme";

// A signature drawn with a finger (#82). Points are kept in a 0..1 box, so the server can draw the same lines at any
// size; the pad sends strokes, not a picture.
export type Strokes = [number, number][][];

const ASPECT = 3;

const toPath = (strokes: Strokes, width: number, height: number) =>
  strokes
    .map((stroke) => {
      const [first, ...rest] = stroke.map(([x, y]) => `${(x * width).toFixed(1)} ${(y * height).toFixed(1)}`);
      return rest.length ? `M ${first} L ${rest.join(" L ")}` : `M ${first} l 0.1 0`;
    })
    .join(" ");

const clamp = (value: number) => Math.min(Math.max(value, 0), 1);

export const SignaturePad = ({ onChange }: { onChange: (signature: { aspect: number; strokes: Strokes } | null) => void }) => {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [strokes, setStrokes] = useState<Strokes>([]);
  const strokesRef = useRef<Strokes>([]);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const responder = useMemo(() => {
    const point = (x: number, y: number): [number, number] => [clamp(x / (sizeRef.current.width || 1)), clamp(y / (sizeRef.current.height || 1))];
    const update = (change: (current: Strokes) => Strokes) => {
      const next = change(strokesRef.current);
      strokesRef.current = next;
      setStrokes(next);
      onChangeRef.current(next.length ? { aspect: ASPECT, strokes: next } : null);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // A signature must not scroll the sheet it sits on.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        const { locationX, locationY } = event.nativeEvent;
        update((current) => [...current, [point(locationX, locationY)]]);
      },
      onPanResponderMove: (event) => {
        const { locationX, locationY } = event.nativeEvent;
        update((current) => {
          const last = current[current.length - 1];
          if (!last || last.length >= 2000) return current;
          return [...current.slice(0, -1), [...last, point(locationX, locationY)]];
        });
      },
    });
  }, []);

  const onLayout = ({ nativeEvent }: LayoutChangeEvent) => {
    const width = nativeEvent.layout.width;
    setSize({ width, height: width / ASPECT });
  };

  const clear = () => {
    strokesRef.current = [];
    setStrokes([]);
    onChange(null);
  };

  return (
    <View style={styles.wrap}>
      <View onLayout={onLayout} style={[styles.pad, { height: size.height || 120 }]} {...responder.panHandlers} accessibilityLabel="Pole podpisu">
        {size.width ? (
          <Svg width={size.width} height={size.height} pointerEvents="none">
            <Path d={toPath(strokes, size.width, size.height)} stroke="#10204A" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        ) : null}
        {strokes.length === 0 ? (
          <Text style={styles.placeholder} pointerEvents="none">
            Podpisz się palcem
          </Text>
        ) : null}
      </View>
      <Pressable accessibilityRole="button" onPress={clear} hitSlop={8} style={styles.clear}>
        <Text style={styles.link}>Wyczyść</Text>
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  pad: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: "#FFFFFF", overflow: "hidden" },
  placeholder: { position: "absolute", alignSelf: "center", top: "40%", fontSize: 15, color: colors.muted },
  clear: { alignSelf: "flex-end" },
  link: { fontSize: 15, color: colors.link },
});
