// FEATURE E2E (2026-10-26): the gold path for a real person, end to end through the production agent-chat handler
// (handler-career.ts handleChat, unchanged harness: tests/flow/handler.ts, real supabase-js, real Postgres with CI's
// migration order, Supabase-parity grants and row security):
//
//   1. a new person signs up and pastes their resume; they are shown each entry and say it is theirs (evidenced)
//   2. "apply me to this: https://jobs.ashbyhq.com/ramp/<id>": the posting is read from Ashby's public posting API on
//      demand, stored in career_postings, queued in career_apply_wanted
//   3. the server's prepare (prepare-ahead.ts, as the worker runs it) asks only what is not known; the person answers in
//      chat; the engine's dry run on the employer's form asks the form's own questions; they answer those too
//   4. "show my applications": the card lists every exact answer and the resume
//   5. their tap on the web chat's card (src/career-apply-card.js mounted with the reply's meta, supabase-js as the person:
//      it reads the card and the prepared application, checks the hashes and calls career_apply_card_answer_own)
//   6. a career_apply_jobs row is queued, bound to the hash the card showed
//   7. a simulated executor (approve-first.ts runApproved -> scripts/apply.ts --approved) finishes it on the form
//   8. "did my Ramp application go through?" reads back the true recorded state
//
// The seams, disclosed: the HTTP hop to the Supabase project (tests/flow/postgrest.ts, as in every flow test) and the HTTP
// hop to Ashby: api.ashbyhq.com is answered by a server on 127.0.0.1 holding one synthetic Ramp posting, and the
// employer's form is a locally served copy of a captured Ashby form (tests/fixtures/forms-ci/ashby-crusoe-*.html,
// scripts removed, the employer's name replaced by the posting's) with a small script standing in for Ashby's own
// (its yes/no buttons and its one GraphQL application mutation). Any other outbound request fails the test: nothing
// reaches a real employer. The person is the synthetic TEST resume (packages/career-data/fixtures/test-resume.txt).
import assertNode from "node:assert/strict";
import { pgBinDir, startPg } from "../flow/pg.ts";
import { engineRunner, ownQueue, runApproved } from "../../workers/career-browser/approve-first.ts";
import { prepareAhead, storedProfile, tailoredResume } from "../../workers/career-browser/prepare-ahead.ts";
import { edgeRenderer, memoryResumeStore, type ResumeStore } from "../../supabase/functions/_shared/career_tailor.ts";
import { ANON_KEY, careerHandler, type Chat, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { fakeDocument } from "../flow/fake-dom.ts";
import { answerOneByOne } from "../helpers/one_question.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
function browserEnv(): boolean {
  if (Deno.env.get("UPMORE_PLAYWRIGHT_PATH")) return true;
  try {
    Deno.statSync(`${ROOT}/tools/node_modules/playwright`);
    Deno.env.set("UPMORE_PLAYWRIGHT_PATH", `${ROOT}/tools/node_modules/playwright`);
    return true;
  } catch {
    return false;
  }
}
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const CAPTURED = `${ROOT}/tests/fixtures/forms-ci/ashby-crusoe-b1b99030-d393-4329-80fe-5bc2e4c93b03.html`;
const JOB_UUID = "a13ae586-f4cb-4385-8822-c42b9b54ed74";
const LINK = `https://jobs.ashbyhq.com/ramp/${JOB_UUID}`;
const KEY = `ashby:ramp:${JOB_UUID}`;
const TITLE = "Frontend Engineer Intern (TEST)";

// Ashby's public posting API and the employer's form, on 127.0.0.1.
function ashby() {
  const applications: any[] = [], other: string[] = [];
  const strip = (h: string) => h.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<link\b[^>]*>/gi, "")
    .replace(/\s(src|srcset)="https?:[^"]*"/gi, "").replace(/Crusoe/g, "Ramp");
  // Ashby's own script, reduced to what the form needs: a yes/no button presses itself and sets its hidden checkbox; the
  // location box offers what was typed as its one option; Submit sends the application as one GraphQL mutation.
  const script = `<script>
document.querySelectorAll(".ashby-application-form-input-yesno").forEach((g) => g.querySelectorAll("button").forEach((b) => b.addEventListener("click", (e) => {
  e.preventDefault(); g.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  const box = g.querySelector("input[type=checkbox]"); if (box) box.checked = b.dataset.option === "yes";
})));
document.querySelectorAll("input[role=combobox]").forEach((inp) => {
  const list = document.createElement("div"); list.setAttribute("role", "listbox"); inp.parentElement.appendChild(list);
  inp.addEventListener("input", () => { list.innerHTML = inp.value ? '<div role="option" tabindex="-1">' + inp.value.replace(/[<>&"]/g, "") + "</div>" : ""; inp.setAttribute("aria-expanded", String(!!inp.value));
    const o = list.firstElementChild; if (o) o.addEventListener("mousedown", (e) => { e.preventDefault(); inp.value = o.textContent; list.innerHTML = ""; inp.setAttribute("aria-expanded", "false"); }); });
});
document.querySelector(".ashby-application-form-submit-button").addEventListener("click", async (e) => {
  e.preventDefault();
  const fieldEntries = [];
  document.querySelectorAll(".ashby-application-form-field-entry").forEach((f) => {
    const field = f.dataset.fieldPath, yes = f.querySelector("button[aria-pressed=true]");
    const input = f.querySelector("input:not([type=file]):not([type=checkbox]), textarea");
    if (yes) fieldEntries.push({ field, value: yes.textContent.trim() });
    else if (input && input.value) fieldEntries.push({ field, value: input.value });
  });
  const file = document.querySelector("[data-field-path=_systemfield_resume] input[type=file]").files[0];
  let bin = ""; if (file) new Uint8Array(await file.arrayBuffer()).forEach((c) => { bin += String.fromCharCode(c); });
  const content = file ? btoa(bin) : null;
  const r = await fetch("/api/non-user-graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    operationName: "ApiSubmitSingleApplicationFormAction", query: "mutation ApiSubmitSingleApplicationFormAction { submit }",
    variables: { organizationHostedJobsPageName: "ramp", jobPostingId: ${JSON.stringify(JOB_UUID)}, applicationForm: { fieldEntries }, resume: file ? { name: file.name, content } : null } }) });
  if (r.ok) document.body.innerHTML = "<h1>Thank you for applying</h1><p>Application received. Confirmation number: RAMP-TEST-4410.</p>";
});
</script>`;
  const form = strip(Deno.readTextFileSync(CAPTURED)).replace(/<\/body>/i, `${script}</body>`);
  const board = { apiVersion: "1", jobs: [{
    id: JOB_UUID, title: TITLE, location: "New York, NY", departmentName: "Engineering", employmentType: "Intern", isListed: true,
    publishedAt: new Date().toISOString(), jobUrl: LINK, applyUrl: `${LINK}/application`,
    descriptionPlain: "TEST synthetic posting. Build product UI in React and TypeScript with the engineering team.",
  }] };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const u = new URL(req.url);
    if (req.method === "GET" && u.pathname === "/posting-api/job-board/ramp") return Response.json(board);
    if (req.method === "GET" && u.pathname === `/ramp/${JOB_UUID}/application`) return new Response(form, { headers: { "content-type": "text/html" } });
    if (req.method === "POST" && u.pathname === "/api/non-user-graphql") {
      const body = await req.json().catch(() => ({}));
      if (/^ApiSubmit/.test(String(body?.operationName))) applications.push(body); else other.push(String(body?.operationName));
      return Response.json({ data: { ok: true } });
    }
    other.push(`${req.method} ${u.pathname}`);
    return new Response("not found", { status: 404 });
  });
  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  return { origin, form: `${origin}/ramp/${JOB_UUID}/application`, applications, other, close: () => server.shutdown() };
}

Deno.test({
  name: "E2E: sign up, resume, 'apply me to <Ashby link>', asked only what is unknown, card with every answer, tap, queued by hash, executor, read back",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir() || !browserEnv()) {
      if (CI) throw Error("the e2e chat-to-submit flow needs Postgres 16 binaries and the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Postgres binaries or Playwright browser");
      return;
    }
    if (Deno.uid?.() === 0 && !CI) {
      console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)");
      return;
    }
    const pg = await startPg();
    const site = ashby();
    const work = await Deno.makeTempDir({ prefix: "trainee-e2e-" });
    let agentChat: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const outbound: string[] = [];
    try {
      await supabaseParity(pg);
      const PERSON = "7b0f8f8e-6a43-4a49-9d2c-0000000000e7";
      // Sign-up, as the app's auth creates it: an auth user, their profile, their career account.
      await pg.sql(`insert into auth.users (id, email) values ('${PERSON}', 'alex.testcase@example.test');
        insert into public.profiles (id) values ('${PERSON}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
      agentChat = await careerHandler(pg, { "tok-alex": PERSON });
      // Ashby's hosts answered here; anything else that is not the Supabase double or 127.0.0.1 fails the run.
      const double = globalThis.fetch;
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin === new URL(SUPABASE_URL).origin || u.hostname === "127.0.0.1") return double(req);
        outbound.push(u.href);
        if (u.hostname === "api.ashbyhq.com") return double(new Request(`${site.origin}${u.pathname}${u.search}`, req));
        return Promise.reject(new Error(`the e2e test reaches no real host: ${u.href}`));
      }) as typeof fetch;
      const svc = pg.asService(), person = pg.asPerson(PERSON);
      const memory = memoryResumeStore();
      const resumes: ResumeStore = {
        put: async (path, pdf) => {
          await memory.put(path, pdf);
          await pg.sql(`insert into storage.objects (bucket_id, name) values ('career-resumes', '${path}') on conflict (bucket_id, name) do nothing`);
        },
        signedUrl: (path, seconds) => memory.signedUrl(path, seconds),
        removeAll: (u) => memory.removeAll(u),
      };
      const runEngine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`, "--script-submit", "ashby"] });
      const deps = { db: svc, runEngine, profileFor: storedProfile(svc), urlFor: () => site.form, resumeFor: tailoredResume({ render: edgeRenderer(), resumes }) };
      const chat: Chat = agentChat.chat("tok-alex");
      const say = async (message: string) => {
        const r = await chat.say(message);
        assertEquals(r.status, 200, r.reply);
        return r;
      };
      // The worker's prepare, for this person's queued posting only.
      const prepare = async () => {
        const done = await prepareAhead(deps, { only: { user_id: PERSON, job_ids: [KEY] } });
        for (const d of done) if (d.outcome !== "asked" && d.outcome !== "ready") console.log(`prepare: ${d.outcome}: ${d.detail}`);
        return done.map((d) => d.outcome);
      };
      const open = async () => await pg.sql(`select coalesce(string_agg(key, ',' order by key), '') from public.career_apply_questions where user_id = '${PERSON}' and state = 'open'`);
      // One question at a time (review of #360): each shown question answered in their own words as it comes up.
      const answer = async (answers: [RegExp, string][]) => {
        const r = await answerOneByOne(say, answers);
        if (Deno.env.get("E2E_DEBUG")) console.log(`SHOWN:\n${r.shown}\nREPLIES:\n${r.saved}`);
        assert(!/doesn't fit|does not fit|isn't one of/i.test(r.saved), `their answers are taken: ${r.saved}`);
        return r;
      };

      await t.step("sign up and resume: shown each entry, they say it is theirs; each entry evidenced", async () => {
        const pasted = await say(`here is my resume:\n${RESUME}`);
        assertEquals(pasted.intent, "career_resume_ingest", pasted.reply);
        const yes = await say("yes, that's my resume");
        assertEquals([yes.intent, yes.resultStatus], ["career_resume_ingest", "completed"], yes.reply);
        assert(Number(await pg.sql(`select count(*) from public.career_events where user_id = '${PERSON}' and kind = 'fact_confirmed'`)) >= 10, "one event per entry");
      });

      await t.step("'apply me to this: <Ashby link>': the posting is read from Ashby, stored, and queued; nothing sent", async () => {
        const r = await say(`apply me to this: ${LINK}`);
        assertEquals([r.intent, r.resultStatus], ["career_apply_queue", "queued"], r.reply);
        assert(/^1\/1 queued/.test(r.reply) && r.reply.includes(TITLE) && /Ramp/.test(r.reply), r.reply);
        assert(!/submitted|sent to Ramp|applied/i.test(r.reply.replace(/Nothing is sent/g, "")), `nothing is claimed sent: ${r.reply}`);
        assert(outbound.some((u) => u.startsWith("https://api.ashbyhq.com/posting-api/job-board/ramp")), `read from Ashby's posting API: ${outbound}`);
        assertEquals(JSON.parse(await pg.sql(`select json_build_array(company, title, url, provider, board, closed_at) from public.career_postings where job_id = '${KEY}'`)),
          ["Ramp", TITLE, LINK, "ashby", "ramp", null], "stored as the ingest stores it, facts only from the posting and the registry");
        assertEquals(await pg.sql(`select string_agg(posting_key || ' ' || state, ',') from public.career_apply_wanted where user_id = '${PERSON}'`), `${KEY} waiting`);
        assertEquals(site.applications.length, 0);
      });

      await t.step("asked only what is unknown: their name and email for the resume, answered in chat", async () => {
        assertEquals(await prepare(), ["asked"]);
        assertEquals(await open(), "fact:email,fact:first_name,fact:last_name");
        await answer([[/First name/i, "Alex"], [/Last name/i, "Testcase"], [/Email/i, "alex.testcase@example.test"]]);
        assertEquals(await open(), "");
      });

      let formQuestions = "";
      await t.step("the dry run on the employer's form asks the form's own questions, and only those; answered in chat", async () => {
        assertEquals(await prepare(), ["asked"]);
        formQuestions = await open();
        const asked = await pg.sql(`select string_agg(label, ' | ' order by label) from public.career_apply_questions where user_id = '${PERSON}' and state = 'open'`);
        assert(/sponsorship/i.test(asked) && /work for Ramp/i.test(asked) && /state, province, or region/i.test(asked), asked);
        assert(!/first name|last name|email/i.test(asked), `nothing already known is asked again: ${asked}`);
        await answer([[/sponsorship/i, "no"], [/currently work for Ramp/i, "no"], [/state, province, or region/i, "Illinois"]]);
        assertEquals(await open(), "");
        assertEquals(site.applications.length, 0, "a dry run sends nothing");
      });

      let cardMeta: Record<string, unknown> = {}, preparedHash = "", rowFields: any[] = [];
      await t.step("ready, then 'show my applications': the card lists every exact answer and the resume", async () => {
        assertEquals(await prepare(), ["ready"]);
        const row = JSON.parse(await pg.sql(`select row_to_json(p) from public.career_apply_prepared p where user_id = '${PERSON}'`));
        preparedHash = row.payload_hash;
        rowFields = row.payload.fields.filter((x: any) => x.name !== "_systemfield_resume");
        const shown = await say("show my applications");
        assertEquals(shown.resultStatus, "shown", shown.reply);
        cardMeta = shown.body?.meta ?? {};
        assertEquals(cardMeta.intent, "career_apply_card", JSON.stringify(cardMeta));
        assert(/^[0-9a-f-]{36}$/.test(String(cardMeta.card_id)), `the card's id rides the reply: ${JSON.stringify(cardMeta)}`);
        for (const f of rowFields) assert(shown.reply.includes(String(f.value)), `the card shows ${f.label} = ${f.value}: ${shown.reply}`);
        for (const v of ["Alex Testcase", "alex.testcase@example.test", "Illinois"]) assert(shown.reply.includes(v), `${v} on the card: ${shown.reply}`);
        assert(/Resume: .*tailored for this role \([0-9a-f]{12}\)/.test(shown.reply), `the resume on the card: ${shown.reply}`);
        assertEquals(await pg.sql(`select items->0->>'payload_hash' from public.career_apply_cards where id = '${cardMeta.card_id}'`), preparedHash);
      });

      // D-MS-1 (owner, 2026-10-27; replaces the reply-only rule): a text yes while the card is the thread's last word
      // approves it. Here the person first asks something else, so the card is no longer the last word and a bare "maybe"
      // and a bare "yes" do nothing to it; the tap below is what approves.
      await t.step("an unclear reply approves nothing; after another turn a bare yes is not the card's (D-MS-1)", async () => {
        const unclear = await say("maybe");
        assert(/nothing was approved/i.test(unclear.reply), unclear.reply);
        await say("what do you need from me");
        const r = await say("yes");
        assert(r.resultStatus !== "answered", `a yes after another turn is not the card's: ${r.reply}`);
        assertEquals(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${PERSON}'`), "0");
        assertEquals(await pg.sql(`select state from public.career_apply_cards where id = '${cardMeta.card_id}'`), "open");
      });

      await t.step("their tap on the web chat's card (src/career-apply-card.js, their own session): queued, bound to the card's hash", async () => {
        // The web app's own module, mounted under the reply with the reply's meta, reading and answering with supabase-js
        // signed in as the person (row-level security), exactly as the web chat does.
        await import("../../src/career-apply-card.js");
        const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
        const supa = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: "Bearer tok-alex" } }, auth: { persistSession: false, autoRefreshToken: false } });
        const doc = fakeDocument(), host = doc.createElement("div");
        // deno-lint-ignore no-explicit-any
        const W = (globalThis as any).TraineeApplyCard;
        const v = await W.mount(host, cardMeta, { from: (t: string) => supa.from(t), rpc: (n: string, a: unknown) => supa.rpc(n, a), document: doc });
        assert(v?.ok, `the card verifies against its prepared application: ${JSON.stringify(v)}`);
        const seen = host.text();
        for (const f of rowFields) assert(seen.includes(String(f.value)), `the web card shows ${f.label} = ${f.value}: ${seen}`);
        assert(/Resume: .*tailored for this role/.test(seen), seen);
        const approve = host.buttons().find((b) => b.textContent === "Approve");
        assert(approve?.onclick, `an Approve button: ${seen}`);
        await approve!.onclick!();
        assert(/1 approved exactly as shown/.test(host.text()) && /Ramp: approved/.test(host.text()), host.text());
        const job = JSON.parse(await pg.sql(`select row_to_json(j) from public.career_apply_jobs j where user_id = '${PERSON}'`));
        assertEquals([job.state, job.approval_hash, job.payload_hash, job.company], ["queued", preparedHash, preparedHash, "Ramp"], `bound to the approval hash the card carried: ${JSON.stringify(job)}`);
        assertEquals(await pg.sql(`select public.career_apply_payload_hash(payload) = '${preparedHash}' from public.career_apply_jobs where user_id = '${PERSON}'`), "t", "the queued payload is the one the card showed");
        assertEquals(await pg.sql(`select count(*) from public.career_apply_ledger('${PERSON}', now() - interval '1 day')`), "1");
        const back = await say("did my Ramp application go through?");
        assert(/approved, not sent yet/.test(back.reply), back.reply);
      });

      await t.step("the executor (simulated: the engine with --approved on the employer's form) finishes it; one application sent", async () => {
        const queue = ownQueue(person);
        const done = await runApproved({
          claim: () => queue.claim(1),
          finish: (id, lease, state, evidence) => queue.finish(id, lease, state, evidence),
          resumeFor: async (job) => {
            const path = `${work}/sent-resume.pdf`;
            await Deno.writeFile(path, memory.files.get(`career-resumes/${PERSON}/${job.payload.resume_sha256}.pdf`)!);
            return { path, sha256: job.payload.resume_sha256 };
          },
          writeFacts: async (_job, facts) => {
            const p = `${work}/approved-facts.json`;
            await Deno.writeTextFile(p, JSON.stringify(facts));
            return p;
          },
          runEngine,
        });
        assertEquals(done.length, 1);
        assertEquals(site.applications.length, 1, `exactly one application mutation: ${JSON.stringify(site.other)}`);
        const sent = JSON.stringify(site.applications[0].variables);
        for (const v of ["Alex Testcase", "alex.testcase@example.test", "Illinois"]) assert(sent.includes(v), `${v} sent: ${sent.slice(0, 600)}`);
        assertEquals(site.applications[0].variables.jobPostingId, JOB_UUID);
        const job = JSON.parse(await pg.sql(`select row_to_json(j) from public.career_apply_jobs j where user_id = '${PERSON}'`));
        assertEquals([job.state, job.confirmation_id], ["submitted_unconfirmed", "RAMP-TEST-4410"], JSON.stringify(job));
      });

      await t.step("'did my Ramp application go through?': the true recorded state, never a confirmation Ramp did not send", async () => {
        const r = await say("did my Ramp application go through?");
        assert(/submitted/.test(r.reply) && /has not confirmed it yet/.test(r.reply) && /RAMP-TEST-4410/.test(r.reply), r.reply);
        assert(!/confirmed it\b(?! yet)|successful/i.test(r.reply.replace("has not confirmed it yet", "")), r.reply);
        assert(outbound.every((u) => u.startsWith("https://api.ashbyhq.com/")), `no other host was asked: ${outbound}`);
        void formQuestions;
      });
    } finally {
      agentChat?.restore();
      await site.close();
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
