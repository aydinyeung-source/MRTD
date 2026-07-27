-- ============================================================
-- MRTD chest: seven towers on a rotating line-up.
--
--   common     dagger, axe                52%
--   rare       farm, sniper, shotgunner   27%
--   epic       blender, spawner           18%
--   legendary  beacon, forge, metronome    2%
--   mythic     djtv                        1%
--
-- Legendary takes what is left after the others, so adding the
-- 1% mythic moved it from 3 to 2.
--
-- One tower from each rarity is in the chest at a time. The
-- line-up changes every half hour and is worked out from the
-- clock, so every player everywhere sees the same one without
-- anything needing to be scheduled or stored.
--
-- NOTE ON WEIGHTS: the weight column is the whole RARITY's share
-- of a pull, repeated on every tower in that rarity. Whichever
-- tower is up carries it. That way adding a tower to a rarity
-- changes how often you see that particular tower, and never
-- changes how often the rarity itself comes up.
-- Run once, then this file goes.
-- ============================================================

insert into public.chest_odds (tower_key, weight, rarity) values
  ('dagger',     52, 'common'),
  ('axe',        52, 'common'),
  ('farm',       27, 'rare'),
  ('sniper',     27, 'rare'),
  ('shotgunner', 27, 'rare'),
  ('blender',    18, 'epic'),
  ('spawner',    18, 'epic'),
  -- The three boosters share the 3% legendary slot, one up at a
  -- time like every other rarity.
  ('beacon',      2, 'legendary'),
  ('forge',       2, 'legendary'),
  ('metronome',   2, 'legendary'),
  ('djtv',        1, 'mythic')
on conflict (tower_key) do update
  set weight = excluded.weight, rarity = excluded.rarity;

-- Which half hour we are in. Same number for everyone.
create or replace function public.chest_slot()
returns bigint
language sql
stable
as $$ select floor(extract(epoch from now()) / 1800)::bigint $$;

-- When the current line-up gives way to the next.
create or replace function public.chest_rotates_at()
returns timestamptz
language sql
stable
as $$ select to_timestamp((public.chest_slot() + 1) * 1800) $$;

-- The towers actually in the chest right now: one per rarity,
-- each carrying its rarity's share.
create or replace function public.active_chest()
returns table (tower_key text, weight integer, rarity text)
language sql
stable
security definer
set search_path = ''
as $$
  with ranked as (
    select
      c.tower_key,
      c.weight,
      c.rarity,
      row_number() over (partition by c.rarity order by c.tower_key) - 1 as slot,
      count(*)    over (partition by c.rarity) as choices
    from public.chest_odds c
  )
  select r.tower_key, r.weight, r.rarity
  from ranked r
  where r.slot = mod(public.chest_slot(), r.choices);
$$;

-- Draws come from the active line-up rather than the whole table,
-- so a tower that is not up cannot be pulled.
create or replace function public.draw_tower()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  total   integer;
  roll    integer;
  running integer := 0;
  picked  text;
  entry   record;
begin
  select sum(weight) into total from public.active_chest();

  if total is null or total = 0 then
    raise exception 'The chest is empty';
  end if;

  roll := floor(random() * total) + 1;

  for entry in select tower_key, weight from public.active_chest() order by tower_key loop
    running := running + entry.weight;

    if roll <= running then
      picked := entry.tower_key;
      exit;
    end if;
  end loop;

  return picked;
end $$;

grant execute on function public.chest_slot() to authenticated;
grant execute on function public.chest_rotates_at() to authenticated;
grant execute on function public.active_chest() to authenticated;

select * from public.active_chest() order by weight desc;
