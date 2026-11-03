// Billing and cancel-by-text ROUND 2 end to end (battery 2026-10-30), sampled from the generated scenarios
// (tests/architect/scenarios/billing-r2-generator.ts; the full 10,000 run pure in tests/architect/scenarios-billing-r2.test.ts),
// on real Postgres 16 with every migration (20261030130000_billing_r2.sql included).
//
// A. TEXT through the REAL production chat handler (agent-chat handler-career.ts handleChat; harness tests/flow/handler.ts),
//    the web channel and Telegram's: each scenario is a fresh person whose user_subscriptions row (currency, discount, live
//    count included) is the scenario's state and whose invoices, charges and billing page are FakeStripeR2's, texting the
//    scenario's ask. The staged brain is ON with a fake model that counts its calls: every billing ask with an answer in the
//    records is answered by billing with ZERO model calls; facts only from the row or Stripe's records; the card page only as
//    Stripe returned it; a cancel in another language confirmed, applied once on "yes", never on "sí"/"oui"/"ja" or a "no".
// B. WEBHOOK through the REAL handler (stripe_webhook.ts) with the product's store over supabase-js to the PostgREST double,
//    so every write is billing_sync_subscription's 13-argument form on Postgres: double checkouts, trials, coupons,
//    currencies, dunning, customer.deleted, a deleted account, schedules, unknown events, signatures; after every step the row
//    is Stripe's truth (newest live subscription, live count, currency, discount); the referrer is credited only for money paid.
// C. THE CHAT'S CANCEL AND A SLOWER WEBHOOK (round 1's open item): a webhook read of Stripe taken before the chat's cancel
//    but written after it is refused as stale (stripe_synced_at advanced by the cancel); a read after it is written.
// D. ACCOUNT DELETION'S BILLING STEP (account_delete.ts restDeps endBilling) reading the row through the double and
//    cancelling at FakeStripeR2: a live plan (or two) is cancelled; none, no call; Stripe down, "failed" (nothing deleted).
//
// Row dates are moved to 2031 (ahead) or 2021 (past), so nothing depends on the wall clock the handler reads; every
// environment variable set here is restored; no host but the double, FakeStripeR2 and the fake model is reached (others are
// refused and listed). About 90 flows.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import {
  ASKS_R2, cancellableR2, FakeStripeR2, NOW, PORTAL, rowR2, STRIPE_KEY_R2, type TextScenarioR2, textScenariosR2, truthR2, uidR2, type WebhookScenarioR2,
  webhookScenariosR2, WEBHOOK_SECRET_R2, rng, invoicesR2,
} from "./scenarios/billing-r2-generator.ts";
import { factsR2, playWebhookR2 } from "./scenarios/billing-r2-play.ts";
import { REFUND_PROMISE, RETENTION } from "./scenarios/billing-check.ts";
import { PAY_BY_CHECKOUT, type Subscription } from "../../supabase/functions/_shared/career_billing.ts";
import { handleStripeWebhook, stripeSignature, type SyncRow, supabaseWebhookStore, webhookStripe } from "../../supabase/functions/_shared/stripe_webhook.ts";
import { restDeps } from "../../supabase/functions/_shared/account_delete.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

const CI = Deno.env.get("CI") === "true";
const LIVE = ["active", "trialing", "past_due", "unpaid"];
const uidOf = (i: number) => `7b0f8f8e-6a43-4a49-9d2c-${(0xb2000000 + i).toString(16).padStart(12, "0")}`;
const lit = (v: unknown) => v === null || v === undefined ? "null" : typeof v === "boolean" || typeof v === "number" ? String(v) : `$q$${v}$q$`;
// Dates off the wall clock: ahead of NOW -> 2031, at or before -> 2021 (same month, day and time).
const shift = (iso: string | null | undefined) => iso ? `${Date.parse(iso) > NOW ? "2031" : "2021"}${iso.slice(4)}` : iso ?? null;
const shiftRow = (r: Subscription | null): Subscription | null => r ? { ...r, current_period_end: shift(r.current_period_end), current_period_start: shift(r.current_period_start) } : null;
// The model's key for the staged brain: fake, assembled at run time.
const MODEL_KEY = ["sk", "test", "billingR2", "model", "not", "real"].join("-");
const completion = (body: any, message: any) => Response.json({ id: "chatcmpl-b2", model: body.model, choices: [{ index: 0, message, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 40 } });

// Each ask family on the row states that matter for it; a cancel in other languages on every cancellable state.
function sampleText(): TextScenarioR2[] {
  const all = textScenariosR2(20261030, 6000);
  const want: Record<string, string[]> = {
    "ask:card": ["active", "past_due", "none", "unpaid"], "ask:charges": ["two_live", "active", "none"], "ask:refund_status": ["active", "ended"],
    "ask:pause": ["active", "none", "two_live"], "ask:change_plan": ["yearly", "canceled"], "ask:subscribe": ["none", "active", "ended"],
    "ask:price": ["trialing", "past_due", "unpaid", "discounted", "eur", "jpy", "two_live", "canceled", "ended"], "ask:refund": ["active"],
    "ask:cancel": ["active", "trialing", "none"], "ask:cancel_now": ["active"], "lang_cancel": ["active", "trialing", "yearly", "past_due", "none", "ending"],
    "not_billing": ["active", "none"], "stale_answer": ["active"],
  };
  const seen = new Set<string>();
  const out: TextScenarioR2[] = [];
  for (const s of all) {
    const k = s.script.kind === "ask" ? `ask:${s.script.family}` : s.script.kind;
    if (!want[k]?.includes(s.rowKind) || seen.has(`${k}|${s.rowKind}`)) continue;
    seen.add(`${k}|${s.rowKind}`);
    out.push({ ...s, row: shiftRow(s.row), mode: s.mode === "timeout" ? "5xx" : s.mode });
  }
  return out;
}
function sampleWebhooks(): WebhookScenarioR2[] {
  const all = webhookScenariosR2(20261032, 3000);
  // Every flow twice (two different deliveries), and every refused signature at least once.
  const picked: WebhookScenarioR2[] = [];
  const has = (f: (x: WebhookScenarioR2) => boolean) => picked.some(f);
  for (const s of all) {
    const flow = s.steps.join(">");
    const same = picked.filter((x) => x.steps.join(">") === flow);
    const newBad = s.bad !== "none" && !has((x) => x.bad === s.bad);
    if (newBad || (same.length < 2 && !same.some((x) => x.delivery === s.delivery))) picked.push(s);
  }
  return picked.slice(0, 48).map((s, i) => ({ ...s, user: uidR2(300000 + i * 2), other: uidR2(300000 + i * 2 + 1), customer: `cus_f2_${i}` }));
}

Deno.test({
  name: "billing round 2 end to end: the real chat handler (web and Telegram, staged brain on, model calls counted), the real webhook on Postgres, the chat's cancel against a slower webhook, account deletion's billing step",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const started = Date.now();
    const TEXT = sampleText(), HOOKS = sampleWebhooks();
    const people: Record<string, string> = {};
    for (let i = 1; i <= TEXT.length + 40; i++) people[`tok-b2-${i}`] = uidOf(i);
    const keys = ["CAREER_BRAIN", "ANTHROPIC_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "CAREER_MODEL", "MODEL_PROVIDER", "CAREER_BRAIN_ROUTER_INTENTS",
      "CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS", "MODEL_BUDGET_PAUSED", "CAREER_REPLY_WRITER", "TELEGRAM_BOT_TOKEN"];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    for (const k of keys) Deno.env.delete(k);
    const pg: Pg = await startPg();
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch;
    const realLog = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    const logged: string[] = [];
    let closeSession: (() => Promise<void>) | null = null;
    const wire = { model: 0 };
    try {
      await supabaseParity(pg);
      await pg.sql(Object.values(people).map((id) => `insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`).join("\n"));
      const session = psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! });
      closeSession = session.close;
      const fast: Pg = { ...pg, sql: async (text: string) => (await session.q(text)).join("\n").trim() };
      h = await careerHandler(fast, people);
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      const cur = { fake: new FakeStripeR2() };
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin === new URL(SUPABASE_URL).origin) return await viaDouble(req);
        if (u.host === "api.stripe.com") return await cur.fake.fetch(req);
        if (u.host === "api.anthropic.com") { wire.model++; return anthropicWire(req, (body) => completion(body, { role: "assistant", content: "Here is a general answer." })); }
        outbound.push(`${req.method} ${u.host}${u.pathname}`);
        throw new TypeError(`network refused: ${u.host}`);
      }) as typeof fetch;
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = (...a: unknown[]) => { logged.push(a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ")); };
      const failures: string[] = [];
      const counts = { text: 0, turns: 0, hooks: 0, deliveries: 0, stale: 0, deletes: 0, modelOnBilling: 0, modelSanity: 0 };
      const insertRow = async (id: string, r: Subscription) => {
        await fast.sql(`insert into public.user_subscriptions (user_id, status, plan, price_cents, current_period_start, current_period_end, stripe_customer_id, stripe_subscription_id, cancel_at_period_end, currency, discounted, live_subscriptions)
          values ('${id}', ${lit(r.status)}, ${lit(r.plan)}, ${lit(r.price_cents)}, ${lit(r.current_period_start)}, ${lit(r.current_period_end)}, ${lit(r.stripe_customer_id)}, ${lit(r.stripe_subscription_id)},
          ${lit(r.cancel_at_period_end ?? false)}, ${lit(r.currency)}, ${lit(r.discounted ?? false)}, ${lit(r.live_subscriptions)}) on conflict (user_id) do nothing;`);
      };

      Deno.env.set("STRIPE_SECRET_KEY", STRIPE_KEY_R2);
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", MODEL_KEY);

      await t.step(`A. text: ${TEXT.length} sampled scenarios through the chat handler (web and Telegram), staged brain on`, async () => {
        for (const [i, sc] of TEXT.entries()) {
          const id = uidOf(i + 1), tok = `tok-b2-${i + 1}`, chat = h!.chat(tok);
          const s = sc.script;
          const channel = i % 2 ? "telegram" : undefined;
          const name = `#${sc.id} [${sc.rowKind}/${sc.mode}/${s.kind}${s.kind === "ask" ? `:${s.family}` : ""}${channel ? "/telegram" : ""}]`;
          const fail = (m: string) => failures.push(`A ${name} ${m}`);
          const fake = new FakeStripeR2();
          cur.fake = fake;
          const row = sc.row;
          for (const x of truthR2(row, id)) fake.subs.set(x.id, x);
          if (row?.stripe_customer_id) fake.customers.set(row.stripe_customer_id, { id: row.stripe_customer_id, metadata: { supabase_user_id: id } });
          fake.invoices = sc.invoices;
          if (row) await insertRow(id, row);
          fake.mode = sc.mode;
          const links = new Set<string>([...sc.invoices.map((x) => x.url!).filter(Boolean), ...(row?.stripe_customer_id ? [PORTAL(row.stripe_customer_id)] : [])]);
          const say = async (m: string) => {
            await fast.sql(`delete from public.agent_rate_limits`);
            const before = wire.model;
            const res = await chat.say(m, channel ? { channel } : {});
            counts.turns++;
            const billing = /^career_billing/.test(String(res.intent));
            const calls = wire.model - before;
            if (res.status !== 200) fail(`${JSON.stringify(m)}: HTTP ${res.status} ${res.reply.slice(0, 120)}`);
            if (billing) {
              if (calls) { counts.modelOnBilling += calls; fail(`${JSON.stringify(m)}: a billing turn called the model ${calls} times`); }
              const bad = factsR2(res.reply, row, sc.invoices, links, [...fake.subs.values()].map((x) => x.current_period_end));
              if (bad) fail(`${JSON.stringify(m)}: ${bad}: ${res.reply}`);
              const plain = res.reply.replace(/ before a discount/g, "").replace(/A discount applies[^.]*\./g, "");
              if (RETENTION.test(plain) || REFUND_PROMISE.test(res.reply)) fail(`retention or refund words: ${res.reply}`);
            }
            return { ...res, billing, calls };
          };
          if (s.kind === "ask") {
            const a = await say(s.text);
            if (!a.billing) fail(`${JSON.stringify(s.text)} not answered by billing (${a.intent}, model calls ${a.calls}): ${a.reply.slice(0, 160)}`);
            const fam = s.family;
            if (fam === "card" && row?.stripe_customer_id && sc.mode === "ok" && !a.reply.includes(PORTAL(row.stripe_customer_id))) fail(`no billing page: ${a.reply}`);
            if (fam === "card" && !/Never send card details in chat/.test(a.reply)) fail(`card details not kept out of chat: ${a.reply}`);
            if (fam === "subscribe" && (!row || !LIVE.includes(row.status) || sc.rowKind === "ended") && !a.reply.includes(PAY_BY_CHECKOUT)) fail(`how to pay not said: ${a.reply}`);
            if (fam === "price" && row?.status === "trialing" && /You're paying/.test(a.reply)) fail(`a trial said as paying: ${a.reply}`);
            if (fam === "price" && sc.rowKind === "eur" && !/EUR\/month/.test(a.reply)) fail(`EUR not said: ${a.reply}`);
            if (fam === "price" && sc.rowKind === "discounted" && !/before a discount/.test(a.reply)) fail(`discount not said: ${a.reply}`);
            if (["price", "pause", "charges"].includes(fam) && sc.rowKind === "two_live" && sc.mode === "ok" && !/2 live Trainee subscriptions/.test(a.reply)) fail(`two live not said: ${a.reply}`);
            if ((fam === "cancel" || fam === "cancel_now") && cancellableR2(row) && !/Reply "yes" to cancel\.$/.test(a.reply)) fail(`no exact confirmation: ${a.reply}`);
            if (fake.calls.some((c) => c.method !== "GET" && c.path !== "/v1/billing_portal/sessions")) fail(`${fam} changed something at Stripe`);
          } else if (s.kind === "lang_cancel") {
            const a = await say(s.text);
            if (!a.billing) fail(`a cancel in another language not answered by billing: ${JSON.stringify(s.text)} -> ${a.intent}`);
            const b = await say(s.answer);
            const sub = truthR2(row, id)[0] ? fake.subs.get(truthR2(row, id)[0].id) : null;
            if (s.yes && cancellableR2(row)) {
              if (sub?.cancel_at_period_end !== true || !/^Done, your plan is cancelled/.test(b.reply)) fail(`${JSON.stringify(s.answer)} did not cancel: ${b.reply}`);
              const flag = await fast.sql(`select cancel_at_period_end::text || '|' || (stripe_synced_at is not null)::text from public.user_subscriptions where user_id = '${id}'`);
              if (flag !== "true|true") fail(`the row after the cancel: ${flag} (want ending, synced)`);
            } else {
              if (fake.calls.some((c) => c.method === "POST")) fail(`${JSON.stringify(s.answer)} reached Stripe`);
              if (cancellableR2(row) && !b.billing) fail(`${JSON.stringify(s.answer)} to a waiting cancel left to the rest of the chat (${b.intent})`);
            }
          } else if (s.kind === "not_billing") {
            const a = await say(s.text);
            if (a.billing) fail(`a look-alike taken by billing: ${JSON.stringify(s.text)} -> ${a.reply.slice(0, 120)}`);
            if (fake.calls.length) fail(`a look-alike reached Stripe`);
          } else if (s.kind === "stale_answer") {
            const a = await say(s.ask);
            if (cancellableR2(row)) {
              if (!/Reply "yes" to cancel\.$/.test(a.reply)) fail(`no confirmation: ${a.reply}`);
              const sub = fake.subs.get(truthR2(row, id)[0].id)!;
              sub.current_period_end += 30 * 86400;
              await fast.sql(`update public.user_subscriptions set current_period_end = ${lit(new Date(sub.current_period_end * 1000).toISOString())} where user_id = '${id}'`);
              const b = await say(s.answer);
              if (fake.calls.some((c) => c.method === "POST")) fail(`a yes to a changed plan reached Stripe: ${b.reply}`);
              if (!/changed since I asked/.test(b.reply)) fail(`the change not said: ${b.reply}`);
            }
          }
          counts.text++;
        }
        // Sanity: the fake model is reachable, so a zero above is the billing turn's own.
        const c = h!.chat(`tok-b2-${TEXT.length + 1}`);
        const before = wire.model;
        await fast.sql(`delete from public.agent_rate_limits`);
        await c.say("what should I focus on this week in my job search?");
        counts.modelSanity = wire.model - before;
        if (!counts.modelSanity) failures.push("A: the staged brain never called the fake model, so the zero-calls check proves nothing");
      });
      Deno.env.delete("CAREER_BRAIN"); Deno.env.delete("ANTHROPIC_API_KEY"); Deno.env.delete("CAREER_MODEL");

      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { global: { fetch: h!.double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
      const read = async (u: string) => {
        const out = await fast.sql(`select coalesce((select json_build_object('status', status, 'plan', plan, 'price_cents', price_cents, 'current_period_end', current_period_end, 'stripe_customer_id', stripe_customer_id,
          'stripe_subscription_id', stripe_subscription_id, 'cancel_at_period_end', cancel_at_period_end, 'currency', currency, 'discounted', discounted, 'live_subscriptions', live_subscriptions)::text
          from public.user_subscriptions where user_id = '${u}'), 'null')`);
        return JSON.parse(out);
      };
      const addProfile = async (u: string) => { await fast.sql(`insert into auth.users (id, email) values ('${u}', '${u}@example.test') on conflict do nothing; insert into public.profiles (id) values ('${u}') on conflict do nothing;`); };

      await t.step(`B. webhook: ${HOOKS.length} sampled scenarios through the webhook handler, written by billing_sync_subscription (13 arguments)`, async () => {
        const base = supabaseWebhookStore(admin);
        let credited = 0;
        const store = { ...base, creditReferrer: async (u: string) => { credited++; await base.creditReferrer(u); } };
        for (const sc of HOOKS) {
          const fake = new FakeStripeR2();
          cur.fake = fake;
          const clock = { t: NOW };
          const stripe = webhookStripe(fake.fetch, STRIPE_KEY_R2, { timeoutMs: 50 });
          credited = 0;
          const res = await playWebhookR2(sc, {
            store, fake, clock,
            deliver: (req) => handleStripeWebhook(req, { secret: WEBHOOK_SECRET_R2, stripe, store, now: () => clock.t }),
            read, addProfile,
            deleteProfile: async (u) => { await fast.sql(`delete from public.profiles where id = '${u}'; delete from auth.users where id = '${u}';`); },
            referrerCredits: () => credited,
          });
          failures.push(...res.fails.map((f) => `B ${f}`));
          counts.hooks++;
          counts.deliveries += res.deliveries;
        }
      });

      await t.step("C. the chat's cancel and a slower webhook: an older read written later is refused; a later read is written", async () => {
        Deno.env.set("STRIPE_SECRET_KEY", STRIPE_KEY_R2);
        for (const [k, older] of [[0, true], [1, false], [2, true], [3, false]] as const) {
          const i = TEXT.length + 2 + k, id = uidOf(i), chat = h!.chat(`tok-b2-${i}`);
          const fail = (m: string) => failures.push(`C${k} ${m}`);
          const fake = new FakeStripeR2();
          cur.fake = fake;
          const row = shiftRow(rowR2(rng(k), "active", 99000 + k))!;
          for (const x of truthR2(row, id)) fake.subs.set(x.id, x);
          fake.customers.set(row.stripe_customer_id!, { id: row.stripe_customer_id!, metadata: { supabase_user_id: id } });
          await insertRow(id, row);
          await fast.sql(`update public.user_subscriptions set stripe_synced_at = now() - interval '1 hour' where user_id = '${id}'`);
          const sub = fake.subs.get(row.stripe_subscription_id!)!;
          const base = supabaseWebhookStore(admin);
          let release!: () => void, reached!: () => void;
          const gate = new Promise<void>((r) => release = r), atStore = new Promise<void>((r) => reached = r);
          // The webhook reads Stripe (not yet cancelled) before the chat's cancel and writes after it (older = true); or reads after.
          const store = { ...base, sync: async (r: SyncRow) => { if (older) { reached(); await gate; } return await base.sync(r); } };
          const readAt = Date.now() - (older ? 5_000 : -5_000);
          const stripe = webhookStripe(fake.fetch, STRIPE_KEY_R2, { timeoutMs: 50 });
          const ev = JSON.stringify({ id: `evt_c${k}`, object: "event", type: "customer.subscription.updated", created: Math.floor(NOW / 1000), data: { object: fake.subJson(sub) } });
          const sig = async () => `t=${Math.floor(readAt / 1000)},v1=${await stripeSignature(WEBHOOK_SECRET_R2, Math.floor(readAt / 1000), ev)}`;
          let hook: Promise<Response> | null = null;
          if (older) {
            hook = handleStripeWebhook(new Request("https://p.test/stripe-webhook", { method: "POST", headers: { "stripe-signature": await sig() }, body: ev }), { secret: WEBHOOK_SECRET_R2, stripe, store, now: () => readAt });
            await atStore;
          }
          await fast.sql(`delete from public.agent_rate_limits`);
          await chat.say("cancel my plan");
          const yes = await chat.say("yes");
          if (!/^Done, your plan is cancelled/.test(yes.reply)) fail(`the cancel: ${yes.reply}`);
          if (older) { release(); const r = await hook!; await r.body?.cancel().catch(() => {}); }
          else {
            const r = await handleStripeWebhook(new Request("https://p.test/stripe-webhook", { method: "POST", headers: { "stripe-signature": await sig() }, body: ev }), { secret: WEBHOOK_SECRET_R2, stripe, store, now: () => readAt });
            await r.body?.cancel().catch(() => {});
          }
          const got = await read(id);
          if (got?.cancel_at_period_end !== true) fail(`${older ? "an older webhook read put back" : "a later webhook read lost"} the cancel: row ${JSON.stringify(got)} (Stripe: ${sub.cancel_at_period_end})`);
          counts.stale++;
        }
        Deno.env.delete("STRIPE_SECRET_KEY");
      });

      await t.step("D. account deletion's billing step over the double and FakeStripeR2: a live plan cancelled first, else nothing deleted", async () => {
        const cases = [["active", "ok"], ["two_live", "ok"], ["trialing", "ok"], ["canceled", "ok"], ["none", "ok"], ["active", "5xx"], ["active", "no_key"], ["ending", "ok"]] as const;
        for (const [k, [kind, fault]] of cases.entries()) {
          const i = TEXT.length + 10 + k, id = uidOf(i);
          const fail = (m: string) => failures.push(`D${k} [${kind}/${fault}] ${m}`);
          const fake = new FakeStripeR2();
          cur.fake = fake;
          const row = shiftRow(rowR2(rng(50 + k), kind, 99500 + k));
          for (const x of truthR2(row, id)) fake.subs.set(x.id, x);
          if (row) await insertRow(id, row);
          if (fault === "5xx") fake.mode = "5xx";
          const deps = restDeps(SUPABASE_URL, SERVICE_KEY, h!.double.fetch as typeof fetch, { billing: { stripeKey: fault === "no_key" ? null : STRIPE_KEY_R2, fetch: fake.fetch } });
          const out = await deps.endBilling!(id);
          const liveLeft = [...fake.subs.values()].filter((x) => LIVE.includes(x.status)).length;
          const live = !!row && LIVE.includes(row.status);
          const want = !live ? "none" : fault === "ok" ? "cancelled" : "failed";
          if (out !== want) fail(`endBilling ${out}, want ${want}`);
          if (want === "cancelled" && liveLeft) fail(`${liveLeft} live subscription(s) left at Stripe`);
          if (want === "none" && fake.calls.length) fail("Stripe reached with no live plan");
          if (fake.calls.some((c) => c.method === "POST")) fail("a refund or another change at Stripe");
          counts.deletes++;
        }
      });

      await t.step("nothing left the machine (no real model, no Stripe); no secret in a log; in time", () => {
        const secs = (Date.now() - started) / 1000;
        for (const l of logged) if (l.includes(STRIPE_KEY_R2) || l.includes(WEBHOOK_SECRET_R2) || l.includes(MODEL_KEY)) { failures.push(`a secret in a log line`); break; }
        realLog.log(`flow-scenarios-billing-r2: A ${counts.text} text scenarios / ${counts.turns} handler turns (model calls on billing turns: ${counts.modelOnBilling}; sanity non-billing turn: ${counts.modelSanity}), B ${counts.hooks} webhook scenarios / ${counts.deliveries} deliveries, C ${counts.stale}, D ${counts.deletes}; ${counts.text + counts.hooks + counts.stale + counts.deletes} flows in ${secs.toFixed(1)} s; refused: ${outbound.join("; ") || "none"}`);
        if (outbound.length) failures.push(`outbound requests: ${outbound.join(", ")}`);
        if (secs > 300) failures.push(`took ${secs.toFixed(0)} s`);
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
void ASKS_R2; void invoicesR2;
