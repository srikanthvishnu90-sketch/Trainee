"""200 people at once against the database layer, real concurrent PostgreSQL sessions; invoked only inside the disposable DB
(tests/db/run.sh, after the schema is complete).

Every person's turn is a handful of independent calls, each its own session and transaction, shuffled together with every other
person's so they interleave the way webhooks and taps do:
  - the model reservation of a turn's first step, delivered 3 times (a retried webhook): exactly one slot per person;
  - the record of that call's token usage, twice at once: one usage row;
  - the global daily budget: 2 reservations each, 400 asks of 7,000 micro-dollars against a 1,000,000 day: exactly 142 granted, the
    day never above its limit, 'limit' for the rest; then the granted ones settle, a few release, concurrently;
  - the Apply tap on a prepared application, 4 times at once: exactly one card answered, one queued application, the payload the
    person was shown; and the neighbour's prepared application tapped by the wrong person: refused, nothing queued.
Then every person's rows are checked against their own id alone.
"""
import json
import random
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

PSQL = sys.argv[1:] + ["-t", "-A"]
N = 200
DAY = "2026-10-29"
NOW = "2026-10-29T17:00:00Z"
LIMIT = 1_000_000
ASK = 7_000
WORKERS = 24


def uid(i):
    return "00000000-0000-4000-8000-%012x" % (0x5ca1e0000 + i)


def tid(i):
    return "00000000-0000-4000-8001-%012x" % (0x5ca1e0000 + i)


def rid(i):
    return "00000000-0000-4000-8002-%012x" % (0x5ca1e0000 + i)


def run(sql):
    p = subprocess.run(PSQL + ["-c", sql], capture_output=True, text=True)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def one(sql):
    code, out, err = run(sql)
    assert code == 0, err
    return out


def setup():
    saved = one(f"select coalesce((select limit_micros || ',' || spent_micros || ',' || reserved_micros from public.model_budget_days where day = '{DAY}'), 'none')")
    one(f"""
      insert into auth.users(id, email) select ('00000000-0000-4000-8000-' || lpad(to_hex(x'5ca1e0000'::bigint + g), 12, '0'))::uuid, 'scale-' || g || '@example.test' from generate_series(1, {N}) g;
      insert into public.profiles(id) select id from auth.users where email like 'scale-%@example.test';
      insert into public.career_watch_kv(user_id, key, value) select id, 'career:account', '{{"epoch":1,"version":1,"paused":false}}' from auth.users where email like 'scale-%@example.test';
      insert into public.agent_threads(id, user_id) select ('00000000-0000-4000-8001-' || lpad(to_hex(x'5ca1e0000'::bigint + g), 12, '0'))::uuid, ('00000000-0000-4000-8000-' || lpad(to_hex(x'5ca1e0000'::bigint + g), 12, '0'))::uuid from generate_series(1, {N}) g;
      insert into public.agent_flow_state(thread_id, user_id, state)
        select t.id, t.user_id, jsonb_build_object('career', jsonb_build_object('stores', jsonb_build_object('profile', jsonb_build_object('facts', jsonb_build_array(
          jsonb_build_object('id', 'f1', 'kind', 'experience', 'status', 'confirmed', 'needs_confirmation', false, 'confirmation_event_id', 'ev-scale-' || t.user_id, 'text', 'Scale'))))))
        from public.agent_threads t join auth.users u on u.id = t.user_id where u.email like 'scale-%@example.test';
      insert into public.career_events(user_id, kind, subject, detail) select id, 'fact_confirmed', 'Scale', jsonb_build_object('confirmation_event_id', 'ev-scale-' || id) from auth.users where email like 'scale-%@example.test';
      insert into storage.objects(bucket_id, name) select 'career-resumes', id::text || '/' || repeat('a', 64) || '.pdf' from auth.users where email like 'scale-%@example.test';
      insert into public.career_apply_prepared(user_id, job_id, company, url, payload, payload_hash, card_lines)
        select u.id, 'scale-' || n, 'Scale Co', 'https://jobs.lever.co/scaleco/' || n, p.payload, public.career_apply_payload_hash(p.payload), array['Scale Co ' || n]
        from auth.users u cross join generate_series(1, 2) n
        cross join lateral (select jsonb_build_object('version', 1, 'user_id', u.id, 'job_id', 'scale-' || n, 'company', 'Scale Co', 'url', 'https://jobs.lever.co/scaleco/' || n,
          'fields', '[]'::jsonb, 'privacy_epoch', 1, 'account_version', 1, 'expires_at', now() + interval '1 day', 'resume_sha256', repeat('a', 64)) as payload) p
        where u.email like 'scale-%@example.test';
      insert into public.model_budget_days(day, limit_micros, spent_micros, reserved_micros) values ('{DAY}', {LIMIT}, 0, 0)
        on conflict (day) do update set limit_micros = {LIMIT}, spent_micros = 0, reserved_micros = 0;
      delete from public.model_budget_reservations where day = '{DAY}';
    """)
    return saved


def teardown(saved):
    run("delete from public.career_apply_jobs where user_id in (select id from auth.users where email like 'scale-%@example.test')")
    run("delete from public.model_budget_reservations where day = '%s'" % DAY)
    if saved == "none":
        run(f"delete from public.model_budget_days where day = '{DAY}'")
    else:
        lim, spent, res = saved.split(",")
        run(f"update public.model_budget_days set limit_micros = {lim}, spent_micros = {spent}, reserved_micros = {res} where day = '{DAY}'")
    run("delete from storage.objects where bucket_id = 'career-resumes' and name like '00000000-0000-4000-8000-%'")
    code, _, err = run("delete from auth.users where email like 'scale-%@example.test'")
    assert code == 0, err


def svc(sql):
    return "set role service_role; " + sql


results = {}


def call(key, sql):
    code, out, err = run(svc(sql))
    results.setdefault(key, []).append((code, out, err))


def tasks():
    t = []
    for i in range(1, N + 1):
        u, th, rq = uid(i), tid(i), rid(i)
        for _ in range(3):
            t.append((("reserve", i), f"select public.agent_model_call_reserve('{u}', '{th}', '{rq}', 0, 'scale-model')::text"))
        for _ in range(2):
            t.append((("budget", i), f"select public.model_budget_reserve({ASK}, 'scale-model', 'chat', '{NOW}')::text"))
        for n in (1, 1, 1, 1):
            t.append((("tap", i), f"select public.career_apply_card_confirm_as('{u}', array[(select id from public.career_apply_prepared where user_id = '{u}' and job_id = 'scale-{n}')], "
                                  f"array[(select payload_hash from public.career_apply_prepared where user_id = '{u}' and job_id = 'scale-{n}')])::text"))
        neighbour = uid(i % N + 1)
        t.append((("wrongtap", i), f"select public.career_apply_card_confirm_as('{u}', array[(select id from public.career_apply_prepared where user_id = '{neighbour}' and job_id = 'scale-2')], "
                                   f"array[(select payload_hash from public.career_apply_prepared where user_id = '{neighbour}' and job_id = 'scale-2')])::text"))
    random.Random(20261030).shuffle(t)
    return t


def main():
    saved = setup()
    started = time.monotonic()
    try:
        ts = tasks()
        with ThreadPoolExecutor(WORKERS) as pool:
            list(pool.map(lambda x: call(*x), ts))
        wave1 = time.monotonic() - started

        # Model reservations: one slot per person, one winner per (person, request, step); the retries say already_reserved.
        slots = one("select count(*) from public.agent_model_calls where user_id in (select id from auth.users where email like 'scale-%@example.test')")
        assert slots == str(N), ("model reservation slots", slots)
        winners = 0
        for i in range(1, N + 1):
            outs = [json.loads(o) for c, o, e in results[("reserve", i)] if c == 0 and o]
            assert len(outs) == 3, (i, results[("reserve", i)])
            winners += sum(1 for o in outs if o["state"] == "reserved")
            assert sum(1 for o in outs if o["state"] == "already_reserved") == 2, (i, outs)
        assert winners == N, ("reservation winners", winners)
        print("  ok   %d people x 3 concurrent deliveries of one model reservation: one slot each, never a second" % N)

        # Record the usage of every call twice at once: one agent_usage row each.
        calls = [r.split("|") for r in one("select id || '|' || user_id from public.agent_model_calls where user_id in (select id from auth.users where email like 'scale-%@example.test')").splitlines()]
        usage = "'{\"input_tokens\":10,\"output_tokens\":5,\"cache_read_tokens\":0,\"cache_write_tokens\":0}'::jsonb"
        rec = []
        for cid, _ in calls:
            rec.append(("record", f"select public.agent_model_call_record('{cid}', {usage})::text"))
            rec.append(("record", f"select public.agent_model_call_record('{cid}', {usage})::text"))
        random.Random(7).shuffle(rec)
        with ThreadPoolExecutor(WORKERS) as pool:
            list(pool.map(lambda x: call(*x), rec))
        bad = [r for r in results["record"] if r[0] != 0]
        assert not bad, bad[:2]
        rows = one("select count(*) from public.agent_usage where call_id in (select id from public.agent_model_calls where user_id in (select id from auth.users where email like 'scale-%@example.test'))")
        assert rows == str(N), ("usage rows", rows)
        print("  ok   the same usage recorded twice at once: one usage row per call (%d)" % N)

        # The global daily budget: no overspend, no double spend.
        granted, refused, ids = 0, 0, []
        for i in range(1, N + 1):
            for c, o, e in results[("budget", i)]:
                assert c == 0, e
                d = json.loads(o)
                if d.get("ok"):
                    granted += 1
                    ids.append(d["id"] if "id" in d else d.get("reservation_id"))
                else:
                    assert d.get("state") == "limit", d
                    refused += 1
        expect = LIMIT // ASK
        assert granted == expect, ("granted", granted, "expected", expect)
        assert granted + refused == 2 * N
        day = one(f"select spent_micros || ',' || reserved_micros from public.model_budget_days where day = '{DAY}'").split(",")
        assert int(day[0]) + int(day[1]) == granted * ASK <= LIMIT, ("the day holds exactly what was granted", day, granted)
        assert one(f"select count(*) from public.model_budget_reservations where day = '{DAY}' and status = 'reserved'") == str(granted)
        print("  ok   %d asks of %d against a %d day: exactly %d granted, the day holds %d, never above its limit" % (2 * N, ASK, LIMIT, granted, granted * ASK))

        # Settle (at a lower proven cost) and release concurrently: spent + reserved never above the limit, every reservation closed once.
        res = one(f"select id from public.model_budget_reservations where day = '{DAY}' and status = 'reserved' order by id").splitlines()
        ops = []
        for k, r in enumerate(res):
            if k % 10 == 0:
                ops.append(("close", f"select public.model_budget_release('{r}', '{NOW}')::text"))
                ops.append(("close", f"select public.model_budget_release('{r}', '{NOW}')::text"))
            else:
                ops.append(("close", f"select public.model_budget_settle('{r}', {ASK - 2000}, '{NOW}')::text"))
                ops.append(("close", f"select public.model_budget_settle('{r}', {ASK - 2000}, '{NOW}')::text"))
        random.Random(11).shuffle(ops)
        with ThreadPoolExecutor(WORKERS) as pool:
            list(pool.map(lambda x: call(*x), ops))
        assert all(c == 0 for c, o, e in results["close"]), [r for r in results["close"] if r[0] != 0][:2]
        released = len([k for k in range(len(res)) if k % 10 == 0])
        settled = len(res) - released
        day = one(f"select spent_micros || ',' || reserved_micros from public.model_budget_days where day = '{DAY}'").split(",")
        assert (int(day[0]), int(day[1])) == (settled * (ASK - 2000), 0), ("settle/release counted once each", day, settled, released)
        assert int(day[0]) + int(day[1]) <= LIMIT
        print("  ok   %d settled and %d released, each asked for twice at once: counted once, nothing left reserved" % (settled, released))

        # Apply taps: one queued application, one answered card, the exact payload shown; the wrong person's tap queued nothing.
        jobs = one("select count(*) from public.career_apply_jobs where user_id in (select id from auth.users where email like 'scale-%@example.test')")
        assert jobs == str(N), ("queued applications", jobs)
        dup = one("select count(*) from (select user_id, job_id from public.career_apply_jobs where user_id in (select id from auth.users where email like 'scale-%@example.test') group by 1, 2 having count(*) > 1) d")
        assert dup == "0", ("duplicate queued applications", dup)
        mism = one("select count(*) from public.career_apply_jobs j join public.career_apply_prepared p on p.user_id = j.user_id and p.job_id = j.job_id "
                   "where j.user_id in (select id from auth.users where email like 'scale-%@example.test') and (j.payload_hash is distinct from p.payload_hash or j.payload ->> 'user_id' <> j.user_id::text or j.job_id <> 'scale-1')")
        assert mism == "0", ("a queued application is not the payload its person was shown", mism)
        cards = one("select count(*) from public.career_apply_cards where user_id in (select id from auth.users where email like 'scale-%@example.test') and state = 'answered'")
        assert cards == str(N), ("answered cards", cards)
        for i in range(1, N + 1):
            ok = [o for c, o, e in results[("tap", i)] if c == 0 and "queued" in o]
            assert len(ok) == 1, (i, "exactly one of four taps queues", results[("tap", i)])
            assert all(c != 0 or "queued" in o for c, o, e in results[("tap", i)])
            assert all(c != 0 for c, o, e in results[("wrongtap", i)]), (i, "the neighbour's application tapped by the wrong person", results[("wrongtap", i)])
        left = one("select count(*) from public.career_apply_prepared where user_id in (select id from auth.users where email like 'scale-%@example.test') and job_id = 'scale-2' and state = 'ready'")
        assert left == str(N), ("a wrong person's tap changed someone's prepared application", left)
        print("  ok   %d people x 4 Apply taps at once: one queued application and one answered card each, the exact payload shown; %d wrong-person taps refused" % (N, N))

        per = one("select max(n) from (select count(*) n from public.career_apply_cards where user_id in (select id from auth.users where email like 'scale-%@example.test') group by user_id) x")
        assert per == "1", ("cards per person", per)
        print("  ok   one card per person (%.1f s for %d interleaved sessions)" % (time.monotonic() - started, len(ts) + len(rec) + len(ops)))
    finally:
        teardown(saved)
        left = one("select count(*) from auth.users where email like 'scale-%@example.test'")
        assert left == "0", "load rows removed"
    print("  ok   load rows removed")


main()
