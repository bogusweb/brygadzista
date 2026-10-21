import { Directory, File, Paths } from "expo-file-system";
import { ApiError, authHeaders, photoUploadUrl } from "./api";
import { serverFolderName } from "./offline";
import type { PendingPhoto } from "./pins";
import type { Connection } from "./settings";

// Photos taken on site are copied into the document directory at once: the picker's own file sits in the cache,
// which the system may empty before the phone gets signal again. Uploaded photos stay there too, so they keep
// showing without signal.
const photosDir = (connection: Connection) => new Directory(Paths.document, "offline", serverFolderName(connection.serverUrl), "photos");
const photoFile = (connection: Connection, photoId: string) => new File(photosDir(connection), `${photoId}.jpg`);

export const keepPhoto = (connection: Connection, photoId: string, pickedUri: string) => {
  photosDir(connection).create({ intermediates: true, idempotent: true });
  const target = photoFile(connection, photoId);
  new File(pickedUri).copy(target);
  return target.uri;
};

export const localPhotoUri = (connection: Connection, photoId: string) => {
  const file = photoFile(connection, photoId);
  return file.exists ? file.uri : null;
};

export const forgetPhoto = (connection: Connection, photoId: string) => {
  const file = photoFile(connection, photoId);
  if (file.exists) file.delete();
};

export const uploadPhoto = async (connection: Connection, projectId: string, photo: PendingPhoto) => {
  const file = new File(photo.uri);
  // 410: the copy is gone (app data cleared), so retrying can never succeed.
  if (!file.exists) throw new ApiError("Nie ma już pliku zdjęcia na telefonie", 410);
  let result;
  try {
    result = await file.upload(photoUploadUrl(connection, projectId, photo), {
      httpMethod: "PUT",
      headers: authHeaders(connection),
      mimeType: "image/jpeg",
    });
  } catch {
    throw new ApiError("Nie udało się wysłać zdjęcia. Sprawdź zasięg.");
  }
  if (result.status >= 400) {
    const message = (() => {
      try {
        return (JSON.parse(result.body) as { error?: string }).error;
      } catch {
        return undefined;
      }
    })();
    throw new ApiError(message ?? `Serwer odpowiedział błędem ${result.status}.`, result.status);
  }
};
