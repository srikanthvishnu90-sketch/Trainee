// Release item 9 (profile and memory), the application half: docs/architect/VERIFICATION-15.md item 9 ("facts only from
// what the person confirmed; reused answers marked; sensitive facts asked per application"), D-007, spec APP-LAYER-15-FIXES
// E.3 28-29. tests/architect/loop-09-memory.test.ts measures what is read back in chat; this battery measures what goes on
// the APPLICATIONS the memory fills, across sessions.
//
// Five people, three sessions each (each session a NEW chat thread, one employer per session). In every session the person
// talks to the REAL agent-chat career handler (handler-career.ts handleChat over the flow harness's PostgREST double, Postgres 16
// with every migration), says what they say (statements, hedges, corrections), asks to apply, and answers the questions the
// preparation asks, one per message, through the product's own questions turn. The preparation is the hosted one
// (workers/career-browser/prepare-ahead.ts prepareAhead with the database's candidate rule, storedProfile and the question
// writers); the one named stand-in is the browser: the employer's form goes through the engine's OWN planner and contract
// (scripts/apply.ts trustedFacts + planApplication), as tests/architect/missing-info-e2e.test.ts does. The prepared payload is
// read back from career_apply_prepared, and its review from application_review.ts reviewOf (what the F-09 review page shows).
//
//   unconfirmed_used     an answer on an application that is not the person's own answer to that question (a hedge, a
//                        statement in chat, a guess, an answer they never typed)                                      bar: 0
//   reuse_unmarked       an answer reused from an earlier session whose source is not shown as theirs              bar: 0
//   shared_reasked       a fact already answered (name, email, sponsorship, graduation) asked again with no
//                        correction in between                                                                     reported
//   sensitive_reused     a per-application answer (veteran, disability, gender, date of birth, salary history)
//                        filled from another employer's answer instead of being asked for this one                 bar: 0
//   stale_after_correction  a value the person corrected in session 2 on a later application, or still on a card
//                        that can be approved                                                                       bar: 0
//
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/loop-09-memory-apply.test.ts
// (Postgres 16; LOOP_OUT=<dir> keeps the transcripts). Nothing is approved, queued to send or sent: the stand-in refuses a send.
import assertNode from "node:assert/strict";
import { basename } from "node:path";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { type AheadDeps, prepareAhead, type PreparedResume, storedProfile } from "../../workers/career-browser/prepare-ahead.ts";
import type { RunEngine } from "../../workers/career-browser/approve-first.ts";
import { applicationApprovalHash, planApplication, trustedFacts } from "../../scripts/apply.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { questionFieldType } from "../../supabase/functions/_shared/career_apply.ts";
import { rowQuestionLabel, rowQuestionType } from "../../supabase/functions/_shared/row_answer.ts";
import { reviewOf } from "../../supabase/functions/_shared/application_review.ts";
import { questionLine } from "../helpers/one_question.ts";
import { entryCorrectionFacts, freshStatedFacts, monthYear, reopenedLine } from "../../supabase/functions/_shared/career_stated_answers.ts";
import { answerKey } from "../../supabase/functions/_shared/question_map.ts";
import { type LoopCase, reportLoop } from "./helpers/loop_report.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const RESUME_TEXT = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const FILE = new TextEncoder().encode("%PDF-1.4\n% TEST synthetic resume file for the memory battery, not a real person\n%%EOF\n");
const KICK_URL = "http://prepare.test/functions/v1/career-cloud-runner/prepare", KICK_TOKEN = "TEST-loop9-prepare-token-0123456789abcdef";
const b64 = (b: Uint8Array) => { let s = ""; for (const c of b) s += String.fromCharCode(c); return btoa(s); };
const sha256 = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------------------------------------- the employers' form
// Every employer asks the same questions (so a reused answer is visible): five facts the person gives once, and five that
// are theirs to give to each employer (self-identification, date of birth, what they were paid).
const opt = (...ls: string[]) => ls.map((l) => ({ label: l, value: l }));
const Q = {
  first: "First name", last: "Last name", email: "Email",
  sponsor: "Will you now or in the future require sponsorship for employment visa status?",
  grad: "Expected graduation date",
  veteran: "Are you a protected veteran?", disability: "Do you have a disability?", gender: "Gender",
  dob: "Date of birth", paid: "What was your salary at your previous job?",
} as const;
type QK = keyof typeof Q;
const SHARED: QK[] = ["first", "last", "email", "sponsor", "grad"];
const PER_APP: QK[] = ["veteran", "disability", "gender", "dob", "paid"];
const SCHEMA = () => [
  { name: "first_name", label: Q.first, type: "input_text", required: true, options: [] },
  { name: "last_name", label: Q.last, type: "input_text", required: true, options: [] },
  { name: "email", label: Q.email, type: "input_text", required: true, options: [] },
  { name: "sponsorship", label: Q.sponsor, type: "radio", required: true, options: opt("Yes", "No") },
  { name: "graduation", label: Q.grad, type: "input_text", required: true, options: [] },
  { name: "veteran", label: Q.veteran, type: "select", required: true, options: opt("I am a protected veteran", "I am not a protected veteran", "I decline to answer") },
  { name: "disability", label: Q.disability, type: "select", required: true, options: opt("Yes", "No", "I do not want to answer") },
  { name: "gender", label: Q.gender, type: "select", required: true, options: opt("Male", "Female", "Non-binary", "Decline to self-identify") },
  { name: "dob", label: Q.dob, type: "input_text", required: true, options: [] },
  { name: "paid", label: Q.paid, type: "input_text", required: true, options: [] },
];
const nameOf: Record<QK, string> = { first: "first_name", last: "last_name", email: "email", sponsor: "sponsorship", grad: "graduation", veteran: "veteran", disability: "disability", gender: "gender", dob: "dob", paid: "paid" };
const keyOfLine = (line: string): QK | null => (Object.keys(Q) as QK[]).find((k) => line.includes(Q[k])) ?? null;

// ---------------------------------------------------------------------------------------------- the people
// A session: what the person says first (statements, hedges, corrections), then the employer they apply to, and their answer
// to each question if it is asked in that session. `stale`: values corrected in that session (never on a later application).
interface Session { say: string[]; answers: Partial<Record<QK, string>>; stale?: Partial<Record<QK, RegExp>> }
interface Person { id: string; sessions: [Session, Session, Session]; never?: RegExp[] }
const BASE = { first: "Alex", last: "Testcase", email: "alex.testcase@example.test" };
const PEOPLE: Person[] = [
  // Gives everything once, then just applies: the five facts are reused (and shown as theirs); the five per-application
  // answers are asked again at each employer, and each employer gets that session's answer.
  { id: "steady", sessions: [
    { say: ["I'm a junior majoring in statistics"], answers: { ...BASE, sponsor: "no", grad: "2027-05-15", veteran: "I am not a protected veteran", disability: "No", gender: "Female", dob: "2004-03-02", paid: "$22 an hour" } },
    { say: [], answers: { veteran: "I decline to answer", disability: "I do not want to answer", gender: "Decline to self-identify", dob: "2004-03-02", paid: "$24 an hour" } },
    { say: ["thanks"], answers: { veteran: "I am not a protected veteran", disability: "No", gender: "Female", dob: "2004-03-02", paid: "$25 an hour" } },
  ] },
  // Answers sponsorship "no" at the first employer, then says in session 2 that they WILL need it. The old "no" must not be
  // on the session 2 or session 3 application, nor on the session 1 card once corrected; they are asked again.
  { id: "sponsorship-corrected", sessions: [
    { say: [], answers: { ...BASE, sponsor: "no", grad: "2027-05-15", veteran: "I am not a protected veteran", disability: "No", gender: "Male", dob: "2003-11-20", paid: "$20 an hour" } },
    { say: ["Actually I will need visa sponsorship."], answers: { sponsor: "yes", veteran: "I am not a protected veteran", disability: "No", gender: "Male", dob: "2003-11-20", paid: "$21 an hour" }, stale: { sponsor: /^no$/i } },
    { say: [], answers: { veteran: "I am not a protected veteran", disability: "No", gender: "Male", dob: "2003-11-20", paid: "$21 an hour" } },
  ] },
  // Graduation answered May 2027, corrected in chat in session 2 (no resume entry involved: the statement path).
  { id: "graduation-corrected", sessions: [
    { say: ["I graduate in May 2027"], answers: { ...BASE, sponsor: "no", grad: "2027-05-15", veteran: "I am a protected veteran", disability: "No", gender: "Non-binary", dob: "2004-07-15", paid: "$19 an hour" } },
    { say: ["Correction: I graduate in December 2026, not May 2027"], answers: { grad: "2026-12-18", veteran: "I am a protected veteran", disability: "No", gender: "Non-binary", dob: "2004-07-15", paid: "$19 an hour" }, stale: { grad: /^2027-05/ } },
    { say: [], answers: { veteran: "I am a protected veteran", disability: "No", gender: "Non-binary", dob: "2004-07-15", paid: "$19 an hour" } },
  ] },
  // Hedges and volunteers sensitive things in chat before any question: none of it may answer a question. Every question is
  // still asked; the applications carry only what they typed as answers.
  { id: "hedged-and-volunteered", sessions: [
    { say: ["I might need sponsorship later, not sure yet", "I think I graduate in 2027 maybe", "I'm a veteran, by the way", "I was born in 2001"], answers: { ...BASE, sponsor: "no", grad: "2027-06-10", veteran: "I decline to answer", disability: "I do not want to answer", gender: "Decline to self-identify", dob: "2001-01-09", paid: "$18 an hour" } },
    { say: ["I made $30 an hour at my last job", "I have a disability"], answers: { veteran: "I decline to answer", disability: "Yes", gender: "Decline to self-identify", dob: "2001-01-09", paid: "$30 an hour" } },
    { say: [], answers: { veteran: "I decline to answer", disability: "I do not want to answer", gender: "Decline to self-identify", dob: "2001-01-09", paid: "$30 an hour" } },
  ], never: [/^I am a protected veteran$/] },
  // Corrects both a shared fact and nothing else across three sessions, and states the same fact again in session 3: a
  // statement that agrees with the answer on file reopens nothing.
  { id: "corrected-then-repeated", sessions: [
    { say: ["I'm a senior majoring in finance"], answers: { ...BASE, sponsor: "yes", grad: "2026-05-20", veteran: "I am not a protected veteran", disability: "No", gender: "Male", dob: "2002-05-05", paid: "$17 an hour" } },
    { say: ["Actually I don't need visa sponsorship. I'm a US citizen."], answers: { sponsor: "no", veteran: "I am not a protected veteran", disability: "No", gender: "Male", dob: "2002-05-05", paid: "$17 an hour" }, stale: { sponsor: /^yes$/i } },
    { say: ["I don't need visa sponsorship"], answers: { veteran: "I am not a protected veteran", disability: "No", gender: "Male", dob: "2002-05-05", paid: "$17 an hour" } },
  ] },
];

// ---------------------------------------------------------------------------------------------- the stand-in browser
// The engine's own decision (trustedFacts + planApplication) on the form above, the engine's own result shapes (as
// tests/architect/missing-info-e2e.test.ts). It never submits.
type Form = { job_id: string; company: string; title: string; url: string };
function standInEngine(forms: () => Form[], sink: { submits: number }): RunEngine {
  return async (args) => {
    if (args.includes("--submit") || args.includes("--approved")) { sink.submits++; throw Error("the memory battery never submits"); }
    const url = args[args.indexOf("--url") + 1];
    const form = forms().find((f) => f.url === url);
    if (!form) return { result: { state: "not_submitted", reason: "NO_SUCH_FORM" }, evidence: null };
    const schema = SCHEMA();
    const facts = JSON.parse(await Deno.readTextFile(args[args.indexOf("--facts") + 1]));
    const resumePath = args[args.indexOf("--resume") + 1];
    const artifact = { filename: basename(resumePath), sha256: await sha256(await Deno.readFile(resumePath)) };
    const manifest = trustedFacts(facts, artifact);
    const p = planApplication({ manifest, userId: facts.user_id, jobId: form.job_id, employer: form.company, schema, artifact, now: Date.now() });
    if (!p.ready) {
      const questions = p.needs.map((n: any) => {
        const f: any = schema.find((x) => (n.field_name ? x.name === n.field_name : x.label === n.label)) || {};
        return { label: rowQuestionLabel(f) || n.label, type: rowQuestionType(f, form.job_id, questionFieldType(f)), options: (f.options || []).map((o: any) => String(o.label)) };
      });
      return { result: { state: "not_submitted", reason: "needs_answers", posting: form.job_id, company: form.company, fields: p.needs.map((n: any) => n.label), questions } as any, evidence: null };
    }
    const schemaHash = await hashApplyPayload(schema);
    const approval = await applicationApprovalHash({ userId: facts.user_id, posting: form.job_id, destination: url, fields: p.fields, resumeSha256: artifact.sha256, schemaHash, pageFieldNames: [], manifest });
    return { result: { state: "not_submitted", reason: "dry_run" }, evidence: {
      approval_hash: approval, schema, fields: p.fields, readback: {}, sources: manifest.byFactId, replay_sources: Object.values(manifest.byFactId),
      trust: { quarantine_version: manifest.version, manifest_hash: manifest.hash },
      payload: { user_id: facts.user_id, posting: form.job_id, company: form.company, destination: url, resume: artifact, page_fields: {}, schema_hash: schemaHash, verification: [] },
    } } as any;
  };
}

const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
// The value the form takes for a typed answer: the option it names (yes/no to Yes/No), or the words as typed.
const formValue = (k: QK, typed: string) => {
  const o = SCHEMA().find((f) => f.name === nameOf[k])!.options;
  return o.length ? (o.find((x) => norm(x.label) === norm(typed))?.value ?? null) : typed;
};

Deno.test("loop 9 applications, pure parts: which statements reopen an answer, and per-application keys", () => {
  assertNode.deepStrictEqual(monthYear("2026-12-18"), { year: 2026, month: 12 });
  assertNode.deepStrictEqual(monthYear("Dec 18, 2026"), { year: 2026, month: 12 });
  assertNode.deepStrictEqual(monthYear("2027"), { year: 2027, month: null });
  assertNode.equal(monthYear("next spring"), null);
  // Only facts recorded THIS turn (an event the facts before did not carry) count.
  const before = [{ kind: "sponsorship", value: "does not need sponsorship", confirmation_event_id: "e1" }];
  assertNode.deepStrictEqual(freshStatedFacts(before, [...before, { kind: "year", value: "senior", confirmation_event_id: "e2" }]), []);
  assertNode.deepStrictEqual(freshStatedFacts(before, [{ kind: "sponsorship", value: "needs sponsorship", confirmation_event_id: "e3" }]), [{ kind: "sponsorship", value: "needs sponsorship" }]);
  assertNode.deepStrictEqual(freshStatedFacts([], [{ kind: "sponsorship", value: "needs sponsorship" }]), [], "a statement with no event is not a confirmed fact");
  // A corrected education entry's date is a graduation fact; another entry's correction is not.
  const ev = (kind: string, from: string, to: string) => ({ kind: "fact_confirmed", detail: { kind, corrected: { from, to } } });
  assertNode.deepStrictEqual(entryCorrectionFacts([ev("education", "May 2027", "December 2026"), ev("leadership", "May 2026", "June 2026"), ev("education", "Stats", "Math")]), [{ kind: "graduation", value: "December 2026" }]);
  assertNode.equal(reopenedLine({ reopened: [], expired: 0, stopped: 0 }), null, "nothing reopened, nothing said");
  assertNode.match(reopenedLine({ reopened: [{ label: Q.sponsor, answer: "No" }], expired: 1, stopped: 1 })!, /you had answered "No".*1 prepared application.*1 approved application not yet sent .* was stopped; nothing was sent/);
  // What they were paid is this employer's answer, as a date of birth is; what they expect stays a fact (by design).
  const k = (label: string, job: string) => answerKey({ label, type: "input_text", options: [] } as any, job);
  for (const l of [Q.paid, "Salary history", Q.dob]) assertNode.notEqual(k(l, "greenhouse:a:1"), k(l, "greenhouse:b:2"), l);
  assertNode.equal(k("What are your salary expectations?", "greenhouse:a:1"), "fact:salary_expectation");
});

Deno.test({
  name: "loop 9 applications: across 3 sessions x 5 people, applications carry only answers the person gave; reused answers are shown as theirs; sensitive answers are asked per employer; a correction in session 2 holds in session 3",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    const pg = await startPg();
    const work = await Deno.makeTempDir({ prefix: "trainee-loop9-apply-" });
    const keys = ["ANTHROPIC_API_KEY", "CAREER_BRAIN", "CAREER_MODEL", "CAREER_REPLY_MODEL", "CAREER_ACCOUNT_MEMORY", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN"];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch;
    const tokens = Object.fromEntries(PEOPLE.map((_, i) => [`ap${i}`, `9e0f8f8e-6a43-4a49-9d2c-${String(910000000000 + i)}`]));
    try {
      for (const k of keys) Deno.env.delete(k);
      Deno.env.set("CAREER_ACCOUNT_MEMORY", "on");
      Deno.env.set("CAREER_PREPARE_AHEAD_URL", KICK_URL);
      Deno.env.set("CAREER_PREPARE_AHEAD_TOKEN", KICK_TOKEN);
      await supabaseParity(pg);
      const ids = Object.values(tokens);
      const forms: Form[] = PEOPLE.flatMap((p, i) => [0, 1, 2].map((s) => ({ job_id: `greenhouse:loop9p${i}s${s}:${9100 + 10 * i + s}`, company: `TEST Employer ${"ABC"[s]}${i}`, title: `Data Analyst Intern ${"ABC"[s]}${i}`,
        url: `https://boards.greenhouse.io/loop9p${i}s${s}/jobs/${9100 + 10 * i + s}` })));
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
        ${forms.map((f) => `('${f.job_id}', 'greenhouse', '${f.job_id.split(":")[1]}', '${f.company}', '${f.title}', 'Chicago, IL', '${f.url}', 'Analyze data with SQL and Python.', now(), now())`).join(",")};
        insert into auth.users (id, email) values ${ids.map((id) => `('${id}', '${id}@example.test')`).join(", ")};
        insert into public.profiles (id) values ${ids.map((id) => `('${id}')`).join(", ")};
        insert into public.career_watch_kv (user_id, key, value) values ${ids.map((id) => `('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}')`).join(", ")};`);
      h = await careerHandler(pg, tokens);
      const double = h.double;
      const outbound: string[] = [];
      const harnessFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        if (req.url === KICK_URL) return new Response("{}", { status: 202 });
        if (new URL(req.url).origin === new URL(SUPABASE_URL).origin) return await harnessFetch(req);
        outbound.push(req.url);
        return Promise.reject(new Error(`the memory battery reaches no real host: ${req.url}`));
      }) as typeof fetch;
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false }, global: { fetch: double.fetch as typeof fetch } });
      const json = async (s: string) => JSON.parse((await pg.sql(`select coalesce(json_agg(x), '[]') from (${s}) x`)) || "[]");
      const sink = { submits: 0 };
      const keptResume = (uid: string) => async (_c: unknown, dir: string): Promise<PreparedResume | null> => {
        const r = await admin.rpc("career_apply_cloud_resume_kept_for", { p_user: uid });
        if (r.error || !r.data) return null;
        const path = `${dir}/${r.data.filename}`;
        await Deno.writeFile(path, Uint8Array.from(atob(r.data.b64), (c) => c.charCodeAt(0)));
        return { path, sha256: r.data.sha256, tag: null };
      };
      const prepare = async (uid: string, job: string) => await prepareAhead({ db: admin as any, runEngine: standInEngine(() => forms, sink), profileFor: storedProfile(admin as any), resumeFor: keptResume(uid), tmpRoot: work } as AheadDeps,
        { only: { user_id: uid, job_ids: [job] }, perPerson: 25, limit: 500 });

      const totals: Record<string, number> = { people: PEOPLE.length, sessions: 0, applications: 0, answers_checked: 0, unconfirmed_used: 0, reused: 0, reuse_unmarked: 0, shared_reasked: 0,
        per_app_asked: 0, sensitive_reused: 0, corrections: 0, stale_after_correction: 0, not_ready: 0 };
      const cases: LoopCase[] = [];
      for (const [i, p] of PEOPLE.entries()) {
        const uid = tokens[`ap${i}`], log: string[] = [], faults: string[] = [];
        const fault = (s: string) => faults.push(s);
        // What the person typed as an answer to each question, by session; and the factId each reused answer must keep.
        const typed: Partial<Record<QK, string>>[] = [];
        const stale: { k: QK; re: RegExp; from: number }[] = [];
        let prevFields: Record<string, { value: string; factId: string }> | null = null;
        for (const [s, sess] of p.sessions.entries()) {
          totals.sessions++;
          const chat: Chat = h.chat(`ap${i}`);
          const say = async (m: string) => { await pg.sql(`delete from public.agent_rate_limits`); const r = await chat.say(m); assertNode.equal(r.status, 200, r.reply); log.push(`[s${s + 1}] > ${m}\n${r.reply}`); return r; };
          if (s === 0) {
            const pasted = await say(`here is my resume:\n${RESUME_TEXT}`);
            assertNode.equal(pasted.intent, "career_resume_ingest", pasted.reply);
            const yes = await say("yes, that's my resume");
            assertNode.equal(yes.resultStatus, "completed", yes.reply);
            // Setup (named): the person's resume file kept for the cloud (the channel's confirmed upload).
            assertNode.equal(await pg.sql(`select public.career_apply_cloud_resume_put_for('${uid}', 'Alex_Testcase_Resume.pdf', '${b64(FILE)}')`), await sha256(FILE));
          }
          for (const m of sess.say) await say(m);
          for (const [k, re] of Object.entries(sess.stale ?? {}) as [QK, RegExp][]) { stale.push({ k, re, from: s }); totals.corrections++; }
          // Once corrected, no card that can still be approved carries the old value (a yes after the correction approves none).
          for (const st of stale.filter((x) => x.from === s)) {
            const live = await json(`select company, payload from public.career_apply_prepared where user_id = '${uid}' and state in ('ready', 'shown')`);
            for (const r of live) {
              const f = (r.payload?.fields ?? []).find((x: any) => x.name === nameOf[st.k]);
              if (f && st.re.test(String(f.value))) { totals.stale_after_correction++; fault(`s${s + 1}: ${r.company}'s card can still be approved with the corrected-away ${st.k} "${f.value}"`); }
            }
          }
          const form = forms[3 * i + s];
          const ap = await say(`apply to the ${form.title} role at ${form.company}`);
          assertNode.equal(ap.resultStatus, "queued", ap.reply);
          let out = await prepare(uid, form.job_id);
          // Answer what is asked, one question per message, as it comes.
          const asked = new Set<QK>(), given: Partial<Record<QK, string>> = {};
          for (let round = 0; round < 3 && out.some((o) => o.outcome === "asked"); round++) {
            let r = await say("what do you need from me");
            for (let n = 0; n < 20 && r.resultStatus !== null && /only you can answer/.test(r.reply); n++) {
              const line = questionLine(r.reply), k = keyOfLine(line);
              const ans = k ? sess.answers[k] : undefined;
              const other = /\bFor (TEST Employer \w+)\./.exec(line)?.[1];
              if (!k || ans === undefined || (other && other !== form.company)) { fault(`s${s + 1}: asked something with no answer planned: ${line}`); r = await say("skip"); continue; }
              asked.add(k); given[k] = ans;
              r = await say(ans);
              if (!/Saved/.test(r.reply)) { fault(`s${s + 1}: the answer to ${k} ("${ans}") was not saved: ${r.reply.slice(0, 200)}`); r = await say("skip"); continue; }
              if (!/\nNext: /.test(r.reply)) break;
            }
            out = await prepare(uid, form.job_id);
          }
          typed.push(given);
          // What was asked this session, against what the person had already given.
          for (const k of PER_APP) { if (asked.has(k)) totals.per_app_asked++; else fault(`s${s + 1}: ${k} was not asked for ${form.company} (a per-application answer)`); }
          for (const k of SHARED) {
            const before = typed.slice(0, s).some((t) => t[k] !== undefined), corrected = stale.some((x) => x.k === k && x.from === s);
            if (before && asked.has(k) && !corrected) { totals.shared_reasked++; fault(`s${s + 1}: ${k} was asked again though already answered`); }
            if (!before && !asked.has(k)) fault(`s${s + 1}: ${k} was never asked, yet nothing was given`);
            if (corrected && !asked.has(k)) fault(`s${s + 1}: ${k} was corrected but not asked again`);
          }
          const prep = (await json(`select id, payload, payload_hash, card_lines from public.career_apply_prepared where user_id = '${uid}' and job_id = '${form.job_id}' and state in ('ready', 'shown') order by created_at desc limit 1`))[0];
          if (!prep) { totals.not_ready++; fault(`s${s + 1}: ${form.company} was not prepared: ${JSON.stringify(out)}`); continue; }
          totals.applications++;
          const fields: Record<string, { value: string; factId: string }> = Object.fromEntries((prep.payload.fields ?? []).map((f: any) => [f.name, { value: String(f.value), factId: String(f.factId) }]));
          const rows = new Map<string, { key: string; answer: string }>((await json(`select id, key, answer from public.career_apply_questions where user_id = '${uid}' and state = 'answered'`)).map((r: any) => [`text-answer:${r.id}`, r]));
          const review = reviewOf({ id: prep.id, payload: prep.payload, payload_hash: prep.payload_hash, card_lines: prep.card_lines });
          for (const k of [...SHARED, ...PER_APP]) {
            const f = fields[nameOf[k]];
            totals.answers_checked++;
            if (!f) { fault(`s${s + 1}: ${k} is missing from the application`); continue; }
            // (a) only the person's own typed answer: the latest one they typed for this question in a session it applies to.
            const latest = PER_APP.includes(k) ? given[k] : [...typed].reverse().find((t) => t[k] !== undefined)?.[k];
            const row = rows.get(f.factId);
            if (latest === undefined || formValue(k, latest) !== f.value || !row || norm(row.answer) !== norm(latest)) {
              totals.unconfirmed_used++; fault(`s${s + 1}: ${k} = "${f.value}" (${f.factId}) is not the answer the person gave${latest === undefined ? " (they gave none here)" : ` ("${latest}")`}`);
            }
            for (const re of p.never ?? []) if (re.test(f.value)) { totals.unconfirmed_used++; fault(`s${s + 1}: ${k} = "${f.value}" came from something said in chat, not an answer`); }
            // (b) reused: same source as the earlier application, and shown as theirs on the review.
            if (prevFields && SHARED.includes(k) && !asked.has(k)) {
              totals.reused++;
              const src = review.answers.find((a) => a.question === Q[k])?.source ?? "";
              if (prevFields[nameOf[k]]?.factId !== f.factId || !/your answer|you confirmed|your confirmed/i.test(src)) { totals.reuse_unmarked++; fault(`s${s + 1}: reused ${k} shown as "${src}" (${f.factId})`); }
            }
            // (c) per application: this employer's own answer, never another employer's row.
            if (PER_APP.includes(k) && row && !row.key.startsWith("job:")) { totals.sensitive_reused++; fault(`s${s + 1}: ${k} is kept under ${row.key}, which travels to other employers`); }
            if (PER_APP.includes(k) && prevFields && prevFields[nameOf[k]]?.factId === f.factId) { totals.sensitive_reused++; fault(`s${s + 1}: ${k} is the previous employer's answer (${f.factId})`); }
            // (d) a corrected value never comes back.
            for (const st of stale.filter((x) => x.k === k && x.from <= s)) if (st.re.test(f.value)) { totals.stale_after_correction++; fault(`s${s + 1}: ${k} = "${f.value}" was corrected in session ${st.from + 1}`); }
          }
          log.push(`[s${s + 1}] ${form.company} application: ${review.answers.map((a) => `${a.question}: ${a.answer} [${a.source}]`).join("; ")}`);
          prevFields = fields;
        }
        cases.push({ id: p.id, asked: p.sessions.map((x) => x.say.join(" | ")).join(" || "), reply: log.join("\n\n"), intent: null, faults });
      }
      const bar = totals.unconfirmed_used === 0 && totals.reuse_unmarked === 0 && totals.sensitive_reused === 0 && totals.stale_after_correction === 0 && totals.not_ready === 0;
      await reportLoop({ item: 9, file: "9-apply", name: "memory-applications", numbers: totals, bar: "unconfirmed_used == 0 && reuse_unmarked == 0 && sensitive_reused == 0 && stale_after_correction == 0 && not_ready == 0", pass: bar, cases });
      assertNode.equal(Number(await pg.sql(`select count(*) from public.career_apply_jobs`)), 0, "nothing approved or queued to send");
      assertNode.equal(sink.submits, 0, "the engine never ran a send");
      assertNode.deepStrictEqual(outbound, [], "no real host was asked");
      assertNode.ok(totals.sessions >= 15 && totals.applications >= 15, `every session ended in a prepared application: ${JSON.stringify(totals)}`);
      assertNode.deepStrictEqual(cases.filter((c) => c.faults.length).map((c) => `${c.id}: ${c.faults.join("; ")}`), []);
    } finally {
      globalThis.fetch = realFetch;
      h?.restore();
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
