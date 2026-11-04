// Billing and cancel-by-text at scale (battery 2026-10-30): ~10,000 generated scenarios (tests/architect/scenarios/
// billing-generator.ts, seeded), pure, on a fixed clock (NOW), with FakeStripe at the HTTP boundary (the product's own
// adapters call it). Extends tests/architect/scenarios-billing-research.test.ts (prices, receipts, Stripe faults); the
// sampled run through the real handlers on real Postgres is tests/architect/flow-scenarios-billing-cancel.test.ts.
//
// TEXT (career_billing.ts billingTurn, the thread's last word kept as the handler keeps it):
//   - only a clear cancel ask is billing's cancel ask, and every clear one is (never the model: a deterministic answer
//     exists); look-alikes ("cancel that", "stop", STOP, "cancel my application", "cancel the interview", "unsubscribe
//     from alerts" ...) never ask, never wait, never reach Stripe, alone or as the answer to an ask;
//   - the ask says exactly what happens: the Trainee plan (the row's price), at the end of the current billing period,
//     the row's period end when it is still ahead, and how to approve; nothing is cancelled until an exact yes;
//   - "cancel" with nothing to cancel says so; a double yes and two yeses at once cancel once at Stripe; a yes on a
//     thread whose pending ask is someone else's never touches their plan (or the sender's);
//   - undo before the period end works (one approved step); after it, it is said to have ended; cancel/undo/cancel in
//     one period and an undo made at Stripe in between end cancelled at Stripe whenever "Done" is said
//     (Stripe replays a reused idempotency key without applying it);
//   - "Done" is said only when Stripe's truth matches it; status and price answers come from the row, and a period end
//     already past is never promised as the future (next charge, access until);
//   - card numbers, security codes and bank details are removed before anything sees them.
// WEBHOOK (stripe_webhook.ts handleStripeWebhook, the store's write semantics = billing_sync_subscription, which the flow
// run checks on Postgres):
//   - a bad signature (missing, another secret, stale, from the future, tampered body, v0 only, garbage) is a 400 and
//     changes nothing; a valid v1 among others is accepted;
//   - in order, shuffled, duplicated (also at once), replayed late, raced by a slower handler, or retried after Stripe
//     was down: the row ends as Stripe's truth for the person's current subscription (status, period end,
//     cancel_at_period_end), and after every step where the step's events arrived, it is that step's truth;
//   - an old subscription's end never replaces the live one; past_due, unpaid and deletion are written as Stripe says;
//     access (a live status) lasts until Stripe ends it at the period end;
//   - an unknown customer, a deleted customer or a person who does not exist attaches to nobody; a customer that is
//     another person's never lands on this person's row, and theirs is untouched;
//   - the price and plan are the subscription's own (never an assumed $10); referral credits reach the balance once.
// No model, Stripe or network call: every boundary is a fake.
import assertNode from "node:assert/strict";
import {
  CANCEL_ASKS, cancellable, FakeStripe, type FakeSub, NOT_CANCEL, NOW, RESUME_ASKS, resumable, rng, signedRequest,
  STATUS_ASKS, STRIPE_KEY, stripeTruth, textScenarios, webhookScenarios, WEBHOOK_SECRET,
} from "./scenarios/billing-generator.ts";
import { MemStore, playWebhook } from "./scenarios/billing-webhook-play.ts";
import { factsOk, fmtDay, REFUND_PROMISE, RETENTION } from "./scenarios/billing-check.ts";
import {
  BILLING_CANCEL_INTENT, BILLING_RESUME_INTENT, billingAsk, type BillingStore, billingTurn, cancelHash, stripeFromEnv, type Subscription,
} from "../../supabase/functions/_shared/career_billing.ts";
import { handleStripeWebhook, webhookStripe } from "../../supabase/functions/_shared/stripe_webhook.ts";
import { redactIdentity } from "../../supabase/functions/_shared/identity_redact.ts";

const TEXT_COUNT = 6000, WEBHOOK_COUNT = 4000;
type Turn = Awaited<ReturnType<typeof billingTurn>>;

// ================================================================================================ text world
function textWorld(row: Subscription | null, userId = "5e7a1c00-0000-4000-8000-00000000b001") {
  const fake = new FakeStripe();
  const truth = stripeTruth(row, userId);
  if (truth) fake.subs.set(truth.id, truth);
  const state = { row: row ? { ...row } : null as Subscription | null, last: null as Record<string, unknown> | null, marked: 0, kept: 0 };
  const store: BillingStore = {
    subscription: async () => state.row ? { ...state.row } : null,
    lastMeta: async () => state.last,
    markCancelling: async (_u, id) => { state.marked++; if (state.row?.stripe_subscription_id === id) state.row = { ...state.row, cancel_at_period_end: true }; },
    markKept: async (_u, id) => { state.kept++; if (state.row?.stripe_subscription_id === id) state.row = { ...state.row, cancel_at_period_end: false }; },
  };
  const stripe = stripeFromEnv(fake.fetch, STRIPE_KEY, { timeoutMs: 50 });
  const turn = (message: string) => billingTurn({ message, userId, threadId: "t-bc", now: NOW, store, stripe });
  const keep = (r: Turn) => { state.last = r ? { intent: r.intent, ...(r.meta ?? {}) } : null; return r; };
  return { fake, state, truth, say: async (m: string) => keep(await turn(m)), turn, keep };
}

Deno.test(`cancel-by-text phrasings: every clear ask is billing's (no model call), every look-alike is left alone (${CANCEL_ASKS.length + STATUS_ASKS.length + RESUME_ASKS.length} asks, ${NOT_CANCEL.length} look-alikes, x12 variants)`, () => {
  const r = rng(30);
  const fails: string[] = [];
  for (const [list, want] of [[CANCEL_ASKS, "cancel"], [STATUS_ASKS, "price"], [RESUME_ASKS, "resume"]] as const) {
    for (const a of list) for (let i = 0; i < 12; i++) {
      const t = i === 0 ? a : variant(r, a);
      const got = billingAsk(t)?.kind ?? null;
      if (got !== want) fails.push(`${JSON.stringify(t)}: want ${want}, got ${got}`);
    }
  }
  for (const a of NOT_CANCEL) for (let i = 0; i < 12; i++) {
    const t = i === 0 ? a : variant(r, a);
    const got = billingAsk(t)?.kind ?? null;
    if (got === "cancel" || got === "resume" || got === "refund") fails.push(`a look-alike read as ${got}: ${JSON.stringify(t)}`);
  }
  if (fails.length) throw new Error(`${fails.length} misread:\n${[...new Set(fails)].slice(0, 60).join("\n")}`);
});
function variant(r: ReturnType<typeof rng>, s: string) {
  let t = s;
  const c = r.next();
  if (c < 0.2) t = t.toUpperCase(); else if (c < 0.45) t = t.charAt(0).toUpperCase() + t.slice(1);
  const p = r.next();
  if (p < 0.2) t = `${t}?`; else if (p < 0.35) t = `${t}.`; else if (p < 0.4) t = `${t}!`;
  if (r.next() < 0.1) t = `hey ${t}`;
  if (r.next() < 0.1) t = t.replace(/'/g, "’");
  return t;
}

const TEXT = textScenarios(20261030, TEXT_COUNT);
Deno.test({
  name: `cancel-by-text at scale: ${TEXT_COUNT} generated scenarios (row states x asks x answers x Stripe faults, fixed clock): only a clear yes to an exact confirmation cancels, once; undo before the period end; Done only when true; facts only from the row`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const logs: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    const fails: string[] = [];
    const tally: Record<string, number> = {};
    let turns = 0;
    try {
      for (const sc of TEXT) {
        const w = textWorld(sc.row);
        w.fake.mode = sc.mode;
        const name = `#${sc.id} [${sc.rowKind}/${sc.mode}/${sc.script.kind}]`;
        const fail = (m: string) => fails.push(`${name} ${m}`);
        const replies: { said: string; r: Turn }[] = [];
        const say = async (m: string) => { const r = await w.say(m); turns++; replies.push({ said: m, r }); check(m, r); return r; };
        const check = (said: string, r: Turn) => {
          if (!r) return;
          const sub = w.truth ? w.fake.subs.get(w.truth.id)! : null;
          if (/^Done, your plan is cancelled/.test(r.reply) && sub?.cancel_at_period_end !== true) fail(`"Done, cancelled" while Stripe still renews: ${JSON.stringify(said)} -> ${r.reply}`);
          if (/^Done, your plan is kept/.test(r.reply) && sub?.cancel_at_period_end !== false) fail(`"Done, kept" while Stripe still ends it: ${r.reply}`);
          if (RETENTION.test(r.reply)) fail(`retention words: ${r.reply}`);
          if (REFUND_PROMISE.test(r.reply)) fail(`a refund promised: ${r.reply}`);
          if (r.reply.includes(STRIPE_KEY) || /sk_(?:test|live)_/.test(r.reply)) fail(`the key in a reply`);
          // Dates and amounts from the row, or from Stripe's own record (the subscription's period end it answered with).
          const stripeSaid = sub ? { ...sc.row!, current_period_end: new Date(sub.current_period_end * 1000).toISOString() } : null;
          const bad = factsOk(r.reply, [sc.row, w.state.row, stripeSaid], [], new Set());
          if (bad) fail(`${JSON.stringify(said)}: ${bad}: ${r.reply}`);
          // A period end already past is never promised as ahead.
          for (const row of [sc.row, w.state.row]) {
            const end = row?.current_period_end ? Date.parse(row.current_period_end) : NaN;
            if (Number.isFinite(end) && end <= NOW) {
              const d = fmtDay(end);
              if (new RegExp(`(?:Next charge: |access until |no charge after |renews on )${d.replace(/[.,]/g, "\\$&")}`).test(r.reply)) fail(`a past period end promised as ahead: ${r.reply}`);
            }
          }
        };
        const s = sc.script;
        tally[s.kind] = (tally[s.kind] ?? 0) + 1;
        const postsTo = (id: string | null | undefined) => id ? w.fake.posts(`/v1/subscriptions/${id}`) : [];
        const subId = sc.row?.stripe_subscription_id ?? null;
        const askCheck = (r: Turn, ask: string) => {
          if (!r) { fail(`clear cancel ask not answered: ${JSON.stringify(ask)}`); return; }
          if (cancellable(sc.row)) {
            if (r.intent !== BILLING_CANCEL_INTENT) fail(`a cancellable plan not asked: ${r.reply}`);
            if (!/This cancels your Trainee plan/.test(r.reply) || !/at the end of the current billing period/.test(r.reply) || !/Reply "yes" to cancel\.$/.test(r.reply)) fail(`the confirmation does not say exactly what happens: ${r.reply}`);
            const end = sc.row!.current_period_end ? Date.parse(sc.row!.current_period_end) : NaN;
            if (Number.isFinite(end) && end > NOW && !r.reply.includes(fmtDay(end))) fail(`the confirmation does not state the row's period end: ${r.reply}`);
          } else {
            if (r.meta) fail(`an ask with nothing to cancel: ${r.reply}`);
            if ((!sc.row || !sc.row.stripe_subscription_id || ["incomplete", "incomplete_expired"].includes(sc.row.status)) && !/not subscribed.*nothing to cancel/.test(r.reply)) fail(`no subscription not said honestly: ${r.reply}`);
          }
        };
        const expectCancelled = (want: boolean, why: string) => {
          const sub = w.truth ? w.fake.subs.get(w.truth.id) : null;
          if (sub && sub.cancel_at_period_end !== want) fail(`${why}: Stripe cancel_at_period_end ${sub.cancel_at_period_end}, want ${want}`);
        };
        const okMode = sc.mode === "ok";
        if (s.kind === "control") {
          const r = await say(s.text);
          if (r?.meta || r?.intent === BILLING_CANCEL_INTENT || r?.intent === BILLING_RESUME_INTENT) fail(`a look-alike asked to cancel: ${JSON.stringify(s.text)} -> ${r.reply}`);
          if (w.fake.posts().length) fail(`a look-alike reached Stripe: ${JSON.stringify(s.text)}`);
          await say("yes");
          if (w.fake.posts().length) fail(`a yes after a look-alike reached Stripe: ${JSON.stringify(s.text)}`);
        } else if (s.kind === "control_after_ask") {
          askCheck(await say(s.ask), s.ask);
          const r = await say(s.text);
          if (r && /^Done/.test(r.reply)) fail(`a look-alike answer approved: ${JSON.stringify(s.text)} -> ${r.reply}`);
          if (w.fake.posts().length) fail(`a look-alike answer reached Stripe: ${JSON.stringify(s.text)}`);
          expectCancelled(sc.row?.cancel_at_period_end === true, "a look-alike answer");
        } else if (s.kind === "cancel") {
          askCheck(await say(s.ask), s.ask);
          if (postsTo(subId).length) fail("the ask itself reached Stripe");
          const r = await say(s.answer);
          const want = s.cls === "yes" && cancellable(sc.row);
          if (!want && postsTo(subId).length) fail(`${JSON.stringify(s.answer)} (${s.cls}) reached Stripe`);
          if (want && okMode) {
            expectCancelled(true, "a clear yes");
            if (!/^Done, your plan is cancelled/.test(r?.reply ?? "")) fail(`a clear yes not done: ${r?.reply}`);
            if (w.state.marked !== 1) fail(`row marked ${w.state.marked} times`);
            const key = await cancelHash(subId!, sc.row!.current_period_end);
            for (const c of postsTo(subId)) if (c.idem !== key || c.body !== "cancel_at_period_end=true") fail(`cancel call ${c.idem} ${c.body}`);
          }
          if (s.cls !== "yes") expectCancelled(sc.row?.cancel_at_period_end === true, `${s.cls} answer`);
          if (!okMode && w.state.marked) fail(`row marked without Stripe's confirmation (${sc.mode})`);
        } else if (s.kind === "double_yes") {
          askCheck(await say(s.ask), s.ask);
          await say(s.answer);
          const r2 = await say(s.answer);
          if (cancellable(sc.row) && okMode) {
            expectCancelled(true, "double yes");
            if (r2 && /^Done/.test(r2.reply)) fail(`a second yes said done again: ${r2.reply}`);
            const effective = postsTo(subId).filter((c) => !c.replayed && c.status === 200).length;
            if (effective !== 1) fail(`Stripe applied the cancel ${effective} times`);
          }
          if (!cancellable(sc.row) && postsTo(subId).length) fail("a double yes on nothing cancellable reached Stripe");
        } else if (s.kind === "concurrent_yes") {
          askCheck(await say(s.ask), s.ask);
          const [a, b] = await Promise.all([w.turn(s.answer), w.turn(s.answer)]);
          turns += 2;
          check(s.answer, a); check(s.answer, b);
          w.keep(b);
          if (cancellable(sc.row) && okMode) {
            expectCancelled(true, "two yeses at once");
            const keys = new Set(postsTo(subId).map((c) => c.idem));
            if (keys.size !== 1) fail(`two yeses at once used ${keys.size} keys`);
            const effective = postsTo(subId).filter((c) => !c.replayed && c.status === 200).length;
            if (effective !== 1) fail(`two yeses at once applied ${effective} times`);
          }
          if (!cancellable(sc.row) && postsTo(subId).length) fail("concurrent yes on nothing cancellable reached Stripe");
        } else if (s.kind === "status") {
          const r = await say(s.ask);
          if (!r) fail(`a status ask left to the model: ${JSON.stringify(s.ask)}`);
          if (w.fake.calls.length) fail("a status ask called Stripe");
          if (r && sc.row?.cancel_at_period_end && ["active", "trialing"].includes(sc.row.status) && /Next charge/i.test(r.reply)) fail(`a next charge on an ending plan: ${r.reply}`);
          if (r && sc.row?.cancel_at_period_end && ["active", "trialing"].includes(sc.row.status) && sc.row.current_period_end && Date.parse(sc.row.current_period_end) <= NOW && !/ended on/.test(r.reply)) fail(`a plan past its end not said to have ended: ${r.reply}`);
        } else if (s.kind === "resume") {
          const ask = await say(s.ask);
          if (!ask) { fail(`resume ask not answered: ${JSON.stringify(s.ask)}`); continue; }
          if (resumable(sc.row)) {
            if (ask.intent !== BILLING_RESUME_INTENT || !/Reply "yes" to keep your plan\.$/.test(ask.reply) || !/Nothing changed yet/.test(ask.reply)) fail(`an undo before the period end not offered: ${ask.reply}`);
          } else if (ask.meta) fail(`an undo offered with nothing to undo: ${ask.reply}`);
          if (postsTo(subId).length) fail("the undo ask itself reached Stripe");
          const r = await say(s.answer);
          if (resumable(sc.row) && s.cls === "yes" && okMode) {
            expectCancelled(false, "a clear yes to undo");
            if (!/^Done, your plan is kept/.test(r?.reply ?? "")) fail(`a clear yes to undo not done: ${r?.reply}`);
            if (w.state.row?.cancel_at_period_end !== false) fail("the row still says ending after the undo");
          } else if (!(resumable(sc.row) && s.cls === "yes")) {
            if (postsTo(subId).length) fail(`${JSON.stringify(s.answer)} after an undo ask reached Stripe`);
            expectCancelled(sc.row?.cancel_at_period_end === true, "no undo");
          }
        } else if (s.kind === "cycle") {
          if (!cancellable(sc.row)) { await say(s.cancel); continue; }
          askCheck(await say(s.cancel), s.cancel); await say("yes"); expectCancelled(true, "cycle: first cancel");
          const ra = await say(s.resume);
          if (future(sc.row) || !sc.row!.current_period_end) {
            if (ra?.intent !== BILLING_RESUME_INTENT) fail(`cycle: undo not offered: ${ra?.reply}`);
            await say("yes"); expectCancelled(false, "cycle: undo");
            askCheck(await say(s.cancel), s.cancel);
            const r3 = await say("yes");
            expectCancelled(true, "cycle: cancel again");
            if (!/^Done, your plan is cancelled/.test(r3?.reply ?? "")) fail(`cycle: second cancel not done: ${r3?.reply}`);
          }
        } else if (s.kind === "stripe_undo") {
          if (!cancellable(sc.row)) { await say(s.ask); continue; }
          await say(s.ask); await say("yes");
          // Undone at Stripe (dashboard, support), and the webhook wrote it to the row.
          const sub = w.fake.subs.get(subId!)!;
          sub.cancel_at_period_end = false; sub.cancel_at = null;
          w.state.row = { ...w.state.row!, cancel_at_period_end: false };
          askCheck(await say(s.ask), s.ask);
          const r = await say("yes");
          expectCancelled(true, "cancel again after an undo at Stripe");
          if (!/^Done, your plan is cancelled/.test(r?.reply ?? "")) fail(`cancel again not done: ${r?.reply}`);
        } else if (s.kind === "other_person") {
          // The thread's last word is an ask shown to someone else (their subscription, their hash).
          const theirs: FakeSub = { ...stripeTruth({ ...textRowForOther(), }, "5e7a1c00-0000-4000-8000-00000000b0ff")! };
          w.fake.subs.set(theirs.id, theirs);
          w.state.last = { intent: BILLING_CANCEL_INTENT, billing_cancel: { subscription_id: theirs.id, period_end: textRowForOther().current_period_end, hash: await cancelHash(theirs.id, textRowForOther().current_period_end) } };
          await say(s.answer);
          if (w.fake.posts(`/v1/subscriptions/${theirs.id}`).length) fail("someone else's subscription reached Stripe");
          if (theirs.cancel_at_period_end) fail("someone else's plan cancelled");
          if (postsTo(subId).length) fail("the sender's plan cancelled without an ask shown to them");
        } else if (s.kind === "payment") {
          const red = redactIdentity(s.text);
          for (const secret of s.secrets) {
            const digits = secret.replace(/\D/g, "");
            const kept = red.text.includes(secret) || (digits.length >= 3 && new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(red.text.replace(/(?<=\d)[ -](?=\d)/g, "")));
            if (kept) fail(`payment detail kept: ${JSON.stringify(secret)} in ${JSON.stringify(red.text)}`);
          }
          if (!red.removed.some((x) => x === "card" || x === "account")) fail(`nothing removed from ${JSON.stringify(s.text)}`);
          const r = await say(red.text);
          if (r && s.secrets.some((x) => r.reply.includes(x))) fail(`a payment detail in a reply`);
          if (w.fake.posts().length) fail("a payment message reached Stripe");
        }
        void replies;
      }
    } finally {
      Object.assign(console, orig);
    }
    for (const l of logs) if (l.includes(STRIPE_KEY)) { fails.push(`the key in a log line: ${l.slice(0, 200)}`); break; }
    console.log(`[cancel-by-text scenarios] ${TEXT.length} scenarios, ${turns} turns; ${Object.entries(tally).sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (fails.length) throw new Error(`${fails.length} cancel-by-text failures:\n${[...new Set(fails)].slice(0, 60).join("\n")}`);
  },
});
const future = (s: Subscription | null) => !!s?.current_period_end && Date.parse(s.current_period_end) > NOW;
function textRowForOther(): Subscription {
  return { status: "active", plan: "monthly", price_cents: 1000, current_period_start: "2026-10-27T15:00:00.000Z", current_period_end: "2026-11-27T15:00:00.000Z",
    stripe_customer_id: "cus_someone_else", stripe_subscription_id: "sub_someone_else", cancel_at_period_end: false };
}

const WEBHOOK = webhookScenarios(20261031, WEBHOOK_COUNT);
Deno.test({
  name: `stripe webhook at scale: ${WEBHOOK_COUNT} generated scenarios (changes x delivery order x who x signatures x credits): verified, never corrupted, never the wrong person, price as Stripe says, credits once`,
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
        const store = new MemStore();
        const fake = new FakeStripe();
        const clock = { t: NOW };
        const res = await playWebhook(sc, {
          store, fake, clock,
          read: async (u) => { const r = store.rows.get(u); return r ? { ...r, synced_at: undefined } as any : null; },
          setupRow: async (u, row) => { store.rows.set(u, { user_id: u, status: "incomplete", plan: "monthly", price_cents: 1000, current_period_start: null, current_period_end: null, stripe_customer_id: "", stripe_subscription_id: "", cancel_at_period_end: false, synced_at: null as any, ...row } as any); },
          addProfile: async (u) => { store.profiles.add(u); },
          addCredits: async (u, amounts) => { store.credits.set(u, amounts.map((a, i) => ({ id: `rc_${sc.id}_${i}`, amount: a, applied: false }))); },
          creditsApplied: async (u) => (store.credits.get(u) ?? []).filter((c) => c.applied).length,
          setHold: (fn) => { store.hold = fn; },
        });
        fails.push(...res.fails);
        deliveries += res.deliveries;
        tally[sc.delivery] = (tally[sc.delivery] ?? 0) + 1;
        tally[`who:${sc.who}`] = (tally[`who:${sc.who}`] ?? 0) + 1;
        for (const w of store.writes) tally[`sync:${w.result}`] = (tally[`sync:${w.result}`] ?? 0) + 1;
      }
    } finally {
      Object.assign(console, orig);
    }
    for (const l of logs) if (l.includes(STRIPE_KEY) || l.includes(WEBHOOK_SECRET)) { fails.push(`a secret in a log line: ${l.slice(0, 160)}`); break; }
    console.log(`[webhook scenarios] ${WEBHOOK.length} scenarios, ${deliveries} deliveries; ${Object.entries(tally).sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (fails.length) throw new Error(`${fails.length} webhook failures:\n${[...new Set(fails)].slice(0, 60).join("\n")}`);
    // Billing round 2: the handler reads all the person's subscriptions and always writes the newest live one, so the store's
    // "other_subscription" refusal is a safety net the handler no longer reaches (the row is still checked against Stripe's
    // live subscription after every step above; tests/db/billing_webhook_sync*.test.sql check the refusal itself).
    for (const k of ["sync:stale", "sync:foreign", "sync:no_user"]) assertNode.ok((tally[k] ?? 0) > 0, `${k} exercised`);
  },
});

Deno.test("webhook: Stripe not configured is a 503; a non-POST is a 405; an event for no subscription is ignored", async () => {
  const store = new MemStore();
  const fake = new FakeStripe();
  const stripe = webhookStripe(fake.fetch, STRIPE_KEY);
  const req = await signedRequest(JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_x" } } }), NOW, "none");
  assertNode.equal((await handleStripeWebhook(req.clone(), { secret: null, stripe, store, now: () => NOW })).status, 503);
  assertNode.equal((await handleStripeWebhook(req.clone(), { secret: WEBHOOK_SECRET, stripe: null, store, now: () => NOW })).status, 503);
  assertNode.equal((await handleStripeWebhook(new Request("https://x.test/", { method: "GET" }), { secret: WEBHOOK_SECRET, stripe, store, now: () => NOW })).status, 405);
  const gone = await handleStripeWebhook(req.clone(), { secret: WEBHOOK_SECRET, stripe, store, now: () => NOW });
  assertNode.equal(gone.status, 200, "a subscription Stripe does not have: ignored, not retried forever");
  assertNode.equal(store.rows.size, 0);
  const other = await signedRequest(JSON.stringify({ type: "charge.refunded", data: { object: { id: "ch_1" } } }), NOW, "none");
  assertNode.equal((await handleStripeWebhook(other, { secret: WEBHOOK_SECRET, stripe, store, now: () => NOW })).status, 200);
  assertNode.equal(fake.calls.filter((c) => c.path.startsWith("/v1/charges")).length, 0);
});
