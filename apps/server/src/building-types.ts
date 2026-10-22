import { stageTemplate, STAGE_TEMPLATES } from "./checklist-templates.js";

// The kind of building a project is (#85). It sets which stage checklists come first and tells the agent what kind of
// work it is. Changing it later only reorders the stages: checklists already made stay as they are.

export const BUILDING_TYPES = [
  {
    type: "dom_murowany",
    label: "Dom jednorodzinny murowany",
    stages: ["fundamenty", "sciany", "strop", "dach", "instalacje", "tynki", "wylewki"],
    context: "Budowa domu jednorodzinnego w technologii murowanej.",
  },
  {
    type: "dom_szkieletowy",
    label: "Dom szkieletowy",
    stages: ["fundamenty", "szkielet", "dach", "stolarka", "instalacje", "wylewki"],
    context: "Budowa domu jednorodzinnego w konstrukcji szkieletowej (drewnianej).",
  },
  {
    type: "garaz",
    label: "Garaż / budynek gospodarczy",
    stages: ["fundamenty", "sciany", "dach", "wylewki"],
    context: "Budowa garażu lub budynku gospodarczego.",
  },
  {
    type: "rozbudowa",
    label: "Rozbudowa",
    stages: ["fundamenty", "sciany", "strop", "dach", "instalacje", "tynki", "wylewki"],
    context: "Rozbudowa istniejącego budynku: zwracaj uwagę na styk z częścią istniejącą (dylatacje, poziomy, izolacje).",
  },
  {
    type: "remont",
    label: "Remont",
    stages: ["instalacje", "tynki", "wylewki", "stolarka"],
    context: "Remont istniejącego budynku: część elementów jest istniejąca, a projekt opisuje zakres zmian.",
  },
  {
    type: "termomodernizacja",
    label: "Termomodernizacja",
    stages: ["ocieplenie", "stolarka", "dach"],
    context: "Termomodernizacja istniejącego budynku: ocieplenie przegród, wymiana stolarki, docieplenie dachu lub stropodachu.",
  },
] as const;

export type BuildingType = (typeof BUILDING_TYPES)[number]["type"];

export const DEFAULT_BUILDING_TYPE: BuildingType = "dom_murowany";

export const buildingType = (type: string | null | undefined) => BUILDING_TYPES.find((candidate) => candidate.type === type);

export const isBuildingType = (value: unknown): value is BuildingType => typeof value === "string" && Boolean(buildingType(value));

// The stages for this project's kind of building first, in building order, then every other stage: a remont may still
// need a foundation checklist.
export const projectTemplates = (type: string) => {
  const stages: readonly string[] = (buildingType(type) ?? buildingType(DEFAULT_BUILDING_TYPE)!).stages;
  const ordered = [
    ...stages.map((stage) => stageTemplate(stage)!),
    ...STAGE_TEMPLATES.filter((template) => !stages.includes(template.stage)),
  ];
  return ordered.map(({ stage, title, when, items }) => ({ stage, title, when, items: items.map((item) => item.label), recommended: stages.includes(stage) }));
};
