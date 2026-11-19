// S3 r12c (the subscription sitting for 2789d3090: dev H022 failed on both judges). The transcripts are in
// evals/career/results/s3sub-2789d30903203bd7af2833bcb80ad4facf0c5705-p1.json / -p2.json.
// Run: deno test -A --no-check tests/edge/s3-r12c-h022.test.ts
import { Ledger, verifyTagged } from "../../supabase/functions/_shared/agent/reply_pipeline.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const NOW = Date.UTC(2026, 9, 19, 15);
const yes = async (cs: unknown[]) => cs.map(() => "yes" as const);

// ---------------------------------------------------------------------------------------------------------------- H022
const H022 = "which of my skills match a data analyst role?";
// (the person's own messages in this chat, as career_brain.ts passes them: the history's user turns and this message)
const SAID = ["I know SQL, Excel and Tableau and did 2 years of reporting", H022];
async function h022Ledger() {
  const t = careerTools({ postings: async () => [] }).find((x) => x.name === "search_jobs")!;
  const out: any = await t.run({ query: "data analyst" }, { userId: "u", threadId: "t", now: NOW, state: {}, turn: { message: H022 } } as any);
  const l = new Ledger(NOW);
  // (their two facts are saved as drafts awaiting their yes: not in the ledger, D-007)
  l.addRecord([], ["city", "phone", "email"]);
  l.fromToolResult("search_jobs", out);
  return l;
}
const H022_DRAFT = "Your SQL and Tableau are the core toolkit for a data analyst role, and Excel covers the ad hoc analysis. " +
  "Your 2 years of reporting is the closest match to the day-to-day work.\n" +
  "1. Data analyst: your SQL and Tableau are the core toolkit.\n2. Reporting analyst: closest to your 2 years of reporting.\n" +
  "With SQL, Excel and Tableau, you already use a data analyst's main tools.";

Deno.test("S3 r12c / H022: before the fix, an empty-search turn dropped every sentence mapping their stated skills", async () => {
  // (p2's turn 2 searched, so the pipeline ran: "no unit holds it", "no cited unit is about SQL", "... about Reporting")
  const v = await verifyTagged(H022_DRAFT, await h022Ledger(), { ask: H022, judge: yes });
  assert(!/SQL|reporting/i.test(v.text) && v.failures.length >= 4, JSON.stringify(v));
});

Deno.test("S3 r12c / H022: the check reads the person's own words, so those sentences stand", async () => {
  const l = await h022Ledger();
  const v = await verifyTagged(H022_DRAFT, l, { ask: H022, judge: yes, said: SAID });
  assert(!v.failures.length, JSON.stringify(v.failures));
  for (const w of ["SQL and Tableau are the core toolkit", "2 years of reporting is the closest", "Reporting analyst: closest", "With SQL, Excel and Tableau"]) assert(v.text.includes(w), v.text);
  // (never in the drafting ledger: the block the draft cites is unchanged, D-007)
  assert(!/SQL/.test(l.block()) && !l.units.some((u) => u.kind === "said"), l.block());
});

Deno.test("S3 r12c / H022: their words back only what they said; a skill they never stated is still dropped", async () => {
  const v = await verifyTagged("Your Python and R are strong for this role.", await h022Ledger(), { ask: H022, judge: yes, said: SAID });
  assert(v.failures.length && !/Python/.test(v.text), JSON.stringify(v));
});

Deno.test("S3 r12c / H022: their words never back a claim about an employer or a posting", async () => {
  const said = ["Stripe pays $60 an hour and Acme has an open data analyst posting"];
  for (const d of ["Stripe pays $60 an hour.", "Acme has an open data analyst posting."]) {
    const v = await verifyTagged(d, await h022Ledger(), { ask: "data analyst jobs", judge: yes, said });
    assert(v.failures.length && !v.text.includes(d.slice(0, 10)), `${d}: ${JSON.stringify(v)}`);
  }
});

Deno.test("S3 r12c / H022: a word their own lines use as an employer still makes it a subject (round 12 B1 unchanged)", async () => {
  const l = new Ledger(NOW);
  l.addRecord(["experience: Intern at Stripe"]);
  l.fromToolResult("search_jobs", { postings: [{ company: "Riverside Health", title: "Data Analyst", location: "Columbus, OH", url: "https://jobs.example.com/da-1", state: "open" }] });
  const v = await verifyTagged("Stripe pays $60 an hour.", l, { ask: "data analyst jobs", judge: yes });
  assert(v.failures[0]?.subject === "Stripe", JSON.stringify(v.failures));
  assert(v.failures.length && !/Stripe/.test(v.text), JSON.stringify(v));
});

// (the probes after the said units, probe-r12c-fix-1/-5 and the traced replay: the failing sentences, verbatim from the repair input)
const MAPPED = "All three of your skills match a data analyst role: SQL for pulling data, Excel for analysis and Tableau for dashboards, and your 2 years of reporting is the closest experience to it, per what you told me.";
const oneHit = () => { const l = new Ledger(NOW); l.fromToolResult("search_jobs", { postings: [{ company: "Riverside Health", title: "Data Analyst", location: "Columbus, OH", url: "https://jobs.example.com/da-1", state: "open" }] }); return l; };
const no = async (cs: unknown[]) => cs.map(() => "no" as const);

Deno.test("S3 r12c / H022: on a turn whose tools read nothing, a sentence mapping their own stated work stands (no judge needed)", async () => {
  const v = await verifyTagged(MAPPED, await h022Ledger(), { ask: H022, judge: no, said: SAID });
  assert(!v.failures.length && v.text.includes("SQL for pulling data"), JSON.stringify(v));
  // (tagged with the empty search's own unit, the same)
  const l = await h022Ledger();
  const e = l.units.find((u) => u.empty)!.id;
  const t = await verifyTagged(`${MAPPED} [${e}]`, l, { ask: H022, judge: no, said: SAID });
  assert(!t.failures.length, JSON.stringify(t));
});

Deno.test("S3 r12c / H022: the same sentence on a turn that read a posting is checked as before", async () => {
  const v = await verifyTagged(MAPPED, oneHit(), { ask: H022, judge: no, said: SAID });
  assert(v.failures.length && !v.text.includes("SQL for pulling data"), JSON.stringify(v));
});

Deno.test("S3 r12c / H022: on an empty-search turn, employer, posting, figure and status claims are still checked", async () => {
  for (const d of ["Your SQL fits Stripe's analyst team, which pays $60 an hour.", "Your SQL and Tableau fit the open data analyst postings near you.",
    "Your 5 years of SQL make you senior.", "Your SQL application was sent to Acme.", "Your SQL skills got you an interview."]) {
    const v = await verifyTagged(d, await h022Ledger(), { ask: H022, judge: no, said: SAID });
    assert(v.failures.length, `${d}: ${JSON.stringify(v)}`);
  }
  // (a general claim not addressed to the person is checked as before)
  const g = await verifyTagged("Tableau is required for most data analyst roles.", await h022Ledger(), { ask: H022, judge: no, said: SAID });
  assert(g.failures.length, JSON.stringify(g));
});

Deno.test("S3 r12c / H022: a word before a job title's head noun is no employer, so it is not carried (\"BI analyst\")", async () => {
  const t1 = "I know SQL, Excel and Tableau and did 2 years of reporting";
  const t = careerTools({ postings: async () => [] }).find((x) => x.name === "search_jobs")!;
  const out: any = await t.run({ query: "reporting analyst SQL Tableau" }, { userId: "u", threadId: "t", now: NOW, state: {}, turn: { message: t1 } } as any);
  const l = new Ledger(NOW); l.fromToolResult("search_jobs", out);
  const draft = "With SQL, Excel, Tableau and 2 years of reporting, you could get hired as a reporting analyst, BI analyst or data analyst. Which city, or remote, should I search?";
  const v = await verifyTagged(draft, l, { ask: t1, judge: yes, said: [t1] });
  assert(!v.failures.some((f) => /about BI/.test(f.reason)), JSON.stringify(v.failures));
  assert(v.text.includes("Which city, or remote, should I search?"), v.text);
  // (an employer written with the plural is still one: "Citadel analysts earn $90 an hour" needs Citadel's unit)
  const c = await verifyTagged("Citadel analysts earn $90 an hour.", oneHit(), { ask: "analyst pay", judge: yes });
  assert(c.failures.length, JSON.stringify(c));
});
