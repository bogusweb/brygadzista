import { useState, type FormEvent } from "react";
import { ApiError, createApi } from "./api";

type Props = { onSignIn: (token: string) => void };

export const LoginScreen = ({ onSignIn }: Props) => {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const candidate = token.trim();
    if (!candidate) return;
    setBusy(true);
    setError(null);
    try {
      const { role } = await createApi(candidate).whoami();
      if (role !== "admin") throw new ApiError("To token aplikacji, a panel wymaga tokenu administratora.", 403);
      onSignIn(candidate);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 401
          ? "Ten token nie pasuje. Sprawdź ADMIN_TOKEN na serwerze i spróbuj ponownie."
          : cause instanceof Error
            ? cause.message
            : "Nie udało się połączyć z serwerem. Spróbuj ponownie.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit}>
        <h1>Brygadzista</h1>
        <p className="muted">Panel operatora. Zaloguj się tokenem administratora.</p>
        <label className="field">
          <span>Token administratora</span>
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
          {busy ? "Sprawdzam…" : "Zaloguj się"}
        </button>
      </form>
    </main>
  );
};
