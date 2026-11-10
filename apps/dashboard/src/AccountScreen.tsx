import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, type AccountSession, type Api, type McpToken, type Me, type TotpStatus } from "./api";
import { dateFormat, errorMessage } from "./format";

type Props = { api: Api; me: Me; onUnauthorized: () => void };

const dateTime = new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short" });
const when = (value: string | null) => (value ? dateTime.format(new Date(value)) : "nigdy");

// A short device name from the browser's user agent, enough to recognize one's own phone or laptop.
const deviceName = (userAgent: string | null) => {
  if (!userAgent) return "Nieznane urządzenie";
  const system = /iPhone|iPad/.test(userAgent)
    ? "iPhone / iPad"
    : /Android/.test(userAgent)
      ? "Android"
      : /Windows/.test(userAgent)
        ? "Windows"
        : /Mac OS X/.test(userAgent)
          ? "Mac"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  const app = /Expo|okhttp|CFNetwork|Darwin/.test(userAgent)
    ? "aplikacja"
    : /Edg\//.test(userAgent)
      ? "Edge"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : null;
  return [app, system].filter(Boolean).join(", ") || userAgent.slice(0, 60);
};

const TOKEN_DAYS = [7, 30, 90, 365];

// The person's own account (#167, #168, #176): where it is logged in, tokens for AI connectors, and the second factor.
export const AccountScreen = ({ api, me, onUnauthorized }: Props) => {
  const [error, setError] = useState<string | null>(null);

  const handleError = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401 && !cause.totpRequired) return onUnauthorized();
      setError(errorMessage(cause));
    },
    [onUnauthorized],
  );

  if (!me.user) {
    return (
      <div className="card empty">
        <h2>Wejście tokenem operatora</h2>
        <p className="muted">Token ADMIN_TOKEN nie ma konta. Sesje, tokeny MCP i logowanie dwuetapowe ustawia się po zalogowaniu kontem.</p>
      </div>
    );
  }

  return (
    <section className="stack">
      <div className="section-head">
        <h1>Konto</h1>
        <p className="muted">
          {me.user.name || me.user.email} · {me.user.email}
        </p>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <SecondFactor api={api} onError={handleError} />
      <Sessions api={api} onError={handleError} />
      <McpTokens api={api} onError={handleError} />
      <Password api={api} onError={handleError} onUnauthorized={onUnauthorized} />
    </section>
  );
};

type PartProps = { api: Api; onError: (cause: unknown) => void };

const SecondFactor = ({ api, onError }: PartProps) => {
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => api.totpStatus().then(setStatus).catch(onError), [api, onError]);
  useEffect(() => void reload(), [reload]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  };

  const start = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setSetup(await api.totpSetup(password));
      setPassword("");
    });
  };

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await api.totpEnable(code.trim());
      setRecoveryCodes(result.recoveryCodes);
      setSetup(null);
      setCode("");
      await reload();
    });
  };

  const turnOff = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api.totpDisable(password, code.trim());
      setPassword("");
      setCode("");
      setDisabling(false);
      await reload();
    });
  };

  return (
    <div className="card stack account-card">
      <h2>Logowanie dwuetapowe</h2>
      {status === null ? (
        <p className="muted">Sprawdzam…</p>
      ) : recoveryCodes ? (
        <>
          <p>Włączone. Zapisz kody zapasowe w bezpiecznym miejscu: każdy wpuści raz, gdy zgubisz telefon. Więcej ich nie zobaczysz.</p>
          <pre className="recovery-codes">{recoveryCodes.join("\n")}</pre>
          <button type="button" className="button ghost" onClick={() => setRecoveryCodes(null)}>
            Zapisałem kody
          </button>
        </>
      ) : status.enabled ? (
        <>
          <p className="muted">
            Włączone od {dateFormat.format(new Date(status.enabledAt!))}. Kody zapasowe: zostało {status.recoveryCodesLeft} z 10.
          </p>
          {disabling ? (
            <form className="stack" onSubmit={turnOff}>
              <label className="field">
                <span>Hasło</span>
                <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
              <label className="field">
                <span>Kod z aplikacji albo kod zapasowy</span>
                <input autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
              </label>
              <div className="row-actions">
                <button type="submit" className="button danger" disabled={busy || !password || !code.trim()}>
                  Wyłącz logowanie dwuetapowe
                </button>
                <button type="button" className="button ghost" onClick={() => setDisabling(false)}>
                  Anuluj
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="button ghost" onClick={() => setDisabling(true)}>
              Wyłącz
            </button>
          )}
        </>
      ) : setup ? (
        <form className="stack" onSubmit={confirm}>
          <p>Zeskanuj kod w aplikacji uwierzytelniającej (np. Google Authenticator, Aegis, 1Password) i wpisz 6 cyfr, które pokaże.</p>
          <img className="totp-qr" src={setup.qrDataUrl} alt="Kod QR do aplikacji uwierzytelniającej" width={220} height={220} />
          <p className="muted small">
            Nie da się zeskanować? Wpisz klucz ręcznie: <code>{setup.secret}</code>
          </p>
          <label className="field">
            <span>Kod z aplikacji</span>
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} autoFocus />
          </label>
          <button type="submit" className="button primary" disabled={busy || code.trim().length < 6}>
            Włącz
          </button>
        </form>
      ) : (
        <form className="stack" onSubmit={start}>
          <p className="muted">Po włączeniu logowanie wymaga też kodu z aplikacji w telefonie, więc samo hasło nie wystarczy.</p>
          <label className="field">
            <span>Hasło</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <button type="submit" className="button primary" disabled={busy || !password}>
            Skonfiguruj
          </button>
        </form>
      )}
    </div>
  );
};

const Sessions = ({ api, onError }: PartProps) => {
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const reload = useCallback(() => api.listSessions().then(setSessions).catch(onError), [api, onError]);
  useEffect(() => void reload(), [reload]);

  const act = (action: () => Promise<void>) => void action().then(reload).catch(onError);

  return (
    <div className="card stack account-card">
      <h2>Gdzie jesteś zalogowany</h2>
      {sessions === null ? (
        <p className="muted">Wczytuję…</p>
      ) : (
        <ul className="list">
          {sessions.map((session) => (
            <li key={session.id} className="row">
              <div className="row-main">
                <span className="row-title">
                  {deviceName(session.userAgent)}
                  {session.current && <span className="badge">to urządzenie</span>}
                </span>
                <span className="muted small">
                  Ostatnio {when(session.lastUsedAt)}
                  {session.ip && session.ip !== "unknown" ? ` · IP ${session.ip}` : ""} · od {when(session.createdAt)}
                </span>
              </div>
              {!session.current && (
                <button type="button" className="button ghost" onClick={() => act(() => api.endSession(session.id))}>
                  Wyloguj
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {sessions && sessions.length > 1 && (
        <button type="button" className="button ghost danger" onClick={() => act(() => api.endOtherSessions())}>
          Wyloguj wszystkie inne urządzenia
        </button>
      )}
    </div>
  );
};

const McpTokens = ({ api, onError }: PartProps) => {
  const [tokens, setTokens] = useState<McpToken[] | null>(null);
  const [name, setName] = useState("");
  const [days, setDays] = useState(90);
  const [created, setCreated] = useState<string | null>(null);
  const reload = useCallback(() => api.listMcpTokens().then(setTokens).catch(onError), [api, onError]);
  useEffect(() => void reload(), [reload]);

  const create = (event: FormEvent) => {
    event.preventDefault();
    void api
      .createMcpToken(name.trim(), days)
      .then(({ token }) => {
        setCreated(token);
        setName("");
        return reload();
      })
      .catch(onError);
  };

  return (
    <div className="card stack account-card">
      <h2>Tokeny MCP</h2>
      <p className="muted">
        Dla asystentów AI (np. Claude) podłączonych do Brygadzisty przez MCP. Token działa tylko w firmie, w której go
        utworzysz, i można go w każdej chwili odwołać.
      </p>
      {created && (
        <div className="stack">
          <p>Skopiuj token teraz. Więcej go nie zobaczysz.</p>
          <pre className="recovery-codes">{created}</pre>
          <button type="button" className="button ghost" onClick={() => void navigator.clipboard?.writeText(created)}>
            Kopiuj
          </button>
        </div>
      )}
      <form className="create-form" onSubmit={create}>
        <label className="field grow">
          <span>Nazwa</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="np. Claude na laptopie" />
        </label>
        <label className="field">
          <span>Ważny</span>
          <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
            {TOKEN_DAYS.map((value) => (
              <option key={value} value={value}>
                {value} dni
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="button primary" disabled={!name.trim()}>
          Utwórz token
        </button>
      </form>
      {tokens && tokens.length > 0 && (
        <ul className="list">
          {tokens.map((token) => (
            <li key={token.id} className="row">
              <div className="row-main">
                <span className="row-title">{token.name}</span>
                <span className="muted small">
                  {token.tenantName ?? ""} · użyty {when(token.lastUsedAt)} · ważny do {when(token.expiresAt)}
                </span>
              </div>
              <button
                type="button"
                className="button ghost danger"
                onClick={() => void api.revokeMcpToken(token.id).then(reload).catch(onError)}
              >
                Odwołaj
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const Password = ({ api, onError, onUnauthorized }: PartProps & { onUnauthorized: () => void }) => {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [done, setDone] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void api
      .changePassword(current, next)
      .then(() => {
        setCurrent("");
        setNext("");
        setDone(true);
      })
      .catch((cause) => (cause instanceof ApiError && cause.status === 401 ? onUnauthorized() : onError(cause)));
  };

  return (
    <form className="card stack account-card" onSubmit={submit}>
      <h2>Zmiana hasła</h2>
      <p className="muted">Po zmianie pozostałe urządzenia zostaną wylogowane.</p>
      <label className="field">
        <span>Obecne hasło</span>
        <input type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
      </label>
      <label className="field">
        <span>Nowe hasło (co najmniej 10 znaków)</span>
        <input type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} />
      </label>
      {done && <p className="muted">Hasło zmienione.</p>}
      <button type="submit" className="button primary" disabled={!current || next.length < 10}>
        Zmień hasło
      </button>
    </form>
  );
};
