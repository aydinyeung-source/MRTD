-- ============================================================
-- MRTD shinies, part 2 of 2.
--
-- Run part 1 first (it added the column). This widens the
-- uniqueness key, teaches the chest to roll 1%, and keeps the
-- two lines apart everywhere they could otherwise mix.
--
-- Chest pulls come back as 'sniper' or 'sniper#shiny'. That is
-- the same variant naming the browser already uses for hotbar
-- slots and loadout entries, so the client reads it without a
-- second format to learn.
--
-- Run once, then this file goes.
-- ============================================================


-- ============================================================
-- 1. The uniqueness key
--
-- Every insert in here used to say
--   on conflict (player_id, tower_key, evolution)
-- which now has to include shiny, or a shiny pull would be
-- folded into the normal stack of the same tower.
--
-- The constraint is found by its columns rather than its name,
-- because the name depends on how the table was first created.
-- ============================================================

do $$
declare
  found_name text;
begin
  select c.conname into found_name
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'player_towers'
    and c.contype in ('p', 'u')
    and (
      select array_agg(a.attname::text order by a.attname)
      from unnest(c.conkey) as k(attnum)
      join pg_attribute a
        on a.attrelid = c.conrelid and a.attnum = k.attnum
    ) = array['evolution', 'player_id', 'tower_key']
  limit 1;

  if found_name is not null then
    execute format(
      'alter table public.player_towers drop constraint %I', found_name
    );
  end if;

  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'player_towers'
      and c.conname = 'player_towers_stack_key'
  ) then
    alter table public.player_towers
      add constraint player_towers_stack_key
      unique (player_id, tower_key, evolution, shiny);
  end if;
end $$;


-- ============================================================
-- 2. The roll
--
-- One in a hundred. Kept in one place so the rate is changed
-- once rather than in five functions.
-- ============================================================

create or replace function public.roll_shiny()
returns boolean
language sql
volatile
as $$ select random() < 0.01 $$;

-- How a pull is reported back to the browser.
create or replace function public.tower_variant(tower text, is_shiny boolean)
returns text
language sql
immutable
as $$ select case when is_shiny then tower || '#shiny' else tower end $$;

grant execute on function public.roll_shiny() to authenticated;
grant execute on function public.tower_variant(text, boolean) to authenticated;


-- ============================================================
-- 3. The chest
-- ============================================================

create or replace function public.open_chest(draws integer, sandbox boolean default false)
returns text[]
language plpgsql
security definer
set search_path = ''
as $function$
declare
  price     integer;
  balance   bigint;
  developer boolean;
  pretend   boolean;
  result    text[] := '{}';
  keys      text[] := '{}';
  shinies   boolean[] := '{}';
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

    keys := array_append(keys, picked);
    /* Rolled per card, so a ten pull is ten chances rather than
       one. */
    shinies := array_append(shinies, public.roll_shiny());
  end loop;

  if draws = 10 and not has_rare then
    select tower_key into picked
    from public.chest_odds
    where rarity <> 'common'
    order by random()
    limit 1;

    keys[10] := picked;
    /* The pity card is a fresh card, so it gets a fresh roll. */
    shinies[10] := public.roll_shiny();
  end if;

  for i in 1..draws loop
    result := array_append(result, public.tower_variant(keys[i], shinies[i]));
  end loop;

  /* A sandbox pull shows what you would have got and keeps none. */
  if pretend then
    return result;
  end if;

  for i in 1..draws loop
    insert into public.player_towers (player_id, tower_key, evolution, copies, shiny)
    values (auth.uid(), keys[i], 0, 1, shinies[i])
    on conflict (player_id, tower_key, evolution, shiny)
    do update set copies = public.player_towers.copies + 1;
  end loop;

  return result;
end $function$;


create or replace function public.open_chest_all(p_sandbox boolean default false)
returns text[]
language plpgsql
security definer
set search_path = ''
as $function$
declare
  price     constant integer := 100;
  cap       constant integer := 500;
  balance   bigint;
  developer boolean;
  draws     integer;
  result    text[] := '{}';
  keys      text[] := '{}';
  shinies   boolean[] := '{}';
  picked    text;
  i         integer;
begin
  select coins, is_dev into balance, developer
  from public.profiles
  where id = auth.uid()
  for update;

  if balance is null then
    raise exception 'No profile for this account';
  end if;

  /* A developer has nothing to spend and keeps nothing, so a
     sandbox pull is a fixed sample. */
  if p_sandbox and coalesce(developer, false) then
    draws := 10;
  else
    draws := least(floor(balance / price)::integer, cap);

    if draws < 1 then
      raise exception 'Not enough coins';
    end if;

    update public.profiles
    set coins = coins - draws * price
    where id = auth.uid();
  end if;

  for i in 1..draws loop
    picked := public.draw_tower();
    keys := array_append(keys, picked);
    shinies := array_append(shinies, public.roll_shiny());
    result := array_append(
      result, public.tower_variant(picked, shinies[i])
    );
  end loop;

  if p_sandbox and coalesce(developer, false) then
    return result;
  end if;

  for i in 1..draws loop
    insert into public.player_towers (player_id, tower_key, evolution, copies, shiny)
    values (auth.uid(), keys[i], 0, 1, shinies[i])
    on conflict (player_id, tower_key, evolution, shiny)
    do update set copies = public.player_towers.copies + 1;
  end loop;

  return result;
end $function$;


create or replace function public.claim_free_roll()
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  pool     text[] := array['blender', 'dagger', 'farm', 'shotgunner', 'sniper'];
  picked   text;
  is_shiny boolean;
  used     boolean;
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
  /* The free card is a real card, so it can come out shiny. */
  is_shiny := public.roll_shiny();

  update public.profiles set free_roll_used = true where id = auth.uid();

  insert into public.player_towers (player_id, tower_key, evolution, copies, shiny)
  values (auth.uid(), picked, 0, 1, is_shiny)
  on conflict (player_id, tower_key, evolution, shiny)
  do update set copies = public.player_towers.copies + 1;

  return public.tower_variant(picked, is_shiny);
end $function$;


-- ============================================================
-- 4. Merging
--
-- The whole point of a shiny: two shinies make a higher shiny,
-- two normals make a higher normal, and neither can consume the
-- other. Every clause below carries shiny for that reason.
-- ============================================================

-- Gains a parameter, so the old signature goes first.
drop function if exists public.evolve_tower(text, integer, boolean);

create or replace function public.evolve_tower(
  target_key text,
  from_evolution integer,
  p_shiny boolean default false,
  sandbox boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
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
    and shiny = p_shiny
  for update;

  if held is null or held < 2 then
    raise exception 'Need two copies to evolve';
  end if;

  update public.player_towers
  set copies = copies - 2
  where player_id = auth.uid()
    and tower_key = target_key
    and evolution = from_evolution
    and shiny = p_shiny;

  insert into public.player_towers (player_id, tower_key, evolution, copies, shiny)
  values (auth.uid(), target_key, from_evolution + 1, 1, p_shiny)
  on conflict (player_id, tower_key, evolution, shiny)
  do update set copies = public.player_towers.copies + 1;

  return from_evolution + 1;
end $function$;


create or replace function public.evolve_all(p_sandbox boolean default false)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  developer boolean;
  target    record;
  performed integer := 0;
begin
  select is_dev into developer
  from public.profiles
  where id = auth.uid();

  /* Developer mode changes nothing, so there is nothing to do. */
  if p_sandbox and coalesce(developer, false) then
    return 0;
  end if;

  loop
    select t.tower_key, t.evolution, t.shiny
    into target
    from public.player_towers t
    where t.player_id = auth.uid()
      and t.copies >= 2
      and t.evolution < 10
    order by t.evolution asc, t.tower_key asc, t.shiny asc
    limit 1;

    exit when not found;

    update public.player_towers
    set copies = copies - 2
    where player_id = auth.uid()
      and tower_key = target.tower_key
      and evolution = target.evolution
      and shiny = target.shiny;

    insert into public.player_towers (player_id, tower_key, evolution, copies, shiny)
    values (auth.uid(), target.tower_key, target.evolution + 1, 1, target.shiny)
    on conflict (player_id, tower_key, evolution, shiny)
    do update set copies = public.player_towers.copies + 1;

    performed := performed + 1;

    /* A collection cannot legitimately need this many. */
    exit when performed >= 5000;
  end loop;

  return performed;
end $function$;


-- ============================================================
-- 5. Counting
--
-- Both of these answered "how many of this card" back when that
-- question had one answer. Now it has two, so they say which.
-- The default is the normal copy, which is what every existing
-- caller means.
-- ============================================================

create or replace function public.base_copies(player uuid, tower text, p_shiny boolean default false)
returns integer
language sql
security definer
set search_path = ''
as $function$
  select coalesce(
    (select t.copies from public.player_towers t
     where t.player_id = player
       and t.tower_key = tower
       and t.evolution = 0
       and t.shiny = p_shiny),
    0
  );
$function$;

create or replace function public.copies_at(player uuid, tower text, evolution integer, p_shiny boolean default false)
returns integer
language sql
security definer
set search_path = ''
as $function$
  select coalesce(
    (select t.copies from public.player_towers t
     where t.player_id = player
       and t.tower_key = tower
       and t.evolution = copies_at.evolution
       and t.shiny = p_shiny),
    0
  );
$function$;


-- ============================================================
-- 6. Trading
--
-- This is the part that would have gone wrong quietly.
--
-- settle_trade moved cards with
--   where tower_key = ... and evolution = ...
-- and no mention of shiny. Once a player holds both lines of the
-- same tower at the same evolution, that matches TWO rows, so a
-- one card trade would have taken a copy off the normal stack
-- AND off the shiny stack, destroying the shiny.
--
-- trade_items gains a shiny column defaulting to false, and
-- every clause below names it. Trades therefore move normal
-- cards only, which is what the trade window offers today.
-- Offering shinies needs set_trade_item and the trade UI to
-- carry the flag as well — deliberately not done here, because a
-- half wired version of that is how cards get lost.
-- ============================================================

alter table public.trade_items
  add column if not exists shiny boolean not null default false;

create or replace function public.settle_trade(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  deal public.trades;
  item record;
begin
  select * into deal from public.trades where id = p_id for update;

  if deal.id is null or auth.uid() not in (deal.player_a, deal.player_b) then
    raise exception 'Not your trade';
  end if;

  if deal.status = 'done' then
    return true;
  end if;

  if deal.status <> 'locked' then
    raise exception 'Both sides must lock first';
  end if;

  if deal.locked_at + make_interval(secs => public.trade_hold_seconds()) > now() then
    raise exception 'Still within the withdrawal window';
  end if;

  /* Everything is rechecked here — cards may have been spent
     while the hold was running. */
  for item in
    select * from public.trade_items where trade_id = p_id
  loop
    if public.copies_at(
         item.player_id, item.tower_key, item.evolution, item.shiny
       ) < item.copies then
      update public.trades set status = 'cancelled' where id = p_id;
      raise exception 'Someone no longer has the cards — trade cancelled';
    end if;
  end loop;

  for item in
    select * from public.trade_items where trade_id = p_id
  loop
    update public.player_towers
    set copies = copies - item.copies
    where player_id = item.player_id
      and tower_key = item.tower_key
      and evolution = item.evolution
      and shiny = item.shiny;

    insert into public.player_towers (player_id, tower_key, evolution, copies, shiny)
    values (
      case when item.player_id = deal.player_a then deal.player_b else deal.player_a end,
      item.tower_key, item.evolution, item.copies, item.shiny
    )
    on conflict (player_id, tower_key, evolution, shiny)
    do update set copies = public.player_towers.copies + item.copies;
  end loop;

  update public.trades set status = 'done' where id = p_id;

  return true;
end $function$;


-- ============================================================
-- 7. Admin grants
--
-- Chests granted by an admin are real chest pulls, so they roll
-- for shiny like any other. Granting a named card takes a flag,
-- so a shiny can be handed out on purpose.
-- ============================================================

create or replace function public.admin_grant_chests(draws integer default 1, online_only boolean default true)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  affected integer := 0;
  target   record;
  picked   text;
  is_shiny boolean;
  i        integer;
begin
  perform public.require_dev();

  if draws is null or draws <= 0 or draws > 50 then
    raise exception 'Draws must be between 1 and 50';
  end if;

  for target in
    select p.id from public.profiles p
    where not online_only or exists (
      select 1 from public.player_sessions s
      where s.player_id = p.id and s.last_seen > now() - interval '2 minutes'
    )
  loop
    for i in 1..draws loop
      picked := public.draw_tower();
      is_shiny := public.roll_shiny();

      insert into public.player_towers (player_id, tower_key, evolution, copies, shiny)
      values (target.id, picked, 0, 1, is_shiny)
      on conflict (player_id, tower_key, evolution, shiny)
      do update set copies = public.player_towers.copies + 1;
    end loop;

    affected := affected + 1;
  end loop;

  insert into public.admin_grants (granted_by, action, detail, recipients)
  values (auth.uid(), 'chests',
          jsonb_build_object('draws', draws, 'online_only', online_only),
          affected);

  return affected;
end $function$;


drop function if exists public.admin_grant_towers(text, integer, boolean);

create or replace function public.admin_grant_towers(
  p_tower text,
  p_copies integer default 1,
  p_online_only boolean default true,
  p_shiny boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  affected integer := 0;
  target   record;
  picked   text;
begin
  perform public.require_dev();

  if p_copies is null or p_copies <= 0 or p_copies > 1000 then
    raise exception 'Copies must be between 1 and 1000';
  end if;

  if p_tower is not null
     and not exists (select 1 from public.chest_odds c where c.tower_key = p_tower) then
    raise exception 'Unknown tower';
  end if;

  for target in
    select p.id from public.profiles p
    where not p_online_only or exists (
      select 1 from public.player_sessions s
      where s.player_id = p.id and s.last_seen > now() - interval '2 minutes'
    )
  loop
    picked := coalesce(p_tower, public.draw_tower());

    insert into public.player_towers as pt (player_id, tower_key, evolution, copies, shiny)
    values (target.id, picked, 0, p_copies, p_shiny)
    on conflict (player_id, tower_key, evolution, shiny)
    do update set copies = pt.copies + p_copies;

    affected := affected + 1;
  end loop;

  insert into public.admin_grants (granted_by, action, detail, recipients)
  values (auth.uid(), 'towers',
          jsonb_build_object('tower', p_tower, 'copies', p_copies,
                             'online_only', p_online_only, 'shiny', p_shiny),
          affected);

  return affected;
end $function$;


-- A shiny of every rarity, to see the gold treatment on a card,
-- a hotbar slot and the board without waiting on a 1% roll.
select 'run part 2 done' as status;
