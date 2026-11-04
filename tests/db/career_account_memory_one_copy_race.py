"""Root cause 3 (20261031050000_career_account_memory_one_copy.sql): two threads of one person save at the same moment.

Case 1, one row locked before the other save: session A holds its own thread X (as its save does) and sleeps. Session B
holds its own thread Y and saves it: the trigger wants X. Then A saves X: the trigger wants Y. Without a deterministic,
skip-locked pick of the other rows, B waits for A and A waits for B, and Postgres kills one with a deadlock. With it, both
saves commit; one copy is left (X, the last save).

Case 2, both rows locked before either save: A holds X, B holds Y, then A saves X (its trigger skips Y, which B holds)
and B saves Y while A has not committed. With skip-locked alone B skips X too and two copies are left. The per-person
advisory lock makes B's trigger wait for A's commit, then clear X: both commit, no deadlock, one copy (Y, the last save).
Invoked only inside the disposable DB by tests/db/run.sh."""
import subprocess
import sys
import time

PSQL = sys.argv[1:] + ["-t", "-A"]
USER = "00000000-0000-4000-8000-00000000a3e1"
X, Y = "00000000-0000-4000-8000-00000000a3e2", "00000000-0000-4000-8000-00000000a3e3"
STATE = """'{"career":{"account_memory":1,"stores":{"profile":{"facts":[{"id":"f1","status":"confirmed"}]}}}}'::jsonb"""


def query(sql):
    return subprocess.run(PSQL + ["-c", sql], capture_output=True, text=True, check=True).stdout.strip()


def save(thread):
    return f"update public.agent_flow_state set state = {STATE} || jsonb_build_object('n', '{thread}') where thread_id = '{thread}'"


def holders():
    return query(f"select coalesce(string_agg(thread_id::text, ',' order by thread_id), '') from public.agent_flow_state where user_id='{USER}' and jsonb_typeof(state#>'{{career,stores,profile,facts}}')='array'")


def setup():
    # Triggers off: both threads start holding a stamped copy, as two account-backed threads would mid-change.
    query(f"""set session_replication_role = replica;
insert into auth.users(id,email) values('{USER}','one-copy-race@example.test') on conflict do nothing;
insert into public.agent_threads(id,user_id,title) values('{X}','{USER}','x'),('{Y}','{USER}','y');
insert into public.agent_flow_state(thread_id,user_id,state) values('{X}','{USER}',{STATE}),('{Y}','{USER}',{STATE});
set session_replication_role = origin;""")
    assert holders() == f"{X},{Y}", "setup: both threads hold a copy"


def teardown():
    query(f"delete from public.agent_flow_state where user_id='{USER}'; delete from public.agent_threads where user_id='{USER}'; delete from auth.users where id='{USER}'")


def start(name, sql):
    return subprocess.Popen(PSQL + ["-c", f"begin; set application_name='{name}'; {sql} commit;"],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def wait_sleeping(proc, name):
    deadline = time.monotonic() + 5
    while query(f"select exists(select 1 from pg_stat_activity where application_name='{name}' and wait_event='PgSleep')") != "t":
        if proc.poll() is not None or time.monotonic() >= deadline:
            raise AssertionError(f"session {name} never held its own row")
        time.sleep(0.02)


def finish(procs):
    for name, p in procs:
        _, err = p.communicate(timeout=20)
        assert p.returncode == 0 and "deadlock" not in err, (f"session {name} failed", err)


def run(case, body):
    procs = []
    setup()
    try:
        body(procs)
    finally:
        for _, p in procs:
            if p.poll() is None:
                p.kill()
                p.communicate()
        teardown()


def one_locked_first(procs):
    a = start("upmore-one-copy-a", f"select 1 from public.agent_flow_state where thread_id='{X}' for update; select pg_sleep(1.5); {save(X)};")
    procs.append(("A", a))
    wait_sleeping(a, "upmore-one-copy-a")
    b = start("upmore-one-copy-b", f"select 1 from public.agent_flow_state where thread_id='{Y}' for update; {save(Y)}; select pg_sleep(0.5);")
    procs.append(("B", b))
    finish(procs)
    print("  ok   two threads of one person saving at once: both commit, no deadlock")
    held = holders()
    assert held == X, ("one copy is left, the last save's", held)
    print("  ok   one copy is left: the thread that saved last")


def both_locked_first(procs):
    # A: holds X, saves X at ~1.0 s, commits at ~2.0 s. B: holds Y from ~0.1 s, saves Y at ~1.6 s (A not yet committed).
    a = start("upmore-one-copy-a2", f"select 1 from public.agent_flow_state where thread_id='{X}' for update; select pg_sleep(1.0); {save(X)}; select pg_sleep(1.0);")
    procs.append(("A", a))
    wait_sleeping(a, "upmore-one-copy-a2")
    b = start("upmore-one-copy-b2", f"select 1 from public.agent_flow_state where thread_id='{Y}' for update; select pg_sleep(1.5); {save(Y)};")
    procs.append(("B", b))
    wait_sleeping(b, "upmore-one-copy-b2")
    finish(procs)
    print("  ok   both rows locked before either save: both commit, no deadlock")
    held = holders()
    assert held == Y, ("one copy is left, the last save's", held)
    print("  ok   both rows locked before either save: one copy is left, the thread that saved last")


run("one row locked first", one_locked_first)
run("both rows locked first", both_locked_first)
