-- ============================================================
-- MRTD admin panel.
-- Run AFTER schema.sql, schema-shop.sql, schema-chest.sql,
-- schema-session.sql and schema-dev.sql.
--
-- Every function here refuses unless the CALLER's profile has
-- is_dev set in the database. The browser cannot talk its way in.
--
-- Note these grants are deliberately REAL and permanent — they
-- affect other people's accounts, so they are not covered by the
-- developer sandbox. Every one is written to admin_grants.
-- ============================================================

-- 1. Who is online ---------------------------------------------
alter table public.player_sessions
  add column if not exists last_seen timestamptz not null default now();

create index if not exists player_sessions_last_seen_idx
  on public.player_sessions (last_seen desc);

-- Broadcast messages -------------------------------------------
create table if not exists public.announcements (
  id      bigserial primary key,
  body    text not null check (length(body) between 1 and 500),
  sent_by uuid references public.profiles(id),
  sent_at timestamptz not null default now()
);

create index if not exists announcements_sent_at_idx
  on public.announcements (sent_at desc);

alter table public.announcements enable row level security;

drop policy if exists "announcements readable" on public.announcements;
create policy "announcements readable" on public.announcements
  for select to authenticated using (true);

/* Called by every signed in client on a timer. Does three jobs in
   one request: refreshes the presence stamp, returns the session
   that currently owns the account, and hands back any broadcast
   sent in the last minute and a half. */
drop function if exists public.heartbeat();

create or replace function public.heartbeat()
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  current_session uuid;
  latest          jsonb;
begin
  update public.player_sessions
  set last_seen = now()
  where player_id = auth.uid()
  returning session_id into current_session;

  select jsonb_build_object('id', a.id, 'body', a.body)
  into latest
  from public.announcements a
  where a.sent_at > now() - interval '90 seconds'
  order by a.id desc
  limit 1;

  return jsonb_build_object('session', current_session, 'announcement', latest);
end $$;

create or replace function public.admin_announce(body text)
returns bigint
language plpgsql
security definer set search_path = ''
as $$
declare
  new_id bigint;
begin
  perform public.require_dev();

  if body is null or length(trim(body)) = 0 then
    raise exception 'Message is empty';
  end if;

  insert into public.announcements (body, sent_by)
  values (trim(body), auth.uid())
  returning id into new_id;

  insert into public.admin_grants (granted_by, action, detail, recipients)
  values (auth.uid(), 'announce', jsonb_build_object('body', trim(body)),
          public.online_count());

  return new_id;
end $$;

/* Anyone seen in the last two minutes. */
create or replace function public.online_count()
returns integer
language sql
security definer set search_path = ''
as $$
  select count(*)::integer
  from public.player_sessions
  where last_seen > now() - interval '2 minutes';
$$;

-- 2. Audit trail -----------------------------------------------
create table if not exists public.admin_grants (
  id         bigserial primary key,
  granted_by uuid not null references public.profiles(id),
  action     text not null,
  detail     jsonb,
  recipients integer not null,
  granted_at timestamptz not null default now()
);

alter table public.admin_grants enable row level security;

drop policy if exists "grants readable by devs" on public.admin_grants;
create policy "grants readable by devs" on public.admin_grants
  for select to authenticated
  using (exists (
    select 1 from public.profiles
    where id = auth.uid() and is_dev
  ));

-- 3. Guard ------------------------------------------------------
/* Two locks, not one: the account must carry the is_dev flag AND
   be on the admin list below. An is_dev flag granted by accident
   is not enough to reach any of these functions.

   To add another admin later, add their username to the array. */
create or replace function public.require_dev()
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  admins text[] := array['amingben'];
begin
  if not exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_dev
      and lower(username) = any (admins)
  ) then
    raise exception 'Not permitted';
  end if;
end $$;

-- 4. Grant coins ------------------------------------------------
create or replace function public.admin_grant_coins(
  amount      bigint,
  online_only boolean default true
)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  affected integer;
begin
  perform public.require_dev();

  if amount is null or amount <= 0 or amount > 1000000 then
    raise exception 'Amount must be between 1 and 1000000';
  end if;

  /* The admin always receives their own grant, whether or not the
     online filter would have caught them. */
  update public.profiles p
  set coins = p.coins + amount
  where p.id = auth.uid()
     or not online_only
     or exists (
       select 1 from public.player_sessions s
       where s.player_id = p.id and s.last_seen > now() - interval '2 minutes'
     );

  get diagnostics affected = row_count;

  insert into public.admin_grants (granted_by, action, detail, recipients)
  values (auth.uid(), 'coins',
          jsonb_build_object('amount', amount, 'online_only', online_only),
          affected);

  return affected;
end $$;

-- 5. Grant tower copies -----------------------------------------
-- A null p_tower gives each player a random one instead.
--
-- The parameters are prefixed because plpgsql substitutes them
-- into the SQL below: a parameter named tower_key or copies would
-- be ambiguous against the columns of the same name, and the
-- on conflict clause fails with "column reference is ambiguous".
drop function if exists public.admin_grant_towers(text, integer, boolean);

create or replace function public.admin_grant_towers(
  p_tower       text,
  p_copies      integer default 1,
  p_online_only boolean default true
)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  affected integer := 0;
  target   record;
  picked   text;
begin
  perform public.require_dev();

  if p_copies is null or p_copies <= 0 or p_copies > 1000 then
    raise exception 'Copies must be between 1 and 1000';
  end if;

  if p_tower is not null
     and not exists (select 1 from public.chest_odds c where c.tower_key = p_tower) then
    raise exception 'Unknown tower';
  end if;

  for target in
    select p.id from public.profiles p
    where p.id = auth.uid()
       or not p_online_only
       or exists (
         select 1 from public.player_sessions s
         where s.player_id = p.id and s.last_seen > now() - interval '2 minutes'
       )
  loop
    picked := coalesce(p_tower, public.draw_tower());

    insert into public.player_towers as pt (player_id, tower_key, evolution, copies)
    values (target.id, picked, 0, p_copies)
    on conflict (player_id, tower_key, evolution)
    do update set copies = pt.copies + p_copies;

    affected := affected + 1;
  end loop;

  insert into public.admin_grants (granted_by, action, detail, recipients)
  values (auth.uid(), 'towers',
          jsonb_build_object('tower', p_tower, 'copies', p_copies,
                             'online_only', p_online_only),
          affected);

  return affected;
end $$;

-- 6. Grant chests ------------------------------------------------
-- Rolls a real chest for each recipient, so everyone gets
-- different towers.
create or replace function public.admin_grant_chests(
  draws       integer default 1,
  online_only boolean default true
)
returns integer
language plpgsql
security definer set search_path = ''
as $$
declare
  affected integer := 0;
  target   record;
  picked   text;
  i        integer;
begin
  perform public.require_dev();

  if draws is null or draws <= 0 or draws > 50 then
    raise exception 'Draws must be between 1 and 50';
  end if;

  for target in
    select p.id from public.profiles p
    where p.id = auth.uid()
       or not online_only
       or exists (
         select 1 from public.player_sessions s
         where s.player_id = p.id and s.last_seen > now() - interval '2 minutes'
       )
  loop
    for i in 1..draws loop
      picked := public.draw_tower();

      insert into public.player_towers (player_id, tower_key, evolution, copies)
      values (target.id, picked, 0, 1)
      on conflict (player_id, tower_key, evolution)
      do update set copies = public.player_towers.copies + 1;
    end loop;

    affected := affected + 1;
  end loop;

  insert into public.admin_grants (granted_by, action, detail, recipients)
  values (auth.uid(), 'chests',
          jsonb_build_object('draws', draws, 'online_only', online_only),
          affected);

  return affected;
end $$;

grant execute on function public.heartbeat() to authenticated;
grant execute on function public.online_count() to authenticated;
grant execute on function public.admin_grant_coins(bigint, boolean) to authenticated;
grant execute on function public.admin_grant_towers(text, integer, boolean) to authenticated;
grant execute on function public.admin_announce(text) to authenticated;
grant execute on function public.admin_grant_chests(integer, boolean) to authenticated;
