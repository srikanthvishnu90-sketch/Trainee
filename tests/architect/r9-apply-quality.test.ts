// Release 9, workstream A, part 1 (architect, 2026-11-07): the root causes of the failed mass-apply scorecard
// (evals/career/mass-apply-outcomes/results/SCORECARD.md on 3defbcf: 52.1% fully clean, Greenhouse 12.5%, duplicates
// prevented 0/14 on Greenhouse, 4 wrong answers). Each case below is one failure class, on the real pure code, in memory.
//   1. A Greenhouse job number reached through an employer's own careers page (?gh_jid=N on any host) is the same posting
//      as boards.greenhouse.io/<board>/jobs/N: refused as a duplicate (D-MS-3), in TS and in the SQL twin's text.
//   2. Options that all carry one value (Ashby's radios are all "on") are planned by the option's own words, so the
//      approved payload says which option was chosen.
//   3. A confirmed fact that does not answer what is asked holds the question and asks (D-007), never a guess:
//      "need sponsorship" (now or later) is no answer to "will you NOW require"; an authorization that needs sponsorship
//      is no "unrestricted right to work" and no "Yes, no restriction"; "no government employment" is no answer about
//      military service.
//   4. A standing SMS opt-out answers "updates ... via SMS. Please answer with Yes or No."
import { assert, assertEquals } from "jsr:@std/assert@1";
import { admitApplication, type FormField, planBatch, postingKey } from "../../supabase/functions/_shared/career_apply.ts";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const f = (label: string, type: string, options: string[] | { label: string; value: string }[] = [], required = true): FormField => ({
  name: "q_" + label.slice(0, 12).replace(/\W/g, "_"), label, type, required,
  options: options.map((o) => typeof o === "string" ? { label: o, value: o } : o),
});
const ans = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, factId: `T:${k}` }]));
const plan = (field: FormField, answers: Record<string, { value: string; factId: string }>, location = "New York, NY") =>
  planBatch({ userId: "TEST", postings: [{ job_id: "J1", company: "Example Co", title: "Analyst", fields: [field], location }], answers, saved: {}, log: [], now: NOW });
const filled = (r: ReturnType<typeof plan>) => r.ready[0]?.fields[0]?.value ?? null;
const asked = (r: ReturnType<typeof plan>) => r.needs.map((n) => n.label);

// Persona B of the eval: F-1 OPT, authorized today, needs sponsorship.
const OPT = ans({ work_authorization: "Yes", sponsorship: "Yes", citizenship: "India", country: "United States", location: "Austin, TX", city: "Austin", state: "TX" });
// Persona A: US citizen, needs no sponsorship.
const CITIZEN = ans({ work_authorization: "Yes", sponsorship: "No", citizenship: "United States", country: "United States", location: "Chicago, IL", city: "Chicago", state: "IL",
  government_employment: "No", sms_opt_in: "No" });

Deno.test("R9-1 a Greenhouse job number on an employer's careers page is the same posting", () => {
  const base = "https://boards.greenhouse.io/datadog/jobs/8257324";
  for (const v of ["https://careers.example.test/jobs?gh_jid=8257324", "https://www.datadoghq.com/careers/detail/?gh_jid=8257324&gh_src=x",
    "https://job-boards.greenhouse.io/embed/job_app?for=datadog&gh_jid=8257324"]) {
    assertEquals(postingKey(v), postingKey(base), v);
  }
  // A different job number stays a different posting; a link with no job number keeps its own key.
  assert(postingKey("https://careers.example.test/jobs?gh_jid=8257325") !== postingKey(base));
  assertEquals(postingKey("https://careers.example.test/jobs?team=data"), "careers.example.test/jobs?team=data");
  const log = [{ user_id: "U", job_id: "gh-8257324", company: "Datadog", url: base, at: NOW, state: "queued" }];
  const r = admitApplication(log, { user_id: "U", job_id: "other-source-1", company: "Datadog", url: "https://careers.example.test/jobs?gh_jid=8257324" }, NOW);
  assertEquals(r, { ok: false, reason: "duplicate_job" });
  // Another person, or another role at the company, is admitted.
  assert(admitApplication(log, { user_id: "V", job_id: "x", company: "Datadog", url: "https://careers.example.test/jobs?gh_jid=8257324" }, NOW).ok);
  assert(admitApplication(log, { user_id: "U", job_id: "y", company: "Datadog", url: "https://careers.example.test/jobs?gh_jid=8257399" }, NOW).ok);
});

Deno.test("R9-1 the SQL posting key says the same: a job number on any host is the Greenhouse job", () => {
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const name = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => /career_apply_posting_key_any_host\.sql$/.test(n));
  assertEquals(name.length, 1, "one migration redefines career_apply_posting_key");
  const sql = Deno.readTextFileSync(new URL(name[0], dir));
  assert(/create or replace function public\.career_apply_posting_key\(p_url text\)/.test(sql));
  // The job number is read from the query before the host is looked at, and the expression index is rebuilt.
  const fn = sql.slice(sql.indexOf("create or replace function public.career_apply_posting_key"));
  assert(fn.indexOf("gh_jid") < fn.indexOf("greenhouse\\.io$"), "gh_jid is read for every host");
  assert(/reindex index (concurrently )?(public\.)?career_apply_jobs_posting_key/i.test(sql));
});

Deno.test("R9-1 options that share one value are planned by their own words", () => {
  const race = f("Hispanic or Latino", "radio", [
    { label: "Hispanic or Latino", value: "on" }, { label: "White (Not Hispanic or Latino)", value: "on" }, { label: "Decline to self-identify", value: "on" },
  ], false);
  const r = plan(race, ans({ eeo: "decline" }));
  assertEquals(filled(r), "Decline to self-identify");
  const harvey = f("Yes, I will require Harvey to sponsor my employment", "radio", [
    { label: "Yes, I will require Harvey to sponsor my employment", value: "on" },
    { label: "No, I do not require sponsorship to work in the country where this role is located", value: "on" },
  ], false);
  assertEquals(filled(plan(harvey, CITIZEN, "San Francisco, CA")), "No, I do not require sponsorship to work in the country where this role is located");
  // Distinct values are untouched: the employer's own value is what is sent.
  const gh = f("Will you now or in the future require sponsorship?", "multi_value_single_select", [{ label: "Yes", value: "1" }, { label: "No", value: "0" }]);
  assertEquals(filled(plan(gh, CITIZEN)), "0");
});

Deno.test("R9-1 a fact that does not answer the question asked is held and asked, never guessed", () => {
  const now = f("Will you now require immigration sponsorship by our company to attain or maintain your employment eligibility (e.g., H-1B, E-3, TN, O-1, STEM OPT)?",
    "multi_value_single_select", [{ label: "Yes", value: "1" }, { label: "No", value: "0" }]);
  assertEquals(filled(plan(now, OPT)), null);
  assertEquals(asked(plan(now, OPT)), [now.label]);
  assertEquals(filled(plan(now, CITIZEN)), "0", "no sponsorship ever answers 'now' too");
  const nowOrLater = f("Will you now or in the future require visa sponsorship?", "multi_value_single_select", [{ label: "Yes", value: "1" }, { label: "No", value: "0" }]);
  assertEquals(filled(plan(nowOrLater, OPT)), "1");

  const unrestricted = f("Do you have the unrestricted right to work in the United States?", "radio", ["Yes", "No"]);
  assertEquals(filled(plan(unrestricted, OPT)), null);
  assertEquals(asked(plan(unrestricted, OPT)), [unrestricted.label]);
  assertEquals(filled(plan(unrestricted, CITIZEN)), "Yes");

  const dd = f("Are you legally authorised to work full-time in the country where this job is based?", "multi_value_single_select", [
    { label: "Yes, no restriction.", value: "754693426" }, { label: "Yes, but I will need sponsorship in the future.", value: "754693427" }, { label: "No, I need sponsorship now.", value: "754693428" }]);
  assert(filled(plan(dd, OPT)) !== "754693426", "an OPT person is never 'Yes, no restriction'");
  assertEquals(filled(plan(dd, CITIZEN)), "754693426");

  const usg = f("Are you currently, or have you previously served (within the past five years), as a United States Government (USG) official, employee, or member of the U.S. military?", "checkbox");
  assertEquals(filled(plan(usg, CITIZEN)), null);
  assertEquals(asked(plan(usg, CITIZEN)), [usg.label]);
});

Deno.test("R9-1 a standing SMS opt-out answers an SMS-updates yes/no", () => {
  const sms = f("I would like to receive updates from a recruiter about this job and/or application activity via SMS. Please answer with Yes or No.",
    "multi_value_single_select", [{ label: "Yes", value: "1" }, { label: "No", value: "0" }]);
  assertEquals(filled(plan(sms, CITIZEN)), "0");
  // No standing choice: asked.
  assertEquals(filled(plan(sms, OPT)), null);
});
