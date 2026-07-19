-- Migration 003: connection engine - pass state, cluster membership, screening decision log.
-- cluster_assignments is separate from folders.metadata so recomputes never touch
-- folders.updated_at (which would poison the same-occasion guard and recency semantics).

create table link_passes (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) default auth.uid(),
  status         text not null default 'started'
                   check (status in ('started','clustered','screened','leaps','completed')),
  started_at     timestamptz not null default now(),
  completed_at   timestamptz,
  spend_estimate real not null default 0,
  notes          text
);

create table cluster_assignments (
  pass_id     uuid not null references link_passes(id) on delete cascade,
  folder_id   uuid not null references folders(id) on delete cascade,
  cluster_id  int not null,
  user_id     uuid not null references auth.users(id) default auth.uid(),
  computed_at timestamptz not null default now(),
  primary key (pass_id, folder_id)
);

-- Calibration answer-key for the future local screener swap. Append-only.
create table screen_log (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) default auth.uid(),
  pass_id        uuid references link_passes(id) on delete set null,
  a_id           uuid not null references folders(id) on delete cascade,
  b_id           uuid not null references folders(id) on delete cascade,
  similarity     real,
  flow           text not null,  -- flow1 | flow2_roam | flow2_harvest | co_mention
  bucket         text,           -- auto_high | auto_low | obvious | maybe | nothing
  confidence     real,
  model          text not null,  -- embedding | haiku | sonnet | (local model name later)
  escalated      boolean not null default false,
  verify_outcome text,           -- filed | dropped | filed_unverified
  created_at     timestamptz not null default now()
);

alter table link_passes enable row level security;
alter table cluster_assignments enable row level security;
alter table screen_log enable row level security;

create policy "link_passes_select_own" on link_passes for select using (auth.uid() = user_id);
create policy "link_passes_insert_own" on link_passes for insert with check (auth.uid() = user_id);
create policy "link_passes_update_own" on link_passes for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "link_passes_delete_own" on link_passes for delete using (auth.uid() = user_id);

create policy "cluster_assignments_select_own" on cluster_assignments for select using (auth.uid() = user_id);
create policy "cluster_assignments_insert_own" on cluster_assignments for insert with check (auth.uid() = user_id);
create policy "cluster_assignments_update_own" on cluster_assignments for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "cluster_assignments_delete_own" on cluster_assignments for delete using (auth.uid() = user_id);

create policy "screen_log_select_own" on screen_log for select using (auth.uid() = user_id);
create policy "screen_log_insert_own" on screen_log for insert with check (auth.uid() = user_id);
create policy "screen_log_update_own" on screen_log for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "screen_log_delete_own" on screen_log for delete using (auth.uid() = user_id);
