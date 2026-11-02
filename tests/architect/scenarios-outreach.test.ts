// NETWORKING OUTREACH AT SCALE (owner rules, 2026-10-30): ~10,000 seeded scenarios (tests/architect/scenarios/outreach-generator.ts)
// through the product's own functions, a fixed clock, a fake Gmail at the HTTP boundary and the in-memory stores. No
// database, no network, no model. What earlier batteries covered is not repeated here: the words of every approval path
// (scenarios-approvals), the readings of a reply (scenarios-replies), people asks, imports and the fact-lock's sentences
// (scenarios-networking), a disconnect (scenarios-connectors). This one covers what happens between them:
//   approve   one answer approves exactly the batch shown IN THAT CHAT, each draft bound to the hash of the text shown;
//             nothing for a batch drafted and shown in another chat, a draft changed behind the person's back, an old
//             batch or an ambiguous answer; an edit needs a new yes; what is queued is exactly what was approved, with the
//             card's address label (an inferred address stays labelled on the rail).
//   worker    the sending rail's worker on one claimed email: at most one send, only when everything allows, of exactly the
//             approved payload (To, Subject, body; never From, Cc or Bcc); "already sent" only on an exact match in Sent;
//             Gmail's quota (in its own words too) backs off and resumes; a follow-up never goes over an answer already on
//             its sequence's threads.
//   followup  the replies lane's follow-ups: only when the step is due with no answer, at most the steps set, each step
//             once (two workers at once), never after a reply / stop / bounce / the person's own follow-up / an opt-out
//             given to someone else, past an out-of-office return date; nothing drafted or asked for a paused person.
//   reply     the rail's reply check over a sequence's threads: each answer recorded on exactly its email, with its kind.
//   draft     drafting never writes to an address that opted out with anyone or bounced for anyone, and writes to exactly
//             the address on the contact's row.
// The end to end sample on Postgres is tests/architect/flow-scenarios-outreach.test.ts.
import assertNode from "node:assert/strict";
import {
  type ApproveScenario, COUNTS, DAY, type DraftScenario, type FollowupScenario, generate, NOW, type ReplyScenario, type WorkerScenario,
} from "./scenarios/outreach-generator.ts";
import { emailHash, footerOf, memoryOutreachStore, messageOf, type OutreachDraft, OUTREACH_INTENT, outreachTurn, payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { encodedWord, queueApprovedOutreach, runReplyCheck, runSendWorker, type WorkerDeps } from "../../supabase/functions/_shared/career_send_rail.ts";
import { ACTIONS_INTENT, memoryRepliesStore, type ReplyRail, recordMessage, repliesTurn, runFollowupDrafts, runOutreachActions } from "../../supabase/functions/_shared/career_outreach_replies.ts";
import { networkingTurn } from "../../supabase/functions/_shared/career_networking.ts";
import { engineAware, seedFacts } from "./personal-fixture.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ALL = generate({ seed: 20261030 });

// ------------------------------------------------------------------------------------------------ the report
type Failure = { id: number; category: string; why: string; got: string };
class Report {
  total = 0; failures = new Map<string, Failure[]>();
  constructor(public what: string) {}
  grade(s: { id: number; category: string }, why: string | null, got: unknown) {
    this.total++;
    if (!why) return;
    const k = `${s.category.split("/").slice(0, 2).join("/")}: ${why.replace(/ \[.*$/s, "")}`;
    if (!this.failures.has(k)) this.failures.set(k, []);
    this.failures.get(k)!.push({ id: s.id, category: s.category, why, got: JSON.stringify(got).slice(0, 400) });
  }
  assertClean() {
    const n = [...this.failures.values()].reduce((a, b) => a + b.length, 0);
    const lines = [`[outreach] ${this.what}: ${this.total} scenarios, ${n} failures`];
    for (const [k, xs] of this.failures) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    #${x.id} ${x.category}${x.why.includes(" [") ? ` ${x.why.slice(x.why.indexOf(" [") + 1)}` : ""} -> ${x.got}`); }
    console.log(lines.join("\n"));
    eq(n, 0, `${this.what}: ${n} of ${this.total} failed (see the report above)`);
  }
}
const sameSet = (a: number[], b: number[]) => a.length === b.length && [...a].sort((x, y) => x - y).every((x, i) => x === [...b].sort((p, q) => p - q)[i]);

// ------------------------------------------------------------------------------------------------ approve
const SIGN = "Sam Lee";
async function batchOf(n: number, tag: string, inferred: number[], at: number) {
  const out: Omit<OutreachDraft, "id" | "batch_id" | "thread_id">[] = [];
  for (let i = 1; i <= n; i++) {
    const recipient = { name: `Person ${tag}${i}`, firm: "Acme", title: "Analyst", school: "", email: `p${tag}${i}@acme.example`, source: `contacts.csv, row ${i}`, ...(inferred.includes(i) ? { address: "inferred" as const } : {}) };
    const d = { n: i, recipient, subject: `A question ${tag}${i}`, body: `Hi Person ${tag}${i},\n\nWould you have 15 minutes this week?`, footer: footerOf(SIGN), shared: [], status: "shown" as const, hash: "",
      approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(at).toISOString() };
    d.hash = await payloadHash(messageOf(d));
    out.push(d);
  }
  return out;
}
async function runApprove(s: ApproveScenario): Promise<string | null> {
  const store = memoryOutreachStore();
  const U = "u-1", HERE = "chat-here", THERE = "chat-there";
  const T0 = NOW - s.ageHours * 3600_000;
  let at = T0 - 600_000;
  for (const o of s.others.filter((x) => x.when === "before")) {
    const t = o.where === "my_other_chat" ? THERE : "chat-other-person";
    await store.saveBatch(o.where === "my_other_chat" ? U : "u-2", t, await batchOf(o.size, "b", [], at), at);
    store.setIntent(t, OUTREACH_INTENT);
  }
  const mine = await store.saveBatch(U, HERE, await batchOf(s.size, "m", s.inferred, T0), T0);
  store.setIntent(HERE, OUTREACH_INTENT);
  // What the person saw in this chat, by draft id: the exact text (to, subject, text) of the last card that showed it.
  const seen = new Map<string, string>();
  for (const d of mine) seen.set(d.id, JSON.stringify(messageOf(d)));
  let shown = mine.map((d) => d.id);
  at = T0 + 60_000;
  for (const e of s.events) {
    const d = (await store.latestBatch(U)).find((x) => x.n === e.n)!;
    if (e.kind === "edit") {
      const r = await outreachTurn({ message: `edit ${e.n}: Hi there, a shorter note: could we talk for 10 minutes?`, userId: U, threadId: HERE, now: at, store });
      if (!r || r.status !== "edit") return `the edit was not taken: ${r?.status}`;
      const nd = (await store.latestBatch(U)).find((x) => x.n === e.n)!;
      if (nd.status !== "shown" || nd.approved_hash) return "an edited draft must wait for a new yes";
      if (!r.reply.includes(messageOf(nd).text)) return "the edit reply shows the new version exactly";
      seen.set(nd.id, JSON.stringify(messageOf(nd)));
    } else if (e.kind === "tamper") {
      // A change behind the person's back (not shown): the stored text moves, the shown hash stays.
      await store.update(U, { ...d, body: `${d.body} P.S. I also worked at Google.` }, { status: "shown" });
    } else {
      const r = await outreachTurn({ message: `cancel ${e.n}`, userId: U, threadId: HERE, now: at, store });
      if (!r || r.status !== "skipped") return `the take-back was not taken: ${r?.status}`;
      store.setIntent(HERE, OUTREACH_INTENT);
    }
  }
  at = T0 + 120_000;
  let newest: OutreachDraft[] | null = null;
  for (const o of s.others.filter((x) => x.when === "after")) {
    const mineToo = o.where === "my_other_chat";
    const saved = await store.saveBatch(mineToo ? U : "u-2", mineToo ? THERE : "chat-other-person", await batchOf(o.size, mineToo ? "x" : "y", [], at), at);
    store.setIntent(mineToo ? THERE : "chat-other-person", OUTREACH_INTENT);
    if (mineToo) newest = saved;
  }
  if (s.showAgainHere && newest) {
    const r = await outreachTurn({ message: "show drafts", userId: U, threadId: HERE, now: T0 + 180_000, store });
    if (!r || r.status !== "shown") return `"show drafts" did not show the newest batch: ${r?.status}`;
    for (const d of newest) { if (!r.reply.includes(messageOf(d).text)) return "the batch shown again is shown exactly"; seen.set(d.id, JSON.stringify(messageOf(d))); }
    shown = newest.map((d) => d.id);
    store.setIntent(HERE, OUTREACH_INTENT);
  }
  // The answer.
  const queued: any[] = [];
  const onApproved = async (u: string, items: { draftId: string; approvalHash: string }[]) => {
    await queueApprovedOutreach({ rpc: async (_n: string, a: any) => { queued.push(...a.p.items); return { data: a.p.items.map((x: any) => ({ source_id: x.source_id, status: "queued", id: `q-${x.source_id}` })), error: null }; }, drafts: (uu: string, ids: string[]) => store.drafts!(uu, ids) } as any, u, items);
  };
  const before = new Map((store.dump().drafts).map((d) => [d.id, d]));
  const r = await outreachTurn({ message: s.answer, userId: U, threadId: HERE, now: NOW, store, onApproved });
  const after = store.dump().drafts;
  const approvedNow = after.filter((d) => d.status === "approved" && before.get(d.id)?.status !== "approved");
  // Every other draft unchanged in status (another person's, another chat's, this batch's not named).
  // What must be approved: the batch shown here, if it is still the newest one of the person's and inside its 3 days.
  const bShown = after.filter((d) => shown.includes(d.id)).sort((a, z) => a.n - z.n);
  const newestBatch = after.filter((d) => d.user_id === U).sort((a, z) => String(a.created_at).localeCompare(String(z.created_at)) || a.n - z.n).at(-1)!.batch_id;
  const stillNewest = bShown[0].batch_id === newestBatch;
  const young = Date.parse(bShown[0].created_at) >= NOW - 72 * 3600_000;
  let want: OutreachDraft[] = [];
  if (s.wants && stillNewest && young) {
    const ns = bShown.map((d) => d.n);
    const named = s.wants.all ? s.wants.except : s.wants.ns;
    const one = s.category.split("/")[1] !== "send_it" || bShown.filter((d) => before.get(d.id)!.status === "shown").length === 1;
    if (one && named.every((n) => ns.includes(n))) {
      const pickN = s.wants.all ? ns.filter((n) => !(s.wants as any).except.includes(n)) : s.wants.ns;
      want = bShown.filter((d) => pickN.includes(d.n) && before.get(d.id)!.status === "shown" && JSON.stringify(messageOf(before.get(d.id)!)) === seen.get(d.id));
    }
  }
  if (!sameSet(approvedNow.map((d) => Number(d.id.slice(1))), want.map((d) => Number(d.id.slice(1))))) {
    const which = (xs: OutreachDraft[]) => xs.map((d) => `${shown.includes(d.id) ? "shown-here" : "elsewhere"}:${d.n}`).join(",") || "nothing";
    return `${approvedNow.some((d) => !shown.includes(d.id)) ? "approved drafts not shown in this chat" : approvedNow.length > want.length ? "approved more than the answer said" : "approved less than the answer said"} [${which(approvedNow)} vs ${which(want)}; ${r?.status}]`;
  }
  for (const d of approvedNow) {
    const m = messageOf(d);
    if (d.approved_hash !== await payloadHash(m) || d.approved_hash !== d.hash) return "approved, but not bound to the hash of its exact text";
    if (JSON.stringify(m) !== seen.get(d.id)) return "approved a text the person was not shown";
    const q = queued.find((x) => x.source_id === d.id);
    if (!q) return "approved but not handed to the rail";
    if (q.to !== m.to || q.subject !== m.subject || q.body !== m.text || q.approval_hash !== d.approved_hash) return "queued something other than what was approved";
    const label = (d.recipient as any).address ?? null;
    if ((q.address_type ?? null) !== label) return `the card's address label (${label}) did not ride with the email (${q.address_type ?? null})`;
    if ("cc" in q || "bcc" in q) return "a Cc or Bcc was queued";
  }
  if (queued.length !== approvedNow.length) return "queued more than was approved";
  if (approvedNow.some((d) => d.user_id !== U)) return "approved another person's draft";
  return null;
}

Deno.test(`outreach at scale, approvals bound to the batch shown in this chat: ${COUNTS.approve} scenarios`, async () => {
  const rep = new Report("approve");
  for (const s of ALL.approve) {
    let why: string | null;
    try { why = await runApprove(s); } catch (e) { why = `threw: ${e instanceof Error ? e.message : e}`; }
    rep.grade(s, why, { answer: s.answer, others: s.others, events: s.events, age: s.ageHours });
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ worker
const b64urlDecode = (s: string) => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)); return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0))); };
const decodeWord = (v: string) => v.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, x) => new TextDecoder().decode(Uint8Array.from(atob(x), (c) => c.charCodeAt(0))));
const SENT_EXACT = new Set(["exact", "exact_named", "encoded_exact"]);
const ANSWERED: Record<string, string> = { reply: "reply", stop: "stop", bounce: "bounce", other_addr_reply: "reply", unsub_mailto: "stop" };
function gmailAnswer(a: WorkerScenario["gmail"]): Response | "throw" {
  const j = (status: number, message: string, reason?: string, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ error: { code: status, message, ...(reason ? { errors: [{ reason, message }] } : {}) } }), { status, headers: { "content-type": "application/json", ...headers } });
  switch (a) {
    case "sent": return Response.json({ id: "g-new", threadId: "t-new", labelIds: ["SENT"] });
    case "sent_no_id": return Response.json({ labelIds: ["SENT"] });
    case "429_secs": return j(429, "Too many requests", undefined, { "retry-after": "120" });
    case "429_date": return j(429, "Too many requests", undefined, { "retry-after": new Date(NOW + 3600_000).toUTCString() });
    case "429_plain": return j(429, "Resource has been exhausted");
    case "403_rate_reason": return j(403, `User-rate limit exceeded.  Retry after ${new Date(NOW + 1800_000).toISOString()}`, "rateLimitExceeded");
    case "403_daily_words": return j(403, "Daily user sending quota exceeded.");
    case "403_concurrent_words": return j(403, "Too many concurrent requests for user");
    case "403_quota_words": return j(403, "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'");
    case "401": return j(401, "Request had invalid authentication credentials.");
    case "403_scope": return j(403, "Request had insufficient authentication scopes.", "insufficientPermissions");
    case "500": return j(500, "Internal error");
    case "503": return j(503, "The service is currently unavailable.");
    case "throw": return "throw";
    case "400_spam": return j(400, "Message rejected: suspected spam", "failedPrecondition");
    case "400_invalid": return j(400, "Invalid To header", "invalidArgument");
  }
}
function expectedOutcome(s: WorkerScenario): { outcome: string; post: boolean; record: string | null; resumeAt?: number } {
  if (s.tamper !== "none") return { outcome: "refused", post: false, record: null };
  if (s.attempts > 1) {
    if (!s.readToken || s.sent === "unreadable") return { outcome: "retry", post: false, record: null };
    if (SENT_EXACT.has(s.sent)) return { outcome: "already_sent", post: false, record: null };
  }
  if (s.followUp) {
    if (!s.readToken || s.seq === "unreadable") return { outcome: "retry", post: false, record: null };
    if (ANSWERED[s.seq]) return { outcome: "retry", post: false, record: ANSWERED[s.seq] };
  }
  if (!s.sendToken) return { outcome: "reconnect", post: false, record: null };
  if (s.go !== "go") return { outcome: "retry", post: false, record: null };
  const back = NOW + 60_000 * 2 ** Math.max(0, s.attempts - 1);
  switch (s.gmail) {
    case "sent": return { outcome: "sent", post: true, record: null };
    case "sent_no_id": case "500": case "503": case "throw": return { outcome: "retry", post: true, record: null };
    case "429_secs": return { outcome: "quota", post: true, record: null, resumeAt: NOW + 120_000 };
    case "429_date": return { outcome: "quota", post: true, record: null, resumeAt: Math.floor((NOW + 3600_000) / 1000) * 1000 };
    case "403_rate_reason": return { outcome: "quota", post: true, record: null, resumeAt: NOW + 1800_000 };
    case "429_plain": case "403_daily_words": case "403_concurrent_words": case "403_quota_words": return { outcome: "quota", post: true, record: null, resumeAt: back };
    case "401": case "403_scope": return { outcome: "reconnect", post: true, record: null };
    case "400_spam": return { outcome: "policy", post: true, record: null };
    case "400_invalid": return { outcome: "failed", post: true, record: null };
  }
}
async function runWorker(s: WorkerScenario): Promise<{ why: string | null; got: unknown }> {
  const footer = `Sam Lee\n\nIf you'd rather not hear from me, reply stop and I won't write again.`;
  const body = s.body.slice(0, s.body.indexOf("\n\nSam Lee"));
  const approved = { to: s.to, subject: s.subject, text: `${body}\n\n${footer}` };
  const hash = await payloadHash(approved);
  const draft = { recipient: { name: "X", firm: "", title: "", school: "", email: s.to, source: "t" }, subject: s.subject, body: s.tamper === "draft" ? `${body} P.S. one more line.` : body, footer };
  const claimed: any = {
    id: "q-1", user_id: "u-1", kind: s.kind, source_id: "d-1", approval_hash: hash, provider: "gmail", to: s.to, subject: s.subject,
    body: s.tamper === "queue" ? `${approved.text}\nP.S. added after approval` : approved.text, attempts: s.attempts, first_claimed_at: new Date(NOW - 600_000).toISOString(),
    follow_up_of: s.followUp ? "q-root" : null, from_email: "me@example.test", draft: s.kind === "outreach" ? draft : null,
    sequence: s.followUp ? [{ id: "q-root", recipient_email: s.to, gmail_id: "g-root", gmail_thread: "t-root", sent_at: new Date(NOW - 5 * DAY).toISOString() }] : null,
  };
  const calls: { name: string; p: any }[] = [];
  let claims = 0;
  const rpc = async (name: string, a: { p: any }) => {
    calls.push({ name, p: a.p });
    if (name === "career_send_claim") return { data: { accounts: claims++ ? [] : [{ user_id: "u-1", provider: "gmail", items: [claimed] }] }, error: null };
    if (name === "career_send_go") return s.go === "error" ? { data: null, error: { message: "connection reset" } } : { data: s.go, error: null };
    if (name === "career_send_complete") return { data: (a.p.results ?? []).map((x: any) => x.outcome), error: null };
    if (name === "career_send_record") return { data: a.p.kind, error: null };
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  };
  const posts: string[] = [];
  const reads: string[] = [];
  const at = (h: string, v: string) => ({ name: h, value: v });
  const lookalike = `x${s.to}`;
  const sentList = (): Response => {
    if (s.sent === "unreadable") return new Response("{}", { status: 500 });
    const m = s.sent === "none" ? [] : [{ id: "s-1", threadId: "ts-1" }];
    return Response.json({ messages: m });
  };
  const sentMsg = () => {
    const to = s.sent === "exact" || s.sent === "other_subject" || s.sent === "encoded_exact" ? s.to : s.sent === "exact_named" ? `"Chen, Maya" <${s.to}>` : s.sent === "lookalike" ? lookalike : `someone.else@${s.to.split("@")[1]}`;
    const subject = s.sent === "other_subject" ? "A different note" : s.sent === "encoded_exact" ? encodedWord(s.subject) : s.subject;
    return Response.json({ id: "s-1", threadId: "ts-1", payload: { headers: [at("To", to), at("Subject", subject)] } });
  };
  const seqThread = () => {
    if (s.seq === "unreadable") return new Response("{}", { status: 503 });
    const mine = { id: "g-root", labelIds: ["SENT"], snippet: "Hi", payload: { headers: [at("From", "me@example.test"), at("Subject", "Coffee chat?")] } };
    const theirs: Record<string, [string, string, string]> = {
      reply: [s.to, "Re: Coffee chat?", "Happy to talk next week. How is Tuesday?"],
      stop: [s.to, "Re: Coffee chat?", "Please remove me from your list."],
      bounce: ["Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Failure)", "Address not found. Your message wasn't delivered."],
      ooo: [s.to, "Automatic reply: Coffee chat?", "I am out of the office until next week with limited access to email."],
      delay: ["Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Delay)", "This is a warning message only. You do not need to resend your message."],
      other_addr_reply: [`Maya <maya.personal@gmail.example>`, "Re: Coffee chat?", "Writing from my personal email: yes, let's talk."],
    };
    const t = theirs[s.seq];
    return Response.json({ id: "t-root", messages: [mine, ...(t ? [{ id: "in-1", labelIds: ["INBOX"], snippet: t[2], payload: { headers: [at("From", t[0]), at("Subject", t[1])] } }] : [])] });
  };
  const fetch = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    if (u.host !== "gmail.googleapis.com") throw new Error(`unexpected host ${u.host}`);
    const path = u.pathname.replace("/gmail/v1/users/me", "");
    if (req.method === "POST" && path === "/messages/send") {
      posts.push(String((await req.json()).raw ?? ""));
      const a = gmailAnswer(s.gmail);
      if (a === "throw") throw new TypeError("network error");
      return a;
    }
    reads.push(`${path}?${u.searchParams.get("q") ?? ""}`);
    if (path === "/messages" && /in:sent/.test(u.searchParams.get("q") ?? "")) return sentList();
    if (path === "/messages" && /subject:unsubscribe/.test(u.searchParams.get("q") ?? "")) return Response.json({ messages: s.seq === "unsub_mailto" ? [{ id: "u-1" }] : [] });
    if (path === "/messages/s-1") return sentMsg();
    if (path === "/threads/t-root") return seqThread();
    return new Response("{}", { status: 404 });
  };
  const deps: WorkerDeps = {
    rpc: rpc as any, fetch: fetch as typeof globalThis.fetch, now: () => NOW,
    token: async (_u, scope) => (scope.endsWith("gmail.send") ? (s.sendToken ? "tok-send" : null) : (s.readToken ? "tok-read" : null)),
  };
  const stats = await runSendWorker(deps, { worker: "w-1", deadlineMs: 60_000 });
  const results = calls.filter((c) => c.name === "career_send_complete").flatMap((c) => c.p.results ?? []);
  const records = calls.filter((c) => c.name === "career_send_record").map((c) => c.p);
  const want = expectedOutcome(s);
  const got = { outcome: results.map((x: any) => x.outcome), posts: posts.length, records, detail: results[0]?.detail, resume: results[0]?.resume_at, err: stats.error };
  if (posts.length > 1) return { why: "sent twice", got };
  if (results.length !== 1) return { why: `one outcome recorded, not ${results.length}`, got };
  const res = results[0];
  if (res.outcome !== want.outcome) return { why: `outcome ${res.outcome}, wanted ${want.outcome}`, got };
  if ((posts.length === 1) !== want.post) return { why: want.post ? "it should have been sent" : "it went when it must not", got };
  if (want.record) { if (records.length !== 1 || records[0].id !== "q-root" || records[0].kind !== want.record) return { why: `the answer recorded on the first email as ${want.record}`, got }; }
  else if (records.length) return { why: "recorded an answer that is not one", got };
  if (want.outcome === "already_sent" && res.gmail_id !== "s-1") return { why: "already_sent names the message found in Sent", got };
  if (want.outcome === "quota" && Date.parse(res.resume_at) !== want.resumeAt) return { why: `backs off until ${new Date(want.resumeAt!).toISOString()}`, got };
  if (["quota", "reconnect", "policy"].includes(want.outcome) && res.untried !== true) return { why: "a refusal is not an attempt", got };
  // Handed back without reaching Gmail (the last check said stop, a follow-up's answer or unreadable thread): not an attempt.
  if (want.outcome === "retry" && !want.post && !(s.attempts > 1 && (!s.readToken || s.sent === "unreadable")) && res.untried !== true) return { why: "an email handed back unsent is not an attempt", got };
  if (want.outcome === "retry" && want.post && res.untried) return { why: "a try that may have reached Gmail is an attempt (Sent is checked next time)", got };
  if (posts.length) {
    const raw = b64urlDecode(posts[0]);
    const [head, enc] = raw.split("\r\n\r\n");
    const lines = head.split("\r\n");
    const h = (n: string) => lines.filter((l) => l.toLowerCase().startsWith(`${n.toLowerCase()}:`)).map((l) => l.slice(n.length + 1).trim());
    const text = new TextDecoder().decode(Uint8Array.from(atob(enc.replace(/\r\n/g, "")), (c) => c.charCodeAt(0))).replace(/\r\n/g, "\n");
    if (h("To").length !== 1 || h("To")[0] !== s.to) return { why: "To is exactly the one approved address", got: { ...got, to: h("To") } };
    if (decodeWord(h("Subject")[0] ?? "") !== s.subject) return { why: "Subject is exactly the approved one", got };
    if (text !== approved.text) return { why: "the body is exactly the approved text", got };
    if (h("From").length || h("Cc").length || h("Bcc").length || h("Reply-To").length) return { why: "no From, Cc, Bcc or Reply-To written", got };
    if (s.kind === "outreach" && !h("List-Unsubscribe").some((v) => v.includes("mailto:me@example.test?subject=unsubscribe"))) return { why: "cold outreach carries List-Unsubscribe to the person's own address", got };
  }
  // A retry reads Sent before it sends; a first try never needs to.
  if (s.attempts === 1 && reads.some((x) => /in:sent/.test(x))) return { why: "a first try does not search Sent", got };
  return { why: null, got };
}

Deno.test(`outreach at scale, the sending rail's worker on one claimed email: ${COUNTS.worker} scenarios`, async () => {
  const rep = new Report("worker");
  for (const s of ALL.worker) {
    let r: { why: string | null; got: unknown };
    try { r = await runWorker(s); } catch (e) { r = { why: `threw: ${e instanceof Error ? e.message : e}`, got: null }; }
    rep.grade(s, r.why, r.got);
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ followup
const RETURN = (t: number) => new Date(t).toLocaleString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
async function runFollowup(s: FollowupScenario): Promise<{ why: string | null; got: unknown }> {
  const store = memoryRepliesStore();
  const U = "u-1", CHAT = "chat-1", T0 = NOW - 40 * DAY, EMAIL = "maya.chen@acme.example";
  const tid = await store.track({ user_id: U, draft_id: "d-1", provider: "gmail", provider_thread: "t-1", email: EMAIL, name: "Maya Chen", firm: "Acme", subject: "Coffee chat?", sent_at: new Date(T0).toISOString() });
  await store.personTurn(U, tid, "m-0", new Date(T0).toISOString(), { summary: "sent" }, false); // the first email, read back from Sent
  if (Array.isArray(s.steps)) await store.setPrefs(U, { steps: s.steps, off: false });
  else if (s.steps === "off") await store.setPrefs(U, { steps: null, off: true });
  let modelCalls = 0, modelCallsQuiet = 0;
  const paused = s.events.find((e) => e.kind === "pause");
  const pausedAt = paused ? T0 + paused.day * DAY : Infinity;
  const quiet = async (ids: string[]) => new Set(ids.filter(() => curT >= pausedAt));
  const model = async () => { modelCalls++; if (curT >= pausedAt) modelCallsQuiet++; return { content: [{ type: "text", text: "Hi Maya, just following up on my earlier note. Would you have a few minutes this week?" }], stop_reason: "end_turn" }; };
  const outbox: { user: string; key: string; at: number }[] = [];
  const box = { enqueue: async (u: string, m: { key: string; at: number }) => { if (outbox.some((x) => x.key === m.key)) return false; outbox.push({ user: u, key: m.key, at: m.at }); return true; } };
  const sends: { at: number; step: number; text: string; to: string }[] = [];
  const rail: ReplyRail = { send: async (_u, _p, m, a) => { sends.push({ at: curT, step: Number((store.dump().actions as any[]).find((x) => x.id === a.sourceId)?.step), text: m.text, to: m.to }); return { status: "queued", id: `q-${a.sourceId}`, thread_id: "" }; } };
  const person = async () => ({ facts: [{ id: "f1", kind: "education", school: "TEST University", status: "confirmed" }], signature: SIGN, name: SIGN });
  let curT = T0;
  const applied: { kind: string; at: number; back?: number | null }[] = [];
  const drafted: { at: number; batch: string }[] = [];
  const msg = (id: string, from: string, subject: string, text: string, at: number) => ({ id, thread: "t-1", from, to: "me@example.test", subject, text, at: new Date(at).toISOString(), headers: {}, fromMe: false });
  for (curT = T0 + 3600_000; curT <= T0 + 40 * DAY; curT += s.runEveryHours * 3600_000) {
    // What happened on the thread since the last run.
    for (const e of s.events) {
      const t = T0 + e.day * DAY;
      if (t > curT || applied.some((x) => x.kind === e.kind && x.at === t)) continue;
      applied.push({ kind: e.kind, at: t, ...(e.kind === "ooo" ? { back: e.back } : {}) });
      const th = (await store.thread(U, tid))!;
      if (e.kind === "reply") await recordMessage({ store, userId: U, thread: th, msg: msg(`in-r-${t}`, `Maya Chen <${EMAIL}>`, "Re: Coffee chat?", "Thanks for reaching out, happy to chat next week.", t), model: null, now: curT, tz: "America/New_York" });
      else if (e.kind === "not_interested") await recordMessage({ store, userId: U, thread: th, msg: msg(`in-n-${t}`, `Maya Chen <${EMAIL}>`, "Re: Coffee chat?", "Not interested, please remove me from your list.", t), model: null, now: curT, tz: "America/New_York" });
      else if (e.kind === "bounce") await recordMessage({ store, userId: U, thread: th, msg: msg(`in-b-${t}`, "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Failure)", "Address not found. Your message wasn't delivered.", t), model: null, now: curT, tz: "America/New_York" });
      else if (e.kind === "ooo") await recordMessage({ store, userId: U, thread: th, msg: msg(`in-o-${t}`, `Maya Chen <${EMAIL}>`, "Automatic reply: Coffee chat?", e.back !== null ? `I am out of the office until ${RETURN(T0 + e.back * DAY)}.` : "I am out of the office with limited access to email.", t), model: null, now: curT, tz: "UTC" });
      else if (e.kind === "own_followup") await store.personTurn(U, tid, `me-${t}`, new Date(t).toISOString(), { summary: "you wrote" }, false);
      else if (e.kind === "dnc_elsewhere") store.addDnc(EMAIL);
    }
    const workers = s.twoWorkers ? ["w1", "w2"] : ["w1"];
    for (const w of workers) {
      const before = (store.dump().actions as any[]).length;
      await runFollowupDrafts({ store, outbox: box, model, person, now: curT, worker: w, quiet });
      const now = store.dump().actions as any[];
      if (now.length > before) { drafted.push({ at: curT, batch: now[now.length - 1].batch_id }); store.setIntent(CHAT, ACTIONS_INTENT); }
    }
    // The person's yes, when they are around (never while paused).
    const open = (store.dump().actions as any[]).filter((a) => a.status === "shown");
    if (s.approveAfterHours !== null && open.length && curT < pausedAt) {
      const d = drafted.find((x) => x.batch === open[0].batch_id);
      if (d && curT >= d.at + s.approveAfterHours * 3600_000) {
        store.setIntent(CHAT, ACTIONS_INTENT);
        await repliesTurn({ message: "yes", userId: U, chatThreadId: CHAT, now: curT, store });
      }
    }
    for (const w of workers) await runOutreachActions({ store, rail, calendars: {}, now: curT, worker: w });
  }
  // The oracle, from the scenario alone.
  const got = { sends: sends.map((x) => ({ day: +((x.at - T0) / DAY).toFixed(2), step: x.step })), applied, outbox: outbox.map((x) => x.key), modelCalls, modelCallsQuiet };
  const steps = Array.isArray(s.steps) ? s.steps : [];
  if (sends.length > steps.length) return { why: `more follow-ups (${sends.length}) than steps set (${steps.length})`, got };
  if (new Set(sends.map((x) => x.step)).size !== sends.length) return { why: "a step sent twice", got };
  let touch = T0;
  for (const [i, x] of sends.entries()) {
    if (x.step !== i + 1) return { why: "steps out of order", got };
    if (x.at < touch + steps[i] * DAY) return { why: `step ${i + 1} went before it was due`, got };
    if (x.to !== EMAIL) return { why: "a follow-up to another address", got };
    touch = x.at;
  }
  const stopAt = Math.min(...applied.filter((e) => ["reply", "not_interested", "bounce", "own_followup", "dnc_elsewhere"].includes(e.kind)).map((e) => e.at), Infinity);
  if (sends.some((x) => x.at >= stopAt)) return { why: "a follow-up after an answer (or an opt-out, or the person's own follow-up)", got };
  for (const e of applied.filter((x) => x.kind === "ooo" && x.back != null)) {
    const back = Date.UTC(new Date(T0 + e.back! * DAY).getUTCFullYear(), new Date(T0 + e.back! * DAY).getUTCMonth(), new Date(T0 + e.back! * DAY).getUTCDate());
    if (sends.some((x) => x.at >= e.at && x.at < back + DAY)) return { why: "a follow-up before the out-of-office return date (plus a day)", got };
  }
  if (modelCallsQuiet) return { why: "drafted for a paused person (model called)", got };
  if (outbox.some((x) => x.at >= pausedAt)) return { why: "asked or told a paused person something", got };
  if (s.steps === "off" && (sends.length || modelCalls)) return { why: "follow-ups are off", got };
  if (s.steps === null && (sends.length || modelCalls)) return { why: "no interval set: nothing drafted", got };
  if (s.steps === null && !paused && !outbox.some((x) => x.key === "status:outreach-followup-interval-ask")) return { why: "no interval set: the person is asked once", got };
  if (outbox.filter((x) => x.key === "status:outreach-followup-interval-ask").length > 1) return { why: "asked twice", got };
  // Liveness: a silent thread with a prompt yes gets every step.
  if (!s.events.length && s.approveAfterHours !== null && steps.length && sends.length !== steps.length) return { why: `a silent thread got ${sends.length} of ${steps.length} follow-ups`, got };
  return { why: null, got };
}

Deno.test(`outreach at scale, follow-ups (the replies lane, two workers, daily runs): ${COUNTS.followup} scenarios`, async () => {
  const rep = new Report("followup");
  for (const s of ALL.followup) {
    let r: { why: string | null; got: unknown };
    try { r = await runFollowup(s); } catch (e) { r = { why: `threw: ${e instanceof Error ? e.stack : e}`, got: null }; }
    rep.grade(s, r.why, r.got);
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ reply
async function runReply(s: ReplyScenario): Promise<{ why: string | null; got: unknown }> {
  const to = "maya.chen@acme.example";
  const rows: any[] = [];
  for (let k = 0; k <= s.steps; k++) rows.push({ id: `q-${k}`, user_id: "u-1", recipient_email: to, gmail_id: `g-${k}`, gmail_thread: `t-${k}`, sent_at: new Date(NOW - (10 - k * 2) * DAY).toISOString(), address_type: null, address_format: null });
  for (let k = 0; k < s.neighbours; k++) rows.push({ id: `n-${k}`, user_id: `u-${k + 2}`, recipient_email: `other${k}@globex.example`, gmail_id: `gn-${k}`, gmail_thread: `tn-${k}`, sent_at: new Date(NOW - 3 * DAY).toISOString(), address_type: null, address_format: null });
  const records: any[] = [];
  const rpc = async (name: string, a: { p: any }) => {
    if (name === "career_send_replies_due") return { data: rows, error: null };
    if (name === "career_send_record") { records.push(a.p); return { data: a.p.kind, error: null }; }
    return { data: null, error: { message: name } };
  };
  const at = (h: string, v: string) => ({ name: h, value: v });
  const incoming: Record<string, [string, string, string]> = {
    reply: [`Maya Chen <${to}>`, "Re: Coffee chat?", "Sure, happy to talk. Does Thursday work?"],
    stop: [`Maya Chen <${to}>`, "Re: Coffee chat?", "Please stop emailing me."],
    ooo: [`Maya Chen <${to}>`, "Out of Office: Coffee chat?", "I am on vacation until Monday."],
    bounce: ["postmaster@acme.example", "Undeliverable: Coffee chat?", "Delivery has failed to these recipients."],
    delay: ["Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Delay)", "This is a warning message only. You do not need to resend your message."],
    other_addr_reply: ["Maya <maya@personal.example>", "Re: Coffee chat?", "Replying from my personal address: happy to talk."],
    other_addr_stop: ["Maya <maya@personal.example>", "Re: Coffee chat?", "Please remove me from this thread."],
    receipt: [`Maya Chen <${to}>`, "Read: Coffee chat?", "Your message was read on Monday."],
  };
  const fetch = async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url), path = u.pathname.replace("/gmail/v1/users/me", "");
    if (req.method !== "GET") throw new Error("the reply check only reads");
    const th = /^\/threads\/(.+)$/.exec(path);
    if (th) {
      const row = rows.find((r) => r.gmail_thread === th[1]);
      if (!row) return new Response("{}", { status: 404 });
      const msgs: any[] = [{ id: row.gmail_id, labelIds: ["SENT"], snippet: "Hi", payload: { headers: [at("From", "me@example.test"), at("Subject", "Coffee chat?")] } }];
      const m = incoming[s.what];
      if (m && row.id === `q-${s.on}`) msgs.push({ id: `in-${s.on}`, labelIds: ["INBOX"], snippet: m[2], payload: { headers: [at("From", m[0]), at("Subject", m[1])] } });
      return Response.json({ id: th[1], messages: msgs });
    }
    if (path === "/messages") {
      const q = u.searchParams.get("q") ?? "";
      const hit = s.what === "unsub_mailto" && q.includes(`from:${to}`) && q.includes("subject:unsubscribe");
      return Response.json({ messages: hit ? [{ id: "unsub-1" }] : [] });
    }
    return new Response("{}", { status: 404 });
  };
  const deps: WorkerDeps = { rpc: rpc as any, fetch: fetch as typeof globalThis.fetch, now: () => NOW, token: async () => "tok-read" };
  const st = await runReplyCheck(deps, { limit: 200 });
  const got = { records, st };
  if (st.errors) return { why: "the check failed", got };
  if (records.some((r) => String(r.id).startsWith("n-"))) return { why: "recorded on someone else's email", got };
  const want: Record<string, string | null> = { reply: "reply", stop: "stop", ooo: null, bounce: "bounce", delay: null, other_addr_reply: "reply", other_addr_stop: "reply", receipt: null, unsub_mailto: "stop" };
  const w = want[s.what];
  if (s.what === "unsub_mailto") {
    if (!records.length || records.some((r) => r.kind !== "stop")) return { why: "the List-Unsubscribe mailto opts the contact out", got };
    return { why: null, got };
  }
  if (!w) return records.length ? { why: "recorded something that is not an answer", got } : { why: null, got };
  if (records.length !== 1 || records[0].id !== `q-${s.on}` || records[0].kind !== w) return { why: `recorded as ${w} on exactly the email it answered (q-${s.on})`, got };
  return { why: null, got };
}

Deno.test(`outreach at scale, what comes back on a sequence's threads, recorded on the right email: ${COUNTS.reply} scenarios`, async () => {
  const rep = new Report("reply");
  for (const s of ALL.reply) {
    let r: { why: string | null; got: unknown };
    try { r = await runReply(s); } catch (e) { r = { why: `threw: ${e instanceof Error ? e.message : e}`, got: null }; }
    rep.grade(s, r.why, r.got);
  }
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ draft
const FACTS = [{ id: "f1", kind: "education", school: "TEST University", degree: "B.S. Computer Science", status: "confirmed" }];
// PERSONALIZED OUTREACH (2026-10-31): each contact carries one sourced fact and the model writes from the engine's payload
// (personal-fixture.ts); was a generic "short call about your team" email to a contact with nothing on record.
const draftModel = engineAware(async (payload: any) => {
  const p = String(payload.messages?.[0]?.content ?? ""), first = /- name: (\S+)/.exec(p)![1];
  return { content: [{ type: "text", text: `Subject: A quick question\n\nHi ${first},\n\nWould you be open to a short call about your team?` }], stop_reason: "end_turn" };
});
async function runDraft(s: DraftScenario): Promise<{ why: string | null; got: unknown }> {
  const store = memoryOutreachStore();
  const U = "u-1", T = "chat-1";
  const state: Record<string, unknown> = { profile: { facts: FACTS } };
  const csv = ["Name,Company,Email,Title", ...s.people.map((p) => `${p.name},${s.firm[0]},${p.email},${p.title}`)].join("\n");
  const imp = await networkingTurn({ message: "here are my contacts", userId: U, threadId: T, now: NOW, state, store, model: null, attachments: [{ name: "contacts.csv", mime: "text/csv", text: csv }] });
  if (imp?.status !== "imported") return { why: `the contacts did not import: ${imp?.status}`, got: imp?.reply };
  await store.setPrefs(U, { signature: SIGN });
  await seedFacts(store, U, s.people.map((p) => p.email));
  for (const p of s.people) {
    if (p.block === "own_dnc") await store.addDnc(U, await emailHash(p.email), "recipient asked to stop", NOW);
    if (p.block === "other_dnc") await store.addDnc("u-someone-else", await emailHash(p.email), "recipient asked to stop", NOW);
    if (p.block === "bounced") store.markBounced(p.email);
  }
  const target = s.people[s.target];
  const message = s.ask === "name" ? `email ${target.name} at ${s.firm[0]} about a coffee chat` : `draft intros to my contacts at ${s.firm[0]}`;
  const r = await networkingTurn({ message, userId: U, threadId: T, now: NOW, state, store, model: draftModel });
  const drafts = store.dump().drafts;
  const got = { status: r?.status, to: drafts.map((d) => d.recipient.email), reply: r?.reply.slice(0, 300) };
  const want = (s.ask === "name" ? [target] : s.people).filter((p) => p.block === "clean").map((p) => p.email).sort();
  if (JSON.stringify(drafts.map((d) => d.recipient.email).sort()) !== JSON.stringify(want)) {
    const blocked = drafts.map((d) => s.people.find((p) => p.email === d.recipient.email)?.block).filter((b) => b && b !== "clean");
    return { why: blocked.length ? `drafted to an address no one may email (${[...new Set(blocked)].join(", ")})` : "a clean contact was not drafted", got };
  }
  for (const d of drafts) {
    const row = s.people.find((p) => p.email === d.recipient.email)!;
    if (messageOf(d).to !== row.email || d.recipient.name !== row.name || d.recipient.firm !== s.firm[0]) return { why: "the draft's recipient is exactly the contact's row", got };
    if (!/contacts\.csv, row \d+/.test(d.recipient.source)) return { why: "the draft names the list it came from", got };
  }
  for (const p of (s.ask === "name" ? [target] : s.people).filter((x) => x.block !== "clean")) {
    if (!r?.reply.includes(p.name)) return { why: `the reply says ${p.name} was not drafted`, got };
    if (p.block === "bounced" ? !/bounced/.test(r.reply) : !/asked not to be contacted/.test(r.reply)) return { why: "the reply says why", got };
  }
  return { why: null, got };
}

Deno.test(`outreach at scale, drafting never writes to an address no one may email: ${COUNTS.draft} scenarios`, async () => {
  const rep = new Report("draft");
  for (const s of ALL.draft) {
    let r: { why: string | null; got: unknown };
    try { r = await runDraft(s); } catch (e) { r = { why: `threw: ${e instanceof Error ? e.message : e}`, got: null }; }
    rep.grade(s, r.why, r.got);
  }
  rep.assertClean();
});

Deno.test("the generator is deterministic, ~10,000 scenarios, and covers what the owner listed", () => {
  const again = generate({ seed: 20261030 });
  eq(JSON.stringify(again), JSON.stringify(ALL), "same seed, same scenarios");
  const n = Object.values(ALL).reduce((a, b) => a + b.length, 0);
  assertNode.ok(n >= 10_000, `${n} scenarios`);
  const cats = (xs: { category: string }[], i: number) => new Set(xs.map((x) => x.category.split("/")[i]));
  for (const c of ["yes", "yes_except", "subset", "send_it", "nothing"]) assertNode.ok(cats(ALL.approve, 1).has(c), c);
  assertNode.ok(ALL.approve.some((s) => s.others.some((o) => o.where === "my_other_chat" && o.when === "after")), "a batch drafted in another chat after this one was shown");
  for (const k of ["edit", "tamper", "cancel"]) assertNode.ok(ALL.approve.some((s) => s.events.some((e) => e.kind === k)), k);
  for (const g of ["sent", "429_secs", "403_daily_words", "throw", "400_spam", "401"]) assertNode.ok(ALL.worker.some((s) => s.gmail === g), g);
  for (const st of ["exact", "lookalike", "unreadable"]) assertNode.ok(ALL.worker.some((s) => s.sent === st), st);
  for (const q of ["reply", "stop", "bounce", "ooo", "unsub_mailto"]) assertNode.ok(ALL.worker.some((s) => s.followUp && s.seq === q), q);
  for (const e of ["reply", "not_interested", "bounce", "ooo", "own_followup", "dnc_elsewhere", "pause"]) assertNode.ok(ALL.followup.some((s) => s.events.some((x) => x.kind === e)), e);
  for (const w of ["other_addr_stop", "unsub_mailto", "receipt"]) assertNode.ok(ALL.reply.some((s) => s.what === w), w);
  for (const b of ["own_dnc", "other_dnc", "bounced"]) assertNode.ok(ALL.draft.some((s) => s.people.some((p) => p.block === b)), b);
});
