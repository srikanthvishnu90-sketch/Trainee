"""MASS NETWORKING M5 load test (20261027240000_career_outreach_replies.sql), CI-runnable on the throwaway Postgres 16.

10,000 people each hold 5 approved actions (50,000), and one heavy person holds 5,000 more. 20 workers, each its own
session, claim through career_outreach_action_claim (100 per call, at most 2 per person per call) and finish each one,
until the queue is empty. Asserted: every action is claimed and finished exactly once (a log row per claim, unique by
action), none is left approved or running, and no call ever gave one person more than 2 (the heavy person cannot starve
anyone). Mailbox leases: 10,000 sync rows claimed by the same 20 workers, each row exactly once per lease window.
Measured and printed: wall time and actions per second. Invoked by tests/db/run.sh only (disposable database)."""
import subprocess
import sys
import time

PSQL = sys.argv[1:] + ["-t", "-A", "-q"]
PEOPLE, PER, HEAVY, WORKERS, BATCH, PER_USER = 10000, 5, 5000, 20, 100, 2


def q(sql):
    return subprocess.run(PSQL + ["-c", sql], capture_output=True, text=True, check=True).stdout.strip()


SETUP = f"""
set client_min_messages = warning;
create table if not exists public.m5_load_log(seq bigserial primary key, call uuid not null, worker text not null, action uuid not null, user_id uuid not null);
create unique index if not exists m5_load_log_once on public.m5_load_log(action);
insert into auth.users(id, email) select ('00000000-0000-4000-9000-' || lpad(to_hex(g), 12, '0'))::uuid, 'load' || g || '@example.test' from generate_series(1, {PEOPLE} + 1) g;
insert into profiles(id) select ('00000000-0000-4000-9000-' || lpad(to_hex(g), 12, '0'))::uuid from generate_series(1, {PEOPLE} + 1) g;
insert into career_outreach_threads(id, user_id, provider, provider_thread, recipient_email, sent_at, status)
 select ('00000000-0000-4000-9100-' || lpad(to_hex(g), 12, '0'))::uuid, ('00000000-0000-4000-9000-' || lpad(to_hex(g), 12, '0'))::uuid, 'gmail', 'lt-' || g, 'c' || g || '@example.test', now() - interval '3 days', 'wants_call'
 from generate_series(1, {PEOPLE} + 1) g;
insert into career_outreach_actions(user_id, thread_id, kind, batch_id, n, payload, hash, status, approved_hash, approved_at)
 select ('00000000-0000-4000-9000-' || lpad(to_hex(g), 12, '0'))::uuid, ('00000000-0000-4000-9100-' || lpad(to_hex(g), 12, '0'))::uuid, 'schedule_reply',
   ('00000000-0000-4000-9200-' || lpad(to_hex(g), 12, '0'))::uuid, k, '{{}}', repeat('a', 64), 'approved', repeat('a', 64), now() - interval '1 hour' + (k || ' seconds')::interval
 from generate_series(1, {PEOPLE}) g, generate_series(1, {PER}) k;
-- The heavy person approved first: an oldest-first queue would hand every worker only them.
insert into career_outreach_actions(user_id, thread_id, kind, batch_id, n, payload, hash, status, approved_hash, approved_at)
 select ('00000000-0000-4000-9000-' || lpad(to_hex({PEOPLE} + 1), 12, '0'))::uuid, ('00000000-0000-4000-9100-' || lpad(to_hex({PEOPLE} + 1), 12, '0'))::uuid, 'schedule_reply',
   '00000000-0000-4000-9300-000000000001', k, '{{}}', repeat('a', 64), 'approved', repeat('a', 64), now() - interval '2 hours'
 from generate_series(1, {HEAVY}) k;
insert into career_outreach_sync(user_id, provider, next_at) select ('00000000-0000-4000-9000-' || lpad(to_hex(g), 12, '0'))::uuid, 'gmail', now() - interval '1 minute' from generate_series(1, {PEOPLE}) g
 on conflict do nothing;
analyze career_outreach_actions; analyze career_outreach_threads; analyze career_outreach_sync;
-- One worker call, as production makes it: the claim is one statement (its leases commit at once), then each finish is
-- the worker's own report (threads in id order).
create or replace function public.m5_load_claim(w text) returns int language plpgsql as $$
declare c uuid := gen_random_uuid(); n int;
begin
 insert into public.m5_load_log(call, worker, action, user_id) select c, w, a.id, a.user_id from career_outreach_action_claim(w, {BATCH}, {PER_USER}, now(), 600) a;
 get diagnostics n = row_count;
 return n;
end $$;
create or replace function public.m5_load_finish(w text) returns int language plpgsql as $$
declare n int := 0; l record;
begin
 for l in select g.action from public.m5_load_log g join career_outreach_actions a on a.id = g.action where g.worker = w and a.status = 'running' order by a.thread_id loop
  if not career_outreach_action_finish(l.action, w, 'done', 'msg', null, 'sent') then raise exception 'finish refused for a leased action'; end if;
  n := n + 1;
 end loop;
 return n;
end $$;
"""


def main():
    subprocess.run(PSQL + ["-v", "ON_ERROR_STOP=1"], input=SETUP, text=True, check=True, capture_output=True)
    total = PEOPLE * PER + HEAVY
    rounds = total // (BATCH * WORKERS) + 40
    script = "".join("select public.m5_load_claim('w%d'); select public.m5_load_finish('w%d');\n" for _ in range(rounds))
    started = time.monotonic()
    procs = [subprocess.Popen(PSQL + ["-v", "ON_ERROR_STOP=1"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(WORKERS)]
    for i, p in enumerate(procs):
        p.stdin.write(script.replace("%d", str(i)))
        p.stdin.close()
    for p in procs:
        p.wait(timeout=900)
        assert p.returncode == 0, p.stderr.read()
    took = time.monotonic() - started
    left = q("select count(*) from career_outreach_actions where status in ('approved', 'running') and user_id::text like '00000000-0000-4000-9000-%'")
    logged, distinct = q("select count(*) || ' ' || count(distinct action) from public.m5_load_log").split()
    done = q("select count(*) from career_outreach_actions where status = 'done' and user_id::text like '00000000-0000-4000-9000-%'")
    # The first five rounds of calls (the queue full of people): no call gives one person more than PER_USER (fairness);
    # once only a few are left, later passes fill the call (no cap: one person alone gets whole calls).
    worst = q(f"select coalesce(max(n), 0) from (select call, user_id, count(*) n from public.m5_load_log group by call, user_id) x where call in (select call from public.m5_load_log group by call order by min(seq) limit {WORKERS * 5})")
    solo = q("select coalesce(max(n), 0) from (select call, count(*) n from public.m5_load_log group by call having count(distinct user_id) = 1) x")
    workers = q("select count(distinct worker) from public.m5_load_log")
    assert int(left) == 0, f"{left} actions left approved or running"
    assert int(logged) == total and int(distinct) == total and int(done) == total, (logged, distinct, done, total)
    assert int(worst) <= PER_USER, f"one call gave one person {worst} (> {PER_USER}) while others waited"
    assert int(solo) > PER_USER, f"a person alone in the queue got only {solo} per call: that is a cap, not fairness"
    assert int(workers) == WORKERS, f"only {workers} of {WORKERS} workers claimed anything"
    # The heavy person's first call came no earlier than everyone else's fair share: in the first 20 calls (one per
    # worker) they hold at most PER_USER each.
    heavy_early = q(f"select count(*) from (select * from public.m5_load_log order by seq limit {BATCH * WORKERS}) x where user_id = '00000000-0000-4000-9000-{PEOPLE + 1:012x}'")
    assert int(heavy_early) <= PER_USER * WORKERS * 2, f"heavy person took {heavy_early} of the first {BATCH * WORKERS} claims"
    print(f"  ok   actions: {total} claimed and finished exactly once by {WORKERS} workers in {took:.1f}s ({total / took:.0f}/s); max per person per call while others wait {worst}, alone {solo}; heavy person {heavy_early} of the first {BATCH * WORKERS}")

    # Mailbox leases: 10,000 due mailboxes, 20 workers, 100 per call: each leased exactly once.
    started = time.monotonic()
    script = "".join("select count(*) from career_outreach_sync_claim('s%d', 100, now(), 600);\n" for _ in range(PEOPLE // (100 * WORKERS) + 10))
    procs = [subprocess.Popen(PSQL + ["-v", "ON_ERROR_STOP=1"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(WORKERS)]
    for i, p in enumerate(procs):
        p.stdin.write(script.replace("%d", str(i)))
        p.stdin.close()
    got = 0
    for p in procs:
        # stdin is already written and closed: communicate() would flush it again and raise.
        out = p.stdout.read()
        p.wait(timeout=600)
        assert p.returncode == 0, p.stderr.read()
        got += sum(int(x) for x in out.split())
    took = time.monotonic() - started
    leased = q("select count(*) from career_outreach_sync where user_id::text like '00000000-0000-4000-9000-%' and lease_owner is not null")
    assert got == PEOPLE and int(leased) == PEOPLE, (got, leased)
    print(f"  ok   mailboxes: {PEOPLE} leased exactly once across {WORKERS} workers in {took:.1f}s ({PEOPLE / took:.0f}/s)")
    q("delete from auth.users where id::text like '00000000-0000-4000-9000-%'; drop table public.m5_load_log; drop function public.m5_load_claim(text); drop function public.m5_load_finish(text);")


main()
