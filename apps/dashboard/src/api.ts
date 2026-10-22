export type Role = "admin" | "app";

export type Project = {
  id: string;
  name: string;
  buildingType: string;
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

export type EmbeddingStatus = {
  active: { model: string; dimensions: number } | null;
  building: { model: string; dimensions: number; done: number; total: number; error: string | null } | null;
};

export type DocumentPage = {
  pageNo: number;
  title: string | null;
  kind: PageKind | null;
  summary: string | null;
  facts: PageFact[];
  indexed: boolean;
};

export type Region = { x: number; y: number; width: number; height: number };

// Questions to the designer (#73).
export type DesignerQuestion = {
  id: string;
  documentId: string | null;
  pageNo: number | null;
  pageTitle: string | null;
  region: Region | null;
  question: string;
  reason: string;
  status: "open" | "answered";
  answer: string | null;
  answeredAt: string | null;
  authorName: string;
  createdAt: string;
};

// Material schedules (#67).
export type ScheduleCategory = "stal" | "nadproza" | "okna" | "drzwi" | "prefabrykaty" | "inne";

export type ScheduleItem = {
  documentId: string;
  pageNo: number;
  category: ScheduleCategory;
  element: string;
  level: string;
  mark: string;
  description: string;
  dimensions: string;
  quantity: number | null;
  unit: string;
  quote: string;
  verified: boolean;
};

export type ScheduleTotal = { category: ScheduleCategory; label: string; unit: string; quantity: number; rows: number };

export type Schedule = {
  status: "ready" | "reading" | "no_model";
  pages: { documentId: string; pageNo: number; title: string | null }[];
  failedPages: number[];
  items: ScheduleItem[];
  totals: ScheduleTotal[];
};

export type NewQuestion = { question: string; documentId?: string; pageNo?: number; region?: Region | null; reason?: string };

export const cropQuery = (region: Region | null) =>
  region
    ? `x=${region.x.toFixed(4)}&y=${region.y.toFixed(4)}&w=${region.width.toFixed(4)}&h=${region.height.toFixed(4)}&`
    : "";

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

export type BuildingType = { type: string; label: string; stages: string[] };

export type Site = { address: string | null; lat: number | null; lon: number | null; found?: string | null };

export const createApi = (token: string) => ({
  // The chat runtime sends its own requests and needs the raw token for its headers.
  token,
  whoami: () => request<{ role: Role }>(token, "/api/auth/me"),
  listProjects: () => request<Project[]>(token, "/api/projects"),
  embeddingStatus: () => request<EmbeddingStatus>(token, "/api/admin/embeddings"),
  createProject: (name: string, buildingType: string) =>
    request<Pick<Project, "id" | "name" | "buildingType">>(token, "/api/projects", { method: "POST", body: JSON.stringify({ name, buildingType }) }),
  updateProject: (id: string, changes: { name?: string; buildingType?: string }) =>
    request<Pick<Project, "id" | "name" | "buildingType">>(token, `/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(changes) }),
  listBuildingTypes: () => request<BuildingType[]>(token, "/api/building-types"),
  deleteProject: (id: string) => request<void>(token, `/api/projects/${id}`, { method: "DELETE" }),
  getSite: (projectId: string) => request<Site | null>(token, `/api/projects/${projectId}/site`),
  putSite: (projectId: string, address: string) =>
    request<Site>(token, `/api/projects/${projectId}/site`, { method: "PUT", body: JSON.stringify({ address }) }),
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
  cropUrl: (documentId: string, pageNo: number, region: Region | null) =>
    `/api/documents/${documentId}/pages/${pageNo}/crop?${cropQuery(region)}token=${encodeURIComponent(token)}`,
  getSchedule: (projectId: string, category?: ScheduleCategory) =>
    request<Schedule>(token, `/api/projects/${projectId}/schedules${category ? `?category=${category}` : ""}`),
  scheduleCsv: async (projectId: string, category?: ScheduleCategory) => {
    const response = await fetch(`/api/projects/${projectId}/schedules.csv${category ? `?category=${category}` : ""}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new ApiError(`Błąd serwera (${response.status})`, response.status);
    return response.blob();
  },
  refreshSchedule: (projectId: string) => request<Schedule>(token, `/api/projects/${projectId}/schedules/refresh`, { method: "POST" }),
  listQuestions: (projectId: string) => request<DesignerQuestion[]>(token, `/api/projects/${projectId}/questions`),
  createQuestion: (projectId: string, question: NewQuestion) =>
    request<DesignerQuestion>(token, `/api/projects/${projectId}/questions`, { method: "POST", body: JSON.stringify(question) }),
  // An empty answer opens the question again.
  answerQuestion: (projectId: string, id: string, answer: string) =>
    request<DesignerQuestion>(token, `/api/projects/${projectId}/questions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ answer: answer.trim() || null }),
    }),
  deleteQuestion: (projectId: string, id: string) =>
    request<void>(token, `/api/projects/${projectId}/questions/${id}`, { method: "DELETE" }),
});

export type Api = ReturnType<typeof createApi>;
