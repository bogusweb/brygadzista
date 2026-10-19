import path from "node:path";
import { config } from "./config.js";

export const documentDir = (documentId: string) => path.join(config.dataDir, "documents", documentId);
export const documentPdf = (documentId: string) => path.join(documentDir(documentId), "source.pdf");
export const pageImagePrefix = (documentId: string, pageNo: number) =>
  path.join(documentDir(documentId), `page-${String(pageNo).padStart(4, "0")}`);
export const pageImage = (documentId: string, pageNo: number) => `${pageImagePrefix(documentId, pageNo)}.jpg`;
