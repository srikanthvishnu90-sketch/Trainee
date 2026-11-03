-- The SQL tests' assertion helpers, as tests/db/agent_foundation.test.sql defines them (lines 5-41), for the mutation harness.
create schema t;
create or replace function t.as_user(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', uid, false);
end $$;

-- Asserts that running `sql` raises an error whose message matches `pattern`.
create or replace function t.must_fail(sql text, pattern text, label text)
returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if sqlerrm !~* pattern then
      raise exception 'FAIL %: failed, but with "%" (wanted /%/)', label, sqlerrm, pattern;
    end if;
    raise notice 'ok   %', label;
    return;
  end;
  raise exception 'FAIL %: statement succeeded but had to fail', label;
end $$;

create or replace function t.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL %', label; end if;
  raise notice 'ok   %', label;
end $$;

grant usage on schema t to anon, authenticated, service_role;
grant execute on all functions in schema t to anon, authenticated, service_role;
grant create on schema t to authenticated;

