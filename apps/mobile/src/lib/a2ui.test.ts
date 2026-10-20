import { describe, expect, it } from "vitest";
import type { Message } from "@copilotkit/react-native/headless";
import { a2uiCatalogDefinitions } from "../../../server/src/a2ui-catalog";
import {
  CATALOG_COMPONENTS,
  applyOperations,
  childRefs,
  parseSurfaceActivity,
  resolveProps,
  toMaterials,
  toPartitions,
  toSource,
  toSteps,
} from "./a2ui";
import { toChatItems } from "./chat";

const SURFACE_ID = "budowa-1";
const source = { page: 3, documentId: "doc-a" };

// What the runtime's A2UI middleware sends once the render_a2ui arguments are complete.
const operations = [
  { version: "v0.9", createSurface: { surfaceId: SURFACE_ID, catalogId: "https://brygadzista.app/a2ui/budowa/v1" } },
  {
    version: "v0.9",
    updateComponents: {
      surfaceId: SURFACE_ID,
      components: [
        { id: "root", component: "Card", child: "col" },
        { id: "col", component: "Column", children: ["thickness", "materials", "list"] },
        { id: "thickness", component: "ParameterCard", label: "Grubość", value: { path: "/thickness" }, unit: "cm", source },
        { id: "materials", component: "MaterialList", items: { path: "/materials" } },
        { id: "list", component: "List", children: { componentId: "name", path: "/materials" } },
        { id: "name", component: "Text", text: { path: "name" } },
      ],
    },
  },
  {
    version: "v0.9",
    updateDataModel: {
      surfaceId: SURFACE_ID,
      path: "/",
      value: { thickness: "15", materials: [{ name: "EPS", quantity: 105, unit: "m²" }, { name: "Klej" }] },
    },
  },
];

describe("catalog contract", () => {
  it("renders every component the server offers the model", () => {
    expect([...CATALOG_COMPONENTS].sort()).toEqual(Object.keys(a2uiCatalogDefinitions).sort());
  });
});

describe("applyOperations", () => {
  it("builds the surface from the operations", () => {
    const [surface] = applyOperations(operations);
    expect(surface?.surfaceId).toBe(SURFACE_ID);
    expect(Object.keys(surface?.components ?? {})).toHaveLength(6);
    expect(surface?.data).toMatchObject({ thickness: "15" });
  });

  it("writes data at a nested path and honours deleteSurface", () => {
    const [surface] = applyOperations([
      ...operations,
      { updateDataModel: { surfaceId: SURFACE_ID, path: "/materials/1/name", value: "Klej do EPS" } },
    ]);
    expect((surface?.data as { materials: { name: string }[] }).materials[1]?.name).toBe("Klej do EPS");
    expect(applyOperations([...operations, { deleteSurface: { surfaceId: SURFACE_ID } }])).toEqual([]);
  });

  it("skips a surface that has no root yet", () => {
    expect(applyOperations([operations[0]])).toEqual([]);
  });
});

describe("bindings", () => {
  const [surface] = applyOperations(operations);
  const scope = { data: surface!.data, basePath: "/" };

  it("resolves bound props against the data model", () => {
    expect(resolveProps(surface!.components.thickness!, scope)).toMatchObject({ value: "15", unit: "cm" });
    expect(toMaterials(resolveProps(surface!.components.materials!, scope).items)).toEqual([
      { name: "EPS", quantity: "105", unit: "m²", note: undefined, source: undefined },
      { name: "Klej", quantity: undefined, unit: undefined, note: undefined, source: undefined },
    ]);
  });

  it("repeats a template child once per item, with relative paths", () => {
    const refs = childRefs(surface!.components.list!, scope);
    expect(refs.map((ref) => ref.scope.basePath)).toEqual(["/materials/0", "/materials/1"]);
    expect(resolveProps(surface!.components.name!, refs[1]!.scope).text).toBe("Klej");
  });
});

describe("catalog items", () => {
  it("drops entries the model got wrong instead of failing the whole list", () => {
    expect(toSteps([{ title: "Przyklej płyty", source: { page: 0 } }, { detail: "bez tytułu" }, "tekst"])).toEqual([
      { title: "Przyklej płyty", detail: undefined, source: undefined },
    ]);
    expect(
      toPartitions([
        { name: "SZ1", layers: [] },
        { name: "SZ2", layers: [{ material: "EPS", thickness: "15 cm" }] },
      ]),
    ).toHaveLength(1);
    expect(toSource({ page: 12 })).toEqual({ page: 12, documentId: undefined });
  });
});

describe("chat items", () => {
  const messages = [
    { id: "u1", role: "user", content: "Zestawienie materiałów" },
    {
      id: "a1",
      role: "assistant",
      content: "Zestawienie poniżej.",
      toolCalls: [{ id: "c1", type: "function", function: { name: "render_a2ui", arguments: "{}" } }],
    },
    { id: "a2ui-surface-c1", role: "activity", activityType: "a2ui-surface", content: { a2ui_operations: operations } },
    { id: "t1", role: "tool", toolCallId: "c1", content: '{"status":"rendered"}' },
  ] as Message[];

  it("shows the surface in place of the render_a2ui call", () => {
    const items = toChatItems(messages, false);
    expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "surface"]);
  });

  it("reads build progress and failures", () => {
    expect(parseSurfaceActivity({ status: "building", progressTokens: 30 })).toEqual({ kind: "building" });
    expect(parseSurfaceActivity({ status: "failed", error: "Zły komponent" })).toEqual({ kind: "failed", error: "Zły komponent" });
    expect(parseSurfaceActivity({ something: "else" })).toBeNull();
  });
});
