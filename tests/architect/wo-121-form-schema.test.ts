// WO-121 (D-042 M4): a posting's application form read once, at ingest, from the ATS's public read (Greenhouse's job
// board API ?questions=true; Lever's server-rendered /apply page; Ashby's job page read, only with the owner's yes), with no
// browser, normalised to field ids, labels, types, required flags and options. SmartRecruiters (key required) and Workday
// (applicant sign-in) are recorded unread with their reason, never guessed. LinkedIn, Indeed and Handshake are never
// requested. PENDING: the module does not exist yet. DRAFT (2026-11-06): not run; no reference implementation proved it.
import assertNode from "node:assert/strict";
import {
  type FormSchema, formRequestFor, parseAshbyPosting, parseGreenhouseForm, parseLeverApplyHtml, readForm,
} from "../../supabase/functions/_shared/posting_schema.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const FORMS = `${ROOT}/tests/fixtures/forms-ci`;
const CAPTURES = `${ROOT}/tests/fixtures/form-schema`;
const NOW = Date.UTC(2026, 10, 7, 12);

// The documented shape of GET /v1/boards/{board}/jobs/{id}?questions=true (the one posting_schema.ts already reads), cut down.
const GH = {
  id: 4802172007, title: "TEST Data Analyst",
  questions: [
    { label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text", values: [] }] },
    { label: "Email", required: true, fields: [{ name: "email", type: "input_text", values: [] }] },
    { label: "Resume/CV", required: true, fields: [{ name: "resume", type: "input_file", values: [] }, { name: "resume_text", type: "textarea", values: [] }] },
    { label: "Cover Letter", required: false, fields: [{ name: "cover_letter", type: "input_file", values: [] }, { name: "cover_letter_text", type: "textarea", values: [] }] },
    { label: "Will you now or in the future require sponsorship?", required: true,
      fields: [{ name: "question_111", type: "multi_value_single_select", values: [{ label: "Yes", value: 1 }, { label: "No", value: 0 }] }] },
    { label: "Why do you want to work here?", required: false, fields: [{ name: "question_112", type: "textarea", values: [] }] },
  ],
  location_questions: [{ label: "Location (City)", required: true, fields: [{ name: "location", type: "input_text", values: [] }] }],
  compliance: [{ type: "eeoc", description: "", questions: [
    { label: "Gender", required: false, fields: [{ name: "gender", type: "multi_value_single_select", values: [{ label: "Male", value: 1 }, { label: "Female", value: 2 }, { label: "Decline To Self Identify", value: 3 }] }] },
  ] }],
  demographic_questions: null,
};

Deno.test("WO-121/1 Greenhouse: one field per field, required and options as published; a _text companion is never required; sections", () => {
  const s = parseGreenhouseForm(GH);
  assert(s, "parsed");
  eq(s!.source, "greenhouse_boards_api");
  const by = new Map(s!.fields.map((f) => [f.id, f]));
  eq(by.get("first_name")?.required, true);
  eq(by.get("resume")?.type, "file");
  eq(by.get("resume_text")?.required, false, "the paste box beside a required upload is not itself required (WO-075)");
  eq(by.get("question_111")?.type, "select");
  eq(by.get("question_111")?.options, [{ label: "Yes", value: "1" }, { label: "No", value: "0" }]);
  eq(by.get("question_112")?.type, "textarea");
  eq(by.get("location")?.section, "location");
  eq(by.get("gender")?.section, "eeo");
  eq(by.get("gender")?.required, false);
  eq([...s!.uploads].sort(), ["cover_letter", "resume"]);
  eq(s!.captcha_expected, false, "the board API publishes no captcha; the engine still checks the live page");
  eq(parseGreenhouseForm({ id: 1 }), null, "no questions array: null, never an empty form");
});

Deno.test("WO-121/2 Lever: every cards[...] field of each captured /apply page, with its label; name, email, resume; hCaptcha noted; page chrome is not a field", async () => {
  const files = [...Deno.readDirSync(FORMS)].map((e) => e.name).filter((n) => /^lever-.*\.html$/.test(n));
  eq(files.length, 6, "the six captured Lever forms (tests/fixtures/forms-ci)");
  for (const f of files) {
    const html = await Deno.readTextFile(`${FORMS}/${f}`);
    const s = parseLeverApplyHtml(html);
    assert(s, `${f}: parsed`);
    eq(s!.source, "lever_apply_html", f);
    const ids = new Set(s!.fields.map((x) => x.id));
    for (const must of ["name", "email", "resume"]) assert(ids.has(must), `${f}: ${must}`);
    const cards = [...html.matchAll(/name="(cards\[[0-9a-f-]{36}\]\[field\d+\])"/g)].map((m) => m[1]);
    for (const c of new Set(cards)) assert(ids.has(c), `${f}: ${c} captured`);
    for (const chrome of ["origin", "referer", "socialReferralKey", "accountId", "twitter:card", "h-captcha-response", "linkedInData", "resumeStorageId"]) {
      assert(!ids.has(chrome), `${f}: ${chrome} is not a question`);
    }
    for (const x of s!.fields) assert(x.label.trim().length > 0 || x.type === "hidden", `${f}: ${x.id} has a label`);
    eq(s!.captcha_expected, /name="h-captcha-response"/.test(html), `${f}: captcha_expected follows the page`);
    assert(s!.uploads.includes("resume"), `${f}: resume upload`);
  }
});

Deno.test("WO-121/3 Ashby: the page's own read gives the browser's schema (ids, labels, required, options) on >= 98% of required fields, none missing", async () => {
  const browser = JSON.parse(await Deno.readTextFile(`${FORMS}/ashby-schemas.json`)).forms as Record<string, { schema: { name: string; label: string; required: boolean; options: { label: string }[] }[] }>;
  let captures: string[] = [];
  try { captures = [...Deno.readDirSync(CAPTURES)].map((e) => e.name).filter((n) => /^ashby-.*\.graphql\.json$/.test(n)); } catch { /* none yet */ }
  if (captures.length === 0) {
    // Owner step 1 (WO-121) decides whether this read is used at all; until then the captures do not exist. Said, not hidden.
    console.log("WO-121/3 SKIPPED BY NAME: no Ashby captures in tests/fixtures/form-schema (owner step 1 not decided)");
    return;
  }
  let required = 0, same = 0;
  for (const f of captures) {
    const id = f.replace(/\.graphql\.json$/, "");
    const want = browser[id]?.schema;
    assert(want, `${id}: a browser schema to compare with`);
    const s = parseAshbyPosting(JSON.parse(await Deno.readTextFile(`${CAPTURES}/${f}`)));
    assert(s, `${id}: parsed`);
    eq(s!.source, "ashby_posting_graphql");
    const got = new Map(s!.fields.map((x) => [x.id, x]));
    for (const w of want.filter((x) => x.required)) {
      required++;
      const g = got.get(w.name);
      assert(g, `${id}: required field ${w.name} (${w.label}) is missing`);
      const sameOpts = JSON.stringify(g!.options.map((o) => o.label)) === JSON.stringify(w.options.map((o) => o.label));
      if (g!.required === true && g!.label.trim() === w.label.trim() && sameOpts) same++;
    }
  }
  assert(required > 0);
  assert(same / required >= 0.98, `same on ${same}/${required} required fields`);
});

Deno.test("WO-121/4 the request: documented Greenhouse URL; Lever's /apply page only; Ashby only with the owner's yes; SmartRecruiters and Workday unread by name; LinkedIn/Indeed never requested", () => {
  const gh = formRequestFor({ job_id: "greenhouse:acme:123", provider: "greenhouse", board: "acme", ats_id: "123", url: "https://job-boards.greenhouse.io/acme/jobs/123" });
  eq((gh as any).url, "https://boards-api.greenhouse.io/v1/boards/acme/jobs/123?questions=true");
  eq((gh as any).method, "GET");
  const lv = formRequestFor({ job_id: "lever:acme:0130d854-9bae-48d4-8ef0-e9da1ee778a5", provider: "lever", board: "acme", ats_id: "0130d854-9bae-48d4-8ef0-e9da1ee778a5", url: "https://jobs.lever.co/acme/0130d854-9bae-48d4-8ef0-e9da1ee778a5" });
  eq((lv as any).url, "https://jobs.lever.co/acme/0130d854-9bae-48d4-8ef0-e9da1ee778a5/apply");
  const ashby = { job_id: "ashby:acme:cba0ab2e-5ab8-416b-ac9b-115638e3c65c", provider: "ashby", board: "acme", ats_id: "cba0ab2e-5ab8-416b-ac9b-115638e3c65c", url: "https://jobs.ashbyhq.com/acme/cba0ab2e-5ab8-416b-ac9b-115638e3c65c" };
  eq((formRequestFor(ashby, { ashbyGraphql: false }) as any).unread, "not_public");
  const ar = formRequestFor(ashby, { ashbyGraphql: true }) as any;
  eq([ar.method, new URL(ar.url).hostname, new URL(ar.url).pathname], ["POST", "jobs.ashbyhq.com", "/api/non-user-graphql"]);
  eq((formRequestFor({ job_id: "smartrecruiters:acme:1", provider: "smartrecruiters", board: "acme", ats_id: "1", url: "https://jobs.smartrecruiters.com/Acme/1" }) as any).unread, "needs_partner_key");
  eq((formRequestFor({ job_id: "workday:acme:R1", provider: "workday", board: "acme", ats_id: "R1", url: "https://acme.wd5.myworkdayjobs.com/en-US/careers/job/R1" }) as any).unread, "sign_in_required");
  for (const url of ["https://www.linkedin.com/jobs/view/1", "https://www.indeed.com/viewjob?jk=1", "https://app.joinhandshake.com/jobs/1"]) {
    const r = formRequestFor({ job_id: "greenhouse:x:1", provider: "greenhouse", board: "x", ats_id: "1", url }) as any;
    eq(r.unread, "not_public", url);
    eq(r.url, undefined, `${url}: no request is built`);
  }
});

Deno.test("WO-121/4b readForm: one GET, no model, a 429 is rate_limited with its Retry-After, a 404 is no_form; a parse failure is parse_error, never an empty form", async () => {
  const calls: string[] = [];
  const answer = (status: number, body: string, headers: Record<string, string> = {}) => async (u: string | URL | Request) => { calls.push(String(u)); return new Response(body, { status, headers }); };
  const p = { job_id: "greenhouse:acme:123", provider: "greenhouse", board: "acme", ats_id: "123", url: "https://job-boards.greenhouse.io/acme/jobs/123" };
  const ok = await readForm(p, { fetch: answer(200, JSON.stringify(GH)) as any, now: () => NOW, ashbyGraphql: false }) as FormSchema;
  eq([ok.v, ok.job_id, ok.source], [1, p.job_id, "greenhouse_boards_api"]);
  assert(/^[a-f0-9]{64}$/.test(ok.sha256));
  eq(calls.length, 1, "one request per posting");
  const again = await readForm(p, { fetch: answer(200, JSON.stringify(GH)) as any, now: () => NOW + 1, ashbyGraphql: false }) as FormSchema;
  eq(again.sha256, ok.sha256, "the sha covers the fields, not the read time");
  eq(((await readForm(p, { fetch: answer(429, "", { "retry-after": "120" }) as any, now: () => NOW, ashbyGraphql: false })) as any).unread, "rate_limited");
  eq(((await readForm(p, { fetch: answer(429, "", { "retry-after": "120" }) as any, now: () => NOW, ashbyGraphql: false })) as any).retry_after_s, 120);
  eq(((await readForm(p, { fetch: answer(404, "") as any, now: () => NOW, ashbyGraphql: false })) as any).unread, "no_form");
  eq(((await readForm(p, { fetch: answer(200, "{not json") as any, now: () => NOW, ashbyGraphql: false })) as any).unread, "parse_error");
});

Deno.test("WO-121/4c no model call anywhere in the capture path", async () => {
  for (const f of ["supabase/functions/_shared/posting_schema.ts", "supabase/functions/_shared/form_readiness.ts", "supabase/functions/career-form-schema/handler.ts"]) {
    const src = await Deno.readTextFile(`${ROOT}/${f}`);
    assert(!/model_gateway|callModel|anthropic|openai/i.test(src.replace(/\/\/.*$/gm, "")), `${f} reaches no model`);
  }
});
