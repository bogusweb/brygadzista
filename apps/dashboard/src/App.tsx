import { useMemo } from "react";
import { createApi } from "./api";
import { useAdminToken } from "./auth";
import { LoginScreen } from "./LoginScreen";
import { DocumentScreen } from "./DocumentScreen";
import { ProjectScreen } from "./ProjectScreen";
import { ProjectsScreen } from "./ProjectsScreen";
import { useRoute } from "./route";

export const App = () => {
  const { token, signIn, signOut } = useAdminToken();
  const api = useMemo(() => (token ? createApi(token) : null), [token]);
  const route = useRoute();

  if (!api) return <LoginScreen onSignIn={signIn} />;

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          Brygadzista
        </a>
        <button type="button" className="button ghost" onClick={signOut}>
          Wyloguj
        </button>
      </header>
      <main className="content">
        {route.screen === "projects" && <ProjectsScreen api={api} onUnauthorized={signOut} />}
        {route.screen === "project" && (
          <ProjectScreen key={route.projectId} api={api} projectId={route.projectId} onUnauthorized={signOut} />
        )}
        {route.screen === "document" && (
          <DocumentScreen
            key={route.documentId}
            api={api}
            projectId={route.projectId}
            documentId={route.documentId}
            onUnauthorized={signOut}
          />
        )}
      </main>
    </div>
  );
};
