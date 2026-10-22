import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, type Api, type FirmSummary, type Invite, type Me, type Member, type Project, type TenantRole } from "./api";
import { dateFormat, errorMessage, pluralize } from "./format";
import { ROLE_HINTS, ROLE_LABELS } from "./roles";
import { routeHref } from "./route";

type Props = {
  api: Api;
  me: Me;
  tenantId: string | null;
  // Every firm, for an operator outside any firm; null for everyone else.
  firms: FirmSummary[] | null;
  onFirmsChanged: () => Promise<void>;
  onPickFirm: (tenantId: string) => void;
  onRenamed: (name: string) => void;
  onUnauthorized: () => void;
};

const ROLES: TenantRole[] = ["owner", "manager", "worker"];
const INVITE_DAYS = [1, 3, 7, 14, 30];

const inviteLink = (token: string) =>
  `${window.location.origin}${window.location.pathname}${routeHref({ screen: "invite", token })}`;

export const FirmScreen = ({ api, me, tenantId, firms, onFirmsChanged, onPickFirm, onRenamed, onUnauthorized }: Props) => {
  if (!tenantId) return <FirmList api={api} firms={firms ?? []} onFirmsChanged={onFirmsChanged} onPickFirm={onPickFirm} />;
  if (!me.operator && me.tenant?.role !== "owner") {
    return (
      <div className="card empty">
        <h2>Ludźmi zarządza właściciel firmy</h2>
        <p className="muted">Jako kierownik prowadzisz budowy. Zaproszenia i role ustawia właściciel.</p>
      </div>
    );
  }
  const firmName = me.tenant?.name ?? firms?.find((firm) => firm.id === tenantId)?.name ?? "";
  return <Firm api={api} me={me} tenantId={tenantId} firmName={firmName} onRenamed={onRenamed} onUnauthorized={onUnauthorized} />;
};

type FirmListProps = { api: Api; firms: FirmSummary[]; onFirmsChanged: () => Promise<void>; onPickFirm: (tenantId: string) => void };

// An operator outside any firm first picks one, or opens a new firm and invites its owner.
const FirmList = ({ api, firms, onFirmsChanged, onPickFirm }: FirmListProps) => {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const firm = await api.createFirm(name.trim());
      setName("");
      await onFirmsChanged();
      onPickFirm(firm.id);
      window.location.hash = routeHref({ screen: "firm" });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack">
      <div className="section-head">
        <h1>Firmy</h1>
        <p className="muted">Wybierz firmę, żeby zobaczyć jej ludzi i zaproszenia.</p>
      </div>
      <form className="card create-form" onSubmit={create}>
        <label className="field grow">
          <span>Nowa firma</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="np. Budmax Jan Kowalski" />
        </label>
        <button type="submit" className="button primary" disabled={busy || !name.trim()}>
          {busy ? "Zakładam…" : "Załóż firmę"}
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="list">
        {firms.map((firm) => (
          <li key={firm.id} className="card row">
            <div className="row-main">
              <span className="row-title">{firm.name}</span>
              <span className="muted small">
                {pluralize(firm.memberCount, "osoba", "osoby", "osób")} · {pluralize(firm.projectCount, "budowa", "budowy", "budów")}
                {firm.disabled && " · zablokowana"}
              </span>
            </div>
            <button
              type="button"
              className="button ghost"
              onClick={() => {
                onPickFirm(firm.id);
                window.location.hash = routeHref({ screen: "firm" });
              }}
            >
              Otwórz firmę
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
};

type FirmProps = { api: Api; me: Me; tenantId: string; firmName: string; onRenamed: (name: string) => void; onUnauthorized: () => void };

const Firm = ({ api, me, tenantId, firmName, onRenamed, onUnauthorized }: FirmProps) => {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleError = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) return onUnauthorized();
      setError(errorMessage(cause));
    },
    [onUnauthorized],
  );

  const reload = useCallback(async () => {
    try {
      const [nextMembers, nextInvites, allProjects] = await Promise.all([api.listMembers(), api.listInvites(), api.listProjects()]);
      setMembers(nextMembers);
      setInvites(nextInvites);
      setProjects(allProjects.filter((project) => project.tenantId === tenantId));
      setError(null);
    } catch (cause) {
      handleError(cause);
    }
  }, [api, handleError, tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const replaceMember = (next: Member) => setMembers((current) => current?.map((member) => (member.id === next.id ? next : member)) ?? null);

  return (
    <section className="stack">
      <FirmName api={api} name={firmName} onRenamed={onRenamed} onError={handleError} />
      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button type="button" className="link" onClick={() => void reload()}>
            Odśwież
          </button>
        </p>
      )}
      <People
        api={api}
        me={me}
        members={members}
        projects={projects}
        onChanged={replaceMember}
        onRemoved={(id) => setMembers((current) => current?.filter((member) => member.id !== id) ?? null)}
        onError={handleError}
      />
      <Invites api={api} invites={invites} projects={projects} onChanged={reload} onError={handleError} />
    </section>
  );
};

type FirmNameProps = { api: Api; name: string; onRenamed: (name: string) => void; onError: (cause: unknown) => void };

const FirmName = ({ api, name, onRenamed, onError }: FirmNameProps) => {
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(name), [name]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || draft.trim() === name) return;
    setBusy(true);
    try {
      const firm = await api.renameFirm(draft.trim());
      onRenamed(firm.name);
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="section-head">
        <h1>{name || "Firma"}</h1>
        <p className="muted">Ludzie, role i zaproszenia. Każda osoba widzi tylko dane tej firmy.</p>
      </div>
      <form className="card create-form" onSubmit={save}>
        <label className="field grow">
          <span>Nazwa firmy</span>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} />
        </label>
        <button type="submit" className="button ghost" disabled={busy || !draft.trim() || draft.trim() === name}>
          {busy ? "Zapisuję…" : "Zapisz nazwę"}
        </button>
      </form>
    </>
  );
};

type PeopleProps = {
  api: Api;
  me: Me;
  members: Member[] | null;
  projects: Project[];
  onChanged: (member: Member) => void;
  onRemoved: (id: string) => void;
  onError: (cause: unknown) => void;
};

const People = ({ api, me, members, projects, onChanged, onRemoved, onError }: PeopleProps) => {
  const [pending, setPending] = useState<string | null>(null);

  const run = async (member: Member, action: () => Promise<void>) => {
    setPending(member.id);
    try {
      await action();
    } catch (cause) {
      onError(cause);
    } finally {
      setPending(null);
    }
  };

  const changeRole = (member: Member, role: TenantRole) =>
    run(member, async () => onChanged(await api.updateMember(member.id, { role })));

  const toggleBlocked = (member: Member) => {
    if (!member.blocked && !window.confirm(`Zablokować ${member.name || member.email}? Straci dostęp do danych firmy od razu.`)) return;
    return run(member, async () => onChanged(await api.updateMember(member.id, { blocked: !member.blocked })));
  };

  const remove = (member: Member) => {
    if (!window.confirm(`Usunąć ${member.name || member.email} z firmy? Zniknie też z jej budów.`)) return;
    return run(member, async () => {
      await api.removeMember(member.id);
      onRemoved(member.id);
    });
  };

  const toggleProject = (member: Member, projectId: string, assigned: boolean) =>
    run(member, async () => {
      if (assigned) await api.removeFromProject(projectId, member.id);
      else await api.addToProject(projectId, member.id);
      const projectIds = assigned ? member.projectIds.filter((id) => id !== projectId) : [...member.projectIds, projectId];
      onChanged({ ...member, projectIds });
    });

  return (
    <div className="card stack">
      <h2>Ludzie</h2>
      {members === null ? (
        <div className="skeleton" aria-busy="true" />
      ) : members.length === 0 ? (
        <p className="muted">W firmie nie ma jeszcze nikogo. Zaproś pierwszą osobę poniżej.</p>
      ) : (
        <ul className="list people">
          {members.map((member) => {
            const self = member.id === me.user?.id;
            const busy = pending === member.id;
            return (
              <li key={member.id} className="person">
                <div className="row">
                  <div className="row-main">
                    <span className="row-title">
                      {member.name || member.email}
                      {self && <span className="muted small"> (Ty)</span>}
                    </span>
                    <span className="muted small">
                      {member.email}
                      {member.blocked && <span className="danger-text"> · zablokowany w firmie</span>}
                      {member.disabled && <span className="danger-text"> · konto wyłączone</span>}
                    </span>
                  </div>
                  <div className="actions">
                    <label className="select-field">
                      <span className="visually-hidden">Rola</span>
                      <select
                        value={member.role}
                        disabled={busy || self}
                        onChange={(event) => void changeRole(member, event.target.value as TenantRole)}
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                    </label>
                    {!self && (
                      <>
                        <button type="button" className="button ghost" disabled={busy} onClick={() => void toggleBlocked(member)}>
                          {member.blocked ? "Odblokuj" : "Zablokuj"}
                        </button>
                        <button type="button" className="button danger" disabled={busy} onClick={() => void remove(member)}>
                          Usuń z firmy
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {member.role === "worker" ? (
                  <details className="person-projects">
                    <summary className="small">
                      Budowy: {member.projectIds.length === 0 ? "żadna" : pluralize(member.projectIds.length, "budowa", "budowy", "budów")}
                    </summary>
                    {projects.length === 0 ? (
                      <p className="muted small">Firma nie ma jeszcze budów.</p>
                    ) : (
                      <ProjectChecklist
                        projects={projects}
                        selected={member.projectIds}
                        disabled={busy}
                        onToggle={(projectId, assigned) => void toggleProject(member, projectId, assigned)}
                      />
                    )}
                  </details>
                ) : (
                  <p className="muted small">{ROLE_HINTS[member.role]}.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

type ProjectChecklistProps = {
  projects: Project[];
  selected: string[];
  disabled?: boolean;
  onToggle: (projectId: string, assigned: boolean) => void;
};

const ProjectChecklist = ({ projects, selected, disabled, onToggle }: ProjectChecklistProps) => (
  <ul className="checks">
    {projects.map((project) => {
      const assigned = selected.includes(project.id);
      return (
        <li key={project.id}>
          <label className="check">
            <input type="checkbox" checked={assigned} disabled={disabled} onChange={() => onToggle(project.id, assigned)} />
            <span>{project.name}</span>
          </label>
        </li>
      );
    })}
  </ul>
);

type InvitesProps = { api: Api; invites: Invite[]; projects: Project[]; onChanged: () => Promise<void>; onError: (cause: unknown) => void };

const inviteStatus = (invite: Invite) => {
  if (invite.acceptedAt) {
    return `przyjęte ${dateFormat.format(new Date(invite.acceptedAt))} przez ${invite.acceptedByName || invite.acceptedByEmail || "usunięte konto"}`;
  }
  if (new Date(invite.expiresAt) <= new Date()) return "wygasło";
  return `czeka, ważne do ${dateFormat.format(new Date(invite.expiresAt))}`;
};

const Invites = ({ api, invites, projects, onChanged, onError }: InvitesProps) => {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TenantRole>("worker");
  const [days, setDays] = useState(7);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setCopied(false);
    try {
      const invite = await api.createInvite({
        role,
        email: email.trim() || undefined,
        days,
        projectIds: role === "worker" ? projectIds : [],
      });
      setLink(inviteLink(invite.token));
      setEmail("");
      setProjectIds([]);
      await onChanged();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard blocked: the link stays selected in the field for a manual copy.
    }
  };

  const revoke = async (invite: Invite) => {
    setRevoking(invite.id);
    try {
      await api.revokeInvite(invite.id);
      await onChanged();
    } catch (cause) {
      onError(cause);
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="card stack">
      <div className="section-head">
        <h2>Zaproszenia</h2>
        <p className="muted small">
          Zaproszenie to jednorazowy link z terminem ważności. Wyślij go SMS-em albo komunikatorem. Nowa osoba trafia tylko do tej firmy.
        </p>
      </div>
      <form className="stack" onSubmit={create}>
        <div className="invite-fields">
          <label className="field grow">
            <span>E-mail (opcjonalnie)</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-describedby="invite-email-hint"
            />
            <span id="invite-email-hint" className="muted small">
              Z e-mailem link zadziała tylko dla tego adresu.
            </span>
          </label>
          <label className="field">
            <span>Rola</span>
            <select value={role} onChange={(event) => setRole(event.target.value as TenantRole)}>
              {ROLES.map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Ważne przez</span>
            <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              {INVITE_DAYS.map((option) => (
                <option key={option} value={option}>
                  {pluralize(option, "dzień", "dni", "dni")}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted small">{ROLE_HINTS[role]}.</p>
        {role === "worker" && projects.length > 0 && (
          <fieldset className="fieldset">
            <legend className="small">Budowy, do których od razu trafi</legend>
            <ProjectChecklist
              projects={projects}
              selected={projectIds}
              onToggle={(projectId, assigned) =>
                setProjectIds((current) => (assigned ? current.filter((id) => id !== projectId) : [...current, projectId]))
              }
            />
          </fieldset>
        )}
        <div>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? "Tworzę link…" : "Utwórz link zaproszenia"}
          </button>
        </div>
      </form>

      {link && (
        <div className="invite-link" role="status">
          <label className="field grow">
            <span>Link zaproszenia. Skopiuj go teraz, później nie da się go pokazać ponownie.</span>
            <input readOnly value={link} onFocus={(event) => event.target.select()} />
          </label>
          <button type="button" className="button ghost" onClick={() => void copy()}>
            {copied ? "Skopiowano" : "Kopiuj link"}
          </button>
        </div>
      )}

      {invites.length > 0 && (
        <ul className="list">
          {invites.map((invite) => {
            const open = !invite.acceptedAt && new Date(invite.expiresAt) > new Date();
            return (
              <li key={invite.id} className="row invite-row">
                <div className="row-main">
                  <span>
                    {invite.email ?? "Dowolna osoba z linkiem"} · {ROLE_LABELS[invite.role].toLowerCase()}
                  </span>
                  <span className="muted small">{inviteStatus(invite)}</span>
                </div>
                {open && (
                  <button type="button" className="button danger" disabled={revoking === invite.id} onClick={() => void revoke(invite)}>
                    {revoking === invite.id ? "Odwołuję…" : "Odwołaj"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
