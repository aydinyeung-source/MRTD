-- ============================================================
-- MRTD player upgrades.
-- Run AFTER schema.sql, schema-shop.sql and schema-chest.sql.
--
-- Prices live in the database and buying happens in Postgres, so
-- the browser cannot invent a cheaper price or grant itself a
-- level it has not paid for.
-- ============================================================

-- 1. What the player owns ---------------------------------------
create table if not exists public.player_upgrades (
  player_id   uuid    not null references public.profiles(id) on delete cascade,
  upgrade_key text    not null,
  level       integer not null default 0 check (level >= 0),
  primary key (player_id, upgrade_key)
);

alter table public.player_upgrades enable row level security;

drop policy if exists "own upgrades" on public.player_upgrades;
create policy "own upgrades" on public.player_upgrades
  for select to authenticated
  using (auth.uid() = player_id);

-- 2. Price list --------------------------------------------------
create table if not exists public.upgrade_costs (
  upgrade_key text    not null,
  level       integer not null,
  cost        bigint  not null check (cost > 0),
  primary key (upgrade_key, level)
);

alter table public.upgrade_costs enable row level security;

drop policy if exists "costs readable" on public.upgrade_costs;
create policy "costs readable" on public.upgrade_costs
  for select to authenticated using (true);

delete from public.upgrade_costs;

insert into public.upgrade_costs (upgrade_key, level, cost) values
  -- Placement limit: +1 tower on the field per level, 15 to 25.
  ('placements',  1,  200), ('placements',  2,  300), ('placements',  3,  450),
  ('placements',  4,  700), ('placements',  5, 1000), ('placements',  6, 1500),
  ('placements',  7, 2300), ('placements',  8, 3400), ('placements',  9, 5100),
  ('placements', 10, 7700),

  -- Starting cash: +100 per level, 100 to 1100.
  ('starting_cash',  1,  250), ('starting_cash',  2,  350), ('starting_cash',  3,  500),
  ('starting_cash',  4,  700), ('starting_cash',  5, 1000), ('starting_cash',  6, 1400),
  ('starting_cash',  7, 2000), ('starting_cash',  8, 2800), ('starting_cash',  9, 3900),
  ('starting_cash', 10, 5500),

  -- One-time unlocks.
  ('quick_buy',  1, 750),
  ('game_speed', 1, 500);

-- 3. Buying ------------------------------------------------------
create or replace function public.buy_upgrade(
  p_key     text,
  p_sandbox boolean default false
)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  current_level integer;
  next_level    integer;
  price         bigint;
  balance       bigint;
  developer     boolean;
begin
  select coalesce(u.level, 0) into current_level
  from public.player_upgrades u
  where u.player_id = auth.uid() and u.upgrade_key = p_key;

  current_level := coalesce(current_level, 0);
  next_level := current_level + 1;

  select c.cost into price
  from public.upgrade_costs c
  where c.upgrade_key = p_key and c.level = next_level;

  if price is null then
    raise exception 'Already at maximum';
  end if;

  select p.coins, p.is_dev into balance, developer
  from public.profiles p
  where p.id = auth.uid()
  for update;

  if balance is null then
    raise exception 'No profile for this account';
  end if;

  /* Developer mode buys nothing and keeps nothing. */
  if p_sandbox and developer then
    return next_level;
  end if;

  if balance < price then
    raise exception 'Not enough coins';
  end if;

  update public.profiles set coins = coins - price where id = auth.uid();

  insert into public.player_upgrades (player_id, upgrade_key, level)
  values (auth.uid(), p_key, next_level)
  on conflict (player_id, upgrade_key)
  do update set level = next_level;

  return next_level;
end $$;

grant execute on function public.buy_upgrade(text, boolean) to authenticated;
