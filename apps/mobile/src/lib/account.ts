import { ApiError } from "./api";
import { request } from "./http";
import type { Connection } from "./settings";

// Logging in with an account (#91): the session works in one firm at a time, and the account may belong to several.
export type TenantRole = "owner" | "manager" | "worker";
export type Tenant = { id: string; name: string; role: TenantRole };
export type AccountUser = { id: string; email: string; name: string };
export type Account = { user: AccountUser; tenant: Tenant | null; tenants: Tenant[] };
export type LoginResult = Account & { token: string };

export const TENANT_ROLE_LABELS: Record<TenantRole, string> = { owner: "właściciel", manager: "kierownik", worker: "pracownik" };

const TIMEOUT_MS = 15_000;

export const login = async (serverUrl: string, email: string, password: string): Promise<LoginResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${serverUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password }),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError("Nie udało się połączyć z serwerem. Sprawdź zasięg i adres.");
  } finally {
    clearTimeout(timer);
  }
  const body = (await response.json().catch(() => null)) as (LoginResult & { error?: string }) | null;
  if (response.status === 404) throw new ApiError("Pod tym adresem nie ma serwera Brygadzisty.", 404);
  if (!response.ok || !body?.token) throw new ApiError(body?.error ?? `Serwer odpowiedział błędem ${response.status}.`, response.status);
  return { token: body.token, user: body.user, tenant: body.tenant, tenants: body.tenants };
};

const accountOf = ({ user, tenant, tenants }: Account): Account => ({ user, tenant, tenants });

export const fetchAccount = async (connection: Connection) => accountOf(await request<Account>(connection, "/api/auth/me"));

// The session itself moves to the other firm; the token stays the same.
export const switchTenant = async (connection: Connection, tenantId: string) =>
  accountOf(
    await request<Account>(connection, "/api/auth/tenant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId }),
    }),
  );

export const logout = (connection: Connection) => request<void>(connection, "/api/auth/logout", { method: "POST" });
