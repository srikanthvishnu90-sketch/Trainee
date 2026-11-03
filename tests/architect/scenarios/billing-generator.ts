// Billing and cancel-by-text scenarios at scale (battery 2026-10-30), seeded and deterministic: a failure names its input
// and every run is the same run. Synthetic only: no real person, key, card, Stripe account or event.
//
// Extends the 2026-10-29 battery (billing-research-generator.ts: prices, receipts, Stripe faults on the cancel) with:
//   TEXT     what a person texts about cancelling and paying, on every row state, with a fixed clock (NOW): clear cancel
//            asks (new phrasings included), look-alikes that must never cancel billing ("cancel that", "stop", STOP,
//            "cancel my application", "cancel the interview", "unsubscribe from alerts" ...), the confirmation and its
//            answers, a double and a concurrent yes, undoing a cancel before the period ends, cancel/undo/cancel cycles and
//            an undo made at Stripe in between (Stripe's idempotency replay), another person's pending ask, a period end
//            already past, card and bank details typed in chat, and status questions that must be answered from the row.
//   WEBHOOK  a person's subscription changing at Stripe (checkout, cancel at period end, undo, renewal, past_due, unpaid,
//            deletion at period end, a new subscription after the old one, price and plan changes), each change an event;
//            delivered in order, shuffled, duplicated, replayed late, concurrently with a slower handler, with bad
//            signatures, with Stripe down (500, redelivered), for an unknown customer, for a customer that is another
//            person's, for a person who does not exist, and with referral credits waiting.
// FakeStripe answers at the HTTP boundary exactly as the adapters call it, keeps the subscriptions' truth, and replays a
// reused idempotency key the way Stripe does (the first answer, header Idempotent-Replayed: true, nothing applied).
import { rng, type R } from "../scenarios-fixture.ts";
import type { Subscription } from "../../../supabase/functions/_shared/career_billing.ts";
import { stripeSignature } from "../../../supabase/functions/_shared/stripe_webhook.ts";

export { rng };
const pick = <T>(r: R, xs: readonly T[]): T => r.pick(xs);

export const NOW = Date.UTC(2026, 9, 30, 12, 0, 0); // the battery's clock
// Fake, and assembled here so no key-shaped literal sits in the repository (secret scanning).
export const STRIPE_KEY = ["sk", "test", "cancelBatteryKEY00000000000NOTREAL"].join("_");
export const WEBHOOK_SECRET = ["whsec", "cancelBatterySECRET0000000NOTREAL"].join("_");
const DAY = 86_400_000;
export const FUTURE_ENDS = ["2026-11-27T15:00:00.000Z", "2026-12-31T23:30:00.000Z", "2027-01-03T00:00:00.000Z", "2026-11-05T12:00:00.000Z", "2026-10-30T12:00:01.000Z"];
export const PAST_ENDS = ["2026-10-01T15:00:00.000Z", "2026-10-30T11:59:59.000Z", "2025-12-31T00:00:00.000Z"];

// ================================================================================================ Stripe at the HTTP boundary
export type Mode = "ok" | "5xx" | "timeout" | "401" | "malformed" | "applied_then_5xx";
export interface FakeSub {
  id: string; customer: string; status: string; cancel_at_period_end: boolean; cancel_at: number | null;
  current_period_start: number; current_period_end: number; created: number;
  metadata: Record<string, string>; price: { unit_amount: number; currency: string; interval: string; interval_count?: number } | null; quantity: number;
}
export interface Call { method: string; path: string; body: string; idem: string | null; auth: string | null; version: string | null; replayed: boolean; status: number }
export class FakeStripe {
  subs = new Map<string, FakeSub>();
  customers = new Map<string, { id: string; metadata: Record<string, string>; deleted?: boolean }>();
  balance = new Map<string, number>();
  calls: Call[] = [];
  mode: Mode = "ok";
  searchLagSec = 0;
  searchNowSec = 0;
  // Stripe keeps a key ~24 h: same key and same request -> the first answer again, nothing applied; a different request -> 400.
  private idem = new Map<string, { path: string; body: string; status: number; json: unknown }>();
  constructor(private key = STRIPE_KEY) {}
  subJson(s: FakeSub) {
    return {
      id: s.id, object: "subscription", customer: s.customer, status: s.status, cancel_at_period_end: s.cancel_at_period_end, cancel_at: s.cancel_at,
      current_period_start: s.current_period_start, current_period_end: s.current_period_end, created: s.created, metadata: { ...s.metadata },
      items: { object: "list", data: s.price ? [{ id: `si_${s.id}`, quantity: s.quantity, price: { id: `price_${s.price.interval}`, unit_amount: s.price.unit_amount, currency: s.price.currency, recurring: { interval: s.price.interval, interval_count: s.price.interval_count ?? 1 } } }] : [] },
    };
  }
  fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.text() : "";
    const call: Call = { method: req.method, path: url.pathname + url.search, body, idem: req.headers.get("idempotency-key"), auth: req.headers.get("authorization"),
      version: req.headers.get("stripe-version"), replayed: false, status: 0 };
    this.calls.push(call);
    const json = (v: unknown, status = 200, extra: Record<string, string> = {}) => { call.status = status; return new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...extra } }); };
    if (url.host !== "api.stripe.com") throw new TypeError(`fake Stripe: not Stripe: ${url.host}`);
    if (call.auth !== `Bearer ${this.key}`) return json({ error: { message: "Invalid API Key provided" } }, 401);
    if (this.mode === "timeout") { call.status = -1; throw new DOMException("Signal timed out.", "TimeoutError"); }
    if (this.mode === "5xx") return json({ error: { message: "api error" } }, 500);
    if (this.mode === "401") return json({ error: { message: `Invalid API Key provided: ${this.key}` } }, 401);
    if (this.mode === "malformed") { call.status = 200; return new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }); }
    if (call.idem && req.method === "POST") {
      const prev = this.idem.get(call.idem);
      if (prev) {
        if (prev.path !== url.pathname || prev.body !== body) return json({ error: { type: "idempotency_error" } }, 400);
        call.replayed = true;
        return json(prev.json, prev.status, { "idempotent-replayed": "true" });
      }
    }
    const answer = (v: unknown, status = 200) => {
      if (call.idem && req.method === "POST") this.idem.set(call.idem, { path: url.pathname, body, status, json: v });
      if (this.mode === "applied_then_5xx" && req.method === "POST") return json({ error: { message: "api error" } }, 500);
      return json(v, status);
    };
    let m: RegExpExecArray | null;
    // Stripe's search by metadata (stripe-webhook reads it since billing round 2); searchLagSec leaves out what was
    // created within that many seconds of searchNowSec (Stripe's search can lag about a minute).
    if (url.pathname === "/v1/subscriptions/search" && req.method === "GET") {
      const who = /metadata\['supabase_user_id'\]:'([^']+)'/.exec(url.searchParams.get("query") ?? "")?.[1];
      const list = [...this.subs.values()].filter((x) => who && x.metadata.supabase_user_id === who && !(this.searchLagSec && x.created > this.searchNowSec - this.searchLagSec));
      return answer({ object: "search_result", data: list.map((x) => this.subJson(x)), has_more: false });
    }
    if ((m = /^\/v1\/subscriptions\/([^/]+)$/.exec(url.pathname))) {
      const s = this.subs.get(decodeURIComponent(m[1]));
      if (!s) return answer({ error: { type: "invalid_request_error", code: "resource_missing" } }, 404);
      if (req.method === "POST") {
        const f = new URLSearchParams(body);
        const v = f.get("cancel_at_period_end");
        if (v !== "true" && v !== "false") return answer({ error: { type: "invalid_request_error" } }, 400);
        if (s.status === "canceled") return answer({ error: { type: "invalid_request_error", message: "canceled" } }, 400);
        s.cancel_at_period_end = v === "true";
        s.cancel_at = s.cancel_at_period_end ? s.current_period_end : null;
      }
      return answer(this.subJson(s));
    }
    if ((m = /^\/v1\/customers\/([^/]+)\/balance_transactions$/.exec(url.pathname)) && req.method === "POST") {
      const c = decodeURIComponent(m[1]);
      const f = new URLSearchParams(body);
      this.balance.set(c, (this.balance.get(c) ?? 0) + Number(f.get("amount")));
      return answer({ id: `cbtxn_${this.calls.length}`, amount: Number(f.get("amount")) });
    }
    if ((m = /^\/v1\/customers\/([^/]+)$/.exec(url.pathname))) {
      const c = this.customers.get(decodeURIComponent(m[1]));
      if (!c) return answer({ error: { type: "invalid_request_error", code: "resource_missing" } }, 404);
      return answer(c.deleted ? { id: c.id, deleted: true } : { id: c.id, object: "customer", metadata: { ...c.metadata } });
    }
    // A customer's subscriptions, any status, newest first (stripe-webhook reads them since billing round 2).
    if (url.pathname === "/v1/subscriptions" && req.method === "GET") {
      const c = url.searchParams.get("customer");
      const list = [...this.subs.values()].filter((x) => x.customer === c).sort((x, y) => y.created - x.created || (y.id < x.id ? -1 : 1));
      return answer({ object: "list", data: list.map((x) => this.subJson(x)), has_more: false });
    }
    if (url.pathname === "/v1/invoices") return answer({ object: "list", data: [] });
    return answer({ error: { type: "invalid_request_error" } }, 404);
  }) as typeof fetch;
  posts(path?: string) { return this.calls.filter((c) => c.method === "POST" && (!path || c.path === path)); }
}

// ================================================================================================ TEXT
export type RowKind = "none" | "active" | "trialing" | "past_due" | "unpaid" | "canceled" | "incomplete" | "ending" | "ending_trial" | "no_period_end"
  | "past_end_active" | "past_end_ending" | "price_odd" | "yearly" | "price_unknown" | "no_stripe_ids";
export const ROW_KINDS: RowKind[] = ["none", "active", "trialing", "past_due", "unpaid", "canceled", "incomplete", "ending", "ending_trial", "no_period_end",
  "past_end_active", "past_end_ending", "price_odd", "yearly", "price_unknown", "no_stripe_ids"];
export function textRow(r: R, kind: RowKind, n: number): Subscription | null {
  if (kind === "none") return null;
  const base: Subscription = {
    status: "active", plan: "monthly", price_cents: 1000, current_period_start: "2026-10-27T15:00:00.000Z", current_period_end: pick(r, FUTURE_ENDS),
    stripe_customer_id: `cus_bc${n}`, stripe_subscription_id: `sub_bc${n}`, cancel_at_period_end: false,
  };
  switch (kind) {
    case "active": return base;
    case "trialing": case "past_due": case "unpaid": case "canceled": return { ...base, status: kind };
    case "incomplete": return { ...base, status: "incomplete", stripe_subscription_id: pick(r, [null, `sub_bc${n}`]) };
    case "ending": return { ...base, cancel_at_period_end: true };
    case "ending_trial": return { ...base, status: "trialing", cancel_at_period_end: true };
    case "no_period_end": return { ...base, current_period_end: null };
    case "past_end_active": return { ...base, current_period_end: pick(r, PAST_ENDS) };
    case "past_end_ending": return { ...base, current_period_end: pick(r, PAST_ENDS), cancel_at_period_end: true };
    case "price_odd": return { ...base, price_cents: pick(r, [999, 2500, 1234, 1050]) };
    case "yearly": return { ...base, plan: "yearly", price_cents: pick(r, [10000, 9900]) };
    case "price_unknown": return { ...base, price_cents: null };
    case "no_stripe_ids": return { ...base, stripe_customer_id: null, stripe_subscription_id: null };
  }
}
export const cancellable = (s: Subscription | null) =>
  !!s?.stripe_subscription_id && !["incomplete", "incomplete_expired", "canceled"].includes(s.status) && s.cancel_at_period_end !== true;
const future = (s: Subscription | null) => !!s?.current_period_end && Date.parse(s.current_period_end) > NOW;
// An undo is possible before the period ends: a live plan ending at period end, its end not yet passed (or unknown).
export const resumable = (s: Subscription | null) =>
  !!s?.stripe_subscription_id && ["active", "trialing", "past_due", "unpaid"].includes(s.status) && s.cancel_at_period_end === true &&
  (!s.current_period_end || future(s));

// Clear cancel asks: every one must be read as the cancel ask (deterministic; the model is never called).
export const CANCEL_ASKS = [
  "cancel my plan", "cancel my subscription", "cancel my membership", "i want to cancel my plan", "i'd like to cancel my subscription", "can you cancel my plan",
  "how do i cancel my plan", "help me cancel my plan", "end my subscription", "stop my plan", "cancel trainee", "stop charging me", "don't charge me again",
  "cancel my trainee subscription", "cancel the plan", "cancel my plan now",
  // battery 2026-10-30: these used to fall through to the model
  "cancel my sub", "cancel subscription", "cancel my auto-renew", "turn off auto renew", "stop auto renewal", "disable auto-renewal for my plan",
  "don't renew my plan", "do not renew my subscription", "cancel my renewal", "unsubscribe me from trainee", "i want to unsubscribe from trainee",
  "terminate my subscription", "delete my subscription", "cancel billing", "stop my billing", "end my trainee billing", "please cancel my subscription",
  "i need to cancel my subscription",
];
// Look-alikes: never billing's cancel ask (no ask shown, nothing waiting, Stripe never called).
export const NOT_CANCEL = [
  "cancel that", "stop", "STOP", "Stop", "stop.", "cancel", "cancel it", "I want to cancel my application", "cancel my application to Acme", "cancel my Acme application",
  "cancel the interview", "cancel the interview with Ramp", "cancel my interview tomorrow", "unsubscribe from alerts", "unsubscribe", "unsubscribe me from job alerts",
  "unsubscribe from emails", "stop sending me alerts", "stop the alerts", "stop sending jobs", "cancel my job alerts subscription", "cancel my subscription to job alerts",
  "cancel my email subscription", "cancel my weekly plan", "cancel my plan for this week", "stop my job search plan", "cancel my account", "delete my account",
  "pause my alerts", "end the call", "cancel the meeting", "stop applying", "cancel the application to Stripe", "stop applying to Acme", "cancel my linkedin premium",
  "how do i cancel netflix", "cancel the order", "end", "quit", "STOP ALL", "unsub", "cancel my request", "stop following up with Maya",
];
export const STATUS_ASKS = [
  "when does my plan end", "when does my subscription end", "when does my access end", "am i subscribed", "am i still subscribed", "is my plan active",
  "is my subscription cancelled", "is my subscription canceled", "did my cancel go through", "did my cancellation go through", "what's my plan status",
  "what is my subscription status", "what's the price of trainee", "what am i paying", "when is my next charge", "how much is trainee",
];
export const RESUME_ASKS = [
  "resume my plan", "resume my subscription", "uncancel my plan", "undo the cancellation", "reactivate my subscription", "keep my plan going",
  "i changed my mind, keep my plan active", "resubscribe", "i want to resubscribe", "cancel my cancellation", "undo my cancellation", "actually keep my subscription",
];
export const YES = ["yes", "Yes", "YES", "yes.", "y", "yep", "yeah", "yes please", "confirm", "go ahead", "do it", "\u{1F44D}", "yes, cancel it"];
export const RESUME_YES = ["yes", "Yes", "yep", "yeah", "yes please", "confirm", "go ahead", "do it", "\u{1F44D}"];
export const NO = ["no", "nope", "nah", "keep it", "never mind", "cancel that", "don't cancel"];
export const UNSURE = ["maybe", "wait", "hold on", "not sure", "ok", "sure", "hmm", "yes?", "what happens to my data?", "yes but not yet", "can I pause instead?", "stop", "STOP"];
// Card and bank details typed in chat, with what must not survive redaction.
export const PAYMENT_DETAILS: { text: string; secrets: string[] }[] = [
  { text: "my card is 4242 4242 4242 4242 exp 12/28 cvv 123", secrets: ["4242 4242 4242 4242", "cvv 123"] },
  { text: "charge my visa 4111-1111-1111-1111 please", secrets: ["4111-1111-1111-1111"] },
  { text: "use 5555555555554444, security code is 321", secrets: ["5555555555554444", "321"] },
  { text: "amex 3782 822463 10005 cid 1234", secrets: ["3782 822463 10005", "1234"] },
  { text: "card number: 4000 0566 5566 5556, expiry 04/30, the 3 digits on the back are 987", secrets: ["4000 0566 5566 5556", "987"] },
  { text: "pay from my bank, routing number 021000021 account number 000123456789", secrets: ["021000021", "000123456789"] },
  { text: "my iban is DE89 3704 0044 0532 0130 00", secrets: ["DE89 3704 0044 0532 0130 00", "37040044"] },
  { text: "IBAN GB29NWBK60161331926819 for the subscription", secrets: ["GB29NWBK60161331926819"] },
  { text: "can I pay with debit card 6011 1111 1111 1117 cvc 456", secrets: ["6011 1111 1111 1117", "456"] },
  { text: "cancel my plan, my card is 4242 4242 4242 4242", secrets: ["4242 4242 4242 4242"] },
  { text: "subscribe me, card 4242424242424242 exp 0128 cvv2 999", secrets: ["4242424242424242", "999"] },
];

export function vary(r: R, s: string): string {
  if (/^\p{Extended_Pictographic}/u.test(s)) return s;
  let t = s;
  const c = r.next();
  if (c < 0.12) t = t.toUpperCase();
  else if (c < 0.3) t = t.charAt(0).toUpperCase() + t.slice(1);
  const p = r.next();
  if (p < 0.15) t = `${t}?`;
  else if (p < 0.25) t = `${t}.`;
  else if (p < 0.3) t = `${t}!`;
  if (r.next() < 0.06) t = `hey ${t}`;
  if (r.next() < 0.04) t = `${t} please`;
  if (r.next() < 0.05) t = t.replace(/'/g, "’");
  return t;
}

export type TextScript =
  | { kind: "control"; text: string }                                       // a look-alike, alone
  | { kind: "control_after_ask"; ask: string; text: string }                // a look-alike as the answer to a cancel ask
  | { kind: "cancel"; ask: string; answer: string; cls: "yes" | "no" | "unsure" }
  | { kind: "double_yes"; ask: string; answer: string }
  | { kind: "concurrent_yes"; ask: string; answer: string }
  | { kind: "status"; ask: string }
  | { kind: "resume"; ask: string; answer: string; cls: "yes" | "no" | "unsure" }
  | { kind: "cycle"; cancel: string; resume: string }                      // cancel, undo, cancel again (same period)
  | { kind: "stripe_undo"; ask: string }                                    // cancel; undone at Stripe (dashboard); cancel again
  | { kind: "other_person"; answer: string }                                // a yes on a thread whose pending ask is someone else's
  | { kind: "payment"; text: string; secrets: string[] };
export interface TextScenario { id: number; rowKind: RowKind; row: Subscription | null; mode: Mode; script: TextScript }
const MODES: Mode[] = ["ok", "ok", "ok", "ok", "5xx", "timeout", "401", "malformed", "applied_then_5xx"];

export function textScenarios(seed: number, count: number): TextScenario[] {
  const r = rng(seed);
  const out: TextScenario[] = [];
  for (let id = 0; id < count; id++) {
    const rowKind = ROW_KINDS[id % ROW_KINDS.length];
    const row = textRow(r, rowKind, id);
    const mode = r.next() < 0.75 ? "ok" : pick(r, MODES);
    const s = r.next();
    let script: TextScript;
    if (s < 0.12) script = { kind: "control", text: vary(r, pick(r, NOT_CANCEL)) };
    else if (s < 0.18) script = { kind: "control_after_ask", ask: vary(r, pick(r, CANCEL_ASKS)), text: pick(r, NOT_CANCEL.filter((x) => !/^(?:cancel that|stop\.?|STOP|Stop|STOP ALL)$/.test(x))) };
    else if (s < 0.42) {
      const c = r.next();
      const [answer, cls] = c < 0.6 ? [pick(r, YES), "yes" as const] : c < 0.8 ? [pick(r, NO), "no" as const] : [pick(r, UNSURE), "unsure" as const];
      script = { kind: "cancel", ask: vary(r, pick(r, CANCEL_ASKS)), answer, cls };
    } else if (s < 0.48) script = { kind: "double_yes", ask: vary(r, pick(r, CANCEL_ASKS)), answer: pick(r, YES) };
    else if (s < 0.54) script = { kind: "concurrent_yes", ask: vary(r, pick(r, CANCEL_ASKS)), answer: pick(r, YES) };
    else if (s < 0.64) script = { kind: "status", ask: vary(r, pick(r, STATUS_ASKS)) };
    else if (s < 0.78) {
      const c = r.next();
      const [answer, cls] = c < 0.65 ? [pick(r, RESUME_YES), "yes" as const] : c < 0.82 ? [pick(r, ["no", "nope", "never mind", "nah"]), "no" as const] : [pick(r, UNSURE), "unsure" as const];
      script = { kind: "resume", ask: vary(r, pick(r, RESUME_ASKS)), answer, cls };
    } else if (s < 0.84) script = { kind: "cycle", cancel: vary(r, pick(r, CANCEL_ASKS)), resume: vary(r, pick(r, RESUME_ASKS)) };
    else if (s < 0.89) script = { kind: "stripe_undo", ask: vary(r, pick(r, CANCEL_ASKS)) };
    else if (s < 0.93) script = { kind: "other_person", answer: pick(r, YES) };
    else { const p = pick(r, PAYMENT_DETAILS); script = { kind: "payment", text: p.text, secrets: p.secrets }; }
    out.push({ id, rowKind, row, mode: ["cycle", "stripe_undo", "payment"].includes(script.kind) ? "ok" : mode, script });
  }
  return out;
}
// The Stripe subscription that is the truth behind a row (same ids, period end and flag).
export function stripeTruth(row: Subscription | null, userId: string): FakeSub | null {
  if (!row?.stripe_subscription_id || !row.stripe_customer_id) return null;
  const end = row.current_period_end ? Math.floor(Date.parse(row.current_period_end) / 1000) : Math.floor((NOW + 20 * DAY) / 1000);
  return {
    id: row.stripe_subscription_id, customer: row.stripe_customer_id, status: row.status, cancel_at_period_end: row.cancel_at_period_end === true,
    cancel_at: row.cancel_at_period_end ? end : null, current_period_start: end - 30 * 86400, current_period_end: end, created: end - 60 * 86400,
    metadata: { supabase_user_id: userId }, price: { unit_amount: row.price_cents ?? 1000, currency: "usd", interval: row.plan === "yearly" ? "year" : "month" }, quantity: 1,
  };
}

// ================================================================================================ WEBHOOK
export type Change =
  | "checkout" | "cancel_at_end" | "undo_cancel" | "renew" | "past_due" | "recover" | "unpaid" | "delete_at_end" | "delete_now"
  | "resubscribe" | "price_yearly" | "price_eur" | "quantity_2" | "incomplete_expired";
export type Delivery = "in_order" | "shuffled" | "duplicated" | "late_replay" | "concurrent_slow" | "stripe_down_then_retry";
export type Who = "own" | "customer_meta_only" | "row_only" | "unknown" | "foreign_customer" | "no_such_user" | "deleted_customer";
export type BadSig = "none" | "missing" | "wrong_secret" | "stale" | "future" | "tampered" | "v0_only" | "extra_v1" | "garbage";
export interface WebhookScenario {
  id: number; changes: Change[]; delivery: Delivery; who: Who; badSig: BadSig; credits: number[]; eventTypes: ("subscription" | "invoice" | "checkout")[];
  user: string; other: string; customer: string; seedSubs: number;
}
export const CHANGE_FLOWS: Change[][] = [
  ["checkout"], ["checkout", "cancel_at_end"], ["checkout", "cancel_at_end", "undo_cancel"], ["checkout", "cancel_at_end", "delete_at_end"],
  ["checkout", "past_due"], ["checkout", "past_due", "recover"], ["checkout", "past_due", "unpaid"], ["checkout", "past_due", "unpaid", "delete_now"],
  ["checkout", "renew"], ["checkout", "renew", "cancel_at_end", "undo_cancel", "cancel_at_end"], ["checkout", "delete_now", "resubscribe"],
  ["checkout", "cancel_at_end", "delete_at_end", "resubscribe"], ["checkout", "price_yearly"], ["checkout", "price_eur"], ["checkout", "quantity_2"],
  ["incomplete_expired"], ["checkout", "cancel_at_end", "undo_cancel", "renew"], ["checkout", "unpaid", "delete_now", "resubscribe", "cancel_at_end"],
];
const DELIVERIES: Delivery[] = ["in_order", "shuffled", "duplicated", "late_replay", "concurrent_slow", "stripe_down_then_retry"];
const WHOS: Who[] = ["own", "own", "own", "own", "customer_meta_only", "row_only", "unknown", "foreign_customer", "no_such_user", "deleted_customer"];
const BADS: BadSig[] = ["missing", "wrong_secret", "stale", "future", "tampered", "v0_only", "extra_v1", "garbage"];
export const uidFor = (n: number) => `5e7a1c00-0b11-4b11-8c11-${(0xc0000000 + n).toString(16).padStart(12, "0")}`;
export function webhookScenarios(seed: number, count: number): WebhookScenario[] {
  const r = rng(seed);
  const out: WebhookScenario[] = [];
  for (let id = 0; id < count; id++) {
    const changes = CHANGE_FLOWS[id % CHANGE_FLOWS.length];
    const who = r.next() < 0.6 ? "own" : pick(r, WHOS);
    out.push({
      id, changes, delivery: pick(r, DELIVERIES), who, badSig: r.next() < 0.2 ? pick(r, BADS) : "none",
      credits: r.next() < 0.25 ? pick(r, [[10], [10, 10], [5.5], [10, 0.25]]) : [],
      eventTypes: [pick(r, ["subscription", "subscription", "invoice", "checkout"] as const)],
      user: uidFor(id * 2), other: uidFor(id * 2 + 1), customer: `cus_wh${id}`, seedSubs: 0,
    });
  }
  return out;
}

// A Stripe event for a subscription as it is when the event is made (the payload a late delivery still carries).
export function eventFor(type: string, sub: FakeSub, created: number, n: number) {
  const object = type.startsWith("invoice.") ? { id: `in_${n}`, object: "invoice", subscription: sub.id, customer: sub.customer, amount_paid: sub.price?.unit_amount ?? 0 }
    : type === "checkout.session.completed" ? { id: `cs_${n}`, object: "checkout.session", subscription: sub.id, customer: sub.customer, metadata: { ...sub.metadata } }
    : { ...JSON.parse(JSON.stringify(sub)), object: "subscription", items: { data: sub.price ? [{ price: { ...sub.price, recurring: { interval: sub.price.interval } }, quantity: sub.quantity }] : [] } };
  return { id: `evt_${n}`, object: "event", type, created, data: { object } };
}
export async function signedRequest(body: string, nowMs: number, bad: BadSig, secret = WEBHOOK_SECRET): Promise<Request> {
  const t = Math.floor(nowMs / 1000);
  const good = await stripeSignature(secret, t, body);
  let header: string | null = `t=${t},v1=${good}`;
  let sent = body;
  switch (bad) {
    case "none": break;
    case "missing": header = null; break;
    case "wrong_secret": header = `t=${t},v1=${await stripeSignature("whsec_someoneElse", t, body)}`; break;
    case "stale": header = `t=${t - 301},v1=${await stripeSignature(secret, t - 301, body)}`; break;
    case "future": header = `t=${t + 301},v1=${await stripeSignature(secret, t + 301, body)}`; break;
    case "tampered": sent = body.replace(/"cancel_at_period_end":(true|false)/, (_m, v) => `"cancel_at_period_end":${v === "true" ? "false" : "true"}`).replace(/"status":"[a-z_]+"/, '"status":"active"') + " "; break;
    case "v0_only": header = `t=${t},v0=${good}`; break;
    case "extra_v1": header = `t=${t},v1=${"0".repeat(64)},v1=${good}`; break; // a valid one among others: accepted
    case "garbage": header = "nonsense"; break;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (header !== null) headers["stripe-signature"] = header;
  return new Request("https://project.functions.test/stripe-webhook", { method: "POST", headers, body: sent });
}
