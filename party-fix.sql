-- ============================================================
-- Fix: accept_party_invite could not be called at all.
--
--   FOR UPDATE is not allowed with aggregate functions
--
-- It counted the party and locked in the same statement:
--
--   select count(*) into headcount
--   from public.party_members m
--   where m.party_id = invite.party_id
--   for update;              <-- Postgres refuses this
--
-- A row lock has to name rows, and an aggregate has already
-- collapsed them, so there is nothing left to lock.
--
-- The lock was there to stop two people taking the fifth seat at
-- the same instant, which is still worth preventing. Locking the
-- PARTY row does the same job better: two accepts for the same
-- party queue behind each other, so the second one counts a
-- table the first has already inserted into.
--
-- Nothing else in the file changes.
-- Run once, then this file goes.
-- ============================================================

create or replace function public.accept_party_invite(p_id bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite    public.party_invites;
  headcount integer;
begin
  select * into invite
  from public.party_invites
  where id = p_id and to_player = auth.uid()
  for update;

  if invite.id is null then
    raise exception 'No such invite';
  end if;

  if invite.status <> 'pending' then
    raise exception 'That invite is no longer open';
  end if;

  if public.my_party() is not null then
    raise exception 'Leave your current party first';
  end if;

  /* Serialises accepts for this party. Anyone else accepting at
     the same moment waits here, and then counts the seats after
     this one has taken theirs rather than alongside it. */
  perform 1 from public.parties where id = invite.party_id for update;

  select count(*) into headcount
  from public.party_members m
  where m.party_id = invite.party_id;

  if headcount >= 5 then
    raise exception 'That party is full';
  end if;

  insert into public.party_members (party_id, player_id)
  values (invite.party_id, auth.uid());

  update public.party_invites set status = 'accepted' where id = p_id;

  return invite.party_id;
end $$;

grant execute on function public.accept_party_invite(bigint) to authenticated;
