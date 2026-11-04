"""Launch readiness S4: two real sessions take turn-gate tickets for one person and thread at the same moment.

Session A takes its ticket inside a transaction that is still open (it sleeps holding it). Session B takes its own
ticket meanwhile, then asks whether it may go. Without career_turn_gate_enter's per-person-and-thread lock, B's ticket
commits first while A's (lower) number is not yet visible, so B is told to go while A will also go: two turns at once.
With the lock, B's enter waits for A's transaction, draws a later number, and is told to wait (f).

The race() helper is tests/db/message_concurrency.py's (that file runs its own checks when loaded, so it is copied here).
Invoked only inside the disposable DB by tests/db/run.sh."""
import subprocess
import sys
import time

PSQL = sys.argv[1:] + ["-t", "-A"]
USER = "00000000-0000-4000-8000-00000000a3f1"


def query(sql):
    return subprocess.run(PSQL + ["-c", sql], capture_output=True, text=True, check=True).stdout.strip()


def race(first_sql, second_sql, first_value, second_value, label):
    worker = subprocess.Popen(PSQL + ["-c", "begin; set application_name='upmore-turn-gate-a'; " + first_sql + "; select pg_sleep(1); commit;"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    second = None
    try:
        deadline = time.monotonic() + 5
        while query("select exists(select 1 from pg_stat_activity where application_name='upmore-turn-gate-a' and wait_event='PgSleep')") != "t":
            if worker.poll() is not None:
                raise AssertionError("worker A exited before holding its transaction")
            if time.monotonic() >= deadline:
                raise AssertionError("worker A never reached its lock-holding wait")
            time.sleep(0.02)
        second = subprocess.Popen(PSQL + ["-c", second_sql], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        a, a_error = worker.communicate(timeout=10)
        b, b_error = second.communicate(timeout=10)
        assert worker.returncode == 0, a_error
        assert second.returncode == 0, b_error
        assert a.strip().splitlines()[0] == first_value, (label, "unexpected first result", a)
        assert b.strip().splitlines()[-1] == second_value, (label, "the second session was told to go while the first held its ticket", b)
        print("  ok   " + label)
    finally:
        if worker.poll() is None:
            worker.kill()
            worker.communicate()
        if second is not None and second.poll() is None:
            second.kill()
            second.communicate()


query(f"insert into auth.users(id,email) values('{USER}','gate-race@example.test') on conflict do nothing")
try:
    enter = lambda key: f"public.career_turn_gate_enter('{USER}','{key}',90,'thread-race')"
    # B's ready is its own statement, so it reads after its enter returned (each statement its own snapshot).
    race(f"select {enter('race-a')} is not null",
         f"create temp table b_ticket as select {enter('race-b')} t; select public.career_turn_gate_ready('{USER}', (select t from b_ticket))",
         "t", "f", "two sessions entering at once: the second is told to wait while the first holds its ticket")
finally:
    query(f"delete from public.career_turn_gate where user_id='{USER}'; delete from auth.users where id='{USER}'")
