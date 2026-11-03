// ACK FAST on real Postgres 16 (the migration 20261102170000_inbound_turn_queue.sql, every earlier migration behind it):
// the queue's claim, lease, per-contact ordering, retry/backoff, exhaustion, privacy and rollback, and the property the owner
// asked for: with several workers claiming at once and some of them dying mid-turn, every message ends done with its visible
// effect (the stand-in for the outbox reply, unique by message key like career_outbox's (user_id, key)) exactly once; a message
// replied twice is a failure.
// Run (as an unprivileged user: initdb refuses root): deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/ack-fast-queue-pg.test.ts
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
type Row = { id: number; channel: string; provider_msg_id: string; contact: string | null; payload: Record<string, unknown>; status: string; attempts: number; claim_token: string | null; last_error: string | null; available_at: string };

Deno.test({
  name: "inbound_turn_queue on Postgres: dedupe, ordering, lease, retry, exhaustion, privacy, grants, rollback, and many workers with deaths: each message once",
  sanitizeResources: false, sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    try {
      const j = async <T = any>(s: string): Promise<T> => JSON.parse((await pg.sql(s)) || "null");
      const enqueue = async (id: string, contact: string, text = "hi") => (await pg.sql(`select public.inbound_turn_enqueue('telegram', ${q(id)}, ${q(contact)}, ${q(JSON.stringify({ text }))}::jsonb)`)) === "t";
      const claim = async (limit = 10, lease = 180, off = 0, max = 3): Promise<Row[]> =>
        await j(`select coalesce(json_agg(c order by c.id), '[]') from public.inbound_turn_claim(${limit}, ${lease}, now() + interval '${off} seconds', ${max}) c`);
      const finish = async (r: { id: number; claim_token: string | null }, outcome: string, err: string | null = null, off = 0) =>
        await pg.sql(`select public.inbound_turn_finish(${r.id}, ${q(r.claim_token ?? "00000000-0000-0000-0000-000000000000")}::uuid, ${q(outcome)}, ${err === null ? "null" : q(err)}, now() + interval '${off} seconds', 3)`);
      const row = async (id: string): Promise<Row> => await j(`select row_to_json(x) from public.inbound_turn_queue x where provider_msg_id = ${q(id)}`);
      const reset = async () => { await pg.sql("delete from public.inbound_turn_queue"); };

      await t.step("grants: service_role only; the table is closed to anon and signed-in people", async () => {
        const fns = ["inbound_turn_enqueue(text,text,text,jsonb)", "inbound_turn_claim(integer,integer,timestamptz,integer)", "inbound_turn_finish(bigint,uuid,text,text,timestamptz,integer)",
          "inbound_turn_health(timestamptz,interval)", "inbound_turn_purge(timestamptz,interval,interval)"];
        for (const f of fns) {
          for (const role of ["anon", "authenticated"]) eq(await pg.sql(`select has_function_privilege('${role}', 'public.${f}', 'execute')`), "f", `${role} cannot run ${f}`);
          eq(await pg.sql(`select has_function_privilege('service_role', 'public.${f}', 'execute')`), "t", `service_role runs ${f}`);
          eq(await pg.sql(`select prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search_path=%') from pg_proc where oid = 'public.${f}'::regprocedure`), "t", `${f} is definer with a search_path`);
        }
        for (const role of ["anon", "authenticated"]) eq(await pg.sql(`select has_table_privilege('${role}', 'public.inbound_turn_queue', 'select,insert,update,delete')`), "f");
        eq(await pg.sql(`select relrowsecurity from pg_class where oid = 'public.inbound_turn_queue'::regclass`), "t");
      });

      await t.step("dedupe: a provider message id is queued once, however many deliveries race", async () => {
        await reset();
        eq(await enqueue("telegram:1", "tg:1"), true);
        eq(await enqueue("telegram:1", "tg:1"), false);
        const racers = await Promise.all(Array.from({ length: 20 }, () => enqueue("telegram:2", "tg:2")));
        eq(racers.filter(Boolean).length, 1, "exactly one of 20 concurrent deliveries inserted");
        eq(await pg.sql("select count(*) from public.inbound_turn_queue"), "2");
        // a different provider's id with the same number is a different message
        eq(await pg.sql(`select public.inbound_turn_enqueue('imessage', 'loopmessage:1', '+15550001111', '{}')`), "t");
      });

      await t.step("ordering: a person's second message waits for the first; other people are not held up", async () => {
        await reset();
        for (const [id, c] of [["m:a1", "tg:A"], ["m:a2", "tg:A"], ["m:a3", "tg:A"], ["m:b1", "tg:B"], ["m:b2", "tg:B"], ["m:c1", "tg:C"]]) await enqueue(id, c);
        const first = await claim(10);
        eq(first.map((r) => r.provider_msg_id), ["m:a1", "m:b1", "m:c1"], "the oldest of each person, nothing behind it");
        eq(first.map((r) => r.attempts), [1, 1, 1]);
        eq(await claim(10), [], "while the first of each is in flight, nothing of theirs is handed out");
        eq(await finish(first[0], "done"), "done");
        eq((await claim(10)).map((r) => r.provider_msg_id), ["m:a2"], "a1 finished: a2 and only a2 (b2 still waits for b1)");
        // a failed first message does not block the next one
        eq(await finish(first[1], "failed", "boom"), "failed");
        eq((await claim(10)).map((r) => r.provider_msg_id), ["m:b2"]);
      });

      await t.step("limit and fair order: oldest first, never more than asked", async () => {
        await reset();
        for (let i = 1; i <= 8; i++) await enqueue(`m:${i}`, `tg:${i}`);
        eq((await claim(3)).map((r) => r.provider_msg_id), ["m:1", "m:2", "m:3"]);
        eq((await claim(3)).map((r) => r.provider_msg_id), ["m:4", "m:5", "m:6"]);
        eq((await claim(0)), []);
      });

      await t.step("lease: a live claim is not taken; an expired one is, with a new token; the old holder cannot finish it", async () => {
        await reset();
        await enqueue("m:l1", "tg:L");
        const [a] = await claim(1, 30);
        eq(await claim(1, 30, 10), [], "10 s into a 30 s lease: not claimable");
        const [b] = await claim(1, 30, 31);
        eq([b.id, b.attempts], [a.id, 2], "after the lease the same message is claimed again");
        assert(b.claim_token !== a.claim_token, "a new claim token");
        eq(await finish(a, "done", null, 31), "stale", "the first worker, late, changes nothing");
        eq((await row("m:l1")).status, "claimed");
        eq(await finish(b, "done", null, 31), "done");
        eq(await finish(b, "done", null, 31), "stale", "finishing twice changes nothing");
        // a message queued behind an expired claim still waits for it (order is kept through a crash)
        await enqueue("m:l2", "tg:L");
        eq((await claim(5)).map((r) => r.provider_msg_id), ["m:l2"], "m:l1 is done, m:l2 is now first: claimable");
      });

      await t.step("retry: released with a backoff (20 s, then 60 s), at most 3 attempts, then FAILED and kept", async () => {
        await reset();
        await enqueue("m:r1", "tg:R", "keep this text");
        await enqueue("m:r2", "tg:R", "second");
        const [a] = await claim(1);
        eq(await finish(a, "retry", "agent-chat HTTP 503"), "queued");
        eq(await claim(5), [], "backing off 20 s, and r2 waits behind r1");
        const [b] = await claim(5, 180, 21);
        eq([b.provider_msg_id, b.attempts], ["m:r1", 2]);
        eq(await finish(b, "retry", "timeout", 21), "queued");
        eq(await claim(5, 180, 21 + 59), [], "second backoff is 60 s");
        const [c] = await claim(5, 180, 21 + 61);
        eq(c.attempts, 3);
        eq(await finish(c, "retry", "agent-chat HTTP 503", 21 + 61), "failed", "no attempt left: failed, not queued");
        const failed = await row("m:r1");
        eq([failed.status, failed.contact, failed.last_error, failed.payload], ["failed", null, "agent-chat HTTP 503", { text: "keep this text" }], "kept with its text and the reason; the number is let go");
        eq((await claim(5, 180, 21 + 62)).map((r) => r.provider_msg_id), ["m:r2"], "the failed message no longer blocks the person's next one");
      });

      await t.step("a worker that dies on every attempt: the row is failed when its last lease runs out, never dropped or left claimed", async () => {
        await reset();
        await enqueue("m:d1", "tg:D");
        await claim(1, 30, 0); await claim(1, 30, 31); await claim(1, 30, 62);
        eq((await row("m:d1")).attempts, 3);
        eq(await claim(1, 30, 70), [], "the third lease is still live");
        eq(await claim(1, 30, 93), [], "expired and out of attempts: not handed out again");
        const r = await row("m:d1");
        eq([r.status, r.contact], ["failed", null]);
        assert(/lease expired/.test(r.last_error ?? ""), String(r.last_error));
        const h = (await j(`select row_to_json(h) from public.inbound_turn_health(now() + interval '93 seconds') h`));
        eq([Number(h.failed_recent), Number(h.queued), Number(h.claimed)], [1, 0, 0], "ops-monitor sees it");
        eq(Number(h.newest_failed_id), r.id);
      });

      await t.step("privacy and retention: done keeps no text or number; purge removes finished rows, never a waiting one", async () => {
        await reset();
        await enqueue("m:p1", "tg:P", "secret words");
        await enqueue("m:p2", "tg:Q", "waiting");
        const [a] = await claim(1);
        eq(await finish(a, "done", null), "done");
        const d = await row("m:p1");
        eq([d.status, d.contact, d.payload], ["done", null, {}]);
        eq(await pg.sql("select public.inbound_turn_purge(now() + interval '8 days')"), "1", "the done row went");
        eq((await row("m:p2")).status, "queued", "m:p2, still waiting, is untouched");
        const h = await j(`select row_to_json(h) from public.inbound_turn_health() h`);
        eq([Number(h.queued), Number(h.claimed), Number(h.failed_recent)], [1, 0, 0]);
      });

      await t.step("MANY WORKERS WITH DEATHS: 150 messages over 40 people, 8 concurrent workers, every third first attempt dies mid-turn: each message done once, one visible effect each, in order per person", async () => {
        await reset();
        await pg.sql("drop table if exists ack_effects; create table ack_effects (msg text primary key, worker int, n int not null default 1, at timestamptz not null default clock_timestamp()); create table if not exists ack_trace (seq bigserial primary key, contact text, msg text, ev text)");
        const people = 40, total = 150;
        const msgs: { id: string; contact: string; n: number }[] = [];
        const perPerson = new Map<string, number>();
        for (let i = 0; i < total; i++) { const c = `tg:${(i * 7) % people}`; const n = (perPerson.get(c) ?? 0) + 1; perPerson.set(c, n); msgs.push({ id: `chaos:${i}`, contact: c, n }); }
        for (const m of msgs) await enqueue(m.id, m.contact, `${m.n}`);
        const inFlight = new Set<string>(); // contacts with a live turn in this process
        const doneOrder = new Map<string, number[]>();
        let violations: string[] = [], claimsSeen = 0, deaths = 0, effectsAttempted = 0;
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const deadline = Date.now() + 90_000;
        const worker = async (w: number) => {
          while (Date.now() < deadline) {
            const rows = await claim(3, 2); // a 2 s lease so a death is noticed quickly
            if (!rows.length) {
              if (Number(await pg.sql("select count(*) from public.inbound_turn_queue where status in ('queued','claimed')")) === 0) return;
              await sleep(150); continue;
            }
            await Promise.all(rows.map(async (r) => {
              claimsSeen++;
              const c = r.contact!;
              if (inFlight.has(c)) violations.push(`two turns in flight for ${c} (msg ${r.provider_msg_id})`);
              inFlight.add(c);
              try {
                // the turn: its visible effect is written under the message's own key (career_outbox's (user_id, key) rule: a second try is refused)
                effectsAttempted++;
                await pg.sql(`insert into ack_effects (msg, worker) values (${q(r.provider_msg_id)}, ${w}) on conflict (msg) do update set n = ack_effects.n + 1`);
                const die = r.attempts === 1 && Number(r.provider_msg_id.split(":")[1]) % 3 === 0;
                if (die) { deaths++; return; } // the worker dies after the effect and before it can mark the row
                await sleep(5 + Math.random() * 20);
                const out = await finish(r, "done");
                if (out === "done") { const seq = Number(r.payload.text); const l = doneOrder.get(c) ?? []; l.push(seq); doneOrder.set(c, l); }
              } finally { inFlight.delete(c); }
            }));
          }
        };
        const t0 = performance.now();
        await Promise.all(Array.from({ length: 8 }, (_, i) => worker(i)));
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        eq(violations, [], "never two turns in flight for one person");
        eq(await pg.sql("select status || ':' || count(*) from public.inbound_turn_queue group by status"), `done:${total}`, "every message done, none failed, none left");
        eq(await pg.sql("select count(*) from ack_effects"), String(total), "one visible effect per message");
        const redone = Number(await pg.sql("select count(*) from ack_effects where n > 1"));
        assert(redone >= deaths - 3 && redone <= deaths, `retried messages tried the effect again and the unique key refused a second visible one (${redone} refused, ${deaths} deaths)`);
        eq(await pg.sql("select count(*) from public.inbound_turn_queue where attempts > 2"), "0");
        for (const [c, order] of doneOrder) eq(order, [...order].sort((a, b) => a - b), `${c}: done in the order they were sent`);
        console.log(`ACK_QUEUE_CHAOS messages=${total} people=${people} workers=8 deaths=${deaths} claims=${claimsSeen} effects=${total} refused_duplicates=${redone} seconds=${secs}`);
      });

      await t.step("rollback: down removes it all, up again restores it, and the earlier tables are untouched", async () => {
        await reset();
        const before = await pg.sql("select count(*) from public.channel_inbound");
        await pg.sql(await Deno.readTextFile(`${ROOT}/supabase/rollbacks/20261102170000_inbound_turn_queue.down.sql`));
        eq(await pg.sql("select to_regclass('public.inbound_turn_queue') is null and not exists (select 1 from pg_proc where proname like 'inbound_turn_%')"), "t");
        await pg.sql(await Deno.readTextFile(`${ROOT}/supabase/migrations/20261102170000_inbound_turn_queue.sql`));
        await pg.sql(await Deno.readTextFile(`${ROOT}/supabase/migrations/20261102170000_inbound_turn_queue.sql`)); // idempotent
        eq(await enqueue("m:z", "tg:Z"), true);
        eq((await claim(1)).length, 1);
        eq(await pg.sql("select count(*) from public.channel_inbound"), before);
      });
    } finally {
      await pg.stop();
    }
  },
});
