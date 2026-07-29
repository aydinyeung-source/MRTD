-- ============================================================
-- MRTD: experience.
--
-- Dropped by the boss of a boss wave and by nothing else. The
-- tenth boss is worth ten times the first.
--
-- The profile card has said "Level 1" since the very first
-- version with nothing behind it. This is what puts something
-- behind it.
--
-- Levels are worked out from xp rather than stored, so there is
-- one number to keep and no way for the two to disagree.
--
-- Run once, then this file goes.
-- ============================================================

alter table public.profiles
  add column if not exists xp bigint not null default 0;


-- How much experience each level costs, and what level a given
-- amount of experience is worth.
--
-- 100 for the second level, and each one 40% dearer than the
-- last. Level 10 is around 2,000 and level 25 around 100,000 —
-- so early levels come from a run or two and later ones are a
-- season of them.
create or replace function public.level_for_xp(p_xp bigint)
returns integer
language sql
immutable
as $$
  select greatest(
    1,
    floor(log(1 + (greatest(p_xp, 0)::numeric * 0.4 / 100)) / log(1.4))::integer + 1
  );
$$;

grant execute on function public.level_for_xp(bigint) to authenticated;


-- Awards experience to whoever is still in a run, alongside the
-- coins.
--
-- Same rule as the coins and for the same reason: present
-- players only, worked out in Postgres rather than named by a
-- browser. p_xp is what the run produced; a client claiming a
-- silly number is capped rather than trusted.
create or replace function public.award_run_xp(p_xp integer default 0)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  mine   bigint;
  amount integer;
  total  bigint;
begin
  /* The run this player is in, ended or not — award_run_xp is
     called right after end_party_run has closed it. */
  select r.run_id into mine
  from public.run_players r
  join public.party_runs run on run.id = r.run_id
  where r.player_id = auth.uid()
  order by run.started_at desc
  limit 1;

  /* Wave 500 with every boss killed is a little over 100,000, so
     anything past a quarter of a million did not come from
     playing. */
  amount := least(greatest(coalesce(p_xp, 0), 0), 250000);

  update public.profiles
  set xp = xp + amount
  where id = auth.uid()
  returning xp into total;

  return coalesce(total, 0);
end $$;

grant execute on function public.award_run_xp(integer) to authenticated;


-- Should be level 1 at nothing, and climb from there.
select
  public.level_for_xp(0)      as at_0,
  public.level_for_xp(100)    as at_100,
  public.level_for_xp(2000)   as at_2k,
  public.level_for_xp(100000) as at_100k;
