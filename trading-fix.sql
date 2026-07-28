-- ============================================================
-- Fix: trading broken by leftover function overloads.
--
-- The shiny migration added a p_shiny argument to two helpers:
--
--   base_copies(player, tower)
--   copies_at(player, tower, evolution)
--
-- and it used CREATE OR REPLACE to do it. That only replaces a
-- function with the SAME signature. A different argument list is
-- a different function, so instead of replacing them it created
-- second copies beside the originals:
--
--   copies_at(uuid, text, integer)
--   copies_at(uuid, text, integer, boolean)   <- new
--
-- Both can satisfy a three argument call — the new one by
-- letting p_shiny default — so Postgres refuses to choose:
--
--   function copies_at(uuid, text, integer) is not unique
--
-- Anything still calling the old arity started failing at that
-- point, which is set_trade_item and settle_trade's recheck.
--
-- The fix is to drop the originals. The newer ones default
-- p_shiny to false, so every existing three and two argument
-- call keeps working and keeps meaning the normal copy.
--
-- Run once, then this file goes.
-- ============================================================

-- What is actually there, before. Two rows for either name is
-- the bug; one row each afterwards is the fix.
select
  p.proname                                as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('base_copies', 'copies_at')
order by p.proname, arguments;


-- The originals. Dropped by exact signature so the replacements
-- are untouched.
--
-- plpgsql resolves function calls when it runs them, not when it
-- is created, so nothing that calls these needs recreating —
-- they will find the remaining overload on their next call.
drop function if exists public.base_copies(uuid, text);
drop function if exists public.copies_at(uuid, text, integer);


-- One row each now.
select
  p.proname                                as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('base_copies', 'copies_at')
order by p.proname, arguments;
