// S3 r12e (the subscription sitting #6 on 52e2025c9: dev H019 failed on both judges in p1; H009 split the judges in p2 and p3;
// H022 failed on both judges in p3). The transcripts are in evals/career/results/s3sub-52e2025c95d365849dfa5b10591b24a700969029-p1.json,
// -p2.json and -p3.json (the sitting's worktree). Each message below is this file's own (synthetic companies), never a held-out case's.
// Run: deno test -A --no-check tests/edge/s3-r12e.test.ts
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { g1CodeAnswers, stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { Ledger, verifyTagged } from "../../supabase/functions/_shared/agent/reply_pipeline.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const NOW = Date.UTC(2026, 9, 19, 15);
const PROD = { get: (_k: string) => undefined };
const ctxAt = (snap: unknown, n: number) => host.createTurnCtx({ userId: "u-r12e", threadId: "t-r12e", now: NOW + n * 60000, accountPersistence: true, snapshot: snap, account: { epoch: 0, version: 0, paused: false } });
function chat(messages: string[]) {
  let snap: unknown = null;
  return messages.map((m, n) => { const ctx = ctxAt(snap, n); const r = host.runTurn(m, ctx); snap = host.extractSnapshot(ctx); return r; });
}

// ---------------------------------------------------------------------------------------------------------------- H019
Deno.test("S3 r12e / H019: an ask for the tailoring's change list is code's answer from its own record, not the brain's", () => {
  // (p1: route brain, intent career_tailor_diff, the brain called list_applications, and the applications hold kept only
  // "Trainee's saved record shows no applications of yours …")
  for (const m of ["show me what you changed and why", "what did you change on it?", "show me exactly what you changed"]) {
    const d = stagedDecision({ env: PROD, message: m, ctx: ctxAt(null, 0), host, structured: false });
    assert(d.intent === "career_tailor_diff" && d.brain === false, `${m}: ${d.intent}/${d.reason}`);
  }
  assert(g1CodeAnswers("what did you change?", "career_tailor_diff", {}), "the change list is code's record");
  // (the router's own answer: no tailoring on the thread is said plainly, with no applications line)
  const [r] = chat(["show me what you changed and why"]);
  assert(r.intent === "career_tailor_diff" && /No tailoring has run in this conversation yet/.test(r.reply) && !/applications? of yours|email was not checked/.test(r.reply), r.reply);
});

Deno.test("S3 r12e / H019: a hypothetical or several asks beside it stay the brain's (G8, G13)", () => {
  const multi = stagedDecision({ env: PROD, message: "what did you change, and also find me analyst jobs in Denver", ctx: ctxAt(null, 0), host, structured: false });
  assert(multi.brain === true, `${multi.intent}/${multi.reason}`);
  assert(!g1CodeAnswers("hypothetically, what would you change?", "career_tailor_diff", {}), "a hypothetical is the brain's");
});

// ---------------------------------------------------------------------------------------------------------------- H009
Deno.test("S3 r12e / H009: a reported stage move names the person's own word for it, with the tracker's stage beside it", () => {
  // (p2, p3: "Moved — … now sits at the Interview rounds stage on your tracker." for their "onsite", then a sentence about evidence)
  const [, onsite] = chat(["I applied to the Data Analyst role at Brightmoor Logistics last week", "I moved to the onsite round at Brightmoor Logistics for the Data Analyst role"]);
  assert(onsite.intent === "tracking_log", onsite.intent);
  assert(/Brightmoor Logistics is now at the onsite round \(Interview rounds on your tracker\)/.test(onsite.reply), onsite.reply);
  assert(!/your word is the evidence|stages here change on evidence/i.test(onsite.reply), onsite.reply);
  const [, phone] = chat(["I applied to the Data Analyst role at Brightmoor Logistics last week", "I moved to the phone screen at Brightmoor Logistics"]);
  assert(/the phone screen \(Recruiter screen on your tracker\)/.test(phone.reply), phone.reply);
  // (their word is the stage's own: the stage is named once)
  const [, same] = chat(["I applied to the Data Analyst role at Brightmoor Logistics last week", "move Brightmoor Logistics to the interview stage"]);
  assert(/is now at the Interview rounds stage on your tracker\./.test(same.reply) && !/\(Interview rounds/.test(same.reply), same.reply);
});

// ---------------------------------------------------------------------------------------------------------------- H022
// (p3: turn 2 searched, the search was empty, and the draft tagged its sentences with the one unit it could cite, the search's count
// line; the person's words, units of the check only, were never put beside a tagged sentence, so "'2' is in no cited unit" dropped
// every mapping sentence and the repair answered "I couldn't verify an answer to that from what I read")
const ASK = "which of my strengths fit a reporting analyst job?";
const SAID = ["I use SQL, Looker and Excel and did 3 years of finance reporting", ASK];
async function emptySearchLedger() {
  const t = careerTools({ postings: async () => [] }).find((x) => x.name === "search_jobs")!;
  const out: any = await t.run({ query: "reporting analyst" }, { userId: "u", threadId: "t", now: NOW, state: {}, turn: { message: ASK } } as any);
  const l = new Ledger(NOW); l.addRecord([], ["city"]); l.fromToolResult("search_jobs", out);
  const id = l.units.find((u) => u.kind === "chat")!.id;
  return { l, id };
}
const yes = async (cs: unknown[]) => cs.map(() => "yes" as const);
const no = async (cs: unknown[]) => cs.map(() => "no" as const);

Deno.test("S3 r12e / H022: a tagged sentence about their stated skills is checked against their words, and the judge reads it", async () => {
  const { l, id } = await emptySearchLedger();
  const asked: { claim: string; source: string }[] = [];
  const rec = async (cs: { claim: string; source: string }[]) => { asked.push(...cs); return cs.map(() => "yes" as const); };
  for (const d of [`Your SQL, Looker and Excel are the core tools of reporting work, and your 3 years of finance reporting is the closest experience to it. [${id}]`,
    `Your 3 years of finance reporting is the closest experience to the job. [${id}]`, `Looker covers dashboards and Excel covers everyday analysis. [${id}]`]) {
    asked.length = 0;
    const v = await verifyTagged(d, l, { ask: ASK, judge: rec, said: SAID });
    assert(!v.failures.length && v.text.length > 20, `${d}: ${JSON.stringify(v)}`);
    assert(asked.some((x) => x.source.includes("did 3 years of finance reporting")), `the judge never saw their words: ${JSON.stringify(asked)}`);
    // (the judge decides: a "no" drops it)
    const n = await verifyTagged(d, l, { ask: ASK, judge: no, said: SAID });
    assert(n.failures.length && !/finance reporting is the closest|Looker covers/.test(n.text), JSON.stringify(n));
  }
});

Deno.test("S3 r12e / H022: tagged or not, their words back nothing they did not say, and no employer or posting claim", async () => {
  const { l, id } = await emptySearchLedger();
  for (const d of [`Your Python and R are strong for this role. [${id}]`, `Your 5 years of finance reporting make you senior. [${id}]`,
    `Your SQL fits Stripe's analyst team, which pays $60 an hour. [${id}]`, `Your Looker skills fit the open reporting analyst postings near you. [${id}]`,
    `Acme has a reporting team that would suit your SQL. [${id}]`, `Your SQL application was sent to Acme. [${id}]`]) {
    const v = await verifyTagged(d, l, { ask: ASK, judge: yes, said: SAID });
    assert(v.failures.length, `${d}: ${JSON.stringify(v)}`);
  }
  // (with no words of theirs, the same tagged sentence still fails: the said units are the only change)
  const bare = await verifyTagged(`Your 3 years of finance reporting is the closest experience to the job. [${id}]`, l, { ask: ASK, judge: yes });
  assert(bare.failures.length, JSON.stringify(bare));
});
