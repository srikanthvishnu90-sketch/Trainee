// MASS APPLY, MISSING INFORMATION, END TO END (owner requirement, 2026-11-02). When Trainee lacks something an application needs
// (a resume, a phone number, work authorization, an employer's own question) it must ASK for exactly that, ONE thing at a time,
// save the answer as a confirmed fact, keep preparing, and show the finished application on the results page ("What will be
// sent" and a black Apply). It never invents an answer (D-007), never takes a password, a code or an ID number, and sends nothing
// before the person's tap.
//
// This test follows that path with the production code on a real Postgres 16 (tests/flow/pg.ts, every migration):
//   chat     the REAL agent-chat career handler (handler-career.ts handleChat) over the flow harness's PostgREST double: the
//            questions turn ("what do you need from me", numbered answers, "skip"), the apply turn, prepareAfterAnswers
//   page     the REAL results page (trainee-file handler.ts handleFile) with the deployed deps (deps.ts buildFileDeps: the
//            supabase stores, supabaseQuestionStore, reprepareQueued, pendingRows): Apply on a card that is not ready ->
//            "A few things first" (gate()), the form's answers (checkAnswer + store.answer), want + reprepare, the card
//   prepare  prepare-ahead.ts prepareAhead (the hosted preparation's own code) with the database's candidate rule, the
//            question writers (career_apply_prepare_ask_for), the card writer (career_apply_prepare_for)
// The one named stand-in is the BROWSER: the engine that opens the employer's form (scripts/apply.ts, Playwright). It is
// replaced here by an engine that takes the form's fields (below) through the engine's OWN planner and contract
// (scripts/apply.ts trustedFacts + planApplication: the same code that decides, in the real engine, what is answered, what is
// asked and what is refused) and returns the engine's own result shapes (needs_answers with its questions, or the dry run).
// Nothing reaches an employer, Telegram, a model or any real host. The reprepare door (CAREER_PREPARE_AHEAD_URL) is a stand-in
// that records the kick; the test then runs the preparation for exactly the ids it was asked for.
//
// Run (any user; no Playwright needed):
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/missing-info-e2e.test.ts
import assertNode from "node:assert/strict";
import { basename } from "node:path";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { type Chat, careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { type AheadDeps, prepareAhead, type PreparedResume, storedProfile } from "../../workers/career-browser/prepare-ahead.ts";
import type { RunEngine } from "../../workers/career-browser/approve-first.ts";
import { applicationApprovalHash, planApplication, trustedFacts } from "../../scripts/apply.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { questionFieldType } from "../../supabase/functions/_shared/career_apply.ts";
import { rowQuestionLabel, rowQuestionType } from "../../supabase/functions/_shared/row_answer.ts";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { buildFileDeps } from "../../supabase/functions/trainee-file/deps.ts";
import { feedUrlsFor } from "../../supabase/functions/_shared/file_link.ts";
import { supabaseFileStore } from "../../supabase/functions/trainee-file/store.ts";
import { type Picked, resultsFile, whatOf } from "../../supabase/functions/_shared/role_results.ts";
import { searchTextOf } from "../../supabase/functions/_shared/posting_constraints.ts";
import { phonePost, signedIn } from "./file-session-fakes.ts";
import { questionLine } from "../helpers/one_question.ts";
import { cardOf, plain, refIn } from "../helpers/results_world.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const RESUME_TEXT = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000000c1";
const SECRET = "missing-info-link-secret-0123456789-abcdef", BASE = "https://trainee.example/file";
const KICK_URL = "http://prepare.test/functions/v1/career-cloud-runner/prepare", KICK_TOKEN = "TEST-missing-info-prepare-token-0123456789abcdef";
const FILE = new TextEncoder().encode("%PDF-1.4\n% TEST synthetic resume file for the missing-information flow, not a real person\n%%EOF\n");
const b64 = (b: Uint8Array) => { let s = ""; for (const c of b) s += String.fromCharCode(c); return btoa(s); };
const sha256 = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------------------------------------- the employers' forms
// Each posting's form as the engine reads it (the field list scripts/apply.ts observes): name, email, phone, work rights,
// and, on some, a question only that employer asks, or one Trainee must never collect.
const yn = [{ label: "Yes", value: "1" }, { label: "No", value: "0" }];
const SPONSOR = "Will you now or in the future require sponsorship for employment visa status?";
const AUTH = "Are you legally authorized to work in the United States?";
const WHY = "Why do you want to work at Globex?";
const SSN = "Enter your Social Security Number";
const base = () => [
  { name: "first_name", label: "First name", type: "input_text", required: true, options: [] },
  { name: "last_name", label: "Last name", type: "input_text", required: true, options: [] },
  { name: "email", label: "Email", type: "input_text", required: true, options: [] },
  { name: "phone", label: "Phone", type: "input_text", required: true, options: [] },
  { name: "sponsorship", label: SPONSOR, type: "radio", required: true, options: yn },
  { name: "work_auth", label: AUTH, type: "radio", required: true, options: yn },
];
type Form = { job_id: string; company: string; title: string; url: string; schema: any[] };
const FORMS: Form[] = [
  { job_id: "greenhouse:acme:1", company: "Acme Web", title: "Frontend Engineering Intern", url: "https://boards.greenhouse.io/acme/jobs/1", schema: base() },
  { job_id: "greenhouse:globex:2", company: "Globex", title: "Frontend Intern", url: "https://boards.greenhouse.io/globex/jobs/2",
    schema: [...base(), { name: "why", label: WHY, type: "textarea", required: true, options: [] }] },
  { job_id: "greenhouse:initech:3", company: "Initech", title: "UI Engineer Intern", url: "https://boards.greenhouse.io/initech/jobs/3",
    schema: [...base(), { name: "ssn", label: SSN, type: "input_text", required: true, options: [] }] },
];
const [ACME, GLOBEX, INITECH] = FORMS;

// ---------------------------------------------------------------------------------------------- the stand-in browser
// The engine's own decision (trustedFacts + planApplication), the engine's own result shapes. It never submits: a send needs
// the engine with --submit --approved, which this stand-in refuses (counted, and the test fails on it).
function standInEngine(sink: { runs: string[]; submits: number }): RunEngine {
  return async (args) => {
    if (args.includes("--submit") || args.includes("--approved")) { sink.submits++; throw Error("the missing-information flow never submits"); }
    const url = args[args.indexOf("--url") + 1];
    const form = FORMS.find((f) => f.url === url);
    if (!form) return { result: { state: "not_submitted", reason: "NO_SUCH_FORM" }, evidence: null };
    sink.runs.push(form.job_id);
    const facts = JSON.parse(await Deno.readTextFile(args[args.indexOf("--facts") + 1]));
    const resumePath = args[args.indexOf("--resume") + 1];
    const artifact = { filename: basename(resumePath), sha256: await sha256(await Deno.readFile(resumePath)) };
    const manifest = trustedFacts(facts, artifact);
    const p = planApplication({ manifest, userId: facts.user_id, jobId: form.job_id, employer: form.company, schema: form.schema, artifact, now: Date.now() });
    if (!p.ready) {
      const questions = p.needs.map((n: any) => {
        const f = form.schema.find((x) => (n.field_name ? x.name === n.field_name : x.label === n.label)) || {};
        const all = f.options || [];
        return { label: rowQuestionLabel(f) || n.label, type: rowQuestionType(f, form.job_id, questionFieldType(f)), options: all.length <= 60 ? all.map((o: any) => String(o.label)) : [] };
      });
      return { result: { state: "not_submitted", reason: "needs_answers", posting: form.job_id, company: form.company, fields: p.needs.map((n: any) => n.label), questions } as any, evidence: null };
    }
    const schemaHash = await hashApplyPayload(form.schema);
    const approval = await applicationApprovalHash({ userId: facts.user_id, posting: form.job_id, destination: url, fields: p.fields, resumeSha256: artifact.sha256, schemaHash, pageFieldNames: [], manifest });
    const readback: Record<string, string> = {};
    for (const f of p.fields) { const sf = form.schema.find((x) => x.name === f.name); const o = sf?.options?.find((x: any) => x.value === f.value || x.label === f.value); if (o) readback[f.name] = o.label; }
    return { result: { state: "not_submitted", reason: "dry_run" }, evidence: {
      approval_hash: approval, schema: form.schema, fields: p.fields, readback, sources: manifest.byFactId, replay_sources: Object.values(manifest.byFactId),
      trust: { quarantine_version: manifest.version, manifest_hash: manifest.hash },
      payload: { user_id: facts.user_id, posting: form.job_id, company: form.company, destination: url, resume: artifact, page_fields: {}, schema_hash: schemaHash, verification: [] },
    } } as any;
  };
}

// ---------------------------------------------------------------------------------------------- the test
Deno.test({
  name: "Missing information, end to end: ask for exactly what an application lacks, one thing at a time, by chat or on the page; save it as a confirmed fact; prepare again; the card shows What will be sent and Apply; nothing is sent before the tap",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw Error("the missing-information flow needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    const pg = await startPg();
    const work = await Deno.makeTempDir({ prefix: "trainee-missing-info-" });
    const saved: Record<string, string | undefined> = {};
    const setEnv = (k: string, v: string) => { if (!(k in saved)) saved[k] = Deno.env.get(k); Deno.env.set(k, v); };
    let agentChat: Awaited<ReturnType<typeof careerHandler>> | null = null;
    let ok = true;
    const step = async (name: string, fn: () => Promise<void>) => { if (ok) ok = await t.step(name, fn); };
    try {
      await supabaseParity(pg);
      await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
        ${FORMS.map((f) => `('${f.job_id}', 'greenhouse', '${f.job_id.split(":")[1]}', '${f.company}', '${f.title}', 'Chicago, IL', '${f.url}', 'Build product UI in React and TypeScript.', now(), now())`).join(",")};
        insert into auth.users (id, email) values ('${PERSON}', '${PERSON}@example.test');
        insert into public.profiles (id) values ('${PERSON}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
      setEnv("CAREER_PREPARE_AHEAD_URL", KICK_URL);
      setEnv("CAREER_PREPARE_AHEAD_TOKEN", KICK_TOKEN);
      agentChat = await careerHandler(pg, { "tok-person": PERSON });
      const chat: Chat = agentChat.chat("tok-person");
      const double = agentChat.double;
      // The reprepare door (named stand-in): records every kick; the preparation it starts runs when the test says so.
      const kicks: { user_id: string; job_ids: string[]; auth: string }[] = [];
      const outbound: string[] = [];
      const harnessFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        if (req.url === KICK_URL) { kicks.push({ ...(await req.json()), auth: req.headers.get("authorization") ?? "" }); return new Response("{}", { status: 202 }); }
        if (new URL(req.url).origin === new URL(SUPABASE_URL).origin) return await harnessFetch(req);
        outbound.push(req.url);
        return Promise.reject(new Error(`the missing-information flow reaches no real host: ${req.url}`));
      }) as typeof fetch;
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false }, global: { fetch: double.fetch as typeof fetch } });

      // ---------------------------------------------------------------- helpers
      const sink = { runs: [] as string[], submits: 0 };
      const keptResume = async (_c: unknown, dir: string): Promise<PreparedResume | null> => {
        const r = await admin.rpc("career_apply_cloud_resume_kept_for", { p_user: PERSON });
        if (r.error || !r.data) return null;
        const bytes = Uint8Array.from(atob(r.data.b64), (c) => c.charCodeAt(0));
        const path = `${dir}/${r.data.filename}`;
        await Deno.writeFile(path, bytes);
        return { path, sha256: r.data.sha256, tag: null };
      };
      const deps = (): AheadDeps => ({ db: admin as any, runEngine: standInEngine(sink), profileFor: storedProfile(admin as any), resumeFor: keptResume, tmpRoot: work });
      const sql = (s: string) => pg.sql(s);
      const json = async (s: string) => JSON.parse((await sql(`select coalesce(json_agg(x), '[]') from (${s}) x`)) || "[]");
      const openQs = () => json(`select key, label, kind, job_ids, company from public.career_apply_questions where user_id = '${PERSON}' and state = 'open' order by created_at, key`);
      const applications = async () => Number(await sql(`select count(*) from public.career_apply_jobs where user_id = '${PERSON}'`));
      const nothingSent = async (why: string) => { eq(await applications(), 0, `${why}: nothing was approved or queued to send`); eq(sink.submits, 0, `${why}: the engine never ran a send`); eq(outbound, [], `${why}: no real host was asked`); };
      const say = async (message: string) => { const r = await chat.say(message); eq(r.status, 200, r.reply); return r; };
      // Run the preparation the kick asked for: exactly the ids it named, for the person it named, as the hosted door runs it.
      let kicked = 0;
      const runKicked = async () => {
        const out: any[] = [];
        while (kicked < kicks.length) {
          const k = kicks[kicked++];
          eq(k.auth, `Bearer ${KICK_TOKEN}`, "the kick carries the owner's token");
          eq(k.user_id, PERSON);
          out.push(...await prepareAhead(deps(), { only: { user_id: k.user_id, job_ids: k.job_ids }, perPerson: 25, limit: 500 }));
        }
        return out;
      };
      const prepareNow = async (ids: string[]) => await prepareAhead(deps(), { only: { user_id: PERSON, job_ids: ids }, perPerson: 25, limit: 500 });

      // The results page (the person's signed-in phone browser), over the deployed deps.
      const A = signedIn();
      const env: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE, TRAINEE_BOT_URL: "https://t.me/TraineeBot", SUPABASE_URL,
        CAREER_PREPARE_AHEAD_URL: KICK_URL, CAREER_PREPARE_AHEAD_TOKEN: KICK_TOKEN };
      const pageDeps = { ...buildFileDeps(admin, { get: (k) => env[k] }, () => Date.now()), sessions: A.store, phone: A.phone.auth };
      const store = supabaseFileStore(admin);
      const picked: Picked[] = FORMS.map((f, i) => ({
        hit: { job_id: f.job_id, company: f.company, title: f.title, location: "Chicago, IL", url: f.url, first_seen_at: null, role_match: true, fit: { score: 80 - i, bucket: null, excluded: false, reasons: [], gaps: [] }, pay: null },
        posting: { job_id: f.job_id, provider: "greenhouse", company: f.company, title: f.title, location: "Chicago, IL", url: f.url, description: "Build product UI in React and TypeScript.", remote: null, posted_at: null, first_seen_at: null, pay: null } as Picked["posting"],
      }));
      const ask = searchTextOf("I want frontend internships in Chicago");
      const made = await resultsFile({ userId: PERSON, now: Date.now(), what: whatOf({ role: ask.role, place: ask.place, remote: ask.remote, limits: ask.limits }), floor: null, picked, store,
        links: (u, l) => feedUrlsFor({ get: (k) => env[k] }, u, l, Date.now()) });
      assert(made, "the results page was made");
      const session = await A.tok(PERSON, made!.listId, Date.now());
      const pageGet = async (query = "") => await handleFile(new Request(`${BASE}${query ? `?${query}` : ""}`, { headers: { cookie: `tf_s=${session}` } }), pageDeps);
      const pagePost = async (f: Record<string, string>, pick: string[] = []) => {
        const init = await phonePost({ ...f, t: session }, SECRET);
        if (pick.length) init.body = String(init.body) + pick.map((p) => `&pick=${encodeURIComponent(p)}`).join("");
        return await handleFile(new Request(BASE, init), pageDeps);
      };
      const listHtml = async () => await (await pageGet()).text();
      const refOf = (html: string, f: Form) => refIn(html, f.title, f.company);
      const tagOf = (html: string, ref: string) => /name="tag" value="([^"]*)"/.exec(cardOf(html, ref))?.[1] ?? "none";
      const tapApply = async (f: Form) => { const html = await listHtml(); const ref = refOf(html, f); return await pagePost({ action: "apply", ref, tag: tagOf(html, ref) }); };
      const thingsOf = (html: string) => ({ text: plain(html), fields: [...new Set([...html.matchAll(/name="(q_[0-9a-f-]+)"/g)].map((m) => m[1]))] });
      void prepareNow;

      // What the person sees on the page for one role, and the form of "A few things first" when Apply opened it.
      const cardHtml = async (f: Form) => { const html = await listHtml(); return cardOf(html, refOf(html, f)); };
      const wantedKeys = async () => (await json(`select posting_key, state from public.career_apply_wanted where user_id = '${PERSON}' order by posting_key`)).map((w: any) => `${w.posting_key}:${w.state}`);
      const ONE = /(?:One question|Question 1 of \d+) only you can answer/g;
      // The chat shows ONE question; the whole reply names just that one.
      const shownQuestion = async () => {
        const r = await say("what do you need from me");
        eq(r.resultStatus, "shown", r.reply);
        eq((r.reply.match(ONE) ?? []).length, 1, `one question per message: ${r.reply}`);
        return { reply: r.reply, line: questionLine(r.reply) };
      };

      // =========================================================================================== 1. no resume at all
      await step("1. no resume: the chat asks for it and queues nothing; the page asks for it too, and does not claim to be preparing", async () => {
        const r = await say(`apply to the ${ACME.title} role at ${ACME.company}`);
        eq(r.intent, "career_apply_queue", r.reply);
        assert(/resume/i.test(r.reply) && /Paste or attach your resume/.test(r.reply), `the chat asks for the resume: ${r.reply}`);
        eq(await wantedKeys(), [], "the chat queued nothing");
        const res = await tapApply(ACME);
        const said = plain(await res.text());
        assert(/resume/i.test(said), `the page asks for the resume: ${said.slice(0, 900)}`);
        assert(!/Getting your application ready/.test(said), "the page does not say it is preparing an application it cannot prepare");
        eq(await wantedKeys(), [], "the page queued nothing without a resume");
        eq(kicks.length, 0, "no preparation was started without a resume");
        await nothingSent("no resume");
      });

      // =========================================================================================== 2. resume pasted; three roles queued
      await step("2. the resume is pasted and confirmed in chat; the three roles are queued (nothing prepared or sent by that)", async () => {
        const pasted = await say(`here is my resume:\n${RESUME_TEXT}`);
        eq(pasted.intent, "career_resume_ingest", pasted.reply);
        const yes = await say("yes, that's my resume");
        eq([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
        for (const f of FORMS) {
          const r = await say(`apply to the ${f.title} role at ${f.company}`);
          eq([r.intent, r.resultStatus], ["career_apply_queue", "queued"], r.reply);
        }
        eq((await wantedKeys()).length, 3);
        assert(kicks.length >= 1, "queueing started a preparation");
        await nothingSent("queued");
      });

      // =========================================================================================== 3. a name and an email nobody gave
      await step("3. the form needs a name and an email Trainee does not have: each is asked ONCE for all three roles, one per message, answers refused when wrong or sensitive", async () => {
        const done = await runKicked();
        eq(done.filter((d) => d.outcome === "asked").length, 3, JSON.stringify(done));
        eq((await openQs()).map((q: any) => q.key).sort(), ["fact:email", "fact:first_name", "fact:last_name"], "one shared question each, never one per role");
        const q1 = await shownQuestion();
        assert(/First name|Last name|Email/.test(q1.line) && ["First name", "Last name", "Email"].filter((w) => q1.reply.includes(w)).length === 1, `only one of the three questions is on screen: ${q1.reply}`);
        // A password, a code, an ID number is never taken as an answer; the question stays open and is asked again.
        for (const bad of ["my password is hunter2!", "my SSN is 123-45-6789"]) {
          const r = await say(bad);
          assert(/Nothing was saved|Still open/.test(r.reply) && !r.reply.includes("hunter2") && !r.reply.includes("123-45-6789"), `refused, not echoed: ${r.reply}`);
        }
        eq((await openQs()).length, 3, "nothing was saved from a refused answer");
        // Each question is answered as it comes, one per message, in whatever order they are asked.
        const answers: [RegExp, string][] = [[/First name/, "Alex"], [/Last name/, "Testcase"], [/Email/, "alex.testcase@example.test"]];
        let shown = q1.reply, kicksBefore = kicks.length, last = "";
        for (let n = 0; n < 3; n++) {
          const line = questionLine(shown);
          const hit = answers.find(([re]) => re.test(line));
          assert(hit, `a question the person can answer: ${shown}`);
          const r = await say(hit![1]);
          assert(/Saved/.test(r.reply), r.reply);
          last = r.reply;
          if (n < 2) { assert(/\nNext: /.test(r.reply) && (r.reply.match(ONE) ?? []).length === 1, `the next question alone: ${r.reply}`); shown = r.reply; }
        }
        assert(!/\nNext: /.test(last), `nothing left to ask: ${last}`);
        assert(kicks.length > kicksBefore, `the last answer started preparing again: ${last}`);
        assert(/preparing your application again now/i.test(last), last);
        const facts = await json(`select key, answer from public.career_apply_questions where user_id = '${PERSON}' and state = 'answered' order by key`);
        eq(facts.map((f: any) => [f.key, f.answer]), [["fact:email", "alex.testcase@example.test"], ["fact:first_name", "Alex"], ["fact:last_name", "Testcase"]], "saved as typed, nothing invented");
        await nothingSent("contact answered");
      });

      // =========================================================================================== 4. the resume file
      await step("4. a resume FILE to attach is missing: the person is told exactly that; once they send it and ask again, the applications are prepared (a past 'no resume' does not block them for a week)", async () => {
        const done = await runKicked();
        eq(done.map((d) => d.outcome).sort(), ["no_resume", "no_resume", "no_resume"], JSON.stringify(done));
        const st = await say("where are my applications");
        for (const f of FORMS) assert(st.reply.includes(f.company), st.reply);
        assert(/resume file/.test(st.reply) && /PDF or Word/.test(st.reply) && /Nothing was sent/.test(st.reply), `it asks for the file: ${st.reply}`);
        eq(await openQs(), [], "no invented question: the one thing missing is the file");
        // The person sends the file (the channel's confirmed upload; career_apply_cloud_resume_put_for). The applications waiting on it
        // start again by themselves: a preparation is asked for them, and the past "no resume" does not keep them out for a week.
        eq(await sql(`select public.career_apply_cloud_resume_put_for('${PERSON}', 'Alex_Testcase_Resume.pdf', '${b64(FILE)}')`), await sha256(FILE));
        const requests = await json(`select job_ids from public.career_apply_prepare_requests where user_id = '${PERSON}' and state = 'queued'`);
        eq(requests.flatMap((r: any) => r.job_ids).sort(), FORMS.map((f) => f.job_id).sort(), "sending the file asked for a preparation of every posting that waited on it");
        const again = await prepareNow(requests.flatMap((r: any) => r.job_ids));
        eq(again.map((d) => d.outcome), ["asked", "asked", "asked"], `prepared again after the file: ${JSON.stringify(again)}`);
        // Setup (named): the dispatcher ran those requests (the preparation above is what a sandbox does for one).
        await sql(`update public.career_apply_prepare_requests set state = 'done', finished_at = now() where user_id = '${PERSON}' and state = 'queued'`);
        await nothingSent("resume file sent");
      });

      // =========================================================================================== 5. phone, work rights, the employer's own question
      await step("5. phone, sponsorship, work authorization and Globex's own question are asked once, one at a time; an ID question is never asked", async () => {
        const all = await openQs();
        const keys = all.map((q: any) => q.key);
        eq(all.filter((q: any) => !q.key.startsWith("job:")).map((q: any) => q.label).sort(), [AUTH, "Phone", SPONSOR].sort(), `each shared question once, not once per role: ${keys.join(",")}`);
        const own = all.filter((q: any) => q.key.startsWith("job:"));
        eq(own.map((q: any) => [q.label, q.company]), [[WHY, GLOBEX.company]], "the employer's own question is bound to that employer alone");
        assert(!all.some((q: any) => /Social Security/i.test(q.label)), "an ID number is never a stored question");
        // By chat, in whatever order they come, one per message: the phone and sponsorship are answered (wrong or sensitive answers
        // refused, the question stays); work authorization and Globex's own question are left for later ("skip": they stay open).
        let now = (await shownQuestion()).reply;
        const done = new Set<string>();
        for (let n = 0; n < 8 && done.size < 2; n++) {
          const line = questionLine(now);
          if (/Phone/i.test(line)) {
            for (const bad of ["my password is hunter2!", "my SSN is 123-45-6789", "the verification code is 482913"]) {
              const r = await say(bad);
              assert(/Nothing was saved|Still open/.test(r.reply) && !/hunter2|123-45-6789|482913/.test(r.reply), `refused, not echoed: ${r.reply}`);
            }
            eq((await json(`select 1 x from public.career_apply_questions where user_id = '${PERSON}' and state = 'answered' and label = 'Phone'`)).length, 0, "no phone saved from a refused answer");
            now = (await say("312-555-0142")).reply;
            assert(/Saved/.test(now), now);
            done.add("phone");
          } else if (line.includes(SPONSOR)) {
            const maybe = await say("maybe");
            assert(/Nothing was saved|Still open/.test(maybe.reply) && /yes or a no|one of/i.test(maybe.reply), `never guessed: ${maybe.reply}`);
            now = (await say("no")).reply;
            assert(/Saved/.test(now), now);
            done.add("sponsorship");
          } else {
            const skipped = await say("skip");
            eq(skipped.resultStatus, "answered_next", skipped.reply);
            assert(/Left for later/.test(skipped.reply), skipped.reply);
            now = skipped.reply;
          }
          if (/\nNext: /.test(now)) eq((now.match(ONE) ?? []).length, 1, `one question per message: ${now}`);
          else if (done.size < 2) now = (await shownQuestion()).reply;
        }
        eq([...done].sort(), ["phone", "sponsorship"]);
        await nothingSent("phone and sponsorship answered");
      });

      // =========================================================================================== 6. the same by the page form
      await step("6. work authorization on the page's 'A few things first': a wrong answer is refused; a right one is saved as a fact and the role is prepared again WITHOUT waiting for other roles' questions", async () => {
        const res = await tapApply(ACME);
        const things = thingsOf(await res.text());
        assert(/A few things first/.test(things.text), things.text.slice(0, 400));
        eq(things.fields.length, 1, `only what is still missing for this role (phone and sponsorship were answered in chat): ${things.text.slice(0, 500)}`);
        assert(/authorized to work/i.test(things.text), things.text.slice(0, 500));
        const ref = refOf(await listHtml(), ACME);
        const post = async (v: string) => await (await pagePost({ action: "answer", ref, [things.fields[0]]: v })).text();
        const bad = plain(await post("maybe"));
        assert(/one of|yes or a no|needs/i.test(bad) && /Nothing was saved/.test(bad), `a wrong answer is refused: ${bad.slice(0, 500)}`);
        eq((await json(`select 1 x from public.career_apply_questions where user_id = '${PERSON}' and state = 'answered' and label = '${AUTH}'`)).length, 0);
        const before = kicks.length;
        const okBody = plain(await post("Yes"));
        eq((await json(`select answer from public.career_apply_questions where user_id = '${PERSON}' and label = '${AUTH}' and state = 'answered'`)).map((r: any) => r.answer), ["Yes"], "saved as a confirmed fact");
        assert(kicks.length > before, `Acme has nothing left to ask, so it is prepared again at once, though Globex's own question is still open: ${okBody.slice(0, 400)}`);
        await runKicked();
        const card = await cardHtml(ACME);
        const said = plain(card);
        assert(/What will be sent/.test(said), `the card shows what will be sent: ${said.slice(0, 700)}`);
        for (const x of ["First name Alex", "Last name Testcase", "Email alex.testcase@example.test", "Phone 312-555-0142"]) assert(said.includes(x), `${x}: ${said}`);
        assert(/class="apply"/.test(card), "a black Apply is on the card");
        await nothingSent("Acme ready");
      });

      // =========================================================================================== 7. the employer's own question
      await step("7. Globex's own question: refused with a password/ID/card in it on the page and in chat; a real answer by chat is kept word for word for Globex alone; then its card is ready", async () => {
        // The page's form first: an empty answer, and one carrying a password and an ID number, save nothing.
        const things = thingsOf(await (await tapApply(GLOBEX)).text());
        eq(things.fields.length, 1, things.text.slice(0, 500));
        assert(things.text.includes(WHY), things.text.slice(0, 500));
        const globexRef = refOf(await listHtml(), GLOBEX);
        for (const bad of ["", "Because my password: Tr0ub4dor&3 and SSN 123-45-6789"]) {
          const refused = await (await pagePost({ action: "answer", ref: globexRef, [things.fields[0]]: bad })).text();
          assert(/Nothing was saved/.test(plain(refused)) && !/Tr0ub4dor|123-45-6789/.test(refused), `the page refuses it and does not echo it: ${plain(refused).slice(0, 500)}`);
        }
        eq((await openQs()).length, 1, "nothing was saved from the page");
        const q = await shownQuestion();
        assert(q.line.includes(WHY), `Globex's own question is the one asked: ${q.reply}`);
        for (const bad of ["Because my password: Tr0ub4dor&3 and SSN 123-45-6789", "my card number is 4242 4242 4242 4242"]) {
          const r = await say(bad);
          assert(/Nothing was saved|Still open/.test(r.reply) && !/Tr0ub4dor|123-45-6789|4242/.test(r.reply), `refused, not echoed: ${r.reply}`);
        }
        eq((await openQs()).length, 1, "still open");
        const kicksBefore = kicks.length;
        const answer = "Globex ships weekly and I want to learn that pace.";
        const r = await say(answer);
        assert(/Saved/.test(r.reply) && /kept word for word/.test(r.reply), r.reply);
        assert(kicks.length > kicksBefore, "the last answer started preparing again");
        await runKicked();
        const html = await cardHtml(GLOBEX);
        const said = plain(html);
        assert(/What will be sent/.test(said) && said.includes(answer) && /class="apply"/.test(html), `Globex's card has its own answer and Apply: ${said.slice(0, 900)}`);
        assert(!plain(await cardHtml(ACME)).includes("Globex ships"), "Globex's answer is not on Acme's card");
        await nothingSent("Globex ready");
      });

      // =========================================================================================== 8. an ID number is never asked for
      await step("8. Initech's form asks for a Social Security Number: it is never asked by chat or on the page, and the role is not shown as ready", async () => {
        const r = await say("what do you need from me");
        assert(!/Social Security|SSN/i.test(r.reply), r.reply);
        const res = await tapApply(INITECH);
        const html = await res.text();
        assert(!/name="q_/.test(html), "no field for it on the page");
        assert(!/Social Security/i.test(plain(html).replace(/Enter your Social Security Number.*$/, "")), "never asked");
        assert(!/What will be sent/.test(plain(await cardHtml(INITECH))), "Initech is not shown as ready");
        await nothingSent("Initech");
      });

      // =========================================================================================== 8b. a stored question that asks for a secret
      await step("8b. even a question row that asks for an ID number (written by some other path) is never answered by chat or on the page", async () => {
        const key = `job:${"ab12cd34ef56ab78"}`;
        await sql(`select public.career_apply_questions_put_for('${PERSON}', '${INITECH.job_id}', ${"$q$"}[{"key":"${key}","kind":"fact","label":"${SSN}","type":"input_text","options":[],"company":"Initech","misfit":false}]${"$q$"}::jsonb)`);
        const row = (await json(`select id from public.career_apply_questions where user_id = '${PERSON}' and key = '${key}'`))[0];
        assert(row, "the secret question row exists (setup)");
        const answered = async () => (await json(`select 1 x from public.career_apply_questions where id = '${row.id}' and state = 'answered'`)).length;
        // Chat: whatever it shows, a number sent back is not saved.
        const shown = await say("what do you need from me");
        assert(!/123-45-6789/.test(shown.reply), shown.reply);
        const r = await say("123-45-6789");
        assert(!/123-45-6789/.test(r.reply), `never echoed: ${r.reply}`);
        eq(await answered(), 0, "chat saved no ID number");
        // Page: no box for it; a post that names it anyway saves nothing.
        const html = await (await tapApply(INITECH)).text();
        assert(!new RegExp(`<input[^>]*name="q_${row.id}"`).test(html), "the page draws no box for an ID number");
        const posted = await (await pagePost({ action: "answer", ref: refOf(await listHtml(), INITECH), [`q_${row.id}`]: "123-45-6789" })).text();
        assert(!/123-45-6789/.test(posted), "never echoed");
        eq(await answered(), 0, "the page saved no ID number");
        await sql(`delete from public.career_apply_questions where id = '${row.id}'`);
        await nothingSent("secret question");
      });

      // =========================================================================================== 9. the tap
      await step("9. only the person's tap on Apply queues exactly the prepared application", async () => {
        eq(await applications(), 0, "nothing was queued before the tap");
        const html = await listHtml();
        const ref = refOf(html, ACME);
        const prepared = (await json(`select id, payload_hash from public.career_apply_prepared where user_id = '${PERSON}' and job_id = '${ACME.job_id}' and state in ('ready','shown')`))[0];
        assert(prepared, "Acme is prepared");
        const said = plain(await (await pagePost({ action: "apply", ref, tag: tagOf(html, ref) })).text());
        assert(/Approved/.test(said), said.slice(0, 600));
        const q = await json(`select job_id, payload_hash, state from public.career_apply_jobs where user_id = '${PERSON}'`);
        eq(q.map((r: any) => [r.job_id, r.payload_hash, r.state]), [[ACME.job_id, prepared.payload_hash, "queued"]], "exactly the prepared payload, once, and nothing else");
        eq(sink.submits, 0, "approving sends nothing by itself");
      });
    } finally {
      agentChat?.restore();
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
