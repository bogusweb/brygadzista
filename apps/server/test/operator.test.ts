import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { documentDir, documentPdf } from "../src/storage.js";
import { ADMIN, PASSWORD, createDocument, createOperator, createProject, createTenant, createUser, login, resetDatabase } from "./helpers.js";

const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify(body),
});

let firmA: string;
let firmB: string;
let documentB: string;

beforeEach(async () => {
  await resetDatabase();
  firmA = await createTenant("Firma A");
  firmB = await createTenant("Firma B");
  await createProject("Dom A", firmA);
  const projectB = await createProject("Dom B", firmB);
  documentB = await createDocument(projectB, "ready");
  await mkdir(await documentDir(documentB), { recursive: true });
  await writeFile(await documentPdf(documentB), "%PDF-1.4 firma B");
  await createUser("szef@a.pl", "owner", PASSWORD, firmA);
  await createUser("szef@b.pl", "owner", PASSWORD, firmB);
});

afterAll(async () => {
  await sql.end();
});

const untar = async (response: Response) => {
  const dir = await mkdtemp(path.join(tmpdir(), "export-test-"));
  const archive = path.join(dir, "export.tar.gz");
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  execFileSync("tar", ["-xzf", archive, "-C", dir]);
  return dir;
};

describe("operator panel", () => {
  it("lists firms with their counts, only for the operator", async () => {
    const response = await app.request("/api/operator/tenants", { headers: ADMIN });
    const firms = (await response.json()) as { name: string; projectCount: number; memberCount: number; documents: number }[];
    expect(firms.find((firm) => firm.name === "Firma B")).toMatchObject({ projectCount: 1, memberCount: 1, documents: 1 });

    expect((await app.request("/api/operator/tenants", { headers: await login("szef@a.pl") })).status).toBe(403);
  });

  it("creates a firm with its owner and blocks it", async () => {
    const created = await app.request(
      "/api/operator/tenants",
      json("POST", { name: "Nowa", ownerEmail: "nowy@firma.pl", ownerPassword: PASSWORD }, ADMIN),
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await app.request("/api/auth/login", json("POST", { email: "nowy@firma.pl", password: PASSWORD }))).status).toBe(200);

    await app.request(`/api/operator/tenants/${id}`, json("PATCH", { disabled: true }, ADMIN));
    expect((await app.request("/api/auth/login", json("POST", { email: "nowy@firma.pl", password: PASSWORD }))).status).toBe(403);
    const log = (await (await app.request("/api/operator/audit", { headers: ADMIN })).json()) as { action: string }[];
    expect(log.map((entry) => entry.action)).toEqual(["block", "create"]);
  });

  it("lets an operator account enter a firm as its owner, and logs it", async () => {
    await createOperator("operator@brygadzista.app");
    const operator = await login("operator@brygadzista.app");

    expect((await app.request(`/api/operator/tenants/${firmB}/enter`, { method: "POST", headers: operator })).status).toBe(200);
    expect(await (await app.request("/api/auth/me", { headers: operator })).json()).toMatchObject({ tenant: { id: firmB, role: "owner" } });
    const people = (await (await app.request("/api/users", { headers: operator })).json()) as { email: string }[];
    expect(people.map((person) => person.email)).toEqual(["szef@b.pl"]);
    expect(await sql`select 1 from operator_audit where action = 'enter' and tenant_id = ${firmB}`).toHaveLength(1);
  });
});

describe("export and deletion of a firm", () => {
  it("exports every row and file of one firm and nothing of another", async () => {
    const response = await app.request(`/api/operator/tenants/${firmB}/export`, { headers: ADMIN });
    expect(response.status).toBe(200);
    const dir = await untar(response);

    const data = JSON.parse(await readFile(path.join(dir, "data.json"), "utf8")) as Record<string, { name?: string; email?: string }[]>;
    expect(data.projects!.map((project) => project.name)).toEqual(["Dom B"]);
    expect(data.users!.map((user) => user.email)).toEqual(["szef@b.pl"]);
    expect(JSON.stringify(data)).not.toContain("Dom A");
    expect(JSON.stringify(data)).not.toContain("password");
    // Files keep their place under DATA_DIR: tenants/<firm>/projects/<project>/documents/<document>/.
    const pdf = path.relative(config.dataDir, await documentPdf(documentB));
    expect(pdf.startsWith(path.join("tenants", firmB))).toBe(true);
    expect(await readFile(path.join(dir, pdf), "utf8")).toBe("%PDF-1.4 firma B");
  });

  it("lets a firm's owner export only their own firm", async () => {
    const owner = await login("szef@a.pl");
    const dir = await untar(await app.request("/api/tenant/export", { headers: owner }));
    const data = JSON.parse(await readFile(path.join(dir, "data.json"), "utf8")) as Record<string, { name?: string }[]>;
    expect(data.projects!.map((project) => project.name)).toEqual(["Dom A"]);
  });

  it("deletes a firm with its data, files and accounts after confirming its name", async () => {
    expect((await app.request(`/api/operator/tenants/${firmB}`, json("DELETE", { confirm: "firma b" }, ADMIN))).status).toBe(400);
    expect((await app.request(`/api/operator/tenants/${firmB}`, json("DELETE", { confirm: "Firma B" }, ADMIN))).status).toBe(204);

    expect(await sql`select 1 from projects where tenant_id = ${firmB}`).toHaveLength(0);
    expect(await sql`select 1 from users where email = 'szef@b.pl'`).toHaveLength(0);
    expect(await stat(await documentDir(documentB)).catch(() => null)).toBeNull();
    expect(await sql`select 1 from projects where tenant_id = ${firmA}`).toHaveLength(1);
    expect(await sql`select tenant_name from operator_audit where action = 'delete'`).toEqual([{ tenant_name: "Firma B" }]);
  });
});
