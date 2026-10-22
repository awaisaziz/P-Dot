-- Verified workflow and connector results for an assistant reply (decision
-- 0015, "Persistence"): the cards and the run panel's steps, so they survive
-- a reload. One row per reply, written once after the reply is saved.
--
-- Additive: a new table only. The code that is live now never reads it, and
-- the new code treats a missing table as "no results", so the order in which
-- the migration and the code land does not matter.
--
-- Same ownership model as every earlier table: user_id = auth.uid(), checked
-- by RLS, and the composite foreign key proves the message belongs to the
-- same user. Rows go with their message (on delete cascade), so there is no
-- update or delete grant.

create table public.message_results (
  message_id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kinds text[] not null
    check (
      cardinality(kinds) <= 4
      and array_position(kinds, null) is null
      and kinds <@ array['flights', 'research', 'calendar', 'drive']::text[]
    ),
  payload jsonb not null
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 32768),
  created_at timestamptz not null default now(),
  foreign key (message_id, user_id)
    references public.messages (id, user_id) on delete cascade
);

alter table public.message_results enable row level security;

create policy message_results_select_own on public.message_results
  for select to authenticated using ((select auth.uid()) = user_id);
create policy message_results_insert_own on public.message_results
  for insert to authenticated with check ((select auth.uid()) = user_id);

revoke all on public.message_results from anon, authenticated;
grant select, insert on public.message_results to authenticated;
