import type { Checklist, ChecklistEvent, ChecklistSummary, ProjectTemplates } from "./checklists";
import { toSyncEvent } from "./checklists";
import { request } from "./http";
import type { Connection } from "./settings";

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/checklists`;
const checklistPath = (id: string) => `/api/checklists/${encodeURIComponent(id)}`;

export const fetchTemplates = (connection: Connection, projectId: string) =>
  request<ProjectTemplates>(connection, `/api/projects/${encodeURIComponent(projectId)}/checklist-templates`);

export const fetchChecklists = (connection: Connection, projectId: string) =>
  request<ChecklistSummary[]>(connection, projectPath(projectId));

export const fetchChecklist = (connection: Connection, id: string) => request<Checklist>(connection, checklistPath(id));

// Filling from the project runs on the server; the answer is the checklist still "generating".
export const createChecklist = (connection: Connection, projectId: string, stage: string) =>
  request<Checklist>(connection, projectPath(projectId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage }),
  });

export const syncChecklist = (connection: Connection, id: string, events: ChecklistEvent[]) =>
  request<Checklist>(connection, `${checklistPath(id)}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: events.map(toSyncEvent) }),
  });
