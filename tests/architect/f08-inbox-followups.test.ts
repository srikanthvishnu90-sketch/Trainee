// FEATURE 8 (DIAGNOSIS-2026-10-25 §2.4, §2.5): the module's own rules, over memory stores. The real-handler proof is
// flow-f08-inbox-followups.test.ts.
import assertNode from "node:assert/strict";
import { followupAnswer, followupAsk, followupTurn, type FollowupDeps, mailNow } from "../../supabase/functions/_shared/career_inbox_followups.ts";
import { standingAsk } from "../../supabase/functions/_shared/career_standing.ts";
import { memoryMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { memoryOutreachStore, messageOf, payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import type { Message } from "../../supabase/functions/_shared/career_outreach.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.parse("2026-10-25T15:00:00Z"), DAY = 86_400_000, iso = (t: number) => new Date(t).toISOString();
const ROOT = new URL("../..", import.meta.url).pathname;

Deno.test("F8/1 the asks: a check, a follow-up for an employer, the answers; nothing else, and never a standing ask", () => {
  for (const m of ["check my email now", "Check my inbox", "please read my email", "scan my gmail for updates", "check my mail again"]) eq(followupAsk(m), { kind: "check", connected: false }, m);
  for (const m of ["I just connected my Gmail", "i connected my email", "my gmail is connected now", "ok I've connected my google account"]) eq(followupAsk(m), { kind: "check", connected: true }, m);
  eq(followupAsk("draft the follow-up to Stripe"), { kind: "card", which: "followup", company: "Stripe", to: null });
  eq(followupAsk("send the thank-you to Acme Corp"), { kind: "card", which: "thank_you", company: "Acme Corp", to: null });
  eq(followupAsk("Send the follow-up to Stripe at Jane.Doe@stripe.com"), { kind: "card", which: "followup", company: "Stripe", to: "jane.doe@stripe.com" });
  eq(followupAsk("follow up with Globex"), { kind: "card", which: "followup", company: "Globex", to: null });
  eq(followupAsk("can you write a thank you note for Initech?"), { kind: "card", which: "thank_you", company: "Initech", to: null });
  eq(followupAsk("email Hooli the follow-up"), { kind: "card", which: "followup", company: "Hooli", to: null });
  // Standing's asks stay standing's, and these are not standing asks.
  for (const m of ["what follow-ups are due?", "who should I follow up with?", "who emailed me?", "any news from Stripe?", "where are my applications?", "follow up with them", "yes", "find data analyst jobs"]) eq(followupAsk(m), null, m);
  for (const m of ["draft the follow-up to Stripe", "check my email now", "send the thank-you to Acme"]) eq(standingAsk(m), null, m);
  eq(followupAnswer("yes"), { kind: "yes" });
  eq(followupAnswer("Yes, send it"), { kind: "yes" });
  eq(followupAnswer("no"), { kind: "no" });
  eq(followupAnswer("jane@stripe.com"), { kind: "to", to: "jane@stripe.com" });
  eq(followupAnswer("send it to Jane@Stripe.com"), { kind: "to", to: "jane@stripe.com" });
  eq(followupAnswer("body: Hi Jane, checking in."), { kind: "body", text: "Hi Jane, checking in." });
  eq(followupAnswer("sign as Pat Lee"), { kind: "sign", text: "Pat Lee" });
  eq(followupAnswer("tell me about stripe@x.com and more"), null);
});

// One quiet application (Stripe, 16 days) and one an email answers (Globex).
const QUEUE = [
  { id: "J1", company: "Stripe", url: "https://stripe.com/jobs/1", state: "submitted_unconfirmed", created_at: iso(NOW - 16 * DAY), updated_at: iso(NOW - 16 * DAY), title: "Data Analyst" },
  { id: "J2", company: "Globex", url: "https://globex.com/careers/2", state: "submitted_unconfirmed", created_at: iso(NOW - 15 * DAY), updated_at: iso(NOW - 15 * DAY), title: "Data Analyst" },
];
const MAIL = { hash: "h1", from: "Globex Recruiting <recruiting@globex.com>", subject: "Interview invitation: Data Analyst at Globex", date: iso(NOW - DAY),
  snippet: "Thank you for applying to the Data Analyst role at Globex. We would like to invite you to interview with our team next week.",
  auth: ["mx.google.com; dkim=pass header.i=@globex.com; spf=pass smtp.mailfrom=recruiting@globex.com; dmarc=pass header.from=globex.com"] };

Deno.test("F8/2 mailNow is one run of the scheduled mail tracking for this person: its texts said, its records its own", async () => {
  const store = memoryMailStore({ people: [{ user_id: "U", read_through: null }, { user_id: "OTHER", read_through: null }], queue: { U: QUEUE, OTHER: QUEUE } });
  const reads: string[] = [];
  const r = await mailNow({ userId: "U", now: NOW, store, cursor: async () => null, read: async (u) => { reads.push(u); return { status: "ok", mails: [MAIL], readThrough: NOW, listed: 1 }; } });
  eq(reads, ["U"], "only this person is read");
  assert(r.status === "ok" && r.read === 1, JSON.stringify(r));
  if (r.status !== "ok") return;
  assert(r.statuses.length === 1 && /Globex \(Data Analyst\) wants to interview you/.test(r.statuses[0]), r.statuses.join("\n"));
  assert(r.offers.length === 1 && /No reply from Stripe/.test(r.offers[0]), r.offers.join("\n"));
  const d = store.dump();
  eq(d.events.U.map((e) => e.kind), ["interview"]);
  eq(d.drafts.U.map((x) => x.company), ["Stripe"]);
  eq(d.cursors.U, NOW);
  eq(d.events.OTHER, undefined, "nobody else was touched");
  const nw = await mailNow({ userId: "U", now: NOW, store, cursor: async () => null, read: async () => ({ status: "NOT_WIRED", reason: "no grant", mails: [], readThrough: null, listed: 0 }) });
  eq(nw.status, "NOT_WIRED");
});

function deps(o: Partial<FollowupDeps> = {}) {
  const outreach = memoryOutreachStore(), sent: Message[] = [], marked: string[] = [];
  let last: { intent: string | null; meta: Record<string, unknown> } | null = null;
  const d: FollowupDeps = {
    read: async () => ({ jobs: QUEUE.map((q) => ({ ...q, reason: null, confirmation_id: null, email_confirmed_at: null })) as any, mail: [], tracker: [], drafts: [], read_through: iso(NOW - 3600_000), unreadable: [] }),
    outreach, lastAssistant: async () => last, addressOnRecord: async () => null, name: () => "Pat Lee",
    markSent: async (_u, c) => { marked.push(c.key); }, mailOn: true, readNow: async () => ({ status: "NOT_WIRED" }),
    sendOn: true, canSend: async () => true, send: async (_u, m) => { sent.push(m); return { status: "sent", id: "g1", thread_id: "t1" }; }, ...o,
  };
  const turn = async (message: string) => {
    const r = await followupTurn({ message, userId: "U", threadId: "T", now: NOW, deps: d });
    if (r) last = { intent: r.intent, meta: r.meta ?? {} };
    return r;
  };
  return { d, outreach, sent, marked, turn };
}

Deno.test("F8/3 the card: due follow-up, address typed, exact message hash-bound; yes sends once; off and ungranted say so", async () => {
  const { outreach, sent, marked, turn } = deps();
  const ask = (await turn("send the follow-up to Stripe"))!;
  eq(ask.status, "need_address");
  const card = (await turn("jane@stripe.com"))!;
  eq(card.status, "shown", card.reply);
  const [d] = await outreach.latestBatch("U");
  eq(d.hash, await payloadHash(messageOf(d)), "the card's hash is the exact message's");
  eq(messageOf(d).to, "jane@stripe.com");
  assert(/^Hello, I applied for the Data Analyst role at Stripe/.test(d.body) && d.footer === "Pat Lee", JSON.stringify(d));
  const yes = (await turn("yes"))!;
  eq(yes.status, "sent", yes.reply);
  eq(sent.length, 1);
  eq(sent[0], messageOf(d), "exactly the message shown");
  eq(marked, ["followup:job:J1"]);
  eq((await outreach.latestBatch("U"))[0].status, "sent");
  eq(await turn("yes"), null, "the card answered, a second yes is not this turn's");
  eq(sent.length, 1);

  const off = deps({ sendOn: false });
  await off.turn("send the follow-up to Stripe at jane@stripe.com");
  eq((await off.turn("yes"))!.status, "SEND_OFF");
  const ng = deps({ canSend: async () => false });
  await ng.turn("send the follow-up to Stripe at jane@stripe.com");
  eq((await ng.turn("yes"))!.status, "NOT_WIRED");
  eq(off.sent.length + ng.sent.length, 0);
  eq((await off.outreach.latestBatch("U"))[0].status, "shown", "the card waits for a yes once sending is on");
});

Deno.test("F8/4 nothing due, nothing on record, a reply on record, an unreadable mail record: each said, nothing drafted", async () => {
  const replied = deps({ read: async () => ({ jobs: QUEUE as any, mail: [{ hash: "h", ref: "job:J2", kind: "interview", company: "Globex", stage: "Interview rounds", flagged: false, evidence: "e", at: iso(NOW - DAY), new_app: false }], tracker: [], drafts: [], unreadable: [] }) });
  eq((await replied.turn("follow up with Globex"))!.status, "none_due");
  eq((await replied.turn("send the follow-up to Initech"))!.status, "none_due");
  assert(/no application to Initech on record/.test((await replied.turn("send the follow-up to Initech"))!.reply));
  const down = deps({ read: async () => ({ jobs: QUEUE as any, mail: null, tracker: [], drafts: [], unreadable: ["mail"] }) });
  eq((await down.turn("send the follow-up to Stripe at jane@stripe.com"))!.status, "unreadable");
  eq((await down.outreach.latestBatch("U")).length, 0);
  const off = deps({ mailOn: false });
  eq((await off.turn("check my email now"))!.status, "MAIL_OFF");
  const nosig = deps({ name: () => null });
  eq((await nosig.turn("send the follow-up to Stripe at jane@stripe.com"))!.status, "need_signature");
  eq((await nosig.turn("sign as Pat Lee"))!.status, "shown");
});

Deno.test("F8/5 agent-chat: the turn runs before the read model's turn, the router and the brain, as one FEATURE 8 block", async () => {
  const src = await Deno.readTextFile(`${ROOT}/supabase/functions/agent-chat/handler-career.ts`);
  const at = src.indexOf("followupTurn(");
  assert(at > 0 && at < src.indexOf("standingTurn(") && at < src.indexOf("AGENT_BRAIN_RELEASED && chooseBrain"));
  assert(/mailOn: chatSwitches\(Deno\.env\)\.mailTracking,/.test(src) /* D-036: a release flag, read through chat_switches.ts */ && /sendOn: chatSwitches\(Deno\.env\)\.emailSend,/.test(src) /* D-037 */);
});
