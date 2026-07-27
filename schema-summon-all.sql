-- ============================================================
-- MRTD "summon all".
-- Run AFTER schema-chest.sql and schema-dev.sql. Idempotent.
--
-- Spends every coin at the single draw price of 100 — no bulk
-- discount, so it trades value for convenience. The count is
-- worked out in Postgres from the real balance, so the browser
-- cannot ask for more draws than it can pay for.
-- ============================================================

create or replace function public.open_chest_all(p_sandbox boolean default false)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  price     constant integer := 100;
  cap       constant integer := 500;
  balance   bigint;
  developer boolean;
  draws     integer;
  result    text[] := '{}';
  picked    text;
  i         integer;
begin
  select coins, is_dev into balance, developer
  from public.profiles
  where id = auth.uid()
  for update;

  if balance is null then
    raise exception 'No profile for this account';
  end if;

  /* A developer has nothing to spend and keeps nothing, so a
     sandbox pull is a fixed sample. */
  if p_sandbox and coalesce(developer, false) then
    draws := 10;
  else
    draws := least(floor(balance / price)::integer, cap);

    if draws < 1 then
      raise exception 'Not enough coins';
    end if;

    update public.profiles
    set coins = coins - draws * price
    where id = auth.uid();
  end if;

  for i in 1..draws loop
    picked := public.draw_tower();
    result := array_append(result, picked);
  end loop;

  if p_sandbox and coalesce(developer, false) then
    return result;
  end if;

  for i in 1..draws loop
    insert into public.player_towers (player_id, tower_key, evolution, copies)
    values (auth.uid(), result[i], 0, 1)
    on conflict (player_id, tower_key, evolution)
    do update set copies = public.player_towers.copies + 1;
  end loop;

  return result;
end $$;

grant execute on function public.open_chest_all(boolean) to authenticated;
