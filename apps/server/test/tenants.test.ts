import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "../src/db.js";
import { createDocument, createProject, createTenant, resetDatabase } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await sql.end();
});

const tenantOf = async (table: string, id: string) => {
  const [row] = await sql.unsafe<{ tenantId: string }[]>(`select tenant_id as "tenantId" from ${table} where id = $1`, [id]);
  return row?.tenantId;
};

describe("firms in the database", () => {
  it("give every row the firm of its project", async () => {
    const tenantId = await createTenant("Firma A");
    const projectId = await createProject("Dom A", tenantId);
    const documentId = await createDocument(projectId);
    const [checklist] = await sql<{ id: string }[]>`
      insert into checklists (project_id, stage, title) values (${projectId}, 'strop', 'Strop') returning id`;
    const [item] = await sql<{ id: string }[]>`
      insert into checklist_items (checklist_id, position, label, ask) values (${checklist!.id}, 1, 'Beton', 'Klasa betonu') returning id`;

    expect(await tenantOf("documents", documentId)).toBe(tenantId);
    expect(await tenantOf("checklists", checklist!.id)).toBe(tenantId);
    expect(await tenantOf("checklist_items", item!.id)).toBe(tenantId);
  });

  it("reject a row that names another firm than its project", async () => {
    const firmA = await createTenant("Firma A");
    const firmB = await createTenant("Firma B");
    const projectId = await createProject("Dom A", firmA);

    await expect(
      sql`insert into documents (project_id, tenant_id, filename) values (${projectId}, ${firmB}, 'obcy.pdf')`,
    ).rejects.toThrow(/documents_project_tenant_fkey/);

    const [checklist] = await sql<{ id: string }[]>`
      insert into checklists (project_id, stage, title) values (${projectId}, 'strop', 'Strop') returning id`;
    await expect(
      sql`insert into checklist_items (checklist_id, tenant_id, position, label, ask) values (${checklist!.id}, ${firmB}, 1, 'Beton', 'Klasa')`,
    ).rejects.toThrow(/checklist_items_checklist_tenant_fkey/);
  });

  it("move all data along when a project changes firm", async () => {
    const firmA = await createTenant("Firma A");
    const firmB = await createTenant("Firma B");
    const projectId = await createProject("Dom A", firmA);
    const documentId = await createDocument(projectId);

    await sql`update projects set tenant_id = ${firmB} where id = ${projectId}`;
    expect(await tenantOf("documents", documentId)).toBe(firmB);
  });

  it("delete a firm with all its projects and data", async () => {
    const tenantId = await createTenant("Firma A");
    const projectId = await createProject("Dom A", tenantId);
    const documentId = await createDocument(projectId);

    await sql`delete from tenants where id = ${tenantId}`;
    expect(await tenantOf("documents", documentId)).toBeUndefined();
  });
});
