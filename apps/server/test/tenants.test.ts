import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql, withTenant } from "../src/db.js";
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

describe("row level security", () => {
  it("hides another firm's rows inside a firm's transaction, even from a query without a filter", async () => {
    const firmA = await createTenant("Firma A");
    const firmB = await createTenant("Firma B");
    const projectA = await createProject("Dom A", firmA);
    const projectB = await createProject("Dom B", firmB);
    await createDocument(projectA);
    await createDocument(projectB);

    const seen = await withTenant(firmA, async () => ({
      projects: (await sql<{ id: string }[]>`select id from projects`).map((row) => row.id),
      documents: (await sql`select 1 from documents`).length,
    }));
    expect(seen).toEqual({ projects: [projectA], documents: 1 });
    // Outside a firm's transaction the server's own role sees everything.
    expect(await sql`select 1 from documents`).toHaveLength(2);
  });

  it("refuses to write a row for another firm inside a firm's transaction", async () => {
    const firmA = await createTenant("Firma A");
    const firmB = await createTenant("Firma B");
    const projectB = await createProject("Dom B", firmB);

    await expect(
      withTenant(firmA, async () => sql`insert into documents (project_id, tenant_id, filename) values (${projectB}, ${firmB}, 'x.pdf')`),
    ).rejects.toThrow(/row-level security/);
    await expect(withTenant(firmA, async () => sql`update projects set name = 'przejęty' where id = ${projectB} returning id`)).resolves.toHaveLength(0);
  });

  it("covers every table with a firm", async () => {
    const tables = await sql<{ table: string; rls: boolean }[]>`
      select c.relname as table, c.relrowsecurity as rls from pg_class c
      join information_schema.columns col on col.table_name = c.relname and col.column_name = 'tenant_id' and col.table_schema = 'public'
      where c.relkind = 'r' and c.relname not in ('sessions', 'tenant_members')`;
    expect(tables.length).toBeGreaterThan(10);
    expect(tables.filter((table) => !table.rls)).toEqual([]);
  });
});
