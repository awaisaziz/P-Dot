-- Google connector grants (decision 0016 and its amendments of 2026-10-21).
--
-- Additive: one new table, two functions the app calls, one log trigger, and
-- three new action log event names. The code that is live now never reads
-- this table, and new code treats a missing table as "no grant", so the
-- deploy order does not matter.
--
-- Same ownership model as every earlier migration: no service role key, every
-- row has user_id = auth.uid(), and RLS refuses anything else. Tokens are
-- encrypted in the Worker (AES-256-GCM); the database stores only ciphertext.
-- The API roles cannot select either ciphertext column and cannot update
-- either one: tokens are read through connector_grant_secrets and written
-- through store_connector_tokens, both limited to the caller's own row.

create table public.connector_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  provider text not null check (provider in ('google')),
  -- The Google account's stable ID (the ID token's sub).
  account_sub text not null check (char_length(account_sub) between 1 and 255),
  account_email text not null check (char_length(account_email) between 3 and 320),
  scopes text[] not null check (cardinality(scopes) between 1 and 20),
  refresh_token_ciphertext bytea not null
    check (octet_length(refresh_token_ciphertext) between 28 and 4096),
  access_token_ciphertext bytea
    check (access_token_ciphertext is null or octet_length(access_token_ciphertext) between 28 and 4096),
  access_token_expires_at timestamptz,
  key_version smallint not null check (key_version >= 1),
  status text not null default 'active' check (status in ('active', 'needs_reconnect')),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One Google account per user in v1. A reconnect replaces the row.
  unique (user_id, provider)
);

create trigger connector_grants_touch_updated_at
  before update on public.connector_grants
  for each row execute function public.touch_updated_at();

alter table public.connector_grants enable row level security;

create policy connector_grants_select_own on public.connector_grants
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy connector_grants_insert_own on public.connector_grants
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy connector_grants_update_own on public.connector_grants
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy connector_grants_delete_own on public.connector_grants
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Only the grants below. No API role can select or update a ciphertext column.
revoke all on public.connector_grants from anon, authenticated;
grant select (
  id, user_id, provider, account_sub, account_email, scopes,
  access_token_expires_at, key_version, status, last_used_at, created_at, updated_at
) on public.connector_grants to authenticated;
grant insert on public.connector_grants to authenticated;
grant delete on public.connector_grants to authenticated;
grant update (account_email, scopes, status, last_used_at, access_token_expires_at)
  on public.connector_grants to authenticated;

-- ---------------------------------------------------------------------------
-- Token writes. Updates the caller's own row; a null p_refresh keeps the
-- stored refresh token. Returns false when the caller has no such row.
-- ---------------------------------------------------------------------------
create function public.store_connector_tokens(
  p_id uuid, p_refresh bytea, p_access bytea, p_expires timestamptz, p_key_version smallint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  update public.connector_grants g
  set refresh_token_ciphertext = coalesce(p_refresh, g.refresh_token_ciphertext),
      access_token_ciphertext = p_access,
      access_token_expires_at = p_expires,
      key_version = p_key_version
  where g.id = p_id and g.user_id = v_uid;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Token reads: the only way to read a ciphertext. The caller's own row in any
-- status, so Disconnect can revoke a grant that needs reconnecting.
-- ---------------------------------------------------------------------------
create function public.connector_grant_secrets(p_id uuid)
returns table (id uuid, key_version smallint, refresh_token_ciphertext bytea, access_token_ciphertext bytea)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  return query
    select g.id, g.key_version, g.refresh_token_ciphertext, g.access_token_ciphertext
    from public.connector_grants g
    where g.id = p_id and g.user_id = v_uid;
end;
$$;

revoke execute on function public.store_connector_tokens(uuid, bytea, bytea, timestamptz, smallint) from public, anon;
grant execute on function public.store_connector_tokens(uuid, bytea, bytea, timestamptz, smallint) to authenticated;
revoke execute on function public.connector_grant_secrets(uuid) from public, anon;
grant execute on function public.connector_grant_secrets(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Action log. The full list from 20261021000000_memory_hardening.sql plus the
-- three connector events. Every existing row uses a name from the old list.
-- ---------------------------------------------------------------------------
alter table public.action_log drop constraint if exists action_log_event_check;
alter table public.action_log
  add constraint action_log_event_check check (event in (
    'proposed', 'approved', 'rejected', 'executed', 'failed',
    'memory_added', 'memory_edited', 'memory_deleted',
    'document_added', 'document_ready', 'document_failed', 'document_deleted',
    'reminder_added', 'reminder_changed', 'reminder_deleted',
    'connector_added', 'connector_removed', 'connector_changed'
  ));

-- IDs, the provider, a count and the status only. Never the email, the
-- account ID, the scopes or a token.
create function public.log_connector_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.write_action_log(new.user_id, 'connector_added', null, jsonb_build_object(
      'grantId', new.id, 'provider', new.provider, 'scopeCount', cardinality(new.scopes), 'status', new.status));
    return new;
  elsif tg_op = 'UPDATE' then
    perform public.write_action_log(new.user_id, 'connector_changed', null, jsonb_build_object(
      'grantId', new.id, 'provider', new.provider, 'scopeCount', cardinality(new.scopes), 'status', new.status));
    return new;
  else
    perform public.write_action_log(old.user_id, 'connector_removed', null, jsonb_build_object(
      'grantId', old.id, 'provider', old.provider, 'scopeCount', cardinality(old.scopes), 'status', old.status));
    return old;
  end if;
end;
$$;

revoke execute on function public.log_connector_change() from public, anon, authenticated;

create trigger connector_grants_log_insert_delete
  after insert or delete on public.connector_grants
  for each row execute function public.log_connector_change();

-- A token write or a last-used time is not logged; a status or scope change is.
create trigger connector_grants_log_update
  after update of status, scopes on public.connector_grants
  for each row
  when (old.status is distinct from new.status or old.scopes is distinct from new.scopes)
  execute function public.log_connector_change();
