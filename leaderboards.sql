-- ============================================================
-- MRTD leaderboards.
--
-- Three views of the same data:
--
--   weekly   the top 50 RUNS of the current week, by wave then
--            by how little game time it took
--   friends  the people on your list, by level or by best wave
--   global   everybody, by level or by best wave
--
-- And one thing that only exists because of them: the Obelisk,
-- handed out when the week resets to the players who were on the
-- weekly board. It is not in chest_odds and never will be, so
-- there is no other way to get one.
--
-- The reset is lazy rather than scheduled. Nothing here needs
-- pg_cron: the first person to open a leaderboard in a new week
-- settles the previous one, and a table of already-settled weeks
-- makes sure it happens exactly once however many people open it
-- at the same moment.
--
-- Run once, then this file goes.
-- ============================================================

alter table public.profiles
  add column if not exists best_wave integer not null default 0;

-- Game seconds of the run that set best_wave. Kept so the
-- all-time board can break ties the same way the weekly one
-- does: further first, then faster.
alter table public.profiles
  add column if not exists best_time integer not null default 0;


-- Every finished run worth ranking. Fun runs never reach here.
create table if not exists public.run_scores (
  id           bigint generated always as identity primary key,
  player_id    uuid not null references auth.users (id) on delete cascade,
  wave         integer not null,
  game_seconds integer not null,
  ended_at     timestamptz not null default now()
);

create index if not exists run_scores_week
  on public.run_scores (ended_at desc, wave desc);

create index if not exists run_scores_player
  on public.run_scores (player_id);


-- Which weeks have already paid out. One row per week, and the
-- primary key is what stops two people settling the same week.
create table if not exists public.weeks_settled (
  week_start timestamptz primary key,
  settled_at timestamptz not null default now(),
  winners    integer not null default 0
);

alter table public.run_scores    enable row level security;
alter table public.weeks_settled enable row level security;

-- Scores are public — that is the entire point of a leaderboard.
drop policy if exists run_scores_read on public.run_scores;
create policy run_scores_read on public.run_scores
  for select to authenticated using (true);

drop policy if exists weeks_settled_read on public.weeks_settled;
create policy weeks_settled_read on public.weeks_settled
  for select to authenticated using (true);


-- ============================================================
-- Recording a run
-- ============================================================

create or replace function public.record_run(
  p_wave integer default 0,
  p_seconds integer default 0
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  waves   integer;
  seconds integer;
begin
  /* Wave 500 is the end of the game and an hour and a half of
     game time is already implausible, so anything past these did
     not come from playing. Clamped rather than rejected — a
     silly number should not lose an honest run. */
  waves := least(greatest(coalesce(p_wave, 0), 0), 500);
  seconds := least(greatest(coalesce(p_seconds, 0), 0), 360000);

  if waves <= 0 then
    return;
  end if;

  insert into public.run_scores (player_id, wave, game_seconds)
  values (auth.uid(), waves, seconds);

  /* Best ever. Further wins; if the wave ties, the quicker run
     replaces the slower one. */
  update public.profiles p
  set best_wave = waves,
      best_time = seconds
  where p.id = auth.uid()
    and (
      waves > p.best_wave
      or (waves = p.best_wave and (p.best_time = 0 or seconds < p.best_time))
    );
end $$;


-- ============================================================
-- Settling a week
--
-- Called by whoever opens a leaderboard first in a new week.
-- Everything is inside one statement per step, so a dozen
-- clients calling it at once still pay exactly one set of
-- prizes: the insert into weeks_settled either wins or does
-- nothing, and the rest only runs if it won.
--
-- THE PRIZE IS TURNED OFF. Everything else works: weeks are
-- claimed, settled and recorded, and the boards read correctly.
-- Nothing is handed out.
--
-- With only a handful of players, everyone would place on the
-- first board and a brand new account would be given the best
-- tower in the game in its first week. The Obelisk exists in the
-- game files and can be granted by hand; it is not earned by
-- anybody yet.
--
-- To turn it on, uncomment the block below. One Obelisk to
-- everybody on the board, no tiers — the prize is being on it.
-- ============================================================

create or replace function public.settle_week()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  this_week timestamptz := date_trunc('week', now());
  last_week timestamptz := date_trunc('week', now()) - interval '7 days';
  paid      integer := 0;
begin
  /* Claims the week. If another client got here first this does
     nothing and we stop — no double payouts. */
  insert into public.weeks_settled (week_start)
  values (last_week)
  on conflict (week_start) do nothing;

  if not found then
    return 0;
  end if;

  /* ---- THE PRIZE, TURNED OFF -----------------------------
     Uncomment to start handing Obelisks out. One each to
     everybody in the top fifty; being on the board is the
     prize, so there are no tiers.

  insert into public.player_towers as pt
    (player_id, tower_key, evolution, copies, shiny)
  select s.player_id, 'obelisk', 0, 1, false
  from public.run_scores s
  where s.ended_at >= last_week and s.ended_at < this_week
  group by s.player_id
  order by max(s.wave) desc, min(s.game_seconds) asc
  limit 50
  on conflict (player_id, tower_key, evolution, shiny)
  do update set copies = pt.copies + 1;

  get diagnostics paid = row_count;
     -------------------------------------------------------- */

  /* Counted anyway, so the record says who WOULD have been paid
     and the week still reads as settled. */
  select count(*) into paid
  from (
    select s.player_id
    from public.run_scores s
    where s.ended_at >= last_week and s.ended_at < this_week
    group by s.player_id
    limit 50
  ) as board;

  update public.weeks_settled
  set winners = paid
  where week_start = last_week;

  return paid;
end $$;


-- ============================================================
-- Reading the boards
-- ============================================================

-- The top 50 runs of the current week. One entry per player,
-- their best: further first, then whoever got there in less game
-- time.
create or replace function public.board_weekly()
returns table (
  place     integer,
  username  text,
  wave      integer,
  seconds   integer,
  is_me     boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    row_number() over (
      order by max(s.wave) desc, min(s.game_seconds) asc
    )::integer,
    pr.username,
    max(s.wave)::integer,
    min(s.game_seconds)::integer,
    (s.player_id = auth.uid())
  from public.run_scores s
  join public.profiles pr on pr.id = s.player_id
  where s.ended_at >= date_trunc('week', now())
  group by s.player_id, pr.username
  order by max(s.wave) desc, min(s.game_seconds) asc
  limit 50;
$$;

-- All time, by level or by best wave. `p_friends` narrows it to
-- the caller's accepted friends, plus the caller.
create or replace function public.board_all(
  p_sort text default 'wave',
  p_friends boolean default false
)
returns table (
  place     integer,
  username  text,
  level     integer,
  xp        bigint,
  wave      integer,
  seconds   integer,
  is_me     boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    row_number() over (
      order by
        case when p_sort = 'level' then pr.xp else pr.best_wave end desc,
        case when p_sort = 'level' then 0 else pr.best_time end asc,
        pr.username asc
    )::integer,
    pr.username,
    public.level_for_xp(pr.xp),
    pr.xp,
    pr.best_wave,
    pr.best_time,
    (pr.id = auth.uid())
  from public.profiles pr
  where
    (not p_friends or pr.id = auth.uid() or exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and (
          (f.requester_id = auth.uid() and f.addressee_id = pr.id) or
          (f.addressee_id = auth.uid() and f.requester_id = pr.id)
        )
    ))
    /* Nobody who has never finished a run and never earned
       anything — an empty board of empty accounts helps no one. */
    and (pr.best_wave > 0 or pr.xp > 0)
  order by
    case when p_sort = 'level' then pr.xp else pr.best_wave end desc,
    case when p_sort = 'level' then 0 else pr.best_time end asc,
    pr.username asc
  limit 50;
$$;

grant execute on function public.record_run(integer, integer) to authenticated;
grant execute on function public.settle_week() to authenticated;
grant execute on function public.board_weekly() to authenticated;
grant execute on function public.board_all(text, boolean) to authenticated;

select
  date_trunc('week', now())                        as week_started,
  date_trunc('week', now()) + interval '7 days'    as week_resets;
