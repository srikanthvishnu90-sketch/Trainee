// APPLICATION LAYER REVIEW LOOP (agent2/app-layer, 2026-11-10; VERIFICATION-15 item 1; spec APP-LAYER-15-FIXES B.3, C.11
// F-09, C.12 F-10, E.3): a job request becomes the exact application shown for review, and one yes approves exactly that
// payload. N synthetic TEST profiles x M employer forms, each through the deployed preparation path:
//   facts      what each person confirmed: a resume confirmed on file (tests/flow/resume-seed.ts) and their own answers to
//              questions an earlier application asked (career_apply_questions, answered), nothing else
//   prepare    workers/career-browser/prepare-ahead.ts prepareOne, the queue path's own preparation: the trusted profile
//              (storedProfile), the trust contract, the REAL engine (scripts/apply.ts) dry run in Chromium on a local
//              employer page, career_apply_prepare_for (the stored payload, its hash and the card lines), or the questions
//              the form asks that nothing confirmed answers (career_apply_prepare_ask_for)
//   ask once   a question the person had already answered elsewhere is answered from that answer (as the setup of a
//              person who answered it before) and the posting prepared again; one nothing answers stays asked
//   the card   "show my applications" then "yes" through the production chat handler (handler-career.ts handleChat)
// For each case: every answer on the card traces to one of that person's confirmed answers (an unknown one is asked, never
// filled: D-007; a sensitive one is never taken in chat), the resume is the confirmed file and the target is the posting,
// and the hash the yes approves is the prepared payload's own; a stale yes and a yes after the payload changed approve
// nothing. Prints: APP-LAYER LOOP: cases X, answers Y, traced T, invented Z, hash match H/R, stale-yes refused S/S.
// Bar: 0 invented, 100% hash match, every stale yes refused. Nothing reaches an employer: the engine only dry-runs.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { engineRunner } from "../../workers/career-browser/approve-first.ts";
import { type Candidate, prepareOne, storedProfile } from "../../workers/career-browser/prepare-ahead.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const lit = (s: string) => `$q$${s}$q$`;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------------------------------- the employer forms
const input = (name: string, label: string, extra = "") => `<label for="${name}">${label}</label><input id="${name}" name="${name}" ${extra}>`;
const select = (name: string, label: string, opts: string[], req = true) =>
  `<label for="${name}">${label}</label><select id="${name}" name="${name}" ${req ? "required" : ""}><option value="">Select</option>${opts.map((o, i) => `<option value="${i + 1}">${o}</option>`).join("")}</select>`;
const BASE = [input("first_name", "First name", "required"), input("last_name", "Last name", "required"), input("email", "Email", 'type="email" required')];
const RESUME = `<label for="resume">Resume</label><input type="file" id="resume" name="resume" required>`;
const AUTH = select("auth", "Are you authorized to work in the United States?", ["Yes", "No"]);
const SPONSOR = select("sponsor", "Will you now or in the future require visa sponsorship?", ["Yes", "No"]);
const OUTSIDE = input("outside", "Will you continue an outside business while employed?", "required");
const WHY = `<label for="why">Why do you want to work here?</label><textarea id="why" name="why" required></textarea>`;
const SSN = input("ssn", "Social Security number", "required");
const GENDER = select("gender", "Gender (voluntary self-identification)", ["Female", "Male", "Decline to self-identify"], false);
export const FORMS: Record<string, { title: string; company: string; parts: string[] }> = {
  basic: { title: "Data Analyst Intern", company: "TEST Lakefront Analytics", parts: [...BASE, RESUME] },
  auth: { title: "Business Analyst Intern", company: "TEST Prairie Ledger", parts: [...BASE, AUTH, SPONSOR, RESUME] },
  unknown: { title: "Operations Analyst", company: "TEST Northline Data", parts: [...BASE, OUTSIDE, RESUME] },
  essay: { title: "Analytics Associate", company: "TEST Harbor Metrics", parts: [...BASE, WHY, RESUME] },
  sensitive: { title: "Data Analyst", company: "TEST Granite Payroll", parts: [...BASE, SSN, GENDER, RESUME] },
  // Self-identification and a date of birth: never filled from anything but this application's own answer.
  eeo: { title: "Reporting Analyst", company: "TEST Cedar Health", parts: [...BASE, GENDER, select("race", "Race or ethnicity (voluntary)", ["Asian", "Black or African American", "Hispanic or Latino", "White", "Decline to self-identify"], false), input("dob", "Date of birth", "required"), RESUME] },
  relocate: { title: "Junior Data Analyst", company: "TEST Birch Logistics", parts: [...BASE, select("relocate", "Are you willing to relocate?", ["Yes", "No"]), AUTH, RESUME] },
  // Interim ruling (d): a date of birth is asked only when the form requires it, per application, never reused or guessed.
  dobopt: { title: "Insights Analyst", company: "TEST Alder Retail", parts: [...BASE, input("dob", "Date of birth (optional)"), RESUME] },
  dob2: { title: "Claims Data Analyst", company: "TEST Spruce Insurance", parts: [...BASE, input("dob", "Date of birth", "required"), RESUME] },
};
// The posting a person asks for in chat (the step from "apply to ..." to the queue): a board link, served locally to the engine.
const CHATQ = { id: "greenhouse:testjuniper:9101", url: "https://boards.greenhouse.io/testjuniper/jobs/9101", title: "Data Analyst", company: "TEST Juniper Insights", form: { title: "Data Analyst", parts: [...BASE, AUTH, RESUME] } };
// The date of birth one person gives for one application (TEST Avery Quill at TEST Cedar Health), and only for it.
const DOB_GIVEN = { person: "00000000-0000-4000-8000-0000000a0001", form: "eeo", value: "1999-04-02" };
const page = (f: { title: string; parts: string[] }) => `<!doctype html><h1>${f.title}</h1><form method="post" action="/submit" enctype="multipart/form-data">${f.parts.join("")}<button type="submit">Submit application</button></form>`;

// ------------------------------------------------------------------------------------------------- the synthetic people
// answers: what each person confirmed before, by the question it answered (a regex over the label) and their words.
interface Profile { id: string; name: string; answers: [RegExp, string, string][] } // [label, key-hint, value]
const P = (n: number) => `00000000-0000-4000-8000-0000000a${String(n).padStart(4, "0")}`;
export const PROFILES: Profile[] = [
  { id: P(1), name: "TEST Avery Quill", answers: [[/first name/i, "first_name", "Avery"], [/last name/i, "last_name", "Quill"], [/email/i, "email", "avery.quill@example.test"],
    [/authorized to work/i, "", "Yes"], [/sponsorship/i, "", "No"], [/relocate/i, "", "Yes"]] },
  { id: P(2), name: "TEST Bo Lindqvist", answers: [[/first name/i, "first_name", "Bo"], [/last name/i, "last_name", "Lindqvist"], [/email/i, "email", "bo.lindqvist@example.test"]] },
  { id: P(3), name: "TEST Chidi Okafor-Brandt", answers: [[/first name/i, "first_name", "Chidi"], [/last name/i, "last_name", "Okafor-Brandt"], [/email/i, "email", "chidi.ob@example.test"],
    [/authorized to work/i, "", "No"], [/sponsorship/i, "", "Yes"]] },
  { id: P(4), name: "TEST Dana Ruiz", answers: [[/first name/i, "first_name", "Dana"], [/last name/i, "last_name", "Ruiz"], [/email/i, "email", "dana.ruiz@example.test"],
    [/authorized to work/i, "", "Yes"]] },
];

// Each answer the card shows, traced to the person's own confirmed answers; and each answer the application carries that the
// card does not show (sent, not on the card). Lines that are not answers (employer, resume, destination, page fields) are skipped.
export function traceCard(lines: string[], payload: any, confirmed: string[]): { label: string; value: string; traced: boolean }[] {
  const mine = new Set(confirmed.map(norm)), out: { label: string; value: string; traced: boolean }[] = [];
  for (const line of lines) {
    if (line === payload.company || /^(Resume|Also sent|Sends to|The page runs)\b/.test(line) || /^Cover note:/.test(line)) continue;
    const m = /^(.*?): (.*)$/.exec(line.replace(/^(You agree|Your statement|About this job): /, ""));
    if (!m) { out.push({ label: line, value: "", traced: false }); continue; }
    out.push({ label: m[1], value: m[2], traced: mine.has(norm(m[2])) });
  }
  for (const fl of Array.isArray(payload.fields) ? payload.fields : []) {
    if (fl.value === payload.resume_sha256 || (fl.value && typeof fl.value === "object")) continue;
    if (!lines.some((l) => l.includes(`${fl.label}: `))) out.push({ label: `${fl.label} (sent, not on the card)`, value: String(fl.value), traced: false });
  }
  return out;
}

// The loop's own check can fail: an answer nobody confirmed, and an answer sent but not shown, are both counted.
Deno.test("app-layer loop self-check: an invented answer and an answer sent off the card are caught", () => {
  const payload = { company: "TEST Co", resume_sha256: "a".repeat(64), fields: [{ label: "First name", value: "Avery" }, { label: "Phone", value: "555-0100" }, { label: "Resume", value: "a".repeat(64) }] };
  const got = traceCard(["TEST Co", "First name: Avery", "Last name: Smith", "Resume: r.pdf", "Sends to https://x.test"], payload, ["Avery"]);
  assert(JSON.stringify(got.filter((a) => !a.traced).map((a) => a.label)) === JSON.stringify(["Last name", "Phone (sent, not on the card)"]), JSON.stringify(got));
});

interface Case { person: string; form: string; outcome: string; detail: string; asked: string[]; answers: { label: string; value: string; traced: boolean }[]; resumeOk: boolean; targetOk: boolean; preparedId?: string; hash?: string }

Deno.test({
  name: "application layer review loop: request -> prepared review card from confirmed facts only, and one yes approves exactly that payload",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb, Chromium)"); return; }
    if (!Deno.env.get("UPMORE_CHROMIUM_PATH") && !CI) { console.log("NOT_RUN locally: set UPMORE_CHROMIUM_PATH and UPMORE_PLAYWRIGHT_PATH for the engine"); return; }
    const pg: Pg = await startPg();
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
      const k = new URL(req.url).pathname.split("/")[2] ?? "";
      if (req.method !== "GET") return new Response("this test page takes no submission", { status: 405 }); // the dry run never posts
      if (k === "chatq") return new Response(page(CHATQ.form), { headers: { "content-type": "text/html" } });
      return FORMS[k] ? new Response(page(FORMS[k]), { headers: { "content-type": "text/html" } }) : new Response("no such job", { status: 404 });
    });
    const port = (server.addr as Deno.NetAddr).port;
    const work = await Deno.makeTempDir({ prefix: "app-layer-loop-" });
    const unset = ["CAREER_BRAIN", "ANTHROPIC_API_KEY", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_ACCOUNT_MEMORY", "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET"];
    const saved = Object.fromEntries(unset.map((k) => [k, Deno.env.get(k)]));
    for (const k of unset) Deno.env.delete(k);
    Deno.env.set("CAREER_MAIL_TRACKING", "off");
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realError = console.error, realLog = console.log;
    const cases: Case[] = [];
    try {
      await supabaseParity(pg);
      for (const p of PROFILES) {
        await pg.sql(`insert into auth.users (id, email) values ('${p.id}', '${p.id}@example.test'); insert into public.profiles (id) values ('${p.id}');
          insert into public.career_watch_kv (user_id, key, value) values ('${p.id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
          ${confirmedResumeSql(p.id)}`);
      }
      h = await careerHandler(pg, Object.fromEntries(PROFILES.map((p, i) => [`tok-al-${i}`, p.id])));
      const admin: any = createClient(SUPABASE_URL, SERVICE_KEY);
      // Each person's confirmed resume file: a synthetic PDF, stored as Storage stores it (the queue takes an application only
      // with its stored resume, OWNER RULE 2026-10-26).
      const resumes = new Map<string, { path: string; sha256: string }>();
      for (const p of PROFILES) {
        const bytes = new TextEncoder().encode(`%PDF-1.4\n% SYNTHETIC TEST RESUME for ${p.name}\n`);
        const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes)), path = `${work}/${p.id}.pdf`;
        await Deno.writeFile(path, bytes);
        await pg.sql(`insert into storage.objects (bucket_id, name) values ('career-resumes', '${p.id}/${sha256}.pdf') on conflict do nothing`);
        resumes.set(p.id, { path, sha256 });
      }
      const engine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`] });
      console.log = (...a: unknown[]) => { if (typeof a[0] === "string" && (a[0].startsWith("{\"evt\"") || !a[0].startsWith("APP-LAYER"))) return; realLog(...a); };
      console.error = () => {};
      const json = async (sql: string) => JSON.parse((await pg.sql(sql)) || "null");
      const asked = async (u: string) => (await json(`select coalesce(jsonb_agg(jsonb_build_object('id', id, 'key', key, 'label', label, 'state', state, 'company', company, 'kind', kind)), '[]') from public.career_apply_questions where user_id = '${u}'`)) as any[];

      const postingSql = (id: string, f: { title: string; company: string }, url: string) =>
        `insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
         values (${lit(id)}, 'greenhouse', 'test', ${lit(f.company)}, ${lit(f.title)}, 'Chicago, IL', ${lit(url)}, ${lit(f.title)}, now() - interval '1 day', now()) on conflict do nothing`;
      // Each fixture posting is a board posting (its job id and link as the boards give them); the engine reads it from the
      // local page standing in for that link (prepareOne's urlFor), so nothing leaves the machine.
      const postingOf = (k: string, p: Profile) => ({ id: `greenhouse:test${k}:${Number(p.id.slice(-4))}`, url: `https://boards.greenhouse.io/test${k}/jobs/${Number(p.id.slice(-4))}` });
      for (const p of PROFILES) for (const [k, f] of Object.entries(FORMS)) await pg.sql(postingSql(postingOf(k, p).id, f, postingOf(k, p).url));
      const chatq: { queued: number; candidate: number; outcome: string; asked: string } = { queued: 0, candidate: 0, outcome: "not run", asked: "" };
      const dob = { requiredAsked: 0, requiredForms: 0, optionalAsked: 0, reusedElsewhere: 0, keys: 0, keysPerApplication: 0 };

      await t.step("prepare every profile x form through prepareOne and the real engine", async () => {
        for (const p of PROFILES) {
          for (const [k, f] of Object.entries(FORMS)) {
            const url = `http://127.0.0.1:${port}/job/${k}`;
            const c: Candidate = { user_id: p.id, job_id: postingOf(k, p).id, company: f.company, title: f.title, url: postingOf(k, p).url, location: "Chicago, IL", description: f.title, epoch: 0, version: 0 } as Candidate;
            const deps: any = { db: admin, runEngine: engine, profileFor: storedProfile(admin), resumeFor: async () => ({ ...resumes.get(p.id)!, tag: null }), now: () => Date.now(), tmpRoot: work, urlFor: () => url };
            let r = await prepareOne(deps, c);
            // Ask once: a question this person already answered elsewhere is answered from that answer, then prepared again.
            for (let round = 0; round < 2 && r.outcome === "asked"; round++) {
              let answered = 0;
              for (const q of await asked(p.id)) {
                if (q.state !== "open") continue;
                // A date of birth: given only by the one person, only for the one application it was asked for.
                const own = /date of birth/i.test(String(q.label)) ? (p.id === DOB_GIVEN.person && k === DOB_GIVEN.form && norm(q.company) === norm(f.company) ? DOB_GIVEN.value : null) : null;
                const a = own ? [null, null, own] as const : p.answers.find(([rx]) => rx.test(String(q.label)));
                if (!a) continue;
                await pg.sql(`update public.career_apply_questions set state = 'answered', answer = ${lit(String(a[2]))}, answered_at = now() where id = '${q.id}'`);
                answered++;
              }
              if (!answered) break;
              r = await prepareOne(deps, c);
            }
            const open = (await asked(p.id)).filter((q) => q.state === "open" && (q.kind !== "fact" ? norm(q.company) === norm(f.company) : true)).map((q) => String(q.label));
            const row = r.prepared_id ? (await json(`select jsonb_build_object('payload', payload, 'hash', payload_hash, 'lines', card_lines,
              'hash_ok', payload_hash = encode(sha256(convert_to(public.career_apply_canonical(payload), 'UTF8')), 'hex')) from public.career_apply_prepared where id = '${r.prepared_id}'`)) : null;
            const answers: Case["answers"] = [];
            const given = p.id === DOB_GIVEN.person && k === DOB_GIVEN.form ? [DOB_GIVEN.value] : [];
            let resumeOk = true, targetOk = true;
            if (row) {
              assert(row.hash_ok, `the stored hash is the payload's own (${p.name} ${k})`);
              answers.push(...traceCard(row.lines as string[], row.payload, [...p.answers.map(([, , v]) => v), ...given]));
              resumeOk = row.payload.resume_sha256 === resumes.get(p.id)!.sha256 && (row.lines as string[]).filter((l) => /^Resume\b/.test(l)).length === 1;
              targetOk = row.payload.url === url && norm(row.payload.company) === norm(f.company);
            }
            cases.push({ person: p.name, form: k, outcome: r.outcome, detail: r.detail, asked: open, answers, resumeOk, targetOk, preparedId: r.prepared_id, hash: row?.hash });
            // (d) the date of birth: asked where the form requires it, never where it is optional, never filled from another
            // application's answer, and always kept as this application's own answer (job key), never as a fact.
            const dobAsked = open.some((l) => /date of birth/i.test(l)), dobOnCard = answers.some((a) => /date of birth/i.test(a.label));
            const requires = f.parts.some((x) => /name="dob"[^>]*required/.test(x));
            if (requires) { dob.requiredForms++; if (dobAsked || (dobOnCard && given.length)) dob.requiredAsked++; }
            if (!requires && f.parts.some((x) => /name="dob"/.test(x)) && (dobAsked || dobOnCard)) dob.optionalAsked++;
            if (dobOnCard && !(p.id === DOB_GIVEN.person && k === DOB_GIVEN.form)) dob.reusedElsewhere++;
          }
        }
        for (const p of PROFILES) for (const q of await asked(p.id)) if (/date of birth/i.test(String(q.label))) { dob.keys++; if (String(q.key).startsWith("job:")) dob.keysPerApplication++; }
      });

      await t.step("from the chat ask to the queue: \"apply to ...\" queues the posting, the preparation takes it, the card shows it", async () => {
        const p = PROFILES[0];
        await pg.sql(postingSql(CHATQ.id, CHATQ, CHATQ.url));
        const chat = h!.chat("tok-al-0");
        await pg.sql(`delete from public.agent_rate_limits`);
        const r = await chat.say(`apply to the ${CHATQ.title} role at ${CHATQ.company}`);
        const wanted = Number(await pg.sql(`select count(*) from public.career_apply_wanted where user_id = '${p.id}' and posting_key = ${lit(CHATQ.id)} and state = 'waiting'`));
        chatq.asked = r.reply.slice(0, 300);
        chatq.queued = wanted;
        const cands = (await admin.rpc("career_apply_prepare_candidates_for", { p_user: p.id, p_now: new Date().toISOString(), p_per_person: 25, p_limit: 500 })).data ?? [];
        const cand = (cands as any[]).find((c) => c.job_id === CHATQ.id);
        chatq.candidate = cand ? 1 : 0;
        if (!cand) return;
        const local = `http://127.0.0.1:${port}/job/chatq`;
        const deps: any = { db: admin, runEngine: engine, profileFor: storedProfile(admin), resumeFor: async () => ({ ...resumes.get(p.id)!, tag: null }), now: () => Date.now(), tmpRoot: work, urlFor: () => local };
        const out = await prepareOne(deps, cand as Candidate);
        chatq.outcome = out.outcome;
        if (!out.prepared_id) return;
        const row = await json(`select jsonb_build_object('payload', payload, 'hash', payload_hash, 'lines', card_lines) from public.career_apply_prepared where id = '${out.prepared_id}'`);
        const answers = traceCard(row.lines, row.payload, p.answers.map(([, , v]) => v));
        cases.push({ person: p.name, form: "chatq", outcome: out.outcome, detail: out.detail, asked: [], answers, resumeOk: row.payload.resume_sha256 === resumes.get(p.id)!.sha256,
          targetOk: norm(row.payload.company) === norm(CHATQ.company), preparedId: out.prepared_id, hash: row.hash });
      });

      const approvals = { checked: 0, matched: 0, staleTried: 0, staleRefused: 0, changedTried: 0, changedRefused: 0, cardLineMissing: 0 };
      const review = { shown: 0, role: 0, resumeLines: 0, resumeHex: 0, withOpen: 0, openNamed: 0 };
      await t.step("the card and the yes: the hash the yes approves is the prepared payload's; a stale yes and a changed payload approve nothing", async () => {
        const jobs = async (u: string) => (await json(`select coalesce(jsonb_agg(jsonb_build_object('job_id', job_id, 'payload_hash', payload_hash)), '[]') from public.career_apply_jobs where user_id = '${u}'`)) as any[];
        for (const [i, p] of PROFILES.entries()) {
          const ready = cases.filter((c) => c.person === p.name && c.preparedId);
          if (!ready.length) continue;
          const chat = h!.chat(`tok-al-${i}`);
          const say = async (m: string) => { await pg.sql(`delete from public.agent_rate_limits`); return await chat.say(m); };
          if (i === 1) {
            // A stale yes: the card was shown more than 10 minutes ago (D-031), so the yes approves nothing.
            await say("show my applications");
            await pg.sql(`update public.career_apply_cards set shown_at = now() - interval '11 minutes' where user_id = '${p.id}' and state = 'open'`);
            approvals.staleTried++;
            await say("yes");
            if ((await jobs(p.id)).length === 0) approvals.staleRefused++;
            await pg.sql(`update public.career_apply_cards set state = 'answered', answered_at = now() where user_id = '${p.id}' and state = 'open'`);
          }
          if (i === 2) {
            // A changed payload: an answer changes after the card was shown, so the yes to the card approves nothing of it.
            await say("show my applications");
            const id = ready[0].preparedId!;
            const changedJob = await pg.sql(`select job_id from public.career_apply_prepared where id = '${id}'`);
            await pg.sql(`update public.career_apply_prepared set payload = jsonb_set(payload, '{fields,0,value}', '"TEST changed after the card"'),
              payload_hash = encode(sha256(convert_to(public.career_apply_canonical(jsonb_set(payload, '{fields,0,value}', '"TEST changed after the card"')), 'UTF8')), 'hex') where id = '${id}'`);
            approvals.changedTried++;
            await say("yes");
            // Refused: no application of that posting was approved (the other, unchanged one on the card may be).
            if (!(await jobs(p.id)).some((j) => String(j.job_id) === changedJob)) approvals.changedRefused++;
            continue;
          }
          const shown = await say("show my applications");
          // What the person reads is what is hashed: every stored card line of the shown applications is in the card text.
          for (const c of ready) {
            const lines = JSON.parse(await pg.sql(`select to_jsonb(card_lines)::text from public.career_apply_prepared where id = '${c.preparedId}'`));
            for (const l of lines) if (!shown.reply.includes(l)) { approvals.cardLineMissing++; realLog(`[card line missing] ${p.name} ${c.form}: "${l}"`); }
          }
          // Measured, not yet a bar (each needs a change outside this loop's files, named in the PR): C.11 asks for the exact
          // role, the resume by a human label, and the questions still open named on the review.
          for (const c of ready) { review.shown++; if (shown.reply.includes(`${c.form === "chatq" ? CHATQ.company : FORMS[c.form].company} — ${c.form === "chatq" ? CHATQ.title : FORMS[c.form].title}`)) review.role++; }
          review.resumeLines += (shown.reply.match(/^\s*Resume: .*$/gm) ?? []).length;
          review.resumeHex += (shown.reply.match(/^\s*Resume: .*\([0-9a-f]{12}\)\s*$/gm) ?? []).length;
          const openHere = cases.filter((c) => c.person === p.name && c.asked.length).flatMap((c) => c.asked);
          if (openHere.length) { review.withOpen++; if (openHere.some((q) => shown.reply.includes(q))) review.openNamed++; }
          const yes = await say("yes");
          const got = await jobs(p.id);
          for (const c of ready) {
            approvals.checked++;
            if (got.some((j) => j.payload_hash === c.hash)) approvals.matched++;
            else realLog(`[no match] ${p.name} ${c.form}: card "${shown.reply.slice(0, 200)}" / yes "${yes.reply.slice(0, 200)}"`);
          }
        }
      });

      const answers = cases.flatMap((c) => c.answers), traced = answers.filter((a) => a.traced).length;
      for (const c of cases) {
        const bad = c.answers.filter((a) => !a.traced);
        realLog(`[${c.person} / ${c.form}] ${c.outcome}${c.asked.length ? ` asked: ${c.asked.join(" | ")}` : ""}${bad.length ? ` INVENTED: ${bad.map((a) => `${a.label}=${a.value}`).join("; ")}` : ""}${c.resumeOk ? "" : " RESUME WRONG"}${c.targetOk ? "" : " TARGET WRONG"}${c.outcome !== "ready" ? ` (${c.detail.slice(0, 120)})` : ""}`);
      }
      const ready = cases.filter((c) => c.outcome === "ready").length;
      const sensitiveFilled = cases.filter((c) => c.answers.some((a) => /social security|gender|race|ethnicity/i.test(a.label))).length;
      const unknownFilled = cases.filter((c) => (c.form === "unknown" || c.form === "essay") && c.outcome === "ready").length;
      const summary = `APP-LAYER LOOP: cases ${cases.length}, ready ${ready}, answers ${answers.length}, traced ${traced}, invented ${answers.length - traced}, ` +
        `unknown or essay filled ${unknownFilled}, sensitive filled ${sensitiveFilled}, resume right ${cases.filter((c) => c.outcome === "ready" && c.resumeOk).length}/${ready}, ` +
        `target right ${cases.filter((c) => c.outcome === "ready" && c.targetOk).length}/${ready}, hash match ${approvals.matched}/${approvals.checked}, ` +
        `stale-yes refused ${approvals.staleRefused}/${approvals.staleTried}, changed-payload yes refused ${approvals.changedRefused}/${approvals.changedTried}, card lines missing from the shown card ${approvals.cardLineMissing}`;
      realLog(summary);
      const reviewLine = `APP-LAYER REVIEW: role named on the card ${review.role}/${review.shown}, resume lines showing a hash prefix ${review.resumeHex}/${review.resumeLines}, ` +
        `people with an open question who see it named on the card ${review.openNamed}/${review.withOpen}`;
      const dobLine = `APP-LAYER DOB: asked where the form requires it ${dob.requiredAsked}/${dob.requiredForms}, asked where optional ${dob.optionalAsked}, ` +
        `filled from another application ${dob.reusedElsewhere}, kept per application ${dob.keysPerApplication}/${dob.keys}`;
      const chatLine = `APP-LAYER CHAT->QUEUE: queued ${chatq.queued}, a preparation candidate ${chatq.candidate}, prepared ${chatq.outcome}, on the card and approved by the yes ${cases.some((c) => c.form === "chatq" && c.preparedId) ? "see hash match" : "no"}`;
      realLog(reviewLine);
      realLog(dobLine);
      realLog(chatLine);
      if (!chatq.queued) realLog(`[chat ask] ${chatq.asked}`);
      const out = Deno.env.get("APP_LAYER_LOOP_OUT");
      if (out) Deno.writeTextFileSync(out, JSON.stringify({ summary, reviewLine, dobLine, chatLine, cases, approvals, review, dob, chatq }, null, 1));
      assert(answers.length - traced === 0, `invented answers on a card (listed above): ${summary}`);
      assert(unknownFilled === 0 && sensitiveFilled === 0, `an unknown, essay or sensitive question was filled: ${summary}`);
      assert(ready > 0 && cases.every((c) => c.outcome !== "ready" || (c.resumeOk && c.targetOk)), `resume or target wrong: ${summary}`);
      assert(approvals.checked > 0 && approvals.matched === approvals.checked && approvals.cardLineMissing === 0, `hash match / card shown: ${summary}`);
      assert(approvals.staleRefused === approvals.staleTried && approvals.changedRefused === approvals.changedTried, `stale or changed yes: ${summary}`);
      // Architect rulings on #674: (a) the role on every card, (b) no hash prefix on the card, (c) every open question named.
      assert(review.shown > 0 && review.role === review.shown && review.resumeHex === 0 && review.openNamed === review.withOpen, reviewLine);
      // (d) the date of birth.
      assert(dob.requiredAsked === dob.requiredForms && dob.optionalAsked === 0 && dob.reusedElsewhere === 0 && dob.keysPerApplication === dob.keys, dobLine);
      // From the chat ask: queued, taken by the preparation, prepared, and on the card the yes approved (counted in hash match).
      assert(chatq.queued === 1 && chatq.candidate === 1 && chatq.outcome === "ready", chatLine);
      assert(await pg.sql(`select count(*) from public.career_apply_jobs where state not in ('queued')`) === "0", "nothing beyond the queue: no application ran");
    } finally {
      console.error = realError;
      console.log = realLog;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await server.shutdown();
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
