-- ============================================================
-- MRTD developer mode.
-- Run AFTER schema.sql, schema-shop.sql and schema-chest.sql.
--
-- The flag lives in the database, not the browser, so only an
-- account that has actually been granted it can spend nothing on
-- chests. A client that merely claims to be a developer gets the
-- cosmetic effects and nothing else.
-- ============================================================

alter table public.profiles
  add column if not exists is_dev boolean not null default false;

-- Grant it to the one account. Usernames are case insensitive.
update public.profiles
set is_dev = true
where lower(username) = 'amingben';

-- Chests are free for developers; everyone else pays as before.
create or replace function public.open_chest(draws integer)
returns text[]
language plpgsql
security definer set search_path = ''
as $$
declare
  price    integer;
  balance  bigint;
  developer boolean;
  result   text[] := '{}';
  picked   text;
  i        integer;
  has_rare boolean := false;
begin
  if draws = 1 then
    price := 100;
  elsif draws = 10 then
    price := 900;
  else
    raise exception 'Chests come in 1 or 10';
  end if;

  select coins, is_dev into balance, developer
  from public.profiles
  where id = auth.uid()
  for update;

  if balance is null then
    raise exception 'No profile for this account';
  end if;

  if not developer then
    if balance < price then
      raise exception 'Not enough coins';
    end if;

    update public.profiles set coins = coins - price where id = auth.uid();
  end if;

  for i in 1..draws loop
    picked := public.draw_tower();

    if picked in (select tower_key from public.chest_odds where rarity <> 'common') then
      has_rare := true;
    end if;

    result := array_append(result, picked);
  end loop;

  if draws = 10 and not has_rare then
    select tower_key into picked
    from public.chest_odds
    where rarity <> 'common'
    order by random()
    limit 1;

    result[10] := picked;
  end if;

  for i in 1..draws loop
    insert into public.player_towers (player_id, tower_key, evolution, copies)
    values (auth.uid(), result[i], 0, 1)
    on conflict (player_id, tower_key, evolution)
    do update set copies = public.player_towers.copies + 1;
  end loop;

  return result;
end $$;

grant execute on function public.open_chest(integer) to authenticated;
