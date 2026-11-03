"""PEOPLE DISCOVERY at scale (D-MN-3 as replaced 21:32 + the owner's SCALE REQUIREMENT, 2026-10-27), on the disposable DB only.

1. Dedupe/upsert at 1M people rows: 10,000 people x 100 contacts each, then one shared discovery (100 people, half inferred)
   delivered to 1,000 of them; the dedupe reads are index scans (asserted from EXPLAIN), and the timings are printed.
2. The lookup queue under 20 concurrent workers: 10,000 people asking 5 lookups each plus one heavy person asking
   5,000 first (55,000 jobs), claimed with FOR UPDATE SKIP LOCKED leases by 20 worker sessions at once. Asserts exactly
   once (every job done once, one ledger row each, no job claimed twice) and fairness (every light person's first lookup
   is claimed before the heavy person's 1,000th, though the heavy person queued all 5,000 first). Prints throughput.
Invoked by tests/db/run.sh with the psql command line; nothing here reaches a provider or the live project.
"""
import subprocess
import sys
import time

PSQL = sys.argv[1:] + ["-t", "-A", "-v", "ON_ERROR_STOP=1"]
LIGHT, PER, HEAVY, WORKERS, BATCH = 10_000, 5, 5_000, 20, 50


def q(sql):
    r = subprocess.run(PSQL + ["-c", sql], capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(r.stderr.strip())
    return r.stdout.strip()


def ok(label):
    print("  ok   " + label, flush=True)


# ------------------------------------------------------------------------------------------------ setup
q("""set client_min_messages = warning;
insert into auth.users (id, email) select ('00000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, null from generate_series(1, 10001) g on conflict do nothing""")
U = lambda n: "00000000-0000-4000-8000-" + format(n, "x").zfill(12)
HEAVY_USER = U(10001)

# ------------------------------------------------------------------------------------------------ 1. 1M rows
t0 = time.monotonic()
q("""insert into career_people (user_id, source, name, email, company, company_key, position, source_ref, dedupe_key)
select ('00000000-0000-4000-8000-' || lpad(to_hex(u), 12, '0'))::uuid, 'linkedin_export',
       'Person ' || u || ' ' || i, case when i % 3 = 0 then 'p' || u || '.' || i || '@co' || (i % 50) || '.com' end,
       'Co' || (i % 50), 'co' || (i % 50), 'Engineer', 'Connections.csv, row ' || i,
       case when i % 3 = 0 then 'e:p' || u || '.' || i || '@co' || (i % 50) || '.com' else 'n:person ' || u || ' ' || i || '|co' || (i % 50) end
from generate_series(1, 10000) u, generate_series(1, 100) i""")
q("analyze career_people")
load_s = time.monotonic() - t0
n = int(q("select count(*) from career_people where source = 'linkedin_export' and source_ref like 'Connections.csv, row %' and user_id::text like '00000000-0000-4000-8000-%'"))
assert n >= 1_000_000, n
ok(f"1,000,000 people rows loaded and analyzed in {load_s:.1f} s")

# One shared discovery: 100 people at co7 (domain co7.com, MX present): even ones with a published address, odd ones with
# none, so their address is inferred from co7.com's learned format (first.last, 5 addresses of evidence). Delivered to
# people 1..1000, none of whom has any of them yet.
q("""insert into career_email_domains (domain, mx) values ('co7.com', 'pass'), ('co9.com', 'pass') on conflict do nothing;
insert into career_email_formats (domain, format, evidence) values ('co7.com', 'first.last', 5) on conflict do nothing;
insert into career_provider_cache (provider, query_key, company, company_key, domain, results, expires_at) values ('web', 'scale|co7', 'Co7', 'co7', 'co7.com', 100, now() + interval '1 day');
insert into career_provider_people (cache_id, provider, provider_id, name, email, company, company_key, domain, position, source_ref, source_url)
select (select id from career_provider_cache where query_key = 'scale|co7'), 'web', 'co7.com:' || g, 'Ann ' || translate(g::text, '0123456789', 'abcdefghij'),
       case when g % 2 = 0 then 'ann.' || translate(g::text, '0123456789', 'abcdefghij') || '@co7.com' end, 'Co7', 'co7', 'co7.com', 'Engineering Manager',
       'public page, co7.com', 'https://co7.com/team'
from generate_series(1, 100) g""")
plan_e = q("""explain select id from career_people where user_id = '00000000-0000-4000-8000-000000000001' and email = 'p1.9@co9.com' limit 1""")
plan_n = q("""explain select id, email from career_people where user_id = '00000000-0000-4000-8000-000000000001' and name is not null
  and career_people_name_key(name, company_key) = career_people_name_key('Person 1 7', 'co7') order by (source = 'provider'), id limit 1""")
assert "career_people_user_email" in plan_e, plan_e
assert "career_people_user_name_key" in plan_n, plan_n
ok("the dedupe reads are index scans at 1M rows (career_people_user_email, career_people_user_name_key)")

t0 = time.monotonic()
out = q("""select sum((d->>'inserted')::int) || ':' || sum((d->>'already_known')::int) || ':' || sum((d->>'inferred')::int)
  from (select career_provider_deliver(('00000000-0000-4000-8000-' || lpad(to_hex(u), 12, '0'))::uuid, (select id from career_provider_cache where query_key = 'scale|co7')) d
        from generate_series(1, 1000) u) x""")
deliver_s = time.monotonic() - t0
assert out == "100000:0:50000", out
t0 = time.monotonic()
again = q("""select sum((d->>'inserted')::int) || ':' || sum((d->>'refreshed')::int)
  from (select career_provider_deliver(('00000000-0000-4000-8000-' || lpad(to_hex(u), 12, '0'))::uuid, (select id from career_provider_cache where query_key = 'scale|co7')) d
        from generate_series(1, 1000) u) x""")
redeliver_s = time.monotonic() - t0
assert again == "0:100000", again
ok(f"100 discovered people (50 published, 50 inferred from the shared format) delivered to 1,000 people over 1M rows: 100,000 rows in {deliver_s:.1f} s ({100000 / deliver_s:,.0f} rows/s); "
   f"a repeat refreshes in place, no duplicate, in {redeliver_s:.1f} s")
# dedupe against the export at scale: a published address the export already has, and the export's name without one
q("""insert into career_provider_cache (provider, query_key, company, company_key, domain, results, expires_at) values ('web', 'scale|dupe', 'Co9', 'co9', 'co9.com', 2, now() + interval '1 day');
insert into career_provider_people (cache_id, provider, provider_id, name, email, company, company_key, domain, source_ref, source_url)
values ((select id from career_provider_cache where query_key = 'scale|dupe'), 'web', 'd1', 'P Nine', 'p5.9@co9.com', 'Co9', 'co9', 'co9.com', 'x', 'https://co9.com/a'),
       ((select id from career_provider_cache where query_key = 'scale|dupe'), 'web', 'd2', 'person 5  7', 'p57@co7.com', 'Co7', 'co7', 'co9.com', 'x', 'https://co9.com/b')""")
d = q("select career_provider_deliver('00000000-0000-4000-8000-000000000005', (select id from career_provider_cache where query_key = 'scale|dupe'))::text")
assert d == '{"linked": 1, "inferred": 0, "inserted": 1, "refreshed": 0, "already_known": 1}', d
ok("dedupe at scale: the export's address is known (not stored again); the export's name without an address is linked (same_as)")

# ------------------------------------------------------------------------------------------------ 2. the queue
q("""create or replace procedure public.scale_worker(p_name text, p_batch int) language plpgsql as $$
declare j record; n int;
begin
  loop
    n := 0;
    for j in select * from career_provider_claim(p_batch, 60, null) loop
      insert into scale_claims (job_id, worker) values (j.id, p_name);
      perform career_provider_complete(j.id, j.lease_token, 'Co', 'co', null, 'not_run', '[]'::jsonb, 1, null);
      n := n + 1;
    end loop;
    commit;
    exit when n = 0;
  end loop;
end $$;
create table if not exists public.scale_claims (seq bigint generated always as identity, job_id bigint not null, worker text not null, at timestamptz not null default clock_timestamp());""")
# Each ask is its own transaction, as in production (one advisory lock each, released at commit).
q("""create or replace procedure public.scale_enqueue(p_heavy uuid, p_heavy_n int, p_light int, p_per int) language plpgsql as $$
declare i int; u int; k int;
begin
  for i in 1 .. p_heavy_n loop perform career_provider_request(p_heavy, 'web', 'heavy|' || i, '{}'::jsonb, 86400); commit; end loop;
  for u in 1 .. p_light loop
    for k in 1 .. p_per loop
      perform career_provider_request(('00000000-0000-4000-8000-' || lpad(to_hex(u), 12, '0'))::uuid, 'web', 'light|' || u || '|' || k, '{}'::jsonb, 86400);
      commit;
    end loop;
  end loop;
end $$""")
t0 = time.monotonic()
# the heavy person queues all 5,000 first; then 10,000 people 5 each
q(f"call public.scale_enqueue('{HEAVY_USER}'::uuid, {HEAVY}, {LIGHT}, {PER})")
queue_s = time.monotonic() - t0
total = HEAVY + LIGHT * PER
assert q("select count(*) from career_provider_jobs where state = 'queued'") == str(total)
ok(f"{total:,} lookups queued by {LIGHT + 1:,} people in {queue_s:.1f} s")

t0 = time.monotonic()
procs = [subprocess.Popen(PSQL + ["-c", f"call public.scale_worker('w{i}', {BATCH})"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for i in range(WORKERS)]
for p in procs:
    _, err = p.communicate(timeout=1800)
    assert p.returncode == 0, err
run_s = time.monotonic() - t0
assert q("select count(*) from career_provider_jobs where state = 'done'") == str(total), "every job done"
assert q("select count(*) from scale_claims") == str(total), "claimed exactly once each in all"
assert q("select count(*) from (select job_id from scale_claims group by 1 having count(*) > 1) x") == "0", "no job claimed twice"
assert q("select count(*) from career_provider_lookups where kind = 'api' and (query_key like 'heavy|%' or query_key like 'light|%')") == str(total), "one ledger row per lookup"
busy = int(q("select count(distinct worker) from scale_claims"))
assert busy == WORKERS, busy
ok(f"{total:,} lookups claimed and completed by {WORKERS} concurrent workers exactly once in {run_s:.1f} s ({total / run_s:,.0f} lookups/s); all {busy} workers took work")
heavy_1000 = int(q(f"""select seq from (select c.seq, row_number() over (order by c.seq) rn from scale_claims c join career_provider_jobs j on j.id = c.job_id
  where j.query_key like 'heavy|%') x where rn = 1000"""))
last_first = int(q("""select max(first) from (select min(c.seq) first from scale_claims c join career_provider_jobs j on j.id = c.job_id
  where j.query_key like 'light|%' group by split_part(j.query_key, '|', 2)) x"""))
assert last_first < heavy_1000, (last_first, heavy_1000)
ok(f"fair: every light person's first lookup was claimed by claim #{last_first:,}; the heavy person's 1,000th at #{heavy_1000:,}, though queued first")

q("drop procedure public.scale_worker(text, int); drop procedure public.scale_enqueue(uuid, int, int, int); drop table public.scale_claims;"
  "delete from career_provider_jobs; delete from career_provider_lookups; delete from career_provider_cache; delete from career_provider_user_clock;"
  "delete from career_email_formats where domain in ('co7.com', 'co9.com'); delete from career_email_domains where domain in ('co7.com', 'co9.com');"
  "delete from career_people where user_id::text like '00000000-0000-4000-8000-%';"
  # The 10,001 people's other rows are gone above; their account rows go without walking every table that references a
  # person (a cascade check per row over ~100 tables took most of the run). Nothing else of theirs was written.
  "set session_replication_role = replica; delete from public.profiles where id::text like '00000000-0000-4000-8000-%';"
  " delete from auth.users where id::text like '00000000-0000-4000-8000-%'; set session_replication_role = origin;")
ok("scale data removed")
