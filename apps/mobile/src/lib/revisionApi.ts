import { request } from "./http";
import type { Revision } from "./revisions";
import type { Connection } from "./settings";

export const fetchRevisions = (connection: Connection, projectId: string) =>
  request<Revision[]>(connection, `/api/projects/${encodeURIComponent(projectId)}/revisions`);
