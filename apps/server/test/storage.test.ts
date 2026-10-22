import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { diaryAudio, documentPdf, migrateFiles, photoFile, tenantDir } from "../src/storage.js";
import { createDocument, createProject, createTenant, resetDatabase } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await sql.end();
});

const isPresent = (file: string) => stat(file).then(
  () => true,
  () => false,
);

const writeLegacy = async (relative: string, content: string) => {
  const file = path.join(config.dataDir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
};

describe("files per firm", () => {
  it("keep every file of a project inside its firm's directory", async () => {
    const firm = await createTenant("Firma A");
    const projectId = await createProject("Dom A", firm);
    const documentId = await createDocument(projectId);
    for (const file of [await documentPdf(documentId), await photoFile(projectId, "zdjecie", "full"), await diaryAudio(projectId, "wpis", "m4a")]) {
      expect(file.startsWith(path.join(tenantDir(firm), "projects", projectId) + path.sep), file).toBe(true);
    }
  });

  it("moves files from the old layout once, and a second run changes nothing", async () => {
    const firm = await createTenant("Firma A");
    const projectId = await createProject("Dom A", firm);
    const documentId = await createDocument(projectId);
    await writeLegacy(`documents/${documentId}/source.pdf`, "%PDF stary");
    await writeLegacy(`projects/${projectId}/photos/foto.jpg`, "zdjęcie");
    const audio = await writeLegacy(`diary/stary-wpis.m4a`, "nagranie");
    const [entry] = await sql<{ id: string }[]>`
      insert into diary_entries (project_id, entry_date, source, status, audio_file) values (${projectId}, current_date, 'audio', 'ready', ${audio})
      returning id`;

    await migrateFiles();
    await migrateFiles();

    expect(await readFile(await documentPdf(documentId), "utf8")).toBe("%PDF stary");
    expect(await readFile(path.join(tenantDir(firm), "projects", projectId, "photos", "foto.jpg"), "utf8")).toBe("zdjęcie");
    const [moved] = await sql<{ audioFile: string }[]>`select audio_file as "audioFile" from diary_entries where id = ${entry!.id}`;
    expect(moved!.audioFile).toBe(path.join(tenantDir(firm), "projects", projectId, "diary", "stary-wpis.m4a"));
    expect(await readFile(moved!.audioFile, "utf8")).toBe("nagranie");
    for (const old of ["documents", "projects", "diary"]) expect(await isPresent(path.join(config.dataDir, old))).toBe(false);
  });
});
