-- Runs once, after the image's own setup. Supabase Auth (GoTrue) replaces the
-- auth.uid(), auth.role() and auth.email() functions in its first migration,
-- which only their owner may do. The image leaves them owned by postgres
-- (seen on public.ecr.aws/supabase/postgres:17.11.0.004, 2026-10-21), so Auth
-- restarted with "must be owner of function uid" until they were handed over.
ALTER FUNCTION auth.uid() OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.role() OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.email() OWNER TO supabase_auth_admin;
