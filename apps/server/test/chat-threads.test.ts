import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { sql } from "../src/db.js";
import { PASSWORD, addMember, createProject, createTenant, createUser, login, resetDatabase } from "./helpers.js";

let firmA: string;
let projectA: string;
let projectB: string;

beforeEach(async () => {
  await resetDatabase();
  firmA = await createTenant("Firma A");
  const firmB = await createTenant("Firma B");
  projectA = await createProject("Dom A", firmA);
  projectB = await createProject("Dom B", firmB);
  await createUser("szef@a.pl", "owner", PASSWORD, firmA);
  await addMember(projectA, await createUser("ola@a.pl", "worker", PASSWORD, firmA));
  await createUser("szef@b.pl", "owner", PASSWORD, firmB);
});

afterAll(async () => {
  await sql.end();
});

const run = (headers: Record<string, string>, projectId: string, threadId: string, action = "run") =>
  app.request(`/api/copilotkit/agent/default/${action}`, {
    method: "POST",
    headers: { ...headers, "x-project-id": projectId, "content-type": "application/json" },
    body: JSON.stringify({ threadId, runId: "r1", messages: [], tools: [], context: [], state: {}, forwardedProps: {} }),
  });

describe("chat threads", () => {
  it("belong to the first caller, their project and firm", async () => {
    const owner = await login("szef@a.pl");
    await run(owner, projectA, "watek-1");

    expect(await sql`select project_id, tenant_id, owner from chat_threads where id = 'watek-1'`).toEqual([
      expect.objectContaining({ project_id: projectA, tenant_id: firmA }),
    ]);
    expect((await run(owner, projectA, "watek-1")).status).not.toBe(404);
  });

  it("cannot be run, joined or stopped by someone else", async () => {
    await run(await login("szef@a.pl"), projectA, "watek-1");
    const colleague = await login("ola@a.pl");
    const otherFirm = await login("szef@b.pl");

    expect((await run(colleague, projectA, "watek-1")).status).toBe(404);
    expect((await run(colleague, projectA, "watek-1", "connect")).status).toBe(404);
    expect((await run(otherFirm, projectB, "watek-1")).status).toBe(404);
    const stop = await app.request("/api/copilotkit/agent/default/stop/watek-1", {
      method: "POST",
      headers: { ...colleague, "x-project-id": projectA },
    });
    expect(stop.status).toBe(404);
  });

  it("cannot move to another project", async () => {
    const owner = await login("szef@a.pl");
    const second = await createProject("Dom A2", firmA);
    await run(owner, projectA, "watek-1");

    expect((await run(owner, second, "watek-1")).status).toBe(404);
  });

  it("are not listed or cleared across users", async () => {
    const owner = await login("szef@a.pl");
    for (const path of ["/api/copilotkit/threads", "/api/copilotkit/threads/clear", "/api/copilotkit/threads/watek-1/messages"]) {
      const response = await app.request(path, { method: "POST", headers: { ...owner, "x-project-id": projectA } });
      expect(response.status, path).toBe(404);
    }
  });
});
