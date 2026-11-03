// Billing and cancel-by-text, ROUND 2 (battery 2026-10-30): 10,000 generated scenarios (tests/architect/scenarios/
// billing-r2-generator.ts, seeded), pure, on a fixed clock (NOW), with FakeStripeR2 at the HTTP boundary (the product's own
// adapters call it). Round 1 (scenarios-billing-cancel.test.ts, scenarios-billing-research.test.ts) is not repeated; the
// sampled run through the real handlers on real Postgres is flow-scenarios-billing-r2.test.ts.
//
// TEXT, 6,000 (career_billing.ts billingTurn, the thread's last word kept as the handler keeps it):
//   - every ask with an answer in the records is answered by code (model calls: 0): cancel in six languages, "cancel it
//     now", "cancel my trial", "stop paying", "pause my plan", "downgrade", "switch to annual", "why was I charged twice",
//     "update my card", "how much do I pay", "how do I subscribe", "refund me", "was I refunded", trial, discount, currency,
//     access after a lapse; look-alikes ("pause my alerts", "cancelar mi solicitud", "update my resume") are not billing;
//   - no amount, date, plan, refund or dispute is said unless the row or Stripe's records hold it; a refund is never promised;
//     a trial is never "you're paying"; past_due and unpaid never promise a next charge; a discount is never stated as the
//     charge; a EUR or JPY price is said in its currency; two live subscriptions are said;
//   - "update my card" is Stripe's billing page as Stripe returned it, and no card number is ever asked for or said;
//   - a cancel only on a clear English yes to the exact confirmation (as every approval: "sí", "oui", "ja" approve
//     nothing); "no" in any of the languages, or a plan that changed at Stripe since the ask, changes nothing; Stripe is
//     reached only for that cancel or the page.
// WEBHOOK, 3,000 (stripe_webhook.ts with the store's semantics = billing_sync_subscription, which the flow run checks on
// Postgres): trials, double checkouts on one customer and on two, coupons, currencies, prorated plan changes, dunning to
// the end, refund and dispute events, schedules, customer.deleted, unknown events, a deleted account; delivered in order,
// reversed, shuffled, duplicated at once, replayed; signatures with several v1 values, v0, spaces, the 300 s edges (and
// refused at 301 s, wrong v1s only, a non-number t, upper-case hex, an empty v1). After every step the row is Stripe's
// truth: the newest live subscription, how many are live, its currency and discount; the referrer is credited only for
// money actually paid; the webhook never changes anything at Stripe.
// ACCOUNT DELETION, 1,000 (account_delete.ts restDeps over a fake project and FakeStripeR2): a live plan (or two) is
// cancelled at Stripe before anything is deleted, and when Stripe does not confirm it nothing is deleted and the person is
// told why; no plan, no Stripe call.
// No model, Stripe or network call: every boundary is a fake.
import assertNode from "node:assert/strict";
import {
  ASKS_R2, cancellableR2, deleteScenarios, FakeStripeR2, FOREIGN_YES, type InvoiceR2, NOT_BILLING_R2, NOW, PORTAL, rng, STRIPE_KEY_R2, type SubR2, textScenariosR2, truthR2,
  webhookScenariosR2, WEBHOOK_SECRET_R2,
} from "./scenarios/billing-r2-generator.ts";
import { factsR2, MemStoreR2, playWebhookR2 } from "./scenarios/billing-r2-play.ts";
import { REFUND_PROMISE, RETENTION } from "./scenarios/billing-check.ts";
import { LINK } from "./scenarios/research-check.ts";
import {
  BILLING_CANCEL_INTENT, billingAsk, type BillingStore, billingTurn, PAY_BY_CHECKOUT, stripeFromEnv, type Subscription,
} from "../../supabase/functions/_shared/career_billing.ts";
import { deleteAccount, deletionWords, restDeps } from "../../supabase/functions/_shared/account_delete.ts";

const TEXT_COUNT = 6000, WEBHOOK_COUNT = 3000, DELETE_COUNT = 1000;
type Turn = Awaited<ReturnType<typeof billingTurn>>;
const LIVE = ["active", "trialing", "past_due", "unpaid"];

// ================================================================================================ text world
function textWorld(row: Subscription | null, inv: InvoiceR2[], userId = "5e7a1c00-0000-4000-8000-0000000b2001") {
  const fake = new FakeStripeR2();
  const truth = truthR2(row, userId);
  for (const s of truth) fake.subs.set(s.id, s);
  if (row?.stripe_customer_id) fake.customers.set(row.stripe_customer_id, { id: row.stripe_customer_id, metadata: { supabase_user_id: userId } });
  fake.invoices = inv;
  const state = { row: row ? { ...row } : null as Subscription | null, last: null as Record<string, unknown> | null, marked: 0 };
  const store: BillingStore = {
    subscription: async () => state.row ? { ...state.row } : null,
    lastMeta: async () => state.last,
    markCancelling: async (_u, id) => { state.marked++; if (state.row?.stripe_subscription_id === id) state.row = { ...state.row, cancel_at_period_end: true }; },
    markKept: async (_u, id) => { if (state.row?.stripe_subscription_id === id) state.row = { ...state.row, cancel_at_period_end: false }; },
  };
  const stripe = stripeFromEnv(fake.fetch, STRIPE_KEY_R2, { timeoutMs: 50 });
  const say = async (message: string) => {
    const r = await billingTurn({ message, userId, threadId: "t-r2", now: NOW, store, stripe });
    state.last = r ? { intent: r.intent, ...(r.meta ?? {}) } : null;
    return r;
  };
  return { fake, state, truth, say };
}

Deno.test(`billing r2 phrasings: every ask with an answer in the records is billing's (no model), each look-alike is not (${Object.values(ASKS_R2).flat().length} asks, ${NOT_BILLING_R2.length} look-alikes, x10 variants)`, () => {
  const r = rng(2026103002);
  const fails: string[] = [];
  const vary = (s: string) => {
    let t = s;
    const c = r.next();
    if (c < 0.2) t = t.toUpperCase(); else if (c < 0.45) t = t.charAt(0).toUpperCase() + t.slice(1);
    const p = r.next();
    if (p < 0.2) t = `${t}?`; else if (p < 0.35) t = `${t}.`; else if (p < 0.4) t = `${t}!`;
    if (r.next() < 0.1) t = `hey ${t}`;
    return t;
  };
  for (const [family, list] of Object.entries(ASKS_R2)) for (const a of list) for (let i = 0; i < 10; i++) {
    const t = i === 0 ? a : vary(a);
    const got = billingAsk(t);
    const want = family === "cancel_now" ? "cancel" : family;
    if (got?.kind !== want) fails.push(`${JSON.stringify(t)}: want ${want}, got ${got?.kind ?? null}`);
    if (family === "cancel_now" && got?.now !== true) fails.push(`${JSON.stringify(t)}: "now" not read`);
  }
  for (const a of NOT_BILLING_R2) for (let i = 0; i < 10; i++) {
    const t = i === 0 ? a : vary(a);
    const got = billingAsk(t);
    if (got) fails.push(`a look-alike read as ${got.kind}: ${JSON.stringify(t)}`);
  }
  if (fails.length) throw new Error(`${fails.length} misread:\n${[...new Set(fails)].slice(0, 80).join("\n")}`);
});

const TEXT = textScenariosR2(20261030, TEXT_COUNT);
Deno.test({
  name: `billing r2 by text at scale: ${TEXT_COUNT} scenarios (row states x asks x languages x invoices x Stripe faults, fixed clock): answered by code, facts only from the records, the card page from Stripe, cancel only on a clear yes`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const logs: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    const fails: string[] = [];
    const tally: Record<string, number> = {};
    let turns = 0, modelCalls = 0;
    try {
      for (const sc of TEXT) {
        const w = textWorld(sc.row, sc.invoices);
        w.fake.mode = sc.mode;
        const s = sc.script;
        const name = `#${sc.id} [${sc.rowKind}/${sc.mode}/${s.kind}${s.kind === "ask" ? `:${s.family}` : ""}]`;
        const fail = (m: string) => fails.push(`${name} ${m}`);
        const row = sc.row;
        const links = new Set<string>([...sc.invoices.map((i) => i.url!).filter(Boolean), ...(row?.stripe_customer_id ? [PORTAL(row.stripe_customer_id)] : [])]);
        const check = (said: string, r: Turn) => {
          if (!r) return;
          const bad = factsR2(r.reply, w.state.row ?? row, sc.invoices, links, w.truth.map((t) => t.current_period_end));
          if (bad) fail(`${JSON.stringify(said)}: ${bad}: ${r.reply}`);
          const plain = r.reply.replace(/ before a discount/g, "").replace(/A discount applies[^.]*\./g, "");
          if (RETENTION.test(plain)) fail(`retention words: ${r.reply}`);
          if (REFUND_PROMISE.test(r.reply)) fail(`a refund promised: ${r.reply}`);
          if (/\d{12,19}/.test(r.reply.replace(LINK, " ").replace(/[ -]/g, ""))) fail(`a card-number-length run of digits: ${r.reply}`);
          if (/refunded/.test(r.reply) && !sc.invoices.some((i) => (i.charge?.refunded ?? 0) > 0)) fail(`a refund Stripe never recorded: ${r.reply}`);
          if (/disputed/.test(r.reply) && !sc.invoices.some((i) => i.charge?.disputed)) fail(`a dispute Stripe never recorded: ${r.reply}`);
          if (r.reply.includes(STRIPE_KEY_R2)) fail("the key in a reply");
          const st = row?.status ?? "none";
          if (/You're paying/.test(r.reply) && ["trialing", "past_due", "unpaid", "canceled", "incomplete", "none"].includes(st)) fail(`"you're paying" on a ${st} plan: ${r.reply}`);
          if (/Next charge/i.test(r.reply) && !(st === "active" && row?.cancel_at_period_end !== true)) fail(`a next charge promised on a ${st}${row?.cancel_at_period_end ? " ending" : ""} plan: ${r.reply}`);
          if (row?.discounted && /\$\d+(?:\.\d\d)?\/month/.test(r.reply) && !/before a discount|A discount applies/.test(r.reply) && !/^This cancels/.test(r.reply)) fail(`a discounted plan's list price said as the charge: ${r.reply}`);
          if (row && row.currency && row.currency !== "usd" && typeof row.price_cents === "number" && /\$\d/.test(r.reply) && !/Trainee is \$10\/month/.test(r.reply)) fail(`a ${row.currency} price said in dollars: ${r.reply}`);
        };
        const say = async (m: string) => { const r = await w.say(m); turns++; check(m, r); return r; };
        const posts = () => w.fake.calls.filter((c) => c.method !== "GET");
        const subPosts = () => w.fake.calls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/subscriptions/"));
        const live2 = (row?.live_subscriptions ?? 1) > 1 && LIVE.includes(row?.status ?? "");
        tally[s.kind] = (tally[s.kind] ?? 0) + 1;
        if (s.kind === "ask") {
          tally[`ask:${s.family}`] = (tally[`ask:${s.family}`] ?? 0) + 1;
          const r = await say(s.text);
          if (!r) { modelCalls++; fail(`left to the model: ${JSON.stringify(s.text)}`); continue; }
          const fam = s.family;
          const reached = ["card", "charges", "refund_status"].includes(fam) && !!row?.stripe_customer_id;
          if (!reached && fam !== "cancel" && fam !== "cancel_now" && w.fake.calls.length) fail(`${fam} reached Stripe: ${w.fake.calls.map((c) => c.path).join(", ")}`);
          if (posts().filter((c) => c.path !== "/v1/billing_portal/sessions").length) fail(`${fam} changed something at Stripe`);
          if (fam === "card") {
            if (row?.stripe_customer_id && sc.mode === "ok" && !r.reply.includes(PORTAL(row.stripe_customer_id))) fail(`no billing page from Stripe: ${r.reply}`);
            if (row?.stripe_customer_id && sc.mode !== "ok" && /https:/.test(r.reply)) fail(`a link with Stripe unreachable: ${r.reply}`);
            if (!row?.stripe_customer_id && (/https:/.test(r.reply) || !/no card on file/.test(r.reply))) fail(`no subscription not said: ${r.reply}`);
            if (!/Never send card details in chat/.test(r.reply)) fail(`card details not kept out of chat: ${r.reply}`);
          } else if (fam === "charges" || fam === "refund_status") {
            if (!row?.stripe_customer_id) { if (!/no Trainee billing on file/.test(r.reply)) fail(`no billing not said: ${r.reply}`); }
            else if (sc.mode !== "ok") { if (!/couldn't reach billing/.test(r.reply) || /\d+\.\d\d|\$\d/.test(r.reply)) fail(`Stripe down not said honestly: ${r.reply}`); }
            else {
              if (fam === "charges") {
                const n = Math.min(5, sc.invoices.length);
                if (n && !r.reply.includes(n === 1 ? "this payment" : `these ${n} payments`)) fail(`the payments Stripe records not listed (${n}): ${r.reply}`);
                if (!n && !/no paid invoices/.test(r.reply)) fail(`no payments not said: ${r.reply}`);
                if (live2 && !/2 live Trainee subscriptions/.test(r.reply)) fail(`two live subscriptions not said: ${r.reply}`);
              }
              if (fam === "refund_status") {
                const any = sc.invoices.slice(0, 5).some((i) => (i.charge?.refunded ?? 0) > 0 || i.charge?.disputed);
                if (any !== /^Stripe records:/.test(r.reply)) fail(`refund status not as Stripe records it (any=${any}): ${r.reply}`);
              }
              if (!/can't issue or promise a refund/.test(r.reply)) fail(`refund not said plainly: ${r.reply}`);
            }
          } else if (fam === "refund") {
            if (!/can't issue or promise a refund/.test(r.reply)) fail(`refund: ${r.reply}`);
          } else if (fam === "subscribe") {
            // A plan cancelled at period end whose end has passed is over: the person is told how to subscribe again.
            const subscribed = row && LIVE.includes(row.status) && !(row.cancel_at_period_end && row.current_period_end && Date.parse(row.current_period_end) <= NOW);
            if (subscribed && !/already subscribed/.test(r.reply)) fail(`a live plan told to subscribe: ${r.reply}`);
            if (!subscribed && !(r.reply.includes(PAY_BY_CHECKOUT) && r.reply.includes("$10/month"))) fail(`how to subscribe not said: ${r.reply}`);
          } else if (fam === "pause" || fam === "change_plan") {
            if (!/nothing changed/.test(r.reply)) fail(`${fam}: not said that nothing changed: ${r.reply}`);
            if (live2 && !/2 live Trainee subscriptions/.test(r.reply)) fail(`two live subscriptions not said: ${r.reply}`);
          } else if (fam === "price") {
            if (row?.status === "trialing" && !/free trial/.test(r.reply)) fail(`a trial not said: ${r.reply}`);
            if (row?.status === "past_due" && row.cancel_at_period_end !== true && !/past due/.test(r.reply)) fail(`past due not said: ${r.reply}`);
            if (row?.status === "unpaid" && !/unpaid/.test(r.reply)) fail(`unpaid not said: ${r.reply}`);
            if ((row?.status === "canceled" || sc.rowKind === "ended") && !/delete your account/.test(r.reply)) fail(`what a lapsed plan keeps not said: ${r.reply}`);
            if (sc.rowKind === "eur" && !/\d+\.\d\d EUR\/month/.test(r.reply)) fail(`a EUR price not said in EUR: ${r.reply}`);
            if (sc.rowKind === "jpy" && !/1500 JPY\/month/.test(r.reply)) fail(`a JPY price not said in JPY: ${r.reply}`);
            if (sc.rowKind === "discounted" && !/before a discount/.test(r.reply)) fail(`a discount not said: ${r.reply}`);
            if (live2 && !/2 live Trainee subscriptions/.test(r.reply)) fail(`two live subscriptions not said: ${r.reply}`);
          } else if (fam === "cancel" || fam === "cancel_now") {
            if (cancellableR2(row)) {
              if (r.intent !== BILLING_CANCEL_INTENT || !/This cancels your Trainee plan/.test(r.reply) || !/Reply "yes" to cancel\.$/.test(r.reply)) fail(`no exact confirmation: ${r.reply}`);
              if (fam === "cancel_now" && !/can't end it immediately/.test(r.reply)) fail(`"now" not answered plainly: ${r.reply}`);
              if (live2 && !/this cancels only the newest one/.test(r.reply)) fail(`two live subscriptions not said: ${r.reply}`);
            } else if (r.meta) fail(`an ask with nothing to cancel: ${r.reply}`);
            if (subPosts().length) fail("the ask itself reached Stripe");
          }
        } else if (s.kind === "lang_cancel") {
          const a = await say(s.text);
          if (!a) { modelCalls++; fail(`a cancel in another language left to the model: ${JSON.stringify(s.text)}`); continue; }
          const b = await say(s.answer);
          const sub = w.truth[0] ? w.fake.subs.get(w.truth[0].id)! : null;
          const want = s.yes && cancellableR2(row);
          if (want) {
            if (sub?.cancel_at_period_end !== true || !/^Done, your plan is cancelled/.test(b?.reply ?? "")) fail(`a clear ${JSON.stringify(s.answer)} did not cancel: ${b?.reply}`);
            if (subPosts().filter((c) => !c.replayed).length !== 1) fail(`cancel applied ${subPosts().length} times`);
          } else {
            if (subPosts().length) fail(`${JSON.stringify(s.answer)} reached Stripe`);
            if (sub && sub.cancel_at_period_end !== (row?.cancel_at_period_end === true)) fail(`the plan changed without a yes`);
            // A yes in another language approves nothing, and the person is told to answer "yes" (no model, the ask kept).
            if (FOREIGN_YES.includes(s.answer) && cancellableR2(row) && !/Say "yes" to cancel/.test(b?.reply ?? "")) fail(`a "${s.answer}" not answered: ${b?.reply}`);
          }
        } else if (s.kind === "not_billing") {
          const r = await w.say(s.text);
          turns++;
          if (r) fail(`a look-alike answered by billing: ${JSON.stringify(s.text)} -> ${r.reply}`);
          if (w.fake.calls.length) fail(`a look-alike reached Stripe: ${JSON.stringify(s.text)}`);
        } else if (s.kind === "stale_answer") {
          const a = await say(s.ask);
          if (!cancellableR2(row)) continue;
          if (a?.intent !== BILLING_CANCEL_INTENT) { fail(`no confirmation: ${a?.reply}`); continue; }
          // The plan renewed at Stripe (the webhook wrote it) between the ask and the yes.
          const sub = w.fake.subs.get(w.truth[0].id)!;
          sub.current_period_end += 30 * 86400;
          w.state.row = { ...w.state.row!, current_period_end: new Date(sub.current_period_end * 1000).toISOString() };
          const b = await w.say(s.answer);
          turns++;
          if (subPosts().length) fail(`a yes to a changed plan reached Stripe: ${b?.reply}`);
          if (!/changed since I asked/.test(b?.reply ?? "")) fail(`a changed plan not said: ${b?.reply}`);
        }
      }
    } finally {
      Object.assign(console, orig);
    }
    for (const l of logs) if (l.includes(STRIPE_KEY_R2)) { fails.push(`the key in a log line`); break; }
    console.log(`[billing r2 text] ${TEXT.length} scenarios, ${turns} turns, model calls ${modelCalls}; ${Object.entries(tally).sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (fails.length) throw new Error(`${fails.length} billing r2 text failures:\n${[...new Set(fails)].slice(0, 80).join("\n")}`);
    assertNode.equal(modelCalls, 0, "billing turns with an answer in the records never call the model");
  },
});

const WEBHOOK = webhookScenariosR2(20261032, WEBHOOK_COUNT);
Deno.test({
  name: `stripe webhook r2 at scale: ${WEBHOOK_COUNT} scenarios (trials, double checkouts, coupons, currencies, dunning, refunds, schedules, deleted customers and accounts x delivery x signatures): the row is Stripe's truth after every step`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const logs: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    const fails: string[] = [];
    const tally: Record<string, number> = {};
    let deliveries = 0;
    try {
      for (const sc of WEBHOOK) {
        const store = new MemStoreR2();
        const fake = new FakeStripeR2();
        const clock = { t: NOW };
        const res = await playWebhookR2(sc, {
          store, fake, clock,
          read: async (u) => { const r = store.rows.get(u); return r ? { ...r } as any : null; },
          addProfile: async (u) => { store.profiles.add(u); },
          deleteProfile: async (u) => { store.deleteProfile(u); },
          referrerCredits: () => store.referrerCredited,
          addReferral: async () => {},
        });
        fails.push(...res.fails);
        deliveries += res.deliveries;
        for (const [k, v] of Object.entries(res.tally)) tally[k] = (tally[k] ?? 0) + v;
        tally[`flow:${sc.steps.join(">")}`] = (tally[`flow:${sc.steps.join(">")}`] ?? 0) + 1;
        for (const [k, v] of Object.entries(res.statuses)) tally[`http:${k}`] = (tally[`http:${k}`] ?? 0) + v;
      }
    } finally {
      Object.assign(console, orig);
    }
    for (const l of logs) if (l.includes(STRIPE_KEY_R2) || l.includes(WEBHOOK_SECRET_R2)) { fails.push(`a secret in a log line: ${l.slice(0, 160)}`); break; }
    console.log(`[billing r2 webhook] ${WEBHOOK.length} scenarios, ${deliveries} deliveries; ${Object.entries(tally).filter(([k]) => !k.startsWith("flow:")).sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (fails.length) throw new Error(`${fails.length} webhook r2 failures:\n${[...new Set(fails)].slice(0, 80).join("\n")}`);
    assertNode.ok((tally["http:400"] ?? 0) > 0 && (tally["ignored:no_user"] ?? 0) > 0, "refusals and a deleted account exercised");
  },
});

// ================================================================================================ account deletion
// A fake project: the REST paths restDeps calls, with the person's subscription row; the auth user is deleted for real here.
function project(row: Record<string, unknown> | null, o: { unreadable?: boolean }) {
  const st = { userDeleted: false, deletes: 0, calls: [] as string[] };
  const f = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    st.calls.push(`${req.method} ${u.pathname}`);
    const j = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/rest/v1/user_subscriptions") return o.unreadable ? j({ message: "boom" }, 500) : j(row ? [row] : []);
    if (u.pathname.startsWith("/auth/v1/admin/users/")) {
      if (req.method === "DELETE") { st.userDeleted = true; st.deletes++; return j({}); }
      return st.userDeleted ? j({}, 404) : j({ id: "x" });
    }
    if (u.pathname.startsWith("/rest/v1/rpc/oauth_vault_read")) return j(null);
    if (u.pathname.startsWith("/rest/v1/rpc/")) return j(null);
    if (u.pathname === "/storage/v1/object/list/career-resumes") return j([]);
    if (req.method === "GET") return j([]);
    return j(null, req.method === "DELETE" ? 200 : 201);
  }) as typeof fetch;
  return { f, st };
}
const DELETES = deleteScenarios(20261033, DELETE_COUNT);
Deno.test({
  name: `account deletion with a plan at scale: ${DELETE_COUNT} scenarios (no plan, live, trial, past due, ending, two live, already cancelled or missing at Stripe x Stripe faults): a live plan is cancelled at Stripe first, or nothing is deleted`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fails: string[] = [];
    const tally: Record<string, number> = {};
    for (const sc of DELETES) {
      const name = `#${sc.id} [${sc.kind}/${sc.fault}]`;
      const fail = (m: string) => fails.push(`${name} ${m}`);
      const fake = new FakeStripeR2();
      const cus = `cus_del_${sc.id}`, sid = `sub_del_${sc.id}`;
      const status = sc.kind === "none" ? null : sc.kind === "canceled" ? "canceled" : sc.kind === "trialing" ? "trialing" : sc.kind === "past_due" ? "past_due" : "active";
      const row = status ? { status, stripe_subscription_id: sid, stripe_customer_id: cus } : null;
      const mk = (id: string, st: string, created: number): SubR2 => ({ id, customer: cus, status: st, cancel_at_period_end: sc.kind === "ending", cancel_at: null, current_period_start: created,
        current_period_end: created + 30 * 86400, created, metadata: { supabase_user_id: sc.user }, price: { unit_amount: 1000, currency: "usd", interval: "month" }, quantity: 1 });
      if (status && sc.kind !== "missing_at_stripe") fake.subs.set(sid, mk(sid, sc.kind === "already_canceled_at_stripe" ? "canceled" : status, 1_790_000_000));
      if (sc.kind === "two_live") fake.subs.set(`${sid}_older`, mk(`${sid}_older`, "active", 1_789_000_000));
      // Someone else's live plan under another customer: never touched.
      fake.subs.set(`sub_other_${sc.id}`, { ...mk(`sub_other_${sc.id}`, "active", 1_790_000_000), customer: `cus_other_${sc.id}`, metadata: { supabase_user_id: "someone-else" } });
      const liveBefore = [...fake.subs.values()].filter((s) => s.metadata.supabase_user_id === sc.user && LIVE.includes(s.status)).map((s) => s.id);
      const needs = !!row && LIVE.includes(row.status);
      if (sc.fault === "5xx" || sc.fault === "timeout") fake.mode = sc.fault;
      const p = project(row, { unreadable: sc.fault === "row_unreadable" });
      const deps = restDeps("http://project.test", "service-key", p.f, { sleep: async () => {}, billing: { stripeKey: sc.fault === "no_key" ? null : STRIPE_KEY_R2, fetch: fake.fetch } });
      const res = await deleteAccount(deps, sc.user);
      const words = deletionWords(res);
      const liveAfter = [...fake.subs.values()].filter((s) => s.metadata.supabase_user_id === sc.user && LIVE.includes(s.status)).map((s) => s.id);
      const blocked = sc.fault === "row_unreadable" || (needs && sc.fault !== "ok");
      tally[blocked ? "blocked" : res.billing ?? "?"] = (tally[blocked ? "blocked" : res.billing ?? "?"] ?? 0) + 1;
      if (blocked) {
        if (res.deleted || p.st.deletes) fail(`deleted although the plan could not be confirmed cancelled: ${words}`);
        if (!/was not deleted/.test(words) || !/still live at Stripe|couldn't confirm cancelling/.test(words)) fail(`not told why: ${words}`);
        if (p.st.calls.some((c) => c.startsWith("DELETE"))) fail(`something was deleted before billing was settled: ${p.st.calls.filter((c) => c.startsWith("DELETE")).join(", ")}`);
      } else {
        if (!res.deleted) fail(`not deleted: ${words}`);
        if (liveAfter.length) fail(`still charged after the account is gone: ${liveAfter.join(", ")}`);
        if (liveBefore.length && !/Your Trainee plan is cancelled at Stripe/.test(words)) fail(`the plan's end not said: ${words}`);
        if (/plan is cancelled at Stripe/.test(words) && ![...fake.subs.values()].some((s) => s.metadata.supabase_user_id === sc.user && s.status === "canceled")) fail(`a cancel said with none at Stripe: ${words}`);
        if (!needs && fake.calls.length) fail(`Stripe reached with no live plan: ${fake.calls.map((c) => `${c.method} ${c.path}`).join(", ")}`);
      }
      if (fake.subs.get(`sub_other_${sc.id}`)!.status !== "active") fail("someone else's plan cancelled");
      if (fake.calls.some((c) => c.method === "POST")) fail("a refund or another change at Stripe");
      if (REFUND_PROMISE.test(words)) fail(`a refund promised: ${words}`);
    }
    console.log(`[billing r2 delete] ${DELETES.length} scenarios; ${Object.entries(tally).sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (fails.length) throw new Error(`${fails.length} deletion failures:\n${[...new Set(fails)].slice(0, 60).join("\n")}`);
  },
});
