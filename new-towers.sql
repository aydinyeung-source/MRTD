-- ============================================================
-- MRTD: Fan and Clock Tower join the chest.
--
--   fan         mythic   alongside DJTV and Ice Cannon
--   clocktower  godly    alongside Quantum
--
-- Weights are per mille and are the whole RARITY's share, not
-- the tower's. Every tower in a rarity carries the same number,
-- and whichever one is up that half hour uses it. That is why
-- adding a tower here changes how often you see that particular
-- tower and never how often the rarity itself comes up.
--
-- So mythic stays at 1.0% and godly at 0.1%. What changes:
--
--   mythic  was DJTV / Ice Cannon        each up half the time
--           now DJTV / Ice Cannon / Fan  each up a third
--   godly   was Quantum, always up
--           now Quantum / Clock Tower, alternating
--
-- Quantum was alone in its tier and therefore always in the
-- chest. It is now up half the time. If you would rather it
-- stayed permanently available, say so and Clock Tower can have
-- a tier of its own instead.
--
-- Run once, then this file goes.
-- ============================================================

insert into public.chest_odds (tower_key, weight, rarity) values
  ('fan',         10, 'mythic'),
  ('clocktower',   1, 'godly')
on conflict (tower_key) do update
  set weight = excluded.weight, rarity = excluded.rarity;

-- What is in the chest this half hour, and what each is worth.
select * from public.active_chest() order by weight desc;
