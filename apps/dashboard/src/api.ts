export type Role = "admin" | "app";

export type TenantRole = "owner" | "manager" | "worker";

export type Tenant = { id: string; name: string; role: TenantRole };

export type SessionUser = { id: string; email: string; name: string; role: "operator" | "user" };

// `user` is null for the operator token from env; `tenant` is null for an operator outside any firm.
export type Me = { role: Role; user: SessionUser | null; operator: boolean; tenant: Tenant | null; tenants: Tenant[] };

export type LoginResult = Me & { token: string; expiresAt: string };

export type FirmSummary = { id: string; name: string; createdAt: string; disabled: boolean; memberCount: number; projectCount: number };

export type Member = {
  id: string;
  email: string;
  name: string;
  disabled: boolean;
  blocked: boolean;
  createdAt: string;
  role: TenantRole;
  projectIds: string[];
};

export type MemberPatch = Partial<{ name: string; role: TenantRole; blocked: boolean }>;

export type Invite = {
  id: string;
  email: string | null;
  role: TenantRole;
  projectIds: string[];
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedByName: string | null;
  acceptedByEmail: string | null;
};

export type NewInvite = { role: TenantRole; email?: string; days?: number; projectIds?: string[] };

export type InviteInfo = { tenantName: string; email: string | null; role: TenantRole; expiresAt: string };

export type Project = {
  id: string;
  name: string;
  tenantId: string;
  createdAt: string;
  documentCount: number;
};

export type DocumentStatus = "uploading" | "awaiting_start" | "queued" | "processing" | "paused" | "ready" | "error";

export type IndexingEstimate = { pages: number; costUsd: number; seconds: number; vision: boolean };

export type IndexingProgress = { total: number; done: number; startedAt: string | null; etaSeconds: number };

export type ProjectDocument = {
  id: string;
  filename: string;
  pageCount: number;
  indexedPages: number;
  status: DocumentStatus;
  error: string | null;
  createdAt: string;
  // Older servers (before #9) don't send these, so they stay optional.
  estimate?: IndexingEstimate;
  progress?: IndexingProgress | null;
  failedPages?: number;
};

export type UploadedDocument = { id: string; status?: DocumentStatus; pageCount?: number; estimate?: IndexingEstimate };

export type PageKind = "opis" | "rysunek" | "detal" | "zestawienie" | "formalne" | "inne";

export type PageFact = { label: string; value: string };

export type DocumentPage = {
  pageNo: number;
  title: string | null;
  kind: PageKind | null;
  summary: string | null;
  facts: PageFact[];
  indexed: boolean;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const request = async <T>(token: string | null, path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Błąd serwera (${response.status})`, response.status);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
};

const errorFromXhr = (xhr: XMLHttpRequest) => {
  try {
    const body = JSON.parse(xhr.responseText) as { error?: string };
    if (body.error) return new ApiError(body.error, xhr.status);
  } catch {
    // Not JSON: fall through to the generic message.
  }
  return new ApiError(`Błąd serwera (${xhr.status})`, xhr.status);
};

// fetch() can't report upload progress, so the PDF goes up through XHR.
const uploadDocument = (token: string, projectId: string, file: File, onProgress: (fraction: number) => void) => {
  const xhr = new XMLHttpRequest();
  const done = new Promise<UploadedDocument>((resolve, reject) => {
    // autostart=0: indexing waits until the operator has seen the cost estimate and pressed start.
    xhr.open("PUT", `/api/projects/${projectId}/documents?filename=${encodeURIComponent(file.name)}&autostart=0`);
    xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.setRequestHeader("content-type", "application/pdf");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText) as UploadedDocument);
      else reject(errorFromXhr(xhr));
    };
    xhr.onerror = () => reject(new ApiError("Połączenie przerwane. Sprawdź internet i wyślij plik ponownie.", 0));
    xhr.onabort = () => reject(new ApiError("Wysyłanie anulowane.", 0));
    xhr.send(file);
  });
  return { done, cancel: () => xhr.abort() };
};

export type Site = { address: string | null; lat: number | null; lon: number | null; found?: string | null };

const post = (body: unknown, method = "POST"): RequestInit => ({ method, body: JSON.stringify(body) });

// Requests that need no session: signing in and the invitation page.
export const publicApi = {
  login: (email: string, password: string) => request<LoginResult>(null, "/api/auth/login", post({ email, password })),
  inviteInfo: (token: string) => request<InviteInfo>(null, `/api/invites/token/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, body: { email?: string; name: string; password: string }) =>
    request<{ email: string; tenant: Tenant }>(null, `/api/invites/token/${encodeURIComponent(token)}/accept`, post(body)),
};

// `operatorTenantId` is the firm an operator outside any firm picked in the header. Firm-scoped requests name it in
// ?tenantId=; for everyone else the server takes the firm from the session.
export const createApi = (token: string, operatorTenantId: string | null = null) => {
  const scoped = (path: string) =>
    operatorTenantId ? `${path}${path.includes("?") ? "&" : "?"}tenantId=${encodeURIComponent(operatorTenantId)}` : path;
  return {
    // The chat runtime sends its own requests and needs the raw token for its headers.
    token,
    operatorTenantId,
    whoami: () => request<Me>(token, "/api/auth/me"),
    logout: () => request<void>(token, "/api/auth/logout", { method: "POST" }),
    switchTenant: (tenantId: string) => request<Me>(token, "/api/auth/tenant", post({ tenantId })),
    listFirms: () => request<FirmSummary[]>(token, "/api/tenants"),
    createFirm: (name: string) => request<{ id: string; name: string }>(token, "/api/tenants", post({ name })),
    renameFirm: (name: string) => request<{ id: string; name: string }>(token, scoped("/api/tenant"), post({ name }, "PATCH")),
    listMembers: () => request<Member[]>(token, scoped("/api/users")),
    updateMember: (id: string, patch: MemberPatch) => request<Member>(token, scoped(`/api/users/${id}`), post(patch, "PATCH")),
    removeMember: (id: string) => request<void>(token, scoped(`/api/users/${id}`), { method: "DELETE" }),
    addToProject: (projectId: string, userId: string) =>
      request<void>(token, `/api/projects/${projectId}/members/${userId}`, { method: "PUT" }),
    removeFromProject: (projectId: string, userId: string) =>
      request<void>(token, `/api/projects/${projectId}/members/${userId}`, { method: "DELETE" }),
    listInvites: () => request<Invite[]>(token, scoped("/api/invites")),
    createInvite: (invite: NewInvite) => request<Invite & { token: string }>(token, scoped("/api/invites"), post(invite)),
    revokeInvite: (id: string) => request<void>(token, scoped(`/api/invites/${id}`), { method: "DELETE" }),
    listProjects: () => request<Project[]>(token, "/api/projects"),
    createProject: (name: string) =>
      request<Pick<Project, "id" | "name">>(token, "/api/projects", post({ name, tenantId: operatorTenantId ?? undefined })),
    deleteProject: (id: string) => request<void>(token, `/api/projects/${id}`, { method: "DELETE" }),
    getSite: (projectId: string) => request<Site | null>(token, `/api/projects/${projectId}/site`),
    putSite: (projectId: string, address: string) => request<Site>(token, `/api/projects/${projectId}/site`, post({ address }, "PUT")),
    listDocuments: (projectId: string) => request<ProjectDocument[]>(token, `/api/projects/${projectId}/documents`),
    uploadDocument: (projectId: string, file: File, onProgress: (fraction: number) => void) =>
      uploadDocument(token, projectId, file, onProgress),
    startDocument: (id: string) => request<{ ok: true }>(token, `/api/documents/${id}/start`, { method: "POST" }),
    resumeDocument: (id: string) => request<{ ok: true }>(token, `/api/documents/${id}/resume`, { method: "POST" }),
    reindexDocument: (id: string) => request<{ ok: true }>(token, `/api/documents/${id}/reindex`, { method: "POST" }),
    deleteDocument: (id: string) => request<void>(token, `/api/documents/${id}`, { method: "DELETE" }),
    listPages: (documentId: string) => request<DocumentPage[]>(token, `/api/documents/${documentId}/pages`),
    pageText: (documentId: string, pageNo: number) =>
      request<{ text: string }>(token, `/api/documents/${documentId}/pages/${pageNo}/text`),
    // <img> can't send headers, so the image URL carries the token as a query parameter.
    pageImageUrl: (documentId: string, pageNo: number) =>
      `/api/documents/${documentId}/pages/${pageNo}/image?token=${encodeURIComponent(token)}`,
  };
};

export type Api = ReturnType<typeof createApi>;
