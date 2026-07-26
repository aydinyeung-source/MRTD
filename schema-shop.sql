-- ============================================================
-- MRTD shop, collection and evolutions.
-- Run this AFTER schema.sql. Idempotent: safe to re-run.
--
-- Rolling and evolving are Postgres functions, not client writes.
-- The browser has no insert or update rights on player_towers, so
-- it can ask for a roll but cannot grant itself one.
-- ============================================================

-- 1. One free roll per account, ever ---------------------------
alter table public.profiles
  add column if not exists free_roll_used boolean not null default false;

-- 2. Collection ------------------------------------------------
-- Replaces the earlier player_towers, which had no room for
-- duplicate copies or evolution tiers. Drops existing rows.
drop table if exists public.player_towers cascade;

create table public.player_towers (
  player_id uuid    not null references public.profiles(id) on delete cascade,
  tower_key text    not null,
  evolution integer not null default 0 check (evolution between 0 and 10),
  copies    integer not null default 0 check (copies >= 0),
  primary key (player_id, tower_key, evolution)
);

alter table public.player_towers enable row level security;

-- Read only. All writes go through the functions below.
drop policy if exists "own towers" on public.player_towers;
create policy "own towers" on public.player_towers
  for select to authenticated
  using (auth.uid() = player_id);

-- 3. The free roll ---------------------------------------------
create or replace function public.claim_free_roll()
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  pool   text[] := array['blender', 'dagger', 'farm', 'shotgunner', 'sniper'];
  picked text;
  used   boolean;
begin
  -- Locks the row, so two clicks cannot both win a roll.
  select free_roll_used into used
  from public.profiles
  where id = auth.uid()
  for update;

  if used is null then
    raise exception 'No profile for this account';
  end if;

  if used then
    raise exception 'Free roll already used';
  end if;

  picked := pool[1 + floor(random() * array_length(pool, 1))::int];

  update public.profiles set free_roll_used = true where id = auth.uid();

  insert into public.player_towers (player_id, tower_key, evolution, copies)
  values (auth.uid(), picked, 0, 1)
  on conflict (player_id, tower_key, evolution)
  do update set copies = public.player_towers.copies + 1;

  return picked;
end $$;

-- 4. Evolving --------------------------------------------------
-- Two copies at the same tier become one copy at the next tier.
create or replace function public.evolve_tower(
  target_key     text,
  from_evolution integer
)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  held integer;
begin
  if from_evolution < 0 or from_evolution >= 10 then
    raise exception 'Evolution out of range';
  end if;

  select copies into held
  from public.player_towers
  where player_id = auth.uid()
    and tower_key = target_key
    and evolution = from_evolution
  for update;

  if held is null or held < 2 then
    raise exception 'Need two copies to evolve';
  end if;

  update public.player_towers
  set copies = copies - 2
  where player_id = auth.uid()
    and tower_key = target_key
    and evolution = from_evolution;

  insert into public.player_towers (player_id, tower_key, evolution, copies)
  values (auth.uid(), target_key, from_evolution + 1, 1)
  on conflict (player_id, tower_key, evolution)
  do update set copies = public.player_towers.copies + 1;

  return from_evolution + 1;
end $$;

-- 5. Let logged in players call them ---------------------------
grant execute on function public.claim_free_roll() to authenticated;
grant execute on function public.evolve_tower(text, integer) to authenticated;
