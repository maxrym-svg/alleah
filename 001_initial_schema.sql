-- Personal Knowledge Memory — initial schema
-- Migration 001 | Embeddings: voyage-4, 1024 dims, cosine
-- Run in the Supabase SQL editor (or via CLI migration).

create extension if not exists vector;

-- ============================================================
-- folders — one atomic idea per row
-- ============================================================
create table folders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) default auth.uid(),
  title       text not null,
  type        text not null check (type in ('concept','project','person','note')),
  body        text not null,                    -- the 3–5 sentence atomic idea
  embedding   vector(1024),                     -- voyage-4
  source      text,                             -- raw capture text this was drafted from
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ============================================================
-- links — defined now, populated in the auto-linking phase
-- ============================================================
create table links (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) default auth.uid(),
  source_id    uuid not null references folders(id) on delete cascade,
  target_id    uuid not null references folders(id) on delete cascade,
  relationship text not null,                   -- e.g. 'depends_on', 'analogy'
  weight       real not null default 1.0,
  origin       text not null check (origin in ('auto','user')),
  is_leap      boolean not null default false,  -- bold cross-domain analogy
  verified     boolean not null default true,   -- leaps start false until second pass
  confidence   real,
  rationale    text,
  created_at   timestamptz not null default now(),
  check (source_id <> target_id),
  unique (source_id, target_id, relationship)
);

-- ============================================================
-- briefing_cards — defined now, populated in the briefing phase
-- NOTE: member_folder_ids uuid[] does not cascade on folder
-- delete; revisit when building the briefing-card phase.
-- ============================================================
create table briefing_cards (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) default auth.uid(),
  title             text not null,
  summary           text not null,
  member_folder_ids uuid[] not null,
  updated_at        timestamptz not null default now()
);

-- ============================================================
-- Vector search index (cosine)
-- ============================================================
create index folders_embedding_idx on folders
  using hnsw (embedding vector_cosine_ops);

-- ============================================================
-- updated_at maintenance
-- ============================================================
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger folders_set_updated_at
  before update on folders
  for each row execute function set_updated_at();

create trigger briefing_cards_set_updated_at
  before update on briefing_cards
  for each row execute function set_updated_at();

-- ============================================================
-- Row Level Security — explicit policies, not just enabled.
-- Each user can select/insert/update/delete only their own rows.
-- ============================================================
alter table folders enable row level security;
alter table links enable row level security;
alter table briefing_cards enable row level security;

create policy "folders_select_own" on folders
  for select using (auth.uid() = user_id);
create policy "folders_insert_own" on folders
  for insert with check (auth.uid() = user_id);
create policy "folders_update_own" on folders
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "folders_delete_own" on folders
  for delete using (auth.uid() = user_id);

create policy "links_select_own" on links
  for select using (auth.uid() = user_id);
create policy "links_insert_own" on links
  for insert with check (auth.uid() = user_id);
create policy "links_update_own" on links
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "links_delete_own" on links
  for delete using (auth.uid() = user_id);

create policy "briefing_cards_select_own" on briefing_cards
  for select using (auth.uid() = user_id);
create policy "briefing_cards_insert_own" on briefing_cards
  for insert with check (auth.uid() = user_id);
create policy "briefing_cards_update_own" on briefing_cards
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "briefing_cards_delete_own" on briefing_cards
  for delete using (auth.uid() = user_id);

-- ============================================================
-- Vector search RPC — called from the app for retrieval.
-- security invoker (default): RLS applies, only your rows match.
-- ============================================================
create or replace function match_folders(
  query_embedding vector(1024),
  match_count int default 8
)
returns table (
  id uuid,
  title text,
  type text,
  body text,
  similarity float
)
language sql stable as $$
  select f.id, f.title, f.type, f.body,
         1 - (f.embedding <=> query_embedding) as similarity
  from folders f
  where f.embedding is not null
  order by f.embedding <=> query_embedding
  limit match_count;
$$;
