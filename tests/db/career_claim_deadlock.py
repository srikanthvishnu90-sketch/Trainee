"""Outreach claim deadlock (20261105180000_career_claim_deadlock.sql), CI-runnable on the throwaway Postgres 16.

The M5 load test once failed with "deadlock detected ... while locking updated version of tuple in relation
career_outreach_actions" inside career_outreach_action_claim's FOR ... FOR UPDATE SKIP LOCKED loop. Two claims read the same
person's approved actions at once; a row the other worker leased after this read's snapshot is still 'approved' in it, and
FOR UPDATE follows it to its newer version and locks that (the other worker's leased row) before finding it no longer
approved. The claim keeps the lock; the other worker's finish waits for it; when the claim then waits for that worker, there
is a cycle (SKIP LOCKED covers neither wait).

1. The exact interleaving, every time (three sessions, ordered by sleeps): person D's oldest action is a follow-up on a
   thread that has a reply (refused: its thread's sequence ends), then 9 scheduling replies, then 10 more on thread T3, then
   a follow-up on T3 that is refused too. Session X holds T1 for a moment, so worker B's claim (share 30) stops at the
   first refusal with D's first 10 rows read and locked. Worker A claims D (share 10): the 10 rows after B's, committed. A
   finishes its first one (T3 updated) and, in the same transaction, the next. B then goes on with its old read: it locks
   A's other leased rows, and ends T3's sequence: B waits for A, A waits for B. Asserted: no session errors (no deadlock),
   no action leased twice, all 19 scheduling replies leased, and (after one more claim) both follow-ups refused and their
   threads' sequences ended.
2. Contention rounds (the load test's tail, where every worker is on the same people): 2 people with 3,000 scheduling
   replies each on one thread and an open follow-up there (refused at the claim: the thread wants a call), 32 workers
   claiming 100 at a time, 2 per person per pass, each finishing its whole lease in one transaction, threads in id order
   (as the load test's worker). On 20261027240000's claim about a third of rounds deadlock. Asserted, every round: no worker
   statement errors, every claimable action claimed and finished exactly once, every refused one refused, nothing left
   approved or running, no call above its limit.

Usage: career_claim_deadlock.py <psql args...>   (ROUNDS: contention rounds, default 3; ONLY=1|2: one part; KEEP_GOING=1
counts failures over every round (and ONLY=1 repeats the interleaving ROUNDS times) instead of stopping at the first, to
measure a definition's failure rate; SHAPE=people,threads,per_thread,workers,limit,per_person and FOLLOWUPS=0 vary part 2).
Invoked by tests/db/run.sh only (disposable database)."""
import os
import subprocess
import sys
import time

PSQL = sys.argv[1:] + ["-t", "-A", "-q"]
ROUNDS = int(os.environ.get("ROUNDS", "3"))
ONLY = os.environ.get("ONLY", "")
KEEP_GOING = os.environ.get("KEEP_GOING") == "1"
U = "00000000-0000-4000-9800-"   # people
T = "00000000-0000-4000-9900-"   # threads: T + 4 hex person + 8 hex thread number
D_USER = U + "00000000d001"


def q(sql):
    return subprocess.run(PSQL + ["-c", sql], capture_output=True, text=True, check=True).stdout.strip()


def run(sql):
    subprocess.run(PSQL + ["-v", "ON_ERROR_STOP=1"], input="set client_min_messages = warning;\n" + sql, text=True, check=True, capture_output=True)


def start(sql, stop="1"):
    p = subprocess.Popen(PSQL + ["-v", "ON_ERROR_STOP=" + stop], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    p.stdin.write("set client_min_messages = warning;\n" + sql)
    p.stdin.close()
    return p


def errors_of(procs):
    out = []
    for p in procs:
        err = p.stderr.read()
        p.stdout.read()
        p.wait(timeout=600)
        out += [line for line in err.splitlines() if "ERROR:" in line]
    return out


def clean():
    run(f"delete from auth.users where id::text like '{U}%';")


def thread_sql(tid, uid, status, replied):
    return (f"insert into career_outreach_threads(id, user_id, provider, provider_thread, recipient_email, sent_at, status, replied_at)"
            f" values ('{tid}', '{uid}', 'gmail', 'dl-{tid}', 'dl-{tid[-8:]}@example.test', now() - interval '9 days', '{status}',"
            f" {'now() - interval ' + chr(39) + '1 day' + chr(39) if replied else 'null'});")


def action_sql(uid, tid, kind, n, secs, step="null"):
    return (f"insert into career_outreach_actions(user_id, thread_id, kind, step, batch_id, n, payload, hash, status, approved_hash, approved_at)"
            f" values ('{uid}', '{tid}', '{kind}', {step}, gen_random_uuid(), {n}, '{{}}', repeat('a', 64), 'approved', repeat('a', 64),"
            f" now() - interval '2 hours' + interval '{secs} seconds');")


# ------------------------------------------------------------------------------------------------ 1. the exact interleaving
def interleaving():
    clean()
    t1, t2, t3 = (T + "d001" + "%08x" % i for i in (1, 2, 3))
    sql = [f"insert into auth.users(id, email) values ('{D_USER}', 'dld@example.test'); insert into profiles(id) values ('{D_USER}');",
           thread_sql(t1, D_USER, "awaiting", True), thread_sql(t2, D_USER, "wants_call", False), thread_sql(t3, D_USER, "wants_call", False)]
    sql.append(action_sql(D_USER, t1, "followup", 1, 1, step=1))
    sql += [action_sql(D_USER, t2, "schedule_reply", 1 + k, 1 + k) for k in range(1, 10)]
    sql += [action_sql(D_USER, t3, "schedule_reply", 11 + k, 11 + k) for k in range(10)]
    sql.append(action_sql(D_USER, t3, "followup", 21, 21, step=1))
    run("\n".join(sql))
    ids = q(f"select string_agg(id::text, ' ' order by approved_at) from career_outreach_actions where user_id = '{D_USER}'").split()
    assert len(ids) == 21
    x = start(f"begin; select 1 from career_outreach_threads where id = '{t1}' for update; select pg_sleep(3); commit;\n")
    time.sleep(0.4)
    b = start("select count(*) from career_outreach_action_claim('dl-B', 100, 30, now(), 600);\n")
    time.sleep(0.6)
    a = start("select count(*) from career_outreach_action_claim('dl-A', 10, 10, now(), 600);\n"
              f"begin; select career_outreach_action_finish('{ids[10]}', 'dl-A', 'done', 'msg', null, 'sent'); select pg_sleep(3.5);"
              f" select career_outreach_action_finish('{ids[11]}', 'dl-A', 'done', 'msg', null, 'sent'); commit;\n")
    errors = errors_of([x, b, a])
    # Whatever was left for later (a refused follow-up whose thread was busy goes back to approved): the next claim.
    q("select count(*) from career_outreach_action_claim('dl-C', 100, 30, now(), 600)")
    unleased = q(f"select count(*) from career_outreach_actions where user_id = '{D_USER}' and status = 'running' and lease_owner is null")
    refused = q(f"select count(*) from career_outreach_actions where user_id = '{D_USER}' and kind = 'followup' and status = 'refused' and result = 'replied'")
    off = q(f"select count(*) from career_outreach_threads where id in ('{t1}', '{t3}') and followup_state = 'off'")
    leased = q(f"select count(*) from career_outreach_actions where user_id = '{D_USER}' and kind = 'schedule_reply' and status in ('running', 'done')")
    clean()
    problems = []
    if errors:
        problems.append(f"{len(errors)} session errors ({sum('deadlock detected' in e for e in errors)} deadlocks), first: {errors[0]}")
    else:
        if int(unleased) != 0:
            problems.append(f"{unleased} running actions without a lease")
        if int(refused) != 2 or int(off) != 2:
            problems.append(f"refused follow-ups {refused} (want 2), threads ended {off} (want 2)")
        if int(leased) != 19:
            problems.append(f"{leased} of 19 scheduling replies leased")
    return problems


# ------------------------------------------------------------------------------------------------ 2. contention rounds
PEOPLE, THREADS, PER_THREAD, WORKERS, BATCH, PER_USER = (int(v) for v in os.environ.get("SHAPE", "2,1,3000,32,100,2").split(","))
FOLLOWUPS = os.environ.get("FOLLOWUPS", "1") == "1"


def contention_round():
    clean()
    # Per person: THREADS threads that want a call, each with PER_THREAD scheduling replies spread over the person's approval
    # order and one open follow-up (refused at the claim: the thread has a reply, which ends its sequence) in the middle.
    run(f"""
insert into auth.users(id, email) select ('{U}' || lpad(to_hex(g), 12, '0'))::uuid, 'dlc' || g || '@example.test' from generate_series(1, {PEOPLE}) g;
insert into profiles(id) select ('{U}' || lpad(to_hex(g), 12, '0'))::uuid from generate_series(1, {PEOPLE}) g;
insert into career_outreach_threads(id, user_id, provider, provider_thread, recipient_email, sent_at, status, replied_at)
 select ('{T}' || lpad(to_hex(g), 4, '0') || lpad(to_hex(h), 8, '0'))::uuid, ('{U}' || lpad(to_hex(g), 12, '0'))::uuid, 'gmail', 'dlc-' || g || '-' || h,
   'dlc' || g || '-' || h || '@example.test', now() - interval '9 days', 'wants_call', now() - interval '1 day'
 from generate_series(1, {PEOPLE}) g, generate_series(1, {THREADS}) h;
insert into career_outreach_actions(user_id, thread_id, kind, step, batch_id, n, payload, hash, status, approved_hash, approved_at)
 select ('{U}' || lpad(to_hex(g), 12, '0'))::uuid, ('{T}' || lpad(to_hex(g), 4, '0') || lpad(to_hex(h), 8, '0'))::uuid, 'schedule_reply', null,
   gen_random_uuid(), k, '{{}}', repeat('a', 64), 'approved', repeat('a', 64), now() - interval '3 hours' + ((k * {THREADS} + h) || ' seconds')::interval
 from generate_series(1, {PEOPLE}) g, generate_series(1, {THREADS}) h, generate_series(1, {PER_THREAD}) k;
-- One open follow-up per thread, in the middle of the person's order.
""" + ("" if not FOLLOWUPS else f"""insert into career_outreach_actions(user_id, thread_id, kind, step, batch_id, n, payload, hash, status, approved_hash, approved_at)
 select ('{U}' || lpad(to_hex(g), 12, '0'))::uuid, ('{T}' || lpad(to_hex(g), 4, '0') || lpad(to_hex(h), 8, '0'))::uuid, 'followup', 1,
   gen_random_uuid(), 1, '{{}}', repeat('a', 64), 'approved', repeat('a', 64), now() - interval '3 hours' + (({PER_THREAD} / 2 * {THREADS} + h) || ' seconds')::interval
 from generate_series(1, {PEOPLE}) g, generate_series(1, {THREADS}) h;
""") + """
analyze career_outreach_actions;
""")
    claimable = PEOPLE * THREADS * PER_THREAD
    refusable = PEOPLE * THREADS if FOLLOWUPS else 0
    calls = claimable // (BATCH * WORKERS) * 4 + 30
    # ON_ERROR_STOP off: a worker whose claim errors goes on (as a production worker retries), so every error is counted.
    script = "".join("select public.dl_claim('c%d'); select public.dl_finish('c%d');\n" for _ in range(calls))
    started = time.monotonic()
    procs = [start(script.replace("%d", str(i)), stop="0") for i in range(WORKERS)]
    errors = errors_of(procs)
    took = time.monotonic() - started
    left = q(f"select count(*) from career_outreach_actions where status in ('approved', 'running') and user_id::text like '{U}%'")
    logged, distinct = q(f"select count(*) || ' ' || count(distinct action) from public.dl_log where user_id::text like '{U}%'").split()
    done = q(f"select count(*) from career_outreach_actions where status = 'done' and user_id::text like '{U}%'")
    refused = q(f"select count(*) from career_outreach_actions where status = 'refused' and user_id::text like '{U}%'")
    ended = q(f"select count(*) from career_outreach_threads where followup_state = 'off' and user_id::text like '{U}%'")
    worst = q("select coalesce(max(n), 0) from (select call, count(*) n from public.dl_log group by call) x")
    problems = []
    if errors:
        problems.append(f"{len(errors)} worker statement errors ({sum('deadlock detected' in e for e in errors)} deadlocks), first: {errors[0]}")
    else:
        if int(left) != 0:
            problems.append(f"{left} actions left approved or running")
        if not (int(logged) == claimable and int(distinct) == claimable and int(done) == claimable and int(refused) == refusable and int(ended) == refusable):
            problems.append(f"not exactly once: logged {logged}, distinct {distinct}, done {done} of {claimable}; refused {refused}, ended {ended} of {refusable}")
    if int(worst) > BATCH:
        problems.append(f"one call took {worst} (> {BATCH})")
    q("delete from public.dl_log")
    clean()
    return problems, took, claimable


def contention():
    run(f"""
create table if not exists public.dl_log(seq bigserial primary key, call uuid not null, worker text not null, action uuid not null, user_id uuid not null);
create unique index if not exists dl_log_once on public.dl_log(action);
create or replace function public.dl_claim(w text) returns int language plpgsql as $$
declare c uuid := gen_random_uuid(); n int;
begin
 insert into public.dl_log(call, worker, action, user_id) select c, w, a.id, a.user_id from career_outreach_action_claim(w, {BATCH}, {PER_USER}, now(), 600) a;
 get diagnostics n = row_count;
 return n;
end $$;
-- The worker's whole lease finished in one transaction, threads in id order (as the M5 load test's worker).
create or replace function public.dl_finish(w text) returns int language plpgsql as $$
declare n int := 0; l record;
begin
 for l in select g.action from public.dl_log g join career_outreach_actions a on a.id = g.action where g.worker = w and a.status = 'running' order by a.thread_id, a.id loop
  if not career_outreach_action_finish(l.action, w, 'done', 'msg', null, 'sent') then raise exception 'finish refused for a leased action'; end if;
  n := n + 1;
 end loop;
 return n;
end $$;
""")
    failed = 0
    for r in range(ROUNDS):
        problems, took, total = contention_round()
        if problems:
            failed += 1
            print(f"  round {r + 1}: FAIL {'; '.join(problems)}", flush=True)
            if not KEEP_GOING:
                break
        else:
            print(f"  round {r + 1}: {total} actions, {WORKERS} workers on {PEOPLE} people: exactly once, refusals ended, no error ({took:.1f}s)", flush=True)
    run("drop table public.dl_log; drop function public.dl_claim(text); drop function public.dl_finish(text);")
    return failed


def main():
    failures = []
    if ONLY in ("", "1"):
        runs = ROUNDS if KEEP_GOING and ONLY == "1" else 1
        bad = 0
        for _ in range(runs):
            problems = interleaving()
            if problems:
                bad += 1
                print(f"  interleaving: FAIL {'; '.join(problems)}", flush=True)
        if KEEP_GOING and ONLY == "1":
            print(f"  summary: interleaving failed {bad} of {runs}")
        if bad:
            failures.append(f"interleaving failed {bad} of {runs}")
        else:
            print("  ok   two claims and a batched finish on one person in the deadlocking order: no deadlock, no lease twice, both refused follow-ups end their threads")
    if ONLY in ("", "2"):
        bad = contention()
        if KEEP_GOING:
            print(f"  summary: contention failed {bad} of {ROUNDS} rounds")
        if bad:
            failures.append(f"contention failed {bad} of {ROUNDS} rounds")
        else:
            print(f"  ok   claim under contention: {ROUNDS} rounds, {WORKERS} workers, batched finishes, refusals: no deadlock, no error, exactly once")
    assert not failures, "; ".join(failures)


main()
