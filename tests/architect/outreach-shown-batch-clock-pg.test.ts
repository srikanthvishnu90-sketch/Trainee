// Follow-up approvals bound to the batch a chat showed, against the clocks (2026-10-31; CI run 41154002130, architect
// shard 2, tests/architect/flow-scenarios-networking-r2.test.ts B3: "exactly the shown batch's [1] approved ... the newer
// batch is not approved"). supabaseRepliesStore.shownBatch takes the newest batch created no later than the chat's
// "show outreach approvals" reply (agent_messages.created_at: the database's clock, microseconds). saveActions wrote each
// action's created_at from the caller's `at` (the worker's clock, milliseconds; the scheduled run passes its start time).
// So a batch read as shown when it was not:
//   1. drafted by a run that started before the reply was written and saved after it (its `at` is the run's start);
//   2. saved in the same millisecond as the reply (the millisecond truncated below the reply's microseconds): B3's race;
//   3. any batch, when the reply was written before a batch existed (the newest batch was read instead).
// Each is a "send all" approving a batch the person never saw. On a real Postgres 16 with every migration, through the
// PostgREST double and the real supabase-js client, as the chat turn runs it (repliesTurn).
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/outreach-shown-batch-clock-pg.test.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { CI, haveDb, person, railDb, rows, uid as uidOf } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseParity } from "../flow/handler.ts";
import { ACTIONS_INTENT, actionHash, repliesTurn, supabaseRepliesStore } from "../../supabase/functions/_shared/career_outreach_replies.ts";

function ok(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const DAY = 86_400_000;
const RUN = crypto.randomUUID().slice(0, 3);

Deno.test({ name: "outreach approvals: the batch a chat showed is the one approved, whatever clock drafted the next one", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const db = await railDb();
  try {
    await supabaseParity(db.pg as any);
    const double = postgrestDouble(db.pg as any, { url: "http://supabase.test", serviceKey: "service-test-key", users: {} });
    const admin = createClient("http://supabase.test", "service-test-key", { global: { fetch: double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
    const replies = supabaseRepliesStore(admin);
    let n = 0;
    const setup = async () => {
      const u = uidOf(++n, `9${RUN}`.slice(0, 3)), chat = crypto.randomUUID();
      await person(db, u);
      await db.sql.query(`insert into public.agent_threads (id, user_id, title) values (${q(chat)}, ${q(u)}, 'TEST')`);
      // One batch of k follow-ups, saved at `at` (the drafting run's clock).
      const mk = async (k: number, at: number) => {
        const items = [];
        for (let i = 0; i < k; i++) {
          const to = `c${n}-${crypto.randomUUID().slice(0, 6)}.${RUN}@example.test`;
          const tid = await replies.track({ user_id: u, draft_id: null, provider: "gmail", provider_thread: `th-${crypto.randomUUID().slice(0, 8)}`, email: to, name: `P ${i}`, firm: "Acme", subject: "Coffee chat?", sent_at: new Date(Date.now() - 5 * DAY).toISOString() });
          const payload = { to, subject: "Re: Coffee chat?", text: `Following up (${i}).`, thread: null, provider: "gmail", step: 1 };
          items.push({ thread_id: tid, kind: "followup" as const, step: 1, payload, hash: await actionHash("followup", payload) });
        }
        return await replies.saveActions(u, items, at);
      };
      // "show outreach approvals", and the reply written into the chat as the chat turn writes it; its time (the database's).
      const show = async () => {
        const s = await repliesTurn({ message: "show outreach approvals", userId: u, chatThreadId: chat, now: Date.now(), store: replies });
        ok(s?.status === "shown", `shown (${s?.status})`);
        const r = await db.sql.query(`insert into public.agent_messages (thread_id, role, content, meta) values (${q(chat)}, 'assistant', ${q(s!.reply)}, ${q(JSON.stringify({ intent: ACTIONS_INTENT }))}::jsonb)
          returning to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
        return Date.parse(String(r[0][0]));
      };
      const state = async (batch: string) => (await rows(db, `select n, status from public.career_outreach_actions where user_id = ${q(u)} and batch_id = ${q(batch)} order by n`)).map((x: any) => `${x.n}:${x.status}`).join(",");
      return { u, chat, mk, show, state };
    };

    await t.step("1. drafted by a run that started before the reply, saved after it: not approved by the yes to what was shown", async () => {
      const s = await setup();
      const runStart = Date.now();
      const shown = await s.mk(2, Date.now());
      await new Promise((r) => setTimeout(r, 20));
      const msgAt = await s.show();
      const newer = await s.mk(1, Math.max(runStart, msgAt - 5)); // the run's clock: before the reply, after the shown batch
      const r = await repliesTurn({ message: "send all", userId: s.u, chatThreadId: s.chat, now: Date.now(), store: replies });
      ok(r?.status === "approved", `"send all" is read (${r?.status}: ${r?.reply})`);
      ok(await s.state(shown[0].batch_id) === "1:approved,2:approved", `the shown batch approved (${await s.state(shown[0].batch_id)})`);
      ok(await s.state(newer[0].batch_id) === "1:shown", `the batch drafted after the reply is not approved (${await s.state(newer[0].batch_id)})`);
      ok(/more drafted since/.test(r?.reply ?? ""), `the reply says one more waits (${r?.reply})`);
    });

    await t.step("2. saved in the reply's own millisecond (the worker's milliseconds against the database's microseconds)", async () => {
      const s = await setup();
      const shown = await s.mk(1, Date.now() - 1000);
      const msgAt = await s.show();
      const newer = await s.mk(2, msgAt); // the same millisecond, truncated: at or below the reply's microseconds
      const r = await repliesTurn({ message: "yes", userId: s.u, chatThreadId: s.chat, now: Date.now(), store: replies });
      ok(r?.status === "approved", `"yes" is read (${r?.status}: ${r?.reply})`);
      ok(await s.state(shown[0].batch_id) === "1:approved", `the shown batch approved (${await s.state(shown[0].batch_id)})`);
      ok(await s.state(newer[0].batch_id) === "1:shown,2:shown", `the newer batch is not approved (${await s.state(newer[0].batch_id)})`);
    });

    await t.step("3. the reply was written before any batch existed: a batch drafted later is not approved by the next yes", async () => {
      const s = await setup();
      await s.show(); // nothing waiting
      const later = await s.mk(1, Date.now() - 60_000);
      const r = await repliesTurn({ message: "send all", userId: s.u, chatThreadId: s.chat, now: Date.now(), store: replies });
      ok(r?.status !== "approved", `nothing approved (${r?.status}: ${r?.reply})`);
      ok(await s.state(later[0].batch_id) === "1:shown", `the batch drafted after the reply waits (${await s.state(later[0].batch_id)})`);
    });
  } finally {
    await db.stop();
  }
} });
