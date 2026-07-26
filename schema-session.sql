-- ============================================================
-- MRTD single device sign in.
-- Run AFTER schema.sql. Idempotent.
--
-- Each login claims a fresh token. Other devices notice their
-- token is no longer the current one and sign themselves out.
--
-- This lives in its own table rather than on profiles, because
-- profiles are readable by every logged in player and a session
-- token should not be.
-- ============================================================

create table if not exists public.player_sessions (
  player_id  uuid primary key references public.profiles(id) on delete cascade,
  session_id uuid not null,
  claimed_at timestamptz not null default now()
);

alter table public.player_sessions enable row level security;

-- You can read your own row and nobody else's. Writes go through
-- the function below.
drop policy if exists "own session" on public.player_sessions;
create policy "own session" on public.player_sessions
  for select to authenticated
  using (auth.uid() = player_id);

-- Claim the account for this device, kicking any other.
create or replace function public.claim_session(new_session uuid)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
begin
  if new_session is null then
    raise exception 'Session token required';
  end if;

  insert into public.player_sessions (player_id, session_id, claimed_at)
  values (auth.uid(), new_session, now())
  on conflict (player_id)
  do update set session_id = excluded.session_id, claimed_at = now();

  return new_session;
end $$;

grant execute on function public.claim_session(uuid) to authenticated;
