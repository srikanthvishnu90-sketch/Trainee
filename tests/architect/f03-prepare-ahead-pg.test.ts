// FEATURE 3 (D-011; backend gap map G4): applications are prepared before the person asks, on a real Postgres 16 with
// the career schema:
//   chat       the resume pasted and confirmed, and "Watch for data analyst roles in Chicago", through handleChat
//              (agent-chat/handler-career.ts), the production handler; their name and email are answers on file
//   the run    career-proactive's handleProactive with CAREER_PREPARE_AHEAD=on: the alert settings row (supabaseAlertStore),
//              the watch record, today's postings, supabaseAheadStore over the database, and the queue path's own
//              preparation (workers/career-browser/prepare-ahead.ts aheadPrepare -> prepareOne): the person's trusted
//              profile, the resume tailored to each posting (career_tailor.ts tailorForPosting, edgeRenderer), a cover note
//              drafted from their confirmed facts (essay_draft.ts draftEssay), career_apply_prepare_for
//   the card   ONE card a day through career_apply_card_push_as: "8/10 applications ready for your yes", the stops named
// Faked: the job board (rows in career_postings), the employer pages (the engine's dry run is a stub that answers as
// scripts/apply.ts does, so no browser is needed) and the model's words (a stub that writes one of the person's facts).
// Nothing is approved, queued or sent: career_apply_jobs stays empty.
// Fail-first: on the base (arch/diagnosis-1240) handleProactive has no prepare-ahead rail, so nothing is prepared and no
// card is pushed. Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/f03-prepare-ahead-pg.test.ts
import { confirmedResumeSql } from "../flow/resume-seed.ts"; // OWNER RULE 2026-10-26: the person has a confirmed resume
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { supabaseAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { supabaseAheadStore } from "../../supabase/functions/_shared/career_prepare_ahead.ts";
import { edgeRenderer, memoryResumeStore } from "../../supabase/functions/_shared/career_tailor.ts";
import { handleProactive } from "../../supabase/functions/career-proactive/handler.ts";
import { aheadPrepare, storedProfile, tailoredResume } from "../../workers/career-browser/prepare-ahead.ts";
import type { RunEngine } from "../../workers/career-browser/approve-first.ts";

const CI = Deno.env.get("CI") === "true";
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const HOUR = 3600000, SECRET = "s".repeat(40);
const _d = new Date(); const T0 = Date.UTC(_d.getUTCFullYear(), _d.getUTCMonth(), _d.getUTCDate() + 1, 15); // 11:00 New York tomorrow
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const PERSON = "00000000-0000-4000-8000-0000000f0301";
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

// The engine's dry run, as scripts/apply.ts answers it: the form filled from the facts file it was given (their own
// answers only), the resume file it was given by its hash. Two employers' pages stop it: one asks for a login, one fails.
function fakeEngine(stops: Record<string, "login" | "crash">): { run: RunEngine; calls: string[] } {
  const calls: string[] = [];
  const run: RunEngine = async (args) => {
    const arg = (k: string) => args[args.indexOf(k) + 1];
    const url = arg("--url"), facts = JSON.parse(await Deno.readTextFile(arg("--facts"))), pdf = await Deno.readFile(arg("--resume"));
    calls.push(url);
    if (stops[url] === "crash") throw new Error("the employer page did not load");
    if (stops[url] === "login") return { result: { state: "not_submitted", reason: "LOGIN_REQUIRED" }, evidence: null };
    const said = JSON.stringify(facts);
    if (!said.includes("Alex") || !said.includes("alex.testcase@example.test")) return { result: { state: "not_submitted", reason: "MISSING_FACTS" }, evidence: null };
    const sha = hex(await crypto.subtle.digest("SHA-256", pdf));
    const posting = `greenhouse:${new URL(url).pathname.split("/")[1]}:${url.split("/").pop()}`;
    return {
      result: { state: "not_submitted", reason: "dry_run" },
      evidence: {
        approval_hash: hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${posting}|${sha}`))),
        fields: [
          { name: "first_name", label: "First name", value: "Alex", factId: "fact:first_name" },
          { name: "email", label: "Email", value: "alex.testcase@example.test", factId: "fact:email" },
          { name: "resume", label: "Resume", value: sha, factId: "resume" },
        ],
        sources: {}, readback: {},
        payload: { user_id: facts.user_id, posting, company: facts.posting?.company ?? "", destination: url, resume: { sha256: sha, filename: "resume.pdf" }, page_fields: {} },
      },
    };
  };
  return { run, calls };
}
// The model's words: the first of the person's confirmed facts it was shown, as one sentence (it passes the fact lock).
const coverModel = async (payload: any) => {
  const line = String(payload.messages[0].content).split("\n").find((l: string) => l.startsWith("- ["))!;
  const parts = line.replace(/^- \[[^\]]*\]\s*/, "").split("; ");
  let text = "";
  for (const p of parts) { if ((text + "; " + p).length > 400) break; text = text ? `${text}; ${p}` : p; }
  return { content: [{ type: "text", text: `${text.replace(/[.;,\s]+$/, "")}.` }], stop_reason: "end_turn" };
};

let jobs = 0;
async function board(pg: Pg, title: string, company: string, seen: number) {
  const n = ++jobs, slug = `co${n}`, id = `greenhouse:${slug}:${n}`, at = new Date(seen).toISOString();
  await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at)
    values ('${id}', 'greenhouse', '${slug}', '${company}', '${title}', 'Chicago, IL', 'https://boards.greenhouse.io/${slug}/jobs/${n}',
    '${title}. SQL, Python and dashboards for internal teams.', '${at}', '${at}', '${at}')`);
  return { id, url: `https://boards.greenhouse.io/${slug}/jobs/${n}` };
}

Deno.test({
  name: "FEATURE 3: today's best new matches are prepared before the person asks (tailored resume and cover note bound into the payload), and ONE card says 8/10 ready with each stop named; nothing is sent",
  sanitizeResources: false, sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    const pg = await startPg();
    let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realNow = Date.now;
    try {
      await supabaseParity(pg);
      await pg.sql(`insert into auth.users (id, email) values ('${PERSON}', 'ahead@example.test'); insert into public.profiles (id) values ('${PERSON}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
        ${confirmedResumeSql(PERSON)}`);
      handler = await careerHandler(pg, { "tok-ahead": PERSON });
      const admin: any = createClient(SUPABASE_URL, SERVICE_KEY);
      const chat = handler.chat("tok-ahead");
      const say = async (text: string, at: number) => {
        Date.now = () => at;
        try { const r = await chat.say(text); assert(r.status === 200, `${r.status} ${r.reply}`); return r; } finally { Date.now = realNow; }
      };
      // The setup the person did before today: their resume confirmed, a watch set, and their name and email given as
      // answers to the questions an earlier application asked (career_apply_questions, answered).
      await say(`here is my resume:\n${RESUME}`, T0 - 120000);
      const yes = await say("yes, that's my resume", T0 - 60000);
      eq([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], `profile on file: ${yes.reply}`);
      const watch = await say("Watch for data analyst roles in Chicago", T0);
      eq(watch.intent, "career_watch_create", watch.reply);
      await pg.sql(`insert into public.channel_contacts (contact, user_id, thread_id) values ('+15550003001', '${PERSON}', '${chat.thread()}');
        insert into public.career_apply_questions (user_id, key, kind, label, type, state, answer, answered_at) values
        ('${PERSON}', 'fact:first_name', 'fact', 'First name', 'input_text', 'answered', 'Alex', now()),
        ('${PERSON}', 'fact:last_name', 'fact', 'Last name', 'input_text', 'answered', 'Testcase', now()),
        ('${PERSON}', 'fact:email', 'fact', 'Email', 'input_text', 'answered', 'alex.testcase@example.test', now());
        insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, created_at)
        values ('${PERSON}', 'greenhouse:prior:1', 'Prior Analytics', 'https://boards.greenhouse.io/prior/jobs/1', '{}', repeat('a', 64), repeat('a', 64), 'submitted_unconfirmed', now() - interval '10 days');`);

      // Today's board: ten new data analyst postings at ten employers, one more at an employer they applied to 10 days
      // ago, a second one at the first employer, and a posting their watch does not match.
      const picked: { id: string; url: string; company: string }[] = [];
      for (let i = 1; i <= 10; i++) picked.push({ ...(await board(pg, "Data Analyst", `Employer ${String(i).padStart(2, "0")}`, T0 + HOUR - i * 60000)), company: `Employer ${String(i).padStart(2, "0")}` });
      const prior = await board(pg, "Data Analyst", "Prior Analytics", T0 + HOUR);
      const second = await board(pg, "Data Analyst", "Employer 01", T0 + HOUR - 30 * 60000);
      const other = await board(pg, "Marketing Manager", "Employer 11", T0 + HOUR);
      const engine = fakeEngine({ [picked[8].url]: "login", [picked[9].url]: "crash" });
      // The tailored renders are stored as Storage stores them (the bucket's object row), as in the other flow tests: the
      // queue takes an application only with its stored resume (OWNER RULE 2026-10-26, 20261026210016).
      const memResumes = memoryResumeStore();
      const resumes = { ...memResumes, put: async (path: string, pdf: Uint8Array) => {
        await memResumes.put(path, pdf);
        await pg.sql(`insert into storage.objects (bucket_id, name) values ('career-resumes', '${path}') on conflict (bucket_id, name) do nothing`);
      } };
      const before = await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${PERSON}'`);

      const run = async (at: number, on = true) => {
        let recorded: any = null;
        const posts = async (sql: string) => JSON.parse((await pg.sql(`select coalesce(jsonb_agg(to_jsonb(p)), '[]') from public.career_postings p ${sql}`)) || "[]");
        const res = await handleProactive(new Request("http://local/career-proactive", { method: "POST", headers: { "x-trainee-proactive-secret": SECRET } }), {
          env: { get: (k: string) => (k === "CAREER_PROACTIVE_SECRET" ? SECRET : k === "CAREER_PREPARE_AHEAD" ? (on ? "on" : undefined) : undefined) }, now: () => at,
          store: () => supabaseAlertStore(admin),
          recentPostings: (since) => posts(`where closed_at is null and first_seen_at > '${since}'`),
          postingsById: (ids) => posts(`where job_id in (${ids.map((i) => `'${i}'`).join(",") || "''"})`),
          quiet: async (ids) => new Set(((await admin.rpc("career_quiet_users", { p_users: ids })).data ?? []).map((r: any) => String(r.user_id))),
          watches: async (ids) => {
            const out = new Map<string, unknown>();
            const { data, error } = await admin.from("career_watch_kv").select("user_id,value").in("user_id", ids).in("key", ids.map((u) => `career:watch-profile:${u}`));
            if (error) throw new Error(error.message);
            for (const r of data ?? []) out.set(String(r.user_id), r.value);
            return out;
          },
          prepareAhead: {
            store: () => supabaseAheadStore(admin),
            prepare: aheadPrepare({
              admin,
              base: { db: admin, runEngine: engine.run, profileFor: storedProfile(admin), resumeFor: tailoredResume({ render: edgeRenderer(), resumes }), now: () => at },
              cover: { newMeter: () => ({ calls: 0 }), call: (payload) => coverModel(payload) },
            }),
          },
          recordRun: async (r) => { recorded = r; },
        });
        assert(res.status === 200, `career-proactive answered ${res.status}: ${await res.text()}`);
        return recorded;
      };
      const cards = async () => JSON.parse((await pg.sql(`select coalesce(jsonb_agg(jsonb_build_object('key', key, 'text', text) order by id), '[]') from public.career_outbox where user_id = '${PERSON}' and kind = 'card'`)) || "[]");
      const prepared = async () => JSON.parse((await pg.sql(`select coalesce(jsonb_agg(jsonb_build_object('job_id', job_id, 'company', company, 'state', state, 'payload', payload,
        'hash_ok', payload_hash = encode(sha256(convert_to(public.career_apply_canonical(payload), 'UTF8')), 'hex'), 'lines', card_lines) order by company), '[]')
        from public.career_apply_prepared where user_id = '${PERSON}'`)) || "[]");

      await t.step("off by default: with CAREER_PREPARE_AHEAD unset the run prepares nothing and pushes no card", async () => {
        const r = await run(T0 + 2 * HOUR - 5 * 60000, false);
        eq([r.ahead_picked ?? null, (await prepared()).length, (await cards()).length, engine.calls.length], [null, 0, 0, 0], "nothing prepared");
      });

      await t.step("on: ten picked from today's matches (the employer applied to in 30 days, a second posting at one employer and the non-match left out); 8 ready, 2 stops", async () => {
        const r = await run(T0 + 2 * HOUR);
        eq([r.ahead_people, r.ahead_picked, r.ahead_ready, r.ahead_cards], [1, 10, 8, 1], `the run's counts (${JSON.stringify(r)})`);
        eq(engine.calls.sort(), picked.map((p) => p.url).sort(), "the engine ran once for each of the ten, and for nothing else");
        assert(!engine.calls.includes(prior.url) && !engine.calls.includes(second.url) && !engine.calls.includes(other.url), "the skipped ones never reached the engine");
        const rows = await prepared();
        const facts = JSON.parse(await pg.sql(`select coalesce((select state->'career'->'stores'->'profile'->'facts' from public.agent_flow_state where user_id = '${PERSON}' order by updated_at desc limit 1)::text, '[]')`));
        const confirmed = new Set((facts as any[]).filter((f) => f.status === "confirmed" && f.needs_confirmation === false && f.confirmation_event_id).map((f) => String(f.id)));
        eq(rows.map((x: any) => x.company), picked.slice(0, 8).map((p) => p.company), "the eight ready, one per employer");
        for (const x of rows) {
          assert(x.hash_ok, `the stored hash is the payload's own (${x.company})`);
          assert(x.payload.resume_tailored === true && resumes.files.has(`career-resumes/${PERSON}/${x.payload.resume_sha256}.pdf`), `the resume tailored to this posting is bound by its hash (${x.company})`);
          assert(typeof x.payload.cover_note?.text === "string" && x.payload.cover_note.text.length > 20 && x.payload.cover_note.fact_ids.length > 0, `a cover note from their confirmed facts is in the payload (${x.company}): ${JSON.stringify(x.payload.cover_note)}`);
          assert(x.lines.includes(`Cover note: ${x.payload.cover_note.text}`), `the card shows the cover note whole (${x.company})`);
          assert(x.payload.cover_note.fact_ids.every((id: string) => confirmed.has(id)), `the cover note cites only their confirmed facts (${JSON.stringify(x.payload.cover_note.fact_ids)})`);
        }
        const attempts = JSON.parse(await pg.sql(`select coalesce(jsonb_agg(jsonb_build_object('job', posting_job_id, 'outcome', outcome) order by posting_job_id), '[]') from public.career_apply_prepare_attempts where user_id = '${PERSON}'`));
        eq(attempts.filter((a: any) => a.outcome !== "ready").map((a: any) => [a.job, a.outcome]), [[picked[9].id, "error"], [picked[8].id, "refused"]], "every try recorded");
      });

      await t.step("one card: \"8/10 applications ready for your yes\", the ready ones exactly as the card shows them, each stop named; nothing is sent", async () => {
        const c = await cards();
        eq(c.length, 1, "one card");
        const text: string = c[0].text;
        assert(text.startsWith("8/10 applications ready for your yes."), text);
        assert(text.includes(`- Employer 09 (Data Analyst): the application form could not be filled ahead (LOGIN_REQUIRED)`), text);
        assert(text.includes(`- Employer 10 (Data Analyst): preparing it failed (the employer page did not load)`), text);
        assert(/1\. Employer 01/.test(text) && text.includes("Cover note: "), text);
        assert(/\d+ more ready: say "show my applications"/.test(text), `the rest are named as waiting, not dropped: ${text}`);
        eq(await pg.sql(`select count(*) from public.career_apply_cards where user_id = '${PERSON}' and state = 'open'`), "1", "the card is open for their tap");
        eq(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${PERSON}'`), before, "nothing queued or sent: the tap is the only approval");
      });

      await t.step("once a day: a later run the same day prepares nothing more and pushes no second card", async () => {
        const n = engine.calls.length;
        await board(pg, "Data Analyst", "Employer 12", T0 + 3 * HOUR);
        const r = await run(T0 + 4 * HOUR);
        eq([r.ahead_picked, r.ahead_cards, engine.calls.length, (await cards()).length], [0, 0, n, 1], "the day's work is done");
      });
    } finally {
      handler?.restore();
      await pg.stop();
    }
  },
});
