-- Local stand-ins for what Supabase provides, so schema.sql runs on plain Postgres.
-- On a real Supabase project you do NOT run this file.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (id uuid primary key, email text);
-- Same contract as Supabase: the caller's id comes from the request.jwt.claim.sub setting.
create function auth.uid() returns uuid
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

-- A demo operator, used when no X-Operator-Id header is sent.
insert into auth.users (id, email)
values ('00000000-0000-4000-8000-000000000001', 'operator@example.com');
