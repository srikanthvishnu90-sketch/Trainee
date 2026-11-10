// R9 apply completion (architect, 2026-11-08; fix/r9-apply-completion-20261108). The 1,000-task eval (evals/career/e2e,
// --set full) scored apply 10.4%. Root causes fixed here, each held on the real code:
//   A. The ask as people text it. An apply or search ask with filler ("lowkey", "fr", "🙏"), a typo ("appply", "rle",
//      "firrst", "sicence"), "can you apply me to ...?", "please submit an application for ...", "I want to apply 4 X's ...",
//      Spanish or romanized Hindi reached the staged brain, which never applies (STAGED_WITHHELD_TOOLS): no card. It is
//      now read into the plain English shape the apply turn and the search already read (career_ask_canon.ts), names,
//      titles, places and links kept exactly as typed. A reply to a card or a question, a "don't apply", a how-question
//      and the past are never read as an ask.
//   B. Two named roles in one message read the same way ("aplica a X en Y y a Z en W", "Y ke X aur W ke Z dono mein apply
//      kar do", "... rle at Y and the ... rolle at W").
//   C. SmartRecruiters: a jobs.smartrecruiters.com posting is a posting the queue can key (posting_key.ts, the engine's
//      own key), and the cloud's claims, refusals, gate and dispatch name the family (20261108120000), under the same
//      gate as the other three: nothing opens by itself.
//   D. The eval's "find X roles in <city> and apply to all of them" asked for exactly min(5, the track's postings): five
//      when the person's search had two, and a fail for applying to all eighteen. It now asks for every posting whose
//      title says what they searched (at least), and at most the track's postings there.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { careerAskCanon } from "../../supabase/functions/_shared/career_ask_canon.ts";
import { applyAsk, namedAsks } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { detectPortal, formUrlFor, postingKey } from "../../supabase/functions/_shared/posting_key.ts";
import { wantsFrom } from "../../supabase/functions/_shared/career_apply_want.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("A: an apply ask as people text it reads as the apply turn's own shape, names kept as typed", () => {
  const single: [string, string, string][] = [
    ["apply to the Data Scientist role at Keystone Bank 🙏", "Data Scientist", "Keystone Bank"],
    ["lowkey apply to the Data Analyst role at Truecourse Analytics no cap", "Data Analyst", "Truecourse Analytics"],
    ["can you apply me to the Machine Learning Engineer, New Grad job at Beacon Energy?", "Machine Learning Engineer, New Grad", "Beacon Energy"],
    ["can u aplpy me to the Frontend Engineering Intern job at Hollow Oak Freight? thx", "Frontend Engineering Intern", "Hollow Oak Freight"],
    ["please submit an application for FP&A Analyst at Prairie Logistics", "FP&A Analyst", "Prairie Logistics"],
    ["plase sbmit an appilcation for Frontend Engineer at Silverpine Security", "Frontend Engineer", "Silverpine Security"],
    ["i want to apply 4 Quarry Capital's Frontend Engineer opening rn", "Frontend Engineer", "Quarry Capital"],
    ["I watn to appy for Willow Freight's Data Science Intern opening", "Data Science Intern", "Willow Freight"],
    ["aply to the Software Engineer, New Grad rloe at Truecourse Foods", "Software Engineer, New Grad", "Truecourse Foods"],
    ["aplica al puesto de UI Engineer en Silverpine Security porfa", "UI Engineer", "Silverpine Security"],
    ["quiero aplicar al rol de Software Engineer, New Grad en Onyx Analytics", "Software Engineer, New Grad", "Onyx Analytics"],
    ["Northgate Bio pe Financial Analyst role ke liye apply kar do", "Financial Analyst", "Northgate Bio"],
    ["mujhe Arbor Energy ke Backend Engineer, New Grad job ke liye apply karna hai", "Backend Engineer, New Grad", "Arbor Energy"],
  ];
  for (const [m, role, company] of single) {
    const c = careerAskCanon(m);
    assert(c, `read: ${m}`);
    assertEquals(applyAsk(c!), { role, company }, `${m} -> ${c}`);
  }
});

Deno.test("B: two named roles in one message, in any of the ways people text it, are the two asks", () => {
  const two: [string, [string, string][]][] = [
    ["apply to the Business Intelligence Analyst role at Delta Bay Freight and the Financial Analyst role at Sable Energy 🙏", [["Business Intelligence Analyst", "Delta Bay Freight"], ["Financial Analyst", "Sable Energy"]]],
    ["apply to the Full Stack Engineer rle at Quarry Logistics and the Software Engineer Intern rolle at Delta Bay Media", [["Full Stack Engineer", "Quarry Logistics"], ["Software Engineer Intern", "Delta Bay Media"]]],
    ["hey can u apply to the Data Science Intern role at Zephyr Foods and the Software Engineer, New Grad role at Truecourse Foods fr", [["Data Science Intern", "Zephyr Foods"], ["Software Engineer, New Grad", "Truecourse Foods"]]],
    ["aplica a Software Engineer Intern en Vantage Energy y a Frontend Engineering Intern en Tidal Robotics", [["Software Engineer Intern", "Vantage Energy"], ["Frontend Engineering Intern", "Tidal Robotics"]]],
    ["Lumina Systems ke Financial Analyst aur Halcyon Robotics ke Frontend Engineering Intern dono mein apply kar do", [["Financial Analyst", "Lumina Systems"], ["Frontend Engineering Intern", "Halcyon Robotics"]]],
  ];
  for (const [m, want] of two) {
    const c = careerAskCanon(m) ?? m;
    assertEquals(namedAsks(c)?.map((a) => [a.role, a.company]), want, `${m} -> ${c}`);
  }
});

Deno.test("A: searches and picks from a list read the same way; links are kept byte for byte", () => {
  const cases: [string, string][] = [
    ["find financial analyyst rolees in Denver", "find financial analyst roles in Denver"],
    ["fid dta analyst roles in Denver", "find data analyst roles in Denver"],
    ["find data analyst roles in San Francisco ty", "find data analyst roles in San Francisco"],
    ["hey can u find frontend roles in New York and apply to all of them ty", "find frontend roles in New York and apply to all of them"],
    ["busca roles de data analyst en Austin y aplica a todos", "find data analyst roles in Austin and apply to all of them"],
    ["Seattle mein frontend roles dhundo aur sab mein apply kar do", "find frontend roles in Seattle and apply to all of them"],
    ["go 4 the first one, apply pls", "apply to the first one"],
    ["appy to the firrst one", "apply to the first one"],
    ["appply to the top one", "apply to the top one"],
    ["aplica al primero", "apply to the first one"],
    ["pehle wale mein apply kar do", "apply to the first one"],
  ];
  for (const [m, want] of cases) assertEquals(careerAskCanon(m), want, m);
  const links = "https://boards.greenhouse.io/acme/jobs/4100100\nhttps://jobs.lever.co/beta/1a396119-0119-4000-8000-000000000119";
  assertEquals(careerAskCanon(`in sab ke liye apply kar do:\n${links}`), `apply to all of these:\n${links}`);
  assertEquals(careerAskCanon(`aplica a estos 2 por favor:\n${links}`), `apply to all of these:\n${links}`);
});

Deno.test("A: never an ask: replies to a card or a question, refusals, how-questions, the past, anything else", () => {
  for (const m of ["yes", "yes pls", "yep go", "yse send it", "haan", "haan, bhej do", "yes bhej do", "sí, envíala", "sí", "send 1", "send all",
    "show my applications", "what do you need from me", "how do I apply to Stripe?", "how do i aply to the Data Analyst role at Acme?",
    "don't apply to the Data Analyst role at Acme", "never apply to Acme pls", "I applied to the Data Analyst role at Acme",
    "mat apply karo Acme pe", "no apliques a Acme", "Leon", "Nasser", "leon.nasser@example.test", "Yes", "No",
    "email Maya at Stripe about the new grad program", "research Acme Bank and give me a file", "tailor my resume for the Data Analyst role at Acme"]) {
    assertEquals(careerAskCanon(m), null, m);
  }
  // Already in the shape code reads: nothing to change.
  for (const m of ["apply to the Data Analyst role at Acme", "find data analyst roles in Austin", "apply to all of these:\nhttps://boards.greenhouse.io/acme/jobs/1"]) {
    assertEquals(careerAskCanon(m), null, m);
  }
});

Deno.test("A: the handler routes by the reading and keeps the person's own words for the brain and the record", async () => {
  const src = await Deno.readTextFile(`${ROOT}/supabase/functions/agent-chat/handler-career.ts`);
  assert(/const typedMessage = message;\s*\n\s*message = careerAskCanon\(message\) \?\? message;/.test(src), "routing reads the canonical ask");
  assert(src.indexOf("const hashedMessage = message;") < src.indexOf("message = careerAskCanon(message)"), "the request hash is of what was typed");
  assert(/agentTurn\(\{ message: typedMessage,/.test(src), "the brain reads the person's own words");
});

Deno.test("C: a SmartRecruiters posting is keyed as the engine keys it and queued; formUrlFor stays the three board forms", () => {
  const url = "https://jobs.smartrecruiters.com/keystonebank/4100364";
  assertEquals(detectPortal(url), { family: "smartrecruiters", embedded: false });
  assertEquals(postingKey(url), "smartrecruiters:keystonebank:4100364");
  assertEquals(postingKey("https://jobs.smartrecruiters.com/Acme/743999912345678-data-analyst"), "smartrecruiters:Acme:743999912345678");
  assertEquals(postingKey("https://jobs.smartrecruiters.com/acme"), null, "a company page is not a posting");
  const r = wantsFrom([{ url, job_id: "smartrecruiters:keystonebank:4100364", company: "Keystone Bank", title: "Data Scientist" }], Date.parse("2026-11-08T12:00:00Z"));
  assertEquals([r.ok.length, r.refused.length], [1, 0]);
  assertEquals(formUrlFor("smartrecruiters:x:1"), null, "WO-078: a shelf posting's board form is Greenhouse, Lever or Ashby's");
  // Never LinkedIn or Indeed, whatever else changed.
  assertEquals(wantsFrom([{ url: "https://www.linkedin.com/jobs/view/123" }], 0).ok.length, 0);
});

Deno.test("C: the migration widens every cloud family list over the live definitions, regenerates the portal claim, and opens no gate", async () => {
  const sql = await Deno.readTextFile(`${ROOT}/supabase/migrations/20261108120000_career_apply_cloud_smartrecruiters.sql`);
  assert(/pg_get_functiondef\(p\.oid\)/.test(sql), "over the live definitions");
  assert(/career_apply_cloud_claim_portal_install\(\)/.test(sql), "the per-family claim is generated again");
  assert(/'greenhouse', 'lever', 'ashby', 'smartrecruiters'/.test(sql) && /''greenhouse'', ''lever'', ''ashby'', ''smartrecruiters''/.test(sql));
  assert(!/career_apply_cloud_open\(p_portal text\)[\s\S]*select true/.test(sql) && !/insert into public\.career_apply_cloud_gate_waivers/.test(sql), "no gate opened, no waiver written");
  assert(await Deno.stat(`${ROOT}/supabase/rollbacks/20261108120000_career_apply_cloud_smartrecruiters.down.sql`).then(() => true), "with its rollback");
});

Deno.test("D: the eval's 'find ... and apply to all of them' asks for every posting the search names, and no fewer", async () => {
  const { generate } = await import("../../evals/career/e2e/generate.ts");
  const g = generate();
  const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const CITIES = ["Chicago", "New York", "Austin", "Seattle", "Boston", "San Francisco", "Atlanta", "Denver"];
  for (const t of g.full.filter((x: any) => x.family === "apply.all")) {
    const q = String(Object.values(t.oracle)[0][0].args!.query), city = CITIES.find((c) => q.endsWith(` ${c}`))!;
    const said = words(q.slice(0, -city.length)).trim().split(" ");
    const titled = g.postings.filter((p: any) => p.location.startsWith(`${city},`) && said.every((w) => words(p.title).includes(` ${w} `)));
    assert(titled.length >= 1, t.id);
    assertEquals(t.expect.apply.min, titled.length, `${t.id}: at least every posting titled "${said.join(" ")}" in ${city}`);
    assert(t.expect.apply.max >= t.expect.apply.min, t.id);
  }
});

Deno.test("E: an applicant-tracking system's own sender is never the employer's person (adversarial A-ATSD-003/006/007)", async () => {
  const { checkAddress } = await import("../../supabase/functions/_shared/career_contacts.ts");
  const { automatedInbox } = await import("../../supabase/functions/_shared/automated_inbox.ts");
  const mx = async () => ({ status: "ok" as const, hosts: ["mx.example"] });
  for (const e of ["notifications@hire.lever.co", "no-reply@us.greenhouse-mail.io", "no-reply@ashbyhq.com", "jobs@smartrecruiters.com", "alerts@myworkday.com", "updates@lever.co"]) {
    assert(automatedInbox(e) !== null, e);
    assertEquals((await checkAddress(e, mx)).check.role, "flagged", e);
    assertEquals((await checkAddress(e, mx)).verified, false, e);
  }
  // A person at an employer is a person, and so is a person at the ATS company when that company is the employer.
  for (const [e, employer] of [["dana.lee@acme.io", "Acme"], ["maya.chen@lever.co", "Lever"]]) {
    assertEquals(automatedInbox(e, employer), null, e);
  }
  assertEquals((await checkAddress("dana.lee@acme.io", mx)).verified, true);
});

Deno.test("F: one application's own unhashable payload is not sent and never counts toward pausing the ATS for everyone", async () => {
  const { settle } = await import("../../workers/career-cloud/worker.ts");
  assertEquals(settle({ state: "not_submitted", reason: "INVALID_APPLY_PAYLOAD" }).outcome, "not_sent");
  // A failure the site can cause still counts.
  assertEquals(settle({ state: "not_submitted", reason: "FORM_DID_NOT_SETTLE" }).outcome, "error");
  assertEquals(settle({ state: "needs_user", reason: "captcha" }).outcome, "bot_check");
});

Deno.test("G: tailor then apply, as people text it, reads as the tailor-then-apply turn's own shape", async () => {
  const { tailorAndApplyOf } = await import("../../supabase/functions/_shared/career_compound_ask.ts");
  const cases: [string, string, string][] = [
    ["tailor and apply: Data Analyst at Vantage Freight", "Data Analyst", "Vantage Freight"],
    ["taillor and apply: Machine Learning Engineer, New Grad at Ironleaf Analytics thx", "Machine Learning Engineer, New Grad", "Ironleaf Analytics"],
    ["tailor my rseume for the Frontend Engineer roel at Granite Insurance and apply with it", "Frontend Engineer", "Granite Insurance"],
    ["ngl tailor my resume 4 the Software Engineer, New Grad role at Northgate Bio and apply with it lmk", "Software Engineer, New Grad", "Northgate Bio"],
    ["adapta mi currículum para FP&A Analyst en Hollow Oak Bank y aplica con él", "FP&A Analyst", "Hollow Oak Bank"],
    ["Upland Health ke Financial Analyst ke liye resume tailor karo aur apply kar do", "Financial Analyst", "Upland Health"],
  ];
  for (const [m, role, company] of cases) {
    const t = tailorAndApplyOf(careerAskCanon(m) ?? m);
    assertEquals(t && [t.role, t.company], [role, company], m);
  }
  // Tailoring alone is not an application.
  assertEquals(careerAskCanon("tailor my resume for the Data Analyst role at Acme"), null);
  assertEquals(careerAskCanon("tailr my resume for the Data Analyst role at Acme pls"), null);
});

Deno.test("H: a batch on ONE page (past one card's 1,600 characters, under a page) is pushed as one card of every application (e2e F-AP-096)", async () => {
  const { handlePrepareBridge, prepareToken } = await import("../../supabase/functions/_shared/cloud_prepare.ts");
  const { batchFor, cardFor } = await import("../../supabase/functions/_shared/career_apply_cards.ts");
  const SECRET = "TEST-r9-one-page-runner-secret-0123456789abcd", U = "7b0f8f8e-6a43-4a49-9d2c-0000000003a1";
  const RID = "aaaaaaaa-bbbb-4ccc-8ddd-0000000003f1", LEASE = "11111111-2222-4333-8444-0000000003f1";
  const prepared = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, company: `Employer ${n}`,
    card_lines: [`Employer ${n}`, `First Name: Alex`, `Last Name: Testcase`, `Email: alex.testcase@example.test`, `Phone: 312-555-0142`,
      `Are you legally authorized to work in the United States?: Yes`, `Resume: Alex_Resume.pdf (${"a".repeat(12)})`, `Sends to https://boards.greenhouse.io/employer${n}/jobs/${n}`], resume_sha256: "a".repeat(64) });
  const ready = Array.from({ length: 8 }, (_, i) => prepared(i + 1));
  const c = cardFor(ready), b = batchFor(ready);
  assert(c && "take" in c && c.take.length < 8, "one card text does not hold all eight");
  assert(b && !("tooLong" in b) && b.parts.length === 0 && b.take.length === 8, "the batch is one page: no paged card");
  const calls: { name: string; args: any }[] = [];
  const row = { id: RID, user_id: U, job_ids: ready.map((_, i) => `greenhouse:e${i + 1}:${i + 1}`), lease_token: LEASE, state: "running", claimed_at: new Date().toISOString() };
  const deps = { secret: SECRET, readRequest: async () => row, rpc: async (name: string, args: any) => {
    calls.push({ name, args });
    if (name === "career_apply_prepare_request_ready") return ready;
    if (name === "career_apply_questions_open_as" || name === "career_apply_prepare_candidates_for") return [];
    if (name === "career_apply_card_push_requested_for") return "c0000000-0000-4000-8000-000000000003";
    return { state: "done" };
  } };
  const r = await handlePrepareBridge("finish", { id: RID, sandbox: "sbx_1", token: await prepareToken(SECRET, RID, LEASE, "sbx_1"), outcomes: [] }, deps as any);
  assertEquals((r.body as any).push, "shown");
  const push = calls.find((x) => x.name === "career_apply_card_push_requested_for")!;
  assertEquals(push.args.p_ids, ready.map((p) => p.id), "every application on the one card");
  assert(push.args.p_text.length <= 4000, "one text");
  for (const p of ready) for (const l of p.card_lines) assert(push.args.p_text.includes(l), l);
  assert(!calls.some((x) => x.name === "career_apply_prepare_request_notice"), "no 'say show my applications' instead of the card");
});
