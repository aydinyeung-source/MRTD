-- ============================================================
-- MRTD: the Mint, and a new rarity above godly.
--
-- Two changes to chest_odds.
--
-- 1. Quantum moves from godly to ULTIMATE.
--
--    Godly was doing two jobs — the rarest thing in the chest,
--    and the best thing in the game. Splitting them means a new
--    tower can be godly without being measured against Quantum.
--    The Obelisk joins ultimate when it starts being handed out;
--    it is not in this table and must not be, or it becomes
--    summonable.
--
-- 2. The Mint arrives at godly, beside the Clock Tower.
--
-- WEIGHTS ARE PER MILLE AND ARE THE RARITY'S SHARE, repeated on
-- every tower in that rarity. So moving Quantum out of godly and
-- into a tier of its own does NOT change how often godly comes
-- up — it changes what is in it.
--
--   ultimate    1    0.1%   Quantum, alone, always up
--   godly       1    0.1%   Clock Tower / Mint, alternating
--   mythic     10    1.0%   DJTV / Ice Cannon / Fan
--   epic      180   18.0%   Blender / Spawner / Medic
--   rare      267   26.7%
--   common    512   51.2%
--
-- That adds 0.1% and takes the total to 1001 per mille rather
-- than 1000. draw_tower sums the active line-up and rolls
-- against that sum, so it stays correct — the shares simply
-- become 1/1001 rather than 1/1000. Common drops from 51.2% to
-- 51.15%. Nobody will notice, and the alternative is shaving a
-- point off another tier for no reason.
--
-- Run once, then this file goes.
-- ============================================================

insert into public.chest_odds (tower_key, weight, rarity) values
  ('mint',      1, 'godly'),
  ('quantum',   1, 'ultimate')
on conflict (tower_key) do update
  set weight = excluded.weight, rarity = excluded.rarity;

-- What is up now, and what each is worth. Ultimate should show
-- Quantum on its own; godly should show one of Clock Tower or
-- Mint depending on the half hour.
select
  tower_key,
  rarity,
  weight,
  round(weight * 100.0 / sum(weight) over (), 2) as percent
from public.active_chest()
order by weight asc, tower_key;
