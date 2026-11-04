// LETTER TARGET AT SCALE (architect, 2026-10-29; owner rule D-007, never invent a fact). The onboarding battery found
// "write a cover letter … I live in Boston" set the letter's target to "the Boston Consulting Group role": the company-file
// matcher took the first word of a file's name (Boston) as the firm. ~10,000 seeded asks
// (tests/architect/scenarios/letter-target-generator.ts) through the router's own code, as the handler runs it
// (supabase/functions/_shared/router_core.career.js, the bundle of packages/domain/142-career-router.js):
//   extraction  CareerRouter.letterTargetOf: the target is exactly the company the ask names (or none), and every target it
//               returns stands in the ask as a whole name (a firm's own short form counts; a word that only opens a firm's
//               name, a city, a school, a skill, a former employer or a negated firm never does)
//   turns       a sample through the career host's turn (130 onboarding, then the 142 router), with no profile and with a
//               confirmed resume: every target a reply sets or states ("The letter's target is set — …", "The target is
//               set — …", "I need the … posting to tailor against") is a posting they referenced or is made only of what they
//               said, and no reply names a company with a file on record that the ask did not name
// No network, no model, no database (the same asks on real Postgres: flow-scenarios-letter-target.test.ts).
//   deno test -A --no-check tests/architect/scenarios-letter-target.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { letterCases, namedIn, postingOf, replyViolation, rng } from "./scenarios/letter-target-generator.ts";

const SEED = 20261029;
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const Router = (core as any).CareerRouter;
const P = (core as any).CareerProfile;
const host = (CareerHost as any).createCareerHost(core);
const NOW = Date.parse("2026-10-29T15:00:00Z");

type Fails = Map<string, string[]>;
const fail = (f: Fails, family: string, line: string) => { if (!f.has(family)) f.set(family, []); f.get(family)!.push(line); };
function report(f: Fails, total: number, what: string) {
  const n = [...f.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[letter-target] ${what}: ${total} scenarios, ${n} failures`];
  for (const [k, xs] of f) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 5)) lines.push(`    ${x}`); }
  console.log(lines.join("\n"));
  assertNode.equal(n, 0, `${what}: ${n} of ${total} failed (see the report above)`);
}

Deno.test("letter target extraction: ~10,000 asks name exactly their target, and every target is a whole name the person said", () => {
  const cases = letterCases(rng(SEED), 10000);
  const f: Fails = new Map();
  const fams = new Map<string, number>();
  for (const c of cases) {
    fams.set(c.family.split(":")[0], (fams.get(c.family.split(":")[0]) ?? 0) + 1);
    const got = Router.letterTargetOf(c.input, { postings: (c.postings ?? []).map(postingOf) })?.company ?? null;
    if (got && !namedIn(c.input, got)) fail(f, `invented:${c.family}`, `${JSON.stringify(c.input)} -> ${got}: never named as a whole name`);
    else if (got !== c.expect) fail(f, c.family, `${JSON.stringify(c.input)} -> ${got}, expected ${c.expect}`);
  }
  console.log(`[letter-target] families: ${[...fams].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  report(f, cases.length, "extraction");
});

Deno.test("the reported bug: a city, school or plain word is never expanded into a firm (input → expected → actual on trunk)", () => {
  const rows: [string, string | null][] = [
    ["write a cover letter, I live in Boston", null], // trunk: Boston Consulting Group
    ["write me a cover letter. I live in Boston", null], // trunk: Boston Consulting Group
    ["tailor my resume, I live in Boston", null], // trunk: Boston Consulting Group
    ["write a cover letter, I studied at Boston University", null], // trunk: Boston Consulting Group
    ["write a cover letter for Bain Capital", "Bain Capital"], // trunk: Bain & Company
    ["write a cover letter for Goldman Sachs Asset Management", "Goldman Sachs Asset Management"], // trunk: Goldman Sachs
    ["write a cover letter, I'm a student at Goldman School of Public Policy", null], // trunk: Goldman Sachs
    ["write a cover letter. I know Python, SQL and Snowflake", null], // trunk: Snowflake
    ["write a cover letter, I wrote an essay about the Amazon river", null], // trunk: Amazon
    ["write a cover letter, I used to work at Stripe", null], // trunk: Stripe
    ["write a cover letter for Stripe, not Goldman", "Stripe"],
    ["write a cover letter for Deloitte", "Deloitte"], // trunk: Deloitte Consulting
    ["write a cover letter for Citadel", "Citadel"], // trunk: Citadel Securities
    ["write a cover letter for the analyst role at Wells Fargo. I live in Boston", "Wells Fargo"],
  ];
  for (const [input, want] of rows) assertNode.equal(Router.letterTargetOf(input, {})?.company ?? null, want, input);
});

function turn(text: string, o: { profile?: boolean; posting?: unknown; postings?: string[] } = {}) {
  const ctx = host.createTurnCtx({ userId: "TEST-lt", threadId: "t-lt", now: NOW, accountPersistence: true, snapshot: null, account: { epoch: 0, version: 0, paused: false }, postings: (o.postings ?? []).map(postingOf) });
  if (o.profile) { const p = P.createProfile({ id: "TEST-lt" }); P.ingestResume(p, RESUME); for (const fct of p.facts) P.confirmFact(p, fct.id); ctx.profile = p; }
  if (o.posting !== undefined) ctx.posting = o.posting;
  const r = host.runTurn(text, ctx);
  return { intent: String(r.intent ?? ""), reply: String(r.reply ?? ""), mirror: ctx };
}

Deno.test("letter target turns: a sample through the career host's turn, no profile and a confirmed resume; no reply states a target never named", () => {
  const all = letterCases(rng(SEED + 1), 10000);
  const sample = all.filter((_, i) => i % 8 === 0);
  const f: Fails = new Map();
  let tailorTurns = 0, named = 0;
  for (const [i, c] of sample.entries()) {
    const profile = i % 3 === 0;
    const r = turn(c.input, { profile, postings: c.postings });
    const v = replyViolation(c.input, r.reply);
    if (v) fail(f, `${profile ? "resume" : "no-resume"}:${c.family}`, `${JSON.stringify(c.input)} -> ${r.intent}: ${v}`);
    if (r.intent === "career_tailor" && !profile) {
      tailorTurns++;
      // The no-resume letter / tailor reply names exactly the target the ask named, or none.
      const m = /target is set — (.+?)\.(?:\s+(?:It|One)\b|[ \t]*\n|\s*$)/.exec(r.reply);
      if (c.expect && !(m && m[1].includes(c.expect))) fail(f, `missed:${c.family}`, `${JSON.stringify(c.input)}: expected the target ${c.expect}: ${r.reply.split("\n")[0]}`);
      if (c.expect) named++;
      if (!c.expect && m && /^the [A-Z]/.test(m[1])) fail(f, `claimed:${c.family}`, `${JSON.stringify(c.input)}: a company target with none named: ${m[0]}`);
    }
  }
  console.log(`[letter-target] turns: ${sample.length} (no-resume letter/tailor answers ${tailorTurns}, ${named} with a named target)`);
  report(f, sample.length, "turns");
});

Deno.test("a referenced posting is the target; a hollow one (no company, no title) is none", () => {
  const posting = { source: "user_pasted_link", url: "https://boards.greenhouse.io/acmerobotics/jobs/7", company: "Acme Robotics", title: "Data Analyst", job_id: "7" };
  const r = turn("write a cover letter for this one, I live in Boston", { posting });
  assertNode.ok(/target is set — Data Analyst at Acme Robotics\./.test(r.reply), r.reply);
  assertNode.equal(replyViolation("write a cover letter for this one, I live in Boston", r.reply, posting), null);
  const hollow = turn("write a cover letter, I live in Boston", { posting: { source: "user_pasted_link", url: "https://github.com/example-testcase", company: null, title: null, job_id: null } });
  assertNode.ok(!/target is set/.test(hollow.reply) && !/Boston Consulting/.test(hollow.reply), hollow.reply);
});

Deno.test("the tailoring branch with a confirmed resume: a city is no firm; a named firm with no posting is asked for by its name", () => {
  const city = turn("tailor my resume, I live in Boston", { profile: true });
  assertNode.ok(!/Boston Consulting/.test(city.reply), `trunk said "I need the Boston Consulting Group posting": ${city.reply}`);
  const named = turn("tailor my resume for Goldman Sachs. I live in Boston", { profile: true });
  assertNode.ok(/Goldman Sachs/.test(named.reply) && !/Boston Consulting/.test(named.reply), named.reply);
  const unfiled = turn("tailor my resume for the analyst role at Wells Fargo", { profile: true });
  assertNode.equal(replyViolation("tailor my resume for the analyst role at Wells Fargo", unfiled.reply), null, unfiled.reply);
});
