// Billing and cancel-by-text end to end (battery 2026-10-30), sampled from the generated scenarios
// (tests/architect/scenarios/billing-generator.ts; the full ~10,000 run pure in tests/architect/scenarios-billing-cancel.test.ts),
// on real Postgres 16 with every migration.
//
// TEXT through the REAL production chat handler (agent-chat handler-career.ts handleChat; harness tests/flow/handler.ts):
// each scenario is a fresh person whose user_subscriptions row is the scenario's state, texting the scenario's script;
// FakeStripe answers the handler's own adapter (stripeFromEnv, a fake key in the environment). Checked: a clear cancel ask
// is answered by billing with the exact confirmation; look-alikes never ask or reach Stripe; "Done" only when FakeStripe's
// truth says so; a double or concurrent yes applies once; undo before the period end works; a cancel after an undo made at
// Stripe really cancels; another person's thread never cancels anything; card and bank details are in no reply, no
// message row and no log, and the reply says where paying goes; no billing turn reaches a model.
//
// WEBHOOK through the REAL handler (stripe_webhook.ts handleStripeWebhook, what stripe-webhook/index.ts serves) with the
// product's store over supabase-js to the PostgREST double, so every write is billing_sync_subscription on Postgres:
// in order, shuffled, duplicated at once, replayed late, raced by a slower handler, retried after Stripe was down, with
// bad signatures, unknown and foreign customers, missing people; the row ends as Stripe's truth and never on the wrong
// person.
//
// Row dates are moved to 2031 (ahead) or 2021 (past), so nothing depends on the wall clock the handler reads; every
// environment variable set here is restored; no host but the double and FakeStripe is reached (others are refused and
// listed). About 60 text scenarios (~170 handler turns) and 40 webhook scenarios (~200 deliveries).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import {
  cancellable, FakeStripe, NOW, resumable, STRIPE_KEY, stripeTruth, type TextScenario, textScenarios, uidFor, WEBHOOK_SECRET, type WebhookScenario, webhookScenarios,
} from "./scenarios/billing-generator.ts";
import { playWebhook } from "./scenarios/billing-webhook-play.ts";
import { factsOk, REFUND_PROMISE, RETENTION } from "./scenarios/billing-check.ts";
import { PAY_BY_CHECKOUT, type Subscription } from "../../supabase/functions/_shared/career_billing.ts";
import { handleStripeWebhook, type SyncRow, supabaseWebhookStore, webhookStripe } from "../../supabase/functions/_shared/stripe_webhook.ts";

const CI = Deno.env.get("CI") === "true";
const uidOf = (i: number) => `7b0f8f8e-6a43-4a49-9d2c-${(0xbc000000 + i).toString(16).padStart(12, "0")}`;
const lit = (v: unknown) => v === null || v === undefined ? "null" : typeof v === "boolean" || typeof v === "number" ? String(v) : `$q$${v}$q$`;
// Dates off the wall clock: ahead of NOW -> 2031, at or before -> 2021 (same month, day and time).
const shift = (iso: string | null | undefined) => iso ? `${Date.parse(iso) > NOW ? "2031" : "2021"}${iso.slice(4)}` : iso ?? null;
const shiftRow = (r: Subscription | null): Subscription | null => r ? { ...r, current_period_end: shift(r.current_period_end), current_period_start: shift(r.current_period_start) } : null;

function sampleText(): TextScenario[] {
  const all = textScenarios(20261030, 6000);
  const seen = new Map<string, number>();
  const out: TextScenario[] = [];
  for (const s of all) {
    const key = `${s.script.kind}|${s.rowKind}`;
    const cap = ["cancel", "resume", "control", "payment", "status"].includes(s.script.kind) ? 1 : 1;
    if ((seen.get(key) ?? 0) >= cap) continue;
    // Each kind on the row states that matter for it (and a couple of others).
    const rowsFor: Record<string, string[]> = {
      cancel: ["active", "none", "past_due", "canceled", "ending", "price_unknown", "yearly", "past_end_active"], double_yes: ["active", "trialing"], concurrent_yes: ["active", "unpaid"],
      control: ["active", "ending", "none"], control_after_ask: ["active", "trialing"], status: ["active", "ending", "past_end_ending", "none", "past_end_active"],
      resume: ["ending", "ending_trial", "past_end_ending", "active", "canceled", "none"], cycle: ["active", "trialing", "price_odd"], stripe_undo: ["active", "yearly"],
      other_person: ["active", "none"], payment: ["active", "none", "ending"],
    };
    if (!rowsFor[s.script.kind]?.includes(s.rowKind)) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    out.push({ ...s, row: shiftRow(s.row), mode: s.mode === "timeout" ? "5xx" : s.mode });
  }
  return out;
}
function sampleWebhooks(): WebhookScenario[] {
  const all = webhookScenarios(20261031, 4000);
  const seen = new Set<string>();
  const out: WebhookScenario[] = [];
  for (const s of all) {
    const key = s.who !== "own" ? `who:${s.who}` : s.badSig !== "none" ? `sig:${s.badSig}` : `${s.delivery}|${s.changes.join(">")}`;
    if (seen.has(key)) continue;
    if (s.who === "own" && s.badSig === "none" && [...seen].filter((k) => k.startsWith(`${s.delivery}|`)).length >= 4) continue;
    seen.add(key);
    out.push({ ...s, credits: [], user: uidFor(100000 + out.length * 2), other: uidFor(100000 + out.length * 2 + 1) });
    if (out.length >= 40) break;
  }
  return out;
}

Deno.test({
  name: "billing and cancel-by-text end to end: the real chat handler and the real webhook handler on Postgres, FakeStripe at the HTTP boundary",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const started = Date.now();
    const TEXT = sampleText(), HOOKS = sampleWebhooks();
    const people: Record<string, string> = {};
    for (let i = 1; i <= TEXT.length * 2 + 2; i++) people[`tok-bc-${i}`] = uidOf(i);
    const unset = ["CAREER_BRAIN", "ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];
    const saved = Object.fromEntries(unset.map((k) => [k, Deno.env.get(k)]));
    for (const k of unset) Deno.env.delete(k);
    const pg: Pg = await startPg();
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch;
    const realLog = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    const logged: string[] = [];
    let closeSession: (() => Promise<void>) | null = null;
    try {
      await supabaseParity(pg);
      await pg.sql(Object.values(people).map((id) => `insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`).join("\n"));
      const session = psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! });
      closeSession = session.close;
      const fast: Pg = { ...pg, sql: async (text: string) => (await session.q(text)).join("\n").trim() };
      h = await careerHandler(fast, people);
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      const cur = { fake: new FakeStripe() };
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin === new URL(SUPABASE_URL).origin) return await viaDouble(req);
        if (u.host === "api.stripe.com") return await cur.fake.fetch(req);
        outbound.push(`${req.method} ${u.host}${u.pathname}`);
        throw new TypeError(`network refused: ${u.host}`);
      }) as typeof fetch;
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = (...a: unknown[]) => { logged.push(a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ")); };
      const failures: string[] = [];
      const counts = { text: 0, turns: 0, hooks: 0, deliveries: 0 };
      const secretsSeen: string[] = [];

      await t.step(`text: ${TEXT.length} sampled scenarios through the chat handler`, async () => {
        Deno.env.set("STRIPE_SECRET_KEY", STRIPE_KEY);
        for (const [i, sc] of TEXT.entries()) {
          const id = uidOf(i + 1), tok = `tok-bc-${i + 1}`, chat = h!.chat(tok);
          const name = `#${sc.id} [${sc.rowKind}/${sc.mode}/${sc.script.kind}]`;
          const fail = (m: string) => failures.push(`${name} ${m}`);
          const fake = new FakeStripe();
          fake.mode = sc.mode;
          cur.fake = fake;
          const truth = stripeTruth(sc.row, id);
          if (truth) fake.subs.set(truth.id, truth);
          const r = sc.row;
          if (r) {
            await pg.sql(`insert into public.user_subscriptions (user_id, status, plan, price_cents, current_period_start, current_period_end, stripe_customer_id, stripe_subscription_id, cancel_at_period_end)
              values ('${id}', ${lit(r.status)}, ${lit(r.plan)}, ${lit(r.price_cents)}, ${lit(r.current_period_start)}, ${lit(r.current_period_end)}, ${lit(r.stripe_customer_id)}, ${lit(r.stripe_subscription_id)}, ${lit(r.cancel_at_period_end ?? false)});`);
          }
          const sub = () => truth ? fake.subs.get(truth.id)! : null;
          let doneSaid = false;
          const say = async (m: string, c = chat) => {
            const res = await c.say(m);
            counts.turns++;
            if (res.status !== 200) fail(`${JSON.stringify(m)}: HTTP ${res.status} ${res.reply.slice(0, 120)}`);
            const billing = /^career_billing/.test(String(res.intent));
            if (billing) {
              if (/^Done, your plan is cancelled/.test(res.reply)) doneSaid = true;
              if (/^Done, your plan is cancelled/.test(res.reply) && sub()?.cancel_at_period_end !== true) fail(`"Done, cancelled" while Stripe still renews: ${res.reply}`);
              if (/^Done, your plan is kept/.test(res.reply) && sub()?.cancel_at_period_end !== false) fail(`"Done, kept" while Stripe still ends it: ${res.reply}`);
              if (RETENTION.test(res.reply) || REFUND_PROMISE.test(res.reply)) fail(`retention or refund words: ${res.reply}`);
              const stripeSaid = truth ? { ...sc.row!, current_period_end: new Date(sub()!.current_period_end * 1000).toISOString() } : null;
              const bad = factsOk(res.reply, [sc.row, stripeSaid], [], new Set());
              if (bad) fail(`${JSON.stringify(m)}: ${bad}: ${res.reply}`);
            }
            return { ...res, billing };
          };
          const effective = () => truth ? fake.posts(`/v1/subscriptions/${truth.id}`).filter((c) => !c.replayed && c.status === 200).length : 0;
          const s = sc.script;
          const ok = sc.mode === "ok";
          if (s.kind === "control") {
            const a = await say(s.text);
            if (a.billing && a.body?.meta?.intent === "career_billing_cancel_ask") fail(`a look-alike asked to cancel: ${JSON.stringify(s.text)}`);
            await say("yes");
            if (fake.posts().length) fail(`a look-alike reached Stripe: ${JSON.stringify(s.text)}`);
          } else if (s.kind === "control_after_ask" || s.kind === "cancel" || s.kind === "double_yes" || s.kind === "concurrent_yes") {
            const ask = await say(s.ask);
            if (!ask.billing) fail(`a clear cancel ask not answered by billing: ${JSON.stringify(s.ask)} -> ${ask.intent}`);
            if (cancellable(r) && !(/This cancels your Trainee plan/.test(ask.reply) && /Reply "yes" to cancel\.$/.test(ask.reply))) fail(`no exact confirmation: ${ask.reply}`);
            if (!cancellable(r) && ask.intent === "career_billing_cancel_ask") fail(`an ask with nothing to cancel: ${ask.reply}`);
            if (s.kind === "control_after_ask") {
              await say(s.text);
              if (fake.posts().length) fail(`a look-alike answer reached Stripe: ${JSON.stringify(s.text)}`);
            } else if (s.kind === "cancel") {
              const a = await say(s.answer);
              const want = s.cls === "yes" && cancellable(r);
              if (!want && fake.posts().length) fail(`${JSON.stringify(s.answer)} reached Stripe`);
              if (want && ok && (sub()?.cancel_at_period_end !== true || !/^Done/.test(a.reply))) fail(`a clear yes did not cancel: ${a.reply}`);
            } else if (s.kind === "double_yes") {
              await say(s.answer); await say(s.answer);
              if (cancellable(r) && ok && (effective() !== 1 || sub()?.cancel_at_period_end !== true)) fail(`double yes applied ${effective()} times`);
            } else {
              const [a, b] = await Promise.all([chat.say(s.answer), chat.say(s.answer)]);
              counts.turns += 2;
              for (const x of [a, b]) {
                if (![200, 409, 503].includes(x.status)) fail(`concurrent yes: HTTP ${x.status}`);
                if (/^Done, your plan is cancelled/.test(x.reply)) doneSaid = true;
                if (/^Done, your plan is cancelled/.test(x.reply) && sub()?.cancel_at_period_end !== true) fail(`concurrent "Done" while Stripe renews`);
              }
              if (cancellable(r) && ok && effective() > 1) fail(`two yeses at once applied ${effective()} times`);
              if (!cancellable(r) && fake.posts().length) fail("concurrent yes on nothing cancellable reached Stripe");
            }
            const marked = await pg.sql(`select coalesce((select cancel_at_period_end::text from public.user_subscriptions where user_id = '${id}'), 'none')`);
            // The row says ending exactly when it was, or when "Done" was said (Stripe confirmed, on the first yes or a retry).
            const want = r ? (r.cancel_at_period_end === true || doneSaid ? "true" : "false") : "none";
            if (marked !== want) fail(`row cancel_at_period_end ${marked}, want ${want}`);
          } else if (s.kind === "status") {
            const a = await say(s.ask);
            if (!a.billing) fail(`a status ask left to the rest of the chat: ${JSON.stringify(s.ask)} -> ${a.intent}`);
            if (fake.calls.length) fail("a status ask called Stripe");
          } else if (s.kind === "resume") {
            const a = await say(s.ask);
            if (!a.billing) fail(`an undo ask not answered by billing: ${JSON.stringify(s.ask)}`);
            if (resumable(r) !== (a.intent === "career_billing_resume_ask")) fail(`undo offered ${a.intent === "career_billing_resume_ask"}, resumable ${resumable(r)}: ${a.reply}`);
            const b = await say(s.answer);
            if (resumable(r) && s.cls === "yes" && ok) {
              if (sub()?.cancel_at_period_end !== false || !/^Done, your plan is kept/.test(b.reply)) fail(`undo yes not done: ${b.reply}`);
              if (await pg.sql(`select cancel_at_period_end::text from public.user_subscriptions where user_id = '${id}'`) !== "false") fail("row still ending after the undo");
            } else if (!(resumable(r) && s.cls === "yes") && fake.posts().length) fail(`an undo reached Stripe without a clear yes: ${JSON.stringify(s.answer)}`);
          } else if (s.kind === "cycle") {
            await say(s.cancel); await say("yes");
            await say(s.resume); await say("yes");
            if (sub()?.cancel_at_period_end !== false) fail("cycle: the undo did not reach Stripe");
            await say(s.cancel);
            const c = await say("yes");
            if (sub()?.cancel_at_period_end !== true || !/^Done, your plan is cancelled/.test(c.reply)) fail(`cycle: the second cancel ${c.reply}`);
          } else if (s.kind === "stripe_undo") {
            await say(s.ask); await say("yes");
            // Undone at Stripe; the webhook wrote it.
            sub()!.cancel_at_period_end = false; sub()!.cancel_at = null;
            await pg.sql(`update public.user_subscriptions set cancel_at_period_end = false where user_id = '${id}'`);
            await say(s.ask);
            const c = await say("yes");
            if (sub()?.cancel_at_period_end !== true) fail(`a cancel after an undo at Stripe did not cancel (said: ${c.reply})`);
          } else if (s.kind === "other_person") {
            // A asks to cancel; B answers "yes" on A's thread.
            const aTok = `tok-bc-${TEXT.length + i + 1}`, aId = people[aTok];
            const aRow = shiftRow({ status: "active", plan: "monthly", price_cents: 1000, current_period_start: "2026-10-27T15:00:00.000Z", current_period_end: "2026-11-27T15:00:00.000Z",
              stripe_customer_id: `cus_a${i}`, stripe_subscription_id: `sub_a${i}`, cancel_at_period_end: false })!;
            await pg.sql(`insert into public.user_subscriptions (user_id, status, plan, price_cents, current_period_start, current_period_end, stripe_customer_id, stripe_subscription_id)
              values ('${aId}', 'active', 'monthly', 1000, ${lit(aRow.current_period_start)}, ${lit(aRow.current_period_end)}, 'cus_a${i}', 'sub_a${i}') on conflict (user_id) do nothing;`);
            fake.subs.set(`sub_a${i}`, stripeTruth(aRow, aId)!);
            const a = h!.chat(aTok);
            await a.say("cancel my plan");
            const res = await chat.say(s.answer, { thread_id: a.thread() });
            counts.turns += 2;
            if (fake.posts().length) fail(`another person's yes reached Stripe (HTTP ${res.status}: ${res.reply.slice(0, 100)})`);
            if (fake.subs.get(`sub_a${i}`)!.cancel_at_period_end) fail("A's plan cancelled by B");
          } else if (s.kind === "payment") {
            const a = await say(s.text);
            secretsSeen.push(...s.secrets);
            for (const x of s.secrets) if (a.reply.includes(x)) fail(`a payment detail in the reply: ${x}`);
            if (!a.reply.includes(PAY_BY_CHECKOUT)) fail(`not told to pay by checkout: ${a.reply.slice(0, 200)}`);
            if (fake.posts().length) fail("a payment message reached Stripe");
          }
          counts.text++;
        }
        Deno.env.delete("STRIPE_SECRET_KEY");
        // Card and bank details: in no message row, no meta, no subscription row, no log line.
        const dump = await pg.sql(`select coalesce(string_agg(t, E'\\n'), '') from (select content as t from public.agent_messages union all select meta::text from public.agent_messages union all select row(s.*)::text from public.user_subscriptions s) x`);
        const flat = dump.replace(/(?<=\d)[ -](?=\d)/g, "");
        for (const x of new Set(secretsSeen)) {
          const d = x.replace(/\D/g, "");
          if (dump.includes(x) || (d.length >= 6 && flat.includes(d))) failures.push(`a payment detail stored: ${x}`);
        }
        for (const l of logged) {
          if (l.includes(STRIPE_KEY)) { failures.push("the Stripe key in a log line"); break; }
          for (const x of secretsSeen) if (x.length >= 12 && l.includes(x)) { failures.push(`a payment detail in a log line: ${x}`); break; }
        }
      });

      await t.step(`webhook: ${HOOKS.length} sampled scenarios through the webhook handler, written by billing_sync_subscription`, async () => {
        const admin = createClient(SUPABASE_URL, SERVICE_KEY, { global: { fetch: h!.double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
        const base = supabaseWebhookStore(admin);
        let hold: ((row: SyncRow) => Promise<void>) | null = null;
        const store = { ...base, sync: async (row: SyncRow) => { if (hold) await hold(row); return await base.sync(row); } };
        const read = async (u: string) => {
          const out = await pg.sql(`select coalesce((select json_build_object('status', status, 'plan', plan, 'price_cents', price_cents, 'current_period_end', current_period_end, 'stripe_customer_id', stripe_customer_id, 'stripe_subscription_id', stripe_subscription_id, 'cancel_at_period_end', cancel_at_period_end)::text from public.user_subscriptions where user_id = '${u}'), 'null')`);
          return JSON.parse(out);
        };
        for (const sc of HOOKS) {
          const fake = new FakeStripe();
          cur.fake = fake;
          const clock = { t: NOW };
          const stripe = webhookStripe(fake.fetch, STRIPE_KEY, { timeoutMs: 50 });
          const res = await playWebhook(sc, {
            store, fake, clock,
            deliver: (req) => handleStripeWebhook(req, { secret: WEBHOOK_SECRET, stripe, store, now: () => clock.t }),
            read,
            setupRow: async (u, row) => {
              await pg.sql(`insert into public.user_subscriptions (user_id, status, current_period_end, stripe_customer_id, stripe_subscription_id) values ('${u}', ${lit(row.status)}, ${lit(row.current_period_end ?? null)}, ${lit(row.stripe_customer_id)}, ${lit(row.stripe_subscription_id ?? null)})`);
            },
            addProfile: async (u) => { await pg.sql(`insert into auth.users (id, email) values ('${u}', '${u}@example.test') on conflict do nothing; insert into public.profiles (id) values ('${u}') on conflict do nothing;`); },
            addCredits: async () => {},
            creditsApplied: async () => 0,
            setHold: (fn) => { hold = fn; },
          });
          failures.push(...res.fails);
          counts.hooks++;
          counts.deliveries += res.deliveries;
        }
        for (const l of logged) if (l.includes(WEBHOOK_SECRET) || l.includes(STRIPE_KEY)) { failures.push("a secret in a log line"); break; }
      });

      await t.step("nothing left the machine (no model, no Stripe); in time", () => {
        const secs = (Date.now() - started) / 1000;
        realLog.log(`flow-scenarios-billing-cancel: text ${counts.text} scenarios / ${counts.turns} handler turns, webhook ${counts.hooks} scenarios / ${counts.deliveries} deliveries, in ${secs.toFixed(1)} s; refused: ${outbound.join("; ") || "none"}`);
        if (outbound.length) failures.push(`outbound requests: ${outbound.join(", ")}`);
        if (secs > 240) failures.push(`took ${secs.toFixed(0)} s`);
        assertNode.deepEqual(failures, [], failures.slice(0, 60).join("\n"));
      });
    } finally {
      Object.assign(console, realLog);
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await closeSession?.().catch(() => {});
      await pg.stop();
    }
  },
});
