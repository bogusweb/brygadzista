import postgres from "postgres";
import { extractCodes } from "./codes.js";
import { config } from "./config.js";

export const sql = postgres(config.databaseUrl, { max: 10, onnotice: () => {} });

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
      embedding vector(${sql.unsafe(String(config.embeddingDimensions))}) not null
    )`;
  // Progress of the current indexing run (#9): pages queued for it, pages finished, and when it started.
  await sql`alter table documents add column if not exists started_at timestamptz`;
  await sql`alter table documents add column if not exists run_total int not null default 0`;
  await sql`alter table documents add column if not exists run_done int not null default 0`;
  // A page that keeps failing is recorded and skipped instead of stopping the whole document.
  await sql`alter table pages add column if not exists error text`;
  await sql`alter table pages add column if not exists attempts int not null default 0`;
  // User accounts (#10): owners see every project, contractors only the ones they are members of.
  await sql`
    create table if not exists users (
      id uuid primary key default gen_random_uuid(),
      email text not null unique,
      name text not null default '',
      password_hash text not null,
      role text not null check (role in ('owner', 'contractor')),
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
  await sql`create index if not exists sessions_user on sessions (user_id)`;
  await sql`create index if not exists project_members_user on project_members (user_id)`;
  await sql`create index if not exists chunks_embedding on chunks using hnsw (embedding vector_cosine_ops)`;
  await sql`create index if not exists chunks_project on chunks (project_id)`;
  await sql`create index if not exists pages_fts on pages using gin (to_tsvector('simple', search_text))`;
  await sql`create index if not exists pages_trgm on pages using gin (search_text gin_trgm_ops)`;
  await sql`create index if not exists pages_codes on pages using gin (codes)`;
  await backfillCodes();
};

const BACKFILL_BATCH = 200;

// Pages indexed before codes existed get them from their stored text, without reindexing the document.
const backfillCodes = async () => {
  for (;;) {
    const pages = await sql<{ id: string; title: string | null; raw_text: string }[]>`
      select id, title, raw_text from pages where codes is null and search_text <> '' limit ${BACKFILL_BATCH}`;
    if (pages.length === 0) return;
    for (const page of pages) {
      await sql`update pages set codes = ${extractCodes(`${page.title ?? ""}\n${page.raw_text}`)} where id = ${page.id}`;
    }
  }
};
