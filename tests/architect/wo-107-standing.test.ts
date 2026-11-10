// WO-107 (F3): one read model on the live path. "where are my applications", "did my application to X go through",
// "where do I stand with X", "who emailed me", "any news from X" and "what follow-ups are due" are answered by code,
// before the router, from one model built from the four records that did not see each other: career_apply_jobs (what
// Trainee sent), career_mail_events (what the employer's mail said), every thread's tracker (what the person told
// Trainee) and career_mail_drafts (follow-ups drafted, never sent). Each line says which record it came from; a record
// that cannot be read is named, never guessed; nothing is sent or drafted by any of these turns.
import assertNode from "node:assert/strict";
import { type AppRow, statusReply } from "../../supabase/functions/_shared/career_apply_status.ts";
import { FOLLOWUPS_INTENT, INBOX_INTENT, STANDING_INTENT, standingAsk, standingFrom, type StandingRows, standingTurn } from "../../supabase/functions/_shared/career_standing.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const DAY = 86_400_000, NOW = Date.UTC(2026, 9, 25, 12);
const iso = (t: number) => new Date(t).toISOString();
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

const job = (id: string, company: string, state: string, daysAgo: number, extra: Partial<AppRow> = {}): AppRow =>
  ({ id, company, state, reason: null, confirmation_id: null, email_confirmed_at: null, created_at: iso(NOW - daysAgo * DAY), updated_at: iso(NOW - daysAgo * DAY), title: null, ...extra });
const JOBS: AppRow[] = [
  job("j-acme", "Acme", "confirmed", 16, { confirmation_id: "ACME-1", title: "Data Analyst", email_confirmed_at: "2026-10-24T15:00:00Z" }),
  job("j-globex", "Globex", "submitted_unconfirmed", 9, { confirmation_id: "CONF-4242" }),
  job("j-initech", "Initech", "unknown_outcome", 20),
  job("j-umbrella", "Umbrella", "queued", 1),
  job("j-hooli", "Hooli", "not_submitted", 2, { reason: "the employer's page changed after you approved it" }),
];
const mailEvent = (ref: string, company: string, kind: any, stage: string | null, daysAgo: number, role?: string) =>
  ({ hash: "h".repeat(64), ref, kind, company, role, stage, flagged: false, evidence: `${kind} email`, at: iso(NOW - daysAgo * DAY), new_app: false });
const MAIL = [
  mailEvent("job:j-globex", "Globex", "interview", "Interview rounds", 5),
  mailEvent("job:j-initech", "Initech", "rejection", "Rejected", 3),
  mailEvent("mail:stark", "Stark Industries", "recruiter_reply", null, 1, "Analyst"),
];
const TRACKER = [
  { app_id: "app-vandelay-1", company: "Vandelay Industries", role: "Data Analyst", stage: "Submitted", applied_at: iso(NOW - 10 * DAY), events: [{ type: "applied", at: iso(NOW - 10 * DAY) }] },
  { app_id: "app-acme-2", company: "Acme", role: "Data Analyst", stage: "Submitted", applied_at: iso(NOW - 16 * DAY), events: [{ type: "applied", at: iso(NOW - 16 * DAY) }] },
  // Initech: the queue has it (unknown outcome) and the person told Trainee it was rejected; the merge reads them as one
  // application, and what they reported counts on it.
  { app_id: "app-initech-3", company: "Initech", role: null, stage: "Rejected", applied_at: iso(NOW - 20 * DAY), events: [{ type: "rejection", at: iso(NOW - 6 * DAY) }] },
];
const DRAFTS = [{ draft_key: "followup:job:j-initech", application_ref: "job:j-initech", kind: "followup" as const, company: "Initech", role: null, text: "Hello, I applied for a role at Initech on Oct 5 and wanted to follow up.", basis: "applied Oct 5; no reply in 15 days", state: "drafted", created_at: iso(NOW - 2 * DAY) }];
const rows = (o: Partial<StandingRows> = {}): StandingRows => ({ jobs: JOBS, mail: MAIL, tracker: TRACKER, drafts: DRAFTS, read_through: iso(NOW - 3600_000), unreadable: [], ...o });
const read = (r: StandingRows = rows()) => async () => r;
const turn = (message: string, r: StandingRows = rows()) => standingTurn({ message, userId: "U1", now: NOW, read: read(r) });

Deno.test("WO-107/1 the asks: status, inbox and due follow-ups; anything else is not claimed and never read for", async () => {
  eq(standingAsk("where are my applications?"), { kind: "status", company: null });
  eq(standingAsk("did my application to Acme go through?"), { kind: "status", company: "Acme" });
  eq(standingAsk("where do I stand with Globex?"), { kind: "status", company: "Globex" });
  eq(standingAsk("where do I stand"), { kind: "status", company: null });
  eq(standingAsk("who emailed me?"), { kind: "inbox", company: null });
  eq(standingAsk("Who has emailed me"), { kind: "inbox", company: null });
  eq(standingAsk("did anyone get back to me?"), { kind: "inbox", company: null });
  eq(standingAsk("have I heard back from anyone"), { kind: "inbox", company: null });
  eq(standingAsk("any news from Globex?"), { kind: "inbox", company: "Globex" });
  eq(standingAsk("Any news from Stark Industries"), { kind: "inbox", company: "Stark Industries" });
  eq(standingAsk("did Globex get back to me?"), { kind: "inbox", company: "Globex" });
  eq(standingAsk("have I heard back from Initech?"), { kind: "inbox", company: "Initech" });
  eq(standingAsk("has Acme replied"), { kind: "inbox", company: "Acme" });
  eq(standingAsk("what follow-ups are due?"), { kind: "followups" });
  eq(standingAsk("any follow ups due"), { kind: "followups" });
  eq(standingAsk("who should I follow up with?"), { kind: "followups" });
  eq(standingAsk("which applications need a follow-up?"), { kind: "followups" });
  eq(standingAsk("do I owe any follow-ups"), { kind: "followups" });
  // Not these turns: a search, an apply ask, a follow-up to write, a tracker report, a new-jobs ask.
  for (const m of ["find me data analyst roles in Chicago", "apply to Acme", "follow up with Acme", "draft a follow-up to Globex", "I applied to Acme yesterday", "any new jobs?", "any updates?", "yes", "who is the recruiter at Acme"]) {
    eq(standingAsk(m), null, m);
  }
  let reads = 0;
  eq(await standingTurn({ message: "find me data analyst roles in Chicago", userId: "U1", now: NOW, read: async () => { reads++; return rows(); } }), null);
  eq(reads, 0, "never read for another turn");
});

Deno.test("WO-107/2 status: the queue's own wording stands, byte for byte, and the other records follow it, each named", async () => {
  // Architect amendment, D-024 status truth (coordinator ruling 2026-11-10): byte for byte over the rows with their answers joined.
  const JOINED = standingFrom(rows(), NOW).jobs;
  const base = statusReply("where are my applications?", JOINED, NOW)!;
  const all = (await turn("where are my applications?"))!;
  eq(all.intent, STANDING_INTENT);
  assert(all.reply.startsWith(base.reply), `the queue's lines first, unchanged:\n${all.reply}`);
  assert(/Vandelay Industries \(Data Analyst\): you told Trainee you applied on Oct 15; stage Submitted/.test(all.reply), `the tracker's employer, named as theirs: ${all.reply}`);
  assert(/Globex: interview invitation .*Oct 20/.test(all.reply) && /Initech: rejection .*Oct 22/.test(all.reply), `the employer's mail, named: ${all.reply}`);
  assert(!/Acme.*you told Trainee you applied/.test(all.reply), "an employer the queue has is not repeated from the tracker");
  const one = (await turn("did my application to Globex go through?"))!;
  const oneBase = statusReply("did my application to Globex go through?", JOINED, NOW)!;
  assert(one.reply.startsWith(oneBase.reply), one.reply);
  assert(/Globex's email: interview invitation on Oct 20 \(stage: Interview rounds\)/.test(one.reply), one.reply);
  assert(!/Initech|Vandelay/.test(one.reply), "one employer's answer names no other");
  // An employer only the tracker and the mail know: the queue's "no application on record" stands, and the rest is said.
  const acme = (await turn("where do I stand with Acme?"))!;
  assert(/Acme confirmed it/.test(acme.reply) && /You told Trainee: applied on Oct 9; stage Submitted \(Data Analyst\)/.test(acme.reply), acme.reply);
  assert(/No email from Acme in the mail Trainee has read \(read through Oct 25\)/.test(acme.reply), acme.reply);
  const vandelay = (await turn("did my application to Vandelay Industries go through?"))!;
  assert(/no application to Vandelay Industries on record/.test(vandelay.reply) && /Nothing was sent to Vandelay Industries through Trainee/.test(vandelay.reply), vandelay.reply);
  assert(/You told Trainee: applied on Oct 15; stage Submitted/.test(vandelay.reply), vandelay.reply);
  assert(/No email from Vandelay Industries in the mail Trainee has read/.test(vandelay.reply), vandelay.reply);
  const stark = (await turn("where do I stand with Stark Industries?"))!;
  assert(/no application to Stark Industries on record/.test(stark.reply) && /Stark Industries's email: recruiter reply on Oct 24/.test(stark.reply), stark.reply);
});

Deno.test("WO-107/3 status with a record missing: the queue's unreadable wording stands; a missing tracker or mail is named, never guessed", async () => {
  const noJobs = (await turn("did my application to Acme go through?", rows({ jobs: null, unreadable: ["applications"] })))!;
  assert(/couldn't read your applications/.test(noJobs.reply) && !/confirmed|no application|not sent/i.test(noJobs.reply), noJobs.reply);
  const noMail = (await turn("where are my applications?", rows({ mail: null, unreadable: ["mail"] })))!;
  assert(/Your mail events could not be read just now/.test(noMail.reply) && !/interview|rejection/.test(noMail.reply), noMail.reply);
  const noTracker = (await turn("where are my applications?", rows({ tracker: null, unreadable: ["tracker"] })))!;
  assert(/Your tracker could not be read just now/.test(noTracker.reply) && !/Vandelay/.test(noTracker.reply), noTracker.reply);
});

Deno.test("WO-107/4 inbox: who emailed, newest first, from the mail events only; nothing on record is said with how far the mail was read", async () => {
  const who = (await turn("who emailed me?"))!;
  eq(who.intent, INBOX_INTENT);
  const lines = who.reply.split("\n").filter((l) => l.startsWith("- "));
  eq(lines.map((l) => l.slice(2, l.indexOf(":"))), ["Stark Industries (Analyst)", "Initech", "Globex"], who.reply);
  assert(/Stark Industries \(Analyst\): recruiter reply on Oct 24/.test(who.reply) && /Initech: rejection on Oct 22 \(stage: Rejected\)/.test(who.reply) && /Globex: interview invitation on Oct 20/.test(who.reply), who.reply);
  assert(!/Vandelay|Acme/.test(who.reply), "the tracker and the queue are not the inbox");
  const globex = (await turn("any news from Globex?"))!;
  assert(/Globex: interview invitation on Oct 20 \(stage: Interview rounds\)/.test(globex.reply) && !/Initech|Stark/.test(globex.reply), globex.reply);
  const hooli = (await turn("any news from Hooli?"))!;
  assert(/No email from Hooli in the mail Trainee has read \(read through Oct 25\)/.test(hooli.reply), hooli.reply);
  const never = (await turn("who emailed me?", rows({ mail: [], read_through: null })))!;
  assert(/No employer email about your applications is on record/.test(never.reply) && /has not read your mail yet/.test(never.reply), never.reply);
  const down = (await turn("who emailed me?", rows({ mail: null, unreadable: ["mail"] })))!;
  assert(/couldn't read your mail events just now/.test(down.reply) && !/Globex|Initech|Stark|No employer email/.test(down.reply), down.reply);
});

Deno.test("WO-107/5 follow-ups: drafted ones from the table, due ones from the same quiet-days rule as the mail run; nothing is sent, and no reply is claimed unread", async () => {
  const due = (await turn("what follow-ups are due?"))!;
  eq(due.intent, FOLLOWUPS_INTENT);
  assert(/Initech: follow-up drafted Oct 23 \(applied Oct 5; no reply in 15 days\); not sent/.test(due.reply), due.reply);
  assert(/Acme \(Data Analyst\): follow-up due \(applied Oct 9; no reply in 16 days\)/.test(due.reply), `Acme: 16 quiet days, no reply in the mail or the tracker:\n${due.reply}`);
  assert(!/Globex/.test(due.reply), "an employer that replied (the interview email) owes no follow-up: " + due.reply);
  // Initech's rejection was the person's own report (the tracker), folded onto the queue's row: a reply, so nothing is due
  // for it beyond the draft already made.
  const s0 = standingFrom(rows({ drafts: [] }), NOW);
  eq(s0.due.map((d) => d.ref), ["job:j-acme"], "Initech owes nothing: they reported its rejection");
  assert(!/Umbrella|Hooli/.test(due.reply), "an application that never went owes none: " + due.reply);
  assert(/Hello, I applied for a role at Initech/.test(due.reply), "the drafted text is shown so it is ready to send: " + due.reply);
  assert(/Nothing is sent by Trainee/.test(due.reply) && !/\bsent\b(?! by Trainee)/.test(due.reply.replace(/not sent/g, "")), due.reply);
  const none = (await turn("what follow-ups are due?", rows({ jobs: [job("j-new", "Newco", "confirmed", 3)], mail: [], tracker: [], drafts: [] })))!;
  assert(/No follow-up is due right now/.test(none.reply) && /14 quiet days/.test(none.reply), none.reply);
  const down = (await turn("what follow-ups are due?", rows({ mail: null, unreadable: ["mail"] })))!;
  assert(/couldn't read your mail events just now/.test(down.reply) && /can't tell which applications are still unanswered/.test(down.reply) && !/Acme.*due/.test(down.reply), down.reply);
  // The model itself: due follow-ups are the mail run's rule over the merged applications, minus what is already drafted.
  const s = standingFrom(rows(), NOW);
  eq(s.due.map((d) => d.ref), ["job:j-acme"]);
  eq(s.drafts.map((d) => d.draft_key), ["followup:job:j-initech"]);
});

Deno.test("WO-107/6 agent-chat answers these asks by code, before the queue-only status turn, the router and the brain", async () => {
  const src = await Deno.readTextFile(`${ROOT}/supabase/functions/agent-chat/handler-career.ts`);
  const at = src.indexOf("standingTurn(");
  assert(at > 0, "the handler calls it");
  assert(at < src.indexOf("applicationsTurn("), "before the queue-only status turn, which stays as its fallback");
  assert(at < src.indexOf("AGENT_BRAIN_RELEASED && chooseBrain"), "before the brain and the router");
  assert(/read: supabaseStanding\(admin\)/.test(src), "reading the four records through the one reader");
});
