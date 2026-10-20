import type { ReactNode } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { childRefs, resolveProps, text } from "../../lib/a2ui";
import type { A2UIComponent, Scope, Surface, SurfaceActivity } from "../../lib/a2ui";
import { colors, radius, spacing } from "../../lib/theme";
import { ToolStatus } from "../chat/ToolStatus";
import { CATALOG_RENDERERS } from "./catalog";
import type { ComponentRenderer } from "./sourcePage";

// Agent-built surfaces can nest freely; past this depth something is cyclic.
const MAX_DEPTH = 24;

const TEXT_VARIANTS: Record<string, object> = {
  h1: { fontSize: 24, lineHeight: 30, fontWeight: "700" },
  h2: { fontSize: 21, lineHeight: 27, fontWeight: "700" },
  h3: { fontSize: 18, lineHeight: 24, fontWeight: "700" },
  h4: { fontSize: 16, lineHeight: 22, fontWeight: "700" },
  h5: { fontSize: 15, lineHeight: 21, fontWeight: "600" },
  caption: { fontSize: 13, lineHeight: 18, color: colors.muted },
};

// The part of the basic A2UI catalog the agent actually uses for layout. Buttons, inputs and the like need actions,
// which the app does not send back yet, so they fall through to the "not supported" note.
const BASIC_RENDERERS: Record<string, ComponentRenderer> = {
  Text: (props) => <Text style={[styles.text, TEXT_VARIANTS[text(props.variant)]]}>{text(props.text)}</Text>,
  Card: (_, children) => <View style={styles.card}>{children}</View>,
  Column: (_, children) => <View style={styles.column}>{children}</View>,
  List: (props, children) => <View style={props.direction === "horizontal" ? styles.row : styles.column}>{children}</View>,
  Row: (_, children) => <View style={styles.row}>{children}</View>,
  Divider: () => <View style={styles.divider} />,
  Image: (props) =>
    text(props.url) ? <Image source={{ uri: text(props.url) }} style={styles.image} resizeMode="contain" accessibilityIgnoresInvertColors /> : null,
  Icon: () => null,
};

const RENDERERS: Record<string, ComponentRenderer> = { ...BASIC_RENDERERS, ...CATALOG_RENDERERS };

export const SUPPORTED_COMPONENTS = Object.keys(RENDERERS);

const Unsupported = ({ name }: { name: string }) => (
  <Text style={styles.unsupported}>{`Element „${name}” nie jest jeszcze obsługiwany w aplikacji.`}</Text>
);

const SurfaceView = ({ surface }: { surface: Surface }) => {
  const render = (id: string, scope: Scope, depth: number, key: string): ReactNode => {
    const component: A2UIComponent | undefined = surface.components[id];
    if (!component || depth > MAX_DEPTH) return null;
    const renderer = RENDERERS[component.component];
    if (!renderer) return <Unsupported key={key} name={component.component} />;
    const props = resolveProps(component, scope);
    const children = childRefs(component, scope).map((child, index) => render(child.id, child.scope, depth + 1, `${key}/${index}`));
    // `weight` is the A2UI way to share a Row; on a phone it becomes flex-grow with a sensible minimum width.
    const weight = typeof component.weight === "number" ? component.weight : undefined;
    return (
      <View key={key} style={weight ? [styles.weighted, { flexGrow: weight }] : undefined}>
        {renderer(props, children)}
      </View>
    );
  };
  return <>{render("root", { data: surface.data, basePath: "/" }, 0, surface.surfaceId)}</>;
};

// One "a2ui-surface" activity: the build status while the agent writes it, then the surface itself.
export const A2UIActivity = ({ activity }: { activity: SurfaceActivity }) => {
  switch (activity.kind) {
    case "building":
      return <ToolStatus label="Przygotowuję zestawienie…" done={false} />;
    case "retrying":
      return <ToolStatus label={`Poprawiam zestawienie (próba ${activity.attempt} z ${activity.maxAttempts})…`} done={false} />;
    case "failed":
      return <ToolStatus label="Nie udało się przygotować zestawienia, odpowiedź jest w tekście." done />;
    case "ready":
      return (
        <View style={styles.surfaces}>
          {activity.surfaces.map((surface) => (
            <SurfaceView key={surface.surfaceId} surface={surface} />
          ))}
        </View>
      );
  }
};

const styles = StyleSheet.create({
  surfaces: { gap: spacing.md },
  text: { fontSize: 15, lineHeight: 21, color: colors.text },
  card: {
    padding: spacing.md,
    gap: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  column: { gap: spacing.md },
  row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  weighted: { flexBasis: 140 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  image: { width: "100%", aspectRatio: 1.414, borderRadius: radius.md },
  unsupported: { fontSize: 13, color: colors.muted, fontStyle: "italic" },
});
