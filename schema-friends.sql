-- ============================================================
-- MRTD trading between friends.
-- Run AFTER schema.sql, schema-shop.sql and schema-chest.sql.
--
-- Friends themselves use the friendships table and its policies
-- directly. Trading cannot: copies have to leave one collection
-- and arrive in another as a single act, so it lives in these
-- functions.
--
-- Only base copies (evolution 0) are tradeable. An evolution is
-- work someone has already done and stays with them.
-- ============================================================

create table if not exists public.trades (
  id           bigserial primary key,
  from_player  uuid not null references public.profiles(id) on delete cascade,
  to_player    uuid not null references public.profiles(id) on delete cascade,
  offer_key    text not null,
  offer_copies integer not null check (offer_copies > 0),
  want_key     text not null,
  want_copies  integer not null check (want_copies > 0),
  status       text not null default 'pending'
                 check (status in ('pending', 'accepted', 'done', 'cancelled')),
  accepted_at  timestamptz,
  created_at   timestamptz not null default now(),
  constraint no_self_trade check (from_player <> to_player)
);

create index if not exists trades_to_idx on public.trades (to_player, status);
create index if not exists trades_from_idx on public.trades (from_player, status);

alter table public.trades enable row level security;

drop policy if exists "own trades" on public.trades;
create policy "own trades" on public.trades
  for select to authenticated
  using (auth.uid() in (from_player, to_player));

-- How long either side has to pull out after accepting.
create or replace function public.trade_hold_seconds()
returns integer language sql immutable as $$ select 5 $$;

-- Do the two players count as friends?
create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = a and f.addressee_id = b)
        or (f.requester_id = b and f.addressee_id = a))
  );
$$;

-- Copies of a tower a player holds at evolution 0.
create or replace function public.base_copies(player uuid, tower text)
returns integer
language sql
security definer
set search_path = ''
as $$
  select coalesce(
    (select t.copies from public.player_towers t
     where t.player_id = player and t.tower_key = tower and t.evolution = 0),
    0
  );
$$;

-- 1. Propose -----------------------------------------------------
create or replace function public.propose_trade(
  p_to           uuid,
  p_offer_key    text,
  p_offer_copies integer,
  p_want_key     text,
  p_want_copies  integer
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id bigint;
begin
  if not public.are_friends(auth.uid(), p_to) then
    raise exception 'You can only trade with friends';
  end if;

  if p_offer_copies < 1 or p_want_copies < 1
     or p_offer_copies > 999 or p_want_copies > 999 then
    raise exception 'Copies must be between 1 and 999';
  end if;

  if public.base_copies(auth.uid(), p_offer_key) < p_offer_copies then
    raise exception 'You do not have that many to give';
  end if;

  insert into public.trades
    (from_player, to_player, offer_key, offer_copies, want_key, want_copies)
  values
    (auth.uid(), p_to, p_offer_key, p_offer_copies, p_want_key, p_want_copies)
  returning id into new_id;

  return new_id;
end $$;

-- 2. Accept, starting the hold ----------------------------------
create or replace function public.accept_trade(p_id bigint)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  deal public.trades;
begin
  select * into deal from public.trades where id = p_id for update;

  if deal.id is null then
    raise exception 'No such trade';
  end if;

  if deal.to_player <> auth.uid() then
    raise exception 'Only the recipient can accept';
  end if;

  if deal.status <> 'pending' then
    raise exception 'That trade is no longer open';
  end if;

  if public.base_copies(auth.uid(), deal.want_key) < deal.want_copies then
    raise exception 'You do not have that many to give';
  end if;

  update public.trades
  set status = 'accepted', accepted_at = now()
  where id = p_id;

  return now() + make_interval(secs => public.trade_hold_seconds());
end $$;

-- 3. Pull out ----------------------------------------------------
-- Either side, at any point before it settles.
create or replace function public.cancel_trade(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  deal public.trades;
begin
  select * into deal from public.trades where id = p_id for update;

  if deal.id is null then
    raise exception 'No such trade';
  end if;

  if auth.uid() not in (deal.from_player, deal.to_player) then
    raise exception 'Not your trade';
  end if;

  if deal.status not in ('pending', 'accepted') then
    raise exception 'That trade is already finished';
  end if;

  update public.trades set status = 'cancelled' where id = p_id;

  return true;
end $$;

-- 4. Settle ------------------------------------------------------
-- Runs only once the hold has elapsed, and moves both sides in one
-- statement each so a trade cannot half happen.
create or replace function public.settle_trade(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  deal public.trades;
begin
  select * into deal from public.trades where id = p_id for update;

  if deal.id is null then
    raise exception 'No such trade';
  end if;

  if auth.uid() not in (deal.from_player, deal.to_player) then
    raise exception 'Not your trade';
  end if;

  if deal.status = 'done' then
    return true;
  end if;

  if deal.status <> 'accepted' then
    raise exception 'That trade is not accepted';
  end if;

  if deal.accepted_at + make_interval(secs => public.trade_hold_seconds()) > now() then
    raise exception 'Still within the withdrawal window';
  end if;

  /* Both sides are rechecked here: someone may have spent the
     copies while the hold was running. */
  if public.base_copies(deal.from_player, deal.offer_key) < deal.offer_copies
     or public.base_copies(deal.to_player, deal.want_key) < deal.want_copies then
    update public.trades set status = 'cancelled' where id = p_id;
    raise exception 'Someone no longer has the cards — trade cancelled';
  end if;

  update public.player_towers set copies = copies - deal.offer_copies
  where player_id = deal.from_player and tower_key = deal.offer_key and evolution = 0;

  update public.player_towers set copies = copies - deal.want_copies
  where player_id = deal.to_player and tower_key = deal.want_key and evolution = 0;

  insert into public.player_towers (player_id, tower_key, evolution, copies)
  values (deal.to_player, deal.offer_key, 0, deal.offer_copies)
  on conflict (player_id, tower_key, evolution)
  do update set copies = public.player_towers.copies + deal.offer_copies;

  insert into public.player_towers (player_id, tower_key, evolution, copies)
  values (deal.from_player, deal.want_key, 0, deal.want_copies)
  on conflict (player_id, tower_key, evolution)
  do update set copies = public.player_towers.copies + deal.want_copies;

  update public.trades set status = 'done' where id = p_id;

  return true;
end $$;

grant execute on function public.trade_hold_seconds() to authenticated;
grant execute on function public.are_friends(uuid, uuid) to authenticated;
grant execute on function public.base_copies(uuid, text) to authenticated;
grant execute on function public.propose_trade(uuid, text, integer, text, integer) to authenticated;
grant execute on function public.accept_trade(bigint) to authenticated;
grant execute on function public.cancel_trade(bigint) to authenticated;
grant execute on function public.settle_trade(bigint) to authenticated;
