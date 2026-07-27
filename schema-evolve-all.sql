-- ============================================================
-- MRTD "evolve all".
-- Run AFTER schema-shop.sql and schema-dev.sql. Idempotent.
--
-- Does every evolution the collection can afford in one call,
-- lowest tier first so pairs cascade upward the way they would
-- if you clicked through them by hand.
-- ============================================================

create or replace function public.evolve_all(p_sandbox boolean default false)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  developer boolean;
  target    record;
  performed integer := 0;
begin
  select is_dev into developer
  from public.profiles
  where id = auth.uid();

  /* Developer mode changes nothing, so there is nothing to do. */
  if p_sandbox and coalesce(developer, false) then
    return 0;
  end if;

  loop
    select t.tower_key, t.evolution
    into target
    from public.player_towers t
    where t.player_id = auth.uid()
      and t.copies >= 2
      and t.evolution < 10
    order by t.evolution asc, t.tower_key asc
    limit 1;

    exit when not found;

    update public.player_towers
    set copies = copies - 2
    where player_id = auth.uid()
      and tower_key = target.tower_key
      and evolution = target.evolution;

    insert into public.player_towers (player_id, tower_key, evolution, copies)
    values (auth.uid(), target.tower_key, target.evolution + 1, 1)
    on conflict (player_id, tower_key, evolution)
    do update set copies = public.player_towers.copies + 1;

    performed := performed + 1;

    /* A collection cannot legitimately need this many. */
    exit when performed >= 5000;
  end loop;

  return performed;
end $$;

grant execute on function public.evolve_all(boolean) to authenticated;
