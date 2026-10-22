import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { agentProject } from "../src/auth.js";
import { sql } from "../src/db.js";
import { documentDir, pageImage, photoFile } from "../src/storage.js";
import { APP, PASSWORD, addMember, createDocument, createProject, createTenant, createUser, insertPage, login, resetDatabase } from "./helpers.js";

// Two firms with the same kinds of data. Everyone in firm A, whatever their role, must get 404 for anything of firm B,
// on every route the server has, including routes added later (they are read from the app itself).

type FirmData = {
  tenantId: string;
  projectId: string;
  documentId: string;
  pinId: string;
  photoId: string;
  diaryId: string;
  checklistId: string;
  questionId: string;
  userId: string;
};

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

const seedFirm = async (name: string): Promise<FirmData> => {
  const tenantId = await createTenant(name);
  const slug = name.toLowerCase().replace(/\W+/g, "-");
  const userId = await createUser(`szef@${slug}.pl`, "owner", PASSWORD, tenantId);
  const projectId = await createProject(`Budowa ${name}`, tenantId);
  const documentId = await createDocument(projectId, "ready");
  await insertPage(projectId, documentId, 1, { title: "Rzut parteru", searchText: `Rzut parteru ${name} strop 24 cm`, indexed: true });
  await mkdir(documentDir(documentId), { recursive: true });
  await writeFile(pageImage(documentId, 1), JPEG);

  const pinId = randomUUID();
  const photoId = randomUUID();
  await sql`
    insert into pins (id, project_id, document_id, page_no, x, y, kind, note, status, created_at, updated_at)
    values (${pinId}, ${projectId}, ${documentId}, 1, 0.5, 0.5, 'defect', 'Rysa na ścianie', 'open', now(), now())`;
  await sql`
    insert into pin_photos (id, pin_id, project_id, width, height, bytes, taken_at)
    values (${photoId}, ${pinId}, ${projectId}, 1, 1, ${JPEG.length}, now())`;
  await mkdir(path.dirname(photoFile(projectId, photoId, "full")), { recursive: true });
  await writeFile(photoFile(projectId, photoId, "full"), JPEG);
  await writeFile(photoFile(projectId, photoId, "thumb"), JPEG);

  const [diary] = await sql<{ id: string }[]>`
    insert into diary_entries (project_id, entry_date, source, transcript, status) values (${projectId}, current_date, 'text', 'Beton', 'ready')
    returning id`;
  const [checklist] = await sql<{ id: string }[]>`
    insert into checklists (project_id, stage, title, status) values (${projectId}, 'strop', 'Strop', 'ready') returning id`;
  await sql`insert into checklist_items (checklist_id, position, label, ask) values (${checklist!.id}, 1, 'Beton', 'Klasa betonu')`;
  const [question] = await sql<{ id: string }[]>`
    insert into designer_questions (project_id, document_id, page_no, question) values (${projectId}, ${documentId}, 1, 'Jaki strop?')
    returning id`;
  return { tenantId, projectId, documentId, pinId, photoId, diaryId: diary!.id, checklistId: checklist!.id, questionId: question!.id, userId };
};

// Fills a route's parameters with firm B's ids; null when the route does not point at data of a firm.
const pathFor = (routePath: string, b: FirmData) => {
  if (!/:/.test(routePath) || routePath.includes(":token")) return null;
  const idFor = routePath.startsWith("/api/projects/")
    ? b.projectId
    : routePath.startsWith("/api/documents/")
      ? b.documentId
      : routePath.startsWith("/api/diary/")
        ? b.diaryId
        : routePath.startsWith("/api/checklists/")
          ? b.checklistId
          : routePath.startsWith("/api/users/")
            ? b.userId
            : null;
  if (!idFor) return null;
  return routePath
    .replace(":id", idFor)
    .replace(":pinId", b.pinId)
    .replace(":photoId", b.photoId)
    .replace(":userId", b.userId)
    .replace(":questionId", b.questionId)
    .replace(":pageNo", "1");
};

const dataRoutes = (b: FirmData) => {
  const seen = new Set<string>();
  return app.routes.flatMap(({ method, path: routePath }) => {
    const target = pathFor(routePath, b);
    const key = `${method} ${routePath}`;
    if (method === "ALL" || !target || seen.has(key)) return [];
    seen.add(key);
    return [{ method, routePath, target }];
  });
};

const countsOf = async (b: FirmData) => {
  const [row] = await sql`
    select (select count(*)::int from projects where tenant_id = ${b.tenantId}) as projects,
      (select count(*)::int from documents where tenant_id = ${b.tenantId}) as documents,
      (select count(*)::int from pages where tenant_id = ${b.tenantId}) as pages,
      (select count(*)::int from pins where tenant_id = ${b.tenantId}) as pins,
      (select count(*)::int from pin_photos where tenant_id = ${b.tenantId}) as photos,
      (select count(*)::int from diary_entries where tenant_id = ${b.tenantId}) as diary,
      (select count(*)::int from checklists where tenant_id = ${b.tenantId}) as checklists,
      (select count(*)::int from designer_questions where tenant_id = ${b.tenantId}) as questions,
      (select count(*)::int from checklist_items where tenant_id = ${b.tenantId}) as items,
      (select count(*)::int from tenant_members where tenant_id = ${b.tenantId}) as people,
      (select disabled_at is null from users where id = ${b.userId}) as "userActive"`;
  return row;
};

let a: FirmData;
let b: FirmData;
let callers: Record<string, Record<string, string>>;

beforeAll(async () => {
  await resetDatabase();
  a = await seedFirm("Firma A");
  b = await seedFirm("Firma B");
  await createUser("kierownik@firma-a.pl", "manager", PASSWORD, a.tenantId);
  const workerId = await createUser("brygada@firma-a.pl", "worker", PASSWORD, a.tenantId);
  await addMember(a.projectId, workerId);
  callers = {
    owner: await login("szef@firma-a.pl"),
    manager: await login("kierownik@firma-a.pl"),
    worker: await login("brygada@firma-a.pl"),
    // The legacy app token works in the oldest firm, which is firm A.
    appToken: APP,
  };
});

afterAll(async () => {
  await sql.end();
});

describe("isolation of two firms", () => {
  it("covers every route with firm data", () => {
    const routes = dataRoutes(b).map((route) => `${route.method} ${route.routePath}`);
    expect(routes.length).toBeGreaterThan(25);
    for (const expected of ["GET /api/documents/:id/pages/:pageNo/image", "GET /api/projects/:id/photos/:photoId/image", "DELETE /api/projects/:id"]) {
      expect(routes).toContain(expected);
    }
  });

  it("answers 404 to firm A on every route that points at firm B, and changes nothing", async () => {
    const before = await countsOf(b);
    const leaks: string[] = [];
    for (const [who, headers] of Object.entries(callers)) {
      for (const route of dataRoutes(b)) {
        const init: RequestInit = { method: route.method, headers: { ...headers, "content-type": "application/json" } };
        if (route.method !== "GET") init.body = "{}";
        const response = await app.request(route.target, init);
        // 401/403 means the caller's role may not use the route at all, which hides firm B's data just as well.
        if (![401, 403, 404].includes(response.status)) leaks.push(`${who}: ${route.method} ${route.routePath} -> ${response.status}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(await countsOf(b)).toEqual(before);
  });

  it("does not leak through ?token= on images and PDFs", async () => {
    const token = callers.owner!.authorization.slice("Bearer ".length);
    for (const target of [
      `/api/documents/${b.documentId}/pages/1/image?token=${token}`,
      `/api/projects/${b.projectId}/photos/${b.photoId}/image?token=${token}`,
      `/api/projects/${b.projectId}/defects/protocol.pdf?token=${token}`,
    ]) {
      expect((await app.request(target)).status, target).toBe(404);
    }
  });

  it("shows firm A its own data on the same routes", async () => {
    for (const target of [
      `/api/projects/${a.projectId}/documents`,
      `/api/documents/${a.documentId}/pages/1/image`,
      `/api/projects/${a.projectId}/photos/${a.photoId}/image`,
      `/api/projects/${a.projectId}/diary`,
      `/api/checklists/${a.checklistId}`,
    ]) {
      expect((await app.request(target, { headers: callers.owner })).status, target).toBe(200);
    }
  });

  it("lists only firm A's projects and people", async () => {
    for (const headers of Object.values(callers)) {
      const projects = (await (await app.request("/api/projects", { headers })).json()) as { id: string }[];
      expect(projects.map((project) => project.id)).toEqual([a.projectId]);
    }
    const people = (await (await app.request("/api/users", { headers: callers.owner })).json()) as { id: string }[];
    expect(people.map((person) => person.id)).not.toContain(b.userId);
  });

  it("does not build the agent for firm B's project, in any role", async () => {
    for (const headers of Object.values(callers)) {
      const request = new Request("http://localhost/api/copilotkit/agent/default/run", { headers: { ...headers, "x-project-id": b.projectId } });
      await expect(agentProject(request, ["app", "admin"])).rejects.toThrow("Nieznany projekt");
    }
    const response = await app.request("/api/copilotkit/agent/default/run", {
      method: "POST",
      headers: { ...callers.owner, "x-project-id": b.projectId, "content-type": "application/json" },
      body: JSON.stringify({ threadId: "t1", runId: "r1", messages: [], tools: [], context: [], state: {}, forwardedProps: {} }),
    });
    expect(response.ok).toBe(false);
  });

  it("builds the agent for firm A's project with firm A attached", async () => {
    const request = new Request("http://localhost/api/copilotkit/agent/default/run", { headers: { ...callers.owner, "x-project-id": a.projectId } });
    await expect(agentProject(request, ["app", "admin"])).resolves.toEqual({ projectId: a.projectId, tenantId: a.tenantId });
  });
});
