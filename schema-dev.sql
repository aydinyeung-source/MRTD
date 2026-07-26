-- ============================================================
-- MRTD developer mode.
-- Run AFTER schema.sql, schema-shop.sql and schema-chest.sql.
--
-- Two rules:
--   1. The flag lives in the database, so only a granted account
--      gets free chests. A client that merely claims to be a
--      developer is charged as normal.
--   2. Nothing done in developer mode persists. When `sandbox`
--      is set by a real developer the functions compute and
--      return a result but write nothing — no coins spent, no
--      coins earned, no copies added. Toggling the mode off
--      leaves the account exactly as it was.
-- ============================================================

alter table public.profiles
  add column if not exists is_dev boolean not null default false;

-- Grant it to the one account. Usernames are case insensitive.
update public.profiles
set is_dev = true
where lower(username) = 'amingben';

-- The old signatures have to go before adding the new argument,
-- otherwise a one argument call becomes ambiguous.
drop function if exists public.open_chest(integer);
drop function if exists public.bank_run(integer);
drop function if exists public.evolve_tower(text, integer);

-- 1. Chests ----------------------------------------------------
create or replace function public.open_chest(
  draws   integer,
  sandbox boolean default false
)
returns text[]
language plpgsql
security definer set search_path = ''
as $$
declare
  price     integer;
  balance   bigint;
  developer boolean;
  pretend   boolean;
  result    text[] := '{}';
  picked    text;
  i         integer;
  has_rare  boolean := false;
begin
  if draws = 1 then
    price := 100;
  elsif draws = 10 then
    price := 900;
  else
    raise exception 'Chests come in 1 or 10';
  end if;

  select coins, is_dev into balance, developer
  from public.profiles
  where id = auth.uid()
  for update;

  if balance is null then
    raise exception 'No profile for this account';
  end if;

  /* Only a real developer can ask for a throwaway pull. */
  pretend := sandbox and developer;

  if not pretend then
    if balance < price then
      raise exception 'Not enough coins';
    end if;

    update public.profiles set coins = coins - price where id = auth.uid();
  end if;

  for i in 1..draws loop
    picked := public.draw_tower();

    if picked in (select tower_key from public.chest_odds where rarity <> 'common') then
      has_rare := true;
    end if;

    result := array_append(result, picked);
  end loop;

  if draws = 10 and not has_rare then
    select tower_key into picked
    from public.chest_odds
    where rarity <> 'common'
    order by random()
    limit 1;

    result[10] := picked;
  end if;

  /* A sandbox pull shows what you would have got and keeps none. */
  if pretend then
    return result;
  end if;

  for i in 1..draws loop
    insert into public.player_towers (player_id, tower_key, evolution, copies)
    values (auth.uid(), result[i], 0, 1)
    on conflict (player_id, tower_key, evolution)
    do update set copies = public.player_towers.copies + 1;
  end loop;

  return result;
end $$;

-- 2. Banking a run ---------------------------------------------
create or replace function public.bank_run(
  waves_beaten integer,
  sandbox      boolean default false
)
returns bigint
language plpgsql
security definer set search_path = ''
as $$
declare
  reward    bigint;
  balance   bigint;
  developer boolean;
begin
  if waves_beaten is null or waves_beaten < 0 then
    raise exception 'Invalid wave count';
  end if;

  select coins, is_dev into balance, developer
  from public.profiles
  where id = auth.uid()
  for update;

  if balance is null then
    raise exception 'No profile for this account';
  end if;

  reward := floor(5 * power(waves_beaten, 1.25));

  /* Developer runs are not worth anything. */
  if sandbox and developer then
    return balance;
  end if;

  update public.profiles
  set coins = coins + reward
  where id = auth.uid()
  returning coins into balance;

  return balance;
end $$;

-- 3. Evolving --------------------------------------------------
create or replace function public.evolve_tower(
  target_key     text,
  from_evolution integer,
  sandbox        boolean default false
)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  held      integer;
  developer boolean;
begin
  if from_evolution < 0 or from_evolution >= 10 then
    raise exception 'Evolution out of range';
  end if;

  select is_dev into developer from public.profiles where id = auth.uid();

  /* Nothing is consumed or created in developer mode. */
  if sandbox and developer then
    return from_evolution + 1;
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

grant execute on function public.open_chest(integer, boolean) to authenticated;
grant execute on function public.bank_run(integer, boolean) to authenticated;
grant execute on function public.evolve_tower(text, integer, boolean) to authenticated;
