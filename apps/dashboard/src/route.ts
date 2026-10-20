import { useEffect, useState } from "react";

export type Route =
  | { screen: "projects" }
  | { screen: "project"; projectId: string }
  | { screen: "chat"; projectId: string }
  | { screen: "document"; projectId: string; documentId: string };

// Hash routes keep the browser back button working without a router or server rewrites.
const parse = (hash: string): Route => {
  const [, projects, projectId, documents, documentId] = hash.replace(/^#/, "").split("/");
  if (projects !== "projects" || !projectId) return { screen: "projects" };
  if (documents === "documents" && documentId) return { screen: "document", projectId, documentId };
  if (documents === "chat") return { screen: "chat", projectId };
  return { screen: "project", projectId };
};

export const routeHref = (route: Route) => {
  if (route.screen === "projects") return "#/";
  if (route.screen === "project") return `#/projects/${route.projectId}`;
  if (route.screen === "chat") return `#/projects/${route.projectId}/chat`;
  return `#/projects/${route.projectId}/documents/${route.documentId}`;
};

export const useRoute = () => {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
};
