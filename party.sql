-- ============================================================
-- MRTD parties: up to five players in one run.
--
-- A player is in at most one party at a time, which is enforced
-- by the join rather than left to the browser. Everything that
-- changes membership is a security definer function, so a client
-- can ask to join and cannot write itself in.
--
-- This is the lobby half. Playing together needs a live channel
-- between the browsers as well; nothing here knows about that.
--
-- Run once, then this file goes.
-- ============================================================

create table if not exists public.parties (
  id          bigint generated always as identity primary key,
  leader      uuid not null references auth.users (id) on delete cascade,
  status      text not null default 'open',
  created_at  timestamptz not null default now()
);

create table if not exists public.party_members (
  party_id    bigint not null references public.parties (id) on delete cascade,
  player_id   uuid not null references auth.users (id) on delete cascade,
  joined_at   timestamptz not null default now(),
  primary key (party_id, player_id)
);

-- One party per player, enforced in the table rather than by
-- remembering to check.
create unique index if not exists party_members_one_each
  on public.party_members (player_id);

create table if not exists public.party_invites (
  id          bigint generated always as identity primary key,
  party_id    bigint not null references public.parties (id) on delete cascade,
  from_player uuid not null references auth.users (id) on delete cascade,
  to_player   uuid not null references auth.users (id) on delete cascade,
  status      text not null default 'pending',
  created_at  timestamptz not null default now(),
  unique (party_id, to_player)
);

-- ============================================================
-- Runs
--
-- A party is who you are with. A RUN is the match in progress,
-- and they are separate on purpose: a player can walk out of a
-- run and come back to it, and the run has to outlive their
-- absence for that to work.
--
-- `present` is the whole point of run_players. Someone who
-- leaves stays on the row with present = false, so:
--
--   their towers are still theirs and stay on the board
--   they can rejoin the same run
--   they cannot start or join a different one
--   and if the run ends while they are away, they are not paid
--
-- A row is never deleted while a run lives. Deleting it would
-- lose the answer to every one of those questions.
-- ============================================================

create table if not exists public.party_runs (
  id          bigint generated always as identity primary key,
  party_id    bigint not null references public.parties (id) on delete cascade,
  status      text not null default 'running',
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);

create table if not exists public.run_players (
  run_id      bigint not null references public.party_runs (id) on delete cascade,
  player_id   uuid not null references auth.users (id) on delete cascade,
  present     boolean not null default true,
  left_at     timestamptz,
  paid        boolean not null default false,
  primary key (run_id, player_id)
);

-- Finding "the run this player is still tied to" happens on
-- every join, leave and start, so it is worth an index.
create index if not exists run_players_by_player
  on public.run_players (player_id);

alter table public.parties        enable row level security;
alter table public.party_members  enable row level security;
alter table public.party_invites  enable row level security;
alter table public.party_runs     enable row level security;
alter table public.run_players    enable row level security;

drop policy if exists party_runs_read on public.party_runs;
create policy party_runs_read on public.party_runs
  for select to authenticated
  using (
    exists (
      select 1 from public.run_players r
      where r.run_id = party_runs.id and r.player_id = auth.uid()
    )
  );

drop policy if exists run_players_read on public.run_players;
create policy run_players_read on public.run_players
  for select to authenticated
  using (
    exists (
      select 1 from public.run_players mine
      where mine.run_id = run_players.run_id and mine.player_id = auth.uid()
    )
  );


-- ============================================================
-- Reading
--
-- You can see the party you are in, and invites addressed to
-- you. Nothing else.
-- ============================================================

drop policy if exists parties_read on public.parties;
create policy parties_read on public.parties
  for select to authenticated
  using (
    exists (
      select 1 from public.party_members m
      where m.party_id = parties.id and m.player_id = auth.uid()
    )
    or exists (
      select 1 from public.party_invites i
      where i.party_id = parties.id
        and i.to_player = auth.uid()
        and i.status = 'pending'
    )
  );

drop policy if exists party_members_read on public.party_members;
create policy party_members_read on public.party_members
  for select to authenticated
  using (
    exists (
      select 1 from public.party_members mine
      where mine.party_id = party_members.party_id
        and mine.player_id = auth.uid()
    )
  );

drop policy if exists party_invites_read on public.party_invites;
create policy party_invites_read on public.party_invites
  for select to authenticated
  using (to_player = auth.uid() or from_player = auth.uid());


-- ============================================================
-- Membership
-- ============================================================

-- Whichever party the caller is in, or null.
create or replace function public.my_party()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select m.party_id from public.party_members m where m.player_id = auth.uid();
$$;

-- Makes a party with the caller as leader, or returns the one
-- they are already in. Calling it twice is not an error.
create or replace function public.create_party()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing bigint;
  fresh    bigint;
begin
  existing := public.my_party();

  if existing is not null then
    return existing;
  end if;

  insert into public.parties (leader) values (auth.uid())
  returning id into fresh;

  insert into public.party_members (party_id, player_id)
  values (fresh, auth.uid());

  return fresh;
end $$;

-- Leader only, and only to someone on your friends list. Making
-- a party first if there is not one yet, so inviting is a single
-- action from the player's side.
create or replace function public.invite_to_party(p_to uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_party bigint;
  headcount    integer;
begin
  if p_to = auth.uid() then
    raise exception 'You are already in your own party';
  end if;

  target_party := public.create_party();

  if not exists (
    select 1 from public.parties p
    where p.id = target_party and p.leader = auth.uid()
  ) then
    raise exception 'Only the party leader can invite';
  end if;

  /* Accepted friendships only — a pending request is not yet
     someone you can drag into a run. */
  if not exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and (
        (f.requester_id = auth.uid() and f.addressee_id = p_to) or
        (f.addressee_id = auth.uid() and f.requester_id = p_to)
      )
  ) then
    raise exception 'You can only invite friends';
  end if;

  select count(*) into headcount
  from public.party_members m where m.party_id = target_party;

  if headcount >= 5 then
    raise exception 'A party holds five';
  end if;

  insert into public.party_invites (party_id, from_player, to_player)
  values (target_party, auth.uid(), p_to)
  on conflict (party_id, to_player)
  do update set status = 'pending', created_at = now();

  return target_party;
end $$;

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

  /* Counted inside the same statement that inserts, so two
     people accepting the fifth seat at once cannot both get in. */
  select count(*) into headcount
  from public.party_members m
  where m.party_id = invite.party_id
  for update;

  if headcount >= 5 then
    raise exception 'That party is full';
  end if;

  insert into public.party_members (party_id, player_id)
  values (invite.party_id, auth.uid());

  update public.party_invites set status = 'accepted' where id = p_id;

  return invite.party_id;
end $$;

create or replace function public.decline_party_invite(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.party_invites
  set status = 'declined'
  where id = p_id and to_player = auth.uid() and status = 'pending';

  return found;
end $$;

-- Leaving as the leader hands the party to whoever has been in
-- it longest. The last one out closes it, so an empty party is
-- never left sitting there holding invites open.
create or replace function public.leave_party()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  mine      bigint;
  is_leader boolean;
  heir      uuid;
begin
  mine := public.my_party();

  if mine is null then
    return false;
  end if;

  select (p.leader = auth.uid()) into is_leader
  from public.parties p where p.id = mine;

  delete from public.party_members
  where party_id = mine and player_id = auth.uid();

  if is_leader then
    select m.player_id into heir
    from public.party_members m
    where m.party_id = mine
    order by m.joined_at asc
    limit 1;

    if heir is null then
      delete from public.parties where id = mine;
    else
      update public.parties set leader = heir where id = mine;
    end if;
  end if;

  return true;
end $$;

-- Leader only. Used to remove someone who has gone quiet.
create or replace function public.kick_from_party(p_player uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  mine bigint;
begin
  mine := public.my_party();

  if mine is null or p_player = auth.uid() then
    return false;
  end if;

  if not exists (
    select 1 from public.parties p
    where p.id = mine and p.leader = auth.uid()
  ) then
    raise exception 'Only the party leader can remove someone';
  end if;

  delete from public.party_members
  where party_id = mine and player_id = p_player;

  return true;
end $$;


-- ============================================================
-- Starting
--
-- The leader starts whenever they like. Outstanding invites do
-- NOT hold it up — waiting on someone who has not opened the
-- game means one person can stall four, and there is no way to
-- tell "thinking about it" from "not there".
--
-- So starting takes whoever has actually accepted at that
-- moment, and every pending invite is closed on the way out.
-- Someone who accepts a second too late gets told the party has
-- gone rather than joining a run already in progress.
-- ============================================================

-- The run the caller is still tied to, present or not. Null once
-- it has ended. This is what blocks starting a second run: while
-- this returns something, you belong to a match already.
create or replace function public.my_run()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select r.run_id
  from public.run_players r
  join public.party_runs run on run.id = r.run_id
  where r.player_id = auth.uid() and run.status = 'running'
  limit 1;
$$;

create or replace function public.start_party_run()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  mine    bigint;
  fresh   bigint;
  stale   bigint;
begin
  mine := public.my_party();

  if mine is null then
    raise exception 'You are not in a party';
  end if;

  if not exists (
    select 1 from public.parties p
    where p.id = mine and p.leader = auth.uid()
  ) then
    raise exception 'Only the party leader can start';
  end if;

  /* You belong to one match at a time. Someone who walked out of
     a run that is still going has to go back to it or see it
     finish — starting a fresh one would leave their towers
     standing in a game they are no longer accountable to. */
  stale := public.my_run();

  if stale is not null then
    raise exception 'You are still in a run — rejoin or wait for it to end';
  end if;

  update public.parties set status = 'playing' where id = mine;

  /* Anyone who had not answered has missed it. Closing these
     rather than leaving them pending is what stops a late accept
     dropping someone into a run that has already been sized for
     fewer players. */
  update public.party_invites
  set status = 'declined'
  where party_id = mine and status = 'pending';

  insert into public.party_runs (party_id) values (mine)
  returning id into fresh;

  /* Everyone in the party at this moment is in the run, and
     anyone already tied to another run is skipped rather than
     dragged into a second one. */
  insert into public.run_players (run_id, player_id)
  select fresh, m.player_id
  from public.party_members m
  where m.party_id = mine
    and not exists (
      select 1
      from public.run_players r
      join public.party_runs run on run.id = r.run_id
      where r.player_id = m.player_id and run.status = 'running'
    );

  return public.party_state();
end $$;

-- Stepping out. The row stays, marked absent, so the towers keep
-- their owner and the seat keeps its claim.
create or replace function public.leave_run()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  mine      bigint;
  remaining integer;
begin
  mine := public.my_run();

  if mine is null then
    return false;
  end if;

  update public.run_players
  set present = false, left_at = now()
  where run_id = mine and player_id = auth.uid();

  /* The last one out ends it. A run with nobody in it has no
     host simulating it, so leaving it 'running' would block
     everyone in it from ever starting another. */
  select count(*) into remaining
  from public.run_players
  where run_id = mine and present;

  if remaining = 0 then
    update public.party_runs
    set status = 'ended', ended_at = now()
    where id = mine;

    update public.parties set status = 'open'
    where id = (select party_id from public.party_runs where id = mine);
  end if;

  return true;
end $$;

-- Coming back. Only to the run you were already in, only while
-- it is still going, and only while somebody is still there to
-- be simulating it.
create or replace function public.rejoin_run()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  mine    bigint;
  present integer;
begin
  mine := public.my_run();

  if mine is null then
    raise exception 'That run has finished';
  end if;

  select count(*) into present
  from public.run_players
  where run_id = mine and present;

  if present = 0 then
    raise exception 'Everyone has left that run';
  end if;

  update public.run_players
  set present = true, left_at = null
  where run_id = mine and player_id = auth.uid();

  return mine;
end $$;

-- Ends the run and pays whoever is still in it.
--
-- Called by the host when the base falls or the party leaves. The
-- reward is worked out here rather than sent from the browser,
-- because a client that names its own payout is a client that
-- names a large one.
create or replace function public.end_party_run(p_waves integer default 0)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  mine   bigint;
  reward integer;
  paid   integer := 0;
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
     leaving strictly better than staying. */
  with payees as (
    update public.run_players
    set paid = true
    where run_id = mine and present and not paid
    returning player_id
  )
  update public.profiles p
  set coins = p.coins + reward
  from payees
  where p.id = payees.player_id;

  get diagnostics paid = row_count;

  update public.parties set status = 'open'
  where id = (select party_id from public.party_runs where id = mine);

  return paid;
end $$;


-- ============================================================
-- What the browser reads
--
-- One call for the whole panel: who is in the party, who leads
-- it, and any invite waiting for you. Usernames are joined here
-- so the client does not need a second round trip or a readable
-- profiles table.
-- ============================================================

create or replace function public.party_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  mine    bigint;
  run     bigint;
  result  jsonb;
begin
  mine := public.my_party();
  run := public.my_run();

  select jsonb_build_object(
    'party_id', mine,
    'leader', (select p.leader from public.parties p where p.id = mine),
    'status', (select p.status from public.parties p where p.id = mine),

    /* The run the caller is tied to, if any, and whether they are
       currently in it. A client that is absent from a live run
       shows "Rejoin" rather than "Play". */
    'run_id', run,
    'run_present', coalesce((
      select r.present from public.run_players r
      where r.run_id = run and r.player_id = auth.uid()
    ), false),

    /* Who is actually on the board right now — this is the number
       enemy health multiplies by. */
    'run_present_count', coalesce((
      select count(*) from public.run_players r
      where r.run_id = run and r.present
    ), 0),
    'members', coalesce((
      select jsonb_agg(
               jsonb_build_object('id', m.player_id, 'username', pr.username)
               order by m.joined_at
             )
      from public.party_members m
      join public.profiles pr on pr.id = m.player_id
      where m.party_id = mine
    ), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', i.id,
                 'party_id', i.party_id,
                 'from', pr.username
               )
               order by i.created_at desc
             )
      from public.party_invites i
      join public.profiles pr on pr.id = i.from_player
      where i.to_player = auth.uid() and i.status = 'pending'
    ), '[]'::jsonb)
  ) into result;

  return result;
end $$;

grant execute on function public.my_party() to authenticated;
grant execute on function public.create_party() to authenticated;
grant execute on function public.invite_to_party(uuid) to authenticated;
grant execute on function public.accept_party_invite(bigint) to authenticated;
grant execute on function public.decline_party_invite(bigint) to authenticated;
grant execute on function public.leave_party() to authenticated;
grant execute on function public.kick_from_party(uuid) to authenticated;
grant execute on function public.start_party_run() to authenticated;
grant execute on function public.end_party_run(integer) to authenticated;
grant execute on function public.my_run() to authenticated;
grant execute on function public.leave_run() to authenticated;
grant execute on function public.rejoin_run() to authenticated;
grant execute on function public.party_state() to authenticated;

select public.party_state() as state;
