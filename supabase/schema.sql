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

-- Personal calendar kept in Day Book (added Nov 2026).
create table if not exists public.personal_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  location text not null default '',
  notes text not null default '',
  all_day boolean not null default false,
  start_date date not null,
  start_time text,
  end_time text,
  repeat_days int[],
  repeat_until date,
  skip_dates date[] not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.personal_events enable row level security;
drop policy if exists "own personal events" on public.personal_events;
create policy "own personal events" on public.personal_events for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
do $$ begin
  alter publication supabase_realtime add table public.personal_events;
exception when duplicate_object then null; end $$;

-- Per-calendar switch for the missing-Unavailable check (added Nov 2026).
alter table public.calendars add column if not exists needs_blocks boolean not null default true;

-- Repeating to-dos (added Nov 2026).
alter table public.tasks add column if not exists repeat text;

-- Subscribe link for the Personal calendar (added Nov 2026).
alter table public.settings add column if not exists feed_token text unique;
create or replace function public.personal_feed(token text)
returns setof public.personal_events
language sql stable security definer set search_path = public
as $$
  select p.* from public.personal_events p
  join public.settings s on s.user_id = p.user_id
  where length(token) >= 48 and s.feed_token = token;
$$;
revoke all on function public.personal_feed(text) from public;
grant execute on function public.personal_feed(text) to anon, authenticated;
