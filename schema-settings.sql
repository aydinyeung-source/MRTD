-- ============================================================
-- MRTD live settings.
-- Run AFTER schema-admin.sql. Idempotent.
--
-- Switches an admin can flip for everyone at once. Players read
-- them but cannot write them, and they arrive on the next
-- heartbeat, so a change reaches everyone within seconds without
-- anyone reloading.
-- ============================================================

create table if not exists public.game_settings (
  key        text primary key,
  enabled    boolean not null default false,
  expires_at timestamptz
);

-- A switch can be turned on for a set time and lapse by itself.
alter table public.game_settings
  add column if not exists expires_at timestamptz;

insert into public.game_settings (key, enabled)
values ('speed10', false)
on conflict (key) do nothing;

alter table public.game_settings enable row level security;

drop policy if exists "settings readable" on public.game_settings;
create policy "settings readable" on public.game_settings
  for select to authenticated using (true);

-- p_minutes null means until it is turned off by hand.
create or replace function public.admin_set_setting(
  p_key     text,
  p_enabled boolean,
  p_minutes integer default null
)
returns timestamptz
language plpgsql
security definer set search_path = ''
as $$
declare
  ends_at timestamptz;
begin
  perform public.require_dev();

  if p_minutes is not null and (p_minutes <= 0 or p_minutes > 1440) then
    raise exception 'Duration must be between 1 and 1440 minutes';
  end if;

  if coalesce(p_enabled, false) and p_minutes is not null then
    ends_at := now() + make_interval(mins => p_minutes);
  end if;

  insert into public.game_settings (key, enabled, expires_at)
  values (p_key, coalesce(p_enabled, false), ends_at)
  on conflict (key) do update
    set enabled = excluded.enabled, expires_at = excluded.expires_at;

  insert into public.admin_grants (granted_by, action, detail, recipients)
  values (auth.uid(), 'setting',
          jsonb_build_object('key', p_key, 'enabled', p_enabled,
                             'minutes', p_minutes),
          public.online_count());

  return ends_at;
end $$;

-- Heartbeat now also carries the live settings, so a flip reaches
-- every signed in client on their next poll.
drop function if exists public.heartbeat();

create or replace function public.heartbeat()
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  current_session uuid;
  latest          jsonb;
  flags           jsonb;
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

  /* A lapsed switch reads as off without needing to be cleared. */
  select coalesce(
    jsonb_object_agg(
      s.key,
      s.enabled and (s.expires_at is null or s.expires_at > now())
    ),
    '{}'::jsonb
  )
  into flags
  from public.game_settings s;

  return jsonb_build_object(
    'session', current_session,
    'announcement', latest,
    'settings', flags
  );
end $$;

grant execute on function public.heartbeat() to authenticated;
grant execute on function public.admin_set_setting(text, boolean, integer) to authenticated;
