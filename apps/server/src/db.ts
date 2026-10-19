import postgres from "postgres";
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
  await sql`create index if not exists chunks_embedding on chunks using hnsw (embedding vector_cosine_ops)`;
  await sql`create index if not exists chunks_project on chunks (project_id)`;
  await sql`create index if not exists pages_fts on pages using gin (to_tsvector('simple', search_text))`;
  await sql`create index if not exists pages_trgm on pages using gin (search_text gin_trgm_ops)`;
};
