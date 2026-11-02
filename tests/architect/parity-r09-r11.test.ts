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

Deno.test("R09: approved but nothing sent yet: the update says nothing has gone to an employer", () => {
  const r = update(rows({ jobs: [job("u", "Umbrella", "queued", 0)] }));
  assert(/nothing has been sent to an employer/i.test(notYet(r) ?? ""), r);
});

Deno.test("R09: emails sent with no reply on record are counted as that, never as replies", () => {
  const sent = { id: "d1", n: 1, status: "sent", sent_at: new Date(T0 - 2 * DAY).toISOString(), created_at: new Date(T0 - 2 * DAY).toISOString(), recipient: { name: "Maya Chen", firm: "Stripe", title: "Recruiter" } };
  const r = update(rows({ outreach: [sent] as any }));
  assert(/1 email you sent has no reply on record/i.test(notYet(r) ?? ""), r);
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
});
