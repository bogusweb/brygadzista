import { useState, type FormEvent } from "react";
import { ApiError, createApi, publicApi, type Tenant } from "./api";
import { panelFirms, ROLE_LABELS } from "./roles";

type Props = { onSignIn: (token: string) => void };

type Mode = "account" | "token";

const WORKER_ONLY = "To konto pracownika. Panel jest dla właściciela i kierownika, a pracownik korzysta z aplikacji na telefonie.";

export const LoginScreen = ({ onSignIn }: Props) => {
  const [mode, setMode] = useState<Mode>("account");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // After login with several firms the person picks one before entering the panel.
  const [choice, setChoice] = useState<{ token: string; firms: Tenant[] } | null>(null);

  const fail = (cause: unknown, unauthorized: string) =>
    setError(
      cause instanceof ApiError && cause.status === 401
        ? unauthorized
        : cause instanceof Error
          ? cause.message
          : "Nie udało się połączyć z serwerem. Spróbuj ponownie.",
    );

  const enterFirm = async (sessionToken: string, tenant: Tenant, current: Tenant | null) => {
    if (tenant.id !== current?.id) await createApi(sessionToken).switchTenant(tenant.id);
    onSignIn(sessionToken);
  };

  const submitAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const result = await publicApi.login(email.trim(), password);
      const firms = panelFirms(result.tenants);
      if (result.operator && firms.length === 0) return onSignIn(result.token);
      if (firms.length === 0) {
        await createApi(result.token).logout().catch(() => {});
        return setError(WORKER_ONLY);
      }
      if (firms.length === 1) return await enterFirm(result.token, firms[0]!, result.tenant);
      setChoice({ token: result.token, firms });
    } catch (cause) {
      fail(cause, "Nieprawidłowy e-mail lub hasło.");
    } finally {
      setBusy(false);
    }
  };

  const submitToken = async (event: FormEvent) => {
    event.preventDefault();
    const candidate = token.trim();
    if (!candidate) return;
    setBusy(true);
    setError(null);
    try {
      const { role } = await createApi(candidate).whoami();
      if (role !== "admin") throw new ApiError("To token aplikacji, a panel wymaga tokenu operatora.", 403);
      onSignIn(candidate);
    } catch (cause) {
      fail(cause, "Ten token nie pasuje. Sprawdź ADMIN_TOKEN na serwerze i spróbuj ponownie.");
    } finally {
      setBusy(false);
    }
  };

  const pick = async (tenant: Tenant) => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      await enterFirm(choice.token, tenant, null);
    } catch (cause) {
      fail(cause, "Sesja wygasła. Zaloguj się ponownie.");
      setBusy(false);
    }
  };

  if (choice) {
    return (
      <main className="login">
        <div className="card login-card">
          <h1>Wybierz firmę</h1>
          <p className="muted">Należysz do kilku firm. Firmę zmienisz później w nagłówku panelu.</p>
          <ul className="list">
            {choice.firms.map((firm) => (
              <li key={firm.id}>
                <button type="button" className="button ghost firm-choice" disabled={busy} onClick={() => void pick(firm)}>
                  <span>{firm.name}</span>
                  <span className="muted small">{ROLE_LABELS[firm.role]}</span>
                </button>
              </li>
            ))}
          </ul>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="login">
      {mode === "account" ? (
        <form className="card login-card" onSubmit={submitAccount}>
          <h1>Brygadzista</h1>
          <p className="muted">Panel firmy. Zaloguj się swoim kontem.</p>
          <label className="field">
            <span>E-mail</span>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setError(null);
              }}
              autoFocus
            />
          </label>
          <label className="field">
            <span>Hasło</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button primary" disabled={busy || !email.trim() || !password}>
            {busy ? "Loguję…" : "Zaloguj się"}
          </button>
          <button
            type="button"
            className="link muted small"
            onClick={() => {
              setMode("token");
              setError(null);
            }}
          >
            Zaloguj się tokenem operatora
          </button>
        </form>
      ) : (
        <form className="card login-card" onSubmit={submitToken}>
          <h1>Brygadzista</h1>
          <p className="muted">Awaryjne wejście operatora tokenem ADMIN_TOKEN z serwera.</p>
          <label className="field">
            <span>Token operatora</span>
            <input
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setError(null);
              }}
              autoFocus
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button primary" disabled={busy || !token.trim()}>
            {busy ? "Sprawdzam…" : "Zaloguj się tokenem"}
          </button>
          <button
            type="button"
            className="link muted small"
            onClick={() => {
              setMode("account");
              setError(null);
            }}
          >
            Wróć do logowania kontem
          </button>
        </form>
      )}
    </main>
  );
};
