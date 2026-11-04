// CLOCK SWEEP (2026-10-31): what a person approves is the newest thing the database received, whatever clock the worker
// that wrote it runs on. The same class as 20261030040000 (outreach send claim), 20261030140000 (apply not-before) and
// PR #341 (the outreach follow-up batch a chat showed): a worker's clock written where the database's is compared.
//   A. supabaseOutreachStore.saveBatch wrote each draft's created_at from the caller's `at` (the turn's or run's start;
//      drafting takes the model's seconds) and latestBatch, the batch an answer approves, is the newest by created_at.
//      A batch drafted by a turn that started earlier but saved (and was shown) later read as older: "send all" approved
//      the batch shown before it. Two workers' clocks 2 s apart reordered them the same way.
//   B. offerApproval (channel_present.ts) wrote the card offer's created_at from the worker's clock and peekApproval
//      resolves a numbered reply ("1", "yes") against the newest live offer by created_at. Two offers that raced past each
//      other's supersede, on two workers 2 s apart, were ordered by those clocks: the reply resolved the card shown before.
// (The SQL side, a card shown and answered in one transaction, is tests/db/clock_sweep.test.sql.) Each step fails before
// the fix. On a real Postgres 16 with every migration, through the PostgREST double and the real supabase-js client.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/clock-sweep-pg.test.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { CI, haveDb, person, railDb, rows, uid as uidOf } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseParity } from "../flow/handler.ts";
import { footerOf, messageOf, OUTREACH_INTENT, outreachTurn, payloadHash, supabaseOutreachStore } from "../../supabase/functions/_shared/career_outreach.ts";
import { offerApproval, peekApproval } from "../../supabase/functions/_shared/channel_present.ts";
import { cardShownAt, dueForWorker, microsToIso, msToMicros, notBeforeReached } from "../flow/db_clock.ts";

function ok(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const RUN = crypto.randomUUID().slice(0, 3);
const RealDate = Date;

// This worker's clock, `skew` ms off the database's, for the duration of fn (new Date() and Date.now()).
async function onClock<T>(skew: number, fn: () => Promise<T>): Promise<T> {
  class Skewed extends RealDate {
    // deno-lint-ignore no-explicit-any
    constructor(...a: any[]) { if (a.length) super(...(a as [number])); else super(RealDate.now() + skew); }
    static override now() { return RealDate.now() + skew; }
  }
  globalThis.Date = Skewed as DateConstructor;
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}

Deno.test({ name: "clock sweep: the newest batch or card offer is the one the database received last, whatever the worker's clock", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const db = await railDb();
  try {
    await supabaseParity(db.pg as any);
    const double = postgrestDouble(db.pg as any, { url: "http://supabase.test", serviceKey: "service-test-key", users: {} });
    const admin = createClient("http://supabase.test", "service-test-key", { global: { fetch: double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
    let n = 0;
    const someone = async () => {
      const u = uidOf(++n, `c${RUN}`.slice(0, 3)), chat = crypto.randomUUID();
      await person(db, u);
      await db.sql.query(`insert into public.agent_threads (id, user_id, title) values (${q(chat)}, ${q(u)}, 'TEST')`);
      return { u, chat };
    };

    // ---------------------------------------------------------------------------------------- A. outreach drafts
    const outreach = { ...supabaseOutreachStore(admin), lastAssistantIntent: async () => OUTREACH_INTENT };
    const drafts = async (tag: string, k: number) => {
      const out = [];
      for (let i = 1; i <= k; i++) {
        const d = { n: i, recipient: { name: `P ${tag}${i}`, firm: "Acme", title: "", school: "", email: `${tag}${i}.${RUN}@example.test`, source: "contacts.csv" },
          subject: `Hello ${tag}${i}`, body: "Would you have 15 minutes?", footer: footerOf("Sam"), shared: [], status: "shown" as const, hash: "",
          approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new RealDate().toISOString() };
        d.hash = await payloadHash(messageOf(d));
        out.push(d);
      }
      return out;
    };
    const statusOf = async (u: string, batch: string) => (await rows(db, `select n, status from public.career_outreach_drafts where user_id = ${q(u)} and batch_id = ${q(batch)} order by n`))
      .map((x: any) => `${x.n}:${x.status}`).join(",");

    await t.step("A1. a turn that started 5 s before the batch shown first, saved after it: \"send all\" approves the batch shown last", async () => {
      const { u, chat } = await someone();
      const first = await outreach.saveBatch(u, chat, await drafts(`a1x${n}`, 2), RealDate.now()); // shown first
      const last = await outreach.saveBatch(u, chat, await drafts(`a1y${n}`, 1), RealDate.now() - 5000); // its turn began earlier; saved, and shown, last
      const latest = await outreach.latestBatch(u);
      ok(latest[0]?.batch_id === last[0].batch_id, `the newest batch is the one saved last (${latest[0]?.batch_id === first[0].batch_id ? "the earlier one" : latest[0]?.batch_id})`);
      const r = await outreachTurn({ message: "send all", userId: u, threadId: chat, now: RealDate.now(), store: outreach });
      ok(r?.status === "approved", `"send all" is read (${r?.status}: ${r?.reply})`);
      ok(await statusOf(u, last[0].batch_id) === "1:approved", `the batch shown last is approved (${await statusOf(u, last[0].batch_id)})`);
      ok(await statusOf(u, first[0].batch_id) === "1:shown,2:shown", `the batch shown before it is not (${await statusOf(u, first[0].batch_id)})`);
    });

    await t.step("A2. two workers 2 s apart: the batch saved last is the newest, whichever clock drafted it", async () => {
      for (const skew of [2000, 1, 0, -1, -2000]) {
        const { u, chat } = await someone();
        const first = await outreach.saveBatch(u, chat, await drafts(`a2x${n}`, 1), RealDate.now() + skew); // the ahead (or behind) worker
        const last = await outreach.saveBatch(u, chat, await drafts(`a2y${n}`, 1), RealDate.now());
        const latest = await outreach.latestBatch(u);
        ok(latest[0]?.batch_id === last[0].batch_id, `skew ${skew} ms: the newest batch is the one saved last (got ${latest[0]?.batch_id === first[0].batch_id ? "the earlier one" : latest[0]?.batch_id})`);
        const [o] = await rows(db, `select (select max(created_at) from public.career_outreach_drafts where batch_id = ${q(first[0].batch_id)})
          < (select min(created_at) from public.career_outreach_drafts where batch_id = ${q(last[0].batch_id)}) as ordered`);
        ok(o?.ordered === true, `skew ${skew} ms: created_at is the database's insert order (${JSON.stringify(o)})`);
      }
    });

    // ---------------------------------------------------------------------------------------- B. card offers
    const runs = new Map<string, string>(); // runId -> card hash
    // The stored run is the core's (career_batch_result_v1); the offers table is the real one.
    // deno-lint-ignore no-explicit-any
    const deps = (o: { supersede: boolean }): any => ({
      env: () => undefined, fetchFn: fetch,
      createAdmin: () => new Proxy(admin, { get(target, k) {
        if (k === "rpc") return async (name: string, a: any) => name === "career_batch_result_v1"
          ? { data: { batch: { version: "career_batch_run/v1", userId: a.p_user, runId: a.p_run, status: "awaiting_approval", run: { id: a.p_run, cardSha256: runs.get(a.p_run), selected: [], apps: {} } } }, error: null }
          : await (target as any).rpc(name, a);
        // An offer whose supersede ran before the other offer's insert (the race): it consumed nothing.
        if (k === "from" && !o.supersede) return (table: string) => {
          const b = (target as any).from(table);
          return table === "channel_pending_approvals" ? new Proxy(b, { get(x, m) { return m === "update" ? () => ({ eq() { return this; }, is: async () => ({ data: null, error: null }) }) : (x as any)[m]?.bind?.(x) ?? (x as any)[m]; } }) : b;
        };
        const v = (target as any)[k];
        return typeof v === "function" ? v.bind(target) : v;
      } }),
    });
    const hex = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

    await t.step("B1. two offers racing on workers 2 s apart: the reply resolves the card offered last", async () => {
      for (const skew of [-2000, -1, 0]) {
        const { u, chat } = await someone();
        const sender = `${n}${RUN}`.replace(/\D/g, "").padEnd(8, "7");
        const shownFirst = `run-first-${n}`, shownLast = `run-last-${n}`;
        runs.set(shownFirst, hex()); runs.set(shownLast, hex());
        const a = await offerApproval(deps({ supersede: true }), { channel: "telegram", senderKey: sender, userId: u, threadId: chat, runId: shownFirst });
        ok(a, "the first offer is made");
        // The second worker's clock is behind; its supersede ran before the first offer's insert.
        const b = await onClock(skew, () => offerApproval(deps({ supersede: false }), { channel: "telegram", senderKey: sender, userId: u, threadId: chat, runId: shownLast }));
        ok(b, "the second offer is made");
        const live = await rows(db, `select run_id from public.channel_pending_approvals where sender_key = ${q(sender)} and consumed_at is null`);
        ok(live.length === 2, `both offers are live, as the race leaves them (${live.length})`);
        const p = await peekApproval(deps({ supersede: true }), { channel: "telegram", senderKey: sender });
        ok(p?.run_id === shownLast, `skew ${skew} ms: the reply resolves the card offered last (${p?.run_id})`);
      }
    });

    // ---------------------------------------------------------------------------------------- C. the rules, as Postgres reads them
    await t.step("C. the clock rules (tests/flow/db_clock.ts) are what Postgres evaluates, at every boundary", async () => {
      const base = RealDate.parse("2026-10-31T04:00:00Z"), cases: string[] = [], want: string[] = [];
      for (let i = 0; i < 300; i++) {
        const ms = base + Math.floor(Math.random() * 86_400_000), dbUs = msToMicros(ms) + BigInt([0, 1, 499, 999, Math.floor(Math.random() * 1000)][i % 5]);
        const w = ms + [-2000, -1, 0, 0, 1, 2000][i % 6], pNow = dbUs + BigInt([-2_000_000, -1, 0, 1, 2_000_000][i % 5]), tx = dbUs;
        const d = `${q(microsToIso(dbUs))}::timestamptz`, wk = `${q(new RealDate(w).toISOString())}::timestamptz`, p = `${q(microsToIso(pNow))}::timestamptz`;
        cases.push(`(${d} <= date_trunc('milliseconds', ${wk}) + interval '999 microseconds')::text || ',' || (date_trunc('milliseconds', ${d}) <= ${wk})::text
          || ',' || to_char(least(${p}, ${d}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
        want.push(`${dueForWorker(dbUs, w)},${notBeforeReached(dbUs, w)},${microsToIso(cardShownAt(pNow, tx))}`);
      }
      const got = await rows(db, `select ${cases.map((c, i) => `${c} as c${i}`).join(", ")}`);
      for (let i = 0; i < cases.length; i++) ok(got[0][`c${i}`] === want[i], `case ${i}: Postgres ${got[0][`c${i}`]}, rule ${want[i]}`);
    });
  } finally {
    globalThis.Date = RealDate;
    await db.stop();
  }
} });
