// Billing and cancel-by-text, ROUND 2 (battery 2026-10-30), seeded and deterministic: a failure names its input and every
// run is the same run. Synthetic only: no real person, key, card, Stripe account or event. Round 1 is billing-generator.ts
// (cancel/undo/confirm, webhook order and signatures, card details in chat) and billing-research-generator.ts (prices,
// receipts, Stripe faults); this round adds, without repeating them:
//   MONEY    trials, coupons and discounts, annual vs monthly, prices in EUR and JPY, a failed payment then a retry
//            (past_due -> active), dunning to the end (unpaid, canceled), refunds and disputes Stripe records on a charge,
//            two live subscriptions at once (a double checkout);
//   ACCESS   a lapsed or ending plan: what the person still has, exactly when access stops, account deletion with a live plan;
//   TEXT     cancel in Spanish, French, German, Italian, Portuguese and Dutch (confirmed only by an English "yes", as every
//            approval is; a "sí"/"oui"/"ja" approves nothing, a "non"/"nein" drops the ask),
//            "pause my plan", "downgrade", "switch to annual", "refund me", "was I refunded", "why was I charged twice",
//            "update my card", "how much do I pay", "how do I subscribe", "cancel it now", and each by a person with no
//            subscription; look-alikes that are not billing ("pause my alerts", "cancelar mi solicitud", "update my resume");
//   WEBHOOK  several v1 values in the signature, the timestamp tolerance at its edges, unknown event types, an event for a
//            deleted account, customer.deleted, invoice.paid / payment_failed in any order, subscription_schedule events,
//            refund and dispute events, referral credit only for money actually paid;
//   BUDGET   every billing ask with a deterministic answer is answered by code: the model is never called.
// FakeStripeR2 extends round 1's FakeStripe (idempotency replays, faults) with discounts, currencies, trials, invoices with
// their charge (refunds, disputes), the customer's subscription list, the billing portal and an immediate cancel.
import { rng, type R } from "../scenarios-fixture.ts";
import { FakeStripe, type FakeSub } from "./billing-generator.ts";
import type { Subscription } from "../../../supabase/functions/_shared/career_billing.ts";

export { rng };
const pick = <T>(r: R, xs: readonly T[]): T => r.pick(xs);

export const NOW = Date.UTC(2026, 9, 30, 12, 0, 0); // the battery's clock
const DAY = 86_400;
// Fake, and assembled at run time so no key-shaped literal sits in the repository (secret scanning).
export const STRIPE_KEY_R2 = ["sk", "test", "billingRoundTwoKEY0000000NOTREAL"].join("_");
export const WEBHOOK_SECRET_R2 = ["whsec", "billingRoundTwoSECRET00000NOTREAL"].join("_");
export const PORTAL = (c: string) => `https://billing.stripe.com/p/session/test_r2_${c}`;

// ================================================================================================ Stripe at the HTTP boundary
export type SubR2 = FakeSub & { discount?: boolean; trial_end?: number | null; schedule?: string | null };
export interface ChargeR2 { refunded: number; disputed: boolean }
export interface InvoiceR2 { id: string; customer: string; subscription: string; created: number; amount_paid: number; currency: string; url: string | null; charge: ChargeR2 | null }
export class FakeStripeR2 extends FakeStripe {
  invoices: InvoiceR2[] = [];
  deleted: string[] = [];
  portals: string[] = [];
  constructor() {
    super(STRIPE_KEY_R2);
    const base = this.fetch;
    this.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      const url = new URL(req.url);
      const p = url.pathname;
      const extra = req.method === "DELETE" || p === "/v1/billing_portal/sessions" || p === "/v1/invoices";
      if (!extra) return await base(req);
      // The same front door as round 1 (key, faults), then the endpoints this round adds.
      const call = { method: req.method, path: p + url.search, body: req.method === "POST" ? await req.clone().text() : "", idem: req.headers.get("idempotency-key"),
        auth: req.headers.get("authorization"), version: req.headers.get("stripe-version"), replayed: false, status: 0 };
      this.calls.push(call);
      const json = (v: unknown, status = 200) => { call.status = status; return new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } }); };
      if (url.host !== "api.stripe.com") throw new TypeError(`fake Stripe: not Stripe: ${url.host}`);
      if (call.auth !== `Bearer ${STRIPE_KEY_R2}`) return json({ error: { message: "Invalid API Key provided" } }, 401);
      if (this.mode === "timeout") { call.status = -1; throw new DOMException("Signal timed out.", "TimeoutError"); }
      if (this.mode === "5xx") return json({ error: { message: "api error" } }, 500);
      if (this.mode === "401") return json({ error: { message: "Invalid API Key provided" } }, 401);
      if (this.mode === "malformed") { call.status = 200; return new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }); }
      if (p === "/v1/invoices") {
        const c = url.searchParams.get("customer");
        const expand = url.searchParams.getAll("expand[]").includes("data.charge");
        const list = this.invoices.filter((i) => i.customer === c).sort((a, b) => b.created - a.created).slice(0, Number(url.searchParams.get("limit") ?? 10));
        return json({ object: "list", data: list.map((i) => ({ id: i.id, object: "invoice", status: "paid", customer: i.customer, subscription: i.subscription, created: i.created,
          amount_paid: i.amount_paid, currency: i.currency, hosted_invoice_url: i.url,
          charge: i.charge ? (expand ? { id: `ch_${i.id}`, object: "charge", amount_refunded: i.charge.refunded, refunded: i.charge.refunded >= i.amount_paid, disputed: i.charge.disputed } : `ch_${i.id}`) : null })) });
      }
      if (p === "/v1/billing_portal/sessions" && req.method === "POST") {
        const c = new URLSearchParams(call.body).get("customer") ?? "";
        if (!this.customers.has(c) && ![...this.subs.values()].some((s) => s.customer === c)) return json({ error: { type: "invalid_request_error", code: "resource_missing" } }, 404);
        this.portals.push(c);
        return json({ id: `bps_${this.portals.length}`, object: "billing_portal.session", customer: c, url: PORTAL(c) });
      }
      const m = /^\/v1\/subscriptions\/([^/]+)$/.exec(p);
      if (m && req.method === "DELETE") {
        const s = this.subs.get(decodeURIComponent(m[1]));
        if (!s) return json({ error: { type: "invalid_request_error", code: "resource_missing" } }, 404);
        if (s.status === "canceled") return json({ error: { type: "invalid_request_error", message: "already canceled" } }, 400);
        s.status = "canceled"; s.cancel_at_period_end = false; s.cancel_at = null;
        this.deleted.push(s.id);
        return json(this.subJson(s));
      }
      return json({ error: { type: "invalid_request_error" } }, 404);
    }) as typeof fetch;
  }
  override subJson(s: FakeSub) {
    const x = s as SubR2;
    const j: any = super.subJson(s);
    j.discount = x.discount ? { id: `di_${s.id}`, object: "discount", coupon: { id: "TWENTY", percent_off: 20 } } : null;
    j.trial_end = x.trial_end ?? null;
    j.schedule = x.schedule ?? null;
    return j;
  }
}

// ================================================================================================ TEXT
export type RowKindR2 = "none" | "active" | "trialing" | "trial_no_end" | "past_due" | "unpaid" | "canceled" | "incomplete" | "ending" | "ending_past_due"
  | "ended" | "discounted" | "eur" | "jpy" | "yearly" | "two_live" | "customer_only";
export const ROW_KINDS_R2: RowKindR2[] = ["none", "active", "trialing", "trial_no_end", "past_due", "unpaid", "canceled", "incomplete", "ending", "ending_past_due",
  "ended", "discounted", "eur", "jpy", "yearly", "two_live", "customer_only"];
export const FUTURE_ENDS = ["2026-11-27T15:00:00.000Z", "2026-12-31T23:30:00.000Z", "2027-10-30T12:00:00.000Z", "2026-11-05T12:00:00.000Z"];
export const PAST_ENDS = ["2026-10-01T15:00:00.000Z", "2026-10-30T11:59:59.000Z"];
export function rowR2(r: R, kind: RowKindR2, n: number): Subscription | null {
  if (kind === "none") return null;
  const base: Subscription = {
    status: "active", plan: "monthly", price_cents: 1000, current_period_start: "2026-10-27T15:00:00.000Z", current_period_end: pick(r, FUTURE_ENDS),
    stripe_customer_id: `cus_r2_${n}`, stripe_subscription_id: `sub_r2_${n}`, cancel_at_period_end: false, currency: "usd", discounted: false, live_subscriptions: 1,
  };
  switch (kind) {
    case "active": return base;
    case "trialing": return { ...base, status: "trialing" };
    case "trial_no_end": return { ...base, status: "trialing", current_period_end: null };
    case "past_due": case "unpaid": return { ...base, status: kind };
    case "canceled": return { ...base, status: "canceled", live_subscriptions: 0 };
    case "incomplete": return { ...base, status: "incomplete", live_subscriptions: 0 };
    case "ending": return { ...base, cancel_at_period_end: true };
    case "ending_past_due": return { ...base, status: "past_due", cancel_at_period_end: true };
    case "ended": return { ...base, cancel_at_period_end: true, current_period_end: pick(r, PAST_ENDS) };
    case "discounted": return { ...base, discounted: true };
    case "eur": return { ...base, currency: "eur", price_cents: pick(r, [900, 1250]) };
    case "jpy": return { ...base, currency: "jpy", price_cents: 1500 };
    case "yearly": return { ...base, plan: "yearly", price_cents: 10000 };
    case "two_live": return { ...base, live_subscriptions: 2 };
    case "customer_only": return { ...base, status: "incomplete", stripe_subscription_id: null, live_subscriptions: 0 };
  }
}
export const isLiveRow = (s: Subscription | null) => !!s && ["active", "trialing", "past_due", "unpaid"].includes(s.status);
export const cancellableR2 = (s: Subscription | null) => !!s?.stripe_subscription_id && isLiveRow(s) && s.cancel_at_period_end !== true;
export function invoicesR2(r: R, row: Subscription | null, n: number): InvoiceR2[] {
  if (!row?.stripe_customer_id) return [];
  const kind = pick(r, ["none", "one", "two_same_period", "refunded", "partial_refund", "disputed", "several"] as const);
  const cur = row.currency ?? "usd", amt = row.price_cents ?? 1000;
  const mk = (i: number, created: number, ch: ChargeR2 | null = { refunded: 0, disputed: false }): InvoiceR2 => ({
    id: `in_r2_${n}_${i}`, customer: row.stripe_customer_id!, subscription: row.stripe_subscription_id ?? `sub_r2_${n}`, created, amount_paid: amt, currency: cur,
    url: `https://invoice.stripe.com/i/acct_R2/test_${n}_${i}`, charge: ch,
  });
  const t = Math.floor(NOW / 1000);
  switch (kind) {
    case "none": return [];
    case "one": return [mk(0, t - 3 * DAY)];
    case "two_same_period": return [mk(0, t - 3 * DAY), mk(1, t - 3 * DAY + 40)];
    case "refunded": return [mk(0, t - 33 * DAY), mk(1, t - 3 * DAY, { refunded: amt, disputed: false })];
    case "partial_refund": return [mk(0, t - 3 * DAY, { refunded: Math.floor(amt / 2), disputed: false })];
    case "disputed": return [mk(0, t - 3 * DAY, { refunded: 0, disputed: true })];
    case "several": return [0, 1, 2, 3, 4, 5].map((i) => mk(i, t - (3 + 30 * i) * DAY, i === 2 ? null : { refunded: 0, disputed: false }));
  }
}

// What each ask must be read as (the deterministic kind); billing answers it, the model is never called.
export const ASKS_R2: Record<string, string[]> = {
  cancel: [
    "cancela mi suscripción", "cancelar mi suscripcion", "quiero cancelar mi plan", "cancelar mi membresía", "darme de baja de trainee",
    "annuler mon abonnement", "je veux résilier mon abonnement", "résilier l'abonnement",
    "abo kündigen", "mein abo kündigen", "ich möchte mein abonnement kündigen", "kündige mein abo",
    "cancella il mio abbonamento", "voglio disdire l'abbonamento",
    "cancelar minha assinatura", "quero cancelar o meu plano",
    "mijn abonnement opzeggen", "ik wil mijn abonnement opzeggen",
    "cancel my trial", "end my free trial", "stop paying", "i want to stop paying for trainee",
  ],
  cancel_now: ["cancel my plan immediately", "cancel my subscription right now", "cancel my plan today", "end my subscription immediately", "cancel my plan and refund me"],
  pause: ["pause my plan", "pause my subscription", "can i pause my subscription", "freeze my membership", "put my plan on hold", "suspend my subscription for a month", "is there a way to pause my plan"],
  change_plan: ["downgrade", "downgrade my plan", "upgrade my plan", "switch to annual", "switch to yearly billing", "change my plan to monthly", "downgrade to the free plan", "do you have a student plan", "is there a cheaper plan"],
  charges: ["why was i charged twice", "i was charged twice", "double charged", "why did you charge me", "i see two charges on my card", "what is this charge", "why was i billed this month", "duplicate charge"],
  card: ["update my card", "change my credit card", "update my payment method", "how do i update my card", "my card was declined", "my card expired", "why did my payment fail", "manage my subscription", "billing portal", "update billing info"],
  subscribe: ["how do i subscribe", "how do i pay", "subscribe", "subscribe me", "how can i pay for trainee", "i want to subscribe", "where do i pay"],
  refund: ["refund me", "i want a refund", "can i get a refund for last month", "give me my money back", "do you offer refunds"],
  refund_status: ["was i refunded", "did i get my refund", "where is my refund", "did you refund me", "has my refund been processed", "i disputed the charge", "chargeback"],
  price: ["how much do i pay", "how much will i be charged next month", "am i on a trial", "when does my trial end", "do i have a discount", "what currency am i paying in",
    "is my plan past due", "do i still have access", "can i still use trainee", "what happens when my plan ends", "what is my next payment"],
};
// Not billing: no billing reply, nothing asked or waiting, Stripe never called.
export const NOT_BILLING_R2 = [
  "pause my alerts", "pause my job search", "pause the job alerts", "pause my account", "cancelar mi solicitud a Acme", "annuler l'entretien", "annuler ma candidature",
  "mijn sollicitatie intrekken", "update my resume", "change my email", "update my linkedin", "subscribe to job alerts", "subscribe me to alerts", "how do i apply",
  "upgrade my resume", "switch to remote jobs", "change my location", "what can i still do to get this job", "why was i rejected", "double check my resume",
  "is the job paid", "how much does the job pay", "how much do i pay in taxes as an intern", "refund policy at acme", "cancel my interview", "card", "my card",
  "stop", "cancel", "si", "oui", "ja", "update my cover letter", "manage my applications", "show my applications",
];
export const YES_R2 = ["yes", "Yes", "yep", "yes please", "\u{1F44D}"];
// The approval words stay English (owner rule; tests/architect/scenarios-approvals.test.ts): these approve nothing.
export const FOREIGN_YES = ["sí", "si", "oui", "ja", "sim", "Sí"];
export const NO_R2 = ["no", "non", "nein", "não", "nee", "nope"];
export function varyR2(r: R, s: string): string {
  let t = s;
  const c = r.next();
  if (c < 0.12) t = t.toUpperCase();
  else if (c < 0.35) t = t.charAt(0).toUpperCase() + t.slice(1);
  const p = r.next();
  if (p < 0.15) t = `${t}?`; else if (p < 0.25) t = `${t}.`; else if (p < 0.3) t = `${t}!`;
  if (r.next() < 0.05) t = `hey ${t}`;
  if (r.next() < 0.05) t = t.replace(/'/g, "’");
  return t;
}

export type Mode = "ok" | "5xx" | "timeout" | "401" | "malformed";
export type TextScriptR2 =
  | { kind: "ask"; family: string; text: string }                                   // one ask, answered from the row or Stripe
  | { kind: "lang_cancel"; text: string; answer: string; yes: boolean }             // a cancel in another language, answered
  | { kind: "not_billing"; text: string }                                           // a look-alike: never billing
  | { kind: "stale_answer"; ask: string; answer: string };                          // the plan changed at Stripe between ask and yes
export interface TextScenarioR2 { id: number; rowKind: RowKindR2; row: Subscription | null; invoices: InvoiceR2[]; mode: Mode; script: TextScriptR2 }
export function textScenariosR2(seed: number, count: number): TextScenarioR2[] {
  const r = rng(seed);
  const fams = Object.keys(ASKS_R2);
  const out: TextScenarioR2[] = [];
  for (let id = 0; id < count; id++) {
    const rowKind = ROW_KINDS_R2[id % ROW_KINDS_R2.length];
    const row = rowR2(r, rowKind, id);
    const inv = invoicesR2(r, row, id);
    const mode: Mode = r.next() < 0.8 ? "ok" : pick(r, ["5xx", "timeout", "401", "malformed"] as const);
    const s = r.next();
    let script: TextScriptR2;
    if (s < 0.62) { const family = pick(r, fams); script = { kind: "ask", family, text: varyR2(r, pick(r, ASKS_R2[family])) }; }
    else if (s < 0.8) {
      const c = r.next();
      const [answer, yes] = c < 0.5 ? [pick(r, YES_R2), true] : c < 0.75 ? [pick(r, FOREIGN_YES), false] : [pick(r, NO_R2), false];
      script = { kind: "lang_cancel", text: varyR2(r, pick(r, ASKS_R2.cancel.slice(0, 18))), answer, yes };
    }
    else if (s < 0.94) script = { kind: "not_billing", text: varyR2(r, pick(r, NOT_BILLING_R2)) };
    else script = { kind: "stale_answer", ask: pick(r, ASKS_R2.cancel), answer: pick(r, YES_R2) };
    out.push({ id, rowKind, row, invoices: inv, mode: script.kind === "lang_cancel" || script.kind === "stale_answer" ? "ok" : mode, script });
  }
  return out;
}
// The Stripe subscription(s) behind a row (same ids, period end, price, discount; a second live one for two_live).
export function truthR2(row: Subscription | null, userId: string): SubR2[] {
  if (!row?.stripe_subscription_id || !row.stripe_customer_id) return [];
  const end = row.current_period_end ? Math.floor(Date.parse(row.current_period_end) / 1000) : Math.floor(NOW / 1000) + 20 * DAY;
  const one: SubR2 = {
    id: row.stripe_subscription_id, customer: row.stripe_customer_id, status: row.status, cancel_at_period_end: row.cancel_at_period_end === true,
    cancel_at: row.cancel_at_period_end ? end : null, current_period_start: end - 30 * DAY, current_period_end: end, created: end - 40 * DAY,
    metadata: { supabase_user_id: userId }, price: { unit_amount: row.price_cents ?? 1000, currency: row.currency ?? "usd", interval: row.plan === "yearly" ? "year" : "month" },
    quantity: 1, discount: row.discounted === true, trial_end: row.status === "trialing" ? end : null,
  };
  if ((row.live_subscriptions ?? 1) < 2) return [one];
  return [one, { ...one, id: `${one.id}_older`, created: one.created - 3600, metadata: { ...one.metadata } }];
}

// ================================================================================================ WEBHOOK
export type Step =
  | "checkout" | "checkout_trial" | "trial_converts" | "double_checkout" | "second_customer_checkout" | "cancel_newest_now" | "cancel_older_now"
  | "coupon_on" | "coupon_off" | "to_yearly_prorated" | "to_eur" | "to_jpy" | "payment_failed" | "retry_succeeds" | "dunning_unpaid" | "dunning_canceled"
  | "refund_event" | "dispute_event" | "schedule_update" | "schedule_release" | "customer_deleted" | "unknown_events" | "cancel_at_end" | "account_deleted";
export const FLOWS_R2: Step[][] = [
  ["checkout_trial", "trial_converts"], ["checkout_trial", "trial_converts", "coupon_on", "coupon_off"], ["checkout", "double_checkout"],
  ["checkout", "double_checkout", "cancel_newest_now"], ["checkout", "double_checkout", "cancel_older_now"], ["checkout", "second_customer_checkout"],
  ["checkout", "second_customer_checkout", "cancel_newest_now"], ["checkout", "coupon_on"], ["checkout", "to_yearly_prorated"], ["checkout", "to_eur"], ["checkout", "to_jpy"],
  ["checkout", "payment_failed", "retry_succeeds"], ["checkout", "payment_failed", "dunning_unpaid", "dunning_canceled"], ["checkout", "refund_event", "dispute_event"],
  ["checkout", "schedule_update", "schedule_release"], ["checkout", "customer_deleted"], ["checkout", "unknown_events"], ["checkout", "cancel_at_end", "double_checkout"],
  ["checkout", "account_deleted"], ["checkout_trial", "double_checkout", "cancel_newest_now"], ["checkout", "second_customer_checkout", "cancel_newest_now", "customer_deleted"],
];
export type DeliveryR2 = "in_order" | "reversed" | "shuffled" | "duplicated" | "replayed";
export type SigR2 = "plain" | "many_v1_first" | "many_v1_last" | "v1_and_v0" | "edge_past" | "edge_future" | "spaces";
export type BadSigR2 = "none" | "past_301" | "future_301" | "only_wrong_v1s" | "t_not_number" | "v1_upper_hex" | "empty_v1";
export interface WebhookScenarioR2 { id: number; steps: Step[]; delivery: DeliveryR2; sig: SigR2; bad: BadSigR2; user: string; other: string; customer: string; credits: boolean }
export const uidR2 = (n: number) => `5e7a1c00-0b22-4b22-8c22-${(0xd0000000 + n).toString(16).padStart(12, "0")}`;
export function webhookScenariosR2(seed: number, count: number): WebhookScenarioR2[] {
  const r = rng(seed);
  const out: WebhookScenarioR2[] = [];
  for (let id = 0; id < count; id++) {
    out.push({
      id, steps: FLOWS_R2[id % FLOWS_R2.length], delivery: pick(r, ["in_order", "reversed", "shuffled", "duplicated", "replayed"] as const),
      sig: pick(r, ["plain", "plain", "many_v1_first", "many_v1_last", "v1_and_v0", "edge_past", "edge_future", "spaces"] as const),
      bad: r.next() < 0.3 ? pick(r, ["past_301", "future_301", "only_wrong_v1s", "t_not_number", "v1_upper_hex", "empty_v1"] as const) : "none",
      user: uidR2(id * 2), other: uidR2(id * 2 + 1), customer: `cus_w2_${id}`, credits: r.next() < 0.3,
    });
  }
  return out;
}

// ================================================================================================ ACCOUNT DELETION
export type DeleteCase = "none" | "active" | "trialing" | "past_due" | "canceled" | "two_live" | "already_canceled_at_stripe" | "missing_at_stripe" | "ending";
export type DeleteFault = "ok" | "5xx" | "timeout" | "no_key" | "row_unreadable";
export interface DeleteScenario { id: number; kind: DeleteCase; fault: DeleteFault; user: string }
export function deleteScenarios(seed: number, count: number): DeleteScenario[] {
  const r = rng(seed);
  const kinds: DeleteCase[] = ["none", "active", "trialing", "past_due", "canceled", "two_live", "already_canceled_at_stripe", "missing_at_stripe", "ending"];
  const out: DeleteScenario[] = [];
  for (let id = 0; id < count; id++) {
    out.push({ id, kind: kinds[id % kinds.length], fault: r.next() < 0.7 ? "ok" : pick(r, ["5xx", "timeout", "no_key", "row_unreadable"] as const), user: uidR2(500000 + id) });
  }
  return out;
}
