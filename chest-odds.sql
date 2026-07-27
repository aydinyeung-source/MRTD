-- ============================================================
-- MRTD chest: six towers, and a rotating line-up.
--
--   common  dagger, axe
--   rare    farm, sniper, shotgunner
--   epic    blender
--
-- One tower from each rarity is in the chest at a time. The
-- line-up changes every half hour and is worked out from the
-- clock, so every player everywhere sees the same one without
-- anything needing to be scheduled or stored.
--
-- A rarity's whole weight goes to whichever of its towers is
-- currently up, so the odds of getting SOMETHING rare never
-- change — only which rare it is.
-- Run once, then this file goes.
-- ============================================================

insert into public.chest_odds (tower_key, weight, rarity)
values ('axe', 24, 'common')
on conflict (tower_key) do update
  set weight = excluded.weight, rarity = excluded.rarity;

update public.chest_odds set weight = 28, rarity = 'common' where tower_key = 'dagger';
update public.chest_odds set weight = 24, rarity = 'common' where tower_key = 'axe';
update public.chest_odds set weight = 14, rarity = 'rare'   where tower_key = 'farm';
update public.chest_odds set weight = 12, rarity = 'rare'   where tower_key = 'sniper';
update public.chest_odds set weight = 10, rarity = 'rare'   where tower_key = 'shotgunner';
update public.chest_odds set weight = 12, rarity = 'epic'   where tower_key = 'blender';

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

-- The towers actually in the chest right now, one per rarity,
-- each carrying its whole rarity's weight.
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
      c.rarity,
      row_number() over (partition by c.rarity order by c.tower_key) - 1 as slot,
      count(*)    over (partition by c.rarity) as choices,
      sum(c.weight) over (partition by c.rarity) as tier_weight
    from public.chest_odds c
  )
  select r.tower_key, r.tier_weight::integer, r.rarity
  from ranked r
  where r.slot = mod(public.chest_slot(), r.choices);
$$;

-- Draws now come from the active line-up rather than the whole
-- table, so a tower that is not up cannot be pulled.
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
