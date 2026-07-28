-- ============================================================
-- MRTD: lock the live channel to the run it belongs to.
--
-- Party matches talk over a Supabase Realtime broadcast channel
-- named after the run:
--
--   run:41
--
-- Until now that channel was public. Nobody could cheat with it
-- — rewards and membership are decided in Postgres, and this
-- carries nothing the database trusts — but anyone who guessed a
-- run id could sit and watch someone else's game.
--
-- Marking the channel private makes Realtime check RLS on
-- realtime.messages before letting anyone on. The rule is the
-- obvious one: you may read and write a run's channel if you are
-- one of its players.
--
-- Note it is run_players, not present-only. A player who has
-- stepped out has to be able to rejoin, and rejoining means
-- getting back on the channel.
--
-- Run once, then this file goes.
-- ============================================================

-- Pulls the run id out of a topic name, or null if the topic is
-- not one of ours.
--
-- Null is the point. A policy comparing run_id to null matches
-- nothing, so any topic that is not exactly "run:<digits>" is
-- refused without the cast ever being attempted. Casting
-- whatever arrived straight to bigint would throw on the first
-- oddly named channel and take the policy with it.
create or replace function public.topic_run_id(topic text)
returns bigint
language sql
immutable
as $$
  select case
    when topic ~ '^run:[0-9]+$' then substring(topic from 5)::bigint
    else null
  end;
$$;

grant execute on function public.topic_run_id(text) to authenticated;


-- Reading the channel: subscribing, and receiving what others
-- broadcast.
drop policy if exists "mrtd run channel read" on realtime.messages;
create policy "mrtd run channel read"
on realtime.messages
for select
to authenticated
using (
  exists (
    select 1
    from public.run_players r
    where r.run_id = public.topic_run_id(realtime.topic())
      and r.player_id = auth.uid()
  )
);

-- Writing to it: broadcasting.
drop policy if exists "mrtd run channel write" on realtime.messages;
create policy "mrtd run channel write"
on realtime.messages
for insert
to authenticated
with check (
  exists (
    select 1
    from public.run_players r
    where r.run_id = public.topic_run_id(realtime.topic())
      and r.player_id = auth.uid()
  )
);


-- Should return the number, so the extraction works.
select public.topic_run_id('run:41') as should_be_41,
       public.topic_run_id('run:nope') as should_be_null,
       public.topic_run_id('realtime:run:41') as should_also_be_null;
