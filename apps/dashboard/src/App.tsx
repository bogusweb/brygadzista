import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, createApi, type FirmSummary, type Me } from "./api";
import { useOperatorTenant, useStoredToken } from "./auth";
import { DocumentScreen } from "./DocumentScreen";
import { FirmScreen } from "./FirmScreen";
import { errorMessage } from "./format";
import { InviteScreen } from "./InviteScreen";
import { LoginScreen } from "./LoginScreen";
import { ProjectScreen } from "./ProjectScreen";
import { ProjectsScreen } from "./ProjectsScreen";
import { panelFirms } from "./roles";
import { routeHref, useRoute, type Route } from "./route";

// CopilotKit is most of the bundle, so it loads only when the chat opens.
const ChatScreen = lazy(() => import("./ChatScreen").then((module) => ({ default: module.ChatScreen })));

export const App = () => {
  const route = useRoute();
  const { token, signIn, signOut } = useStoredToken();

  if (route.screen === "invite") return <InviteScreen token={route.token} />;
  if (!token) return <LoginScreen onSignIn={signIn} />;
  return <Panel key={token} token={token} route={route} onSignOut={signOut} />;
};

type PanelProps = { token: string; route: Route; onSignOut: () => void };

const Panel = ({ token, route, onSignOut }: PanelProps) => {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [firms, setFirms] = useState<FirmSummary[]>([]);
  const [operatorTenant, chooseOperatorTenant] = useOperatorTenant();
  const [switching, setSwitching] = useState(false);

  // An operator outside any firm (the ADMIN_TOKEN, or an operator account without a firm) picks the firm here;
  // everyone else works in the firm of their session.
  const operatorMode = Boolean(me?.operator && !me.tenant);
  const api = useMemo(() => createApi(token, operatorMode ? operatorTenant : null), [token, operatorMode, operatorTenant]);
  const activeTenantId = me?.tenant?.id ?? (operatorMode ? operatorTenant : null);
  const canManagePeople = Boolean(me && (me.operator || me.tenant?.role === "owner"));

  const signOut = useCallback(() => {
    if (me?.user) void api.logout().catch(() => {});
    onSignOut();
  }, [api, me, onSignOut]);

  useEffect(() => {
    let cancelled = false;
    createApi(token)
      .whoami()
      .then((result) => !cancelled && setMe(result))
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 401) onSignOut();
        else setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [token, onSignOut]);

  const reloadFirms = useCallback(async () => {
    try {
      setFirms(await api.listFirms());
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [api]);

  useEffect(() => {
    if (operatorMode) void reloadFirms();
  }, [operatorMode, reloadFirms]);

  // A firm picked earlier that no longer exists falls back to every firm.
  useEffect(() => {
    if (operatorMode && operatorTenant && firms.length > 0 && !firms.some((firm) => firm.id === operatorTenant)) {
      chooseOperatorTenant(null);
    }
  }, [operatorMode, operatorTenant, firms, chooseOperatorTenant]);

  const switchFirm = async (tenantId: string) => {
    window.location.hash = routeHref({ screen: "projects" });
    if (operatorMode) return chooseOperatorTenant(tenantId || null);
    setSwitching(true);
    try {
      setMe(await api.switchTenant(tenantId));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return onSignOut();
      setError(errorMessage(cause));
    } finally {
      setSwitching(false);
    }
  };

  if (!me) {
    return (
      <main className="login">
        {error ? (
          <p className="error" role="alert">
            {error}{" "}
            <button type="button" className="link" onClick={() => window.location.reload()}>
              Odśwież
            </button>
          </p>
        ) : (
          <div className="card login-card skeleton" aria-busy="true" />
        )}
      </main>
    );
  }

  const switchable = operatorMode
    ? firms.map((firm) => ({ id: firm.id, name: firm.name }))
    : panelFirms(me.tenants).concat(me.tenant && me.tenant.role === "worker" ? [me.tenant] : []);
  const firmNames = new Map(firms.map((firm) => [firm.id, firm.name]));
  const inPanel = me.role === "admin";

  const firmRenamed = (name: string) => {
    const current = me.tenant;
    if (!current) return void reloadFirms();
    setMe({
      ...me,
      tenant: { ...current, name },
      tenants: me.tenants.map((tenant) => (tenant.id === current.id ? { ...tenant, name } : tenant)),
    });
  };

  return (
    <div className="shell">
      <header className="topbar">
        <nav className="topnav">
          <a className="brand" href={routeHref({ screen: "projects" })}>
            Brygadzista
          </a>
          {inPanel && (
            <a className="navlink" href={routeHref({ screen: "projects" })} aria-current={route.screen !== "firm" ? "page" : undefined}>
              Projekty
            </a>
          )}
          {inPanel && canManagePeople && (
            <a className="navlink" href={routeHref({ screen: "firm" })} aria-current={route.screen === "firm" ? "page" : undefined}>
              Firma
            </a>
          )}
        </nav>
        <div className="topbar-side">
          {operatorMode || switchable.length > 1 ? (
            <label className="firm-switch">
              <span className="visually-hidden">Firma</span>
              <select
                value={activeTenantId ?? ""}
                disabled={switching}
                onChange={(event) => void switchFirm(event.target.value)}
              >
                {operatorMode && <option value="">Wszystkie firmy</option>}
                {switchable.map((firm) => (
                  <option key={firm.id} value={firm.id}>
                    {firm.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            me.tenant && <span className="muted small firm-name">{me.tenant.name}</span>
          )}
          <span className="muted small user-name" title={me.user?.email}>
            {me.user ? me.user.name || me.user.email : "Operator"}
          </span>
          <button type="button" className="button ghost" onClick={signOut}>
            Wyloguj
          </button>
        </div>
      </header>
      <main className="content" key={activeTenantId ?? "all"}>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!inPanel ? (
          <div className="card empty">
            <h2>W tej firmie jesteś pracownikiem</h2>
            <p className="muted">Pracownik korzysta z aplikacji na telefonie. Wybierz w nagłówku firmę, w której jesteś właścicielem albo kierownikiem.</p>
          </div>
        ) : (
          <>
            {route.screen === "projects" && (
              <ProjectsScreen
                api={api}
                onUnauthorized={signOut}
                tenantId={activeTenantId}
                firmNames={operatorMode && !operatorTenant ? firmNames : null}
              />
            )}
            {route.screen === "firm" && (
              <FirmScreen
                api={api}
                me={me}
                tenantId={activeTenantId}
                firms={operatorMode ? firms : null}
                onFirmsChanged={reloadFirms}
                onPickFirm={(id) => void switchFirm(id)}
                onRenamed={firmRenamed}
                onUnauthorized={signOut}
              />
            )}
            {route.screen === "project" && (
              <ProjectScreen key={route.projectId} api={api} projectId={route.projectId} onUnauthorized={signOut} />
            )}
            {route.screen === "chat" && (
              <Suspense fallback={<div className="card skeleton" aria-busy="true" />}>
                <ChatScreen key={route.projectId} api={api} projectId={route.projectId} onUnauthorized={signOut} />
              </Suspense>
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
          </>
        )}
      </main>
    </div>
  );
};
