-- Migration 002: queries table - questions are gap signal, not knowledge.
-- Logged by ask (it already has the embedding + matches). Powers gap detection later.

create table queries (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) default auth.uid(),
  question_text      text not null,
  embedding          vector(1024),
  matched_folder_ids uuid[],
  top_similarity     real,
  created_at         timestamptz not null default now()
);

alter table queries enable row level security;

create policy "queries_select_own" on queries
  for select using (auth.uid() = user_id);
create policy "queries_insert_own" on queries
  for insert with check (auth.uid() = user_id);
create policy "queries_update_own" on queries
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "queries_delete_own" on queries
  for delete using (auth.uid() = user_id);
