-- ============================================================
-- MRTD coins and chests.
-- Run AFTER schema.sql and schema-shop.sql. Idempotent.
--
-- Draws happen in Postgres, not the browser: the client can ask
-- to open a chest but cannot choose what falls out or pay itself.
-- ============================================================

-- 1. Lobby coins ----------------------------------------------
alter table public.profiles
  add column if not exists coins bigint not null default 0 check (coins >= 0);

-- 2. Drop table -----------------------------------------------
-- Weights are per draw and sum to 100.
create table if not exists public.chest_odds (
  tower_key text primary key,
  weight    integer not null check (weight > 0),
  rarity    text    not null
);

insert into public.chest_odds (tower_key, weight, rarity) values
  ('dagger',     30, 'common'),
  ('farm',       26, 'common'),
  ('blender',    17, 'rare'),
  ('shotgunner', 15, 'rare'),
  ('sniper',     12, 'epic')
on conflict (tower_key) do update
  set weight = excluded.weight, rarity = excluded.rarity;

alter table public.chest_odds enable row level security;

-- Odds are public so the shop can show them honestly.
drop policy if exists "odds readable" on public.chest_odds;
create policy "odds readable" on public.chest_odds
  for select to authenticated using (true);

-- 3. One weighted draw ----------------------------------------
create or replace function public.draw_tower()
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  total  integer;
  roll   integer;
  picked text;
  running integer := 0;
  row     record;
begin
  select sum(weight) into total from public.chest_odds;
  roll := floor(random() * total) + 1;

  for row in select tower_key, weight from public.chest_odds order by tower_key loop
    running := running + row.weight;

    if roll <= running then
      picked := row.tower_key;
      exit;
    end if;
  end loop;

  return picked;
end $$;

-- 4. Bank a finished run --------------------------------------
-- 5 x waves^1.25, rounded down.
create or replace function public.bank_run(waves_beaten integer)
returns bigint
language plpgsql
security definer set search_path = ''
as $$
declare
  reward bigint;
  total  bigint;
begin
  if waves_beaten is null or waves_beaten < 0 then
    raise exception 'Invalid wave count';
  end if;

  reward := floor(5 * power(waves_beaten, 1.25));

  update public.profiles
  set coins = coins + reward
  where id = auth.uid()
  returning coins into total;

  if total is null then
    raise exception 'No profile for this account';
  end if;

  return total;
end $$;

-- 5. Open a chest ---------------------------------------------
-- One draw costs 100, ten cost 900. A ten pull guarantees at
-- least one rare or better.
create or replace function public.open_chest(draws integer)
returns text[]
language plpgsql
security definer set search_path = ''
as $$
declare
  price   integer;
  balance bigint;
  result  text[] := '{}';
  picked  text;
  i       integer;
  has_rare boolean := false;
begin
  if draws = 1 then
    price := 100;
  elsif draws = 10 then
    price := 900;
  else
    raise exception 'Chests come in 1 or 10';
  end if;

  -- Lock the row so two clicks cannot spend the same coins.
  select coins into balance
  from public.profiles
  where id = auth.uid()
  for update;

  if balance is null then
    raise exception 'No profile for this account';
  end if;

  if balance < price then
    raise exception 'Not enough coins';
  end if;

  update public.profiles set coins = coins - price where id = auth.uid();

  for i in 1..draws loop
    picked := public.draw_tower();

    if picked in (select tower_key from public.chest_odds where rarity <> 'common') then
      has_rare := true;
    end if;

    result := array_append(result, picked);
  end loop;

  -- Pity: a ten pull always contains something better than common.
  if draws = 10 and not has_rare then
    select tower_key into picked
    from public.chest_odds
    where rarity <> 'common'
    order by random()
    limit 1;

    result[10] := picked;
  end if;

  -- Bank the copies.
  for i in 1..draws loop
    insert into public.player_towers (player_id, tower_key, evolution, copies)
    values (auth.uid(), result[i], 0, 1)
    on conflict (player_id, tower_key, evolution)
    do update set copies = public.player_towers.copies + 1;
  end loop;

  return result;
end $$;

grant execute on function public.draw_tower() to authenticated;
grant execute on function public.bank_run(integer) to authenticated;
grant execute on function public.open_chest(integer) to authenticated;
