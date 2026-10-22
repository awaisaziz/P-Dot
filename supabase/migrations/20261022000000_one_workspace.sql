-- One workspace (decision 0014, docs/DEPLOYMENT.md "Expand, then contract").
--
-- Additive and safe for the code that is live now:
-- - match_memories and match_document_chunks keep their signatures, return
--   types, SECURITY INVOKER and empty search_path. The only change is the
--   filter: a null p_mode now matches every mode. The live code always passes
--   'personal' or 'work', so it gets exactly the rows it got before; the new
--   code passes null and gets every row of the caller.
-- - The mode column of tasks, memories, documents and reminders gets the
--   default 'personal' (conversations already has it). Every insert from the
--   live code names a mode, so a default changes none of them.
-- No column, constraint, index or row is removed or rewritten. The execute
-- revokes and grants are re-issued so the functions keep exactly the access
-- they had.

create or replace function public.match_memories(p_query extensions.vector(1024), p_mode text, p_count integer)
returns table (id uuid, content text, similarity double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.id, m.content, 1 - (m.embedding operator(extensions.<=>) p_query) as similarity
  from public.memories m
  where m.user_id = (select auth.uid())
    and (p_mode is null or m.mode = p_mode)
    and m.status = 'active'
    and m.embedding is not null
  order by m.embedding operator(extensions.<=>) p_query
  limit least(greatest(coalesce(p_count, 5), 1), 20);
$$;

create or replace function public.match_document_chunks(p_query extensions.vector(1024), p_mode text, p_count integer)
returns table (id uuid, document_id uuid, title text, content text, similarity double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.id, c.document_id, d.title, c.content,
         1 - (c.embedding operator(extensions.<=>) p_query) as similarity
  from public.document_chunks c
  join public.documents d on d.id = c.document_id and d.user_id = c.user_id
  where c.user_id = (select auth.uid())
    and (p_mode is null or d.mode = p_mode)
    and d.status = 'ready'
    and c.embedding is not null
  order by c.embedding operator(extensions.<=>) p_query
  limit least(greatest(coalesce(p_count, 5), 1), 20);
$$;

revoke execute on function public.match_memories(extensions.vector, text, integer) from public, anon;
revoke execute on function public.match_document_chunks(extensions.vector, text, integer) from public, anon;
grant execute on function public.match_memories(extensions.vector, text, integer) to authenticated;
grant execute on function public.match_document_chunks(extensions.vector, text, integer) to authenticated;

alter table public.tasks alter column mode set default 'personal';
alter table public.memories alter column mode set default 'personal';
alter table public.documents alter column mode set default 'personal';
alter table public.reminders alter column mode set default 'personal';
