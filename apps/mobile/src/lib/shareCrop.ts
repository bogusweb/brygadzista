import * as Sharing from "expo-sharing";
import { Directory, File, Paths } from "expo-file-system";
import { authHeaders } from "./api";
import type { Connection } from "./settings";

// The crop is downloaded to the cache and handed to the system share sheet, so it goes out with the question.
export const shareCrop = async (connection: Connection, path: string, name: string) => {
  if (!(await Sharing.isAvailableAsync())) throw new Error("Udostępnianie plików nie działa na tym urządzeniu.");
  const target = new File(new Directory(Paths.cache, "questions"), `${name}.jpg`);
  if (!target.parentDirectory.exists) target.parentDirectory.create({ intermediates: true });
  const file = await File.downloadFileAsync(`${connection.serverUrl}${path}`, target, { headers: authHeaders(connection), idempotent: true });
  await Sharing.shareAsync(file.uri, { mimeType: "image/jpeg", dialogTitle: "Wyślij wycinek rysunku" });
};
