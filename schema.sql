-- ============================================================
-- MRTD player data. Idempotent: safe to re-run.
-- Paste the whole file into the Supabase SQL editor.
-- ============================================================

-- 1. Profiles -------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users on delete cascade,
  username      text unique,
  highest_level integer     not null default 1  check (highest_level >= 1),
  xp            bigint      not null default 0  check (xp >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Upgrade path if an earlier, smaller version of the table exists.
alter table public.profiles add column if not exists highest_level integer     not null default 1;
alter table public.profiles add column if not exists xp            bigint      not null default 0;
alter table public.profiles add column if not exists updated_at    timestamptz not null default now();

-- Usernames are case insensitive: "Aydin" and "aydin" are the same
-- name. The index enforces that; the stored value keeps its original
-- capitalisation for display.
alter table public.profiles drop constraint if exists profiles_username_key;

create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

-- 2. Towers discovered ----------------------------------------
create table if not exists public.player_towers (
  player_id     uuid        not null references public.profiles(id) on delete cascade,
  tower_key     text        not null,
  discovered_at timestamptz not null default now(),
  primary key (player_id, tower_key)
);

-- 3. Friends ---------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'friend_status') then
    create type public.friend_status as enum ('pending', 'accepted', 'blocked');
  end if;
end $$;

create table if not exists public.friendships (
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status       public.friend_status not null default 'pending',
  created_at   timestamptz not null default now(),
  primary key (requester_id, addressee_id),
  constraint no_self_friend check (requester_id <> addressee_id)
);

create index if not exists friendships_addressee_idx
  on public.friendships (addressee_id);

-- 4. Keep updated_at honest ------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- 5. Create the profile row on signup --------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data->>'username');
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 6. Row level security ----------------------------------------
alter table public.profiles      enable row level security;
alter table public.player_towers enable row level security;
alter table public.friendships   enable row level security;

drop policy if exists "profiles readable"   on public.profiles;
drop policy if exists "profiles own insert" on public.profiles;
drop policy if exists "profiles own update" on public.profiles;

create policy "profiles readable"   on public.profiles for select to authenticated using (true);
create policy "profiles own insert" on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "profiles own update" on public.profiles for update to authenticated using (auth.uid() = id);

drop policy if exists "own towers" on public.player_towers;
create policy "own towers" on public.player_towers
  for all to authenticated
  using (auth.uid() = player_id) with check (auth.uid() = player_id);

drop policy if exists "friendships visible" on public.friendships;
drop policy if exists "friendships request" on public.friendships;
drop policy if exists "friendships respond" on public.friendships;
drop policy if exists "friendships remove"  on public.friendships;

create policy "friendships visible" on public.friendships
  for select to authenticated
  using (auth.uid() in (requester_id, addressee_id));

create policy "friendships request" on public.friendships
  for insert to authenticated with check (auth.uid() = requester_id);

create policy "friendships respond" on public.friendships
  for update to authenticated using (auth.uid() = addressee_id);

create policy "friendships remove" on public.friendships
  for delete to authenticated
  using (auth.uid() in (requester_id, addressee_id));
