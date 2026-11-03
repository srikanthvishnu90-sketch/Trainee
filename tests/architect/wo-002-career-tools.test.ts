// WO-002 acceptance tests (architect-authored; Codex makes them pass, never edits them).
// The first career tools: thin wrappers over the existing domain modules, operating on the same per-thread
// career state the router uses (the CareerHost snapshot stores), so either brain can run on a thread.
// Contract in docs/architect/work-orders/WO-002.md. Run: deno test --no-check tests/architect/
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }

const NOW = Date.UTC(2026, 9, 18, 15);
const ctx = () => ({ userId: "u1", threadId: "t1", now: NOW, state: {} as Record<string, any> });
const posting = (id: string, title: string, company: string, extra: Record<string, unknown> = {}) =>
  ({ job_id: id, title, company, location: "New York, NY", url: `https://boards.greenhouse.io/${company.toLowerCase()}/jobs/${id}`, description: `${title} at ${company}.`, first_seen_at: "2026-10-18T14:00:00Z", ...extra });

async function rejects(f: () => Promise<unknown>, re: RegExp) { try { await f(); } catch (e) { assert(re.test(String((e as Error).message)), `wrong error: ${(e as Error).message}`); return; } throw new Error("did not reject"); }
function byName(tools: any[]) { return Object.fromEntries(tools.map((t) => [t.name, t])); }

Deno.test("WO-002/T1 the tool set: names, effects, schemas; no external tool yet", () => {
  const tools = careerTools({ postings: async () => [] });
  eq(tools.map((t) => t.name).sort(), [
    "add_profile_fact", "confirm_profile_fact", "correct_profile_fact", "read_resume", "forget_instruction", "get_interview_questions", "get_job_alerts", "get_memory", "get_profile",
    "interview_brief", "list_applications", "recall", "remember_instruction", "save_resume_persona", "score_interview_answer", "search_jobs", "set_job_alerts", "set_resume_contact",
    "stop_job_alerts", "tailor_resume", "track_application", "use_resume_persona", "where_do_i_stand",
    "contact_list", "draft_outreach", "record_list_cost", "referral_map", "set_outreach_signature", "verify_contacts",
    "brief_from_invite", "set_weekly_digest",
    "offer_benchmark", "career_path_answer",
    "queue_applications", "get_posting", "get_situation",
  ].sort()); // correct_profile_fact (a correction replaces the fact it corrects) and read_resume (a pasted resume read by code): WO-106; // get_situation (the person's situation, read once per turn): WO-100; // get_posting (one posting in full, its stated pay): WO-068; // queue_applications (the person's own apply queue; each application goes only on its card's tap): WO-066; // the three alert tools: WO-007; standing instructions: WO-023; where_do_i_stand: WO-024; the pre-interview brief: WO-025; recall (the account's timeline): WO-027; the resume tools: WO-028; brief_from_invite and set_weekly_digest: WO-034; offer_benchmark and career_path_answer: WO-036;
  // contacts, outreach drafts and the referral map: WO-033 (drafting is write_own: sending is only by the approval reply and the scheduled run)
  const effects = Object.fromEntries(tools.map((t) => [t.name, t.effect]));
  eq(effects, {
    remember_instruction: "write_own", forget_instruction: "write_own", get_memory: "read",
    get_profile: "read", add_profile_fact: "write_own", confirm_profile_fact: "write_own", read_resume: "write_own", correct_profile_fact: "write_own",
    get_situation: "read", list_applications: "read", track_application: "write_own", queue_applications: "write_own", get_posting: "read", search_jobs: "read",
    set_job_alerts: "write_own", get_job_alerts: "read", stop_job_alerts: "write_own", recall: "read",
    get_interview_questions: "read", interview_brief: "read", offer_benchmark: "write_own", career_path_answer: "read",
    score_interview_answer: "read",
    tailor_resume: "write_own", set_resume_contact: "write_own", save_resume_persona: "write_own", use_resume_persona: "write_own", where_do_i_stand: "read",
    contact_list: "read", verify_contacts: "write_own", record_list_cost: "write_own", draft_outreach: "write_own",
    set_outreach_signature: "write_own", referral_map: "read",
    brief_from_invite: "write_own", set_weekly_digest: "write_own",
  });
  for (const t of tools) {
    assert(t.description.length >= 20 && t.description.length <= 400, `${t.name}: a real description`);
    eq(t.input_schema.type, "object", t.name);
    assert(Array.isArray(t.input_schema.required), `${t.name}: required is a list`);
  }
});

Deno.test("WO-002/T2 a stated fact is saved as a DRAFT; only confirm makes it usable", async () => {
  const t = byName(careerTools({ postings: async () => [] })), c = ctx();
  const empty = await t.get_profile.run({}, c) as any;
  eq([empty.confirmed.length, empty.unconfirmed.length], [0, 0]);
  const added = await t.add_profile_fact.run({ kind: "experience", text: "6 years ICU nurse at Cleveland Clinic" }, c) as any;
  assert(added.fact && typeof added.fact.id === "string", "the fact gets a stable id");
  eq(added.fact.needs_confirmation, true, "a stated fact is a draft until the user confirms it");
  const mid = await t.get_profile.run({}, c) as any;
  eq([mid.confirmed.length, mid.unconfirmed.length], [0, 1]);
  // The person's yes comes in a later turn (the confirmation rule: tests WO-002/T8).
  const next = { ...ctx(), state: c.state, turn: { message: "Yes, that's right.", added: [] as string[] } };
  const done = await t.confirm_profile_fact.run({ id: added.fact.id }, next) as any;
  eq(done.fact.needs_confirmation, false);
  const after = await t.get_profile.run({}, c) as any;
  eq([after.confirmed.length, after.unconfirmed.length], [1, 0]);
  assert(JSON.stringify(after.confirmed).includes("ICU"), "the confirmed fact keeps the user's words");
  assert(c.state.profile && Array.isArray(c.state.profile.facts), "facts live in the career state's profile store");
});

Deno.test("WO-002/T3 confirming a fact that doesn't exist is an error, never a silent success", async () => {
  const t = byName(careerTools({ postings: async () => [] }));
  let threw = false;
  try { await t.confirm_profile_fact.run({ id: "F-999" }, ctx()); } catch { threw = true; }
  assert(threw, "confirm_profile_fact throws for an unknown id");
});

Deno.test("WO-002/T4 applications are tracked in the career state's trackStore and listed back", async () => {
  const t = byName(careerTools({ postings: async () => [] })), c = ctx();
  const a = await t.track_application.run({ company: "Stripe", role: "Data Analyst", stage: "Submitted" }, c) as any;
  eq([a.application.company, a.application.role, a.application.stage], ["Stripe", "Data Analyst", "Submitted"]);
  const b = await t.track_application.run({ company: "Stripe", stage: "Interview rounds" }, c) as any;
  eq(b.application.stage, "Interview rounds", "the same company moves stage instead of duplicating");
  const list = await t.list_applications.run({}, c) as any;
  eq(list.applications.length, 1);
  eq(list.applications[0].stage, "Interview rounds");
  assert(c.state.trackStore, "rows live in the career state's trackStore");
});

Deno.test("WO-002/T5 search_jobs is honest when there are no live postings", async () => {
  const t = byName(careerTools({ postings: async () => [] }));
  const r = await t.search_jobs.run({ query: "registered nurse" }, ctx()) as any;
  eq(r.postings, []);
  eq(r.source, "none");
});

Deno.test("WO-002/T6 search_jobs filters live postings by the query, caps by limit, and keeps each posting's url and first-seen time", async () => {
  const pool = [
    posting("1", "Registered Nurse - ICU", "Mount Sinai"),
    posting("2", "Software Engineer", "Stripe"),
    posting("3", "ICU Travel Nurse", "Northwell"),
    posting("4", "Data Analyst", "Ramp"),
  ];
  const t = byName(careerTools({ postings: async () => pool }));
  const r = await t.search_jobs.run({ query: "nurse", limit: 5 }, ctx()) as any;
  eq(r.source, "live");
  eq(r.postings.map((p: any) => p.job_id).sort(), ["1", "3"]);
  for (const p of r.postings) { assert(p.url && p.first_seen_at, "url and first_seen_at are kept"); }
  const one = await t.search_jobs.run({ query: "nurse", limit: 1 }, ctx()) as any;
  eq(one.postings.length, 1);
  const all = await t.search_jobs.run({}, ctx()) as any;
  eq(all.postings.length, 4, "no query returns the pool (up to the default limit of 10)");
});

Deno.test("WO-002/T7 interview questions come from the banks; answers are scored by the existing rubric", async () => {
  const t = byName(careerTools({ postings: async () => [] }));
  const q = await t.get_interview_questions.run({ role: "consulting analyst" }, ctx()) as any;
  assert(Array.isArray(q.questions) && q.questions.length > 0, "questions are served");
  assert(q.questions.every((x: any) => typeof x.q === "string" && x.q.length > 10), "each question has text");
  const s = await t.score_interview_answer.run({ answer: "In my internship I rebuilt the reporting pipeline, which cut weekly prep from 6 hours to 1 and was adopted by two other teams." }, ctx()) as any;
  assert(s && typeof s === "object", "the rubric result is returned as-is");
});

Deno.test("WO-002/T8 only the person confirms a fact: never in the turn that added it, never without their plain yes", async () => {
  const t = byName(careerTools({ postings: async () => [] }));
  const turn1 = { ...ctx(), turn: { message: "I was a nurse for 6 years", added: [] as string[] } };
  const added = await t.add_profile_fact.run({ kind: "experience", text: "6 years as a nurse" }, turn1) as any;
  await rejects(() => t.confirm_profile_fact.run({ id: added.fact.id }, turn1), /added in this turn/);
  const later = (message: string) => ({ ...ctx(), state: turn1.state, turn: { message, added: [] as string[] } });
  await rejects(() => t.confirm_profile_fact.run({ id: added.fact.id }, later("what jobs are open?")), /not a plain yes/);
  await rejects(() => t.confirm_profile_fact.run({ id: added.fact.id }, later("no, it was 5 years")), /not a plain yes/);
  await rejects(() => t.confirm_profile_fact.run({ id: added.fact.id }, { ...ctx(), state: turn1.state }), /no confirmation/);
  const ok = await t.confirm_profile_fact.run({ id: added.fact.id }, later("yes, correct")) as any;
  eq(ok.fact.needs_confirmation, false);
});

