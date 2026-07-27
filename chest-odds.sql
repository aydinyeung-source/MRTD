-- ============================================================
-- MRTD chest odds: blender becomes the epic, sniper the rare.
-- Weights still total 100. Run once, then this file goes.
-- ============================================================

update public.chest_odds set weight = 30, rarity = 'common' where tower_key = 'dagger';
update public.chest_odds set weight = 26, rarity = 'common' where tower_key = 'farm';
update public.chest_odds set weight = 17, rarity = 'rare'   where tower_key = 'sniper';
update public.chest_odds set weight = 15, rarity = 'rare'   where tower_key = 'shotgunner';
update public.chest_odds set weight = 12, rarity = 'epic'   where tower_key = 'blender';

select tower_key, weight, rarity
from public.chest_odds
order by weight desc;
