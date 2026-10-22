import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { BUILDING_TYPES } from "../src/building-types.js";
import { STAGE_TEMPLATES } from "../src/checklist-templates.js";
import { sql } from "../src/db.js";
import { ADMIN, APP, addMember, createProject, createUser, login, resetDatabase } from "./helpers.js";

const json = (body: unknown) => JSON.stringify(body);
const post = (path: string, body: unknown, headers: Record<string, string> = ADMIN) =>
  app.request(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: json(body) });
const patch = (path: string, body: unknown, headers: Record<string, string> = ADMIN) =>
  app.request(path, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: json(body) });

type Templates = { buildingType: string; templates: { stage: string; recommended: boolean }[] };
const templatesOf = async (projectId: string, headers: Record<string, string> = APP) =>
  (await (await app.request(`/api/projects/${projectId}/checklist-templates`, { headers })).json()) as Templates;

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await sql.end();
});

describe("building types (#85)", () => {
  it("only name stages that have a checklist template", () => {
    const stages = new Set(STAGE_TEMPLATES.map((template) => template.stage));
    for (const type of BUILDING_TYPES) for (const stage of type.stages) expect(stages.has(stage), `${type.type}: ${stage}`).toBe(true);
  });

  it("is chosen when the project is created and listed with it", async () => {
    const created = await post("/api/projects", { name: "Ocieplenie szkoły", buildingType: "termomodernizacja" });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ buildingType: "termomodernizacja" });
    const list = (await (await app.request("/api/projects", { headers: ADMIN })).json()) as { name: string; buildingType: string }[];
    expect(list.find((project) => project.name === "Ocieplenie szkoły")?.buildingType).toBe("termomodernizacja");
  });

  it("defaults to a brick house and refuses unknown types", async () => {
    expect(await (await post("/api/projects", { name: "Dom" })).json()).toMatchObject({ buildingType: "dom_murowany" });
    expect((await post("/api/projects", { name: "X", buildingType: "zamek" })).status).toBe(400);
  });

  it("puts the type's stages first and keeps the others available", async () => {
    const projectId = await createProject();
    await patch(`/api/projects/${projectId}`, { buildingType: "termomodernizacja" });
    const { buildingType, templates } = await templatesOf(projectId);
    expect(buildingType).toBe("termomodernizacja");
    expect(templates.slice(0, 3).map((template) => [template.stage, template.recommended])).toEqual([
      ["ocieplenie", true],
      ["stolarka", true],
      ["dach", true],
    ]);
    expect(templates).toHaveLength(STAGE_TEMPLATES.length);
    expect(templates.filter((template) => !template.recommended).map((template) => template.stage)).toContain("fundamenty");
  });

  it("changes later without touching checklists already made", async () => {
    const projectId = await createProject();
    await sql`insert into checklists (project_id, stage, title, status) values (${projectId}, 'fundamenty', 'Fundamenty', 'ready')`;
    const response = await patch(`/api/projects/${projectId}`, { buildingType: "garaz" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ buildingType: "garaz", name: "Hala sportowa" });
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from checklists where project_id = ${projectId}`;
    expect(count).toBe(1);
    expect((await patch(`/api/projects/${projectId}`, { buildingType: "zamek" })).status).toBe(400);
  });

  it("is changed by those who run projects, not by workers", async () => {
    const projectId = await createProject();
    const workerId = await createUser("ola@firma.pl", "worker");
    await addMember(projectId, workerId);
    const worker = await login("ola@firma.pl");
    expect((await patch(`/api/projects/${projectId}`, { buildingType: "garaz" }, worker)).status).toBe(401);
    expect((await templatesOf(projectId, worker)).buildingType).toBe("dom_murowany");
    await createUser("szef@firma.pl", "manager");
    expect((await patch(`/api/projects/${projectId}`, { buildingType: "garaz" }, await login("szef@firma.pl"))).status).toBe(200);
  });

  it("is listed for the clients", async () => {
    const types = (await (await app.request("/api/building-types", { headers: APP })).json()) as { type: string; label: string }[];
    expect(types.map((type) => type.type)).toEqual(BUILDING_TYPES.map((type) => type.type));
  });
});
