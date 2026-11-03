// stripe-webhook's logic (the Edge Function in ../stripe-webhook/index.ts is only the server around it), testable with a
// fake Stripe at the HTTP boundary and a real database (tests/architect/scenarios-billing-cancel.test.ts and
// flow-scenarios-billing-cancel.test.ts).
//
// Battery 2026-10-30 found the old handler wrote each event's own copy of the subscription straight onto the person's
// row: a replayed or late event (Stripe retries for days and never promises order) put back a cancel the person had
// undone, or an old subscription's "canceled" over the new live one; the price was always written as $10 whatever the
// plan; a duplicate "active" delivery applied the same referral credit to the Stripe balance twice; and a subscription
// whose metadata named one person but whose customer was another person's was written onto the first person's row.
// Now:
//   - the signature is checked here (Stripe's v1 scheme: HMAC-SHA256 of "t.body" with the endpoint secret, any v1 in the
//     header, the timestamp within five minutes of now), constant time, before anything is read;
//   - an event is only a nudge: the subscription is read back from Stripe as it is now and that is what is written, so a
//     replay, a duplicate or an out-of-order event writes the same current truth. Stripe unreachable: 500, Stripe
//     retries; nothing is guessed from the payload;
//   - the write is billing_sync_subscription (20261030020000): last read wins (a slower handler's older read is
//     refused), a non-live subscription never replaces a different live one, and a customer or subscription already on
//     another person's row is refused, as is a person who does not exist;
//   - the person is the subscription's metadata, else the customer's, else the row that already holds the customer;
//     none of those: ignored (200, never retried forever), never attached to anyone;
//   - the price and plan are the subscription's own price (unit amount, interval); unknown is null, never $10;
//   - access ends at the period end: a plan cancelled at period end stays live until Stripe deletes it then (the row
//     keeps Stripe's status and period end; the chat says "ended" once the end has passed);
//   - referral credits go to the Stripe balance under an idempotency key made from the credit rows, so two deliveries
//     credit once.
//
// Billing round 2 (battery 2026-10-30, tests/architect/scenarios-billing-r2.test.ts, flow-scenarios-billing-r2.test.ts):
//   - two live subscriptions for one person (a double checkout) were "last read wins": the row flipped between them with the
//     order of Stripe's events, and when the shown one ended the row said "cancelled" while the other still charged. Now every
//     event reads all the person's subscriptions (Stripe's search by the person, the event's customer and the customer
//     already on the row) and writes one chosen the same way whatever the order: the newest live one (created, then id);
//     none live, the one on the row as Stripe has it now; the row also says how many are live (live_subscriptions), and the
//     chat says so;
//   - the price's currency is kept (a EUR plan was "a price I don't have on file") and a coupon or discount is marked (the
//     chat said "You're paying $10/month" under a 100%-off coupon);
//   - customer.deleted (Stripe cancels the customer's subscriptions) was ignored: the row is now re-read and written;
//     subscription_schedule events are a nudge like the others;
//   - the referrer's credit was granted on any checkout or paid invoice, a free trial's $0 one included: only a payment of
//     more than zero counts.
// Stripe is reached with fetch (no SDK), pinned to API version 2023-10-16 (the version the old handler used, which has
// current_period_start/end on the subscription). The key and the webhook secret are never printed.

export const STRIPE_API_VERSION = "2023-10-16";
const LIVE = ["active", "trialing", "past_due", "unpaid"];
const STATUSES = new Set(["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------------------------------------ the signature
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function stripeSignature(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
}
// Stripe's header: "t=<unix seconds>,v1=<hex>[,v1=<hex>][,v0=...]". True only for a v1 that matches, with t within
// toleranceSec of now (both ways: a header from the future is as stale as one from the past).
export async function verifyStripeSignature(body: string, header: string | null, secret: string, nowMs: number, toleranceSec = 300): Promise<boolean> {
  if (!header || !secret) return false;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  if (t === null || !v1.length) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return false;
  const want = await stripeSignature(secret, t, body);
  let ok = false;
  for (const s of v1) ok = sameText(s, want) || ok;
  return ok;
}

// ------------------------------------------------------------------------------------------------ Stripe
export class StripeHttpError extends Error {
  constructor(message: string, readonly status: number | null) { super(message); this.name = "StripeHttpError"; }
}
// deno-lint-ignore no-explicit-any
type Json = any;
export interface WebhookStripe {
  // The subscription as Stripe has it now; null when Stripe says it does not exist (404).
  subscription(id: string): Promise<Json | null>;
  // Every subscription of a customer, any status (Stripe's list, newest first); [] when Stripe has no such customer.
  subscriptions?(customerId: string): Promise<Json[]>;
  // Every subscription whose metadata names the person, under any customer (Stripe's search; it can lag a minute behind,
  // so the customers' own lists are read as well). [] when Stripe's search is not available to the account.
  subscriptionsOf?(userId: string): Promise<Json[]>;
  customer(id: string): Promise<Json | null>;
  creditBalance(customerId: string, amountCents: number, description: string, idempotencyKey: string): Promise<void>;
}
export function webhookStripe(fetchFn: typeof fetch, key: string, o: { timeoutMs?: number } = {}): WebhookStripe {
  const base = "https://api.stripe.com/v1";
  const call = async (path: string, init: RequestInit = {}, missingOk = false) => {
    const where = `stripe ${path.split("?")[0].replace(/\/[a-z]+_[A-Za-z0-9]+/g, "/{id}")}`;
    let r: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${key}`);
      headers.set("stripe-version", STRIPE_API_VERSION);
      r = await fetchFn(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
    } catch (e) {
      throw new StripeHttpError(`${where} did not answer (${e instanceof Error && /^[A-Za-z]+$/.test(e.name) ? e.name : "error"})`, null);
    }
    if (missingOk && r.status === 404) { await r.body?.cancel().catch(() => {}); return null; }
    if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new StripeHttpError(`${where} answered ${r.status}`, r.status); }
    try { return await r.json(); } catch { throw new StripeHttpError(`${where} answered ${r.status} with a body that is not JSON`, null); }
  };
  return {
    subscription: (id) => call(`/subscriptions/${encodeURIComponent(id)}`, {}, true),
    customer: (id) => call(`/customers/${encodeURIComponent(id)}`, {}, true),
    async subscriptions(customerId) {
      const q = new URLSearchParams({ customer: customerId, status: "all", limit: "100" });
      const j = await call(`/subscriptions?${q}`, {}, true);
      return Array.isArray(j?.data) ? j.data : [];
    },
    async subscriptionsOf(userId) {
      const q = new URLSearchParams({ query: `metadata['supabase_user_id']:'${userId}'`, limit: "100" });
      try {
        const j = await call(`/subscriptions/search?${q}`, {}, true);
        return Array.isArray(j?.data) ? j.data : [];
      } catch (e) {
        if (e instanceof StripeHttpError && e.status === 400) return [];
        throw e;
      }
    },
    async creditBalance(customerId, amountCents, description, idempotencyKey) {
      const body = new URLSearchParams({ amount: String(-Math.abs(amountCents)), currency: "usd", description });
      await call(`/customers/${encodeURIComponent(customerId)}/balance_transactions`, {
        method: "POST", body: body.toString(), headers: { "content-type": "application/x-www-form-urlencoded", "idempotency-key": idempotencyKey },
      });
    },
  };
}

// ------------------------------------------------------------------------------------------------ the store
export interface SyncRow {
  user_id: string; status: string; plan: string | null; price_cents: number | null;
  current_period_start: string | null; current_period_end: string | null;
  stripe_customer_id: string; stripe_subscription_id: string; cancel_at_period_end: boolean; synced_at: string;
  // Billing round 2: the price's currency (null when no price), a coupon or discount on the subscription, and how many of
  // the person's subscriptions are live (null: not known).
  currency?: string | null; discounted?: boolean; live_subscriptions?: number | null;
}
// applied | stale (a later read already written) | other_subscription (a live different subscription is on the row) |
// foreign (the customer or subscription is another person's) | no_user | invalid
export type SyncResult = "applied" | "stale" | "other_subscription" | "foreign" | "no_user" | "invalid";
export interface WebhookStore {
  sync(row: SyncRow): Promise<SyncResult>;
  userForCustomer(customerId: string): Promise<string | null>;
  // The person's row as it is (its customer and subscription), or null. Optional only for older fakes.
  current?(userId: string): Promise<{ stripe_customer_id: string | null; stripe_subscription_id: string | null; status: string; plan: string | null;
    price_cents: number | null; current_period_start: string | null; current_period_end: string | null; cancel_at_period_end: boolean | null; currency?: string | null } | null>;
  pendingCredits(userId: string): Promise<{ id: string; amount: number }[]>;
  markCreditsApplied(ids: string[]): Promise<void>;
  creditReferrer(userId: string): Promise<void>;
}
// deno-lint-ignore no-explicit-any
export function supabaseWebhookStore(admin: any): WebhookStore {
  return {
    async sync(row) {
      const r = await admin.rpc("billing_sync_subscription", {
        p_user_id: row.user_id, p_status: row.status, p_plan: row.plan, p_price_cents: row.price_cents,
        p_period_start: row.current_period_start, p_period_end: row.current_period_end, p_customer: row.stripe_customer_id,
        p_subscription: row.stripe_subscription_id, p_cancel_at_period_end: row.cancel_at_period_end, p_synced_at: row.synced_at,
        p_currency: row.currency ?? null, p_discounted: row.discounted === true, p_live_subscriptions: row.live_subscriptions ?? null,
      });
      if (r.error) throw new Error(`sync the subscription: ${r.error.message}`);
      return String(r.data) as SyncResult;
    },
    async userForCustomer(customerId) {
      const r = await admin.from("user_subscriptions").select("user_id").eq("stripe_customer_id", customerId).limit(2);
      if (r.error) throw new Error(`find the customer: ${r.error.message}`);
      // Two rows holding one customer is no answer at all: nobody is guessed.
      return Array.isArray(r.data) && r.data.length === 1 ? String(r.data[0].user_id) : null;
    },
    async current(userId) {
      const r = await admin.from("user_subscriptions").select("*").eq("user_id", userId).maybeSingle();
      if (r.error) throw new Error(`read the row: ${r.error.message}`);
      return r.data ?? null;
    },
    async pendingCredits(userId) {
      // The referral tables are optional on a project (20260927_000001 is not in go-live's list): absent, no credits.
      const r = await admin.from("referral_credits").select("id, amount").eq("user_id", userId).eq("applied", false);
      if (r.error) return [];
      return (r.data ?? []).map((c: Json) => ({ id: String(c.id), amount: Number(c.amount) }));
    },
    async markCreditsApplied(ids) {
      const r = await admin.from("referral_credits").update({ applied: true }).in("id", ids);
      if (r.error) throw new Error(`mark credits: ${r.error.message}`);
    },
    async creditReferrer(userId) {
      const r = await admin.rpc("credit_pending_referral", { p_referee_id: userId });
      if (r.error) console.error("stripe-webhook: credit_pending_referral failed:", r.error.message);
    },
  };
}

// ------------------------------------------------------------------------------------------------ the row from Stripe
const iso = (sec: unknown) => typeof sec === "number" && Number.isFinite(sec) && Number.isFinite(new Date(sec * 1000).getTime()) ? new Date(sec * 1000).toISOString() : null;
const idOf = (v: unknown): string | null => typeof v === "string" && v ? v : v && typeof v === "object" && typeof (v as Json).id === "string" ? (v as Json).id : null;
export function rowFrom(sub: Json, userId: string, syncedAt: string): SyncRow | null {
  const id = idOf(sub?.id), customer = idOf(sub?.customer);
  if (!id || !customer || !STATUSES.has(String(sub?.status))) return null;
  // The plan's own price: one item, a whole unit amount in a currency Stripe states (billing round 2: not only USD); the
  // interval names the plan. Anything else is unknown.
  const items = Array.isArray(sub?.items?.data) ? sub.items.data : [];
  const p = items.length === 1 ? items[0]?.price ?? items[0]?.plan : null;
  const currency = String(p?.currency ?? "").toLowerCase();
  const amount = p && Number.isSafeInteger(p.unit_amount ?? p.amount) && (p.unit_amount ?? p.amount) >= 0 && /^[a-z]{3}$/.test(currency)
    && (items[0]?.quantity ?? 1) === 1 ? Number(p.unit_amount ?? p.amount) : null;
  const interval = p?.recurring?.interval ?? p?.interval;
  const count = Number(p?.recurring?.interval_count ?? p?.interval_count ?? 1);
  const plan = amount === null ? null : count === 1 && interval === "month" ? "monthly" : count === 1 && interval === "year" ? "yearly" : null;
  const end = iso(sub.current_period_end);
  // A cancel set for a date at or before the period end is the same as "at period end" for what the person is told.
  const cancelAt = typeof sub.cancel_at === "number" ? sub.cancel_at : null;
  const ending = sub.cancel_at_period_end === true || (cancelAt !== null && typeof sub.current_period_end === "number" && cancelAt <= sub.current_period_end);
  return {
    user_id: userId, status: String(sub.status), plan, price_cents: plan ? amount : null,
    current_period_start: iso(sub.current_period_start), current_period_end: end,
    stripe_customer_id: customer, stripe_subscription_id: id, cancel_at_period_end: ending, synced_at: syncedAt,
    currency: plan ? currency : null,
    // A coupon or discount on the subscription (2023-10-16: discount; later versions: discounts): the price is not the charge.
    discounted: !!(sub.discount && typeof sub.discount === "object") || (Array.isArray(sub.discounts) && sub.discounts.length > 0),
    live_subscriptions: null,
  };
}

// ------------------------------------------------------------------------------------------------ the handler
export interface WebhookDeps {
  secret: string | null | undefined;
  stripe: WebhookStripe | null;
  store: WebhookStore;
  now: () => number;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const safe = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_]+/g, "[key]").slice(0, 200);

export async function handleStripeWebhook(req: Request, d: WebhookDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!d.secret || !d.stripe) {
    console.error("stripe-webhook: missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET");
    return json({ error: "Stripe not configured" }, 503);
  }
  const sig = req.headers.get("stripe-signature");
  if (!sig) return json({ error: "Missing signature" }, 400);
  const raw = await req.text();
  if (!(await verifyStripeSignature(raw, sig, d.secret, d.now()))) {
    console.error("stripe-webhook: signature verification failed");
    return json({ error: "Invalid signature" }, 400);
  }
  let event: Json;
  try { event = JSON.parse(raw); } catch { return json({ error: "Invalid payload" }, 400); }
  const type = String(event?.type ?? ""), obj = event?.data?.object ?? {};
  try {
    let subId: string | null = null;
    if (type === "checkout.session.completed") subId = idOf(obj.subscription);
    else if (type.startsWith("customer.subscription.")) subId = idOf(obj.id);
    else if (type.startsWith("invoice.")) subId = idOf(obj.subscription);
    else if (type.startsWith("subscription_schedule.")) subId = idOf(obj.subscription);
    else if (type === "customer.deleted") {
      const out = await customerDeleted(idOf(obj.id), d);
      return json({ received: true, ...(out === "applied" ? {} : { ignored: out }) });
    } else { console.log(`stripe-webhook: unhandled event ${type}`); return json({ received: true }); }
    if (!subId) return json({ received: true, ignored: "no subscription" });
    const out = await sync(subId, d);
    // The referrer's credit on a paid charge (idempotent in the database: only a pending referral is credited). Only money
    // actually paid counts: a free trial's checkout or $0 invoice, or a 100%-off coupon, is not a paid charge.
    const paid = type === "checkout.session.completed" ? obj.payment_status === "paid" && Number(obj.amount_total) > 0
      : (type === "invoice.payment_succeeded" || type === "invoice.paid") && Number(obj.amount_paid) > 0;
    if (out.userId && paid) await d.store.creditReferrer(out.userId);
    return json({ received: true, ...(out.result === "applied" ? {} : { ignored: out.result }) });
  } catch (e) {
    // Stripe or the database did not answer: nothing is written from the payload; Stripe retries.
    console.error("stripe-webhook error:", safe(e));
    return json({ error: "Webhook failed" }, 500);
  }
}

async function sync(subId: string, d: WebhookDeps): Promise<{ result: SyncResult | "unknown_person" | "not_found"; userId: string | null }> {
  const stripe = d.stripe!;
  const syncedAt = new Date(d.now()).toISOString();
  const sub = await stripe.subscription(subId);
  if (!sub) return { result: "not_found", userId: null };
  const customer = idOf(sub.customer);
  let userId: string | null = typeof sub.metadata?.supabase_user_id === "string" ? sub.metadata.supabase_user_id : null;
  if (!userId && customer) {
    const c = await stripe.customer(customer);
    userId = c && !c.deleted && typeof c.metadata?.supabase_user_id === "string" ? c.metadata.supabase_user_id : null;
  }
  if (!userId && customer) userId = await d.store.userForCustomer(customer);
  if (!userId || !UUID.test(userId)) {
    console.error(`stripe-webhook: no person for subscription ${subId}; ignored`);
    return { result: "unknown_person", userId: null };
  }
  // Every subscription the person has at Stripe (Stripe's search by the person, this customer's, and the customer already
  // on the row), and the one to show chosen by Stripe's own facts, so the order events arrive in never decides it.
  const cur = d.store.current ? await d.store.current(userId) : null;
  const all = new Map<string, Json>();
  if (stripe.subscriptionsOf) for (const s of await stripe.subscriptionsOf(userId)) { const sid = idOf(s?.id); if (sid && s?.metadata?.supabase_user_id === userId) all.set(sid, s); }
  if (stripe.subscriptions) {
    for (const c of [...new Set([customer, cur?.stripe_customer_id].filter((x): x is string => typeof x === "string" && !!x))]) {
      for (const s of await stripe.subscriptions(c)) {
        const sid = idOf(s?.id);
        const owner = typeof s?.metadata?.supabase_user_id === "string" ? s.metadata.supabase_user_id : null;
        // Another person's subscription on a shared customer is never theirs to show here.
        if (sid && (owner === null || owner === userId)) all.set(sid, s);
      }
    }
  }
  all.set(subId, sub); // the subscription just read is the freshest copy of itself
  const chosen = choose([...all.values()], cur?.stripe_subscription_id);
  const row = rowFrom(chosen, userId, syncedAt);
  if (!row) return { result: "invalid", userId: null };
  row.live_subscriptions = stripe.subscriptions ? [...all.values()].filter((s) => LIVE.includes(String(s?.status))).length : null;
  const result = await d.store.sync(row);
  if (result !== "applied") {
    console.log(`stripe-webhook: subscription ${subId} not written (${result})`);
    return { result, userId: result === "stale" || result === "other_subscription" ? userId : null };
  }
  if (row.status === "active") await applyCredits(userId, row.stripe_customer_id, d);
  return { result, userId };
}

// The subscription a person's row shows: the newest live one (created, then id); none live, the one already on the row as
// Stripe has it now (so its own end is written, never refused as another subscription's), else the newest of any status.
export function choose(subs: Json[], onRow?: string | null): Json {
  const order = (a: Json, b: Json) => (Number(b?.created) || 0) - (Number(a?.created) || 0) || String(idOf(b?.id)).localeCompare(String(idOf(a?.id)));
  const live = subs.filter((s) => LIVE.includes(String(s?.status))).sort(order);
  return live[0] ?? subs.find((s) => onRow && idOf(s?.id) === onRow) ?? [...subs].sort(order)[0];
}

// customer.deleted: Stripe cancels a deleted customer's subscriptions. The row that holds the customer is synced like any
// other event (all the person's subscriptions read, so a live one under another customer is still found); a subscription
// Stripe no longer returns, under a customer Stripe confirms deleted, is written as cancelled (the row's own period and
// price kept). Nothing is guessed when Stripe does not confirm the deletion.
async function customerDeleted(customer: string | null, d: WebhookDeps): Promise<SyncResult | "unknown_person" | "not_deleted" | "no_row" | "not_found"> {
  if (!customer) return "unknown_person";
  const stripe = d.stripe!;
  const userId = await d.store.userForCustomer(customer);
  if (!userId || !UUID.test(userId)) return "unknown_person";
  const c = await stripe.customer(customer);
  if (c && !c.deleted) return "not_deleted";
  const cur = d.store.current ? await d.store.current(userId) : null;
  if (!cur?.stripe_subscription_id || cur.stripe_customer_id !== customer) return "no_row";
  if (await stripe.subscription(cur.stripe_subscription_id)) return (await sync(cur.stripe_subscription_id, d)).result;
  return await d.store.sync({
    user_id: userId, status: "canceled", plan: cur.plan, price_cents: cur.price_cents, current_period_start: cur.current_period_start,
    current_period_end: cur.current_period_end, stripe_customer_id: customer, stripe_subscription_id: cur.stripe_subscription_id,
    cancel_at_period_end: false, synced_at: new Date(d.now()).toISOString(), currency: cur.currency ?? null, discounted: false, live_subscriptions: 0,
  });
}

async function applyCredits(userId: string, customerId: string, d: WebhookDeps) {
  const credits = await d.store.pendingCredits(userId);
  if (!credits.length) return;
  const total = credits.reduce((s, c) => s + Math.round(Number(c.amount) * 100), 0);
  if (!Number.isSafeInteger(total) || total <= 0) return;
  const ids = credits.map((c) => c.id).sort();
  // The same credit rows are the same key: a second delivery, or two at once, credit the balance once.
  const bytes = new TextEncoder().encode(`trainee-referral-credit\n${customerId}\n${ids.join(",")}`);
  const key = hex(await crypto.subtle.digest("SHA-256", bytes));
  await d.stripe!.creditBalance(customerId, total, `Referral credit applied (${ids.length} referral${ids.length === 1 ? "" : "s"})`, key);
  await d.store.markCreditsApplied(ids);
  console.log(`stripe-webhook: applied $${(total / 100).toFixed(2)} credit to customer ${customerId}`);
}

export const isLive = (status: string) => LIVE.includes(status);
