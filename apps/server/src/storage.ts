import { mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { sql } from "./db.js";

// Files are kept per firm and project (#126): DATA_DIR/tenants/<firm>/projects/<project>/ holds documents/<document>
// (the PDF, page images, tiles, crops), photos/ and diary/. Exporting or deleting a firm is one directory, deleting a
// project another. Paths are looked up from the ids; a project never changes firm, so the lookups are cached.
const projectTenants = new Map<string, string>();
const documentProjects = new Map<string, string>();

export const tenantDir = (tenantId: string) => path.join(config.dataDir, "tenants", tenantId);
const projectPath = (tenantId: string, projectId: string) => path.join(tenantDir(tenantId), "projects", projectId);
const documentPath = (projectRoot: string, documentId: string) => path.join(projectRoot, "documents", documentId);

export const projectDir = async (projectId: string) => {
  let tenantId = projectTenants.get(projectId);
  if (!tenantId) {
    const [project] = await sql<{ tenantId: string }[]>`select tenant_id as "tenantId" from projects where id = ${projectId}`;
    if (!project) throw new Error(`Nieznany projekt ${projectId}`);
    tenantId = project.tenantId;
    projectTenants.set(projectId, tenantId);
  }
  return projectPath(tenantId, projectId);
};

export const documentDir = async (documentId: string) => {
  let projectId = documentProjects.get(documentId);
  if (!projectId) {
    const [doc] = await sql<{ projectId: string }[]>`select project_id as "projectId" from documents where id = ${documentId}`;
    if (!doc) throw new Error(`Nieznany dokument ${documentId}`);
    projectId = doc.projectId;
    documentProjects.set(documentId, projectId);
  }
  return documentPath(await projectDir(projectId), documentId);
};

export const documentPdf = async (documentId: string) => path.join(await documentDir(documentId), "source.pdf");
export const pageImagePrefix = async (documentId: string, pageNo: number) =>
  path.join(await documentDir(documentId), `page-${String(pageNo).padStart(4, "0")}`);
export const pageImage = async (documentId: string, pageNo: number) => `${await pageImagePrefix(documentId, pageNo)}.jpg`;
export const pageTilesDir = async (documentId: string, pageNo: number) => `${await pageImagePrefix(documentId, pageNo)}-tiles`;
export const photoFile = async (projectId: string, photoId: string, size: "full" | "thumb") =>
  path.join(await projectDir(projectId), "photos", size === "thumb" ? `${photoId}-thumb.jpg` : `${photoId}.jpg`);
export const diaryAudio = async (projectId: string, entryId: string, extension: string) =>
  path.join(await projectDir(projectId), "diary", `${entryId}.${extension}`);

// Moves a file or directory; into an existing directory it merges entry by entry.
const moveInto = async (from: string, to: string): Promise<void> => {
  await mkdir(path.dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    for (const entry of await readdir(from)) await moveInto(path.join(from, entry), path.join(to, entry));
    await rm(from, { recursive: true, force: true });
  }
};

const isPresent = (file: string) => stat(file).then(
  () => true,
  () => false,
);

// Files written before #126 lay in DATA_DIR/documents, /projects and /diary. They are moved once at start-up;
// moving again finds nothing and changes nothing.
export const migrateFiles = async () => {
  let moved = 0;
  const projects = await sql<{ id: string; tenantId: string }[]>`select id, tenant_id as "tenantId" from projects`;
  for (const project of projects) {
    const legacy = path.join(config.dataDir, "projects", project.id);
    if (!(await isPresent(legacy))) continue;
    await moveInto(legacy, projectPath(project.tenantId, project.id));
    moved++;
  }
  const documents = await sql<{ id: string; projectId: string; tenantId: string }[]>`
    select id, project_id as "projectId", tenant_id as "tenantId" from documents`;
  for (const doc of documents) {
    const legacy = path.join(config.dataDir, "documents", doc.id);
    if (!(await isPresent(legacy))) continue;
    await moveInto(legacy, documentPath(projectPath(doc.tenantId, doc.projectId), doc.id));
    moved++;
  }
  const notes = await sql<{ id: string; projectId: string; tenantId: string; audioFile: string }[]>`
    select id, project_id as "projectId", tenant_id as "tenantId", audio_file as "audioFile" from diary_entries
    where audio_file is not null and audio_file not like ${`${path.join(config.dataDir, "tenants")}/%`}`;
  for (const note of notes) {
    const target = path.join(projectPath(note.tenantId, note.projectId), "diary", path.basename(note.audioFile));
    if (await isPresent(note.audioFile)) {
      await moveInto(note.audioFile, target);
      moved++;
    }
    await sql`update diary_entries set audio_file = ${target} where id = ${note.id}`;
  }
  // The old directories go once empty; anything left in them belongs to no row and is kept for a look by hand.
  for (const dir of ["documents", "projects", "diary"]) await rmdir(path.join(config.dataDir, dir)).catch(() => {});
  if (moved) console.log(`brygadzista: moved ${moved} file groups into per-firm directories`);
};
