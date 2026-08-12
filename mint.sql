-- ============================================================
-- MRTD: the Mint, and a tier above godly.
--
-- Rebuilt after the original was lost. The client side was
-- untouched, so this is written to match what stats.js already
-- says rather than from memory:
--
--   mint      godly
--   quantum   ultimate
--   obelisk   ultimate  (but NOT added here — see below)
--
-- ============================================================
-- HOW THE WEIGHTS WORK, because it is not obvious
--
-- The weight column is the whole RARITY's share of a pull, per
-- mille, repeated on every tower in that rarity. Whichever
-- tower is up that half hour carries it. That is what lets a
-- rarity gain a tower without becoming more common — it only
-- changes how often you see that particular one.
--
-- So the numbers have to add up across RARITIES, not rows:
--
--   common     511   dagger, axe
--   rare       267   farm, sniper, shotgunner
--   epic       180   blender, spawner, medic
--   legendary   30   beacon, forge, metronome
--   mythic      10   djtv, ice cannon, fan
--   godly        1   clock tower, mint
--   ultimate     1   quantum
--              ----
--              1000
--
-- Common drops from 512 to 511 to pay for the new tier. Ultimate
-- is 0.1%, the same as godly was, and Quantum moves into it —
-- so Quantum is exactly as rare as it always was, and the Clock
-- Tower is now easier to see because it no longer shares its
-- slot with Quantum.
--
-- THE OBELISK IS NOT HERE ON PURPOSE. It is not obtainable yet,
-- and anything in this table can be rolled or admin-granted.
-- Dev mode owns every tower regardless of this table, which is
-- how it is tested. Add it here when the weekly prize is turned
-- on.
--
-- Run once, then this file goes.
-- ============================================================

insert into public.chest_odds (tower_key, weight, rarity) values
  ('mint',      1, 'godly'),

  /* Out of godly and into a tier of its own. */
  ('quantum',   1, 'ultimate'),

  /* Common pays for the new tier, so the total stays at 1000. */
  ('dagger',  511, 'common'),
  ('axe',     511, 'common')
on conflict (tower_key) do update
  set weight = excluded.weight, rarity = excluded.rarity;


-- Should be 1000 across the rarities, and one row per rarity.
select
  rarity,
  min(weight)      as weight,
  count(*)         as towers,
  string_agg(tower_key, ', ' order by tower_key) as members
from public.chest_odds
group by rarity
order by min(weight) desc;

select sum(weight) as should_be_1000
from (
  select distinct on (rarity) rarity, weight
  from public.chest_odds
  order by rarity, weight
) as tiers;
