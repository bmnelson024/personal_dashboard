-- Personal Dashboard schema. Run once in Supabase: SQL Editor > New query > paste > Run.
-- Every table is locked to the signed-in user by row level security.

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  area text,
  due date,
  pri boolean not null default false,
  notes text not null default '',
  done boolean not null default false,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists tasks_user_idx on public.tasks (user_id, done);

create table if not exists public.calendars (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null default 'Calendar',
  url text not null,
  color text not null default '#2e6f8e',
  enabled boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  areas jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.tasks enable row level security;
alter table public.calendars enable row level security;
alter table public.settings enable row level security;

drop policy if exists "own tasks" on public.tasks;
create policy "own tasks" on public.tasks for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own calendars" on public.calendars;
create policy "own calendars" on public.calendars for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own settings" on public.settings;
create policy "own settings" on public.settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Live sync between your laptop and phone.
do $$ begin
  alter publication supabase_realtime add table public.tasks;
exception when duplicate_object then null; end $$;
