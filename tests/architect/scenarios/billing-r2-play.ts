// Plays a round-2 webhook scenario (billing-r2-generator.ts) against stripe-webhook's handler: Stripe's truth changes step
// by step (trials, double checkouts, coupons, currencies, dunning, refunds, schedules, a deleted customer, a deleted
// account), each change makes the events Stripe sends, delivered as the scenario says, with the scenario's signature
// header; after every step the person's row is checked against what Stripe holds for them. Shared by the pure battery
// (scenarios-billing-r2.test.ts, with MemStoreR2) and the Postgres run (flow-scenarios-billing-r2.test.ts, the product's store).
import { FakeStripeR2, NOW, rng, type Step, type SubR2, STRIPE_KEY_R2, type WebhookScenarioR2, WEBHOOK_SECRET_R2 } from "./billing-r2-generator.ts";
import { MemStore } from "./billing-webhook-play.ts";
import { fmtDay } from "./billing-check.ts";
import { LINK } from "./research-check.ts";
import type { InvoiceR2 } from "./billing-r2-generator.ts";
import { PLAN_PRICE_CENTS, type Subscription } from "../../../supabase/functions/_shared/career_billing.ts";
import { handleStripeWebhook, stripeSignature, type SyncRow, type WebhookStore, webhookStripe } from "../../../supabase/functions/_shared/stripe_webhook.ts";

const LIVE = ["active", "trialing", "past_due", "unpaid"];

// ================================================================================================ the facts check
const fmtMoney = (minor: number, currency: string) => {
  const c = currency.toLowerCase();
  const zero = ["jpy", "krw", "vnd"].includes(c);
  return zero ? [String(minor)] : [(minor / 100).toFixed(2), minor % 100 ? (minor / 100).toFixed(2) : String(minor / 100)];
};
// Every number, date and link in a billing reply comes from the row, from Stripe's records, or is the plan's public price.
export function factsR2(reply: string, row: Subscription | null, inv: InvoiceR2[], links: Set<string>, stripeEnds: number[] = []): string | null {
  if (/Invalid Date|NaN|undefined|\bnull\b|\[object/.test(reply)) return "a broken value in the reply";
  for (const u of (reply.match(LINK) ?? []).map((x) => x.replace(/[.,;:!?)]+$/, ""))) if (!links.has(u)) return `a link Stripe did not return: ${u}`;
  let rest = reply.replace(LINK, " ");
  const dates = new Set<string>(), nums = new Set<string>([String(PLAN_PRICE_CENTS / 100)]);
  if (row?.current_period_end && Number.isFinite(Date.parse(row.current_period_end))) dates.add(fmtDay(Date.parse(row.current_period_end)));
  for (const e of stripeEnds) dates.add(fmtDay(e * 1000)); // the period end Stripe answered a cancel with
  if (typeof row?.price_cents === "number") for (const v of fmtMoney(row.price_cents, row.currency ?? "usd")) nums.add(v);
  if (typeof row?.live_subscriptions === "number") nums.add(String(row.live_subscriptions));
  for (const i of inv) {
    dates.add(fmtDay(i.created * 1000));
    for (const v of fmtMoney(i.amount_paid, i.currency)) nums.add(v);
    if (i.charge?.refunded) for (const v of fmtMoney(i.charge.refunded, i.currency)) nums.add(v);
  }
  for (const m of rest.match(/\b[A-Z][a-z]{2} \d{1,2}, \d{4}\b/g) ?? []) if (!dates.has(m)) return `a date not in the row or Stripe's records: ${m}`;
  for (const d of dates) rest = rest.split(d).join(" ");
  rest = rest.replace(/\b(?:last|these) [1-5] payments\b/g, " ");
  for (const m of rest.match(/\d+(?:[.,]\d+)*/g) ?? []) if (!nums.has(m)) return `a number not in the row or Stripe's records: ${m}`;
  return null;
}


// The store with billing_sync_subscription's semantics, plus the row read and a person's deletion (the flow run uses the
// real function and table).
export class MemStoreR2 extends MemStore {
  async current(userId: string) { const r = this.rows.get(userId); return r ? { ...r } as any : null; }
  deleteProfile(userId: string) { this.profiles.delete(userId); this.rows.delete(userId); }
}

// The header Stripe would send, in the scenario's valid shape, or one that must be refused.
export async function headerR2(body: string, nowMs: number, sc: Pick<WebhookScenarioR2, "sig" | "bad">, which: "valid" | "bad"): Promise<string> {
  const t = Math.floor(nowMs / 1000);
  const sign = (ts: number) => stripeSignature(WEBHOOK_SECRET_R2, ts, body);
  const wrong = async (n: number) => await stripeSignature(`${WEBHOOK_SECRET_R2}x${n}`, t, body);
  if (which === "valid") {
    switch (sc.sig) {
      case "plain": return `t=${t},v1=${await sign(t)}`;
      case "many_v1_first": return `t=${t},v1=${await sign(t)},v1=${await wrong(1)},v1=${await wrong(2)}`;
      case "many_v1_last": return `t=${t},v1=${await wrong(1)},v1=${await wrong(2)},v1=${await sign(t)}`;
      case "v1_and_v0": return `t=${t},v0=${await wrong(3)},v1=${await sign(t)}`;
      case "edge_past": return `t=${t - 300},v1=${await sign(t - 300)}`;
      case "edge_future": return `t=${t + 300},v1=${await sign(t + 300)}`;
      case "spaces": return `t=${t}, v1=${await sign(t)}`;
    }
  }
  switch (sc.bad) {
    case "past_301": return `t=${t - 301},v1=${await sign(t - 301)}`;
    case "future_301": return `t=${t + 301},v1=${await sign(t + 301)}`;
    case "only_wrong_v1s": return `t=${t},v1=${await wrong(1)},v1=${await wrong(2)},v0=${await sign(t)}`;
    case "t_not_number": return `t=${t}abc,v1=${await sign(t)}`;
    case "v1_upper_hex": return `t=${t},v1=${(await sign(t)).toUpperCase()}`;
    case "empty_v1": return `t=${t},v1=`;
    default: return `t=${t},v1=${await sign(t)}`;
  }
}

// The row Stripe's truth says the person should have: the newest live subscription of theirs (created, then id), else the
// newest; and how many are live. Written independently of the product's choose().
export function expectedRow(fake: FakeStripeR2, user: string): { sub: SubR2; live: number } | null {
  const mine = [...fake.subs.values()].filter((s) => s.metadata.supabase_user_id === user) as SubR2[];
  if (!mine.length) return null;
  const order = (a: SubR2, b: SubR2) => b.created - a.created || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0);
  const live = mine.filter((s) => LIVE.includes(s.status)).sort(order);
  return { sub: live[0] ?? [...mine].sort(order)[0], live: live.length };
}

export interface RunR2 { fails: string[]; deliveries: number; statuses: Record<number, number>; tally: Record<string, number> }
export async function playWebhookR2(sc: WebhookScenarioR2, o: {
  store: WebhookStore; fake: FakeStripeR2; clock: { t: number }; deliver?: (req: Request) => Promise<Response>;
  read: (user: string) => Promise<Record<string, unknown> | null>; addProfile: (user: string) => Promise<void>; deleteProfile: (user: string) => Promise<void>;
  referrerCredits: () => number; addReferral?: (user: string) => Promise<void>;
}): Promise<RunR2> {
  const fails: string[] = [];
  const tally: Record<string, number> = {};
  const name = `#${sc.id} [${sc.steps.join(">")}/${sc.delivery}/${sc.sig}/${sc.bad}]`;
  const fail = (m: string) => fails.push(`${name} ${m}`);
  const statuses: Record<number, number> = {};
  const r = rng(sc.id * 104729 + 7);
  const { fake, clock } = o;
  const tick = (ms = 1000) => (clock.t += ms);
  const stripe = webhookStripe(fake.fetch, STRIPE_KEY_R2, { timeoutMs: 50 });
  const deliver = o.deliver ?? ((req: Request) => handleStripeWebhook(req, { secret: WEBHOOK_SECRET_R2, stripe, store: o.store, now: () => clock.t }));
  const user = sc.user, cusA = sc.customer, cusB = `${sc.customer}_b`;
  await o.addProfile(user);
  await o.addProfile(sc.other);
  if (sc.credits && o.addReferral) await o.addReferral(user);
  fake.customers.set(cusA, { id: cusA, metadata: { supabase_user_id: user } });
  // Stripe's search lags a minute: a subscription created in the last 60 s is found only through its customer.
  fake.searchLagSec = 60;
  let n = 0, evn = 0, accountGone = false, paidSoFar = false;
  const subs: SubR2[] = [];
  const newSub = (customer: string, status: string, trialDays = 0): SubR2 => {
    n++;
    const start = Math.floor(clock.t / 1000);
    const s: SubR2 = { id: `sub_w2_${sc.id}_${n}`, customer, status, cancel_at_period_end: false, cancel_at: null, current_period_start: start,
      current_period_end: start + (trialDays || 30) * 86400, created: start, metadata: { supabase_user_id: user }, price: { unit_amount: 1000, currency: "usd", interval: "month" },
      quantity: 1, discount: false, trial_end: trialDays ? start + trialDays * 86400 : null, schedule: null };
    fake.subs.set(s.id, s);
    subs.push(s);
    return s;
  };
  const liveOnes = () => subs.filter((s) => LIVE.includes(s.status)).sort((a, b) => b.created - a.created || (b.id > a.id ? 1 : -1));
  const current = () => liveOnes()[0] ?? subs[subs.length - 1];
  type Ev = { body: string; paid: boolean };
  const ev = (type: string, object: Record<string, unknown>, paid = false): Ev => {
    evn++;
    return { body: JSON.stringify({ id: `evt_w2_${sc.id}_${evn}`, object: "event", type, created: Math.floor(clock.t / 1000), data: { object } }), paid };
  };
  const subObj = (s: SubR2) => fake.subJson(s);
  const inv = (type: string, s: SubR2, amount: number) => ev(type, { id: `in_w2_${sc.id}_${evn + 1}`, object: "invoice", subscription: s.id, customer: s.customer, amount_paid: type === "invoice.payment_failed" ? 0 : amount, currency: s.price?.currency ?? "usd" }, type !== "invoice.payment_failed" && amount > 0);
  const checkout = (s: SubR2, amount: number) => ev("checkout.session.completed", { id: `cs_w2_${sc.id}_${evn + 1}`, object: "checkout.session", subscription: s.id, customer: s.customer,
    payment_status: amount > 0 ? "paid" : "no_payment_required", amount_total: amount, metadata: { supabase_user_id: user } }, amount > 0);
  const all: Ev[] = [];
  for (const [i, step] of sc.steps.entries()) {
    tick(90_000); // each step at least 90 s after the last, so the search has caught up with what came before
    fake.searchNowSec = Math.floor(clock.t / 1000);
    const out: Ev[] = [];
    const cur = current();
    switch (step as Step) {
      case "checkout": { const s = newSub(cusA, "active"); out.push(checkout(s, 1000), ev("customer.subscription.created", subObj(s)), inv("invoice.paid", s, 1000)); break; }
      case "checkout_trial": { const s = newSub(cusA, "trialing", 14); out.push(checkout(s, 0), ev("customer.subscription.created", subObj(s)), inv("invoice.paid", s, 0)); break; }
      case "trial_converts": { cur.status = "active"; cur.trial_end = cur.trial_end; cur.current_period_start = cur.current_period_end; cur.current_period_end += 30 * 86400; out.push(ev("customer.subscription.updated", subObj(cur)), inv("invoice.paid", cur, 1000)); break; }
      case "double_checkout": { tick(); const s = newSub(cusA, "active"); out.push(checkout(s, 1000), ev("customer.subscription.created", subObj(s)), inv("invoice.paid", s, 1000)); break; }
      case "second_customer_checkout": {
        tick();
        fake.customers.set(cusB, { id: cusB, metadata: { supabase_user_id: user } });
        const s = newSub(cusB, "active"); out.push(checkout(s, 1000), ev("customer.subscription.created", subObj(s)), inv("invoice.paid", s, 1000)); break;
      }
      case "cancel_newest_now": case "cancel_older_now": {
        const live = liveOnes();
        const s = step === "cancel_newest_now" ? live[0] : live[live.length - 1];
        if (s) { s.status = "canceled"; s.cancel_at_period_end = false; s.cancel_at = null; out.push(ev("customer.subscription.deleted", subObj(s))); }
        break;
      }
      case "coupon_on": case "coupon_off": cur.discount = step === "coupon_on"; out.push(ev("customer.subscription.updated", subObj(cur))); break;
      case "to_yearly_prorated": cur.price = { unit_amount: 10000, currency: "usd", interval: "year" }; out.push(ev("customer.subscription.updated", subObj(cur)), inv("invoice.paid", cur, 9032)); break;
      case "to_eur": cur.price = { unit_amount: 900, currency: "eur", interval: "month" }; out.push(ev("customer.subscription.updated", subObj(cur))); break;
      case "to_jpy": cur.price = { unit_amount: 1500, currency: "jpy", interval: "month" }; out.push(ev("customer.subscription.updated", subObj(cur))); break;
      case "payment_failed": cur.status = "past_due"; out.push(inv("invoice.payment_failed", cur, 1000), ev("customer.subscription.updated", subObj(cur))); break;
      case "retry_succeeds": cur.status = "active"; out.push(inv("invoice.paid", cur, 1000), ev("customer.subscription.updated", subObj(cur))); break;
      case "dunning_unpaid": cur.status = "unpaid"; out.push(ev("customer.subscription.updated", subObj(cur))); break;
      case "dunning_canceled": cur.status = "canceled"; out.push(ev("customer.subscription.deleted", subObj(cur))); break;
      case "refund_event": out.push(ev("charge.refunded", { id: `ch_w2_${sc.id}`, object: "charge", customer: cur.customer, amount_refunded: 1000, refunded: true })); break;
      case "dispute_event": out.push(ev("charge.dispute.created", { id: `dp_w2_${sc.id}`, object: "dispute", charge: `ch_w2_${sc.id}`, amount: 1000 })); break;
      case "schedule_update": cur.schedule = `sub_sched_${sc.id}`; cur.price = { unit_amount: 1500, currency: "usd", interval: "month" }; out.push(ev("subscription_schedule.updated", { id: cur.schedule, object: "subscription_schedule", subscription: cur.id, customer: cur.customer })); break;
      case "schedule_release": out.push(ev("subscription_schedule.released", { id: cur.schedule, object: "subscription_schedule", subscription: cur.id, customer: cur.customer })); cur.schedule = null; break;
      case "customer_deleted": {
        for (const s of subs.filter((x) => x.customer === cusA && LIVE.includes(x.status))) { s.status = "canceled"; s.cancel_at_period_end = false; s.cancel_at = null; }
        fake.customers.set(cusA, { id: cusA, metadata: {}, deleted: true });
        out.push(ev("customer.deleted", { id: cusA, object: "customer", deleted: true }));
        break;
      }
      case "unknown_events":
        out.push(ev("product.created", { id: "prod_x", object: "product" }), ev("payment_intent.succeeded", { id: "pi_x", object: "payment_intent", customer: cur.customer }),
          ev("radar.early_fraud_warning.created", { id: "issfr_x" }), ev("totally.unknown.type", { id: "x_1" }), ev("customer.updated", { id: cur.customer, object: "customer" }));
        break;
      case "cancel_at_end": cur.cancel_at_period_end = true; cur.cancel_at = cur.current_period_end; out.push(ev("customer.subscription.updated", subObj(cur))); break;
      case "account_deleted": {
        await o.deleteProfile(user);
        accountGone = true;
        cur.current_period_start = cur.current_period_end; cur.current_period_end += 30 * 86400;
        out.push(ev("customer.subscription.updated", subObj(cur)), inv("invoice.paid", cur, 1000));
        break;
      }
    }
    all.push(...out);
    const beforeRow = JSON.stringify(await o.read(user));
    const creditsBefore = o.referrerCredits();
    const send = async (e: Ev, which: "valid" | "bad" = "valid") => {
      const header = await headerR2(e.body, clock.t, sc, which);
      const res = await deliver(new Request("https://project.functions.test/stripe-webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: e.body }));
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      const j = await res.json().catch(() => ({}));
      if (j?.ignored) tally[`ignored:${j.ignored}`] = (tally[`ignored:${j.ignored}`] ?? 0) + 1;
      return res.status;
    };
    // A bad signature first: refused, nothing changes.
    if (sc.bad !== "none" && out.length && i === 0) {
      const st = await send(out[0], "bad");
      if (st !== 400) fail(`bad signature (${sc.bad}) answered ${st}`);
      if (await o.read(user) !== null && i === 0) fail(`bad signature (${sc.bad}) wrote a row`);
    }
    const order = sc.delivery === "reversed" ? [...out].reverse() : sc.delivery === "shuffled" ? [...out].sort(() => r.next() - 0.5) : out;
    if (sc.delivery === "duplicated") {
      for (const e of order) { const [a, b] = await Promise.all([send(e), send(e)]); if (a !== 200 || b !== 200) fail(`duplicate delivery answered ${a}/${b}`); }
    } else for (const e of order) { const st = await send(e); if (st !== 200) fail(`${step}: delivery answered ${st}`); }
    if (out.some((e) => e.paid)) paidSoFar = true;
    // ---- after the step
    if (accountGone) {
      if (await o.read(user) !== null) fail(`${step}: a row for a deleted account`);
      if (o.referrerCredits() !== creditsBefore) fail(`${step}: a referral credited for a deleted account`);
      continue;
    }
    if (step === "refund_event" || step === "dispute_event" || step === "unknown_events") {
      if (JSON.stringify(await o.read(user)) !== beforeRow) fail(`${step}: the row changed on an event that changes no subscription`);
    }
    await same(`after ${step}`);
    if (!paidSoFar && o.referrerCredits() > 0) fail(`${step}: the referrer credited before any money was paid (a $0 trial or checkout)`);
  }
  // Old events replayed at the end change nothing.
  if (sc.delivery === "replayed" && !accountGone) {
    for (let k = 0; k < 4 && all.length; k++) { tick(); const e = all[Math.floor(r.next() * all.length)]; if (await send2(e) !== 200) fail("replay not 200"); }
    await same("after replays");
  }
  if (sc.credits && !accountGone && paidSoFar && o.referrerCredits() === 0) fail("money was paid and the referrer was never credited");
  // Stripe calls: only reads, the key, the pinned version.
  for (const c of fake.calls) {
    if (c.auth !== `Bearer ${STRIPE_KEY_R2}` || c.version !== "2023-10-16") fail(`a Stripe call without the key or version: ${c.path}`);
    if (c.method !== "GET") fail(`the webhook changed something at Stripe: ${c.method} ${c.path}`);
  }
  return { fails, deliveries: Object.values(statuses).reduce((a, b) => a + b, 0), statuses, tally };

  async function send2(e: Ev) {
    const header = await headerR2(e.body, clock.t, sc, "valid");
    const res = await deliver(new Request("https://project.functions.test/stripe-webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: e.body }));
    await res.body?.cancel().catch(() => {});
    return res.status;
  }
  async function same(when: string) {
    const want = expectedRow(fake, user);
    const got = await o.read(user);
    if (!want) { if (got) fail(`${when}: a row with no subscription at Stripe`); return; }
    if (!got) { fail(`${when}: no row (Stripe: ${want.sub.id} ${want.sub.status})`); return; }
    // None live: the subscription already on the row is kept, as Stripe has it now (any of the person's, all ended).
    const shown = want.live === 0 ? (fake.subs.get(String(got.stripe_subscription_id)) as SubR2 | undefined) ?? want.sub : want.sub;
    if (want.live === 0 && shown.metadata.supabase_user_id !== user) fail(`${when}: the row shows a subscription that is not the person's`);
    // What Stripe holds, written here from the fake's own record (not from the product's rowFrom): the price only for one
    // item of a monthly or yearly price, in that price's currency.
    const p = shown.price;
    const price = p && shown.quantity === 1 && (p.interval_count ?? 1) === 1 && ["month", "year"].includes(p.interval) ? p.unit_amount : null;
    const ending = shown.cancel_at_period_end || (shown.cancel_at !== null && shown.cancel_at <= shown.current_period_end);
    const checks: [string, unknown, unknown][] = [
      ["stripe_subscription_id", got.stripe_subscription_id, shown.id], ["status", got.status, shown.status],
      ["cancel_at_period_end", got.cancel_at_period_end, ending], ["price_cents", got.price_cents, price],
      ["current_period_end", got.current_period_end ? Date.parse(String(got.current_period_end)) : null, shown.current_period_end * 1000],
      ["currency", got.price_cents === null ? null : got.currency, price === null ? null : p!.currency], ["discounted", got.discounted === true, shown.discount === true],
      ["live_subscriptions", got.live_subscriptions, want.live],
    ];
    for (const [k, a, b] of checks) if (a !== b) fail(`${when}: row ${k} ${JSON.stringify(a)}, Stripe says ${JSON.stringify(b)}`);
  }
}
export { NOW };
export type { SyncRow };
