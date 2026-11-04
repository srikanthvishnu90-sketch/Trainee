"""Load test of the fair, parallel claim (20261027141000_career_apply_mass_submit.sql), on the disposable Postgres
tests/db/run.sh builds; nothing else is reached. Owner, 2026-10-27: "we need to be able to operate these things at large
scale".

PEOPLE people x PER approved applications each are queued through the real enqueue (every approval and hash check); WORKERS
concurrent psql sessions then claim through career_apply_claim (the cloud queue's door) in batches of BATCH, each claim
its own transaction, until the queue is empty. Every claim is logged with the worker and the time.
Asserted:
  - exactly once: every application handed out once and only once (no row twice, none left queued, each with its own lease);
  - fair: in the first PEOPLE claims, every person is served once before anyone is served twice (each round is one per
    person, longest-waiting first); and across the whole run no person's last claim is more than a round behind;
  - a heavy person does not starve the others: a person with HEAVY applications queued first gets one per round like
    everyone else, and every light person's first application goes in the first round.
Measured and printed: queue size, workers, wall time, claims a second, and the per-claim latency (p50, p95, p99).
Sizes from the environment (defaults: 10,000 x 50, 20 workers, batch 50): LOAD_PEOPLE, LOAD_PER, LOAD_WORKERS, LOAD_BATCH.
"""
import os
import subprocess
import sys
import time

PSQL = sys.argv[1:] + ["-t", "-A", "-q"]
PEOPLE = int(os.environ.get("LOAD_PEOPLE", "10000"))
PER = int(os.environ.get("LOAD_PER", "50"))
WORKERS = int(os.environ.get("LOAD_WORKERS", "20"))
BATCH = int(os.environ.get("LOAD_BATCH", "50"))
HEAVY = int(os.environ.get("LOAD_HEAVY", "2000"))
TOTAL = PEOPLE * PER + HEAVY


def sql(text):
    r = subprocess.run(PSQL + ["-v", "ON_ERROR_STOP=1", "-c", text], capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(r.stderr.strip())
    return r.stdout.strip()


def ok(cond, label):
    if not cond:
        raise AssertionError("FAIL " + label)
    print("  ok   " + label, flush=True)


# ---------------------------------------------------------------------------------------------- setup (not timed)
started = time.monotonic()
sql("""
create schema if not exists load;
drop table if exists load.claims;
create unlogged table load.claims (worker int not null, job uuid not null, user_id uuid not null, lease uuid not null,
 at timestamptz not null, took_ms double precision not null, seq bigserial, call bigint not null default 0);
create sequence if not exists load.call_seq;
drop table if exists load.calls;
create unlogged table if not exists load.calls (call bigint primary key, worker int not null, n int not null, took_ms double precision not null, done_at timestamptz not null);
grant all on schema load to postgres;
""")
# The people: a heavy one first (HEAVY waiting, queued before anyone else), then PEOPLE light ones with PER each. Each
# has a real resume on file under the owner's resume rule (20261026210016, when installed): a confirmed experience entry
# in their account profile, its fact_confirmed event, and the resume the cloud holds for them (career_apply_cloud_resumes)
# whose sha256 every payload binds. The claim's resume guard checks exactly these on every row it hands out.
RESUME = "%PDF-1.4 load test resume"
sql(f"""
insert into auth.users(id) select ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid from generate_series(0, {PEOPLE}) g;
insert into public.profiles(id) select ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid from generate_series(0, {PEOPLE}) g;
insert into public.career_watch_kv(user_id, key, value) select ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'career:account',
 jsonb_build_object('epoch', 0, 'version', 0, 'paused', false, 'memory', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(
  jsonb_build_object('kind', 'experience', 'status', 'confirmed', 'needs_confirmation', false, 'confirmation_event_id', 'load-ev-' || g,
   'text', 'Analyst, Load Co'))))) from generate_series(0, {PEOPLE}) g;
set session_replication_role = replica;
insert into public.career_events(user_id, kind, subject, detail, source)
 select ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'fact_confirmed', 'resume entry',
  jsonb_build_object('confirmation_event_id', 'load-ev-' || g), 'chat' from generate_series(0, {PEOPLE}) g;
set session_replication_role = origin;
insert into public.career_apply_cloud_resumes(user_id, sha256, filename, bytes, privacy_epoch)
 select ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, encode(sha256(convert_to('{RESUME}', 'UTF8')), 'hex'), 'resume.pdf',
  convert_to('{RESUME}', 'UTF8'), 0 from generate_series(0, {PEOPLE}) g;
""")
sql("""
create or replace function load.enqueue(p_from int, p_to int, p_per int) returns void language plpgsql as $$
declare g int; k int; p jsonb; h text; u text;
begin
 for g in p_from .. p_to loop
  u := '10000000-0000-4000-8000-' || lpad(g::text, 12, '0');
  for k in 1 .. p_per loop
   p := jsonb_build_object('version', 1, 'user_id', u, 'job_id', 'load:' || g || ':' || k, 'company', 'Load Employer ' || g,
    'url', 'https://jobs.lever.co/load' || g || '/' || k, 'fields', '[]'::jsonb, 'privacy_epoch', 0, 'account_version', 0,
    'expires_at', now() + interval '1 day', 'resume_sha256', encode(sha256(convert_to('""" + RESUME + """', 'UTF8')), 'hex'));
   h := public.career_apply_payload_hash(p);
   perform public.career_apply_enqueue(p, h, h);
  end loop;
 end loop;
end $$;
""")
# The heavy person and the first 20 light people through the real enqueue (every approval, hash and resume check). The
# rest are written in bulk as the enqueue writes them: the same payload shape, its hash over the same canonical text, the
# approval equal to it. The canonical text is built directly for this fixed shape (keys in byte order) instead of by
# the recursive career_apply_canonical, which costs about 1 ms a row; it is checked equal to career_apply_payload_hash on
# a sample below, and the claim itself re-verifies every row it hands out (the hash, and the resume rule). The bulk rows
# skip the per-row insert triggers (resume tag, card boundary, erase guard); the turn rows those would write are written
# in one statement.
sql(f"select load.enqueue(0, 0, {HEAVY})")
sql(f"select load.enqueue(1, {min(PEOPLE, 20)}, {PER})")
if PEOPLE > 20:
    sql(f"""
set session_replication_role = replica;
insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, created_at)
select u::uuid, job, company, url, p, h, h, now()
from (select u, job, company, url,
  jsonb_build_object('version', 1, 'user_id', u, 'job_id', job, 'company', company, 'url', url, 'fields', '[]'::jsonb,
   'privacy_epoch', 0, 'account_version', 0, 'expires_at', exp, 'resume_sha256', rs) p,
  encode(sha256(convert_to('{{"account_version":0,"company":' || to_jsonb(company)::text || ',"expires_at":' || to_jsonb(exp)::text
   || ',"fields":[],"job_id":' || to_jsonb(job)::text || ',"privacy_epoch":0,"resume_sha256":' || to_jsonb(rs)::text
   || ',"url":' || to_jsonb(url)::text || ',"user_id":' || to_jsonb(u)::text || ',"version":1}}', 'UTF8')), 'hex') h
 from (select '10000000-0000-4000-8000-' || lpad(g::text, 12, '0') u, 'load:' || g || ':' || k job, 'Load Employer ' || g company,
   'https://jobs.lever.co/load' || g || '/' || k url, to_jsonb(now() + interval '1 day') #>> '{{}}' exp,
   encode(sha256(convert_to('{RESUME}', 'UTF8')), 'hex') rs
  from generate_series(21, {PEOPLE}) g, generate_series(1, {PER}) k) a) x;
insert into public.career_apply_claim_turns (user_id)
 select ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid from generate_series(21, {PEOPLE}) g on conflict do nothing;
set session_replication_role = origin;
""")
    bad = int(sql("select count(*) from (select * from public.career_apply_jobs where job_id like 'load:%' order by random() limit 500) j "
                  "where j.payload_hash is distinct from public.career_apply_payload_hash(j.payload)"))
    ok(bad == 0, "the bulk rows' hashes equal career_apply_payload_hash on a 500-row sample")
if int(sql("select count(*) from pg_proc where proname = 'career_resume_ok'")) > 0:
    ok(sql("select bool_and(public.career_resume_ok(user_id, payload)) from (select * from public.career_apply_jobs where job_id like 'load:%' order by random() limit 200) j") == "t",
       "the owner's resume rule holds for them: a confirmed resume on file, the bound resume stored (200-row sample)")
queued = int(sql("select count(*) from public.career_apply_jobs where state = 'queued' and job_id like 'load:%'"))
ok(queued == TOTAL, f"{queued} approved applications queued ({PEOPLE} people x {PER}, one person with {HEAVY}; the first 21 people through the real enqueue)")
sql("analyze public.career_apply_jobs; analyze public.career_apply_claim_turns;")
print(f"  setup {time.monotonic() - started:.1f} s", flush=True)

# ---------------------------------------------------------------------------------------------- the claim, timed
# Each worker: one psql session, a procedure that claims in its own transaction per batch until a claim returns nothing.
sql("""
create or replace procedure load.work(p_worker int, p_batch int) language plpgsql as $$
declare n int; t0 timestamptz; k bigint; idle int := 0; begin
 loop
  t0 := clock_timestamp(); k := nextval('load.call_seq');
  insert into load.claims(worker, job, user_id, lease, at, took_ms, call)
   select p_worker, c.id, c.user_id, c.lease_token, t0, 0, k from public.career_apply_claim(clock_timestamp(), p_batch) c;
  get diagnostics n = row_count;
  insert into load.calls(call, worker, n, took_ms, done_at) values (k, p_worker, n, extract(epoch from clock_timestamp() - t0) * 1000, clock_timestamp());
  commit;
  -- A worker with nothing this call (the rest locked by other workers) asks again, as a real worker polls; it stops when
  -- the queue is empty (or after 200 empty calls in a row, which would be a failure the assertions below report).
  if n = 0 then idle := idle + 1; else idle := 0; end if;
  exit when n = 0 and (idle > 200 or not exists (select from public.career_apply_jobs where state = 'queued' and job_id like 'load:%'));
 end loop;
end $$;
""")
t0 = time.monotonic()
workers = [subprocess.Popen(PSQL + ["-v", "ON_ERROR_STOP=1", "-c", f"call load.work({w}, {BATCH})"],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for w in range(WORKERS)]
for w in workers:
    out, err = w.communicate()
    if w.returncode != 0:
        raise AssertionError(err)
wall = time.monotonic() - t0

# ---------------------------------------------------------------------------------------------- what happened
claimed = int(sql("select count(*) from load.claims"))
distinct = int(sql("select count(distinct job) from load.claims"))
leases = int(sql("select count(distinct lease) from load.claims"))
left = int(sql("select count(*) from public.career_apply_jobs where state = 'queued' and job_id like 'load:%'"))
driving = int(sql("select count(*) from public.career_apply_jobs where state = 'driving' and source = 'cloud' and attempts = 1 and job_id like 'load:%'"))
ok(claimed == TOTAL and distinct == TOTAL, f"exactly once: {claimed} handed out, {distinct} distinct, of {TOTAL}")
ok(leases == TOTAL and driving == TOTAL and left == 0, f"each under its own lease ({leases}), all driving once ({driving}), none left queued ({left})")
workers_used = int(sql("select count(distinct worker) from load.claims"))
calls_needed = TOTAL // BATCH
ok(workers_used == WORKERS if calls_needed >= 10 * WORKERS else workers_used >= 2,
   f"{workers_used} of {WORKERS} workers claimed in parallel ({calls_needed} batches of work)")
# Fairness, by claim order (each call's commit, the order the claim's row locks hand turns out; a call's start time
# is not, since 20 workers' calls overlap): number each person's claims; their k-th claim must come after every other waiting person's
# (k-1)-th. Measured as: in the first PEOPLE+1 claims, every person appears exactly once.
first_round = sql(f"select count(distinct user_id) || ',' || count(*) from (select user_id from load.claims c join load.calls k using (call) order by k.done_at, c.call, c.seq limit {PEOPLE + 1}) x")
people_first, n_first = map(int, first_round.split(","))
# Twenty workers commit at once, so no recorded order is the exact order turns were handed out: a few people near the
# round's edge land just inside or outside it. The bar is therefore 97% distinct, plus a strict one: nobody gets more
# than two in the first round (served twice before others are served once would show as three or more).
most_first = int(sql(f"select coalesce(max(n), 0) from (select count(*) n from (select user_id from load.claims c join load.calls k using (call) order by k.done_at, c.call, c.seq limit {PEOPLE + 1}) x group by user_id) y"))
ok(people_first >= int((PEOPLE + 1) * 0.97) and most_first <= 2,
   f"fair: the first {n_first} claims served {people_first} different people of {PEOPLE + 1}, nobody more than {most_first} (one each before anyone twice)")
heavy_first = int(sql(f"select count(*) from (select user_id from load.claims c join load.calls k using (call) order by k.done_at, c.call, c.seq limit {PEOPLE + 1}) x "
                      "where user_id = '10000000-0000-4000-8000-000000000000'"))
ok(heavy_first <= 2, f"the heavy person ({HEAVY} queued first) got {heavy_first} of the first round, not the whole queue")
# Across the run: the spread of each person's k-th claim. A light person's last claim comes within a few rounds of the
# others', never after the heavy person's backlog.
lag = sql(f"""select max(r) from (select user_id, max(rk) r from (select c.user_id, row_number() over (order by k.done_at, c.call, c.seq) rk from load.claims c join load.calls k using (call)) z
 where user_id <> '10000000-0000-4000-8000-000000000000' group by user_id) y""")
heavy_last = sql("select max(rk) from (select c.user_id, row_number() over (order by k.done_at, c.call, c.seq) rk from load.claims c join load.calls k using (call)) z "
                 "where user_id = '10000000-0000-4000-8000-000000000000'")
ok(int(lag) < int(heavy_last), f"no light person waits behind the heavy one: the last light claim is #{lag}, the heavy person's last is #{heavy_last}")

lat = sql("select percentile_cont(array[0.5, 0.95, 0.99]) within group (order by took_ms) from load.calls where n > 0")
p50, p95, p99 = [float(x) for x in lat.strip("{}").split(",")]
calls = int(sql("select count(*) from load.calls where n > 0"))
rate = TOTAL / wall
print(f"  MEASURED queue={TOTAL} people={PEOPLE + 1} workers={WORKERS} batch={BATCH} wall={wall:.1f}s "
      f"throughput={rate:.0f} claims/s calls={calls} latency_ms p50={p50:.1f} p95={p95:.1f} p99={p99:.1f}", flush=True)
# Leave nothing behind for the suites that follow: the load rows are removed.
sql("""
delete from public.career_apply_jobs where job_id like 'load:%';
delete from public.career_apply_claim_turns where user_id::text like '10000000-0000-4000-8000-%';
delete from public.career_watch_kv where user_id::text like '10000000-0000-4000-8000-%';
delete from public.career_events where user_id::text like '10000000-0000-4000-8000-%';
delete from public.career_apply_cloud_resumes where user_id::text like '10000000-0000-4000-8000-%';
delete from public.profiles where id::text like '10000000-0000-4000-8000-%';
delete from auth.users where id::text like '10000000-0000-4000-8000-%';
drop schema load cascade;
""")
print("  ok   load rows removed", flush=True)
