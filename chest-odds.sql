-- ============================================================
-- MRTD chest odds, six towers.
--   common  dagger, axe
--   rare    farm, sniper, shotgunner
--   epic    blender
-- Weights total 100. Run once, then this file goes.
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

select tower_key, weight, rarity,
       round(weight * 100.0 / sum(weight) over (), 1) as percent
from public.chest_odds
order by weight desc;
