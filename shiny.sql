-- ============================================================
-- MRTD shinies, part 1 of 2.
--
-- A shiny is a separate line from the normal copy of the same
-- tower: they never merge into each other. In the database that
-- means (tower_key, evolution, shiny) identifies a stack, not
-- (tower_key, evolution) — a shiny Sniper at evolution 3 and a
-- plain Sniper at evolution 3 are two rows, not one.
--
-- This file is safe to run on its own. It only adds the column;
-- widening the uniqueness key waits for part 2, once I can see
-- what that key currently is. Nothing rolls a shiny yet, so
-- every existing row stays exactly as it is, marked not shiny.
--
-- Part 2 teaches the chest to roll them and the merge to keep
-- the lines apart. It needs to see the current function bodies
-- first, which is what the query at the bottom is for.
-- ============================================================

alter table public.player_towers
  add column if not exists shiny boolean not null default false;

-- Existing rows are all normal copies. Explicit, rather than
-- relying on the default, so the intent survives a schema dump.
update public.player_towers set shiny = false where shiny is null;


-- ============================================================
-- Tell me what to write next.
--
-- Run everything above, then run this and paste me the result.
-- It returns the uniqueness key on player_towers and the source
-- of every function that touches the table — the chest, the
-- merge, the admin grants and the trade settle.
--
-- I need these because they were written in SQL files that were
-- deleted after running, so the database is the only copy left.
-- Guessing at them and replacing them wholesale risks quietly
-- dropping something they do that I cannot see.
-- ============================================================

select
  c.conname                        as constraint_name,
  c.contype                        as constraint_type,
  pg_get_constraintdef(c.oid)      as definition
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname = 'player_towers'
  and c.contype in ('p', 'u');

-- prokind = 'f' keeps this to plain functions. pg_get_functiondef
-- raises on an aggregate, and filtering on its output would have
-- called it on every function in the schema before deciding which
-- ones matter — including the aggregates.
--
-- prosrc is the raw body, so matching on it never has that
-- problem: no function is inspected that is not already a
-- candidate.
select
  p.proname                        as function_name,
  pg_get_functiondef(p.oid)        as source
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.prosrc ilike '%player_towers%'
order by p.proname;
