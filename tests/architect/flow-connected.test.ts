// Backend gap map G1 (docs/architect/BACKEND-GAP-MAP-2026-10-23.md): one application through the D-014 stack as one
// connected flow, on a real Postgres (the career schema, CI's migration order) and a real browser, with the product's own
// code at every step:
//   prepare  approve-first.ts prepare() -> scripts/apply.ts dry run on the employer's page -> career_apply_prepare_own
//   card     career_apply_card_open_own                       (the person's app shows the card)
//   approve  career_apply_card_answer_own                     (the person's own tap; it enqueues under the card's hash)
//   claim    career_apply_claim_own                           (the person's own computer)
//   drive    runApproved() -> scripts/apply.ts --submit --approved <hash> on the employer's page
//   record   career_apply_finish_own                          (a page's confirmation is recorded as submitted_unconfirmed)
// Every call that is the person acting runs as the person (role authenticated, their JWT subject), never as a superuser:
// nothing approves on their behalf. The only service-role writes create the person's account rows (setup, named below).
// The employer is a page on 127.0.0.1 served by this test; nothing reaches a real site.
//
// The attestation gate: a posting whose form asks the person to certify their application has no answer on file (the
// attestation carrier is parked, the owner's question), so it must stop at preparation: asked of the person, never
// prepared, never on a card, never sent. The test checks that stop; it does not answer the attestation.
//
// The facts are a synthetic test person's own statements (name and email only), each with its source. No work
// authorization, sponsorship or other fact is written or inferred: the employer's form does not ask for one.
//
// G4 (second test below): the same stack prepared before the person asks. A posting their job alerts sent them is
// prepared on the server (workers/career-browser/prepare-ahead.ts) with their own confirmed answers and the resume
// tailored to it, before they text anything; their card and their tap then go exactly as above. A posting that asks for a
// cover letter gets one drafted ahead from their confirmed facts (essay_draft.ts, the chat's own drafter); it is shown
// whole only when they ask for it ("draft 1"), saved only by "use 1", and then sent word for word.
//
// G6 (receipts): the text each finished application gets is written by the product's own receipt code (career_proactive_run.ts
// runReceipts) from the rows the queue recorded here, and queued in the real outbox, whose unique key makes it once ever. The
// outbox insert and the finished-rows read are the production store's (career_alert_store.ts, career-proactive/index.ts),
// written in SQL because no PostgREST runs here; RECEIPT_READ pins index.ts's query to this one.
//
// Not covered yet (later gaps): facts written by chat (G2).
import { confirmedResumeSql } from "../flow/resume-seed.ts"; // OWNER RULE 2026-10-26: the person has a confirmed resume
import assertNode from "node:assert/strict";
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assertMatch = (s: string, re: RegExp) => assertNode.match(s, re);
import { pgBinDir, startPg } from "../flow/pg.ts";
import { engineRunner, ownQueue, prepare, questionsToStore, runApproved } from "../../workers/career-browser/approve-first.ts";
import { prepareAhead, tailoredResume } from "../../workers/career-browser/prepare-ahead.ts";
import { edgeRenderer, memoryResumeStore, type ResumeStore } from "../../supabase/functions/_shared/career_tailor.ts";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import { runReceipts } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { FINAL_STATES } from "../../supabase/functions/_shared/career_apply_receipts.ts";
import PROACTIVE_INDEX from "../../supabase/functions/career-proactive/index.ts" with { type: "text" };
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { type OpenQuestion, QUESTIONS_INTENT, type QuestionStore, questionsTurn, type Shown, supabaseQuestionStore } from "../../supabase/functions/_shared/career_apply_questions.ts";

async function sha256hex(b: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";

// The receipts' two database calls, as career-proactive's stores make them through PostgREST. RECEIPT_READ is index.ts's
// own query, pinned below so this copy cannot drift from it.
const RECEIPT_READ = [
  `.from("career_apply_jobs").select("id,user_id,company,url,state,reason,confirmation_id,email_confirmed_at,evidence,source")`,
  `.in("state", ${JSON.stringify([...FINAL_STATES]).replace(/,/g, ", ")}).gte("updated_at", since)`,
  `.or("source.is.null,source.neq.email").limit(2000)`,
];
const quoted = (s: string) => `$q${"x".repeat(3)}$${s}$q${"x".repeat(3)}$`;
function receiptStores(pg: { sql: (q: string) => Promise<string> }) {
  return {
    finished: async (since: string) => JSON.parse(await pg.sql(`select coalesce(json_agg(row_to_json(j)), '[]') from (
      select id, user_id, company, url, state, reason, confirmation_id, email_confirmed_at, evidence, source from public.career_apply_jobs
      where state = any(array[${FINAL_STATES.map((x) => `'${x}'`).join(",")}]) and updated_at >= '${since}' and (source is null or source <> 'email')
      limit 2000) j`)),
    // career_alert_store.ts supabaseAlertStore.enqueue: the insert, and false on the unique key (queued or sent before).
    outbox: {
      enqueue: async (userId: string, m: { key: string; kind: string; text: string; at: number }) => {
        try {
          await pg.sql(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values ('${userId}', ${quoted(m.key)}, '${m.kind}', ${quoted(m.text)}, '${new Date(m.at).toISOString()}')`);
          return true;
        } catch (e) {
          if (/duplicate key|23505/.test(String((e as Error).message))) return false;
          throw e;
        }
      },
    },
  };
}

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

const PERSON = "7b0f8f8e-6a43-4a49-9d2c-000000000001";
const SOURCE = { confirmed: true, provenance: "owner stated (TEST person, synthetic)", confirmation_event_id: "evt-flow-test" };
const FACTS = {
  user_id: PERSON,
  answers: {
    first_name: { value: "Flow", factId: "FLOW-TEST-FACT-1", ...SOURCE },
    last_name: { value: "Tester", factId: "FLOW-TEST-FACT-2", ...SOURCE },
    email: { value: "flow.tester@example.test", factId: "FLOW-TEST-FACT-3", ...SOURCE },
  },
};

// The employer: two postings on 127.0.0.1. /plain asks name, email and a resume; /attest also asks the person to certify
// the application, a legal statement only they can make. Every POST is counted per posting.
function employer() {
  const posts: Record<string, number> = { plain: 0, attest: 0, second: 0, portfolio: 0, cover: 0 };
  // The sha256 of the resume file each posting received (G4: the tailored file, byte for byte), and the cover letter text.
  const uploads: Record<string, string> = {}, letters: Record<string, string> = {};
  const form = (route: string, extra: string) =>
    `<!doctype html><title>TEST role</title><h1>TEST Analyst</h1><p>TEST ${route === "second" ? "Second" : route === "cover" ? "Cover" : "First"} Employer</p><form method="post" action="/${route}/submit" enctype="multipart/form-data">` +
    `<label for="first">First name</label><input name="first_name" id="first" required>` +
    `<label for="last">Last name</label><input name="last_name" id="last" required>` +
    `<label for="email">Email</label><input name="email" id="email" type="email" required>` +
    `<label for="resume">Resume</label><input type="file" name="resume" id="resume" required>` +
    extra + `<button type="submit">Submit application</button></form>`;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === "POST") {
      const route = path.split("/")[1];
      const data = await req.formData(), file = data.get("resume"), letter = data.get("cover_letter");
      if (typeof letter === "string") letters[route] = letter;
      if (file instanceof File) {
        uploads[route] = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
      posts[route] = (posts[route] ?? 0) + 1;
      return new Response(`<h1>Thank you for applying</h1><p>Application received. Confirmation number: FLOW-${route.toUpperCase()}-1.</p>`, { headers: { "content-type": "text/html" } });
    }
    // /second is /plain again, for the negative control.
    if (path === "/plain" || path === "/second") return new Response(form(path.slice(1), ""), { headers: { "content-type": "text/html" } });
    if (path === "/portfolio") {
      return new Response(form("portfolio", `<label for="pf">Portfolio URL</label><input name="portfolio" id="pf" required>`), { headers: { "content-type": "text/html" } });
    }
    if (path === "/cover") {
      return new Response(form("cover", `<label for="cl">Cover letter</label><textarea name="cover_letter" id="cl" required></textarea>`), { headers: { "content-type": "text/html" } });
    }
    if (path === "/attest") {
      return new Response(form("attest", `<label><input type="checkbox" name="certify" id="certify" required> I certify that the information in this application is true and complete.</label>`), { headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  });
  return { base: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`, posts, uploads, letters, close: () => server.shutdown() };
}

Deno.test({
  name: "G1: one application, prepare to card to the person's tap to claim to the employer's page to the recorded outcome, on a real database; a certification stops at the gate",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir() || !browserEnv()) {
      if (CI) throw Error("G1 needs Postgres 16 binaries and the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Postgres binaries or Playwright browser");
      return;
    }
    // The engine refuses an unsandboxed browser, and Chromium cannot sandbox as root (containers); CI runs unprivileged.
    if (Deno.uid?.() === 0 && !CI) {
      console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)");
      return;
    }
    const pg = await startPg();
    const site = employer();
    const work = await Deno.makeTempDir({ prefix: "trainee-flow-" });
    try {
      // Setup (not the person acting): their account, as the chat host writes it on their first text.
      await pg.sql(`insert into auth.users (id, email) values ('${PERSON}', 'flow.tester@example.test');
        insert into public.profiles (id) values ('${PERSON}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
        ${confirmedResumeSql(PERSON, "%PDF-1.4\n% synthetic flow-test resume\n%%EOF\n")}`);
      const factsPath = `${work}/facts.json`, resumePath = `${work}/resume.pdf`;
      await Deno.writeTextFile(factsPath, JSON.stringify(FACTS));
      await Deno.writeFile(resumePath, new TextEncoder().encode("%PDF-1.4\n% synthetic flow-test resume\n%%EOF\n"));
      const person = pg.asPerson(PERSON);
      // The engine's own record of what it sent (its daily limit counts it) lives in this run's directory, never in a home
      // directory that earlier runs filled.
      const runEngine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`] });
      const account = (await person.rpc("career_apply_account_own")).data;
      assertEquals(account, { epoch: 0, version: 0, paused: false });

      let preparedId = "";
      await t.step("prepare: the engine's dry run on the employer's page becomes a stored prepared application", async () => {
        const r = await prepare({ url: `${site.base}/plain`, factsPath, resumePath, account, now: Date.now(), runEngine });
        assert(r.ready, `not ready: ${JSON.stringify((r as any).result)}`);
        const saved = await person.rpc("career_apply_prepare_own", { p_payload: r.payload, p_card_lines: r.card });
        assertEquals(saved.error, null);
        preparedId = saved.data.id;
        assertEquals(saved.data.state, "ready");
        assertEquals(site.posts.plain, 0, "a dry run sends nothing");
      });

      await t.step("the attestation gate: a certification with no answer on file is asked of the person, never prepared or sent", async () => {
        const r = await prepare({ url: `${site.base}/attest`, factsPath, resumePath, account, now: Date.now(), runEngine });
        assertEquals(r.ready, false);
        assertEquals((r.result as any).reason, "needs_answers");
        const ask = questionsToStore(r.result as any, { facts: {}, answered: new Set() });
        assert(ask?.questions.length, "the certification is asked of the person");
        const put = await person.rpc("career_apply_questions_put_own", { p_job_id: ask!.posting, p_questions: ask!.questions });
        assertEquals(put.error, null);
        assertEquals(await pg.sql(`select count(*) from public.career_apply_prepared where user_id = '${PERSON}' and url like '%/attest'`), "0");
        assertEquals(site.posts.attest, 0);
      });

      let jobHash = "";
      await t.step("approve: the card shows the prepared application and the person's own tap enqueues exactly it", async () => {
        const card = await person.rpc("career_apply_card_open_own", { p_ids: [preparedId] });
        assertEquals(card.error, null);
        assertEquals(card.data.items.length, 1);
        const answer = await person.rpc("career_apply_card_answer_own", { p_card: card.data.id, p_approve: [1] });
        assertEquals(answer.error, null, JSON.stringify(answer));
        const row = JSON.parse(await pg.sql(`select row_to_json(j) from public.career_apply_jobs j where user_id = '${PERSON}' and url like '%/plain'`));
        assertEquals(row.state, "queued");
        assertEquals(row.approval_hash, row.payload_hash, "the job carries the hash the card showed");
        jobHash = row.payload_hash;
        assertEquals(await pg.sql(`select payload_hash from public.career_apply_prepared where id = '${preparedId}'`), jobHash);
        assertEquals(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${PERSON}' and url like '%/attest'`), "0");
      });

      await t.step("drive: the person's computer claims it, the engine sends exactly the approved application once, the outcome is recorded", async () => {
        const queue = ownQueue(person);
        const done = await runApproved({
          claim: () => queue.claim(1),
          finish: (id, lease, state, evidence) => queue.finish(id, lease, state, evidence),
          resumeFor: async (job) => ({ path: resumePath, sha256: job.payload.resume_sha256 }),
          writeFacts: async (_job, facts) => {
            const p = `${work}/approved-facts.json`;
            await Deno.writeTextFile(p, JSON.stringify(facts));
            return p;
          },
          runEngine,
        });
        assertEquals(done.length, 1);
        assertEquals(site.posts.plain, 1, "exactly one POST reached the employer's page");
        assertEquals(site.posts.attest, 0);
        const row = JSON.parse(await pg.sql(`select row_to_json(j) from public.career_apply_jobs j where user_id = '${PERSON}' and url like '%/plain'`));
        assertEquals(row.state, "submitted_unconfirmed", "a page's thank-you is never 'confirmed' (only the employer's email is)");
        assertMatch(JSON.stringify(row), /FLOW-PLAIN-1/);
        // G6 (D-024): the proof is kept with the record: a picture of the page at the click, taken after every check
        // before it, and one of the page after it, each named by its hash, its time and its place in the run's own
        // order, and bound at capture to this run, this application and this approval.
        const proof = row.evidence?.proof;
        assert(proof, `the row keeps the proof: ${JSON.stringify(row.evidence)}`);
        for (const shot of ["before_click", "after_submit"]) {
          assertMatch(String(proof[shot]?.file), new RegExp(`^proof-\\d+-${shot.replace("_", "-")}\\.png$`));
          const bytes = await Deno.readFile(`${row.evidence.evidence_path}/${proof[shot].file}`);
          assertEquals(proof[shot].sha256, await sha256hex(bytes), `${shot}: the row's hash is the picture's`);
          assertEquals([proof[shot].run_id, proof[shot].application_id], [proof.run_id, row.id], `${shot} is bound to this run and application`);
        }
        assert(proof.before_click.seq < proof.click.seq && proof.click.seq < proof.after_submit.seq,
          `before the click, then the click, then the page after it, in the run's own order: ${JSON.stringify(proof)}`);
        assertEquals(proof.application_id, row.id);
        assertEquals((await queue.claim(1)).length, 0, "nothing is left to claim: an application is driven once");
      });

      await t.step("negative control: an application changed after the person approved it is never sent", async () => {
        // Another employer (the company is the posting's host), so the once-per-company rule does not hold it back.
        const other = employer();
        try {
        const r = await prepare({ url: `${other.base}/second`, factsPath, resumePath, account, now: Date.now(), runEngine });
        assert(r.ready);
        const saved = await person.rpc("career_apply_prepare_own", { p_payload: r.payload, p_card_lines: r.card });
        const card = await person.rpc("career_apply_card_open_own", { p_ids: [saved.data.id] });
        const tap = await person.rpc("career_apply_card_answer_own", { p_card: card.data.id, p_approve: [1] });
        assertEquals(tap.data?.[0]?.result, "queued", JSON.stringify(tap));
        // Not the person: the stored payload is altered underneath the approval. G3: the database refuses the change...
        const alter = `update public.career_apply_jobs set payload = jsonb_set(payload, '{fields,0,value}', '"Someone Else"') where user_id = '${PERSON}' and url like '%/second'`;
        let refused = "";
        try { await pg.sql(alter); } catch (e) { refused = String((e as Error).message); }
        assert(/approval_fixed/.test(refused), `the database refuses the change: ${refused}`);
        // ...and a row corrupted past every trigger (as a superuser restoring data could) is still never sent.
        await pg.sql(`set session_replication_role = replica;\n${alter};\nset session_replication_role = origin;`);
        const queue = ownQueue(person);
        await runApproved({
          claim: () => queue.claim(1),
          finish: (id, lease, state, evidence) => queue.finish(id, lease, state, evidence),
          resumeFor: async (job) => ({ path: resumePath, sha256: job.payload.resume_sha256 }),
          writeFacts: async (_job, facts) => {
            const p = `${work}/approved-facts-2.json`;
            await Deno.writeTextFile(p, JSON.stringify(facts));
            return p;
          },
          runEngine,
        });
        assertEquals(other.posts.second, 0, "nothing reached the employer");
        const state = await pg.sql(`select state from public.career_apply_jobs where user_id = '${PERSON}' and url like '%/second'`);
        assertEquals(state, "not_submitted", "closed as not sent by the claim (G3), before any drive");
        } finally {
          await other.close();
        }
      });

      await t.step("receipt (G6): each finished application is said once, in the product's words, from the row the queue recorded", async () => {
        for (const part of RECEIPT_READ) assert(PROACTIVE_INDEX.replace(/\s+/g, " ").includes(part), `career-proactive/index.ts still reads finished rows as: ${part}`);
        const stores = receiptStores(pg), events: unknown[] = [];
        const eventStore = { add: async (e: unknown) => { events.push(e); }, recall: async () => [] };
        const run = () => runReceipts({ outbox: stores.outbox as any, now: Date.now(), finished: stores.finished, events: eventStore as any });
        assertEquals(await run(), 2, "one receipt for each of the two finished applications");
        const texts = JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('key', o.key, 'text', o.text, 'state', j.state) order by j.state), '[]')
          from public.career_outbox o join public.career_apply_jobs j on o.key = 'receipt:' || j.id where o.user_id = '${PERSON}' and o.kind = 'receipt'`));
        assertEquals(texts.map((x: any) => x.state), ["not_submitted", "submitted_unconfirmed"]);
        console.log(texts.map((x: any) => x.text).join("\n"));
        // The claim's own words for why (G3: "not sent: the application changed after it was approved"), said once.
        assertMatch(texts[0].text, /^Not sent to \S+: the application changed after it was approved\. Nothing reached the employer\.$/);
        assertMatch(texts[1].text, /^Sent to .+\. Their page said it was received; their confirmation email is the proof, and I'll mark it confirmed when it comes\.$/);
        assert(!/confirmed by/.test(texts[1].text), "a page's thank-you is never said as the employer's confirmation");
        assertEquals(await run(), 0, "a second run says nothing again: the outbox key is once, ever");
        assertEquals(await pg.sql(`select count(*) from public.career_outbox where user_id = '${PERSON}' and kind = 'receipt'`), "2");
        assertEquals(events.length, 2, "each is written to their timeline once");
      });
    } finally {
      await site.close();
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});

// G4 (D-011): prepared before the person asks. Their job alerts sent them two postings (career_outbox 'alert:<job_id>');
// before they text anything, the server prepares each with their own confirmed answers (questions they answered earlier)
// and the resume tailored to it from their confirmed profile (WO-028). The employer pages are the same local pages: the
// postings' https links are opened there by the worker's urlFor seam (production: the posting's own link).
const ALERTED = [
  { job_id: "greenhouse:flowtest:1", path: "/plain", company: "TEST First Employer" },
  { job_id: "greenhouse:flowtest:2", path: "/portfolio", company: "TEST Portfolio Employer" },
];
const NOT_ALERTED = { job_id: "greenhouse:flowtest:3", path: "/second", company: "TEST Unalerted Employer" };
// Alerted later (the cover-letter steps): its form asks for a cover letter typed into a text box. Another employer, so it
// is served from its own site (the engine names a local page's employer by its host).
const COVER = { job_id: "greenhouse:flowtest:4", path: "/cover", company: "TEST Cover Employer" };
// What the stub model writes when asked for the cover letter: only what the person's confirmed facts say (F-002, F-004 of
// the fixture) and the company's name, so the drafter's own fact check passes it. The model is a stub; nothing is paid for.
const LETTER = "I built a reporting dashboard in React and Python used by 200 internal users at TEST Systems Inc, and I cut weekly " +
  "reporting time by 40% by automating data pulls from PostgreSQL. I also built DeployBoard in Go to deploy containerised apps on " +
  "Kubernetes for 12 student teams. I want to bring that work on dashboards for internal teams to TEST Cover Employer.";
// The person's profile as the chat keeps it: the synthetic test resume (WO-028's fixture), each fact confirmed the way the
// chat confirms one (the brain's confirm_profile_fact, its event recorded: the owner's provenance and confirmation event,
// which is what the trust contract keeps; g4-profile-provenance.test.ts proves the rest is left out).
async function confirmedProfile() {
  const text = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
  const p = (CareerProfile as any).createProfile({ basics: { name: "Flow Tester", email: "flow.tester@example.test", location: "Chicago, IL" } });
  assert((CareerProfile as any).ingestResume(p, { text, fileName: "test-resume.txt" }).ok);
  const confirm = careerTools({ postings: async () => [], events: { add: async () => {}, recall: async () => [] } as any })
    .find((x) => x.name === "confirm_profile_fact")!;
  for (const f of p.facts) {
    await confirm.run({ id: f.id }, { userId: PERSON, threadId: "thread-flow-1", now: Date.now(), state: { profile: p }, turn: { message: "yes", added: [], before: "" } } as any);
  }
  assert(p.facts.every((f: any) => f.confirmation_event_id), "every fact carries its confirmation event");
  return { ...p, user_id: PERSON };
}

Deno.test({
  name: "G4: an alerted posting is prepared on the server before the person asks, with their own answers and the resume tailored to it; their card and tap then send exactly it",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir() || !browserEnv()) {
      if (CI) throw Error("G4 needs Postgres 16 binaries and the gate's Playwright browser in CI");
      console.log("NOT_RUN locally: no Postgres binaries or Playwright browser");
      return;
    }
    if (Deno.uid?.() === 0 && !CI) {
      console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)");
      return;
    }
    const pg = await startPg();
    const site = employer(), coverSite = employer();
    const work = await Deno.makeTempDir({ prefix: "trainee-ahead-test-" });
    try {
      // Setup (not the person acting): their account; the answers they texted to earlier questions (ask once, G2's
      // store); the postings their alerts sent them, and one they were never sent.
      await pg.sql(`insert into auth.users (id, email) values ('${PERSON}', 'flow.tester@example.test');
        insert into public.profiles (id) values ('${PERSON}');
        insert into public.career_watch_kv (user_id, key, value) values ('${PERSON}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
        ${confirmedResumeSql(PERSON)}
        insert into public.career_apply_questions (user_id, key, kind, label, type, state, answer, answered_at) values
         ('${PERSON}', 'fact:first_name', 'fact', 'First name', 'input_text', 'answered', 'Flow', now()),
         ('${PERSON}', 'fact:last_name', 'fact', 'Last name', 'input_text', 'answered', 'Tester', now()),
         ('${PERSON}', 'fact:email', 'fact', 'Email', 'input_text', 'answered', 'flow.tester@example.test', now());`);
      for (const p of [...ALERTED, NOT_ALERTED, COVER]) {
        await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at)
          values ('${p.job_id}', 'greenhouse', 'flowtest', '${p.company}', 'TEST Analyst', 'Chicago, IL', 'https://boards.greenhouse.io/flowtest/jobs/${p.job_id.split(":")[2]}',
          'TEST Analyst. Requirements: SQL, Python, dashboards for internal teams.', now(), now())`);
      }
      for (const p of ALERTED) {
        await pg.sql(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values ('${PERSON}', 'alert:${p.job_id}', 'alert', 'TEST alert', now())`);
      }
      const svc = pg.asService(), person = pg.asPerson(PERSON);
      const local = new Map([...ALERTED, NOT_ALERTED, COVER].map((p) => [p.job_id, `${p === COVER ? coverSite.base : site.base}${p.path}`]));
      // The private resume store: kept in memory here; each file it stores is registered as the bucket object it would be,
      // which is what lets career_apply_resume_tag call the queued job tailored.
      const memory = memoryResumeStore();
      const resumes: ResumeStore = {
        put: async (path, pdf) => {
          await memory.put(path, pdf);
          // As the real store's upload with upsert: storing the same file again is one object.
          await pg.sql(`insert into storage.objects (bucket_id, name) values ('career-resumes', '${path}') on conflict (bucket_id, name) do nothing`);
        },
        signedUrl: (path, seconds) => memory.signedUrl(path, seconds),
        removeAll: (u) => memory.removeAll(u),
      };
      const profile = await confirmedProfile();
      const profileFor = async (u: string) => u === PERSON ? profile : null;
      // The engine's own record of what it sent (its daily limit counts it) lives in this run's directory, never in a home
      // directory that earlier runs filled.
      const runEngine = engineRunner({ root: ROOT, extra: ["--state-dir", `${work}/engine-state`] });
      const deps = {
        db: svc, runEngine, profileFor, urlFor: (c: { job_id: string }) => local.get(c.job_id)!,
        resumeFor: tailoredResume({ render: edgeRenderer(), resumes }),
      };

      let preparedId = "", tailoredSha = "";
      await t.step("prepare ahead: before the person texts anything, each alerted posting is prepared or its question asked; nothing is sent", async () => {
        assertEquals(await pg.sql(`select count(*) from public.career_apply_prepared where user_id = '${PERSON}'`), "0");
        const done = await prepareAhead(deps);
        const by = new Map(done.map((r) => [r.job_id, r]));
        assertEquals(by.get(ALERTED[0].job_id)?.outcome, "ready", JSON.stringify(done));
        assertEquals(by.get(ALERTED[1].job_id)?.outcome, "asked", JSON.stringify(done));
        assertEquals(by.has(NOT_ALERTED.job_id), false, "a posting their alerts never sent them is not prepared");
        preparedId = by.get(ALERTED[0].job_id)!.prepared_id!;
        const row = JSON.parse(await pg.sql(`select row_to_json(p) from public.career_apply_prepared p where id = '${preparedId}'`));
        assertEquals(row.state, "ready");
        assertEquals(row.payload.resume_tailored, true, "the payload carries the tailored resume");
        tailoredSha = row.payload.resume_sha256;
        assert(memory.files.has(`career-resumes/${PERSON}/${tailoredSha}.pdf`), "the payload's resume is the one stored for them, by its hash");
        assert(row.card_lines.some((l: string) => /tailored for this role/.test(l)), `the card says so: ${row.card_lines.join(" | ")}`);
        const names = row.payload.fields.map((f: any) => [f.name, f.value]);
        assertEquals(names.filter((n: string[]) => n[0] !== "resume"), [["first_name", "Flow"], ["last_name", "Tester"], ["email", "flow.tester@example.test"]],
          "only their own answers");
        const q = JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('key', key, 'state', state)), '[]') from public.career_apply_questions where user_id = '${PERSON}' and state = 'open'`));
        assertEquals(q, [{ key: "fact:website", state: "open" }], "the portfolio question is asked of them once, before they ask");
        assertEquals(site.posts.plain + site.posts.portfolio + site.posts.second, 0, "a dry run sends nothing");
        assertEquals(await pg.sql(`select count(*) from public.career_apply_jobs where user_id = '${PERSON}'`), "0", "nothing is queued without their tap");
      });

      await t.step("once: a second run prepares nothing again; a paused account is never prepared for", async () => {
        assertEquals((await prepareAhead(deps)).length, 0, "nothing new: the prepared one is done and the asked one waits on them");
        // They answer the question (their text, career_apply_questions.ts) while their account is paused: the asked posting
        // would be prepared now (the next step), but a paused account is never prepared for.
        await pg.sql(`update public.career_watch_kv set value = value || '{"paused":true}' where user_id = '${PERSON}' and key = 'career:account';
          update public.career_apply_questions set state = 'answered', answer = 'https://flow.example.test', answered_at = now() where user_id = '${PERSON}' and key = 'fact:website';`);
        assertEquals((await prepareAhead(deps)).length, 0, "paused: nothing is prepared");
        assertEquals(await pg.sql(`select outcome from public.career_apply_prepare_attempts where user_id = '${PERSON}' and posting_job_id = '${ALERTED[1].job_id}'`), "asked",
          "the try that asked is still on record (under a week old): only the answered questions make it a candidate again");
        await pg.sql(`update public.career_watch_kv set value = value || '{"paused":false}' where user_id = '${PERSON}' and key = 'career:account'`);
      });

      await t.step("answered: once they answer the question it stopped on, the next run prepares that posting too", async () => {
        const done = await prepareAhead(deps);
        assertEquals(done.map((r) => [r.job_id, r.outcome]), [[ALERTED[1].job_id, "ready"]], JSON.stringify(done));
        const row = JSON.parse(await pg.sql(`select row_to_json(p) from public.career_apply_prepared p where id = '${done[0].prepared_id}'`));
        assert(row.payload.fields.some((f: any) => f.name === "portfolio" && f.value === "https://flow.example.test"), "their own answer, as they texted it");
      });

      await t.step("their card and tap: the job queued is exactly the prepared one, and it is marked tailored", async () => {
        const card = await person.rpc("career_apply_card_open_own", { p_ids: [preparedId] });
        assertEquals(card.error, null, JSON.stringify(card));
        const answer = await person.rpc("career_apply_card_answer_own", { p_card: card.data.id, p_approve: [1] });
        assertEquals(answer.error, null, JSON.stringify(answer));
        const job = JSON.parse(await pg.sql(`select row_to_json(j) from public.career_apply_jobs j where user_id = '${PERSON}' and url like '%/plain'`));
        assertEquals(job.state, "queued");
        assertEquals(job.payload_hash, await pg.sql(`select payload_hash from public.career_apply_prepared where id = '${preparedId}'`));
        assertEquals([job.tailored, job.resume_sha256], [true, tailoredSha], "career_apply_resume_tag: the stored tailored file");
      });

      // Their own computer runs what they approved (the queue's claim and finish, as the person).
      const drive = () => {
        const queue = ownQueue(person);
        return runApproved({
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
      };

      await t.step("drive: the employer receives the tailored resume, byte for byte, once", async () => {
        const done = await drive();
        assertEquals(done.length, 1);
        assertEquals(site.posts.plain, 1, `exactly one POST reached the employer's page: ${JSON.stringify(done)}`);
        assertEquals(site.uploads.plain, tailoredSha, "the file the employer received is the tailored one");
        assertEquals(await pg.sql(`select state from public.career_apply_jobs where user_id = '${PERSON}' and url like '%/plain'`), "submitted_unconfirmed");
      });

      // The cover letter. The drafter is the chat's own (essay_draft.ts draftEssay: the employer's AI policy first, only
      // confirmed facts, every name and number traced); the model is a stub that counts its calls.
      const modelCalls: unknown[] = [];
      const draftModel = async (payload: unknown) => {
        modelCalls.push(payload);
        return { content: [{ type: "text", text: LETTER }], stop_reason: "end_turn" };
      };
      // The chat's question store: the production store's database calls (open, answer, the drafts written ahead) over the
      // service role, as the edge function holds it; the rest is what the chat host keeps (which questions were shown,
      // the thread's last reply), here in memory.
      const real = supabaseQuestionStore({ rpc: (name: string, args?: unknown) => svc.rpc(name, args) });
      let shown: Shown | null = null;
      const asQuestions = async (where: string): Promise<OpenQuestion[]> =>
        JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('id', id, 'key', key, 'kind', kind, 'label', label, 'type', type,
          'options', options, 'company', company, 'job_ids', job_ids, 'misfit', misfit, 'answer', answer, 'ai_policy', ai_policy)), '[]')
          from public.career_apply_questions where user_id = '${PERSON}' and ${where}`));
      const store: QuestionStore = {
        open: real.open, answer: real.answer, drafted: real.drafted,
        countOpen: async () => Number(await pg.sql(`select count(*) from public.career_apply_questions where user_id = '${PERSON}' and state = 'open'`)),
        get: (_u, ids) => asQuestions(`id = any('{${ids.join(",")}}'::uuid[])`),
        onPostings: (_u, jobIds) => asQuestions(`job_ids && '{${jobIds.join(",")}}'::text[]`),
        shown: async () => shown,
        setShown: async (_u, s) => { shown = structuredClone(s); },
        lastAssistantIntent: async () => QUESTIONS_INTENT, // every reply below is the questions' (the host records its intent)
      };
      const text = (message: string) =>
        questionsTurn({ message, userId: PERSON, threadId: "thread-flow-1", now: Date.now(), store, draft: { model: draftModel, facts: () => profile.facts } });
      let letterQuestion = "";

      await t.step("cover letter ahead: a posting that asks for one gets it drafted from their confirmed facts before they ask; nothing is saved or sent", async () => {
        // A fact they mentioned but never confirmed: it must never reach the drafter's model.
        const unconfirmed = (CareerProfile as any).addFact(profile, {
          kind: "experience", title: "Desk Lead, ZETAQUANT Trading (TEST)", text: "Desk Lead, ZETAQUANT Trading (TEST) Ran a trading desk of 900 people",
          bullets: ["Ran a trading desk of 900 people"], source: "chat", needs_confirmation: true,
        });
        assert(unconfirmed.needs_confirmation === true, JSON.stringify(unconfirmed));
        await pg.sql(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values ('${PERSON}', 'alert:${COVER.job_id}', 'alert', 'TEST alert', now())`);
        const done = await prepareAhead({ ...deps, draftModel });
        assertEquals(done.map((r) => [r.job_id, r.outcome]), [[COVER.job_id, "asked"]], JSON.stringify(done));
        assertMatch(done[0].detail, /cover letter drafted/);
        assertEquals(modelCalls.length, 1, "one draft, written once");
        const sent = JSON.stringify(modelCalls[0]);
        assert(sent.includes("TEST Systems Inc"), "the drafter was given their confirmed facts");
        assert(!sent.includes("ZETAQUANT"), "an unconfirmed fact never reaches the model");
        const q = await asQuestions(`state = 'open'`);
        assertEquals(q.map((x) => [x.kind, x.label, x.answer]), [["essay", "Cover letter", null]], "the cover letter is asked of them, unanswered");
        letterQuestion = q[0].id;
        assertEquals(await pg.sql(`select text from public.career_apply_question_drafts where question_id = '${letterQuestion}'`), LETTER,
          "the draft waits beside the question");
        assertEquals(coverSite.posts.cover, 0, "nothing is sent");
        assertEquals(await pg.sql(`select count(*) from public.career_apply_prepared where user_id = '${PERSON}' and url like '%/cover'`), "0",
          "nothing is prepared on a draft they have not read");
      });

      await t.step("their text: the questions say a draft is ready; it is shown whole only when they ask; only \"use 1\" saves it", async () => {
        const list = await text("what do you need from me");
        assertEquals(list?.status, "shown", JSON.stringify(list));
        // One question per message (review of #360): the cover letter is the question shown, under its own line.
        assertMatch(list!.reply, /\nCover letter/);
        assertMatch(list!.reply, /A draft of 1 is ready, written only from your confirmed facts\. Say "draft 1" to read it/);
        const early = await text("use 1");
        assertEquals(early?.status, "draft_none", "a draft they have not read is never saved");
        assertEquals((await asQuestions(`id = '${letterQuestion}'`))[0].answer, null);
        const read = await text("draft 1");
        assertEquals(read?.status, "drafted_ahead", JSON.stringify(read));
        assert(read!.reply.includes(LETTER), "shown whole, word for word");
        assertMatch(read!.reply, /Nothing is saved yet/);
        assertEquals(modelCalls.length, 1, "the draft written ahead is shown; the model is not called again");
        assertEquals((await asQuestions(`id = '${letterQuestion}'`))[0].answer, null, "reading it saves nothing");
        const use = await text("use 1");
        assertEquals(use?.status, "answered", JSON.stringify(use));
        assertEquals((await asQuestions(`id = '${letterQuestion}'`))[0].answer, LETTER, "saved as drafted, by their word");
      });

      await t.step("answered: the next run prepares the posting with their letter; their tap sends it word for word", async () => {
        const done = await prepareAhead({ ...deps, draftModel });
        assertEquals(done.map((r) => [r.job_id, r.outcome]), [[COVER.job_id, "ready"]], JSON.stringify(done));
        assertEquals(modelCalls.length, 1, "nothing is drafted again");
        const row = JSON.parse(await pg.sql(`select row_to_json(p) from public.career_apply_prepared p where id = '${done[0].prepared_id}'`));
        assert(row.payload.fields.some((f: any) => f.name === "cover_letter" && f.value === LETTER), JSON.stringify(row.payload.fields));
        const card = await person.rpc("career_apply_card_open_own", { p_ids: [done[0].prepared_id] });
        assertEquals(card.error, null, JSON.stringify(card));
        assertEquals((await person.rpc("career_apply_card_answer_own", { p_card: card.data.id, p_approve: [1] })).error, null);
        assertEquals((await drive()).length, 1);
        assertEquals(coverSite.posts.cover, 1, "exactly one POST");
        assertEquals(coverSite.letters.cover, LETTER, "the employer received the letter they chose, word for word");
      });
    } finally {
      await site.close();
      await coverSite.close();
      await pg.stop();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
