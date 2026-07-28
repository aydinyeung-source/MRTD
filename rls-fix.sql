-- ============================================================
-- Fix: nobody can join a run's live channel.
--
--   Unauthorized: You do not have permissions to read from
--   this Channel topic: run:4
--
-- The policy on realtime.messages asks "is this player in
-- run_players for this run". Reading run_players runs
-- run_players' OWN policy, which is:
--
--   using (exists (select 1 from public.run_players mine
--                  where mine.run_id = run_players.run_id
--                    and mine.player_id = auth.uid()))
--
-- — a policy on run_players that reads run_players. It cannot
-- resolve itself, so it denies, and the join is refused.
--
-- The party tables have the same shape and never showed it,
-- because everything that touches them goes through a security
-- definer function, and those bypass RLS completely. The
-- realtime policy is the first thing to query these tables as
-- the player, so it is the first thing to hit the loop.
--
-- The fix is a security definer helper for the membership
-- question. It answers without RLS, so nothing recurses, and
-- both the realtime policy and the table's own policy can call
-- it.
--
-- Run once, then this file goes.
-- ============================================================

-- Is the caller in this run at all — present or stepped out.
-- Not present-only: someone who left has to be able to get back
-- on the channel to rejoin.
create or replace function public.in_run(p_run bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.run_players r
    where r.run_id = p_run and r.player_id = auth.uid()
  );
$$;

create or replace function public.in_party(p_party bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.party_members m
    where m.party_id = p_party and m.player_id = auth.uid()
  );
$$;

grant execute on function public.in_run(bigint) to authenticated;
grant execute on function public.in_party(bigint) to authenticated;


-- ============================================================
-- The table policies, rewritten to ask the helper instead of
-- asking themselves.
-- ============================================================

drop policy if exists run_players_read on public.run_players;
create policy run_players_read on public.run_players
  for select to authenticated
  using (public.in_run(run_players.run_id));

drop policy if exists party_runs_read on public.party_runs;
create policy party_runs_read on public.party_runs
  for select to authenticated
  using (public.in_run(party_runs.id));

drop policy if exists party_members_read on public.party_members;
create policy party_members_read on public.party_members
  for select to authenticated
  using (public.in_party(party_members.party_id));

drop policy if exists parties_read on public.parties;
create policy parties_read on public.parties
  for select to authenticated
  using (
    public.in_party(parties.id)
    or exists (
      select 1 from public.party_invites i
      where i.party_id = parties.id
        and i.to_player = auth.uid()
        and i.status = 'pending'
    )
  );


-- ============================================================
-- The live channel, now asking a question that can be answered.
-- ============================================================

drop policy if exists "mrtd run channel read" on realtime.messages;
create policy "mrtd run channel read"
on realtime.messages
for select
to authenticated
using (public.in_run(public.topic_run_id(realtime.topic())));

drop policy if exists "mrtd run channel write" on realtime.messages;
create policy "mrtd run channel write"
on realtime.messages
for insert
to authenticated
with check (public.in_run(public.topic_run_id(realtime.topic())));


-- ============================================================
-- Separately: end_party_run is answering 400.
--
-- This prints what actually exists. More than one row means the
-- old no-argument version is still there beside the new one, and
-- a call with one argument cannot choose between them — the same
-- overload trap that broke trading twice.
-- ============================================================

select
  p.proname                                 as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('end_party_run', 'start_party_run', 'leave_run', 'rejoin_run')
order by p.proname, arguments;
