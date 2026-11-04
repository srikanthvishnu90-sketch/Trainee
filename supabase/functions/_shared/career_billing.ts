// Billing and cancelling by text (owner, 2026-10-27: MASS-NETWORKING-BRIEF "Owner answers"). "what am I paying",
// "cancel my plan" and "my invoices" work on every channel, code's, before the router:
// - the price, status and next charge only from the person's own user_subscriptions row (no row: not subscribed);
// - a cancel is one approved step: the reply says the exact effect and binds a hash of the exact payload (subscription +
//   period end) to the thread's last word; only an exact "yes" to it cancels, once, at period end, with the hash as
//   Stripe's idempotency key. A changed row is refused and asked again. No retention offers, no detours;
// - receipts are Stripe's paid invoices with the links Stripe returned, never a constructed one.
// Stripe is reached with fetch and form encoding (no SDK); the key is read by the handler and never printed.
import { approvalWords } from "./approval_words.ts";

export const BILLING_INTENT = "career_billing";
export const BILLING_CANCEL_INTENT = "career_billing_cancel_ask";
// The plan's price for someone with no row (the $10/month the checkout and the webhook charge).
export const PLAN_PRICE_CENTS = 1000;

export interface Subscription {
  status: string;
  plan: string | null;
  price_cents: number | null;
  current_period_start?: string | null;
  current_period_end: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  cancel_at_period_end?: boolean | null;
}
export interface Invoice { id: string; created: number; amount_paid: number; currency: string; hosted_invoice_url: string | null }
export interface CancelResult { cancel_at_period_end: boolean; cancel_at?: number | null; current_period_end?: number | null }
export interface StripeBilling {
  cancelAtPeriodEnd(subscriptionId: string, idempotencyKey: string): Promise<CancelResult>;
  listInvoices(customerId: string): Promise<Invoice[]>;
}
export interface BillingStore {
  subscription(userId: string): Promise<Subscription | null>;
  // The meta of this thread's last reply (with its intent), or null.
  lastMeta(threadId: string): Promise<Record<string, unknown> | null>;
  // After Stripe accepted the cancel: the row says so until the webhook writes the same.
  markCancelling(userId: string, subscriptionId: string): Promise<void>;
}
export interface PendingCancel { subscription_id: string; period_end: string | null; hash: string }
export interface BillingTurn { reply: string; intent: string; status: string; meta?: { billing_cancel: PendingCancel } }

// ------------------------------------------------------------------------------------------------ the asks
const plain = (s: string) => String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[?!.]+\s*$/, "").replace(/\s+/g, " ").trim()
  .replace(/^(?:(?:hey|hi|ok|okay|so|please|trainee),? )+/, "").replace(/,? please$/, "").replace(/[?!.]+$/, "").trim();
// Common misspellings of the billing words, read as the word (scenarios 2026-10-29: "cancle my plan", "my invioces").
// Only these whole words change; an ask still has to match a pattern below in full.
const TYPOS: Record<string, string> = {
  cancle: "cancel", cancell: "cancel", cansel: "cancel", cancal: "cancel", cancl: "cancel", cacnel: "cancel",
  subscripton: "subscription", subcription: "subscription", subscribtion: "subscription", subsciption: "subscription", subscriptoin: "subscription",
  invioces: "invoices", invoces: "invoices", invoics: "invoices", reciepts: "receipts", recipts: "receipts", reciept: "receipt",
  payin: "paying", payng: "paying", paiyng: "paying", refnd: "refund", refud: "refund",
};
const typos = (t: string) => t.replace(/[a-z]+/g, (w) => TYPOS[w] ?? w);
const WHO = "(?:this|trainee|my plan|my subscription|the plan|the subscription)";
const MONTH = "(?: (?:a|per|each) month| monthly)?";
const PRICE: RegExp[] = [
  new RegExp(`^(?:what|how much) (?:am i|do i) (?:paying|being charged|getting charged|pay)(?: for (?:this|trainee|it|my plan|my subscription))?${MONTH}$`),
  new RegExp(`^how much (?:is|does|do i pay for|am i paying for) ${WHO}(?: cost)?${MONTH}$`),
  new RegExp(`^(?:how much does|what does) (?:trainee|my plan|my subscription|the plan|the subscription) cost${MONTH}$`),
  /^(?:what'?s|what is|show(?: me)?|check) (?:my (?:billing|subscription)|trainee'?s pricing|the pricing)$/,
  /^(?:my plan|my subscription|billing|my billing|pricing|my bill)$/,
  /^(?:what'?s|what is|how much is|show(?: me)?|check) my (?:bill|monthly bill|trainee bill)$/,
  /^what plan am i on$/,
  // The next charge (scenarios 2026-10-29): answered from the row like the price.
  /^(?:when(?:'?s| is| will be)?|what(?:'?s| is)) (?:my |the )?next (?:charge|payment|bill|billing date|renewal)(?: date)?$/,
  /^when (?:will|do|am) i (?:be |get )?(?:charged|billed)(?: next| again)?$/,
  /^when does (?:my )?(?:plan|subscription|trainee) renew$/,
  /^is trainee free$/,
];
const CANCEL: RegExp[] = [
  /^(?:i want to |i'?d like to |i wanna |can you |can i |could you |how do i |how can i |help me )?(?:cancel|end|stop) (?:my |the )?(?:trainee )?(?:plan|subscription|membership)(?: now)?$/,
  /^(?:(?:i want to|i'?d like to|how do i|how can i|can you|help me) )?cancel trainee$/,
  /^(?:stop|quit) (?:charging|billing) (?:me|my card)$/,
  /^don'?t charge me (?:again|anymore|any more)$/,
];
const RECEIPTS: RegExp[] = [
  /^(?:(?:show|send|give|get)(?: me)? |can i (?:see|get) |where are |list )?(?:my )?(?:billing|payment|trainee|subscription) (?:receipts?|invoices?|history)$/,
  /^(?:(?:show|send|give|get)(?: me)? |can i (?:see|get) |where are |list )?(?:my |the )?invoices?$/,
  /^(?:(?:show|send|give|get)(?: me)? )?(?:my )?(?:receipts?|invoices?) for (?:my |the )?(?:plan|subscription|trainee|billing)$/,
  /^what (?:was|have) i (?:been )?(?:charged|billed)(?: for)?(?: so far)?$/,
  /^(?:what|how much) did (?:you|trainee) charge me$/,
];
// Undoing a cancel (decided 2026-10-29, scenarios): there is no text path that restarts billing, so the ask is answered
// from the row and nothing is changed or promised; Stripe is never called.
const RESUME: RegExp[] = [
  /^(?:i want to |i'?d like to |can you |can i |could you |how do i |how can i )?(?:resume|restart|reactivate|re-activate|renew|un-?cancel|undo cancel(?:ling)?) (?:my |the )?(?:trainee )?(?:plan|subscription|membership)$/,
  /^(?:undo|reverse|take back) (?:the |my )?(?:cancel|cancellation|cancelation)(?: of my (?:plan|subscription))?$/,
  /^(?:un-?cancel)(?: it| trainee)?$/,
  /^(?:i changed my mind,? )?(?:keep|continue) my (?:plan|subscription) (?:going|active|after all)$/,
];
// A refund is never promised or issued by text (owner: no promises Trainee cannot keep); the person is told so plainly.
const REFUND: RegExp[] = [
  /^(?:can i (?:get|have) |i want |i'?d like |i need |give me |how do i get |how can i get |could i get |may i have )?(?:a |my )?refund(?: me)?(?: (?:for|on) (?:my |the |this |last )?(?:plan|subscription|trainee|month|payment|charge|last payment|last charge|invoice))?$/,
  /^refund (?:me|my (?:plan|subscription|payment|last payment|charge|last charge|money))$/,
  /^(?:i want|can i (?:get|have)|give me|i'?d like) my money back$/,
  /^(?:do|does) (?:you|trainee) (?:do |give |offer )?refunds$/,
];
// "how do I cancel" with nothing after it could be an application or an interview: it is answered with how, and nothing
// is asked or waiting (a "yes" after it approves nothing). With "my plan" / "trainee" it is the cancel ask itself.
const CANCEL_HOW = /^(?:how (?:do|can|would) i|how to|can i|where do i|where can i) cancel$/;
export type BillingAskKind = "price" | "cancel" | "cancel_help" | "receipts" | "resume" | "refund";
export function billingAsk(message: string): { kind: BillingAskKind } | null {
  const t = typos(plain(message));
  if (!t || t.length > 80) return null;
  if (CANCEL.some((re) => re.test(t))) return { kind: "cancel" };
  if (CANCEL_HOW.test(t)) return { kind: "cancel_help" };
  if (RESUME.some((re) => re.test(t))) return { kind: "resume" };
  if (REFUND.some((re) => re.test(t))) return { kind: "refund" };
  if (RECEIPTS.some((re) => re.test(t))) return { kind: "receipts" };
  if (PRICE.some((re) => re.test(t))) return { kind: "price" };
  return null;
}
// The answer to a waiting cancel. Only an exact affirmative is a yes; a question is never one.
const YES = /^(?:yes|yep|yeah|yup|y|yes please|yes,? cancel(?: it| my plan| my subscription)?|confirm|confirmed|do it|go ahead|yes,? (?:do it|go ahead))$/;
const NO = /^(?:no|nope|nah|n|no thanks|no thank you|don'?t|do not|keep it|keep my plan|never ?mind|cancel that|don'?t cancel(?: it)?)$/;
const UNSURE = /^(?:maybe|later|wait|hold on|hang on|not now|not yet|not sure|i'?m not sure|idk|hmm+|none|ok|okay|k|sure|let me think|one sec|give me a (?:sec|minute))$/;
export function cancelAnswer(message: string): "yes" | "no" | "unsure" | null {
  const raw = String(message ?? "").trim();
  if (raw.includes("?")) return "unsure";
  // A thumbs-up alone, or "yess"/"yse" alone, is "yes" (approval_words.ts).
  const t = plain(approvalWords(raw)).replace(/[,.!]+$/, "");
  if (YES.test(t)) return "yes";
  if (NO.test(t)) return "no";
  if (UNSURE.test(t)) return "unsure";
  return null;
}

// ------------------------------------------------------------------------------------------------ the facts
export async function cancelHash(subscriptionId: string, periodEnd: string | null): Promise<string> {
  const bytes = new TextEncoder().encode(`trainee-billing-cancel\n${subscriptionId}\n${periodEnd ?? ""}`);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
const day = (iso: string | number | null | undefined) => {
  const t = typeof iso === "number" ? iso : Date.parse(String(iso ?? ""));
  // A number past the calendar's range is no date ("Invalid Date" is never said).
  return Number.isFinite(t) && Number.isFinite(new Date(t).getTime()) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null;
};
// Stripe amounts are in the currency's smallest unit: most have 2 decimals, these none or 3 (Stripe's currency list).
// A currency Stripe did not state as a 3-letter code is never guessed (it used to read as USD).
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);
const money = (minor: number, currency: string) => {
  const c = String(currency ?? "").trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(c)) return `${(minor / 100).toFixed(2)} (currency not stated by Stripe)`;
  const n = ZERO_DECIMAL.has(c) ? String(minor) : THREE_DECIMAL.has(c) ? (minor / 1000).toFixed(3) : (minor / 100).toFixed(2);
  return c === "usd" ? `$${n}` : `${n} ${c.toUpperCase()}`;
};
const price = (s: Subscription) => {
  if (typeof s.price_cents !== "number" || !Number.isFinite(s.price_cents)) return null;
  const n = s.price_cents % 100 ? (s.price_cents / 100).toFixed(2) : String(s.price_cents / 100);
  return `$${n}${s.plan === "monthly" || !s.plan ? "/month" : ` (${s.plan})`}`;
};
const NOT_SUBSCRIBED = `You're not subscribed, so you're not paying anything. Trainee is $${PLAN_PRICE_CENTS / 100}/month.`;
const LIVE = new Set(["active", "trialing", "past_due", "unpaid"]);
const ending = (s: Subscription) => s.cancel_at_period_end === true && LIVE.has(s.status);

function priceReply(s: Subscription | null): string {
  if (!s || ["incomplete", "incomplete_expired"].includes(s.status)) {
    return s ? `Your checkout never finished, so you're not being charged. Trainee is $${PLAN_PRICE_CENTS / 100}/month.` : NOT_SUBSCRIBED;
  }
  const p = price(s) ?? "a price I don't have on file";
  const end = day(s.current_period_end);
  if (s.status === "canceled") return `Your plan is cancelled; you're not paying anything.`;
  if (ending(s)) return `Your plan (${p}) is cancelled: no more charges. You keep access until ${end ?? "the end of the period you paid for"}.`;
  const state = s.status === "trialing" ? "on a trial" : s.status === "active" ? "active" : `${s.status.replace("_", " ")} (your last payment didn't go through)`;
  return `You're paying ${p}, ${state}. ${end ? `Next charge: ${end}.` : "I don't have your next charge date on file."}`;
}
const effect = (end: string | null) => end
  ? `Cancelling means no charge after ${end}. You keep access until then, and nothing else changes.`
  : "Cancelling means no further charges; you keep access to the end of the period you paid for, and nothing else changes.";

// ------------------------------------------------------------------------------------------------ the turn
const CANT_REACH = "I can't reach billing right now";
export async function billingTurn(o: { message: string; userId: string; threadId: string; now: number; store: BillingStore; stripe: StripeBilling | null }): Promise<BillingTurn | null> {
  const ask = billingAsk(o.message);
  let pending: PendingCancel | null = null;
  if (!ask) {
    // Only a short answer could answer a waiting cancel; nothing else reads the thread.
    if (String(o.message ?? "").length > 120 || cancelAnswer(o.message) === null) return null;
    const last = await o.store.lastMeta(o.threadId).catch((e) => { console.error("billing: read the last reply:", safe(e)); return null; });
    const p = last?.intent === BILLING_CANCEL_INTENT ? last.billing_cancel as PendingCancel | undefined : undefined;
    if (!p || typeof p.hash !== "string" || typeof p.subscription_id !== "string") return null;
    pending = p;
  }
  let sub: Subscription | null;
  try {
    sub = await o.store.subscription(o.userId);
  } catch (e) {
    console.error("billing: read the subscription:", safe(e));
    return { reply: "I can't read your billing right now, so I won't guess. Nothing changed; ask me again in a minute.", intent: BILLING_INTENT, status: "unreadable" };
  }
  if (ask?.kind === "price") return { reply: priceReply(sub), intent: BILLING_INTENT, status: sub ? sub.status : "none" };
  if (ask?.kind === "receipts") return await receipts(sub, o.stripe);
  if (ask?.kind === "cancel") return await askCancel(sub);
  if (ask?.kind === "resume") return { reply: resumeReply(sub), intent: BILLING_INTENT, status: "resume_unavailable" };
  if (ask?.kind === "cancel_help") {
    return { reply: `To cancel your Trainee plan, text "cancel my plan": I'll say exactly what changes and cancel only after you say yes. To withdraw an application, say "cancel my application to" and the company.`, intent: BILLING_INTENT, status: "cancel_help" };
  }
  if (ask?.kind === "refund") {
    return { reply: `I can't issue or promise a refund from chat, so nothing changed.${sub?.stripe_customer_id ? ' Say "my invoices" to see what you were charged.' : ""}`, intent: BILLING_INTENT, status: "refund_unavailable" };
  }

  // A waiting cancel: only an exact yes approves it.
  const answer = cancelAnswer(o.message);
  if (answer === null) return null;
  const end = day(pending!.period_end);
  if (answer === "no") return { reply: "OK, nothing is cancelled. Your plan stays as it is.", intent: BILLING_INTENT, status: "kept" };
  if (answer === "unsure") {
    return { reply: `Nothing is cancelled. ${effect(end)} Say "yes" to cancel, or "no" to keep your plan.`, intent: BILLING_CANCEL_INTENT, status: "waiting", meta: { billing_cancel: pending! } };
  }
  if (!sub?.stripe_subscription_id) return { reply: NOT_SUBSCRIBED.replace("so you're not paying anything", "so there's nothing to cancel"), intent: BILLING_INTENT, status: "none" };
  if (sub.status === "canceled" || ending(sub)) return { reply: already(sub), intent: BILLING_INTENT, status: "already" };
  const hash = await cancelHash(sub.stripe_subscription_id, sub.current_period_end);
  if (hash !== pending!.hash || sub.stripe_subscription_id !== pending!.subscription_id) {
    const again = await askCancel(sub);
    return { ...again, reply: `Your plan changed since I asked, so I didn't cancel anything. ${again.reply}` };
  }
  if (!o.stripe) {
    return { reply: `${CANT_REACH}, so nothing was cancelled and nothing changed. Say "yes" again later to cancel.`, intent: BILLING_CANCEL_INTENT, status: "unavailable", meta: { billing_cancel: pending! } };
  }
  let done: CancelResult;
  try {
    done = await o.stripe.cancelAtPeriodEnd(sub.stripe_subscription_id, hash);
  } catch (e) {
    console.error("billing: cancel:", safe(e));
    // Stripe refused it (a 4xx): nothing was applied. No answer, a 5xx or a garbled one: it may have gone through, so
    // "nothing was cancelled" would be a guess; the retry carries the same idempotency key, so it can't cancel twice.
    const refused = e instanceof StripeError && e.status !== null && e.status >= 400 && e.status < 500;
    return {
      reply: refused ? `Billing refused the request, so nothing was cancelled. Say "yes" again to retry.`
        : `I couldn't get a clear answer from billing just now, so I can't confirm the cancel. Say "yes" again to retry; it can't cancel twice.`,
      intent: BILLING_CANCEL_INTENT, status: "failed", meta: { billing_cancel: pending! },
    };
  }
  if (done.cancel_at_period_end !== true) {
    return { reply: "Billing didn't confirm the cancel, so I can't say it's done. Nothing else changed; ask me again in a minute.", intent: BILLING_INTENT, status: "unconfirmed" };
  }
  await o.store.markCancelling(o.userId, sub.stripe_subscription_id).catch((e) => console.error("billing: mark the row:", safe(e)));
  const at = day(typeof done.cancel_at === "number" ? done.cancel_at * 1000 : typeof done.current_period_end === "number" ? done.current_period_end * 1000 : null) ?? end;
  return { reply: `Done, your plan is cancelled. ${at ? `No charge after ${at}; you keep access until then.` : "No further charges; you keep access to the end of the period you paid for."}`, intent: BILLING_INTENT, status: "cancelled" };
}

function resumeReply(s: Subscription | null): string {
  if (!s || !s.stripe_subscription_id || ["incomplete", "incomplete_expired"].includes(s.status)) {
    return `You're not subscribed, so there's no plan to resume. Trainee is $${PLAN_PRICE_CENTS / 100}/month.`;
  }
  if (s.status === "canceled") return "Your plan is cancelled, and I can't restart it by text, so nothing changed.";
  if (ending(s)) {
    const end = day(s.current_period_end);
    return `Your plan is set to end ${end ? `on ${end}` : "at the end of the period you paid for"}, with no more charges. I can't undo a cancel by text yet, so nothing changed.`;
  }
  return "Your plan isn't cancelled, so there's nothing to resume. Nothing changed.";
}
function already(s: Subscription): string {
  const end = day(s.current_period_end);
  return s.status === "canceled" ? "Your plan is already cancelled. You're not being charged."
    : `Your plan is already cancelled: no charge after ${end ?? "the current period"}, and you keep access until then.`;
}
async function askCancel(sub: Subscription | null): Promise<BillingTurn> {
  if (!sub?.stripe_subscription_id || ["incomplete", "incomplete_expired"].includes(sub.status)) {
    return { reply: "You're not subscribed, so there's nothing to cancel.", intent: BILLING_INTENT, status: "none" };
  }
  if (sub.status === "canceled" || ending(sub)) return { reply: already(sub), intent: BILLING_INTENT, status: "already" };
  const hash = await cancelHash(sub.stripe_subscription_id, sub.current_period_end);
  return {
    reply: `${effect(day(sub.current_period_end))} Reply "yes" to cancel.`,
    intent: BILLING_CANCEL_INTENT, status: "asked",
    meta: { billing_cancel: { subscription_id: sub.stripe_subscription_id, period_end: sub.current_period_end, hash } },
  };
}
// A link only as Stripe returned it: https on a stripe.com host, else no link.
// The text must be the URL exactly: the URL parser drops tabs and newlines inside it, so a value with whitespace or a
// control character (which would put a second, unchecked address on its own line in the reply) is no link at all, nor
// is one with a user name or password before the host.
const stripeLink = (u: unknown) => {
  if (typeof u !== "string" || /[\s\x00-\x1f\x7f]/.test(u)) return null;
  try {
    const x = new URL(u);
    return x.protocol === "https:" && !x.username && !x.password && /(?:^|\.)stripe\.com$/.test(x.hostname) ? u : null;
  } catch { return null; }
};
async function receipts(sub: Subscription | null, stripe: StripeBilling | null): Promise<BillingTurn> {
  if (!sub?.stripe_customer_id) return { reply: "You're not subscribed, so there are no billing receipts.", intent: BILLING_INTENT, status: "none" };
  if (!stripe) return { reply: `${CANT_REACH}, so I can't list your receipts. Nothing is guessed; ask me again later.`, intent: BILLING_INTENT, status: "unavailable" };
  let list: Invoice[];
  try {
    list = await stripe.listInvoices(sub.stripe_customer_id);
  } catch (e) {
    console.error("billing: invoices:", safe(e));
    return { reply: "I couldn't reach billing just now, so I can't list your receipts. Nothing is guessed; ask me again in a minute.", intent: BILLING_INTENT, status: "failed" };
  }
  // Only invoices whose date and amount read as Stripe sent them: a whole, non-negative amount and a real date.
  const rows = list.filter((i) => i && Number.isFinite(i.created) && day(i.created * 1000) !== null && Number.isSafeInteger(i.amount_paid) && i.amount_paid >= 0).slice(0, 5);
  if (!rows.length) return { reply: "No paid invoices on record at Stripe yet.", intent: BILLING_INTENT, status: "none" };
  const lines = rows.map((i) => { const u = stripeLink(i.hosted_invoice_url); return `- ${day(i.created * 1000)}: ${money(i.amount_paid, i.currency)}${u ? ` ${u}` : " (no receipt link from Stripe)"}`; });
  return { reply: [`Your last ${rows.length === 1 ? "payment" : `${rows.length} payments`}:`, ...lines].join("\n"), intent: BILLING_INTENT, status: "listed" };
}

// ------------------------------------------------------------------------------------------------ Stripe and the store
// An error's own message only, never a response body (Stripe echoes keys in some errors), and anything key-shaped masked.
const safe = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_]+/g, "[key]").slice(0, 200);
// Every adapter failure is a StripeError with a fixed message (never a runtime error's text, which can quote the request
// header or the body) and Stripe's HTTP status when it answered (null: no answer, or an answer that was not JSON).
export class StripeError extends Error {
  constructor(message: string, readonly status: number | null) { super(message); this.name = "StripeError"; }
}
export function stripeFromEnv(fetchFn: typeof fetch, key: string | undefined | null, o: { timeoutMs?: number } = {}): StripeBilling | null {
  const k = String(key ?? "").trim();
  if (!k) return null;
  const base = "https://api.stripe.com/v1";
  const call = async (path: string, init: RequestInit = {}) => {
    const where = `stripe ${path.split("?")[0].replace(/\/[a-z]+_[A-Za-z0-9]+/g, "/{id}")}`;
    let r: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${k}`);
      // Never wait on Stripe forever: a hung call is "no answer", said honestly by the turn.
      r = await fetchFn(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
    } catch (e) {
      throw new StripeError(`${where} did not answer (${e instanceof Error && /^[A-Za-z]+$/.test(e.name) ? e.name : "error"})`, null);
    }
    if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new StripeError(`${where} answered ${r.status}`, r.status); }
    try { return await r.json(); } catch { throw new StripeError(`${where} answered ${r.status} with a body that is not JSON`, null); }
  };
  return {
    async cancelAtPeriodEnd(id, idempotencyKey) {
      const j = await call(`/subscriptions/${encodeURIComponent(id)}`, {
        method: "POST", body: "cancel_at_period_end=true",
        headers: { "content-type": "application/x-www-form-urlencoded", "idempotency-key": idempotencyKey },
      });
      return { cancel_at_period_end: j?.cancel_at_period_end === true, cancel_at: typeof j?.cancel_at === "number" ? j.cancel_at : null,
        current_period_end: typeof j?.current_period_end === "number" ? j.current_period_end : null };
    },
    async listInvoices(customerId) {
      const q = new URLSearchParams({ customer: customerId, status: "paid", limit: "5" });
      const j = await call(`/invoices?${q}`);
      return (Array.isArray(j?.data) ? j.data : []).map((i: any) => ({ id: String(i.id ?? ""), created: Number(i.created), amount_paid: Number(i.amount_paid),
        currency: typeof i.currency === "string" ? i.currency : "", hosted_invoice_url: typeof i.hosted_invoice_url === "string" ? i.hosted_invoice_url : null }));
    },
  };
}
// deno-lint-ignore no-explicit-any
export function supabaseBillingStore(admin: any): BillingStore {
  return {
    async subscription(userId) {
      const r = await admin.from("user_subscriptions")
        .select("status,plan,price_cents,current_period_start,current_period_end,stripe_customer_id,stripe_subscription_id,cancel_at_period_end")
        .eq("user_id", userId).maybeSingle();
      if (r.error) throw new Error(`read the subscription: ${r.error.message}`);
      return r.data ?? null;
    },
    async lastMeta(threadId) {
      const r = await admin.from("agent_messages").select("meta").eq("thread_id", threadId).eq("role", "assistant").order("id", { ascending: false }).limit(1);
      if (r.error) throw new Error(`read the last reply: ${r.error.message}`);
      return r.data?.[0]?.meta ?? null;
    },
    async markCancelling(userId, subscriptionId) {
      const r = await admin.from("user_subscriptions").update({ cancel_at_period_end: true, updated_at: new Date().toISOString() })
        .eq("user_id", userId).eq("stripe_subscription_id", subscriptionId);
      if (r.error) throw new Error(`mark the subscription: ${r.error.message}`);
    },
  };
}
