-- ============================================================
-- Fix: rejoin_run raises every time it is called.
--
-- It declared a variable called `present` to count how many
-- players were still in the run. run_players also has a COLUMN
-- called present, which is the thing being counted.
--
--   declare present integer;
--   ...
--   select count(*) into present
--   from public.run_players
--   where run_id = mine and present;      <-- the variable
--
-- plpgsql resolves a bare name to its own variable first, so
-- `and present` was `and 0`, which is not a condition. The
-- function threw, and the browser quietly started a fresh solo
-- match instead of saying so — which is why rejoining looked
-- like it put you in a new game rather than the old one.
--
-- This is the third time a local name has collided with a
-- column in this schema: tower_key in the admin grants, paid in
-- end_party_run, and now present. Every column reference in here
-- is qualified.
--
-- Run once, then this file goes.
-- ============================================================

create or replace function public.rejoin_run()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  mine          bigint;
  still_playing integer;
begin
  mine := public.my_run();

  if mine is null then
    raise exception 'That run has finished';
  end if;

  select count(*) into still_playing
  from public.run_players r
  where r.run_id = mine and r.present;

  if still_playing = 0 then
    raise exception 'Everyone has left that run';
  end if;

  update public.run_players r
  set present = true, left_at = null
  where r.run_id = mine and r.player_id = auth.uid();

  return mine;
end $$;

grant execute on function public.rejoin_run() to authenticated;


-- The other two that count run_players, checked for the same
-- collision. Neither has one — leave_run counts into `remaining`
-- and end_party_run was already fixed — but they are listed so
-- the answer is visible rather than assumed.
select
  p.proname                                 as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('rejoin_run', 'leave_run', 'end_party_run', 'my_run')
order by p.proname;
