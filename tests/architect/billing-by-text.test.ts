// Billing and cancelling by text (owner, 2026-10-27, MASS-NETWORKING-BRIEF "Owner answers"): plain pricing in chat,
// "what am I paying", "cancel my plan" in one approved step on every channel, no dark patterns, receipts by text.
// The turn is pure and dependency-injected: a fake store (the person's user_subscriptions row and the thread's last
// reply) and a fake Stripe. Facts only from the row or from Stripe; a cancel only after an exact "yes" to the exact
// payload (subscription + period end, hash-bound), once; a link only as Stripe returned it; the key never shown.
import assertNode from "node:assert/strict";
import {
  BILLING_CANCEL_INTENT,
  billingAsk,
  type BillingStore,
  billingTurn,
  cancelHash,
  type Invoice,
  stripeFromEnv,
  type StripeBilling,
  type Subscription,
} from "../../supabase/functions/_shared/career_billing.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.UTC(2026, 9, 28, 15);
const END = "2026-11-27T15:00:00.000Z";
const KEY = "sk_test_fake_billing_0000SECRETKEYDONOTSHOW";

const row = (over: Partial<Subscription> = {}): Subscription => ({
  status: "active", plan: "monthly", price_cents: 1000, current_period_start: "2026-10-27T15:00:00.000Z", current_period_end: END,
  stripe_customer_id: "cus_fake1", stripe_subscription_id: "sub_fake1", cancel_at_period_end: false, ...over,
});

// Bare "receipts" stays the application receipts' (FEATURE 14); billing receipts are asked as such ("my invoices").
// The thread as the handler keeps it: each reply's meta is the thread's last word; any other reply (null here) clears it.
function world(sub: Subscription | null, stripe: (StripeBilling & { cancels: string[][] }) | null = fakeStripe()) {
  const state = { sub, last: null as Record<string, unknown> | null, marked: [] as string[] };
  const store: BillingStore = {
    subscription: async () => state.sub,
    lastMeta: async () => state.last,
    markCancelling: async (_u, id) => { state.marked.push(id); if (state.sub) state.sub = { ...state.sub, cancel_at_period_end: true }; },
  };
  const say = async (message: string) => {
    const r = await billingTurn({ message, userId: "u1", threadId: "t1", now: NOW, store, stripe });
    state.last = r ? { intent: r.intent, ...(r.meta ?? {}) } : null;
    return r;
  };
  return { state, store, stripe, say };
}
function fakeStripe(invoices: Invoice[] = []) {
  const cancels: string[][] = [];
  return {
    cancels,
    async cancelAtPeriodEnd(id: string, key: string) { cancels.push([id, key]); return { cancel_at_period_end: true, cancel_at: Date.parse(END) / 1000, current_period_end: Date.parse(END) / 1000 }; },
    async listInvoices(_c: string) { return invoices; },
  };
}

Deno.test("what am I paying: the person's own row, price, status and next charge", async () => {
  const w = world(row());
  for (const ask of ["what am I paying", "What am I paying?", "how much is trainee", "how much is my plan", "billing", "my plan"]) {
    const r = await w.say(ask);
    ok(r, ask);
    ok(/\$10/.test(r!.reply), `${ask}: ${r!.reply}`);
    ok(/Nov 27, 2026/.test(r!.reply), `next charge date: ${r!.reply}`);
    ok(/active/i.test(r!.reply), r!.reply);
  }
  const odd = world(row({ price_cents: 2500 }));
  ok(/\$25/.test((await odd.say("what am I paying"))!.reply), "the row's price, not a constant");
  ok(!/\$10\b/.test((await odd.say("what am I paying"))!.reply), "never a number the row does not hold");
});

Deno.test("no row: not subscribed, Trainee is $10/month; no date invented", async () => {
  const w = world(null);
  const r = await w.say("what am I paying");
  ok(/not subscribed/i.test(r!.reply), r!.reply);
  ok(/\$10\/month/.test(r!.reply), r!.reply);
  ok(!/\d{4}/.test(r!.reply), "no date");
});

Deno.test("cancel my plan: exact effect, one yes cancels exactly once", async () => {
  const w = world(row());
  const ask = await w.say("cancel my plan");
  eq(ask!.intent, BILLING_CANCEL_INTENT);
  ok(/Nov 27, 2026/.test(ask!.reply) && /yes/i.test(ask!.reply), ask!.reply);
  ok(!/(?:discount|offer|instead|pause|are you sure|we'?ll miss)/i.test(ask!.reply), "no retention offers");
  eq(w.stripe!.cancels.length, 0, "nothing cancelled by the ask");
  const hash = await cancelHash("sub_fake1", END);
  eq((ask!.meta as any).billing_cancel.hash, hash);
  const done = await w.say("yes");
  eq(w.stripe!.cancels, [["sub_fake1", hash]], "cancelled once, idempotency key = the payload hash");
  ok(/Nov 27, 2026/.test(done!.reply) && /cancel/i.test(done!.reply), done!.reply);
  eq(w.state.marked, ["sub_fake1"]);
  const again = await w.say("yes");
  eq(w.stripe!.cancels.length, 1, "a second yes calls Stripe no more");
  ok(again === null || !/cancelled your plan/i.test(again.reply));
  for (const ask2 of ["cancel my subscription", "stop charging me", "Cancel my plan please"]) ok(billingAsk(ask2)?.kind === "cancel", ask2);
});

Deno.test("anything but an exact yes approves nothing", async () => {
  for (const reply of ["maybe", "later", "wait", "no", "none", "ok", "what happens to my data?", "yes?"]) {
    const w = world(row());
    await w.say("cancel my plan");
    const r = await w.say(reply);
    eq(w.stripe!.cancels.length, 0, `${reply}: nothing cancelled`);
    if (r) ok(/nothing/i.test(r.reply) || /not cancel|keep/i.test(r.reply), `${reply}: ${r.reply}`);
    if (reply === "no") ok(r && !(r.meta as any)?.billing_cancel, "no drops the ask");
    if (reply === "maybe" || reply === "wait") ok(r && (r.meta as any)?.billing_cancel, `${reply} keeps the ask, as the reply says`);
    // A yes after "no" approves nothing: the ask is gone.
    if (reply === "no") { await w.say("yes"); eq(w.stripe!.cancels.length, 0, "yes after no cancels nothing"); }
  }
});

Deno.test("the row changed since the ask: refuse and re-ask", async () => {
  const w = world(row());
  await w.say("cancel my plan");
  w.state.sub = row({ current_period_end: "2026-12-27T15:00:00.000Z" });
  const r = await w.say("yes");
  eq(w.stripe!.cancels.length, 0, "nothing cancelled on a changed payload");
  ok(/changed/i.test(r!.reply) && /Dec 27, 2026/.test(r!.reply), r!.reply);
  eq(r!.intent, BILLING_CANCEL_INTENT, "re-asked");
  await w.say("yes");
  eq(w.stripe!.cancels.length, 1, "the re-asked payload's yes cancels it");
});

Deno.test("already cancelled is said plainly; no Stripe call", async () => {
  for (const sub of [row({ cancel_at_period_end: true }), row({ status: "canceled" })]) {
    const w = world(sub);
    const r = await w.say("cancel my plan");
    ok(/already/i.test(r!.reply), r!.reply);
    ok(!(r!.meta as any)?.billing_cancel, "nothing to approve");
    await w.say("yes");
    eq(w.stripe!.cancels.length, 0);
  }
  const p = await world(row({ cancel_at_period_end: true })).say("what am I paying");
  ok(!/next charge/i.test(p!.reply) && /Nov 27, 2026/.test(p!.reply), `no next charge once cancelled: ${p!.reply}`);
  const none = await world(null).say("cancel my plan");
  ok(/not subscribed/i.test(none!.reply) && !(none!.meta as any)?.billing_cancel, none!.reply);
});

Deno.test("receipts: only Stripe's own links, date and amount", async () => {
  const inv: Invoice[] = [
    { id: "in_1", created: Date.UTC(2026, 9, 27) / 1000, amount_paid: 1000, currency: "usd", hosted_invoice_url: "https://invoice.stripe.com/i/acct_x/one" },
    { id: "in_2", created: Date.UTC(2026, 8, 27) / 1000, amount_paid: 1000, currency: "usd", hosted_invoice_url: null },
  ];
  const w = world(row(), fakeStripe(inv));
  for (const ask of ["payment receipts", "my invoices", "what was I charged", "billing receipts", "receipts for my plan"]) {
    const r = await w.say(ask);
    ok(r, ask);
    ok(/Oct 27, 2026/.test(r!.reply) && /\$10\.00/.test(r!.reply), r!.reply);
    const urls = r!.reply.match(/https?:\/\/\S+/g) ?? [];
    eq(urls, ["https://invoice.stripe.com/i/acct_x/one"], "only the URL Stripe returned");
  }
  const empty = await world(row(), fakeStripe([])).say("my invoices");
  ok(/no paid/i.test(empty!.reply), empty!.reply);
  const nosub = await world(null, fakeStripe(inv)).say("my invoices");
  ok(!/https?:/.test(nosub!.reply), "no customer, no list");
});

Deno.test("Stripe not configured: said plainly, never invented", async () => {
  const w = world(row(), null);
  const r = await w.say("invoices");
  ok(/can'?t reach billing/i.test(r!.reply), r!.reply);
  await w.say("cancel my plan");
  const y = await w.say("yes");
  ok(/can'?t reach billing/i.test(y!.reply) && /nothing/i.test(y!.reply), y!.reply);
});

Deno.test("not billing: applications, jobs and chat are left alone", async () => {
  for (const m of ["cancel my application to Acme", "cancel my Acme application", "receipts", "show my receipts", "show me the receipt for Stripe",
    "what's my plan for this week", "how much is this job paying", "how much does a data analyst make", "yes", "stop sending me alerts", "unsubscribe"]) {
    eq(billingAsk(m), null, m);
    eq(await world(row()).say(m), null, m);
  }
});

Deno.test("the Stripe adapter: form-encoded, idempotent cancel, paid invoices; the key never in a reply or a log", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFake = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url).includes("/subscriptions/")) return new Response(JSON.stringify({ id: "sub_fake1", cancel_at_period_end: true, cancel_at: Date.parse(END) / 1000 }), { status: 200 });
    return new Response(JSON.stringify({ data: [{ id: "in_1", created: Date.UTC(2026, 9, 27) / 1000, amount_paid: 1000, currency: "usd", hosted_invoice_url: "https://invoice.stripe.com/i/a" }] }), { status: 200 });
  };
  const logs: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try {
    const s = stripeFromEnv(fetchFake as typeof fetch, KEY)!;
    const w = world(row(), s as any);
    const replies: string[] = [];
    for (const m of ["what am I paying", "cancel my plan", "yes", "my invoices"]) replies.push((await w.say(m))?.reply ?? "");
    const c = calls.find((x) => x.url.includes("/subscriptions/"))!;
    eq(c.url, "https://api.stripe.com/v1/subscriptions/sub_fake1");
    eq(c.init.method, "POST");
    eq(String(c.init.body), "cancel_at_period_end=true");
    const h = new Headers(c.init.headers);
    eq(h.get("idempotency-key"), await cancelHash("sub_fake1", END));
    eq(h.get("content-type"), "application/x-www-form-urlencoded");
    eq(h.get("authorization"), `Bearer ${KEY}`);
    const i = calls.find((x) => x.url.includes("/invoices"))!;
    eq(i.url, "https://api.stripe.com/v1/invoices?customer=cus_fake1&status=paid&limit=5&expand%5B%5D=data.charge");
    // A Stripe error that echoes the key is never repeated.
    const bad = stripeFromEnv((async () => new Response(JSON.stringify({ error: { message: `Invalid API Key provided: ${KEY}` } }), { status: 401 })) as typeof fetch, KEY)!;
    const w2 = world(row(), bad as any);
    replies.push((await w2.say("my invoices"))?.reply ?? "");
    await w2.say("cancel my plan");
    replies.push((await w2.say("yes"))?.reply ?? "");
    ok(/nothing/i.test(replies.at(-1)!), replies.at(-1));
    for (const t of [...replies, ...logs]) ok(!t.includes(KEY) && !t.includes("SECRETKEY"), `key leaked: ${t}`);
  } finally {
    Object.assign(console, orig);
  }
  eq(stripeFromEnv(fetch, ""), null, "no key, no adapter");
  eq(stripeFromEnv(fetch, undefined), null);
});
