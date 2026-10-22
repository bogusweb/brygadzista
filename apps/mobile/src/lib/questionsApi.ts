import { request } from "./http";
import type { DesignerQuestion, Region } from "./questions";
import type { Connection } from "./settings";

const questionsPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/questions`;

export const fetchQuestions = (connection: Connection, projectId: string) =>
  request<DesignerQuestion[]>(connection, questionsPath(projectId));

type NewQuestion = { question: string; documentId?: string; pageNo?: number; region?: Region | null; reason?: string };

export const saveQuestion = (connection: Connection, projectId: string, draft: NewQuestion) =>
  request<DesignerQuestion>(connection, questionsPath(projectId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft),
  });

// An empty answer opens the question again.
export const answerQuestion = (connection: Connection, projectId: string, id: string, answer: string) =>
  request<DesignerQuestion>(connection, `${questionsPath(projectId)}/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer: answer.trim() || null }),
  });

export const deleteQuestion = (connection: Connection, projectId: string, id: string) =>
  request<void>(connection, `${questionsPath(projectId)}/${id}`, { method: "DELETE" });
