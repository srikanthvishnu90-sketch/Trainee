// OUTREACH R4 (2026-11-05): a fresh-seed battery (seed 20261105) over networking outreach from the drafts to what comes
// back, in shapes the earlier rounds did not run (scenarios-outreach, -r3, scenarios-networking[-r2], scenarios-people-drafts-r3,
// scenarios-replies): whole lifecycles, both senders at once, and the older scheduled run's own reader. Pure functions, a
// fixed clock, the in-memory rail and a Gmail on the battery's clock (scenarios/outreach-r4-world.ts); no database, no
// network, no model. The database side: tests/architect/flow-scenarios-outreach-r4.test.ts (the real chat handler, real
// Postgres, a fake Gmail) and tests/db/career_outreach_r4.test.sql.
//   lifecycle  a batch of 1-6 drafts, then 4-12 random steps: the person's answers (send all / some / except / yes / only /
//              send it / a question / a hedge / a number not in the batch / edit / redo / skip / cancel / send none /
//              show), unrelated chat, the rail's worker, a Gmail 5xx (sent or not), the older scheduled sender, Gmail
//              connected late, replies (a bounce, a delay, an out-of-office, a read receipt, "stop", the List-Unsubscribe
//              mail, a colleague, a real answer) and both readers, days passing. Then the follow-up reminders 8 days on.
//              Invariants after every step: Gmail took only a payload the person approved, under that exact hash, still
//              their live approval (an edit, redo, skip or cancel ends it); one email per address; none to an address
//              after its bounce or stop was read; none on an approval older than 7 days; every rail email carries
//              List-Unsubscribe; what the chat said ("Approved N", "Won't be sent") is what happened; the draft and the
//              rail agree; a reminder only for an email nobody answered.
//   replies    the older run's reader (career_outreach.ts classifyReply / recordReply) against the rail's
//              (classifyIncoming), on bounces, delays, receipts, auto-replies, opt-outs in many languages, real answers and
//              colleagues: the same reading of the contact's own mail; a delay or an away notice changes nothing.
//   facts      D-007 through the drafter (draftFor) with a scripted writer: a claim about the person traces only to a
//              CONFIRMED fact (never a pending, quarantined or delegated one), a claim about the contact only to their
//              row, "in common" only to both; the honest sentence passes; a writer that adds the claim only on its first
//              try ends with a draft that does not carry it.
//   dupes      group drafts over contact lists with one address under two names or in another case, missing addresses,
//              opted-out and bounced ones: one draft per address, numbered 1..N once each, every one not drafted said with
//              its reason, and "send a-b" approves exactly those numbers.
//   guessed    people web discovery found: drafted only at an address that may be sent to, the card labels an inferred
//              address as a guess, and the rail is told it is inferred.
//   legacy     the older scheduled sender (runOutreachSends) never sends a draft the rail has, an address that bounced
//              for anyone, an opted-out one, a lapsed approval, or anything for a paused person; the rest exactly once.
import assertNode from "node:assert/strict";
import {
  classifyReply, draftFor, emailHash, footerOf, memoryOutreachStore, messageOf, type OutreachDraft, OUTREACH_INTENT, outreachTurn, payloadHash, recordReply,
  runOutreachReplies, runOutreachSends, type Sender,
} from "../../supabase/functions/_shared/career_outreach.ts";
import { classifyIncoming, queueApprovedOutreach, runReplyCheck, runSendWorker, type WorkerDeps } from "../../supabase/functions/_shared/career_send_rail.ts";
import { runOutreachFollowups } from "../../supabase/functions/_shared/career_outreach_track.ts";
import { memoryRail, sentMessage, VirtualGmail } from "./scenarios/outreach-r4-world.ts";
import { world } from "./scenarios/people-drafts-r3.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SEED = 20261105;
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type R = () => number;
const pick = <T>(r: R, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
const int = (r: R, a: number, b: number) => a + Math.floor(r() * (b - a + 1));
class Report {
  total = 0; fails = new Map<string, string[]>();
  constructor(public what: string) {}
  grade(cat: string, why: string | null, got: unknown) {
    this.total++;
    if (why) this.fail(cat, why, got);
  }
  fail(cat: string, why: string, got: unknown) {
    const k = `${cat}: ${why}`;
    if (!this.fails.has(k)) this.fails.set(k, []);
    this.fails.get(k)!.push(JSON.stringify(got).slice(0, 400));
  }
  done(min: number) {
    const n = [...this.fails.values()].reduce((a, b) => a + b.length, 0);
    console.log([`[outreach r4] ${this.what}: ${this.total} scenarios, ${n} failures`, ...[...this.fails].flatMap(([k, xs]) => [`  FAIL ${k}: ${xs.length}`, ...xs.slice(0, 3).map((x) => `    ${x}`)])].join("\n"));
    assertNode.ok(this.total >= min, `${this.what}: ${this.total} < ${min} scenarios`);
    eq(n, 0, `${this.what}: ${n} failures in ${this.total} scenarios (see the report above)`);
  }
}
export const R4_COUNTS = { lifecycle: 2500, replies: 2000, facts: 2000, dupes: 1500, guessed: 800, legacy: 1200 };

const HOUR = 3_600_000, DAY = 86_400_000;
const T0 = Date.parse("2026-11-05T15:00:00Z");
const NAMES = ["Maya Chen", "Jordan Lee", "Priya Shah", "Alex Kim", "Sam Rivera", "Noah Patel", "Lena Fischer", "Omar Haddad", "Grace Okafor", "Tara Nolan"];
const FIRMS = ["Stripe", "Ramp", "Plaid", "Brex", "Figma", "Notion"];
const SIGN = "Sam Testcase";
const FOOT = footerOf(SIGN);

// ================================================================================================ lifecycle
type Answer = { text: string; kind: "send" | "it" | "nothing" | "edit" | "redo" | "skip" | "cancel" | "none" | "show"; ns?: number[]; all?: boolean; except?: number[]; n?: number; body?: string };
function answerOf(r: R, size: number, seq: number): Answer {
  const n = int(r, 1, size), m = int(r, 1, size), lo = Math.min(n, m), hi = Math.max(n, m);
  const range = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
  switch (int(r, 0, 15)) {
    case 0: return { text: pick(r, ["send all", "approve all", "send them all", "send all of them"]), kind: "send", all: true, except: [] };
    case 1: return { text: pick(r, ["yes", "yep", "go ahead", "send them", "yes, send them all", "yes to all"]), kind: "send", all: true, except: [] };
    case 2: return { text: lo === hi ? `send ${lo}` : pick(r, [`send ${lo}-${hi}`, `send ${range.join(",")}`, `send ${range.join(" and ")}`]), kind: "send", ns: range };
    case 3: return { text: pick(r, [`send all except ${n}`, `yes except ${n}`, `send all but ${n}`]), kind: "send", all: true, except: [n] };
    case 4: return { text: pick(r, [`only ${lo}-${hi}`, `just send ${lo}-${hi}`]).replace(`${lo}-${lo}`, `${lo}`), kind: "send", ns: range };
    case 5: return { text: pick(r, ["send it", "looks good, send it", "approve this one"]), kind: "it" };
    case 6: return { text: pick(r, ["send them all?", `send ${n}?`, "yes?", "approve all?"]), kind: "nothing" };
    case 7: return { text: pick(r, ["maybe", "ok", "sure", "hmm, let me think", "yes but not Acme", "not sure yet", "later"]), kind: "nothing" };
    case 8: return { text: `send ${size + int(r, 1, 3)}`, kind: "nothing" };
    case 9: { const body = `Hi there,\n\nA shorter note (${seq}): could we talk for 10 minutes this week?`; return { text: `edit ${n}: ${body}`, kind: "edit", n, body }; }
    case 10: return { text: `redo ${n}`, kind: "redo", n };
    case 11: return { text: `skip ${n}`, kind: "skip", n };
    case 12: return { text: pick(r, [`cancel ${n}`, `don't send ${n}`, `unapprove ${n}`]), kind: "cancel", n };
    case 13: return { text: pick(r, ["send none", "none", "don't send any"]), kind: "none" };
    case 14: return { text: pick(r, ["show my drafts", "show drafts"]), kind: "show" };
    default: return { text: pick(r, ["send all", "yes"]), kind: "send", all: true, except: [] };
  }
}
const INCOMING = ["bounce", "delay", "ooo", "receipt", "stop", "unsubscribe_mail", "colleague", "reply", "not_interested"] as const;
type Incoming = typeof INCOMING[number];
function mailOf(kind: Incoming, to: string, subject: string): { from: string; subject: string; text: string } {
  const name = to.split("@")[0];
  switch (kind) {
    case "bounce": return { from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Failure)", text: `Address not found. Your message wasn't delivered to ${to} because the address couldn't be found.` };
    case "delay": return { from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Delay)", text: "This is a warning message only. You do not need to resend your message. Delivery will continue to be attempted." };
    case "ooo": return { from: `${name} <${to}>`, subject: `Automatic reply: ${subject}`, text: "I am out of the office until Monday with limited access to email." };
    case "receipt": return { from: `${name} <${to}>`, subject: `Read: ${subject}`, text: "Your message was read on Monday, November 9, 2026." };
    case "stop": return { from: `${name} <${to}>`, subject: `Re: ${subject}`, text: "Please remove me from your list.\n\nOn Tue, Nov 3, 2026 Sam wrote:\n> Would you have 15 minutes?" };
    case "not_interested": return { from: `${name} <${to}>`, subject: `Re: ${subject}`, text: "Not interested, thanks." };
    case "colleague": return { from: "Bob Partner <bob.partner@elsewhere.example>", subject: `Re: ${subject}`, text: "She is away; happy to chat instead." };
    case "reply": return { from: `${name} <${to}>`, subject: `Re: ${subject}`, text: "Happy to chat! How is Thursday at 2?" };
    default: return { from: to, subject: "unsubscribe", text: "" };
  }
}

async function lifecycle(r: R, i: number, rep: Report) {
  let clock = T0 + i * 7;
  const now = () => clock;
  const u = `u${i}`, other = `o${i}`, thread = `t${i}`;
  const store = memoryOutreachStore();
  await store.setPrefs(u, { signature: SIGN });
  const connected = new Set<string>(r() < 0.85 ? [u] : []);
  const quiet = new Set<string>();
  const rail = memoryRail(store, { now, connected, quiet });
  const gmail = new VirtualGmail(now);
  const size = int(r, 1, 6);
  const tos = Array.from({ length: size }, (_, k) => `${pick(r, NAMES).split(" ")[0].toLowerCase()}.${k}.${i}@${pick(r, FIRMS).toLowerCase()}.example`);
  // Some addresses were already blocked for anyone before the approval (another person's "stop", a bounce).
  const preBlocked = new Set<string>();
  for (const to of tos) {
    if (r() < 0.06) { await store.addDnc(other, await emailHash(to), "stop", clock); preBlocked.add(to); }
    else if (r() < 0.05) { store.markBounced(to); preBlocked.add(to); }
  }
  const ds = [];
  for (const [k, to] of tos.entries()) {
    const name = `${pick(r, NAMES)}`;
    const d = { n: k + 1, recipient: { name, firm: "Acme", title: "Analyst", school: "", email: r() < 0.2 ? to.toUpperCase() : to, source: "contacts.csv" }, subject: `A quick question ${k + 1}`,
      body: `Hi ${name.split(" ")[0]},\n\nWould you have 15 minutes this week?`, footer: FOOT, shared: [], status: "shown" as const, hash: "", approved_hash: null, approved_at: null,
      sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(clock).toISOString() };
    d.hash = await payloadHash(messageOf(d));
    ds.push(d);
  }
  const saved = await store.saveBatch(u, thread, ds, clock);
  const batchAt = clock;
  store.setIntent(thread, OUTREACH_INTENT);
  const idOf = new Map(saved.map((d) => [d.n, d.id]));
  const addrOf = new Map(saved.map((d) => [d.id, d.recipient.email.trim().toLowerCase()]));
  // The oracle: each draft's message as last shown, the person's live approval (hash and when), every hash ever approved.
  const shownHash = new Map<string, string>(await Promise.all(saved.map(async (d) => [d.id, await payloadHash(messageOf(d))] as [string, string])));
  const live = new Map<string, { hash: string; at: number } | null>();
  const blockedAt = new Map<string, number>(); // address -> when its bounce or stop was read (or before the batch)
  for (const a of preBlocked) blockedAt.set(a, -Infinity);
  const answered = new Set<string>(); // addresses whose email someone answered (as the readers recorded it)
  let seenSends = 0, redo = 0;
  const trail: string[] = [];
  const latest = async () => new Map((await store.latestBatch(u)).map((d) => [d.n, d]));
  const deps: WorkerDeps = {
    rpc: rail.rpc, fetch: gmail.fetch, now,
    token: async (x, scope) => (connected.has(x) ? `tok-${scope.endsWith("gmail.send") ? "send" : "read"}-${x}` : null),
    drafts: (x, ids) => store.drafts!(x, ids),
  };
  const sender: Sender = { send: async (x, m) => (connected.has(x) ? (() => { const s = gmail.legacySend(x, m); return { status: "sent" as const, id: s.id, thread_id: s.thread }; })() : { status: "NOT_WIRED" as const, reason: "no grant" }) };
  const onApproved = async (x: string, items: { draftId: string; approvalHash: string }[]) =>
    (await queueApprovedOutreach({ rpc: rail.rpc, drafts: (y, ids) => store.drafts!(y, ids) }, x, items)).filter((q) => q.status === "refused").map((q) => ({ draftId: q.sourceId, reason: String(q.reason ?? "") }));

  const checkSends = async (step: string) => {
    for (const s of gmail.sent.slice(seenSends)) {
      const to = s.to.trim().toLowerCase();
      const id = [...addrOf].find(([, a]) => a === to)?.[0];
      const h = await payloadHash(sentMessage(s));
      const lv = id ? live.get(id) : null;
      rep.grade("lifecycle", !id ? "Gmail took an email to an address not in the batch" : null, { step, to });
      rep.grade("lifecycle", id && (!lv || lv.hash !== h) ? "Gmail took a payload that is not the person's live approval of that exact message" : null, { step, to, via: s.via, live: lv, h, trail });
      rep.grade("lifecycle", gmail.sent.filter((x) => x.to.trim().toLowerCase() === to).length > 1 ? "two emails to one address" : null, { step, to, vias: gmail.sent.filter((x) => x.to.trim().toLowerCase() === to).map((x) => x.via), trail });
      rep.grade("lifecycle", (blockedAt.get(to) ?? Infinity) <= s.at ? "an email to an address after its bounce or stop was read" : null, { step, to, via: s.via, trail });
      rep.grade("lifecycle", lv && s.at - lv.at > 7 * DAY ? "an email sent on an approval older than 7 days" : null, { step, to, age: lv ? s.at - lv.at : 0 });
      rep.grade("lifecycle", s.via === "rail" && !s.headers.some((x) => /^List-Unsubscribe: <mailto:/.test(x)) ? "a rail email without List-Unsubscribe" : null, { step, headers: s.headers });
    }
    seenSends = gmail.sent.length;
  };

  const steps = int(r, 4, 12);
  for (let s = 0; s < steps; s++) {
    const op = pick(r, ["answer", "answer", "answer", "answer", "worker", "worker", "fail", "legacy", "incoming", "check", "chat", "time", "connect"] as const);
    trail.push(op);
    if (op === "answer") {
      const a = answerOf(r, size, ++redo);
      trail.push(a.text.slice(0, 40));
      const before = await latest();
      const intent = await store.lastAssistantIntent(thread);
      const fresh = clock - batchAt <= 72 * HOUR;
      // The oracle's expectation of what this answer approves.
      let expect: number[] = [];
      const shownNs = [...before.values()].filter((d) => d.status === "shown").map((d) => d.n);
      if (a.kind === "send" && intent === OUTREACH_INTENT && fresh) {
        const named = a.all ? [...before.keys()].filter((n) => !(a.except ?? []).includes(n)) : a.ns!;
        const all = [...(a.ns ?? []), ...(a.except ?? [])];
        if (all.every((n) => before.has(n))) expect = named.filter((n) => before.get(n)!.status === "shown");
      } else if (a.kind === "it" && intent === OUTREACH_INTENT && fresh && shownNs.length === 1) expect = shownNs;
      const res = await outreachTurn({ message: a.text, userId: u, threadId: thread, now: clock, store, onApproved, gmailConnected: async () => connected.has(u),
        redraft: async (d) => ({ ok: true, subject: d.subject, body: `${d.body.split("\n\n")[0]}\n\nA new version (${redo}): would you have 15 minutes?`, shared: [], tries: 1 }) });
      store.setIntent(thread, res?.intent ?? "career_other");
      const got = (res?.approved ?? []).map((x) => x.n).sort((p, q) => p - q);
      rep.grade("lifecycle", JSON.stringify(got) !== JSON.stringify(expect) ? "the answer approved other drafts than the ones it named and the person saw" : null, { text: a.text, intent, expect, got, trail });
      for (const x of res?.approved ?? []) {
        rep.grade("lifecycle", x.approvalHash !== shownHash.get(x.draftId) ? "an approval bound to a hash other than the message shown" : null, { n: x.n });
        live.set(x.draftId, { hash: x.approvalHash, at: clock });
      }
      const said = res?.reply ?? "";
      rep.grade("lifecycle", expect.length && !said.includes(`Approved ${expect.length}, exactly as shown`) ? "the reply does not say how many were approved" : null, { said: said.slice(0, 200), expect });
      rep.grade("lifecycle", !expect.length && /\bApproved \d/.test(said) ? "the reply says something was approved when nothing was" : null, { said: said.slice(0, 200) });
      for (const n of expect) {
        const to = addrOf.get(idOf.get(n)!)!;
        if (blockedAt.has(to)) rep.grade("lifecycle", !new RegExp(`Won't be sent: [^.]*\\b${n} \\(`).test(said) ? "an approval the rail refused for good is not said as won't be sent" : null, { n, said: said.slice(0, 300) });
      }
      // Edits and take-backs end the live approval; what is shown now is the new message.
      const after = await latest();
      for (const [n, d] of after) {
        const b = before.get(n)!;
        if (d.hash !== b.hash || (["shown", "approved"].includes(b.status) && d.status === "skipped")) live.set(d.id, null);
        if (d.status === "shown") shownHash.set(d.id, await payloadHash(messageOf(d)));
        rep.grade("lifecycle", d.status === "shown" && d.hash !== shownHash.get(d.id) ? "a shown draft's stored hash is not its message's" : null, { n });
        rep.grade("lifecycle", d.status === "shown" && d.approved_hash ? "a shown draft still carries an approval" : null, { n, status: d.status });
      }
      if (a.kind === "edit" || a.kind === "redo") {
        const b = before.get(a.n!), d = after.get(a.n!);
        if (b && d && ["shown", "approved"].includes(b.status) && intent === OUTREACH_INTENT && fresh) {
          rep.grade("lifecycle", d.status !== "shown" || d.approved_hash ? "an edited draft is not back to needing an approval" : null, { b: b.status, d: d.status });
          if (a.kind === "edit") rep.grade("lifecycle", !d.body.includes(a.body!.trim()) ? "the edit is not the person's own words" : null, { body: d.body });
        }
      }
    } else if (op === "worker" || op === "fail") {
      if (op === "fail") gmail.refuse = { n: 1, status: 503, went: r() < 0.5 };
      for (let k = 0; k < 3; k++) { const st = await runSendWorker(deps, { worker: "w", deadlineMs: 60_000 }); if (!st.claims) break; }
      gmail.refuse = null;
    } else if (op === "legacy") {
      await runOutreachSends({ store, sender, now: clock });
    } else if (op === "incoming") {
      const s = gmail.sent.length ? pick(r, gmail.sent) : null;
      if (s) {
        const kind = pick(r, INCOMING);
        const m = mailOf(kind, s.to.trim().toLowerCase(), s.subject);
        if (kind === "unsubscribe_mail") gmail.received(u, s.to.trim().toLowerCase(), "unsubscribe"); else gmail.reply(s.thread, m.from, m.subject, m.text);
        trail.push(kind);
      }
    } else if (op === "check") {
      clock += 5 * 60_000;
      const blockedBefore = await store.blocked!(tos.map((x) => x.toLowerCase()));
      await runReplyCheck(deps, {});
      await runOutreachReplies({ store, now: clock, read: async (x, tid) => connected.has(x)
        ? { status: "ok", messages: (gmail.threads.get(tid) ?? []).filter((m) => !m.labelIds.includes("SENT")).map((m) => ({ from: m.from, subject: m.subject, snippet: m.text.slice(0, 200), at: new Date(clock).toISOString() })) }
        : { status: "NOT_WIRED" } });
      const blockedNow = await store.blocked!(tos.map((x) => x.toLowerCase()));
      for (const [a] of blockedNow) if (!blockedBefore.has(a)) blockedAt.set(a, clock);
      // What the threads say, read by the oracle itself: bounce / stop must now block the address; a delay, receipt or
      // away notice must not have changed anything.
      for (const sm of gmail.sent) {
        const to = sm.to.trim().toLowerCase();
        const msgs = (gmail.threads.get(sm.thread) ?? []).filter((m) => !m.labelIds.includes("SENT"));
        const kinds = msgs.map((m) => (/mailer-daemon/.test(m.from) ? (/Failure/.test(m.subject) ? "bounce" : "delay") : m.from.includes(to) ? (/^Automatic reply|^Read:/.test(m.subject) ? "auto" : /remove me|Not interested/.test(m.text) ? "stop" : "reply") : "colleague"));
        const unsub = gmail.inbox.some((m) => m.from === to);
        if (!connected.has(u)) continue;
        // Known to have gone: the rail recorded it sent (a 5xx that Gmail took is found in Sent on the next try, then read),
        // or the older run marked its draft sent.
        const known = sm.via === "rail" ? rail.rows.some((q) => q.to === to && ["sent", "replied", "bounced"].includes(q.state))
          : store.dump().drafts.some((d) => d.recipient.email.trim().toLowerCase() === to && ["sent", "replied", "bounced"].includes(d.status));
        if (!known) continue;
        if (kinds.includes("bounce") || kinds.includes("stop") || (unsub && sm.via === "rail")) {
          rep.grade("lifecycle", !blockedNow.has(to) ? "a bounce or a stop that was read does not block the address" : null, { to, kinds, via: sm.via, trail });
        }
        if (kinds.length && kinds.every((k) => k === "delay" || k === "auto")) {
          const d = (await store.drafts!(u, [[...addrOf].find(([, x]) => x === to)?.[0] ?? ""]))[0];
          rep.grade("lifecycle", d && d.status !== "sent" ? "a delay warning, read receipt or out-of-office changed the draft" : null, { to, status: d?.status, kinds, via: sm.via });
          rep.grade("lifecycle", blockedNow.has(to) && !blockedBefore.has(to) ? "a delay warning, read receipt or out-of-office blocked the address" : null, { to, kinds });
        }
        if (kinds.some((k) => k !== "delay" && k !== "auto") || unsub) answered.add(to);
      }
    } else if (op === "chat") {
      store.setIntent(thread, "career_other");
    } else if (op === "time") {
      clock += pick(r, [HOUR, 6 * HOUR, DAY, 3 * DAY, 8 * DAY]);
    } else if (op === "connect") {
      connected.add(u);
    }
    await checkSends(op);
  }
  // The rail and the drafts agree; one email per draft sent.
  const all = store.dump().drafts.filter((d) => d.user_id === u);
  for (const d of all) {
    const n = gmail.sent.filter((s) => s.to.trim().toLowerCase() === d.recipient.email.trim().toLowerCase()).length;
    rep.grade("lifecycle", ["sent", "replied", "bounced"].includes(d.status) && n !== 1 ? "a draft marked sent without exactly one email in Gmail" : null, { status: d.status, n, trail });
    rep.grade("lifecycle", !["sent", "replied", "bounced", "sending"].includes(d.status) && n > 0 && d.status !== "approved" ? `an emailed draft says ${d.status}` : null, { status: d.status, n, trail });
  }
  for (const q of rail.rows) if (q.state === "sent") rep.grade("lifecycle", !["sent", "replied", "bounced"].includes(all.find((d) => d.id === q.source_id)?.status ?? "") ? "the rail says sent and the draft does not" : null, { q: q.state });
  // Reminders 8 days on: only for an email nobody answered.
  const sentDrafts = all.filter((d) => d.sent_at && ["sent", "replied", "bounced"].includes(d.status));
  if (sentDrafts.length && store.saveFollowups) {
    await store.saveFollowups(u, sentDrafts.map((d) => ({ draft_id: d.id, name: d.recipient.name, firm: d.recipient.firm, email: d.recipient.email, subject: d.subject, sent_at: d.sent_at!, due_at: new Date(Date.parse(d.sent_at!) + 7 * DAY).toISOString(), set_at: d.sent_at!, fired_at: null, asked: false })));
    const queued: { key: string }[] = [];
    await runOutreachFollowups({ store, outbox: { enqueue: async (_x, m) => { queued.push(m); return true; } }, now: clock + 8 * DAY } as any);
    for (const q of queued) {
      const d = sentDrafts.find((x) => q.key.endsWith(x.id))!;
      const to = d.recipient.email.trim().toLowerCase();
      rep.grade("lifecycle", answered.has(to) && connected.has(u) ? "a follow-up reminder for an email someone answered" : null, { to, status: d.status, trail });
    }
  }
}

// ================================================================================================ replies
const OPTOUTS = ["Please stop emailing me.", "Unsubscribe", "Remove me from your list please.", "Not interested, thanks.", "No thank you.", "I'd prefer not to be contacted again.",
  "Por favor, quítenme de su lista.", "Merci de ne plus me contacter.", "Bitte kontaktieren Sie mich nicht mehr.", "Non mi interessa, grazie.", "Não tenho interesse.", "Geen interesse, dank u.",
  "Proszę mnie wypisać.", "Отпишите меня, пожалуйста.", "请不要再给我发邮件。", "더 이상 연락하지 마세요."];
const POSITIVE = ["Happy to chat! How is Thursday?", "Sure, send me a few times.", "Thanks for reaching out. Yes, let's talk next week.", "Don't stop now, this sounds great.", "Glad to help, call me Monday.", "Gracias, me encantaría hablar."];
const AWAY = [["Automatic reply: Hello", "I am out of the office until Monday."], ["Out of Office: Hello", "I'm away with limited access to email."], ["Abwesenheitsnotiz: Hello", "Ich bin nicht im Büro."], ["Réponse automatique : Hello", "Je suis absente jusqu'au 12."], ["Respuesta automática: Hello", "Estoy fuera de la oficina."]];
const NOTICES = [["Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Failure)", "Address not found", "bounce"], ["postmaster@acme.example", "Undeliverable: Hello", "Delivery has failed to these recipients", "bounce"],
  ["Mail Delivery System <MAILER-DAEMON@mx.acme.example>", "Undelivered Mail Returned to Sender", "I'm sorry to have to inform you that your message could not be delivered", "bounce"],
  ["Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "Delivery Status Notification (Delay)", "This is a warning message only. Delivery will continue to be attempted.", "other"],
  ["MAILER-DAEMON@mx.acme.example", "Delayed Mail (still being retried)", "This is a warning only; you do not need to resend.", "other"]];
async function repliesBattery(rep: Report, n: number) {
  const r = rng(SEED + 2);
  for (let i = 0; i < n; i++) {
    const to = `c${i}@acme.example`;
    const k = int(r, 0, 5);
    let m: { from: string; subject: string; snippet: string }, want: string;
    if (k === 0) { const x = pick(r, NOTICES); m = { from: x[0], subject: x[1], snippet: x[2] }; want = x[3]; }
    else if (k === 1) { const x = pick(r, AWAY); m = { from: `C <${to}>`, subject: x[0], snippet: x[1] }; want = "other"; }
    else if (k === 2) { m = { from: `C <${to}>`, subject: pick(r, ["Read: Hello", "Gelesen: Hello"]), snippet: "Your message was read on Monday." }; want = "other"; }
    else if (k === 3) { m = { from: pick(r, [`C <${to}>`, to, `"Doe, C" <${to.toUpperCase()}>`]), subject: pick(r, ["Re: Hello", "RE: Hello", "Hello"]), snippet: `${pick(r, ["", "Hi Sam,\n\n"])}${pick(r, OPTOUTS)}${pick(r, ["", "\n\nBest,\nC", "\n\nOn Tue Sam wrote:\n> Would you have 15 minutes?"])}` }; want = "stop"; }
    else if (k === 4) { m = { from: `C <${to}>`, subject: "Re: Hello", snippet: `${pick(r, POSITIVE)}${pick(r, ["", "\n\nOn Tue Sam wrote:\n> If you'd rather not hear from me, reply stop and I won't write again."])}` }; want = "reply"; }
    else { m = { from: "Colleague <other@acme.example>", subject: "Re: Hello", snippet: pick(r, [...POSITIVE, "Please stop emailing me."]) }; want = "other"; }
    const legacy = classifyReply({ ...m, at: "2026-11-05T00:00:00Z" }, to);
    const railK = classifyIncoming(m, to);
    rep.grade("replies", legacy !== want ? `the older reader read a ${want} as ${legacy}` : null, { m, legacy });
    // The contact's own mail reads the same to both readers (a colleague's answer stops the rail's sequence; the older
    // reader leaves the draft as it is: WO-033).
    if (k !== 5) rep.grade("replies", (railK === "other" ? "other" : railK) !== legacy ? "the two readers disagree on the contact's own mail" : null, { m, legacy, railK });
    // recordReply on a sent draft: what it does to the draft and the lists.
    if (i % 4 === 0) {
      const store = memoryOutreachStore();
      const d = { n: 1, recipient: { name: "C", firm: "Acme", title: "", school: "", email: to, source: "x" }, subject: "Hello", body: "Hi", footer: FOOT, shared: [], status: "sent" as const, hash: "h",
        approved_hash: "h", approved_at: null, sent_at: "2026-11-01T00:00:00Z", gmail_id: "g", gmail_thread: "t", result: "sent", created_at: "2026-11-01T00:00:00Z" };
      const [saved] = await store.saveBatch("u", "t", [d], T0);
      const got = await recordReply({ store, userId: "u", draft: saved, mail: { ...m, at: "2026-11-05T00:00:00Z" }, now: T0 });
      const after = (await store.drafts!("u", [saved.id]))[0];
      const blocked = (await store.blocked!([to])).get(to) ?? null;
      const wantStatus = want === "bounce" ? "bounced" : want === "stop" || want === "reply" ? "replied" : "sent";
      rep.grade("replies", after.status !== wantStatus ? `recordReply left the draft ${after.status}, wanted ${wantStatus}` : null, { m, got });
      rep.grade("replies", want === "stop" && blocked !== "opted_out" ? "a stop is not on the do-not-contact list" : null, { m });
      rep.grade("replies", want === "bounce" && blocked !== "bounced" ? "a bounce read by the older reader is not on the bounce list (anyone could email it again)" : null, { m, blocked });
      rep.grade("replies", (want === "other" || want === "reply") && blocked ? "a reply, delay or away notice blocked the address" : null, { m, blocked });
    }
  }
}

// ================================================================================================ facts
const EMPLOYERS = ["Bravo Labs", "Northwind Traders", "Contoso Health", "Fabrikam", "Globex", "Initech", "Stark Analytics"];
const SCHOOLS = ["DePaul University", "Purdue University", "Rice University", "Tufts University", "Emory University"];
type FactState = "confirmed" | "pending" | "quarantined" | "delegated" | "absent";
function factOf(state: FactState, kind: string, text: string, id: string) {
  if (state === "confirmed") return { id, kind, text, status: "confirmed" };
  if (state === "pending") return { id, kind, text, status: "pending", needs_confirmation: true };
  if (state === "quarantined") return { id, kind, text, status: "confirmed", quarantined: true };
  if (state === "delegated") return { id, kind, text, status: "confirmed", source: "owner-delegated answers" };
  return null;
}
async function factsBattery(rep: Report, n: number) {
  const r = rng(SEED + 3);
  for (let i = 0; i < n; i++) {
    const name = pick(r, NAMES), first = name.split(" ")[0];
    const firm = pick(r, FIRMS), rowSchool = pick(r, SCHOOLS);
    const emp = pick(r, EMPLOYERS.filter((e) => e !== "Bravo Labs")), school = pick(r, SCHOOLS);
    const st: FactState = pick(r, ["confirmed", "confirmed", "pending", "quarantined", "delegated", "absent"] as const);
    const kind = int(r, 0, 5);
    // A base the person always has, confirmed.
    const facts: any[] = [{ id: "F-1", kind: "experience", text: "Data analyst intern at Bravo Labs", status: "confirmed" }];
    let claim = "", pass = false;
    const recipient = { name, firm, title: "Data Scientist", school: rowSchool, email: `${first.toLowerCase()}@${firm.toLowerCase()}.example`, source: "contacts.csv" };
    if (kind === 0) { const f = factOf(st, "experience", `Analyst at ${emp}`, "F-2"); if (f) facts.push(f); claim = pick(r, [`I worked at ${emp} last year.`, `I interned at ${emp}.`, `I was an analyst at ${emp}.`]); pass = st === "confirmed"; }
    else if (kind === 1) { const f = factOf(st, "education", `BS Economics, ${school}, Class of 2027`, "F-2"); if (f) facts.push(f); claim = pick(r, [`I studied at ${school}.`, `I'm a student at ${school}.`, `I graduated from ${school}.`]); pass = st === "confirmed"; }
    else if (kind === 2) { const other = pick(r, FIRMS.filter((x) => x !== firm)); const onRow = r() < 0.5; claim = `I saw you worked at ${onRow ? firm : other}.`; pass = onRow; }
    else if (kind === 3) {
      // In common: the school on their row and in the person's facts in the given state.
      const f = factOf(st, "education", `BA Economics, ${rowSchool}, Class of 2027`, "F-2"); if (f) facts.push(f);
      claim = pick(r, [`We both went to ${rowSchool}.`, `As a fellow ${rowSchool} student, I'd love your advice.`, `I'm also a ${rowSchool} alum.`]); pass = st === "confirmed";
    } else if (kind === 4) { const f = factOf(st, "gpa", "GPA 3.87", "F-2"); if (f) facts.push(f); claim = "My GPA is 3.87."; pass = st === "confirmed"; }
    else { claim = pick(r, [`Congrats on your promotion to partner.`, `I loved your recent talk on fraud models.`, `You lead the payments team there.`]); pass = false; }
    const text = `Subject: A quick question\n\nHi ${first},\n\n${claim} Would you have 15 minutes for a short call?`;
    const once = r() < 0.5; // the claim on the first try only: the retry is honest
    const honest = `Subject: A quick question\n\nHi ${first},\n\nWould you have 15 minutes for a short call?`;
    let calls = 0;
    const model = async (_p: any) => ({ content: [{ type: "text", text: once && calls++ > 0 ? honest : text }], stop_reason: "end_turn" });
    const d = await draftFor({ model, facts, r: recipient });
    if (!once) {
      rep.grade("facts", pass && !d.ok ? "an honest claim from what is on record was refused" : null, { claim, st, kind, d: d.ok ? null : d.detail });
      rep.grade("facts", !pass && d.ok ? "a claim not on record (or only in an unconfirmed fact) was let through" : null, { claim, st, kind });
    } else {
      rep.grade("facts", !d.ok ? "a writer whose retry is honest ended with no draft" : null, { claim, st, kind, d: d.ok ? null : d.detail });
      if (d.ok) rep.grade("facts", !pass && d.body.includes(claim) ? "the stored draft carries a claim not on record" : null, { claim, body: d.body });
    }
  }
}

// ================================================================================================ dupes
async function dupesBattery(rep: Report, n: number) {
  const r = rng(SEED + 4);
  for (let i = 0; i < n; i++) {
    const firm = pick(r, FIRMS), dom = `${firm.toLowerCase()}.com`;
    const k = int(r, 1, 9);
    const contacts: { name: string; firm: string; title: string; email: string | null }[] = [];
    const used = new Set<string>();
    for (let c = 0; c < k; c++) {
      let name = pick(r, NAMES);
      while (used.has(name)) name = `${name.split(" ")[0]} ${String.fromCharCode(65 + c)}${name.split(" ")[1]}`;
      used.add(name);
      const local = `${name.split(" ")[0].toLowerCase()}${c}`;
      contacts.push({ name, firm, title: pick(r, ["Engineer", "Analyst", "Product Manager"]), email: r() < 0.1 ? null : `${local}@${dom}` });
    }
    // One address again under another name (a nickname, another list), in its own case or another.
    const dupCount = int(r, 0, 2);
    for (let x = 0; x < dupCount && contacts.some((c) => c.email); x++) {
      const src = pick(r, contacts.filter((c) => c.email));
      let alias = `${pick(r, ["Jon", "Bobby", "Liz", "Kate", "Max"])} ${src.name.split(" ").at(-1)}`;
      while (used.has(alias)) alias = `${alias}x`;
      used.add(alias);
      contacts.push({ name: alias, firm, title: "Engineer", email: pick(r, [src.email!, src.email!.toUpperCase(), ` ${src.email!}`.trim()]) });
    }
    const emails = contacts.map((c) => c.email).filter(Boolean) as string[];
    const dncOther = emails.filter(() => r() < 0.08), bounced = emails.filter((e) => !dncOther.includes(e) && r() < 0.06);
    const w = await world({ contacts, dncOther, bounced, user: `d${i}` });
    const res = await w.say(`draft intros to my contacts at ${firm}`);
    const ds = w.drafts();
    const addrs = ds.map((d) => d.recipient.email.trim().toLowerCase());
    const blockedSet = new Set([...dncOther, ...bounced].map((e) => e.toLowerCase()));
    const distinct = new Set(emails.map((e) => e.toLowerCase()).filter((e) => !blockedSet.has(e)));
    rep.grade("dupes", new Set(addrs).size !== addrs.length ? "two drafts to one address in one batch" : null, { addrs, said: res?.reply.slice(0, 200) });
    rep.grade("dupes", JSON.stringify(ds.map((d) => d.n)) !== JSON.stringify(ds.map((_, k) => k + 1)) ? "the batch is not numbered 1..N once each" : null, { ns: ds.map((d) => d.n) });
    rep.grade("dupes", addrs.some((a) => blockedSet.has(a)) ? "a draft to an opted-out or bounced address" : null, { addrs, blocked: [...blockedSet] });
    rep.grade("dupes", addrs.length !== distinct.size ? "not one draft per usable address" : null, { addrs, distinct: [...distinct], said: res?.reply.slice(0, 300) });
    const m = /Drafted (\d+)\/(\d+)/.exec(res?.reply ?? "");
    if (ds.length) {
      rep.grade("dupes", !m || Number(m[1]) !== ds.length || Number(m[2]) !== contacts.length ? "the count said is not what was drafted out of whom" : null, { said: res?.reply.slice(0, 200), drafted: ds.length, contacts: contacts.length });
      const notDrafted = contacts.filter((c) => !ds.some((d) => d.recipient.name === c.name));
      for (const c of notDrafted) rep.grade("dupes", !(res?.reply ?? "").includes(`${c.name} (`) ? "someone not drafted is not named with a reason" : null, { name: c.name, said: res?.reply.slice(0, 400) });
      // "send a-b" approves exactly those numbers.
      w.store.setIntent("t-r3", OUTREACH_INTENT);
      const a = int(r, 1, ds.length), b = int(r, a, ds.length);
      const ans = await outreachTurn({ message: a === b ? `send ${a}` : `send ${a}-${b}`, userId: w.user, threadId: "t-r3", now: T0, store: w.store, gmailConnected: async () => true });
      const got = (ans?.approved ?? []).map((x) => x.n);
      rep.grade("dupes", JSON.stringify(got) !== JSON.stringify(Array.from({ length: b - a + 1 }, (_, x) => a + x)) ? "a numbered approval approved other numbers" : null, { a, b, got });
    } else rep.grade("dupes", distinct.size > 0 ? "nothing drafted though someone could be written to" : null, { said: res?.reply.slice(0, 300) });
  }
}

// ================================================================================================ guessed
async function guessedBattery(rep: Report, n: number) {
  const r = rng(SEED + 5);
  for (let i = 0; i < n; i++) {
    const firm = pick(r, FIRMS), dom = `${firm.toLowerCase()}.com`;
    const name = pick(r, NAMES), local = name.toLowerCase().replace(" ", ".");
    const status = pick(r, ["published", "inferred", "inferred", null] as const);
    const sendable = r() < 0.8;
    const personal = status === "inferred" && r() < 0.2;
    const email = status ? `${local}@${personal ? "gmail.com" : dom}` : null;
    const w = await world({ saved: [{ name, email, company: firm, position: "Engineer", email_status: status, sendable } as any], user: `g${i}` });
    const res = await w.say(`draft intros to my contacts at ${firm}`);
    const ds = w.drafts();
    const usable = !!email && sendable && !personal && (status === "published" || status === "inferred");
    rep.grade("guessed", usable !== (ds.length === 1) ? (usable ? "an address that may be sent to was not drafted" : "drafted to an address that may not be sent to (guessed personal, not sendable, or none)") : null, { status, sendable, personal, said: res?.reply.slice(0, 200) });
    if (ds.length !== 1) continue;
    const d = ds[0];
    rep.grade("guessed", d.recipient.address !== status ? "the draft does not carry how its address was found" : null, { status, address: d.recipient.address });
    const card = res?.reply ?? "";
    rep.grade("guessed", status === "inferred" && !/inferred address: guessed from the company's email format, never published; it may bounce/.test(card) ? "an inferred address is shown as if it were known" : null, { card: card.slice(0, 300) });
    rep.grade("guessed", status === "published" && /inferred address/.test(card) ? "a published address is labeled a guess" : null, {});
    // Approved and handed to the rail: the queue is told it is inferred.
    w.store.setIntent("t-r3", OUTREACH_INTENT);
    const items: any[] = [];
    const rpc = async (name_: string, args: { p: any }) => { if (name_ === "career_send_enqueue") { items.push(...args.p.items); return { data: args.p.items.map((x: any) => ({ source_id: x.source_id, status: "queued", id: "q" })), error: null }; } return { data: null, error: { message: "no" } }; };
    await outreachTurn({ message: "send 1", userId: w.user, threadId: "t-r3", now: T0, store: w.store, gmailConnected: async () => true,
      onApproved: async (x, its) => { await queueApprovedOutreach({ rpc, drafts: (y, ids) => w.store.drafts!(y, ids) }, x, its); } });
    rep.grade("guessed", items.length !== 1 || (items[0].address_type ?? null) !== status ? "the rail is not told how the address was found" : null, { items, status });
  }
}

// ================================================================================================ legacy
async function legacyBattery(rep: Report, n: number) {
  const r = rng(SEED + 6);
  for (let i = 0; i < n; i++) {
    const store = memoryOutreachStore();
    const u = `l${i}`, size = int(r, 1, 6);
    const ds = [];
    const fate: string[] = [];
    for (let k = 0; k < size; k++) {
      const to = `p${k}.${i}@acme.example`;
      const f = pick(r, ["ok", "ok", "ok", "bounced", "dnc", "on_rail", "lapsed"] as const);
      fate.push(f);
      const at = f === "lapsed" ? T0 - 8 * DAY : T0 - HOUR;
      const d = { n: k + 1, recipient: { name: `P ${k}`, firm: "Acme", title: "", school: "", email: to, source: "x" }, subject: `Hello ${k}`, body: "Hi,\n\nWould you have 15 minutes?", footer: FOOT, shared: [],
        status: "approved" as const, hash: "", approved_hash: "" as string | null, approved_at: new Date(at).toISOString(), sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(at).toISOString() };
      d.hash = await payloadHash(messageOf(d)); d.approved_hash = d.hash;
      ds.push(d);
    }
    const saved = await store.saveBatch(u, "t", ds, T0);
    for (const [k, d] of saved.entries()) {
      if (fate[k] === "bounced") store.markBounced(d.recipient.email);
      if (fate[k] === "dnc") await store.addDnc("someone-else", await emailHash(d.recipient.email), "stop", T0);
      if (fate[k] === "on_rail") (store as any).markOnRail?.(d.id);
    }
    const paused = r() < 0.1;
    if (paused) store.setQuiet(u, true);
    const sent: string[] = [];
    await runOutreachSends({ store, now: T0, sender: { send: async (_x, m) => { sent.push(m.to); return { status: "sent", id: `g${sent.length}`, thread_id: `t${sent.length}` }; } } });
    const after = await store.drafts!(u, saved.map((d) => d.id));
    for (const [k, d] of saved.entries()) {
      const a = after.find((x) => x.id === d.id)!;
      const want = !paused && fate[k] === "ok";
      const times = sent.filter((x) => x === d.recipient.email).length;
      rep.grade("legacy", times !== (want ? 1 : 0) ? `the older sender sent ${times} to a draft that is ${paused && fate[k] === "ok" ? "paused" : fate[k]}` : null, { fate: fate[k], paused, status: a.status });
      if (fate[k] === "on_rail") rep.grade("legacy", a.status !== "approved" || a.result ? "the older sender touched a draft the rail has" : null, { status: a.status, result: a.result });
      if (fate[k] === "bounced" && !paused) rep.grade("legacy", a.status !== "skipped" || a.result !== "bad_address" ? "a draft to a bounced address does not say why it was not sent" : null, { status: a.status, result: a.result });
    }
  }
}

// ================================================================================================ the tests
Deno.test("outreach r4: whole lifecycles, both senders, both readers, ~2,500 seeded sessions", async () => {
  const rep = new Report("lifecycle");
  const r = rng(SEED + 1);
  for (let i = 0; i < R4_COUNTS.lifecycle; i++) await lifecycle(r, i, rep);
  rep.done(R4_COUNTS.lifecycle * 3);
});
Deno.test("outreach r4: the older run's reader reads what comes back as the rail does (~2,000 messages)", async () => {
  const rep = new Report("replies");
  await repliesBattery(rep, R4_COUNTS.replies);
  rep.done(R4_COUNTS.replies);
});
Deno.test("outreach r4: drafts state only confirmed facts about the person and the contact's own row (~2,000 drafts)", async () => {
  const rep = new Report("facts");
  await factsBattery(rep, R4_COUNTS.facts);
  rep.done(R4_COUNTS.facts);
});
Deno.test("outreach r4: one draft per address, numbered once, approved by number (~1,500 batches)", async () => {
  const rep = new Report("dupes");
  await dupesBattery(rep, R4_COUNTS.dupes);
  rep.done(R4_COUNTS.dupes);
});
Deno.test("outreach r4: a guessed address is drafted only when it may be sent to, labeled, and the rail is told (~800)", async () => {
  const rep = new Report("guessed");
  await guessedBattery(rep, R4_COUNTS.guessed);
  rep.done(R4_COUNTS.guessed);
});
Deno.test("outreach r4: the older scheduled sender leaves the rail's drafts, bounced, opted-out, lapsed and paused ones (~1,200)", async () => {
  const rep = new Report("legacy");
  await legacyBattery(rep, R4_COUNTS.legacy);
  rep.done(R4_COUNTS.legacy);
});
