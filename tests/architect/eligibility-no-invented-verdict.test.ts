// No invented verdict, and confirmed facts read back (chat journey 2026-10-28, D-007). Through the same CareerHost chain
// the handler runs (130 onboarding, then 142 router), with a profile whose resume facts the person confirmed:
//   1. "do I need visa sponsorship?" (never stated, no posting named) says it is not on their record and asks them; no
//      verdict. The thread carries the hollow posting a pasted resume's GitHub link stages (company, title and text all
//      null), which trunk graded as "null at null" and answered "Verdict: this record evidences every hard requirement".
//   2. An eligibility ask over a hollow posting, or over posting text with no requirement read from it, speaks no verdict;
//      a posting with real requirements is still graded (the control).
//   3. A stated sponsorship fact is answered from the record, in the record's words.
//   4. "where did I go to school?" and "what is my GPA?" are answered from the confirmed education entry; a draft is never
//      read back.
// No network, no model.
//   deno test -A --no-check tests/architect/eligibility-no-invented-verdict.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const P = (core as any).CareerProfile;
const host = (CareerHost as any).createCareerHost(core);
const HOLLOW = { source: "user_pasted_link", url: "https://github.com/example-testcase", company: null, job_id: null, title: null };

function profile(confirm: boolean) {
  const p = P.createProfile({ id: "TEST-elig" });
  P.ingestResume(p, RESUME);
  if (confirm) for (const f of p.facts) P.confirmFact(p, f.id);
  return p;
}
function turn(text: string, o: { confirm?: boolean; posting?: unknown; stated?: unknown[] } = {}) {
  const ctx = host.createTurnCtx({ userId: "TEST-elig", threadId: "t-elig", now: Date.parse("2026-10-28T15:00:00Z"), accountPersistence: true,
    snapshot: null, account: { epoch: 0, version: 0, paused: false }, postings: [] });
  ctx.profile = profile(o.confirm ?? true);
  if (o.posting !== undefined) ctx.posting = o.posting;
  if (o.stated) ctx.statedFacts = { facts: o.stated };
  const r = host.runTurn(text, ctx);
  return { intent: String(r.intent ?? ""), reply: String(r.reply ?? "") };
}

Deno.test("a sponsorship question never stated, with no posting named, is said to be not on record and asked; no verdict", () => {
  for (const posting of [HOLLOW, null]) {
    const r = turn("do I need visa sponsorship?", { posting });
    assertNode.ok(!/Verdict|evidences every/i.test(r.reply), `no verdict on a posting nobody named (${JSON.stringify(posting)}): ${r.reply}`);
    assertNode.ok(/not on your record|have not told me|haven't told me/i.test(r.reply), `sponsorship is said to be not on record: ${r.reply}`);
    assertNode.ok(/\?/.test(r.reply), `it is asked of them: ${r.reply}`);
  }
});

Deno.test("a stated sponsorship fact is answered from the record, in its words", () => {
  const r = turn("do I need visa sponsorship?", { posting: HOLLOW, stated: [{ kind: "sponsorship", value: "does not need sponsorship", evidence: "I don't need sponsorship" }] });
  assertNode.ok(/you do not need sponsorship/.test(r.reply), r.reply);
  assertNode.ok(!/Verdict/i.test(r.reply), r.reply);
});

Deno.test("an eligibility ask grades only a real posting with requirements read from it", () => {
  const hollow = turn("am I eligible for it?", { posting: HOLLOW });
  assertNode.ok(!/Verdict:|evidences every/.test(hollow.reply), `a hollow staged posting is not graded: ${hollow.reply}`);
  const empty = turn("am I eligible for this role?", { posting: { source: "user_pasted", company: "Acme (TEST)", title: "Analyst", jd_text: "Join our friendly team. We value curiosity.", url: null } });
  assertNode.ok(!/evidences every/i.test(empty.reply), `zero requirements read is no verdict: ${empty.reply}`);
  const real = turn("am I eligible for this role?", { posting: { source: "user_pasted", company: "Acme (TEST)", title: "Data Analyst", jd_text: "Data Analyst. Requirements: SQL, Python, dashboards for internal teams.", url: null } });
  assertNode.ok(/Verdict/.test(real.reply), `a real posting is still graded: ${real.reply}`);
});

Deno.test("school and GPA are answered from the confirmed education entry; a draft is never read back", () => {
  const school = turn("where did I go to school?");
  assertNode.ok(school.reply.includes("TEST University"), school.reply);
  const gpa = turn("what is my GPA?");
  const said = gpa.reply.match(/\b\d\.\d{1,2}\b/g) ?? [];
  assertNode.deepEqual([...new Set(said)], ["3.7"], gpa.reply);
  const draftSchool = turn("where did I go to school?", { confirm: false });
  assertNode.ok(!draftSchool.reply.includes("TEST University"), `a draft is not read back: ${draftSchool.reply}`);
  const draftGpa = turn("what is my GPA?", { confirm: false });
  assertNode.ok(!/3\.7/.test(draftGpa.reply), `a draft GPA is not read back: ${draftGpa.reply}`);
});
