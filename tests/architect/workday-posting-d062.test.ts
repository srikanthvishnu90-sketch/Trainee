// D-062 (1) (owner, 2026-11-11: "your job is to know exactly what any job posting requires"): the read-only Workday posting
// reader (supabase/functions/_shared/workday_posting.ts), Workday in the posting re-check (C18, research_web.ts recheckPosting,
// link_check.ts), in the pasted-link intake (apply_here.ts), and "what does this posting require" (C11, inspect_apply_flow,
// _shared/posting_requirements.ts) on Workday, Greenhouse, Lever, Ashby and SmartRecruiters.
//
// $0 and no live network: every answer is a recorded copy of a real public page (tests/fixtures/posting-reads/, sources.json
// there says where and when each was recorded). The only shapes that are not recordings are the error answers of a removed Workday
// posting (HTTP 404, and the errorCode S22 body), marked SYNTHETIC below. Through the real handler (MP-W) with a scripted model.
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/workday-posting-d062.test.ts
import assertNode from "node:assert/strict";
import { readWorkdayPosting, searchWorkdayBoard, workdayUrl, parseWorkdayCxs, parseWorkdayPage } from "../../supabase/functions/_shared/workday_posting.ts";
import { readApplyFlow, READ_ONLY_BOUNDARY, requirementsFrom, ASHBY_FORM_QUERY } from "../../supabase/functions/_shared/posting_requirements.ts";
import { postingJobId, recheckPosting } from "../../supabase/functions/_shared/research_web.ts";
import { linkChecker } from "../../supabase/functions/_shared/link_check.ts";
import { applyHereTurn } from "../../supabase/functions/_shared/apply_here.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { canRun } from "./helpers/response_world.ts";
import { effectRows, runConversation, type SeedPosting, type Step, TURNS } from "./helpers/mirror_process.ts";
import { POSTING_PAGE } from "./helpers/posting_checks.ts";
import { judgeDraft } from "./support-test-judge-c.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const FX = new URL("../fixtures/posting-reads/", import.meta.url);
const fx = (f: string) => Deno.readTextFileSync(new URL(f, FX));

// The benchmark's posting (evals/mirror/instinct-wa-batch1/): its page is on Workday. Recorded here (W8); on the handler (MP-W (a))
// it is read with the network refused, so the result does not depend on the date the test runs (its end date is 2026-12-07).
const PAYPAL_WD = "https://paypal.wd1.myworkdayjobs.com/en-US/jobs/job/Software-Engineer-Intern---Summer-2027_R0138586";
const PAYPAL_CXS = "https://paypal.wd1.myworkdayjobs.com/wday/cxs/paypal/jobs/job/Software-Engineer-Intern---Summer-2027_R0138586";
// Recorded Workday postings (real public CXS answers; sources.json).
const NVIDIA = "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-Remote/Software-Engineer--OpenShell_JR2020825";
const NVIDIA_CXS = "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-Remote/Software-Engineer--OpenShell_JR2020825";
const RBC = "https://rbc.wd3.myworkdayjobs.com/en-US/RBCGLOBAL1/job/TORONTO-Ontario-Canada/Lead-Software-Developer_R-0000187445-1";
const RBC_CXS = "https://rbc.wd3.myworkdayjobs.com/wday/cxs/rbc/RBCGLOBAL1/job/TORONTO-Ontario-Canada/Lead-Software-Developer_R-0000187445-1";
const FLY = "https://flywire.wd108.myworkdayjobs.com/flywirecareers/job/Bangalore-India/Relationship-Associate--Agent-Partnerships_JR-1070";
const FLY_CXS = "https://flywire.wd108.myworkdayjobs.com/wday/cxs/flywire/flywirecareers/job/Bangalore-India/Relationship-Associate--Agent-Partnerships_JR-1070";
const NOV11 = Date.parse("2026-11-11T12:00:00Z"), NOV20 = Date.parse("2026-11-20T12:00:00Z");

// The recorded pages, by the exact request (method and address). Anything else: refused (a TypeError, as with no network).
const RECORDED: Record<string, () => Response> = {
  [`GET ${NVIDIA_CXS}`]: () => new Response(fx("workday-nvidia-JR2020825.cxs.json"), { headers: { "content-type": "application/json" } }),
  [`GET ${RBC_CXS}`]: () => new Response(fx("workday-rbc-R-0000187445-1.cxs.json"), { headers: { "content-type": "application/json" } }),
  [`GET ${FLY}`]: () => new Response(fx("workday-flywire-JR-1070.page.html"), { headers: { "content-type": "text/html" } }),
  "GET https://boards-api.greenhouse.io/v1/boards/stripe/jobs/8194287?questions=true": () => new Response(fx("greenhouse-stripe-8194287.questions.json"), { headers: { "content-type": "application/json" } }),
  "GET https://api.lever.co/v0/postings/palantir/0ccbe620-a3ef-41d1-a5c4-68e56b3c91d0": () => new Response(fx("lever-palantir-0ccbe620.posting.json"), { headers: { "content-type": "application/json" } }),
  "GET https://jobs.lever.co/palantir/0ccbe620-a3ef-41d1-a5c4-68e56b3c91d0/apply": () => new Response(fx("lever-palantir-0ccbe620.apply.html"), { headers: { "content-type": "text/html" } }),
  "GET https://jobs.ashbyhq.com/openai/240d459b-696d-43eb-8497-fab3e56ecd9b": () => new Response(fx("ashby-openai-240d459b.page.html"), { headers: { "content-type": "text/html" } }),
  "POST https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting": () => new Response(fx("ashby-openai-240d459b.graphql.json"), { headers: { "content-type": "application/json" } }),
  "GET https://api.smartrecruiters.com/v1/companies/ServiceNow/postings/744000161158559": () => new Response(fx("smartrecruiters-servicenow-744000161158559.posting.json"), { headers: { "content-type": "application/json" } }),
};
function recorded(extra: Record<string, () => Response> = {}) {
  const sent: { method: string; url: string; body: string }[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    sent.push({ method: req.method, url: req.url, body: req.method === "GET" ? "" : await req.clone().text() });
    const hit = extra[`${req.method} ${req.url}`] ?? RECORDED[`${req.method} ${req.url}`];
    if (!hit) throw new TypeError(`network refused: ${req.url}`);
    return hit();
  };
  return { f: f as typeof fetch, sent };
}
// SYNTHETIC (not recordings): a removed Workday posting. Workday's CXS answers errorCode S22 ("unpublished") with HTTP 403 for a
// posting that was taken down, and S21 for one that never existed (third-party notes, sources.json); a 404 is the plain HTTP form.
const S22 = () => Response.json({ errorCode: "S22", httpStatus: 403, message: "unpublished" }, { status: 403 });
const NOT_FOUND = () => new Response("not found", { status: 404 });
// No request may ever go to an application step, a sign-in, an upload or a submission.
const NEVER = /\/apply\b(?!\?)|applyManually|autofillWithResume|signin|sign-in|login|createAccount|\/upload|submit|ApiSubmit/i;
const neverWrites = (sent: { method: string; url: string; body: string }[]) => {
  for (const r of sent) {
    ok(!NEVER.test(r.url.replace("jobs.lever.co/palantir/0ccbe620-a3ef-41d1-a5c4-68e56b3c91d0/apply", "")), `no application step: ${r.method} ${r.url}`);
    if (r.method !== "GET") {
      // The one non-GET read: Ashby's read-only form query, exactly the fixed query (no mutation).
      eq(r.url, "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", `${r.method} ${r.url}`);
      const b = JSON.parse(r.body);
      eq([b.operationName, b.query], ["ApiJobPosting", ASHBY_FORM_QUERY]);
      ok(!/mutation/i.test(b.query));
    }
  }
};

Deno.test("D-062/W1 a public Workday posting link names its CXS endpoint; anything else is not a Workday posting", () => {
  const p = workdayUrl(PAYPAL_WD)!;
  eq([p.host, p.tenant, p.site, p.cxs, p.page], ["paypal.wd1.myworkdayjobs.com", "paypal", "jobs", PAYPAL_CXS, "https://paypal.wd1.myworkdayjobs.com/jobs/job/Software-Engineer-Intern---Summer-2027_R0138586"]);
  // An application step names the posting before "apply"; the step itself is never requested.
  eq(workdayUrl(`${RBC}/apply/applyManually`)?.cxs, RBC_CXS);
  eq(workdayUrl(NVIDIA)?.cxs, NVIDIA_CXS);
  eq(workdayUrl("https://wd3.myworkdaysite.com/en-US/recruiting/acme/External/job/Austin-TX/Associate_R1")?.cxs, "https://wd3.myworkdaysite.com/wday/cxs/acme/External/job/Austin-TX/Associate_R1");
  for (const u of ["https://paypal.wd1.myworkdayjobs.com/en-US/jobs", "https://wd5.myworkday.com/paypal/d/home.htmld", "http://paypal.wd1.myworkdayjobs.com/jobs/job/x_R1", "https://evil.example.com/jobs/job/x", "https://paypal.wd1.myworkdayjobs.com/jobs/job/..%2F..%2Fx"])
    eq(workdayUrl(u), null, u);
  eq(postingJobId(PAYPAL_WD), { id: "workday:paypal.wd1.myworkdayjobs.com:Software-Engineer-Intern---Summer-2027_R0138586", board: "Workday" });
  ok(POSTING_PAGE.test(PAYPAL_CXS) && !POSTING_PAGE.test("https://paypal.wd1.myworkdayjobs.com/wday/cxs/paypal/jobs/jobs"), "a posting's CXS endpoint is its own page; the board listing is not");
});

Deno.test("D-062/W2 the recorded CXS answers read: title, place, pay as stated, requirements, the deadline only when stated", () => {
  const n = parseWorkdayCxs(JSON.parse(fx("workday-nvidia-JR2020825.cxs.json")), NVIDIA)!;
  eq([n.title, n.company, n.location, n.pay, n.deadline, n.can_apply, n.questionnaire], ["Software Engineer, OpenShell", "NVIDIA USA", "US, Remote", "184,000 USD - 287,500 USD", null, true, true]);
  const r = parseWorkdayCxs(JSON.parse(fx("workday-rbc-R-0000187445-1.cxs.json")), RBC)!;
  eq([r.title, r.company, r.deadline, r.deadline_text, r.pay], ["Lead Software Developer", "Royal Bank of Canada", "2026-11-13", "End Date: November 13, 2026; 15 days left to apply", null]);
  const req = requirementsFrom(r.description_html);
  ok(req.required.includes("University or College Degree in Computer Science or a related field") && req.required[0].startsWith("Minimum 7 years of overall development experience in .NET"), JSON.stringify(req.required));
  ok(req.preferred.includes("Experience with cloud-based software development, specifically on Kubernetes.") && !req.preferred.some((l) => /Total Rewards/.test(l)), JSON.stringify(req.preferred));
  eq(requirementsFrom(n.description_html).required[0], "8+ years of professional practical experience in research engineering, software development, or a related technical field");
  // The public page (JSON-LD) carries the details but can never say open: it is the same shell for a removed posting.
  const page = parseWorkdayPage(fx("workday-flywire-JR-1070.page.html"), FLY)!;
  eq([page.source, page.title, page.posted, page.can_apply], ["page", "Relationship Associate, Agent Partnerships", "2026-10-14", null]);
  eq(parseWorkdayCxs({ errorCode: "S22" }, FLY), null);
});

Deno.test("D-062/W3 open, closed and unknown: never open unless the posting's own data says so; GETs of that posting only", async () => {
  const at = (now: number, extra = {}) => { const r = recorded(extra); return { r, d: { fetch: r.f, now: () => now } }; };
  let { r, d } = at(NOV11);
  const open = (await readWorkdayPosting(NVIDIA, d))!;
  eq([open.state, open.posting?.title, open.reads], ["open", "Software Engineer, OpenShell", [`GET ${NVIDIA_CXS}`]]);
  ({ r, d } = at(NOV11));
  eq((await readWorkdayPosting(RBC, d))!.state, "open", "before its stated end date");
  ({ r, d } = at(NOV20));
  const past = (await readWorkdayPosting(RBC, d))!;
  eq([past.state, past.why], ["closed", "its stated end date (2026-11-13) has passed"]);
  ({ r, d } = at(NOV11, { [`GET ${PAYPAL_CXS}`]: S22 }));
  const gone = (await readWorkdayPosting(PAYPAL_WD, d))!;
  eq([gone.state, gone.reads], ["closed", [`GET ${PAYPAL_CXS}`]]);
  ({ r, d } = at(NOV11, { [`GET ${PAYPAL_CXS}`]: NOT_FOUND }));
  eq((await readWorkdayPosting(PAYPAL_WD, d))!.state, "closed");
  // The CXS read fails: the public page gives the details, and the state stays unknown.
  ({ r, d } = at(NOV11, { [`GET ${FLY_CXS}`]: () => new Response("busy", { status: 503 }) }));
  const fb = (await readWorkdayPosting(FLY, d))!;
  eq([fb.state, fb.posting?.source, fb.posting?.title, fb.reads], ["unknown", "page", "Relationship Associate, Agent Partnerships", [`GET ${FLY_CXS}`, `GET ${FLY}`]]);
  // Nothing answers (this environment's proxy refuses *.myworkdayjobs.com): unknown, two reads, never a guess.
  ({ r, d } = at(NOV11));
  const none = (await readWorkdayPosting(PAYPAL_WD, d))!;
  eq([none.state, none.posting, r.sent.map((x) => `${x.method} ${x.url}`)], ["unknown", null, [`GET ${PAYPAL_CXS}`, "GET https://paypal.wd1.myworkdayjobs.com/jobs/job/Software-Engineer-Intern---Summer-2027_R0138586"]]);
  neverWrites(r.sent);
  // The search's link check (link_check.ts) asks the same CXS endpoint, never the page shell.
  const lc = recorded({ [`GET ${PAYPAL_CXS}`]: S22 });
  const check = linkChecker(lc.f);
  eq([await check({ url: NVIDIA }), await check({ url: PAYPAL_WD }), await check({ url: FLY })], ["live", "dead", "unknown"]);
  eq(lc.sent.map((x) => x.url), [NVIDIA_CXS, PAYPAL_CXS, FLY_CXS]);
});

Deno.test("D-062/W4 C18 on Workday: check_posting_open reads it live, with the deadline the posting states; nothing applied", async () => {
  const r = recorded();
  const tools = careerTools({ postings: async () => [], postingRecheck: (url: string) => recheckPosting(url, linkChecker(r.f), () => NOV11, { workday: (u: string) => readWorkdayPosting(u, { fetch: r.f, now: () => NOV11 }) }) } as any);
  const tool = tools.find((t) => t.name === "check_posting_open")!;
  ok(/Workday/.test(tool.description), tool.description);
  const out: any = await tool.run({ url: RBC }, {} as any);
  eq([out.state, out.board, out.deadline, out.title], ["open", "Workday", "2026-11-13", "Lead Software Developer"]);
  ok(/still open/.test(out.note) && /End Date: November 13, 2026/.test(out.note) && /nothing was applied for/.test(out.note), out.note);
  const unread: any = await tool.run({ url: PAYPAL_WD }, {} as any);
  eq(unread.state, "unknown");
  ok(/did not finish/.test(unread.note) && /Do not guess/.test(unread.note), unread.note);
  neverWrites(r.sent);
});

Deno.test("D-062/W5 what a posting requires, per board, from public pages only: questions read where public, named where not", async () => {
  const r = recorded();
  const read = (u: string) => readApplyFlow(u, { fetch: r.f, now: () => NOV11 });
  // Greenhouse: every question of the form from the public posting API.
  const gh = await read("https://job-boards.greenhouse.io/stripe/jobs/8194287");
  eq([gh.status, gh.board, gh.questions_read, gh.posting?.title, gh.sign_in_required], ["ok", "Greenhouse", "read", "Data Analyst, Intern", false]);
  eq(gh.questions!.length, 21);
  ok(gh.questions!.some((q) => q.label === "When do you expect to complete your degree?" && q.required), "a required question");
  ok(gh.questions!.some((q) => q.label === "Are you currently eligible to work in Canada?" && q.options?.length === 2), "its options");
  ok(gh.requirements.required.includes("Experience with SQL") && gh.requirements.preferred.includes("Experience writing and debugging data pipelines"), JSON.stringify(gh.requirements));
  // Lever: the posting API, then the public apply page's questions (its captcha recorded, never touched).
  const lv = await read("https://jobs.lever.co/palantir/0ccbe620-a3ef-41d1-a5c4-68e56b3c91d0");
  eq([lv.board, lv.questions_read, lv.captcha_expected, lv.questions!.length], ["Lever", "read", true, 18]);
  ok(lv.questions!.some((q) => /^Tell us your story/.test(q.label) && q.required && q.type === "long text"), JSON.stringify(lv.questions));
  ok(lv.requirements.required.includes("2+ years of hands-on work experience in a technical setting or engaging in on-the-job technical processes"), JSON.stringify(lv.requirements));
  // Ashby: the posting page, then the one read-only form query the page itself makes.
  const ab = await read("https://jobs.ashbyhq.com/openai/240d459b-696d-43eb-8497-fab3e56ecd9b");
  eq([ab.board, ab.questions_read, ab.posting?.pay, ab.questions!.length], ["Ashby", "read", "$250K - $445K", 21]);
  ok(ab.questions!.some((q) => q.label === "Are you authorized to work lawfully in the US?" && q.required), JSON.stringify(ab.questions));
  eq(ab.requirements.required, ["Have strong programming skills", "Have experience working in large distributed systems", "Be excited about OpenAI’s approach to research"]);
  // SmartRecruiters: the posting; its questions are not public, said so.
  const sr = await read("https://jobs.smartrecruiters.com/ServiceNow/744000161158559-senior-staff-software-engineer");
  eq([sr.board, sr.questions_read, sr.questions, sr.posting?.pay], ["SmartRecruiters", "not_public", null, "$201,300 - $352,300"]);
  // Workday: the posting from its CXS data; the questions are behind the person's own sign-in, named, never guessed.
  const wd = await read(RBC);
  eq([wd.board, wd.status, wd.posting?.state, wd.posting?.deadline, wd.questions, wd.questions_read, wd.sign_in_required], ["Workday", "ok", "open", "2026-11-13", null, "behind_sign_in", true]);
  ok(/only after the person signs in/.test(wd.questions_why) && /not known/.test(wd.questions_why), wd.questions_why);
  ok(wd.entry.some((s) => /the person does this themselves/.test(s)), JSON.stringify(wd.entry));
  // Everything a read returns says it created nothing; never LinkedIn, Indeed or a host Trainee does not read.
  for (const x of [gh, lv, ab, sr, wd]) eq(x.boundary, READ_ONLY_BOUNDARY);
  eq((await read("https://www.linkedin.com/jobs/view/123")).status, "not_readable");
  eq((await read("https://careers.example.com/jobs/1")).status, "not_readable");
  eq(r.sent.map((x) => `${x.method} ${x.url}`), [
    "GET https://boards-api.greenhouse.io/v1/boards/stripe/jobs/8194287?questions=true",
    "GET https://api.lever.co/v0/postings/palantir/0ccbe620-a3ef-41d1-a5c4-68e56b3c91d0", "GET https://jobs.lever.co/palantir/0ccbe620-a3ef-41d1-a5c4-68e56b3c91d0/apply",
    "GET https://jobs.ashbyhq.com/openai/240d459b-696d-43eb-8497-fab3e56ecd9b", "POST https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting",
    "GET https://api.smartrecruiters.com/v1/companies/ServiceNow/postings/744000161158559",
    `GET ${RBC_CXS}`,
  ], "exactly these reads, nothing for LinkedIn or an unread host");
  neverWrites(r.sent);
});

Deno.test("D-062/W6 a pasted Workday link: the posting is read and named; applying is the person's own sign-in; nothing set up", async () => {
  const r = recorded();
  const out = await applyHereTurn({ message: `apply here ${RBC}`, now: NOV11, db: { get: async () => null, put: async () => { throw new Error("nothing is stored"); } } as any,
    fetchFeed: async () => { throw new Error("no board listing is read"); }, apps: async () => [], facts: [], readWorkday: (u) => readWorkdayPosting(u, { fetch: r.f, now: () => NOV11 }) });
  eq([out?.status, out?.hits], ["refused", []]);
  ok(/Lead Software Developer at Royal Bank of Canada \(open, applications close 2026-11-13\): a Workday application needs your own sign-in/.test(out!.reply), out!.reply);
  eq(r.sent.map((x) => x.url), [RBC_CXS]);
});

Deno.test("D-062/W7 Workday discovery: the tenant's public search, paced, capped, stopped by a 429; read-only body", async () => {
  const pages = [0, 1, 2].map((p) => ({ total: 45, jobPostings: Array.from({ length: p < 2 ? 20 : 5 }, (_, i) => ({ title: `Role ${p * 20 + i}`, externalPath: `/job/Remote/Role_R${p * 20 + i}`, locationsText: "Remote", postedOn: "Posted Today", bulletFields: [`R${p * 20 + i}`] })) }));
  const slept: number[] = [], bodies: any[] = [];
  const f = (async (_u: string, init: RequestInit) => { const b = JSON.parse(String(init.body)); bodies.push(b); return Response.json(pages[b.offset / 20]); }) as any;
  const r = await searchWorkdayBoard({ host: "acme.wd5.myworkdayjobs.com", tenant: "acme", site: "External", text: "software intern", fetch: f, sleep: async (ms) => { slept.push(ms); } });
  eq([r.postings.length, r.total, r.complete, r.stopped, slept], [45, 45, true, null, [1500, 1500]]);
  eq(bodies.map((b) => Object.keys(b).sort()), Array(3).fill(["appliedFacets", "limit", "offset", "searchText"]));
  eq(r.reads, Array(3).fill("POST https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs"));
  const limited = await searchWorkdayBoard({ host: "acme.wd5.myworkdayjobs.com", tenant: "acme", site: "External", fetch: (async () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } })) as any, sleep: async () => {} });
  eq([limited.postings.length, limited.stopped, limited.retry_after_s, limited.reads.length], [0, "HTTP 429", 30, 1]);
});

// The benchmark's own posting, recorded HERE once the environment allowed paypal.wd1.myworkdayjobs.com (2026-11-11 22:26 UTC,
// sources.json): the CXS job answer and the first page of the tenant's search for "intern".
const PAYPAL_PAGE = "https://paypal.wd1.myworkdayjobs.com/jobs/job/Software-Engineer-Intern---Summer-2027_R0138586";
const PAYPAL_REC = { [`GET ${PAYPAL_CXS}`]: () => new Response(fx("workday-paypal-R0138586.cxs.json"), { headers: { "content-type": "application/json" } }) };
Deno.test("D-062/W8 the benchmark's PayPal posting, recorded here: open, its stated deadline, pay as stated, requirements; questions behind sign-in", async () => {
  const r = recorded(PAYPAL_REC);
  const w = (await readWorkdayPosting(PAYPAL_WD, { fetch: r.f, now: () => NOV11 }))!;
  eq([w.state, w.posting?.title, w.posting?.req_id, w.posting?.deadline, w.posting?.deadline_text, w.posting?.can_apply, w.posting?.questionnaire],
    ["open", "Software Engineer Intern - Summer 2027", "R0138586", "2026-12-07", "Applications will be accepted through Sunday, December 6th, 2026", true, true]);
  // The posting states a range per place: the first (its primary place, San Jose) is `pay`; each place's range is in `pays`.
  eq(w.posting?.pay, "$32 - $55 Hourly");
  ok(w.posting!.pays.some((x) => x.place === "Chicago, Illinois" && x.pay === "$28- $49 Hourly"), `Chicago's range as the posting states it: ${JSON.stringify(w.posting!.pays)}`);
  ok(w.posting!.locations.includes("Chicago, Illinois, United States of America"), JSON.stringify(w.posting!.locations));
  const req = requirementsFrom(w.posting!.description_html).required;
  ok(req.includes("Must be returning to school in Fall 2027.") && req.includes("Must be legally authorized to work in the U.S. without sponsorship."), JSON.stringify(req));
  eq(w.reads, [`GET ${PAYPAL_CXS}`]);
  // After the stated end date it is closed, by the posting's own data.
  eq((await readWorkdayPosting(PAYPAL_WD, { fetch: recorded(PAYPAL_REC).f, now: () => Date.parse("2026-12-08T12:00:00Z") }))!.state, "closed");
  // C18: the re-check gives the posting's own deadline words.
  const tool = careerTools({ postings: async () => [], postingRecheck: (url: string) => recheckPosting(url, linkChecker(r.f), () => NOV11, { workday: (u: string) => readWorkdayPosting(u, { fetch: r.f, now: () => NOV11 }) }) } as any).find((t) => t.name === "check_posting_open")!;
  const g: any = await tool.run({ url: PAYPAL_WD }, {} as any);
  ok(g.state === "open" && /Applications will be accepted through Sunday, December 6th, 2026/.test(g.note), g.note);
  // C11: requirements read, questions behind the person's own sign-in.
  const a = await readApplyFlow(PAYPAL_WD, { fetch: r.f, now: () => NOV11 });
  eq([a.board, a.posting?.state, a.questions_read, a.sign_in_required], ["Workday", "open", "behind_sign_in", true]);
  ok(a.posting?.pay_by_place?.some((x) => x.place === "Chicago, Illinois"), JSON.stringify(a.posting));
  ok(/this posting has employer questions of its own/.test(a.questions_why), a.questions_why);
  neverWrites(r.sent);
  // Discovery: one page of the tenant's search (recorded), read-only, the total as Workday states it.
  const s = await searchWorkdayBoard({ host: "paypal.wd1.myworkdayjobs.com", tenant: "paypal", site: "jobs", text: "intern", maxPages: 1,
    fetch: (async () => new Response(fx("workday-paypal-search-intern.page0.json"), { headers: { "content-type": "application/json" } })) as any, sleep: async () => {} });
  eq([s.postings.length, s.total, s.complete, s.reads], [20, 193, false, ["POST https://paypal.wd1.myworkdayjobs.com/wday/cxs/paypal/jobs/jobs"]]);
  ok(s.postings.every((x) => x.url.startsWith("https://paypal.wd1.myworkdayjobs.com/jobs/job/")), JSON.stringify(s.postings[0]));
  eq(PAYPAL_PAGE, workdayUrl(PAYPAL_WD)!.page);
});

// ------------------------------------------------------------------------------------------------ through the real handler
// MP-W: C11 and C18 on Workday, through the real career handler at $0 under production's flags (helpers/mirror_process.ts).
//   (a) the benchmark's own turns (C3, C11, C18) with "that paypal internship" seeded as the benchmark's Workday posting, every
//       host refused (no recording of PayPal's page exists): the reads are attempted on that posting's own page, and what was not
//       read is said to be not known, never guessed.
//   (b) a recorded Workday posting (NVIDIA's, its real CXS answer served from tests/fixtures/), named by the person: re-checked
//       open on its own CXS data, its requirements and pay read, its questions named as behind sign-in.
const PAYPAL_SEED: SeedPosting = { id: "workday:paypal.wd1/jobs:Software-Engineer-Intern---Summer-2027_R0138586", provider: "workday", board: "paypal.wd1/jobs", company: "PayPal",
  title: "Software Engineer Intern", location: "Chicago, IL", url: PAYPAL_WD, description: "Summer 2027 software engineering internship." };
const SCRIPT_A: Record<string, Step[]> = {
  C11: [{ tool: "inspect_apply_flow", input: { job_id: PAYPAL_SEED.id } }, { text: `To submit it I'd need your approval of the final resume, the email and phone to use, and you signing in to PayPal's careers site yourself; its application questions are behind that sign-in, so I don't know them yet. I only read the public pages: no account, saved application or submission was created.\n${PAYPAL_WD}` }],
  C18: [{ tool: "check_posting_open", input: { url: PAYPAL_WD } }, { text: `I couldn't finish the check on PayPal's Workday page just now, so I can't call it open. Nothing was applied for.\n${PAYPAL_WD}` }],
};
// The person names the posting (the scripted brain passes its link and id; that the brain is handed the posting the conversation
// listed is asserted in (a)). A Workday link pasted into the message itself is read by code's router as a search ask today (the
// words in its path, "US-Remote/Software-Engineer--..."), before the brain: that routing is outside this change (reported).
const NVIDIA_SEED: SeedPosting = { id: "workday:nvidia.wd5/nvidiaexternalcareersite:Software-Engineer--OpenShell_JR2020825", provider: "workday", board: "nvidia.wd5/NVIDIAExternalCareerSite", company: "NVIDIA",
  title: "Software Engineer, OpenShell", location: "Remote, US", url: NVIDIA, description: "Software engineer, AI agent runtime infrastructure. Remote." };
const W_TURNS = [
  { id: "W18", prompt: "is that nvidia openshell posting still open? check rn" },
  { id: "W11", prompt: "what would you need from me to actually submit that nvidia application? don't apply yet just wanna know" },
];
const SCRIPT_B: Record<string, Step[]> = {
  W18: [{ tool: "check_posting_open", input: { url: NVIDIA } }, { text: `Checked on NVIDIA's Workday page just now: it's still open. Nothing was applied for.\n${NVIDIA}` }],
  W11: [{ tool: "inspect_apply_flow", input: { job_id: NVIDIA_SEED.id } }, { text: `It asks for 8+ years of research engineering or software experience and an MS/PhD or equivalent; pay is listed as 184,000 USD - 287,500 USD. You'd sign in to NVIDIA's careers site yourself; its questions are behind that sign-in. I only read the public pages: no account, saved application or submission was created.\n${NVIDIA}` }],
};
const served = (req: Request) => { const hit = RECORDED[`${req.method} ${req.url}`]; return hit ? hit() : null; };

Deno.test({ name: "D-062/MP-W C11 and C18 on Workday through the real handler: read only, the posting's own pages, nothing created", sanitizeOps: false, sanitizeResources: false, ignore: canRun() !== null && canRun() !== "FAIL", fn: async () => {
  if (canRun() === "FAIL") throw new Error("MP-W needs Postgres 16 in CI");
  // (a) the benchmark's turns, network refused.
  {
    const { seen, world, person, close } = await runConversation(SCRIPT_A, { only: ["C3", "C11", "C18"], posting: PAYPAL_SEED });
    try {
      ok(TURNS.some((t) => t.id === "C11") && TURNS.some((t) => t.id === "C18"));
      ok(seen.C3.reply.includes(PAYPAL_WD), `C3 lists the Workday posting: ${seen.C3.reply.slice(0, 300)}`);
      eq(seen.C3.outbound.filter((o) => /myworkdayjobs/.test(o)), [`GET ${PAYPAL_CXS}`], "C3 re-checks it on its own CXS endpoint, never the page shell");
      const c18 = seen.C18, g = JSON.parse(c18.calls[0]?.result || "{}");
      ok(/THE POSTING THEY MEAN/.test(c18.system) && c18.system.includes(PAYPAL_WD), "C18: the posting the conversation listed");
      eq([g.board, g.state], ["Workday", "unknown"], JSON.stringify(g));
      ok(/Do not guess/.test(g.note), g.note);
      eq(c18.outbound, [`GET ${PAYPAL_CXS}`, "GET https://paypal.wd1.myworkdayjobs.com/jobs/job/Software-Engineer-Intern---Summer-2027_R0138586"], "C18: that posting's own data, then its page");
      ok(!/\bstill open\b|\bis open\b/i.test(c18.reply) && /Nothing was applied for/.test(c18.reply), c18.reply);
      const c11 = seen.C11, a = JSON.parse(c11.calls[0]?.result || "{}");
      ok(c11.tools.includes("inspect_apply_flow"), "C11 offers the read-only apply-flow reader");
      ok(/THE POSTING THEY MEAN/.test(c11.system) && c11.system.includes(PAYPAL_WD), "C11: the posting the conversation listed");
      eq([a.board, a.questions_read, a.questions, a.sign_in_required, a.boundary], ["Workday", "behind_sign_in", null, true, READ_ONLY_BOUNDARY], JSON.stringify(a).slice(0, 400));
      ok(/never guess the questions/.test(a.note) && /own sign-in/.test(a.note) && /no account, saved application or submission was created/.test(a.note), a.note);
      eq(c11.outbound, [`GET ${PAYPAL_CXS}`, "GET https://paypal.wd1.myworkdayjobs.com/jobs/job/Software-Engineer-Intern---Summer-2027_R0138586"], "C11: that posting's own data, then its page; never an application step");
      ok(/no account, saved application or submission was created/.test(c11.reply), "C11 boundary kept");
      for (const [t, n] of Object.entries(await effectRows(world, person.id))) eq(n, 0, `${t} has rows`);
    } finally { await close(); }
  }
  // (b) a recorded Workday posting, pasted.
  {
    // Architect amendment (owner decision 2026-11-13: research support check switched on): the reply's sentences are checked by the
    // support judge, a model call with no tools; the harness answers it by the page truth (support-test-judge-c.ts judgeDraft).
    const { seen, world, person, close } = await runConversation(SCRIPT_B, { turns: W_TURNS, posting: NVIDIA_SEED, serve: served, draft: (sys, user) => judgeDraft(sys, user) });
    try {
      const w18 = seen.W18, g = JSON.parse(w18.calls[0]?.result || "{}");
      ok(!w18.code && w18.tools.includes("check_posting_open"), `W18 reached the brain with the re-check: ${w18.reply.slice(0, 200)}`);
      eq([g.board, g.state, g.title], ["Workday", "open", "Software Engineer, OpenShell"], JSON.stringify(g));
      eq(w18.outbound, [`GET ${NVIDIA_CXS}`], "W18: one read, the posting's own CXS data");
      ok(w18.reply.includes(NVIDIA) && /Nothing was applied for/.test(w18.reply), w18.reply);
      const w11 = seen.W11, a = JSON.parse(w11.calls[0]?.result || "{}");
      ok(!w11.code && w11.tools.includes("inspect_apply_flow"), `W11 reached the brain: ${w11.reply.slice(0, 200)}`);
      eq([a.board, a.status, a.posting?.state, a.posting?.pay, a.questions_read, a.sign_in_required], ["Workday", "ok", "open", "184,000 USD - 287,500 USD", "behind_sign_in", true]);
      ok(a.requirements.required.includes("MS/PhD in Computer Science, Physics, or a related field or equivalent experience"), JSON.stringify(a.requirements));
      ok(/Give its requirements in its own words/.test(a.note), a.note);
      eq(w11.outbound, [`GET ${NVIDIA_CXS}`], "W11: one read");
      ok(/no account, saved application or submission was created/.test(w11.reply), "W11 boundary kept");
      for (const [t, n] of Object.entries(await effectRows(world, person.id))) eq(n, 0, `${t} has rows`);
    } finally { await close(); }
  }
} });
