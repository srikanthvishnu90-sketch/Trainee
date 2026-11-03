// Networking outreach drafts, approvals, the sending rail and follow-ups at scale (owner rules, 2026-10-30): a deterministic,
// seeded generator of ~10,000 scenarios, each with what must happen. Plain data only; the test
// (tests/architect/scenarios-outreach.test.ts) runs each through the product's own functions with a fixed clock, a fake
// Gmail at the HTTP boundary and the in-memory stores, and grades it.
//
//   approve    a batch of drafts shown in one chat (sometimes with batches drafted in other chats, by other people, before
//              or after it), events between showing and answering (an edit, a change behind the person's back, a take-back,
//              the batch growing old), then one answer: a clear yes, a stated subset, or something that approves nothing
//              (a hedge, a question, "ok" alone). Must: approve exactly the stated drafts of the batch shown IN THAT CHAT,
//              each bound to the hash of the text shown; nothing for a batch shown elsewhere, a changed draft, an old batch
//              or an ambiguous answer; queued exactly as approved, with the card's address label (published / inferred).
//   worker     one claimed email on the sending rail: its attempt (a first try, or a retry after a crash, a lost answer or
//              a lapsed lease), what the person's Sent mail shows, the payload (intact, or changed after approval in the
//              queue or in the draft), the grants, the worker's last check (go / stop / unreachable), Gmail's answer (sent,
//              no id, 429 with Retry-After, 403 quota in Gmail's words with or without a reason code, 401, 5xx, a network
//              break, a spam refusal) and, for a follow-up, what is on its sequence's threads. Must: at most one send; a
//              send only when everything allows it and only of exactly the approved payload (To, Subject, body; no From, Cc
//              or Bcc written); "already sent" only when Sent shows exactly that message to exactly that address; Gmail's
//              quota backs off (never "reconnect"); a follow-up never goes over an answer already on the thread.
//   followup   the replies lane's sequence for one sent email: the person's steps (or none / off), what happens on the
//              thread and when (a reply, an out-of-office with or without a return date, a bounce, a "not interested", the
//              person's own follow-up, an opt-out the contact gave someone else, the person pausing), the daily runs (two
//              workers at once), the person's yes. Must: a follow-up only when its step is due with no answer, at most the
//              number of steps, never twice for one step, never after an answer, past an out-of-office return date, and
//              nothing at all drafted or asked for a person who is paused.
//   reply      what comes back on the threads of a sequence already sent (the first email and its follow-ups): from the
//              contact, from another address of theirs, a mail system, an out-of-office, a delay, the List-Unsubscribe
//              mailto. Must: recorded on exactly the email whose thread it is, with the right kind; nothing for the rest.
//   draft      "email <name> at <firm>" / "reach out to <role>s at <firm>" over contacts whose address is clean, on the
//              person's own opt-out list, opted out with ANOTHER Trainee user, or bounced for anyone. Must: never a draft
//              to an address no one may email; the clean ones drafted to exactly the address on their row.
// Every address is synthetic (.example / .test). No network, no model.
import { rng, type R } from "../scenarios-fixture.ts";

export const NOW = Date.parse("2026-10-30T15:00:00Z");
export const DAY = 86_400_000;
const FIRST = ["Maya", "Jordan", "Priya", "Dana", "Luis", "Wei", "Amara", "Noah", "Elena", "Tariq", "Grace", "Omar", "Sofia", "Ken", "Ines", "Ravi", "Hana", "Leo", "Zara", "Ben"];
const LAST = ["Chen", "Lopez", "Patel", "Okafor", "Kim", "Rossi", "Nguyen", "Smith", "Haddad", "Novak", "Ito", "Silva", "Brown", "Garcia", "Singh", "Muller"];
const FIRMS: [string, string][] = [["Acme", "acme.example"], ["Ramp", "ramp.example"], ["Plaid", "plaid.example"], ["Stripe", "stripe.example"], ["Brex", "brex.example"],
  ["Northwind", "northwind.example"], ["Globex", "globex.example"], ["Initech", "initech.example"], ["Umbrella", "umbrella.example"], ["Hooli", "hooli.example"]];
const TITLES = ["Software Engineer", "Recruiter", "Data Analyst", "Product Manager", "Engineering Manager", "Talent Partner", "Analyst", "Designer"];
const pickN = <T>(r: R, xs: readonly T[], n: number) => { const pool = [...xs], out: T[] = []; while (out.length < n && pool.length) out.push(pool.splice(Math.floor(r.next() * pool.length), 1)[0]); return out; };
const person = (r: R, firm?: [string, string]) => {
  const [f, d] = firm ?? r.pick(FIRMS), first = r.pick(FIRST), last = r.pick(LAST);
  return { name: `${first} ${last}`, first, firm: f, domain: d, title: r.pick(TITLES), email: `${first}.${last}`.toLowerCase() + `@${d}` };
};

// ------------------------------------------------------------------------------------------------ approve
// What the answer says, and what it must approve of the batch shown (numbers 1..size): "all", a list, or nothing.
export type Wants = { all: true; except: number[] } | { all: false; ns: number[] } | null;
export interface ApproveScenario {
  id: number; family: "approve"; category: string;
  size: number; inferred: number[]; // drafts whose address is inferred (labelled on the card)
  // Other batches: drafted in another chat of the same person (before or after this one was shown), or another person's.
  others: { where: "my_other_chat" | "other_person"; when: "before" | "after"; size: number }[];
  showAgainHere: boolean; // "show drafts" in this chat after the others (the newest batch is shown here)
  events: ({ kind: "edit"; n: number } | { kind: "tamper"; n: number } | { kind: "cancel"; n: number })[];
  ageHours: number; // from the batch being drafted to the answer
  answer: string; wants: Wants;
}
const YES_ALL = ["yes", "Yes!", "yep", "yeah", "send all", "send them all", "approve all", "yes send them all", "go ahead", "lgtm", "looks good", "send", "yes to all", "👍", "ok, send them all", "sure, go ahead", "yes please", "y"];
const NOTHING = ["yes?", "send them all?", "maybe", "ok", "okay", "sure", "not now", "hmm", "yes but not Acme", "yes but wait", "let me think", "probably", "no", "sounds good?", "can you send them later", "don't send yet", "what do they say?", "nah", "send them tomorrow", "yes, but change the first one", "approve all?", "idk", "yes maybe"];
export function approveScenarios(r: R, count: number, start = 1): ApproveScenario[] {
  const out: ApproveScenario[] = [];
  for (let id = start; id < start + count; id++) {
    const size = r.int(1, 12);
    const inferred = Array.from({ length: size }, (_, i) => i + 1).filter(() => r.next() < 0.25);
    const others: ApproveScenario["others"] = [];
    const x = r.next();
    if (x < 0.25) others.push({ where: "my_other_chat", when: r.next() < 0.5 ? "before" : "after", size: r.int(1, 6) });
    else if (x < 0.4) others.push({ where: "other_person", when: r.pick(["before", "after"] as const), size: r.int(1, 6) });
    else if (x < 0.5) others.push({ where: "my_other_chat", when: "after", size: r.int(1, 4) }, { where: "other_person", when: "after", size: r.int(1, 4) });
    const showAgainHere = others.some((o) => o.where === "my_other_chat" && o.when === "after") && r.next() < 0.35;
    const events: ApproveScenario["events"] = [];
    const e = r.next();
    if (e < 0.12) events.push({ kind: "edit", n: r.int(1, size) });
    else if (e < 0.22) events.push({ kind: "tamper", n: r.int(1, size) });
    else if (e < 0.3) events.push({ kind: "cancel", n: r.int(1, size) });
    const ageHours = r.next() < 0.1 ? r.pick([73, 80, 100, 200]) : r.pick([0, 1, 5, 24, 48, 71]);
    let answer: string, wants: Wants, category: string;
    const k = r.next();
    if (k < 0.42) { answer = r.pick(YES_ALL); wants = { all: true, except: [] }; category = "yes"; }
    else if (k < 0.55 && size >= 2) { const ex = pickN(r, Array.from({ length: size }, (_, i) => i + 1), r.int(1, Math.min(3, size - 1))).sort((a, b) => a - b); answer = `${r.pick(["yes except", "send all except", "yes, except", "send all but"])} ${ex.join(", ")}`; wants = { all: true, except: ex }; category = "yes_except"; }
    else if (k < 0.7) { const ns = pickN(r, Array.from({ length: size }, (_, i) => i + 1), r.int(1, size)).sort((a, b) => a - b); answer = `${r.pick(["send", "only", "approve", "just send"])} ${ns.join(",")}`; wants = { all: false, ns }; category = "subset"; }
    else if (k < 0.75 && size === 1) { answer = r.pick(["send it", "looks good, send it", "approve it"]); wants = { all: false, ns: [1] }; category = "send_it"; }
    else { answer = r.pick(NOTHING); wants = null; category = "nothing"; }
    out.push({ id, family: "approve", category: `approve/${category}/${others.length ? others.map((o) => `${o.where}-${o.when}`).join("+") : "alone"}${events.length ? `/${events[0].kind}` : ""}`, size, inferred, others, showAgainHere, events, ageHours, answer, wants });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ worker
export type GmailAns =
  | "sent" | "sent_no_id" | "429_secs" | "429_date" | "429_plain" | "403_rate_reason" | "403_daily_words" | "403_concurrent_words" | "403_quota_words"
  | "401" | "403_scope" | "500" | "503" | "throw" | "400_spam" | "400_invalid";
export type SentState = "none" | "exact" | "exact_named" | "lookalike" | "other_addr" | "other_subject" | "encoded_exact" | "unreadable";
export type SeqState = "none" | "reply" | "stop" | "bounce" | "ooo" | "delay" | "other_addr_reply" | "unsub_mailto" | "unreadable";
export interface WorkerScenario {
  id: number; family: "worker"; category: string;
  kind: "outreach" | "general"; to: string; subject: string; body: string;
  attempts: number; // the claim's count (1: a first try)
  sent: SentState; // what Sent shows (read only on a retry)
  tamper: "none" | "queue" | "draft";
  sendToken: boolean; readToken: boolean;
  go: "go" | "stop" | "error";
  gmail: GmailAns;
  followUp: boolean; seq: SeqState;
}
const SUBJECTS = ["Quick question about your team", "Coffee chat?", "Fellow alum, a question", "Re: Quick question", "Question about the Data Analyst role", "A question — 15 minutes?", "Intro from your former colleague"];
export function workerScenarios(r: R, count: number, start = 1): WorkerScenario[] {
  const out: WorkerScenario[] = [];
  const answers: GmailAns[] = ["sent", "sent", "sent", "sent", "sent_no_id", "429_secs", "429_date", "429_plain", "403_rate_reason", "403_daily_words", "403_concurrent_words", "403_quota_words", "401", "403_scope", "500", "503", "throw", "400_spam", "400_invalid"];
  for (let id = start; id < start + count; id++) {
    const p = person(r);
    const followUp = r.next() < 0.3;
    const attempts = r.next() < 0.6 ? 1 : r.int(2, 4);
    const sent: SentState = attempts > 1 ? r.pick(["none", "none", "exact", "exact_named", "lookalike", "other_addr", "other_subject", "encoded_exact", "unreadable"] as const) : "none";
    const kind = followUp ? "general" : r.next() < 0.8 ? "outreach" : "general";
    const subject = followUp ? `Re: ${r.pick(SUBJECTS)}` : r.pick(SUBJECTS);
    const s: WorkerScenario = {
      id, family: "worker", category: "", kind, to: p.email, subject,
      body: `Hi ${p.first},\n\nWould you have 15 minutes this week to talk about ${p.firm}?\n\nSam Lee\n\nIf you'd rather not hear from me, reply stop and I won't write again.`,
      attempts, sent, tamper: r.next() < 0.1 ? r.pick(["queue", "draft"] as const) : "none",
      sendToken: r.next() > 0.05, readToken: r.next() > 0.05, go: r.next() < 0.88 ? "go" : r.pick(["stop", "error"] as const),
      gmail: r.pick(answers), followUp, seq: followUp ? r.pick(["none", "none", "reply", "stop", "bounce", "ooo", "delay", "other_addr_reply", "unsub_mailto", "unreadable"] as const) : "none",
    };
    if (s.kind === "general" && s.tamper === "draft") s.tamper = "queue";
    s.category = `worker/${s.followUp ? `followup-${s.seq}` : s.kind}/${s.attempts > 1 ? `retry-${s.sent}` : "first"}/${s.gmail}${s.tamper !== "none" ? `/tamper-${s.tamper}` : ""}${s.go !== "go" ? `/go-${s.go}` : ""}`;
    out.push(s);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ followup
export type ThreadEvent =
  | { kind: "reply"; day: number } | { kind: "not_interested"; day: number } | { kind: "bounce"; day: number }
  | { kind: "ooo"; day: number; back: number | null } | { kind: "own_followup"; day: number } | { kind: "dnc_elsewhere"; day: number }
  | { kind: "pause"; day: number };
export interface FollowupScenario {
  id: number; family: "followup"; category: string;
  steps: number[] | null | "off"; // waits between touches, as stored (career_outreach_followup_prefs.steps)
  events: ThreadEvent[];
  approveAfterHours: number | null; // the person's yes to a drafted batch, this long after it is drafted (null: never)
  twoWorkers: boolean;
  runEveryHours: number;
}
const STEP_SETS: number[][] = [[3], [3, 4, 7], [2, 3, 4, 11], [5], [7, 7], [1, 1, 1], [14], [3, 4]];
export function followupScenarios(r: R, count: number, start = 1): FollowupScenario[] {
  const out: FollowupScenario[] = [];
  for (let id = start; id < start + count; id++) {
    const steps = r.next() < 0.08 ? (r.next() < 0.5 ? null : "off" as const) : r.pick(STEP_SETS);
    const events: ThreadEvent[] = [];
    const e = r.next();
    const day = r.int(1, 20);
    if (e < 0.15) events.push({ kind: "reply", day });
    else if (e < 0.25) events.push({ kind: "not_interested", day });
    else if (e < 0.32) events.push({ kind: "bounce", day });
    else if (e < 0.47) events.push({ kind: "ooo", day, back: r.next() < 0.7 ? day + r.int(1, 12) : null });
    else if (e < 0.53) events.push({ kind: "own_followup", day });
    else if (e < 0.6) events.push({ kind: "dnc_elsewhere", day });
    else if (e < 0.7) events.push({ kind: "pause", day: r.int(0, 10) });
    if (r.next() < 0.1) events.push({ kind: "reply", day: r.int(day, 25) });
    events.sort((a, b) => a.day - b.day);
    const approveAfterHours = r.next() < 0.85 ? r.pick([0, 1, 6, 30]) : null;
    out.push({ id, family: "followup", category: `followup/${Array.isArray(steps) ? `${steps.length}-steps` : String(steps)}/${events.map((x) => x.kind).join("+") || "silence"}${approveAfterHours === null ? "/never-approved" : ""}`,
      steps, events, approveAfterHours, twoWorkers: r.next() < 0.5, runEveryHours: r.pick([6, 12, 24]) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ reply
export type Incoming = "reply" | "stop" | "ooo" | "bounce" | "delay" | "other_addr_reply" | "other_addr_stop" | "unsub_mailto" | "receipt";
export interface ReplyScenario {
  id: number; family: "reply"; category: string;
  steps: number; // how many follow-ups of the sequence were already sent (0..3)
  on: number; // which email's thread the message lands on (0: the first)
  what: Incoming;
  neighbours: number; // other people's sequences checked in the same run, with nothing on them
}
export function replyScenarios(r: R, count: number, start = 1): ReplyScenario[] {
  const out: ReplyScenario[] = [];
  for (let id = start; id < start + count; id++) {
    const steps = r.int(0, 3), on = r.int(0, steps);
    const what = r.pick(["reply", "reply", "stop", "ooo", "bounce", "delay", "other_addr_reply", "other_addr_stop", "unsub_mailto", "receipt"] as const);
    out.push({ id, family: "reply", category: `reply/${what}/on-${on === 0 ? "first" : "followup"}`, steps, on, what, neighbours: r.int(0, 3) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ draft
export type Block = "clean" | "own_dnc" | "other_dnc" | "bounced";
export interface DraftScenario {
  id: number; family: "draft"; category: string;
  firm: [string, string]; people: { name: string; first: string; title: string; email: string; block: Block }[];
  ask: "name" | "group"; target: number; // the person named (by name) or none (group: everyone at the firm)
}
export function draftScenarios(r: R, count: number, start = 1): DraftScenario[] {
  const out: DraftScenario[] = [];
  for (let id = start; id < start + count; id++) {
    const firm = r.pick(FIRMS);
    const n = r.int(1, 4);
    const people: DraftScenario["people"] = [];
    const seen = new Set<string>();
    while (people.length < n) {
      const p = person(r, firm);
      if (seen.has(p.first) || seen.has(p.email)) continue;
      seen.add(p.first); seen.add(p.email);
      const b = r.next();
      people.push({ name: p.name, first: p.first, title: p.title, email: p.email, block: b < 0.4 ? "clean" : b < 0.55 ? "own_dnc" : b < 0.8 ? "other_dnc" : "bounced" });
    }
    const ask = r.next() < 0.6 ? "name" as const : "group" as const;
    const target = r.int(0, n - 1);
    out.push({ id, family: "draft", category: `draft/${ask}/${ask === "name" ? people[target].block : people.map((p) => p.block).sort().join("+")}`, firm, people, ask, target });
  }
  return out;
}

export type Scenario = ApproveScenario | WorkerScenario | FollowupScenario | ReplyScenario | DraftScenario;
export const COUNTS = { approve: 2500, worker: 3200, followup: 2000, reply: 1500, draft: 1000 };
export function generate(o: { seed?: number } = {}) {
  const seed = o.seed ?? 20261030;
  return {
    approve: approveScenarios(rng(seed + 1), COUNTS.approve, 1),
    worker: workerScenarios(rng(seed + 2), COUNTS.worker, 100_001),
    followup: followupScenarios(rng(seed + 3), COUNTS.followup, 200_001),
    reply: replyScenarios(rng(seed + 4), COUNTS.reply, 300_001),
    draft: draftScenarios(rng(seed + 5), COUNTS.draft, 400_001),
  };
}
// A seeded sample that covers every category's first two parts first.
export function sample<T extends { id: number; category: string }>(all: T[], k: number, seed = 7): T[] {
  const r = rng(seed);
  const byCat = new Map<string, T[]>();
  for (const s of all) { const c = s.category.split("/").slice(0, 2).join("/"); byCat.set(c, [...(byCat.get(c) ?? []), s]); }
  const got = new Set<T>();
  for (const xs of byCat.values()) { if (got.size >= k) break; got.add(r.pick(xs)); }
  while (got.size < k) got.add(r.pick(all));
  return [...got].sort((a, b) => a.id - b.id);
}
