-- ============================================================
-- MRTD: the Medic joins the chest, at epic.
--
-- Weights are per mille and are the whole RARITY's share, not
-- the tower's. Every tower in a rarity carries the same number
-- and whichever one is up that half hour uses it, so adding one
-- changes how often you see that particular tower and never how
-- often epic itself comes up.
--
-- Epic stays at 18.0%. What changes:
--
--   was  Blender / Spawner          each up half the time
--   now  Blender / Spawner / Medic  each up a third
--
-- Run once, then this file goes.
-- ============================================================

insert into public.chest_odds (tower_key, weight, rarity) values
  ('medic', 180, 'epic')
on conflict (tower_key) do update
  set weight = excluded.weight, rarity = excluded.rarity;

-- What is in the chest this half hour.
select * from public.active_chest() order by weight desc;
