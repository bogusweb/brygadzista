// The native side of A2UI v0.9: the agent's render_a2ui call reaches the app as an "a2ui-surface" activity message
// (the runtime's A2UI middleware builds it), carrying either a build status or the surface operations. CopilotKit's
// renderer is web only, so the app replays the operations itself and draws a subset of the catalog
// (components/a2ui). The catalog contract lives on the server, apps/server/src/a2ui-catalog.ts.

export const A2UI_ACTIVITY_TYPE = "a2ui-surface";
export const A2UI_TOOL_NAMES = new Set(["render_a2ui", "log_a2ui_event"]);

// The construction components of the server catalog; a test keeps this list in step with it.
export const CATALOG_COMPONENTS = ["ParameterCard", "MaterialList", "WorkSteps", "LayerComparison"] as const;
export type CatalogComponent = (typeof CATALOG_COMPONENTS)[number];

export type A2UIComponent = { id: string; component: string } & Record<string, unknown>;

export type Surface = {
  surfaceId: string;
  catalogId?: string;
  components: Record<string, A2UIComponent>;
  data: unknown;
};

export type SurfaceActivity =
  | { kind: "building" }
  | { kind: "retrying"; attempt: number; maxAttempts: number }
  | { kind: "failed"; error: string }
  | { kind: "ready"; surfaces: Surface[] };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const isComponent = (value: unknown): value is A2UIComponent =>
  isRecord(value) && typeof value.id === "string" && typeof value.component === "string";

const pointerSegments = (path: string) =>
  path
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));

// Writes a value at a JSON pointer, creating objects on the way; "/" (or no path) replaces the whole model.
const setAtPointer = (root: unknown, path: string | undefined, value: unknown): unknown => {
  const segments = pointerSegments(path ?? "/");
  if (segments.length === 0) return value;
  const [head, ...rest] = segments;
  const base = isRecord(root) || Array.isArray(root) ? root : {};
  const copy: Record<string, unknown> | unknown[] = Array.isArray(base) ? [...base] : { ...base };
  const child = (copy as Record<string, unknown>)[head!];
  (copy as Record<string, unknown>)[head!] = rest.length ? setAtPointer(child, `/${rest.join("/")}`, value) : value;
  return copy;
};

export const getAtPointer = (root: unknown, path: string): unknown =>
  pointerSegments(path).reduce<unknown>((node, segment) => {
    if (Array.isArray(node)) return node[Number(segment)];
    return isRecord(node) ? node[segment] : undefined;
  }, root);

// Replays createSurface / updateComponents / updateDataModel / deleteSurface, in order, into surfaces.
// Every snapshot from the middleware carries the full list, so the app always replays from scratch.
export const applyOperations = (operations: readonly unknown[]): Surface[] => {
  const surfaces = new Map<string, Surface>();
  const surfaceFor = (surfaceId: string) => {
    let surface = surfaces.get(surfaceId);
    if (!surface) {
      surface = { surfaceId, components: {}, data: {} };
      surfaces.set(surfaceId, surface);
    }
    return surface;
  };

  for (const operation of operations) {
    if (!isRecord(operation)) continue;
    const { createSurface, updateComponents, updateDataModel, deleteSurface } = operation;
    if (isRecord(createSurface) && typeof createSurface.surfaceId === "string") {
      const surface = surfaceFor(createSurface.surfaceId);
      if (typeof createSurface.catalogId === "string") surface.catalogId = createSurface.catalogId;
    } else if (isRecord(updateComponents) && typeof updateComponents.surfaceId === "string") {
      const surface = surfaceFor(updateComponents.surfaceId);
      const components = Array.isArray(updateComponents.components) ? updateComponents.components : [];
      for (const component of components) if (isComponent(component)) surface.components[component.id] = component;
    } else if (isRecord(updateDataModel) && typeof updateDataModel.surfaceId === "string") {
      const surface = surfaceFor(updateDataModel.surfaceId);
      const path = typeof updateDataModel.path === "string" ? updateDataModel.path : undefined;
      surface.data = setAtPointer(surface.data, path, updateDataModel.value);
    } else if (isRecord(deleteSurface) && typeof deleteSurface.surfaceId === "string") {
      surfaces.delete(deleteSurface.surfaceId);
    }
  }
  // A surface is drawn from its "root" component; without one there is nothing to show yet.
  return [...surfaces.values()].filter((surface) => surface.components.root);
};

export const parseSurfaceActivity = (content: unknown): SurfaceActivity | null => {
  if (!isRecord(content)) return null;
  if (Array.isArray(content.a2ui_operations)) return { kind: "ready", surfaces: applyOperations(content.a2ui_operations) };
  switch (content.status) {
    case "building":
      return { kind: "building" };
    case "retrying":
      return {
        kind: "retrying",
        attempt: typeof content.attempt === "number" ? content.attempt : 2,
        maxAttempts: typeof content.maxAttempts === "number" ? content.maxAttempts : 3,
      };
    case "failed":
      return { kind: "failed", error: typeof content.error === "string" ? content.error : "" };
    default:
      return null;
  }
};

// Data-bound values are { path }. A path without a leading slash is relative to the template item being drawn.
export type Scope = { data: unknown; basePath: string };

const resolvePath = (path: string, basePath: string) => (path.startsWith("/") ? path : `${basePath.replace(/\/$/, "")}/${path}`);

const isBinding = (value: unknown): value is { path: string } => isRecord(value) && typeof value.path === "string" && !("call" in value);

export const resolveValue = (value: unknown, scope: Scope): unknown => {
  if (isBinding(value)) return getAtPointer(scope.data, resolvePath(value.path, scope.basePath));
  // Function calls (formatString and the like) belong to the full renderer; the app skips them.
  if (isRecord(value) && "call" in value) return undefined;
  return value;
};

// Props of a component with every top-level binding resolved, as CopilotKit's binder does for the web.
export const resolveProps = (component: A2UIComponent, scope: Scope): Record<string, unknown> =>
  Object.fromEntries(Object.entries(component).map(([key, value]) => [key, resolveValue(value, scope)]));

export type ChildRef = { id: string; scope: Scope };

// `children` is either a list of ids or a template ({ componentId, path }) repeated for every item of a bound array.
export const childRefs = (component: A2UIComponent, scope: Scope): ChildRef[] => {
  const { child, children } = component;
  if (typeof child === "string") return [{ id: child, scope }];
  if (Array.isArray(children)) return children.filter((id): id is string => typeof id === "string").map((id) => ({ id, scope }));
  if (isRecord(children) && typeof children.componentId === "string" && typeof children.path === "string") {
    const listPath = resolvePath(children.path, scope.basePath);
    const items = getAtPointer(scope.data, listPath);
    if (!Array.isArray(items)) return [];
    return items.map((_, index) => ({ id: children.componentId as string, scope: { data: scope.data, basePath: `${listPath}/${index}` } }));
  }
  return [];
};

// Values the model sends for display, with the wrong type dropped rather than crashing a row.
export const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");

export type A2UISource = { page: number; documentId?: string };
export type Material = { name: string; quantity?: string; unit?: string; note?: string; source?: A2UISource };
export type WorkStep = { title: string; detail?: string; source?: A2UISource };
export type Layer = { material: string; thickness?: string; note?: string };
export type Partition = { name: string; layers: Layer[]; total?: string; uValue?: string; source?: A2UISource };

const optionalText = (value: unknown) => text(value) || undefined;

export const toSource = (value: unknown): A2UISource | undefined => {
  if (!isRecord(value) || typeof value.page !== "number" || !Number.isInteger(value.page) || value.page < 1) return undefined;
  return { page: value.page, documentId: typeof value.documentId === "string" ? value.documentId : undefined };
};

const listOf = <T>(value: unknown, toItem: (entry: Record<string, unknown>) => T | null): T[] =>
  Array.isArray(value) ? value.flatMap((entry) => (isRecord(entry) ? (toItem(entry) ?? []) : [])) : [];

export const toMaterials = (value: unknown): Material[] =>
  listOf(value, (entry) =>
    text(entry.name)
      ? {
          name: text(entry.name),
          quantity: optionalText(entry.quantity),
          unit: optionalText(entry.unit),
          note: optionalText(entry.note),
          source: toSource(entry.source),
        }
      : null,
  );

export const toSteps = (value: unknown): WorkStep[] =>
  listOf(value, (entry) =>
    text(entry.title) ? { title: text(entry.title), detail: optionalText(entry.detail), source: toSource(entry.source) } : null,
  );

export const toPartitions = (value: unknown): Partition[] =>
  listOf(value, (entry) => {
    const layers = listOf(entry.layers, (layer) =>
      text(layer.material) ? { material: text(layer.material), thickness: optionalText(layer.thickness), note: optionalText(layer.note) } : null,
    );
    if (!text(entry.name) || layers.length === 0) return null;
    return { name: text(entry.name), layers, total: optionalText(entry.total), uValue: optionalText(entry.uValue), source: toSource(entry.source) };
  });
