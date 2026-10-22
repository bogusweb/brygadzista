import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { CODES_VERSION, extractCodes } from "./codes.js";
import { config } from "./config.js";
import { configuredEmbedding, embeddingSetId } from "./embedding-model.js";
import { FACTS_VERSION, extractFacts, formatFact } from "./facts.js";
import { META_VERSION, displayTitle, extractPageMeta, titleFromText } from "./page-meta.js";

const rootSql = postgres(config.databaseUrl, { max: 10, onnotice: () => {} });

// Row Level Security (#92): a request for a project runs in a transaction as TENANT_ROLE with app.tenant_id set to the
// project's firm, and policies on every data table let that role see only rows of that firm. `sql` below routes each
// query into that transaction while the request runs, so the code reads the same as without it.
const TENANT_ROLE = "brygadzista_tenant";
type Scope = { tx: postgres.TransactionSql; tenantId: string; done: boolean; afterCommit: (() => unknown)[] };
const scope = new AsyncLocalStorage<Scope>();
let rowLevelSecurity = false;

const activeScope = () => {
  const current = scope.getStore();
  return current && !current.done ? current : null;
};

export const sql = new Proxy(rootSql, {
  apply: (_target, _this, args: unknown[]) => (activeScope()?.tx ?? rootSql)(...(args as Parameters<typeof rootSql>)),
  get: (_target, property) => {
    const current = activeScope();
    // Inside the request's transaction a nested transaction is a savepoint.
    if (current && property === "begin") return (fn: (tx: postgres.TransactionSql) => unknown) => current.tx.savepoint(fn);
    const target = (current && property in current.tx ? current.tx : rootSql) as unknown as Record<string | symbol, unknown>;
    const value = target[property];
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as typeof rootSql;

// Runs fn in a transaction limited to one firm. Nested calls for the same firm reuse the transaction.
export const withTenant = async <T>(tenantId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> => {
  const current = activeScope();
  if (current?.tenantId === tenantId) return fn(current.tx);
  const afterCommit: (() => unknown)[] = [];
  const result = (await rootSql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    if (rowLevelSecurity) await tx.unsafe(`set local role ${TENANT_ROLE}`);
    const store: Scope = { tx, tenantId, done: false, afterCommit };
    try {
      return await scope.run(store, () => fn(tx));
    } finally {
      store.done = true;
    }
  })) as T;
  afterCommit.forEach(detached);
  return result;
};

// Work started from a request that outlives it (indexing a diary note, filling a checklist) leaves the request's
// transaction and runs on the pool.
// It starts once the transaction has committed, so it sees what the request wrote.
export const detached = (fn: () => unknown) => {
  const current = activeScope();
  if (current) current.afterCommit.push(fn);
  else void scope.exit(fn);
};

export const migrate = async () => {
  await sql`create extension if not exists pg_trgm`;
  await sql`create extension if not exists vector`;
  await sql`
    create table if not exists projects (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      created_at timestamptz not null default now()
    )`;
  await sql`
    create table if not exists documents (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects(id) on delete cascade,
      filename text not null,
      page_count int not null default 0,
      indexed_pages int not null default 0,
      status text not null default 'queued',
      error text,
      outline jsonb,
      created_at timestamptz not null default now()
    )`;
  await sql`
    create table if not exists pages (
      id uuid primary key default gen_random_uuid(),
      document_id uuid not null references documents(id) on delete cascade,
      project_id uuid not null references projects(id) on delete cascade,
      page_no int not null,
      kind text,
      title text,
      raw_text text not null default '',
      summary text,
      facts jsonb not null default '[]',
      keywords text[] not null default '{}',
      indexed boolean not null default false,
      search_text text not null default '',
      unique (document_id, page_no)
    )`;
  await sql`
    create table if not exists chunks (
      id bigserial primary key,
      page_id uuid not null references pages(id) on delete cascade,
      project_id uuid not null references projects(id) on delete cascade,
      content text not null,
      embedding vector not null
    )`;
  // Progress of the current indexing run (#9): pages queued for it, pages finished, and when it started.
  await sql`alter table documents add column if not exists started_at timestamptz`;
  await sql`alter table documents add column if not exists run_total int not null default 0`;
  await sql`alter table documents add column if not exists run_done int not null default 0`;
  // A page that keeps failing is recorded and skipped instead of stopping the whole document.
  await sql`alter table pages add column if not exists error text`;
  await sql`alter table pages add column if not exists attempts int not null default 0`;
  // User accounts (#10). Roles in a firm live in tenant_members (#88); the global role is only operator or user.
  await sql`
    create table if not exists users (
      id uuid primary key default gen_random_uuid(),
      email text not null unique,
      name text not null default '',
      password_hash text not null,
      role text not null default 'user',
      disabled_at timestamptz,
      created_at timestamptz not null default now()
    )`;
  // Only a hash of the session token is stored, so a database leak does not hand out working sessions.
  await sql`
    create table if not exists sessions (
      token_hash text primary key,
      user_id uuid not null references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      last_used_at timestamptz not null default now(),
      expires_at timestamptz not null
    )`;
  await sql`
    create table if not exists project_members (
      project_id uuid not null references projects(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (project_id, user_id)
    )`;
  // Exact codes and symbols of each page (#50); null = not extracted yet, filled in by backfillCodes.
  await sql`alter table pages add column if not exists codes text[]`;
  // Pins on a page of the project (#70): a point in page-relative coordinates (0..1) with a note and photos.
  // Ids come from the phone, so a sync retried after a dropped connection never creates a pin twice.
  // `kind` leaves room for defects (#74), which are pins with a status and a person on top.
  await sql`
    create table if not exists pins (
      id uuid primary key,
      project_id uuid not null references projects(id) on delete cascade,
      document_id uuid not null references documents(id) on delete cascade,
      page_no int not null check (page_no >= 1),
      x real not null check (x >= 0 and x <= 1),
      y real not null check (y >= 0 and y <= 1),
      kind text not null default 'photo',
      note text not null default '',
      room text not null default '',
      created_by uuid references users(id) on delete set null,
      author_name text not null default '',
      created_at timestamptz not null,
      updated_at timestamptz not null
    )`;
  await sql`
    create table if not exists pin_photos (
      id uuid primary key,
      pin_id uuid not null references pins(id) on delete cascade,
      project_id uuid not null references projects(id) on delete cascade,
      width int not null,
      height int not null,
      bytes int not null,
      taken_at timestamptz not null,
      created_at timestamptz not null default now()
    )`;
  await sql`create index if not exists pins_page on pins (project_id, document_id, page_no)`;
  await sql`create index if not exists pin_photos_pin on pin_photos (pin_id)`;
  // Defects (#74) are pins of kind 'defect' with a status, a person and a deadline. `spec` is what the project says about
  // the spot, written by the server from the note (never sent by the phone), and `spec_note` the note it was written for.
  await sql`alter table pins add column if not exists status text check (status in ('open', 'to_check', 'closed'))`;
  await sql`alter table pins add column if not exists assignee text not null default ''`;
  await sql`alter table pins add column if not exists due_date date`;
  await sql`alter table pins add column if not exists spec jsonb`;
  await sql`alter table pins add column if not exists spec_note text`;
  // Photos of a defect from before and after the fix; photo pins only use 'before'.
  await sql`alter table pin_photos add column if not exists stage text not null default 'before' check (stage in ('before', 'after'))`;
  // Daily site log (#69). client_id makes an upload from the phone's offline queue safe to repeat.
  await sql`
    create table if not exists diary_entries (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects(id) on delete cascade,
      client_id text,
      entry_date date not null,
      source text not null check (source in ('audio', 'text')),
      audio_file text,
      audio_type text,
      transcript text not null default '',
      entry jsonb,
      status text not null default 'queued',
      error text,
      edited boolean not null default false,
      author_id uuid references users(id) on delete set null,
      author_name text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (project_id, client_id)
    )`;
  await sql`create index if not exists diary_entries_project on diary_entries (project_id, entry_date desc)`;
  // Stage checklists (#68): items filled from the project, ticked on site (also offline) and synced later.
  await sql`
    create table if not exists checklists (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects(id) on delete cascade,
      stage text not null,
      title text not null,
      status text not null default 'generating',
      error text,
      created_by uuid references users(id) on delete set null,
      created_by_name text not null default '',
      created_at timestamptz not null default now(),
      generated_at timestamptz
    )`;
  await sql`
    create table if not exists checklist_items (
      id uuid primary key default gen_random_uuid(),
      checklist_id uuid not null references checklists(id) on delete cascade,
      position int not null,
      label text not null,
      ask text not null,
      value text,
      status text not null default 'to_confirm' check (status in ('found', 'to_confirm')),
      document_id uuid references documents(id) on delete set null,
      page_no int,
      quote text,
      checked boolean not null default false,
      note text,
      checked_at timestamptz,
      checked_by uuid references users(id) on delete set null,
      checked_by_name text,
      unique (checklist_id, position)
    )`;
  // Every change sent from the app, keyed by an id the app generates, so a batch resent after a lost response
  // is applied once.
  await sql`
    create table if not exists checklist_events (
      id uuid primary key,
      checklist_id uuid not null references checklists(id) on delete cascade,
      item_id uuid references checklist_items(id) on delete cascade,
      type text not null check (type in ('check', 'complete')),
      checked boolean,
      note text,
      happened_at timestamptz not null,
      user_id uuid references users(id) on delete set null,
      user_name text not null,
      received_at timestamptz not null default now()
    )`;
  // A finished checklist: who closed it, when, and the state of every item at that moment.
  await sql`
    create table if not exists checklist_results (
      id uuid primary key,
      checklist_id uuid not null references checklists(id) on delete cascade,
      completed_at timestamptz not null,
      completed_by uuid references users(id) on delete set null,
      completed_by_name text not null,
      items jsonb not null
    )`;
  await sql`create index if not exists checklists_project on checklists (project_id)`;
  await sql`create index if not exists checklist_items_checklist on checklist_items (checklist_id)`;
  await sql`alter table pages add column if not exists codes_version int`;
  // Parameters read from the page text by rules (#53): a value with its unit and the words naming it.
  await sql`
    create table if not exists facts (
      id bigserial primary key,
      page_id uuid not null references pages(id) on delete cascade,
      project_id uuid not null references projects(id) on delete cascade,
      label text not null,
      value text not null,
      unit text not null default '',
      quote text not null default ''
    )`;
  await sql`create index if not exists facts_page on facts (page_id)`;
  await sql`create index if not exists facts_project on facts (project_id)`;
  await sql`create index if not exists facts_label on facts using gin (to_tsvector('simple', label))`;
  await sql`alter table pages add column if not exists facts_version int`;
  // Page metadata from the PDF text (#55): the drawing's title block, trade and storey; null = not extracted yet.
  await sql`alter table pages add column if not exists drawing_no text`;
  await sql`alter table pages add column if not exists scale text`;
  await sql`alter table pages add column if not exists revision text`;
  await sql`alter table pages add column if not exists branch text`;
  await sql`alter table pages add column if not exists level text`;
  await sql`alter table pages add column if not exists meta_version int`;
  // Cards of a room or a partition (#71): values from the project with their pages, one card per place.
  await sql`
    create table if not exists element_cards (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects(id) on delete cascade,
      kind text not null check (kind in ('room', 'partition')),
      name text not null,
      status text not null default 'generating',
      error text,
      fields jsonb not null default '[]',
      layers jsonb not null default '[]',
      created_by uuid references users(id) on delete set null,
      created_by_name text not null default '',
      created_at timestamptz not null default now(),
      generated_at timestamptz
    )`;
  await sql`create unique index if not exists element_cards_name on element_cards (project_id, kind, lower(name))`;
  await sql`create index if not exists sessions_user on sessions (user_id)`;
  await sql`create index if not exists project_members_user on project_members (user_id)`;
  await sql`create index if not exists chunks_project on chunks (project_id)`;
  await sql`create index if not exists pages_fts on pages using gin (to_tsvector('simple', search_text))`;
  await sql`create index if not exists pages_trgm on pages using gin (search_text gin_trgm_ops)`;
  await sql`create index if not exists pages_codes on pages using gin (codes)`;
  await sql`create index if not exists pages_drawing_no on pages (project_id, drawing_no) where drawing_no is not null`;
  // Site location (#81): the address as typed and the point the weather is read for (from the address or set by hand).
  await sql`alter table projects add column if not exists site_address text`;
  await sql`alter table projects add column if not exists site_lat double precision`;
  await sql`alter table projects add column if not exists site_lon double precision`;
  // Kind of building (#85): sets the order of stage checklists and the agent's context. Validated in building-types.ts.
  await sql`alter table projects add column if not exists building_type text not null default 'dom_murowany'`;
  // Weather of each site day (#81), kept so a report does not ask again. `final` once the day is over and measured.
  await sql`
    create table if not exists site_weather (
      project_id uuid not null references projects(id) on delete cascade,
      day date not null,
      weather jsonb,
      final boolean not null default false,
      fetched_at timestamptz not null default now(),
      primary key (project_id, day)
    )`;
  // When a defect was closed (#84), for "closed this week"; a defect closed before this column existed counts from its last change.
  await sql`alter table pins add column if not exists closed_at timestamptz`;
  await sql`update pins set closed_at = updated_at where status = 'closed' and closed_at is null`;
  // Weekly reports for the investor (#84): the facts of the week frozen at the moment the report was made.
  await sql`
    create table if not exists reports (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects(id) on delete cascade,
      kind text not null default 'weekly' check (kind in ('weekly')),
      period_start date not null,
      period_end date not null,
      snapshot jsonb not null,
      summary jsonb not null,
      created_by uuid references users(id) on delete set null,
      created_by_name text not null default '',
      created_at timestamptz not null default now(),
      unique (project_id, kind, period_start)
    )`;
  // Questions to the designer (#73): a gap or a contradiction in the project, asked outside the app and answered here.
  await sql`
    create table if not exists designer_questions (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects(id) on delete cascade,
      document_id uuid references documents(id) on delete set null,
      page_no int check (page_no >= 1),
      region jsonb,
      question text not null,
      reason text not null default '',
      status text not null default 'open' check (status in ('open', 'answered')),
      answer text,
      answered_at timestamptz,
      created_by uuid references users(id) on delete set null,
      author_name text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`;
  await sql`create index if not exists designer_questions_project on designer_questions (project_id, created_at desc)`;
  await migrateTenants();
  await migrateEmbeddingSets();
  await backfillCodes();
  await backfillMeta();
  await backfillFacts();
  await enableRowLevelSecurity();
};

// Tables that hang off a project: their firm always comes from the project, through a composite key.
const PROJECT_TABLES = [
  "project_members",
  "documents",
  "pages",
  "chunks",
  "facts",
  "pins",
  "pin_photos",
  "diary_entries",
  "checklists",
  "site_weather",
  "designer_questions",
  "reports",
  "element_cards",
];
// Tables that hang off a checklist and take the firm from it.
const CHECKLIST_TABLES = ["checklist_items", "checklist_events", "checklist_results"];

export const STARTER_TENANT_NAME = "Brygadzista (Paweł)";

const addConstraint = async (table: string, name: string, definition: string) => {
  const [exists] = await sql`select 1 from pg_constraint where conname = ${name}`;
  if (!exists) await sql.unsafe(`alter table ${table} add constraint ${name} ${definition}`);
};

// Firms (#87): every project and every row of its data belongs to one firm. Data from before firms existed goes
// to a starter firm, owners become its owners and contractors its workers.
const migrateTenants = async () => {
  await sql`
    create table if not exists tenants (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      created_at timestamptz not null default now(),
      disabled_at timestamptz
    )`;
  await sql`
    create table if not exists tenant_members (
      tenant_id uuid not null references tenants(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      role text not null check (role in ('owner', 'manager', 'worker')),
      created_at timestamptz not null default now(),
      primary key (tenant_id, user_id)
    )`;
  await sql`create index if not exists tenant_members_user on tenant_members (user_id)`;
  // The firm a session is working in; a user can belong to several.
  await sql`alter table sessions add column if not exists tenant_id uuid references tenants(id) on delete cascade`;
  await sql`alter table projects add column if not exists tenant_id uuid references tenants(id) on delete cascade`;

  const [orphans] = await sql`
    select 1 where exists (select 1 from projects where tenant_id is null)
      or exists (select 1 from users u where u.role <> 'operator' and not exists (select 1 from tenant_members m where m.user_id = u.id))`;
  if (orphans) {
    const starterId = await starterTenantId();
    await sql`update projects set tenant_id = ${starterId} where tenant_id is null`;
    await sql`
      insert into tenant_members (tenant_id, user_id, role)
      select ${starterId}, u.id, case when u.role = 'contractor' then 'worker' else 'owner' end
      from users u where u.role <> 'operator' and not exists (select 1 from tenant_members m where m.user_id = u.id)`;
  }
  // Owners and contractors from before firms are plain users now; their role lives in the firm (#88).
  await sql`alter table users drop constraint if exists users_role_check`;
  await sql`update users set role = 'user' where role not in ('operator', 'user')`;
  await addConstraint("users", "users_global_role_check", "check (role in ('operator', 'user'))");
  await sql`alter table users alter column role set default 'user'`;
  await sql`alter table projects alter column tenant_id set not null`;
  await addConstraint("projects", "projects_id_tenant_key", "unique (id, tenant_id)");
  await sql`create index if not exists projects_tenant on projects (tenant_id)`;

  // A row written without a firm takes the firm of its project; a row with another firm's id is rejected by the key.
  await sql`
    create or replace function tenant_from_project() returns trigger language plpgsql as $$
    begin
      if new.tenant_id is null then
        select tenant_id into new.tenant_id from projects where id = new.project_id;
      end if;
      return new;
    end $$`;
  await sql`
    create or replace function tenant_from_checklist() returns trigger language plpgsql as $$
    begin
      if new.tenant_id is null then
        select tenant_id into new.tenant_id from checklists where id = new.checklist_id;
      end if;
      return new;
    end $$`;

  for (const table of PROJECT_TABLES) {
    await sql.unsafe(`alter table ${table} add column if not exists tenant_id uuid`);
    await sql.unsafe(`update ${table} t set tenant_id = p.tenant_id from projects p where p.id = t.project_id and t.tenant_id is null`);
    await sql.unsafe(`alter table ${table} alter column tenant_id set not null`);
    await sql.unsafe(`create or replace trigger ${table}_tenant before insert on ${table} for each row execute function tenant_from_project()`);
    await addConstraint(
      table,
      `${table}_project_tenant_fkey`,
      "foreign key (project_id, tenant_id) references projects (id, tenant_id) on delete cascade on update cascade",
    );
    await sql.unsafe(`create index if not exists ${table}_tenant on ${table} (tenant_id)`);
  }
  await addConstraint("checklists", "checklists_id_tenant_key", "unique (id, tenant_id)");
  for (const table of CHECKLIST_TABLES) {
    await sql.unsafe(`alter table ${table} add column if not exists tenant_id uuid`);
    await sql.unsafe(`update ${table} t set tenant_id = c.tenant_id from checklists c where c.id = t.checklist_id and t.tenant_id is null`);
    await sql.unsafe(`alter table ${table} alter column tenant_id set not null`);
    await sql.unsafe(`create or replace trigger ${table}_tenant before insert on ${table} for each row execute function tenant_from_checklist()`);
    await addConstraint(
      table,
      `${table}_checklist_tenant_fkey`,
      "foreign key (checklist_id, tenant_id) references checklists (id, tenant_id) on delete cascade on update cascade",
    );
  }
  // Read-only links (#88, used by #82 and #84): a token bound to one project and its firm, valid until it expires.
  await sql`
    create table if not exists share_links (
      token_hash text primary key,
      project_id uuid not null,
      tenant_id uuid not null,
      created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      foreign key (project_id, tenant_id) references projects (id, tenant_id) on delete cascade on update cascade
    )`;
  await sql`create or replace trigger share_links_tenant before insert on share_links for each row execute function tenant_from_project()`;
  // Chat threads with their owner (#92): the CopilotKit runtime keeps messages in memory, this keeps who may use them.
  await sql`
    create table if not exists chat_threads (
      id text primary key,
      project_id uuid not null,
      tenant_id uuid not null,
      owner text not null,
      user_id uuid references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      foreign key (project_id, tenant_id) references projects (id, tenant_id) on delete cascade on update cascade
    )`;
  // A link can open one thing only (#84 a weekly report, #82 a protocol); null target = the project's read-only view.
  await sql`alter table share_links add column if not exists target_type text`;
  await sql`alter table share_links add column if not exists target_id uuid`;
};

// Every table with a tenant_id gets a policy for TENANT_ROLE. The server's own role owns the tables and is not limited,
// so migrations, the operator and background work see everything. Without the right to create roles the server
// keeps running on the checks in code alone.
const enableRowLevelSecurity = async () => {
  try {
    await sql.unsafe(`
      do $$ begin
        if not exists (select from pg_roles where rolname = '${TENANT_ROLE}') then create role ${TENANT_ROLE} nologin; end if;
      end $$`);
    await sql.unsafe(`grant ${TENANT_ROLE} to current_user`).catch(() => {});
  } catch (error) {
    console.warn(`db: cannot create role ${TENANT_ROLE}, row level security is off`, error);
    rowLevelSecurity = false;
    return;
  }
  await sql.unsafe(`grant usage on schema public to ${TENANT_ROLE}`);
  await sql.unsafe(`grant select, insert, update, delete on all tables in schema public to ${TENANT_ROLE}`);
  await sql.unsafe(`grant usage, select on all sequences in schema public to ${TENANT_ROLE}`);
  const tables = await sql<{ table: string }[]>`
    select table_name as table from information_schema.columns
    where table_schema = 'public' and column_name = 'tenant_id' and table_name not in ('sessions', 'tenant_members')`;
  for (const { table } of tables) {
    await sql.unsafe(`alter table ${table} enable row level security`);
    await sql.unsafe(`drop policy if exists tenant_isolation on ${table}`);
    await sql.unsafe(`
      create policy tenant_isolation on ${table} to ${TENANT_ROLE}
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`);
  }
  rowLevelSecurity = true;
};

const starterTenantId = async () => {
  const [existing] = await sql<{ id: string }[]>`select id from tenants where name = ${STARTER_TENANT_NAME} order by created_at limit 1`;
  if (existing) return existing.id;
  const [created] = await sql<{ id: string }[]>`insert into tenants (name) values (${STARTER_TENANT_NAME}) returning id`;
  return created!.id;
};

// Where the operator's new projects go when no firm is named: the oldest firm.
export const defaultTenantId = async () => {
  const [oldest] = await sql<{ id: string }[]>`select id from tenants order by created_at limit 1`;
  return oldest?.id ?? starterTenantId();
};

const BACKFILL_BATCH = 200;

// Pages indexed before codes existed, or with an older extraction, get them from their stored text without reindexing.
const backfillCodes = async () => {
  for (;;) {
    const pages = await sql<{ id: string; title: string | null; raw_text: string }[]>`
      select id, title, raw_text from pages where codes_version is distinct from ${CODES_VERSION} and search_text <> '' limit ${BACKFILL_BATCH}`;
    if (pages.length === 0) return;
    for (const page of pages) {
      await sql`
        update pages set codes = ${extractCodes(`${page.title ?? ""}\n${page.raw_text}`)}, codes_version = ${CODES_VERSION}
        where id = ${page.id}`;
    }
  }
};

// Pages indexed before metadata existed, or with an older extraction, get it from their stored text without reindexing.
const backfillMeta = async () => {
  for (;;) {
    const pages = await sql<{ id: string; page_no: number; raw_text: string }[]>`
      select id, page_no, raw_text from pages where meta_version is distinct from ${META_VERSION} and search_text <> '' limit ${BACKFILL_BATCH}`;
    if (pages.length === 0) return;
    for (const page of pages) {
      const meta = extractPageMeta(page.raw_text, page.page_no);
      await sql`
        update pages set kind = ${meta.kind}, title = ${displayTitle(meta, titleFromText(page.raw_text))},
          drawing_no = ${meta.drawingNo}, scale = ${meta.scale}, revision = ${meta.revision}, branch = ${meta.branch},
          level = ${meta.level}, meta_version = ${META_VERSION}
        where id = ${page.id}`;
    }
  }
};

// Facts shown with a page on the dashboard; the facts table holds all of them.
const PAGE_FACTS_SHOWN = 40;

// Replaces the facts of one page with those read from its text (inside the caller's transaction).
export const replacePageFacts = async (q: postgres.TransactionSql, pageId: string, projectId: string, raw: string) => {
  const facts = extractFacts(raw);
  await q`delete from facts where page_id = ${pageId}`;
  if (facts.length) {
    await q`insert into facts ${q(facts.map((fact) => ({ page_id: pageId, project_id: projectId, ...fact })))}`;
  }
  const shown = facts.slice(0, PAGE_FACTS_SHOWN).map((fact) => ({ label: fact.label, value: formatFact(fact) }));
  await q`update pages set facts = ${q.json(shown)}, facts_version = ${FACTS_VERSION} where id = ${pageId}`;
};

// Pages indexed before facts existed, or with an older extraction, get them from their stored text without reindexing.
const backfillFacts = async () => {
  for (;;) {
    const pages = await sql<{ id: string; project_id: string; raw_text: string }[]>`
      select id, project_id, raw_text from pages
      where facts_version is distinct from ${FACTS_VERSION} and search_text <> '' limit ${BACKFILL_BATCH}`;
    if (pages.length === 0) return;
    for (const page of pages) await sql.begin((tx) => replacePageFacts(tx, page.id, page.project_id, page.raw_text));
  }
};

// Vectors of one embedding set, with the set's own vector size, get their own HNSW index; the column has no fixed size.
const embeddingIndexName = (setId: string) => `chunks_hnsw_${createHash("md5").update(setId).digest("hex").slice(0, 12)}`;

const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

export const createEmbeddingIndex = (set: { id: string; dimensions: number }) =>
  sql.unsafe(
    `create index if not exists ${embeddingIndexName(set.id)} on chunks using hnsw ((embedding::vector(${Math.trunc(set.dimensions)})) vector_cosine_ops) ` +
      `where embedding_set = ${quoteLiteral(set.id)}`,
  );

export const dropEmbeddingSet = async (setId: string) => {
  await sql`delete from chunks where embedding_set = ${setId}`;
  await sql.unsafe(`drop index if exists ${embeddingIndexName(setId)}`);
  await sql`update embedding_sets set status = 'retired' where id = ${setId} and status <> 'active'`;
};

// Embedding sets (#46): every vector is tagged with the model and size that made it. Search reads the active set; when
// the configured model differs, a new set is built in the background and replaces the active one once it is complete.
// Server-wide, not per firm: the model is a setting of the server.
const migrateEmbeddingSets = async () => {
  await sql`
    create table if not exists embedding_sets (
      id text primary key,
      model text not null,
      dimensions int not null,
      status text not null check (status in ('active', 'building', 'retired')),
      error text,
      retry_at timestamptz,
      created_at timestamptz not null default now(),
      activated_at timestamptz
    )`;
  await sql`create unique index if not exists embedding_sets_one_active on embedding_sets ((true)) where status = 'active'`;
  await sql`alter table chunks add column if not exists embedding_set text`;
  await sql`create index if not exists chunks_page_set on chunks (page_id, embedding_set)`;
  // Before sets the column had the size of the one model, and one index over all of it.
  const [column] = await sql<{ type: string }[]>`
    select format_type(atttypid, atttypmod) as type from pg_attribute where attrelid = 'chunks'::regclass and attname = 'embedding'`;
  if (column && column.type !== "vector") {
    await sql`drop index if exists chunks_embedding`;
    await sql`alter table chunks alter column embedding type vector`;
  }

  const wanted = { id: embeddingSetId(configuredEmbedding()), ...configuredEmbedding() };
  let [active] = await sql<{ id: string; dimensions: number }[]>`select id, dimensions from embedding_sets where status = 'active'`;
  if (!active) {
    // Vectors from before sets were made by the configured model.
    [active] = await sql<{ id: string; dimensions: number }[]>`
      insert into embedding_sets (id, model, dimensions, status, activated_at)
      values (${wanted.id}, ${wanted.model}, ${wanted.dimensions}, 'active', now())
      on conflict (id) do update set status = 'active', activated_at = now(), error = null
      returning id, dimensions`;
  }
  await sql`update chunks set embedding_set = ${active!.id} where embedding_set is null`;

  // A set left half built by an earlier configuration is dropped; the configured one is built if search is not on it.
  const stale = await sql<{ id: string }[]>`
    select id from embedding_sets where status = 'building' and (id <> ${wanted.id} or id = ${active!.id})`;
  for (const set of stale) await dropEmbeddingSet(set.id);
  if (wanted.id !== active!.id) {
    await sql`
      insert into embedding_sets (id, model, dimensions, status) values (${wanted.id}, ${wanted.model}, ${wanted.dimensions}, 'building')
      on conflict (id) do update set status = 'building', error = null, retry_at = null`;
    await createEmbeddingIndex(wanted);
  }
  await createEmbeddingIndex(active!);
};
