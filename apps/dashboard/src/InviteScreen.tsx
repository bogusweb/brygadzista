import { useEffect, useState, type FormEvent } from "react";
import { publicApi, type InviteInfo, type Tenant } from "./api";
import { dateFormat, errorMessage } from "./format";
import { ROLE_HINTS, ROLE_LABELS } from "./roles";
import { routeHref } from "./route";

type Props = { token: string };

const MIN_PASSWORD_LENGTH = 10;

// The page behind an invitation link: works without signing in, the token in the link is the access.
export const InviteScreen = ({ token }: Props) => {
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState<{ email: string; tenant: Tenant } | null>(null);

  useEffect(() => {
    let cancelled = false;
    publicApi
      .inviteInfo(token)
      .then((info) => {
        if (cancelled) return;
        setInvite(info);
        setEmail(info.email ?? "");
      })
      .catch((cause: unknown) => !cancelled && setLoadError(errorMessage(cause)));
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setJoined(await publicApi.acceptInvite(token, { email: email.trim(), name: name.trim(), password }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <main className="login">
        <div className="card login-card">
          <h1>Zaproszenie nie działa</h1>
          <p className="muted">{loadError}</p>
          <a className="button ghost" href={routeHref({ screen: "projects" })}>
            Przejdź do logowania
          </a>
        </div>
      </main>
    );
  }

  if (!invite) {
    return (
      <main className="login">
        <div className="card login-card skeleton" aria-busy="true" />
      </main>
    );
  }

  if (joined) {
    const panel = joined.tenant.role !== "worker";
    return (
      <main className="login">
        <div className="card login-card">
          <h1>Jesteś w firmie {joined.tenant.name}</h1>
          <p className="muted">
            {panel
              ? `Zaloguj się do panelu adresem ${joined.email} i swoim hasłem.`
              : `Zaloguj się w aplikacji Brygadzista na telefonie adresem ${joined.email} i swoim hasłem.`}
          </p>
          {panel && (
            <a className="button primary" href={routeHref({ screen: "projects" })}>
              Przejdź do logowania
            </a>
          )}
        </div>
      </main>
    );
  }

  const passwordTooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit}>
        <h1>Dołącz do firmy {invite.tenantName}</h1>
        <p className="muted">
          Rola: {ROLE_LABELS[invite.role].toLowerCase()}. {ROLE_HINTS[invite.role]}. Link jest ważny do{" "}
          {dateFormat.format(new Date(invite.expiresAt))}.
        </p>
        <label className="field">
          <span>E-mail</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            readOnly={Boolean(invite.email)}
            onChange={(event) => setEmail(event.target.value)}
            autoFocus={!invite.email}
          />
        </label>
        <label className="field">
          <span>Imię i nazwisko</span>
          <input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} autoFocus={Boolean(invite.email)} />
        </label>
        <label className="field">
          <span>Hasło</span>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setError(null);
            }}
            aria-describedby="password-hint"
          />
          <span id="password-hint" className={`small ${passwordTooShort ? "danger-text" : "muted"}`}>
            Co najmniej {MIN_PASSWORD_LENGTH} znaków. Masz już konto w Brygadziście? Podaj jego obecne hasło, a firma
            dołączy do konta.
          </span>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button primary" disabled={busy || !email.trim() || !password}>
          {busy ? "Dołączam…" : "Dołącz do firmy"}
        </button>
      </form>
    </main>
  );
};
