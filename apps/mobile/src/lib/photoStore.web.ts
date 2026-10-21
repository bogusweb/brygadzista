import { ApiError, authHeaders, photoUploadUrl } from "./api";
import type { PendingPhoto } from "./pins";
import type { Connection } from "./settings";

// The browser has no app storage for files: a picked photo is only a blob: address that lives until the tab closes,
// so photos taken without signal wait in memory and are lost on reload (the pin and its note are kept).
export const keepPhoto = (_connection: Connection, _photoId: string, pickedUri: string) => pickedUri;
export const localPhotoUri = (_connection: Connection, _photoId: string): string | null => null;
export const forgetPhoto = (_connection: Connection, _photoId: string) => {};

export const uploadPhoto = async (connection: Connection, projectId: string, photo: PendingPhoto) => {
  const blob = await fetch(photo.uri)
    .then((response) => response.blob())
    .catch(() => null);
  if (!blob) throw new ApiError("Zdjęcie przepadło po odświeżeniu strony", 410);
  let response: Response;
  try {
    response = await fetch(photoUploadUrl(connection, projectId, photo), {
      method: "PUT",
      headers: { ...authHeaders(connection), "content-type": blob.type || "image/jpeg" },
      body: blob,
    });
  } catch {
    throw new ApiError("Nie udało się wysłać zdjęcia. Sprawdź zasięg.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Serwer odpowiedział błędem ${response.status}.`, response.status);
  }
};
