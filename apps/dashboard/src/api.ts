export type Role = "admin" | "app";

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  documentCount: number;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const request = async <T>(token: string, path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Błąd serwera (${response.status})`, response.status);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
};

export const createApi = (token: string) => ({
  whoami: () => request<{ role: Role }>(token, "/api/auth/me"),
  listProjects: () => request<Project[]>(token, "/api/projects"),
  createProject: (name: string) =>
    request<Pick<Project, "id" | "name">>(token, "/api/projects", { method: "POST", body: JSON.stringify({ name }) }),
  deleteProject: (id: string) => request<void>(token, `/api/projects/${id}`, { method: "DELETE" }),
});

export type Api = ReturnType<typeof createApi>;
