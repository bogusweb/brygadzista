import path from "node:path";
import { config } from "./config.js";

export const documentDir = (documentId: string) => path.join(config.dataDir, "documents", documentId);
export const documentPdf = (documentId: string) => path.join(documentDir(documentId), "source.pdf");
export const pageImagePrefix = (documentId: string, pageNo: number) =>
  path.join(documentDir(documentId), `page-${String(pageNo).padStart(4, "0")}`);
export const pageImage = (documentId: string, pageNo: number) => `${pageImagePrefix(documentId, pageNo)}.jpg`;
// Site photos (#70) live next to the project, so a backup of DATA_DIR takes them along with the PDFs.
export const projectDir = (projectId: string) => path.join(config.dataDir, "projects", projectId);
export const photoFile = (projectId: string, photoId: string, size: "full" | "thumb") =>
  path.join(projectDir(projectId), "photos", size === "thumb" ? `${photoId}-thumb.jpg` : `${photoId}.jpg`);
export const pageTilesDir =(documentId: string, pageNo: number) => `${pageImagePrefix(documentId, pageNo)}-tiles`;
