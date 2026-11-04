// Plays a generated webhook scenario (billing-generator.ts) against stripe-webhook's handler: Stripe's truth changes step
// by step, each change makes its events, the events are delivered as the scenario says, and the person's row is checked
// against the truth after each step and at the end. Shared by the pure battery (scenarios-billing-cancel.test.ts, with
// MemStore) and the Postgres run (flow-scenarios-billing-cancel.test.ts, with the product's store).
import { type Change, eventFor, FakeStripe, type FakeSub, NOW, rng, signedRequest, STRIPE_KEY, type WebhookScenario, WEBHOOK_SECRET } from "./billing-generator.ts";
import { handleStripeWebhook, rowFrom, type SyncResult, type SyncRow, type WebhookStore, webhookStripe } from "../../../supabase/functions/_shared/stripe_webhook.ts";

// The store with billing_sync_subscription's semantics (20261030020000; the flow run uses the function itself).
const LIVE = new Set(["active", "trialing", "past_due", "unpaid"]);
type Row = SyncRow & { synced_at: string | null };
export class MemStore implements WebhookStore {
  rows = new Map<string, Row>();
  profiles = new Set<string>();
  credits = new Map<string, { id: string; amount: number; applied: boolean }[]>();
  writes: { user: string; result: SyncResult; row: SyncRow }[] = [];
  hold: ((row: SyncRow) => Promise<void>) | null = null;
  referrerCredited = 0;
  async sync(row: SyncRow): Promise<SyncResult> {
    if (this.hold) await this.hold(row);
    const res = this.decide(row);
    this.writes.push({ user: row.user_id, result: res, row });
    return res;
  }
  private decide(row: SyncRow): SyncResult {
    if (!row.user_id || !row.synced_at || !row.stripe_customer_id || !row.stripe_subscription_id) return "invalid";
    if (!["incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid"].includes(row.status)) return "invalid";
    if (!this.profiles.has(row.user_id)) return "no_user";
    for (const [u, r] of this.rows) if (u !== row.user_id && (r.stripe_customer_id === row.stripe_customer_id || r.stripe_subscription_id === row.stripe_subscription_id)) return "foreign";
    const cur = this.rows.get(row.user_id);
    if (cur) {
      if (cur.synced_at && cur.synced_at > row.synced_at) return "stale";
      if (cur.stripe_subscription_id && cur.stripe_subscription_id !== row.stripe_subscription_id && LIVE.has(cur.status) && !LIVE.has(row.status)) return "other_subscription";
    }
    this.rows.set(row.user_id, { ...row, plan: row.plan ?? cur?.plan ?? "monthly" });
    return "applied";
  }
  async userForCustomer(customerId: string) {
    const us = [...this.rows.entries()].filter(([, r]) => r.stripe_customer_id === customerId).map(([u]) => u);
    return us.length === 1 ? us[0] : null;
  }
  async pendingCredits(userId: string) { return (this.credits.get(userId) ?? []).filter((c) => !c.applied).map((c) => ({ id: c.id, amount: c.amount })); }
  async markCreditsApplied(ids: string[]) { for (const list of this.credits.values()) for (const c of list) if (ids.includes(c.id)) c.applied = true; }
  async creditReferrer() { this.referrerCredited++; }
}

export interface WebhookRun { fails: string[]; deliveries: number; statuses: Record<number, number> }
// Plays one scenario: Stripe's truth changes step by step, each change makes its events, the events are delivered as the
// scenario says; checks the row against the truth after each step and at the end.
export async function playWebhook(sc: WebhookScenario, o: {
  store: WebhookStore & { hold?: MemStore["hold"] }; fake: FakeStripe; clock: { t: number }; deliver?: (req: Request) => Promise<Response>;
  read: (user: string) => Promise<Partial<SyncRow> | null>; setupRow: (user: string, row: Partial<SyncRow>) => Promise<void>; addProfile: (user: string) => Promise<void>;
  addCredits: (user: string, amounts: number[]) => Promise<void>; creditsApplied: (user: string) => Promise<number>;
  setHold: (fn: ((row: SyncRow) => Promise<void>) | null) => void;
}): Promise<WebhookRun> {
  const fails: string[] = [];
  const name = `#${sc.id} [${sc.changes.join(">")}/${sc.delivery}/${sc.who}/${sc.badSig}${sc.credits.length ? "/credits" : ""}]`;
  const fail = (m: string) => fails.push(`${name} ${m}`);
  const statuses: Record<number, number> = {};
  const r = rng(sc.id * 7919 + 17);
  const { fake, clock } = o;
  const now = () => (clock.t += 1000);
  const stripe = webhookStripe(fake.fetch, STRIPE_KEY, { timeoutMs: 50 });
  const deliver = o.deliver ?? ((req: Request) => handleStripeWebhook(req, { secret: WEBHOOK_SECRET, stripe, store: o.store, now: () => clock.t }));
  const user = sc.user, other = sc.other, customer = sc.customer;
  const attaches = ["own", "customer_meta_only", "row_only"].includes(sc.who);
  // ---- the people and the customer
  if (sc.who !== "no_such_user") await o.addProfile(user);
  await o.addProfile(other);
  const subMeta: Record<string, string> = ["own", "foreign_customer", "no_such_user"].includes(sc.who) ? { supabase_user_id: user } : {};
  fake.customers.set(customer, { id: customer, metadata: ["own", "customer_meta_only", "foreign_customer", "no_such_user"].includes(sc.who) ? { supabase_user_id: user } : {}, deleted: sc.who === "deleted_customer" });
  if (sc.who === "row_only") await o.setupRow(user, { status: "incomplete", stripe_customer_id: customer });
  let otherRow: Partial<SyncRow> | null = null;
  if (sc.who === "foreign_customer") {
    await o.setupRow(other, { status: "active", stripe_customer_id: customer, stripe_subscription_id: `sub_other${sc.id}`, current_period_end: "2026-12-01T00:00:00.000Z" });
    otherRow = await o.read(other);
  }
  if (sc.credits.length) await o.addCredits(user, sc.credits);
  // ---- truth
  let n = 0, current: FakeSub | null = null;
  const base = Math.floor(NOW / 1000);
  const newSub = (status: string): FakeSub => {
    n++;
    const start = Math.floor(clock.t / 1000);
    return { id: `sub_wh${sc.id}_${n}`, customer, status, cancel_at_period_end: false, cancel_at: null, current_period_start: start, current_period_end: start + 30 * 86400,
      created: start, metadata: { ...subMeta }, price: { unit_amount: 1000, currency: "usd", interval: "month" }, quantity: 1 };
  };
  void base;
  type Ev = { body: string; sub: string; step: number };
  const events: Ev[] = [];
  let evn = 0;
  const emit = (type: string, sub: FakeSub, step: number) => { evn++; events.push({ body: JSON.stringify(eventFor(type, sub, Math.floor(clock.t / 1000), sc.id * 100 + evn)), sub: sub.id, step }); };
  const kind = sc.eventTypes[0];
  const steps: Ev[][] = [];
  for (const [i, ch] of sc.changes.entries()) {
    now();
    const before = events.length;
    const upd = (s: FakeSub) => emit(kind === "invoice" ? "invoice.payment_succeeded" : "customer.subscription.updated", s, i);
    switch (ch) {
      case "checkout": current = newSub("active"); fake.subs.set(current.id, current); emit(kind === "checkout" ? "checkout.session.completed" : "customer.subscription.created", current, i); if (kind === "invoice") emit("invoice.payment_succeeded", current, i); break;
      case "incomplete_expired": current = newSub("incomplete"); fake.subs.set(current.id, current); emit("customer.subscription.created", current, i); current.status = "incomplete_expired"; emit("customer.subscription.updated", current, i); break;
      case "cancel_at_end": current!.cancel_at_period_end = true; current!.cancel_at = current!.current_period_end; upd(current!); break;
      case "undo_cancel": current!.cancel_at_period_end = false; current!.cancel_at = null; upd(current!); break;
      case "renew": current!.current_period_start = current!.current_period_end; current!.current_period_end += 30 * 86400; upd(current!); emit("invoice.payment_succeeded", current!, i); break;
      case "past_due": current!.status = "past_due"; upd(current!); emit("invoice.payment_failed", current!, i); break;
      case "recover": current!.status = "active"; upd(current!); emit("invoice.paid", current!, i); break;
      case "unpaid": current!.status = "unpaid"; upd(current!); break;
      case "delete_at_end": case "delete_now": current!.status = "canceled"; current!.cancel_at_period_end = ch === "delete_at_end"; emit("customer.subscription.deleted", current!, i); break;
      case "resubscribe": current = newSub("active"); fake.subs.set(current.id, current); emit(kind === "checkout" ? "checkout.session.completed" : "customer.subscription.created", current, i); break;
      case "price_yearly": current!.price = { unit_amount: 10000, currency: "usd", interval: "year" }; upd(current!); break;
      case "price_eur": current!.price = { unit_amount: 900, currency: "eur", interval: "month" }; upd(current!); break;
      case "quantity_2": current!.quantity = 2; upd(current!); break;
    }
    steps.push(events.slice(before));
    // ---- deliver this step's events (the delivery mode decides how)
    const send = async (ev: Ev, bad: typeof sc.badSig = "none") => {
      const req = await signedRequest(ev.body, clock.t, bad);
      const res = await deliver(req);
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      await res.body?.cancel().catch(() => {});
      return res.status;
    };
    const mine = steps[i];
    const late: Ev[] = [];
    if (sc.delivery === "in_order" || sc.delivery === "late_replay") for (const ev of mine) { const st = await send(ev); if (st !== 200) fail(`delivery answered ${st}`); }
    else if (sc.delivery === "duplicated") {
      for (const ev of mine) { const [a, b] = await Promise.all([send(ev), send(ev)]); if (a !== 200 || b !== 200) fail(`duplicate delivery answered ${a}/${b}`); }
    } else if (sc.delivery === "shuffled") {
      // A random part of this step's events now, in random order; the rest after a later step.
      const order = [...mine].sort(() => r.next() - 0.5);
      for (const ev of order) if (r.next() < 0.5) late.push(ev); else if (await send(ev) !== 200) fail("shuffled delivery not 200");
      (steps as any).late = [...((steps as any).late ?? []), ...late];
      for (const ev of [...((steps as any).late as Ev[])].filter((e) => e.step < i)) { if (await send(ev) !== 200) fail("late delivery not 200"); (steps as any).late = ((steps as any).late as Ev[]).filter((x) => x !== ev); }
    } else if (sc.delivery === "concurrent_slow") {
      // A slower handler reads Stripe first and writes last; a faster one, for the same subscription after a further
      // change, reads and writes in between. The slower write must be refused (or be the same truth).
      for (const ev of mine) {
        let release!: () => void;
        const gate = new Promise<void>((res) => release = res);
        let held = false;
        let reached!: () => void;
        const atStore = new Promise<void>((res) => reached = res);
        o.setHold(async () => { if (!held) { held = true; reached(); await gate; } });
        const slow = send(ev);
        await Promise.race([atStore, slow]);
        o.setHold(null);
        if (held && current && current.status !== "canceled") {
          now();
          current.cancel_at_period_end = !current.cancel_at_period_end; current.cancel_at = current.cancel_at_period_end ? current.current_period_end : null;
          const fast = { body: JSON.stringify(eventFor("customer.subscription.updated", current, Math.floor(clock.t / 1000), sc.id * 100 + 99)), sub: current.id, step: i };
          if (await send(fast) !== 200) fail("fast delivery not 200");
        }
        release();
        if (await slow !== 200) fail("slow delivery not 200");
      }
    } else if (sc.delivery === "stripe_down_then_retry") {
      for (const ev of mine) {
        fake.mode = r.next() < 0.5 ? "5xx" : "timeout";
        const st = await send(ev);
        if (st !== 500) fail(`Stripe down answered ${st}, want 500 (Stripe retries)`);
        fake.mode = "ok";
        if (await send(ev) !== 200) fail("retry not 200");
      }
    }
    // A bad signature at a random step: a 400 and nothing changes.
    if (sc.badSig !== "none" && i === Math.floor(sc.changes.length / 2) && mine.length) {
      const before = JSON.stringify(await o.read(user));
      const st = await send(mine[0], sc.badSig);
      if (sc.badSig === "extra_v1") { if (st !== 200) fail(`a valid v1 among others answered ${st}`); }
      else {
        if (st !== 400) fail(`bad signature (${sc.badSig}) answered ${st}`);
        if (JSON.stringify(await o.read(user)) !== before) fail(`bad signature (${sc.badSig}) changed the row`);
      }
    }
    // After every step whose events all arrived, the row is that step's truth.
    const caughtUp = !(sc.delivery === "shuffled" && ((steps as any).late ?? []).length);
    if (attaches && caughtUp && current) await same(`after ${ch}`);
  }
  // Everything still late arrives; then old events are replayed.
  for (const ev of ((steps as any).late ?? []) as Ev[]) { const req = await signedRequest(ev.body, clock.t, "none"); const res = await deliver(req); await res.body?.cancel().catch(() => {}); if (res.status !== 200) fail("late delivery not 200"); }
  if (sc.delivery === "late_replay" || sc.delivery === "shuffled") {
    for (let k = 0; k < 3 && events.length; k++) {
      const ev = events[Math.floor(r.next() * events.length)];
      now();
      const req = await signedRequest(ev.body, clock.t, "none");
      const res = await deliver(req); await res.body?.cancel().catch(() => {});
      if (res.status !== 200) fail(`replay answered ${res.status}`);
    }
  }
  // ---- the end state
  if (attaches && current) await same("at the end");
  if (!attaches) {
    if (await o.read(user)) fail(`a row for ${sc.who}: ${JSON.stringify(await o.read(user))}`);
  }
  if (sc.who === "foreign_customer" && JSON.stringify(await o.read(other)) !== JSON.stringify(otherRow)) fail("the other person's row changed");
  if (sc.who !== "foreign_customer" && sc.who !== "row_only" && await o.read(other)) fail("a row for the other person");
  // Credits: once, in full, only after an active state was written for this person.
  const bal = fake.balance.get(customer) ?? 0;
  const want = -sc.credits.reduce((s, c) => s + Math.round(c * 100), 0);
  const wasActive = attaches && events.length > 0 && sc.changes.some((c) => c === "checkout" || c === "recover" || c === "resubscribe");
  void wasActive;
  if (sc.credits.length && attaches) {
    // Applied when an active state was written: exactly once, in full, and marked; never partly or twice.
    if (bal !== 0 && bal !== want) fail(`referral credit on the balance ${bal}, want ${want} (once) or none`);
    if ((bal === want) !== (await o.creditsApplied(user) === sc.credits.length)) fail(`credits marked ${await o.creditsApplied(user)}, balance ${bal}`);
    if (current?.status === "active" && bal !== want) fail(`an active plan and the credit never applied (${bal})`);
  } else if (bal !== 0) fail(`a credit applied for ${sc.who}: ${bal}`);
  // Stripe calls: the key, the pinned version, and only these.
  for (const c of fake.calls) {
    if (c.auth !== `Bearer ${STRIPE_KEY}` || c.version !== "2023-10-16") fail(`a Stripe call without the key or version: ${c.path}`);
    if (!(c.method === "GET" && /^\/v1\/(?:subscriptions|customers)\/[A-Za-z0-9_]+$/.test(c.path)) && !(c.method === "GET" && /^\/v1\/subscriptions\?customer=[A-Za-z0-9_]+&status=all&limit=100$/.test(c.path))
      && !(c.method === "GET" && /^\/v1\/subscriptions\/search\?query=metadata%5B%27supabase_user_id%27%5D%3A%27[0-9a-f-]+%27&limit=100$/.test(c.path)) && !(c.method === "POST" && /^\/v1\/customers\/[A-Za-z0-9_]+\/balance_transactions$/.test(c.path))) fail(`an unexpected Stripe call: ${c.method} ${c.path}`);
  }
  return { fails, deliveries: Object.values(statuses).reduce((a, b) => a + b, 0), statuses };

  async function same(when: string) {
    const got = await o.read(user);
    const want = rowFrom(fake.subJson(current!), user, "x");
    if (!got || !want) { fail(`${when}: no row (want ${current!.status})`); return; }
    for (const k of ["status", "stripe_subscription_id", "stripe_customer_id", "cancel_at_period_end", "current_period_end", "price_cents"] as const) {
      const a = k === "current_period_end" ? (got[k] ? Date.parse(String(got[k])) : null) : got[k];
      const b = k === "current_period_end" ? (want[k] ? Date.parse(String(want[k])) : null) : want[k];
      if (a !== b) fail(`${when}: row ${k} ${JSON.stringify(got[k])}, Stripe says ${JSON.stringify(want[k])}`);
    }
    if (got.price_cents === 1000 && want.price_cents !== 1000) fail(`${when}: an assumed $10`);
  }
}

