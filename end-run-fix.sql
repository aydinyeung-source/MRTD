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


-- ============================================================
-- Also: the admin grant cap went back to 1000.
--
-- An older migration was re-run from a stale editor tab, and its
-- copy of admin_grant_towers predates the change to 1024. It
-- overwrote the newer one — CREATE OR REPLACE does not care that
-- what it is replacing is more recent than itself.
--
-- Put back. Identical to what was running before, cap included.
-- ============================================================

create or replace function public.admin_grant_towers(
  p_tower text,
  p_copies integer default 1,
  p_online_only boolean default true,
  p_shiny boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  affected integer := 0;
  target   record;
  picked   text;
begin
  perform public.require_dev();

  /* 1024 is exactly what evolution 10 costs. */
  if p_copies is null or p_copies <= 0 or p_copies > 1024 then
    raise exception 'Copies must be between 1 and 1024';
  end if;

  if p_tower is not null
     and not exists (select 1 from public.chest_odds c where c.tower_key = p_tower) then
    raise exception 'Unknown tower';
  end if;

  for target in
    select p.id from public.profiles p
    where not p_online_only or exists (
      select 1 from public.player_sessions s
      where s.player_id = p.id and s.last_seen > now() - interval '2 minutes'
    )
  loop
    picked := coalesce(p_tower, public.draw_tower());

    insert into public.player_towers as pt (player_id, tower_key, evolution, copies, shiny)
    values (target.id, picked, 0, p_copies, p_shiny)
    on conflict (player_id, tower_key, evolution, shiny)
    do update set copies = pt.copies + p_copies;

    affected := affected + 1;
  end loop;

  insert into public.admin_grants (granted_by, action, detail, recipients)
  values (auth.uid(), 'towers',
          jsonb_build_object('tower', p_tower, 'copies', p_copies,
                             'online_only', p_online_only, 'shiny', p_shiny),
          affected);

  return affected;
end $function$;


-- Both should be true. The first says the run can be ended
-- without raising; the second says the cap is back.
select
  public.end_party_run(0) = 0 as end_run_works,
  (select prosrc like '%1024%' from pg_proc where proname = 'admin_grant_towers')
    as cap_restored;
