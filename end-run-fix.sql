-- ============================================================
-- Fix: end_party_run answers 400 and nobody gets paid.
--
-- The function declared a variable called `paid` to count how
-- many players it had paid. run_players also has a COLUMN called
-- paid, marking whether that player already collected.
--
-- Then it wrote:
--
--   where run_id = mine and present and not paid
--
-- meaning the column. plpgsql resolves a bare name to its own
-- variable first, so `paid` was the integer 0, and `not 0` is
-- not a condition. The statement never ran, the exception came
-- back as a 400, and a finished run paid nobody.
--
-- Same shape as the tower_key ambiguity from the admin grants:
-- a local name that also exists on the table it is querying.
--
-- The variable is renamed. Nothing else changes — the column
-- keeps the name it should have, since it is the one that
-- describes the row.
--
-- Run once, then this file goes.
-- ============================================================

create or replace function public.end_party_run(p_waves integer default 0)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  mine        bigint;
  reward      integer;
  paid_count  integer := 0;
begin
  mine := public.my_run();

  if mine is null then
    return 0;
  end if;

  /* Same curve as a solo run: 5 x waves ^ 1.25. */
  reward := floor(5 * power(greatest(p_waves, 0), 1.25))::integer;

  update public.party_runs
  set status = 'ended', ended_at = now()
  where id = mine and status = 'running';

  if not found then
    return 0;
  end if;

  /* Present players only. Someone who walked out before the end
     gets nothing — their towers went on helping, but they were
     not there to see it through, and paying them would make
     leaving strictly better than staying.

     run_players.paid is qualified now, so it cannot be mistaken
     for a variable again. */
  with payees as (
    update public.run_players r
    set paid = true
    where r.run_id = mine
      and r.present
      and not r.paid
    returning r.player_id
  )
  update public.profiles p
  set coins = p.coins + reward
  from payees
  where p.id = payees.player_id;

  get diagnostics paid_count = row_count;

  update public.parties set status = 'open'
  where id = (select party_id from public.party_runs where id = mine);

  return paid_count;
end $$;

grant execute on function public.end_party_run(integer) to authenticated;


-- Should return 0 rather than an error: there is no run to end
-- from the SQL editor, where auth.uid() is null.
select public.end_party_run(0) as should_be_zero;
