// Parity audit R09 (report real outcomes, not activity) and R11 (correct a wrong premise first, with the numbers or the record).
//   R09: "any update?" gives the current numbers, what they mean, AND what has NOT happened, from the records only
//        (career_overview.ts, read from career_situation.ts). Negative: nothing is called done without a record.
//   R11: the brain's manner (agent/style.ts) says a request resting on a wrong premise gets the actual arithmetic or record in
//        its first line, then help; and the canonical examples that show it are the ones chosen for premise-shaped messages.
// Run: deno test -A --no-check tests/architect/parity-r09-r11.test.ts
import nodeAssert from "node:assert/strict";
import { overviewTurn } from "../../supabase/functions/_shared/career_overview.ts";
import { situationFrom, type SituationRows } from "../../supabase/functions/_shared/career_situation.ts";
import { MANNER, selectStyle, STYLE_EXAMPLES, styleBlock } from "../../supabase/functions/_shared/agent/style.ts";

const assert = (v: unknown, m?: string) => nodeAssert.ok(v, m);
const T0 = Date.parse("2026-11-03T15:00:00Z"), DAY = 86_400_000;
const rows = (o: Partial<SituationRows> = {}): SituationRows => ({ jobs: [], wanted: [], prepared: [], questions: [], outreach: [], mail_drafts: [], interviews: [], alerts: null,
  standing: [], threads: [], connections: [], cloud: null, channel: null, last_search: null, unreadable: [], ...o } as SituationRows);
const job = (id: string, company: string, state: string, daysAgo: number, extra: Record<string, unknown> = {}) =>
  ({ id, job_id: `gh:${id}`, company, url: `https://${id}.example.test`, state, reason: null, confirmation_id: null, created_at: new Date(T0 - daysAgo * DAY).toISOString(), updated_at: new Date(T0 - daysAgo * DAY).toISOString(), title: "Data Analyst", ...extra });
const update = (r: SituationRows) => overviewTurn({ message: "any update?", situation: situationFrom(r, T0), now: T0 })!.reply;
const notYet = (reply: string) => reply.split("\n").find((l) => /^Not yet:/.test(l)) ?? null;

Deno.test("R09: sent but nothing confirmed: the update says what has NOT happened, from the record", () => {
  const r = update(rows({ jobs: [job("g", "Globex", "submitted_unconfirmed", 3), job("i", "Initech", "submitted_unconfirmed", 2)] }));
  assert(/^Status as of now: 0 confirmed by the employer, 2 sent but not confirmed/.test(r), r);
  const line = notYet(r);
  assert(line, `a "Not yet:" line: ${r}`);
  assert(/no employer has confirmed/i.test(line!) && /no interview/i.test(line!), line!);
  assert(r.indexOf(line!) < r.indexOf("Sent, not confirmed"), "what has not happened comes right after the numbers, before the detail");
});

Deno.test("R09: approved but nothing sent yet: the update says Trainee hasn't sent an application (a send record decides)", () => {
  const r = update(rows({ jobs: [job("u", "Umbrella", "queued", 0)] }));
  assert(/Trainee hasn't sent an application/i.test(notYet(r) ?? ""), r);
});

// Review of #399: two kinds of record. Trainee's own (queue, sends, receipts, mail threads) say what Trainee sent; the person's
// tracker says what they told Trainee. A negative is never said where the tracker says otherwise.
const tracked = (company: string, stage: string) => ({ thread_id: "t1", rows: [{ app_id: `a-${company}`, company, role: "Analyst", stage, applied_at: new Date(T0 - 5 * DAY).toISOString() }] });
Deno.test("R09 (review): the tracker is said as what the person told Trainee, and never contradicted", () => {
  const r = update(rows({ jobs: [job("u", "Umbrella", "queued", 0)], threads: [tracked("Wayne", "Interview")] as any }));
  const line = notYet(r) ?? "";
  assert(/Trainee hasn't sent an application/i.test(line), r);
  assert(/from what you told me[^.]*Wayne[^.]*interview/i.test(r), `the tracker, attributed: ${r}`);
  assert(!/nothing has been sent|no interview/i.test(line), `no negative the tracker contradicts: ${line}`);
  const sentOnly = update(rows({ jobs: [job("g", "Globex", "submitted_unconfirmed", 3)], threads: [tracked("Wayne", "Interview")] as any }));
  assert(!/no interview/i.test(notYet(sentOnly) ?? ""), `the tracker has an interview: ${sentOnly}`);
});

Deno.test("R09 (review): no negative is stated from a source that could not be read", () => {
  const r = update(rows({ jobs: [job("g", "Globex", "submitted_unconfirmed", 3)], unreadable: ["interviews", "threads"] }));
  assert(!/no interview/i.test(notYet(r) ?? ""), `interviews unreadable: ${r}`);
  const q = update(rows({ jobs: [job("u", "Umbrella", "queued", 0)], unreadable: ["jobs"] }));
  assert(!/hasn't sent/i.test(notYet(q) ?? ""), `the queue unreadable: ${q}`);
});

Deno.test("R09 (review): 'no reply on record' comes from the mail threads Trainee tracks, never from the draft table alone", () => {
  const sent = { id: "d1", n: 1, status: "sent", sent_at: new Date(T0 - 2 * DAY).toISOString(), created_at: new Date(T0 - 2 * DAY).toISOString(), recipient: { name: "Maya Chen", firm: "Stripe", title: "Recruiter" } };
  const thread = (status: string, replied: boolean) => ({ draft_id: "d1", status, replied_at: replied ? new Date(T0 - DAY).toISOString() : null, sent_at: new Date(T0 - 2 * DAY).toISOString() });
  const none = update(rows({ outreach: [sent] as any }));
  assert(!/reply/i.test(notYet(none) ?? ""), `no thread read, no reply claim: ${none}`);
  const awaiting = update(rows({ outreach: [sent] as any, replies: [thread("awaiting", false), thread("awaiting", false)] } as any));
  assert(/2 emails Trainee sent have no reply on record/i.test(notYet(awaiting) ?? ""), awaiting);
  const replied = update(rows({ outreach: [sent] as any, replies: [thread("interested", true)] } as any));
  assert(!/no reply/i.test(notYet(replied) ?? ""), replied);
  const lost = update(rows({ outreach: [sent] as any, replies: [thread("awaiting", false)], unreadable: ["replies"] } as any));
  assert(!/reply/i.test(notYet(lost) ?? ""), lost);
});

Deno.test("R09 (review): a shown or approved draft is not counted as sent", () => {
  const prep = { id: "p1", job_id: "gh:p1", company: "Pied Piper", url: "https://p.example.test", state: "shown", created_at: new Date(T0 - DAY).toISOString() };
  const draft = (status: string) => ({ id: `d-${status}`, n: 1, status, sent_at: null, created_at: new Date(T0 - DAY).toISOString(), recipient: { name: "Ana", firm: "Acme" } });
  const r = update(rows({ prepared: [prep] as any, outreach: [draft("shown"), draft("approved")] as any }));
  assert(/^Status as of now: 0 confirmed by the employer, 0 sent but not confirmed/.test(r), r);
  assert(/Trainee hasn't sent an application/i.test(notYet(r) ?? ""), r);
  assert(!/emails? Trainee sent/i.test(r), `a draft is not a sent email: ${r}`);
});

Deno.test("R09: what has happened is not listed as not happened (a confirmation and an interview on record)", () => {
  const r = update(rows({ jobs: [job("a", "Acme", "confirmed", 6, { confirmation_id: "ACME-77" })], interviews: [{ id: "i1", company: "Acme", role: "Data Analyst", at: new Date(T0 + 2 * DAY).toISOString() }] as any }));
  const line = notYet(r) ?? "";
  assert(!/confirmed/i.test(line) && !/interview/i.test(line), `nothing false in the not-yet line: ${r}`);
});

Deno.test("R09: an empty account has no not-yet line (nothing is in flight says it)", () => {
  const r = update(rows());
  assert(!notYet(r), r);
});

Deno.test("R11: the manner says a wrong premise is corrected first, with the arithmetic or the record", () => {
  assert(/premise/i.test(MANNER) && /first/i.test(MANNER) && /(arithmetic|numbers)/i.test(MANNER) && /record/i.test(MANNER), MANNER);
  assert(/reassur/i.test(MANNER), "reassurance is named as not a correction");
  // Review of #399: correcting their own confirmed fact is an update the person makes, not a wrong premise to argue with.
  assert(/correct\w* (?:their|your) own[^.]*(?:update|not a wrong premise)/i.test(MANNER), MANNER);
});

Deno.test("R11: premise-shaped messages get the premise examples, whose first line is the number or the record", () => {
  const math = "im gonna apply to 200 jobs today, like 5 min each, done by tonight right";
  const record = "since acme already got my application, when do they usually reply";
  const pick = (m: string) => selectStyle(m).map((e) => e.id);
  const premise = STYLE_EXAMPLES.filter((e) => e.tags.includes("premise"));
  assert(premise.length >= 2, "at least an arithmetic and a record example");
  assert(premise.some((e) => pick(math).includes(e.id)), `arithmetic premise picks one: ${pick(math)}`);
  assert(premise.some((e) => pick(record).includes(e.id)), `record premise picks one: ${pick(record)}`);
  for (const e of premise) {
    const first = e.reply.split(/(?<=[.!?])\s/)[0];
    assert(/\d/.test(first) || /\b(record|on file|not sent|hasn't|haven't|no application)\b/i.test(first), `${e.id}'s first sentence is the correction: ${first}`);
    assert(!/^(great|sure|absolutely|totally|good luck|no worries)/i.test(e.reply), `${e.id} does not open with reassurance`);
  }
  assert(styleBlock(math).includes(MANNER), "the manner rides with every turn");
  // Review of #399: the arithmetic is right (1,000 minutes is 16 h 40 m) and ordinary questions do not get the premise examples.
  const t17 = STYLE_EXAMPLES.find((e) => e.id === "T17")!;
  assert(/16 hours 40 minutes|16 h 40 m/.test(t17.reply) && !/16 and a half/.test(t17.reply), t17.reply);
  for (const plain of ["any data analyst jobs today", "what can you do", "apply to all of them", "did my application go through", "whats happening with my applications", "did they reply yet", "how long does each application take", "remind me tonight", "is 95k good for a junior analyst", "actually i graduated in 2026 not 2025"]) {
    const ids = pick(plain);
    assert(!premise.some((e) => ids.includes(e.id)), `"${plain}" is not a premise: ${ids}`);
  }
});
