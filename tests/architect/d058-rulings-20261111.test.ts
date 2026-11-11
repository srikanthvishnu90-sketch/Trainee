// D-058 (architect, 2026-11-11, under the owner's 2026-11-11 instruction that Trainee's reply be "the same length" as
// Instinct's): three rulings on the replies the length window left open.
//   1 the search summary keeps the count, the checked-open state and the scope; the freshness clause ("first seen in the last
//     N days") leaves the chat reply and is the turn's proof (each posting's first-seen date stays on the File).
//   2 the empty search has one short form: one clause of scope (what was checked, why nothing qualified, the limits kept) and
//     one widening offer. The refresh time, "Nothing was invented" and "nothing was applied for" are the turn's proof (D-024).
//   3 a message with two asks goes to the model, which answers both; the router keeps single asks. No splitting layer.
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { multiAsk } from "../../supabase/functions/_shared/ask_language.ts";
import { searchJudgeTurn, wideningOffer, type SourcePosting } from "../../supabase/functions/_shared/career_search_judge.ts";
import { nextWidening } from "../../supabase/functions/_shared/search_shortlist.ts";

const env = (v: Record<string, string>) => ({ get: (k: string) => v[k] });
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-d58", threadId: "t-d58", now: Date.UTC(2026, 10, 11, 15), snapshot: null, accountPersistence: true });
const STAGED = env({ CAREER_BRAIN: "staged" });
const decide = (m: string) => stagedDecision({ env: STAGED, message: m, ctx: fresh(), host, structured: false });

const NOW = Date.UTC(2026, 10, 11, 15), DAY = 86_400_000;
const P = (id: string, title: string, location: string, daysAgo: number): SourcePosting =>
  ({ job_id: id, company: `TEST ${id}`, title, location, url: `https://example.test/${id}`, description: "", first_seen_at: new Date(NOW - daysAgo * DAY).toISOString() });
const sources = (live: SourcePosting[], snap: SourcePosting[] = []) => ({ live: async () => live, liveHasRows: async () => live.length > 0, snapshot: async () => snap, refreshedAt: async () => new Date(NOW - 3600_000).toISOString() });

Deno.test("D-058 ruling 1: the summary keeps count, checked state and scope; the freshness is the turn's proof", async () => {
  const ask = { role: "data analyst jobs", place: "Chicago", remote: false };
  const r = (await searchJudgeTurn({ message: "find data analyst jobs in Chicago", ask, userId: "u", now: NOW, profile: null, sources: sources([P("g:1", "Data Analyst", "Chicago, IL", 3)]), judge: { on: false } }))!;
  assertNode.match(r.reply, /^From 1 live posting for data analyst in Chicago\.\n1 listed, not re-checked\./);
  assertNode.ok(!/first seen/.test(r.reply), r.reply);
  assertNode.equal(r.proof?.freshness, "first seen in the last 3 days");
  assertNode.equal(r.picked?.[0]?.posting?.first_seen_at, new Date(NOW - 3 * DAY).toISOString(), "the File keeps each posting's first-seen date");
});

Deno.test("D-058 ruling 2: the short empty form, scope and one widening; the refresh time and 'Nothing was invented' in the proof", async () => {
  for (const [ask, widen] of [
    [{ role: "economist internships", place: "Peoria", remote: false }, /Say "include remote US" to widen to remote roles in the US\.$/],
    [{ role: "data analyst jobs", place: "Chicago", remote: false }, /Say "include the Chicago area" to widen to the Chicago area\.$/],
    [{ role: "data analyst jobs", place: null, remote: true, remoteOnly: true }, /Say "include business analyst and analytics" to widen to related titles\.$/],
  ] as const) {
    const r = (await searchJudgeTurn({ message: "find them", ask: ask as any, userId: "u", now: NOW, profile: null, sources: sources([], []), judge: { on: false } }))!;
    assertNode.equal(r.status, "none");
    assertNode.match(r.reply, /^I checked .+ on the live board and the saved job-board snapshot: no open roles\./, r.reply);
    assertNode.match(r.reply, widen, r.reply);
    assertNode.equal((r.reply.match(/\bSay "/g) ?? []).length, 1, "one widening offer");
    assertNode.ok(!/Nothing was invented|last refreshed|applied for/.test(r.reply), r.reply);
    assertNode.match(String(r.proof?.checked), /on the live board \(last refreshed [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d\d [AP]M UTC\) and the saved snapshot of job boards$/);
    assertNode.equal(r.proof?.invented, "Nothing was invented to fill the list.");
    assertNode.equal(r.proof?.applied, "Nothing was applied for.");
    assertNode.equal(r.shortlist.length, 0);
  }
  assertNode.equal(wideningOffer(nextWidening({ role: "x", roles: ["a", "b"], place: null, remote: true })), "Want a later season or entry-level roles? Say which.");
});

const TWO = [
  "Two things. First, find me 7 devops engineer openings in Dallas. No applying yet. Second, draft only: make the second paragraph less generic.",
  "1) find software engineer roles in aerospace, do not apply. 2) don't send it: write a cover letter for the growth marketer role at Kaiser Permanente.",
  "Quick pair of asks: give me a case prompt to practise, and should I do a master's in marketing or start working.",
  "look up business analyst roles in the Boise area. Don't apply to anything. Then, unrelated: which one certificate would help most for frontend developer.",
  "find accountant roles in insurance, nothing under $20 an hour. Also, separately: give me three Looker practice problems.",
  "why didn't you include Prairie Ledger?. Also, draft a note to Elena at Prairie Ledger about the data analyst role",
  "rework my resume for data scientist jobs and keep it to one page; research Stripe before my interview",
];
const ONE = [
  "I only want media; find data scientist roles. Two things: it has to be remote, and nothing under $35 an hour.",
  "find data analyst internships in Chicago, also give me exactly 3. Don't apply.",
  "Two things: sponsorship is a must for me, and leave out staffing agencies. Find social media manager jobs.",
  "write a cover letter for the analyst role at Ramp",
  "They pay $26/hr plus a $50 bonus at my job; draft a counter at $30/hr",
  "stop",
  "yes",
];

Deno.test("D-058 ruling 3: two asks by their markers; one ask with two conditions is one ask", () => {
  for (const m of TWO) assertNode.ok(multiAsk(m), `two asks: ${m}`);
  for (const m of ONE) assertNode.ok(!multiAsk(m), `one ask: ${m}`);
});

Deno.test("D-058 ruling 3: a two-ask message is the model's on the staged brain; single asks keep their route", async () => {
  for (const m of TWO) {
    const d = await decide(m);
    // A router reply that already contains itself (a control, a crisis line) still wins; every other two-ask message is the model's.
    if (d.intent) assertNode.equal(d.reason, "multi_part", `${m}: ${d.intent} ${d.reason}`);
    assertNode.equal(d.brain, !!d.intent, `${m}: ${d.reason}`);
  }
  for (const m of ONE) assertNode.notEqual((await decide(m)).reason, "multi_part", m);
});
