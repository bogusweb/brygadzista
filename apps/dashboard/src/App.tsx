import { useMemo } from "react";
import { createApi } from "./api";
import { useAdminToken } from "./auth";
import { LoginScreen } from "./LoginScreen";
import { ProjectsScreen } from "./ProjectsScreen";

export const App = () => {
  const { token, signIn, signOut } = useAdminToken();
  const api = useMemo(() => (token ? createApi(token) : null), [token]);

  if (!api) return <LoginScreen onSignIn={signIn} />;

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Brygadzista</span>
        <button type="button" className="button ghost" onClick={signOut}>
          Wyloguj
        </button>
      </header>
      <main className="content">
        <ProjectsScreen api={api} onUnauthorized={signOut} />
      </main>
    </div>
  );
};
