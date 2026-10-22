import { ApiError, authHeaders } from "./api";
import type { Connection } from "./settings";

const TIMEOUT_MS = 30_000;

const messageForStatus = async (response: Response) => {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (body?.error) return body.error;
  if (response.status === 401 || response.status === 403) return "Nieprawidłowy kod dostępu.";
  return `Serwer odpowiedział błędem ${response.status}.`;
};

// A missing status on the error means the request never got an answer (no signal), which the offline queue waits out.
export const request = async <T>(connection: Connection, path: string, init: RequestInit = {}): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${connection.serverUrl}${path}`, {
      ...init,
      headers: { ...authHeaders(connection), ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });
  } catch {
    throw new ApiError("Nie udało się połączyć z serwerem. Sprawdź zasięg.");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new ApiError(await messageForStatus(response), response.status);
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
};
