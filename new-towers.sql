-- ============================================================
-- MRTD: Fan and Clock Tower join the chest.
--
--   fan         mythic   alongside DJTV and Ice Cannon
--   clocktower  godly    alongside Quantum
--
-- Weights are per mille and are the whole RARITY's share, not
-- the tower's. Every tower in a rarity carries the same number,
-- and whichever one is up that half hour uses it. That is why
-- adding a tower here changes how often you see that particular
-- tower and never how often the rarity itself comes up.
--
-- So mythic stays at 1.0% and godly at 0.1%. What changes:
--
--   mythic  was DJTV / Ice Cannon        each up half the time
--           now DJTV / Ice Cannon / Fan  each up a third
--   godly   was Quantum, always up
--           now Quantum / Clock Tower, alternating
--
-- Quantum was alone in its tier and therefore always in the
-- chest. It is now up half the time. If you would rather it
-- stayed permanently available, say so and Clock Tower can have
-- a tier of its own instead.
--
-- Run once, then this file goes.
-- ============================================================

insert into public.chest_odds (tower_key, weight, rarity) values
  ('fan',         10, 'mythic'),
  ('clocktower',   1, 'godly')
on conflict (tower_key) do update
  set weight = excluded.weight, rarity = excluded.rarity;


-- ============================================================
-- The grant cap goes to 1024.
--
-- 1024 is exactly what evolution 10 costs — two copies make an
-- evolution 1, and it doubles all the way up. Stopping at 1000
-- meant the one number an admin would actually reach for was
-- the one number they could not grant.
--
-- Everything else about this function is unchanged from what is
-- already running.
-- ============================================================

create or replace function public.admin_grant_towers(
  p_tower text,
  p_copies integer default 1,
  p_online_only boolean default true,
  p_shiny boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  affected integer := 0;
  target   record;
  picked   text;
begin
  perform public.require_dev();

  if p_copies is null or p_copies <= 0 or p_copies > 1024 then
    raise exception 'Copies must be between 1 and 1024';
  end if;

  if p_tower is not null
     and not exists (select 1 from public.chest_odds c where c.tower_key = p_tower) then
    raise exception 'Unknown tower';
  end if;

  for target in
    select p.id from public.profiles p
    where not p_online_only or exists (
      select 1 from public.player_sessions s
      where s.player_id = p.id and s.last_seen > now() - interval '2 minutes'
    )
  loop
    picked := coalesce(p_tower, public.draw_tower());

    insert into public.player_towers as pt (player_id, tower_key, evolution, copies, shiny)
    values (target.id, picked, 0, p_copies, p_shiny)
    on conflict (player_id, tower_key, evolution, shiny)
    do update set copies = pt.copies + p_copies;

    affected := affected + 1;
  end loop;

  insert into public.admin_grants (granted_by, action, detail, recipients)
  values (auth.uid(), 'towers',
          jsonb_build_object('tower', p_tower, 'copies', p_copies,
                             'online_only', p_online_only, 'shiny', p_shiny),
          affected);

  return affected;
end $function$;



-- ============================================================
-- A sixth loadout slot, 3000 coins.
--
-- One level only, so there is one price. Every other upgrade
-- prices each level separately in this table, which is why the
-- level column is here at all.
-- ============================================================

insert into public.upgrade_costs (upgrade_key, level, cost) values
  ('loadout_slots', 1, 3000)
on conflict (upgrade_key, level) do update
  set cost = excluded.cost;


-- What is in the chest this half hour, and what each is worth.
select * from public.active_chest() order by weight desc;
