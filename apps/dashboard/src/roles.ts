import type { Tenant, TenantRole } from "./api";

export const ROLE_LABELS: Record<TenantRole, string> = { owner: "Właściciel", manager: "Kierownik", worker: "Pracownik" };

export const ROLE_HINTS: Record<TenantRole, string> = {
  owner: "Wszystkie budowy firmy i zarządzanie ludźmi",
  manager: "Wszystkie budowy firmy, bez zarządzania ludźmi",
  worker: "Tylko przypisane budowy, w aplikacji na telefonie",
};

// The panel is for owners and managers; workers use the phone app.
export const panelFirms = (tenants: Tenant[]) => tenants.filter((tenant) => tenant.role !== "worker");
