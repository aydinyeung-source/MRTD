-- ============================================================
-- MRTD live trading.
-- Run AFTER schema-friends.sql. Replaces the fixed-offer trade
-- with a session both players edit together.
--
-- Flow: request -> accept -> both edit freely -> both lock ->
-- five second hold -> settles. Any edit clears both locks, so
-- nobody can change the deal after the other has agreed to it.
-- ============================================================

drop function if exists public.propose_trade(uuid, text, integer, text, integer);
drop function if exists public.accept_trade(bigint);
drop function if exists public.settle_trade(bigint);
drop function if exists public.cancel_trade(bigint);
drop table if exists public.trades cascade;

create table public.trades (
  id         bigserial primary key,
  player_a   uuid not null references public.profiles(id) on delete cascade,
  player_b   uuid not null references public.profiles(id) on delete cascade,
  status     text not null default 'requested'
               check (status in ('requested', 'open', 'locked', 'done', 'cancelled')),
  a_locked   boolean not null default false,
  b_locked   boolean not null default false,
  locked_at  timestamptz,
  created_at timestamptz not null default now(),
  constraint no_self_trade check (player_a <> player_b)
);

create index if not exists trades_party_idx on public.trades (player_a, player_b, status);

-- Evolution is part of what is being traded, so an evolved copy
-- is a different item from a base one of the same tower.
create table public.trade_items (
  trade_id  bigint  not null references public.trades(id) on delete cascade,
  player_id uuid    not null references public.profiles(id) on delete cascade,
  tower_key text    not null,
  evolution integer not null default 0 check (evolution between 0 and 10),
  copies    integer not null check (copies > 0),
  primary key (trade_id, player_id, tower_key, evolution)
);

-- Copies a player holds of one tower at one evolution.
create or replace function public.copies_at(
  player    uuid,
  tower     text,
  evolution integer
)
returns integer
language sql
security definer
set search_path = ''
as $$
  select coalesce(
    (select t.copies from public.player_towers t
     where t.player_id = player
       and t.tower_key = tower
       and t.evolution = copies_at.evolution),
    0
  );
$$;

alter table public.trades enable row level security;
alter table public.trade_items enable row level security;

drop policy if exists "own trades" on public.trades;
create policy "own trades" on public.trades
  for select to authenticated
  using (auth.uid() in (player_a, player_b));

drop policy if exists "own trade items" on public.trade_items;
create policy "own trade items" on public.trade_items
  for select to authenticated
  using (exists (
    select 1 from public.trades t
    where t.id = trade_id and auth.uid() in (t.player_a, t.player_b)
  ));

-- 1. Ask ---------------------------------------------------------
create or replace function public.request_trade(p_to uuid)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  new_id bigint;
begin
  if not public.are_friends(auth.uid(), p_to) then
    raise exception 'You can only trade with friends';
  end if;

  if exists (
    select 1 from public.trades
    where status in ('requested', 'open', 'locked')
      and (auth.uid() in (player_a, player_b) or p_to in (player_a, player_b))
  ) then
    raise exception 'One of you is already in a trade';
  end if;

  insert into public.trades (player_a, player_b)
  values (auth.uid(), p_to)
  returning id into new_id;

  return new_id;
end $$;

-- 2. Answer ------------------------------------------------------
create or replace function public.respond_trade(p_id bigint, p_accept boolean)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  deal public.trades;
begin
  select * into deal from public.trades where id = p_id for update;

  if deal.id is null or deal.player_b <> auth.uid() then
    raise exception 'Not your invitation';
  end if;

  if deal.status <> 'requested' then
    raise exception 'That invitation is no longer open';
  end if;

  update public.trades
  set status = case when p_accept then 'open' else 'cancelled' end
  where id = p_id;

  return case when p_accept then 'open' else 'cancelled' end;
end $$;

-- 3. Edit your side ---------------------------------------------
-- Setting a tower to zero removes it. Every change clears both
-- locks, so an agreed deal can never be altered underneath.
create or replace function public.set_trade_item(
  p_id        bigint,
  p_tower     text,
  p_evolution integer,
  p_copies    integer
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  deal public.trades;
begin
  select * into deal from public.trades where id = p_id for update;

  if deal.id is null or auth.uid() not in (deal.player_a, deal.player_b) then
    raise exception 'Not your trade';
  end if;

  if deal.status not in ('open', 'locked') then
    raise exception 'That trade is not open';
  end if;

  if p_copies < 0 or p_copies > 999 then
    raise exception 'Copies must be between 0 and 999';
  end if;

  if coalesce(p_evolution, 0) < 0 or coalesce(p_evolution, 0) > 10 then
    raise exception 'Evolution out of range';
  end if;

  if p_copies > public.copies_at(auth.uid(), p_tower, coalesce(p_evolution, 0)) then
    raise exception 'You do not have that many';
  end if;

  if p_copies = 0 then
    delete from public.trade_items
    where trade_id = p_id
      and player_id = auth.uid()
      and tower_key = p_tower
      and evolution = coalesce(p_evolution, 0);
  else
    insert into public.trade_items
      (trade_id, player_id, tower_key, evolution, copies)
    values (p_id, auth.uid(), p_tower, coalesce(p_evolution, 0), p_copies)
    on conflict (trade_id, player_id, tower_key, evolution)
    do update set copies = excluded.copies;
  end if;

  update public.trades
  set a_locked = false, b_locked = false, locked_at = null, status = 'open'
  where id = p_id;

  return true;
end $$;

-- 4. Lock in -----------------------------------------------------
create or replace function public.lock_trade(p_id bigint, p_locked boolean)
returns timestamptz
language plpgsql security definer set search_path = ''
as $$
declare
  deal       public.trades;
  is_a       boolean;
  /* Not named "both" — that is a reserved word in Postgres. */
  all_locked boolean;
  starts     timestamptz;
begin
  select * into deal from public.trades where id = p_id for update;

  if deal.id is null or auth.uid() not in (deal.player_a, deal.player_b) then
    raise exception 'Not your trade';
  end if;

  if deal.status not in ('open', 'locked') then
    raise exception 'That trade is not open';
  end if;

  is_a := deal.player_a = auth.uid();

  update public.trades
  set a_locked = case when is_a then coalesce(p_locked, false) else a_locked end,
      b_locked = case when is_a then b_locked else coalesce(p_locked, false) end
  where id = p_id
  returning (a_locked and b_locked) into all_locked;

  if all_locked then
    update public.trades
    set status = 'locked', locked_at = now()
    where id = p_id
    returning locked_at into starts;
  else
    update public.trades
    set status = 'open', locked_at = null
    where id = p_id;
  end if;

  return starts;
end $$;

-- 5. Walk away ---------------------------------------------------
create or replace function public.cancel_trade(p_id bigint)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.trades
  set status = 'cancelled'
  where id = p_id
    and auth.uid() in (player_a, player_b)
    and status in ('requested', 'open', 'locked');

  if not found then
    raise exception 'Nothing to cancel';
  end if;

  return true;
end $$;

-- 6. Settle ------------------------------------------------------
create or replace function public.settle_trade(p_id bigint)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  deal public.trades;
  item record;
begin
  select * into deal from public.trades where id = p_id for update;

  if deal.id is null or auth.uid() not in (deal.player_a, deal.player_b) then
    raise exception 'Not your trade';
  end if;

  if deal.status = 'done' then
    return true;
  end if;

  if deal.status <> 'locked' then
    raise exception 'Both sides must lock first';
  end if;

  if deal.locked_at + make_interval(secs => public.trade_hold_seconds()) > now() then
    raise exception 'Still within the withdrawal window';
  end if;

  /* Everything is rechecked here — cards may have been spent
     while the hold was running. */
  for item in
    select * from public.trade_items where trade_id = p_id
  loop
    if public.copies_at(item.player_id, item.tower_key, item.evolution) < item.copies then
      update public.trades set status = 'cancelled' where id = p_id;
      raise exception 'Someone no longer has the cards — trade cancelled';
    end if;
  end loop;

  for item in
    select * from public.trade_items where trade_id = p_id
  loop
    update public.player_towers
    set copies = copies - item.copies
    where player_id = item.player_id
      and tower_key = item.tower_key
      and evolution = item.evolution;

    insert into public.player_towers (player_id, tower_key, evolution, copies)
    values (
      case when item.player_id = deal.player_a then deal.player_b else deal.player_a end,
      item.tower_key, item.evolution, item.copies
    )
    on conflict (player_id, tower_key, evolution)
    do update set copies = public.player_towers.copies + item.copies;
  end loop;

  update public.trades set status = 'done' where id = p_id;

  return true;
end $$;

grant execute on function public.request_trade(uuid) to authenticated;
grant execute on function public.respond_trade(bigint, boolean) to authenticated;
grant execute on function public.copies_at(uuid, text, integer) to authenticated;
grant execute on function public.set_trade_item(bigint, text, integer, integer) to authenticated;
grant execute on function public.lock_trade(bigint, boolean) to authenticated;
grant execute on function public.cancel_trade(bigint) to authenticated;
grant execute on function public.settle_trade(bigint) to authenticated;
