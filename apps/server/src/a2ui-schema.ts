import { BASIC_COMPONENTS } from "@a2ui/web_core/v0_9/basic_catalog";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod3";
import { A2UI_CATALOG_ID, a2uiCatalogDefinitions } from "./a2ui-catalog.js";

// The v0.9 inline catalog the runtime sends to the model, in the same shape the dashboard's
// renderer would send itself (extractCatalogComponentSchemas in @copilotkit/a2ui-renderer), so
// the server stays the source of truth and the middleware can validate surfaces against it.

type JsonObjectSchema = { properties?: Record<string, unknown>; required?: string[] };

const componentSchema = (name: string, props: ZodTypeAny, description?: string) => {
  // The cast through unknown keeps tsc from expanding zod-to-json-schema's deep generic types.
  const toJsonSchema = zodToJsonSchema as unknown as (schema: ZodTypeAny, options: object) => JsonObjectSchema;
  const json = toJsonSchema(props, { target: "jsonSchema2019-09" });
  return {
    ...(description ? { description } : {}),
    allOf: [
      { $ref: "common_types.json#/$defs/ComponentCommon" },
      {
        properties: { component: { const: name }, ...(json.properties ?? {}) },
        required: ["component", ...(json.required ?? [])],
      },
    ],
  };
};

const components: Record<string, Record<string, unknown>> = {};
for (const api of BASIC_COMPONENTS) components[api.name] = componentSchema(api.name, api.schema);
for (const [name, definition] of Object.entries(a2uiCatalogDefinitions)) {
  components[name] = componentSchema(name, definition.props, definition.description);
}

export const a2uiCatalogSchema = { catalogId: A2UI_CATALOG_ID, components };
