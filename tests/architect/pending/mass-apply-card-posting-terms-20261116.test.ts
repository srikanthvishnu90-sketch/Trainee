// MASS APPLY CONVERSATIONS (2026-11-16, evals/career/mass-apply-conversations: every scenario's card-role-employer and
// card-pay-deadline checks): the card a person says one yes to names each application's ROLE beside its employer, and what the
// posting itself states that decides it: where, the pay and the deadline exactly as posted. Before, the card the hosted
// preparation pushed showed only "1. Lumen" and the answers (its ready rows carry no role), so three Data Analyst roles at
// three employers read as three company names. Now the finish asks `describe` (career_apply_cards.ts withRoles, as the
// chat's own "show my applications" does) and the pushed card carries the role and the posting's own terms. A posting that
// states no pay shows none; nothing is guessed; the card still carries every answer line verbatim.
import assertNode from "node:assert/strict";
import { cardFor, postedTerms, postingDetailLines, withRoles } from "../../../supabase/functions/_shared/career_apply_cards.ts";
import { handlePrepareBridge, prepareToken } from "../../../supabase/functions/_shared/cloud_prepare.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

Deno.test("the posting's own pay and deadline, as written; none when it states none", () => {
  eq(postedTerms("Software Engineering Intern. Requirements: Python. Pay: $42-$48 per hour. Apply by December 15, 2026. Summer 2026 internship."), { pay: "$42-$48 per hour", deadline: "December 15, 2026" });
  eq(postedTerms("Data Analyst. Salary: $70,000-$85,000. Entry level."), { pay: "$70,000-$85,000", deadline: null });
  eq(postedTerms("Backend intern. Applications close January 10, 2027."), { pay: null, deadline: "January 10, 2027" });
  eq(postedTerms("Competitive pay and great benefits. Apply soon."), { pay: null, deadline: null });
  eq(postingDetailLines({ location: "Remote (US)", description: "Pay: $45 per hour." }), ["Where: Remote (US)", "Pay (as posted): $45 per hour"]);
});

Deno.test("the card names the role and the posting's terms above the answers, and still carries every answer line", () => {
  const p = { id: "p1", company: "Northwind", card_lines: ["Northwind", "Email: a@example.test", "Sends to https://boards.greenhouse.io/northwind/jobs/9101"], role: "Software Engineering Intern",
    details: postingDetailLines({ location: "Chicago, IL", description: "Pay: $42-$48 per hour. Apply by December 15, 2026." }) };
  const c = cardFor([p]) as { text: string };
  assert(c.text.includes("1. Northwind — Software Engineering Intern\n   Where: Chicago, IL\n   Pay (as posted): $42-$48 per hour\n   Apply by (as posted): December 15, 2026\n   Email: a@example.test"), c.text);
  for (const l of p.card_lines.slice(1)) assert(c.text.includes(l), l);
});

// A service-role client double for withRoles: the attempts that link each prepared application to its posting, and the postings.
const admin = (postings: any[], attempts: any[]) => ({
  from: (t: string) => ({ select: () => ({ eq: () => ({ in: async () => ({ data: t === "career_apply_prepare_attempts" ? attempts : [] }) }), in: async () => ({ data: t === "career_postings" ? postings : [] }) }) }),
});

Deno.test("the hosted preparation's pushed card: role and posted terms from describe (before: '1. Lumen' and the answers only)", async () => {
  const SECRET = "TEST-unit-runner-secret-0123456789abcdef0123", U = "7b0f8f8e-6a43-4a49-9d2c-0000000001a1";
  const RID = "aaaaaaaa-bbbb-4ccc-8ddd-0000000000f1", LEASE = "11111111-2222-4333-8444-0000000000f1";
  const row = { id: RID, user_id: U, job_ids: ["greenhouse:lumen:801"], lease_token: LEASE, state: "running", claimed_at: new Date().toISOString() };
  const ready = [{ id: "cccccccc-bbbb-4ccc-8ddd-0000000000f3", company: "Lumen", card_lines: ["Lumen", "Email: a@example.test"], created_at: new Date().toISOString() }];
  let pushed = "";
  const deps = { secret: SECRET, readRequest: async () => row, stop: async () => {},
    describe: (user: string, rows: any[]) => withRoles(admin([{ job_id: "greenhouse:lumen:801", title: "Data Analyst", company: "Lumen", location: "Chicago, IL", description: "Salary: $70,000-$85,000." }],
      [{ prepared_id: "cccccccc-bbbb-4ccc-8ddd-0000000000f3", posting_job_id: "greenhouse:lumen:801" }]), user, rows),
    rpc: async (name: string, args: any) => {
      if (name === "career_apply_prepare_request_ready") return ready;
      if (name === "career_apply_questions_open_as" || name === "career_apply_prepare_candidates_for" || name === "career_apply_prepare_request_questions") return [];
      if (name === "career_apply_card_push_requested_for") { pushed = args.p_text; return "dddddddd-bbbb-4ccc-8ddd-0000000000f4"; }
      if (name === "career_apply_prepare_request_finish") return { state: "done" };
      throw Error(name);
    } };
  const out = await handlePrepareBridge("finish", { id: RID, sandbox: "sbx_A", token: await prepareToken(SECRET, RID, LEASE, "sbx_A"), outcomes: [{ job_id: "greenhouse:lumen:801", outcome: "ready", detail: "" }] }, deps as any);
  eq((out.body as any).push, "shown");
  assert(pushed.includes("1. Lumen — Data Analyst\n   Where: Chicago, IL\n   Pay (as posted): $70,000-$85,000\n   Email: a@example.test"), pushed);
});
