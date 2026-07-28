-- ============================================================
-- MRTD: shinies become tradeable.
--
-- Most of this landed with shinies already — trade_items has a
-- shiny column, settle_trade moves the right line, and copies_at
-- can be asked about either. The one thing left is that
-- set_trade_item never learned to say which it meant, so the
-- trade window had to hide shinies rather than offer a card and
-- hand over the wrong one.
--
-- Two changes, and the first matters more than it looks.
--
-- Run once, then this file goes.
-- ============================================================


-- ============================================================
-- 1. The uniqueness key on trade_items
--
-- It is (trade_id, player_id, tower_key, evolution), from before
-- shinies existed. Offering a Shiny Sniper evo 3 and a plain
-- Sniper evo 3 in the same trade would collide on that key, and
-- the ON CONFLICT in set_trade_item would quietly overwrite one
-- offer with the other — no error, just a card that silently
-- stopped being in the trade.
--
-- Found by its columns rather than its name, since the name
-- depends on how the table was first created.
-- ============================================================

do $$
declare
  found_name text;
begin
  select c.conname into found_name
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'trade_items'
    and c.contype in ('p', 'u')
    and (
      select array_agg(a.attname::text order by a.attname)
      from unnest(c.conkey) as k(attnum)
      join pg_attribute a
        on a.attrelid = c.conrelid and a.attnum = k.attnum
    ) = array['evolution', 'player_id', 'tower_key', 'trade_id']
  limit 1;

  if found_name is not null then
    execute format(
      'alter table public.trade_items drop constraint %I', found_name
    );
  end if;

  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'trade_items'
      and c.conname = 'trade_items_offer_key'
  ) then
    alter table public.trade_items
      add constraint trade_items_offer_key
      unique (trade_id, player_id, tower_key, evolution, shiny);
  end if;
end $$;


-- ============================================================
-- 2. set_trade_item gains p_shiny
--
-- The old signature is DROPPED, not left beside the new one.
-- Adding an argument with CREATE OR REPLACE makes a second
-- function rather than replacing the first, and then every four
-- argument call is ambiguous between them — which is exactly
-- what broke trading when copies_at and base_copies grew their
-- shiny argument.
--
-- Everything else is unchanged, including the part that matters
-- most: changing an offer clears BOTH locks and reopens the
-- trade, so nobody can alter what is on the table after the
-- other side has agreed to it.
-- ============================================================

drop function if exists public.set_trade_item(bigint, text, integer, integer);

create or replace function public.set_trade_item(
  p_id bigint,
  p_tower text,
  p_evolution integer,
  p_copies integer,
  p_shiny boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
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

  /* Counted against the line being offered. Without the flag a
     player could offer shinies they do not have by holding the
     same number of normal ones. */
  if p_copies > public.copies_at(
       auth.uid(), p_tower, coalesce(p_evolution, 0), coalesce(p_shiny, false)
     ) then
    raise exception 'You do not have that many';
  end if;

  if p_copies = 0 then
    delete from public.trade_items
    where trade_id = p_id
      and player_id = auth.uid()
      and tower_key = p_tower
      and evolution = coalesce(p_evolution, 0)
      and shiny = coalesce(p_shiny, false);
  else
    insert into public.trade_items
      (trade_id, player_id, tower_key, evolution, copies, shiny)
    values (
      p_id, auth.uid(), p_tower, coalesce(p_evolution, 0), p_copies,
      coalesce(p_shiny, false)
    )
    on conflict (trade_id, player_id, tower_key, evolution, shiny)
    do update set copies = excluded.copies;
  end if;

  /* Unchanged, and the reason this function is worth being
     careful with: touching an offer takes both sides back to
     unlocked, so what was agreed to is always what settles. */
  update public.trades
  set a_locked = false, b_locked = false, locked_at = null, status = 'open'
  where id = p_id;

  return true;
end $function$;

grant execute on function public.set_trade_item(bigint, text, integer, integer, boolean)
  to authenticated;


-- One row, five columns including shiny.
select
  c.conname                   as constraint_name,
  pg_get_constraintdef(c.oid) as definition
from pg_constraint c
join pg_class t on t.oid = c.conrelid
where t.relname = 'trade_items' and c.contype in ('p', 'u');
