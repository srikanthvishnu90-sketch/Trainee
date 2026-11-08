// Release 9, workstream D (architect): the end-to-end task-completion eval judges the REAL outcome, and its gate (S6) is
// wired but off by default. These tests hold the eval's own guards: each judge passes a correct outcome and fails each way
// an outcome can be wrong, the stub ATS records a real form post through the product's own cloud worker, and S6 reads only
// the E2E rows of the score log. No database, no model, no network beyond 127.0.0.1.
// deno-lint-ignore-file no-explicit-any require-await
import { judgeApply, judgeOutreach, judgeResearch, judgeResume, type E2EState, factBacked, inventedIn } from "../../evals/career/e2e/judge.ts";
import { readPdf, StubAts, stubEngine } from "../../evals/career/e2e/worlds.ts";
import { appendRow, E2E_HEADER, type E2ERun, scoreRow } from "../../evals/career/e2e/score_log.ts";
import { runCloudJob, type CloudQueue } from "../../workers/career-cloud/worker.ts";
import { factsFromPayload } from "../../workers/career-browser/approve-first.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { cardBound } from "../helpers/cloud_card_auth.ts";
import { ALL_CHECKS, defaultChecks, type E2ERow, meetsE2EBar, parseE2ELog, parseScoreLog, s6, type Sources } from "../../scripts/launch/deploy-standard.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}\n  got:  ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`); };
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");

const RESUME = new TextEncoder().encode("%PDF-1.4 TEST resume bytes");
const RESUME_SHA = await hex(RESUME);
const CONFIRMED = "Alex Testcase (TEST)\nalex.testcase@example.test | +1 555-0100\nAuthorized to work in the United States: yes";
const empty = (): E2EState => ({ wanted: [], jobs: [], ats: [], confirmed: { text: CONFIRMED, resume_sha256: RESUME_SHA, name: "Alex Testcase" }, drafts: [], sendQueue: [], mail: [], contacts: ["maya.chen@stripe.example"], hashOf: {}, files: [], documents: [], stage: [] });

async function approvedJob(fields: { name: string; label: string; value: string }[]) {
  const payload: any = {
    version: 1, user_id: "u-e2e", job_id: "greenhouse:acme:101", company: "Acme", url: "https://boards.greenhouse.io/acme/jobs/101", destination: "https://boards.greenhouse.io/acme/jobs/101",
    fields: fields.map((f, i) => ({ ...f, factId: `TEST-${i}` })), resume_sha256: RESUME_SHA, privacy_epoch: 1, account_version: 1, expires_at: "2099-01-01T00:00:00Z",
  };
  payload.engine_approval = await hashApplyPayload(factsFromPayload(payload).saved);
  return await cardBound({ id: "job-e2e-1", lease_token: "lease-1", user_id: "u-e2e", company: "Acme", url: payload.url, job_id: payload.job_id, payload });
}
const FIELDS = [{ name: "first_name", label: "First Name", value: "Alex" }, { name: "last_name", label: "Last Name", value: "Testcase" }, { name: "email", label: "Email", value: "alex.testcase@example.test" }, { name: "question_9001", label: "Are you legally authorized to work in the United States?", value: "1" }];

// The product's cloud worker, the eval's engine and the stub ATS, end to end; returns what the world and the queue saw.
async function drive(job: any) {
  const ats = await new StubAts([{ board: "acme", job: "101", title: "Frontend Engineering Intern", company: "Acme" }]).start();
  const real = globalThis.fetch, finished: any[] = [];
  globalThis.fetch = (async (i: any, init?: any) => { const req = i instanceof Request && !init ? i : new Request(i, init); return /greenhouse\.io$/.test(new URL(req.url).hostname) ? await ats.forward(req, real) : new Response("no", { status: 404 }); }) as typeof fetch;
  const queue: CloudQueue = { claim: async () => [], authorize: async () => {}, resume: async () => ({ filename: "resume.pdf", sha256: RESUME_SHA, b64: btoa(String.fromCharCode(...RESUME)) }),
    finish: async (_j, state, evidence) => { finished.push({ state, evidence }); }, ask: async () => 0, gatePresent: async () => true };
  try { await runCloudJob(job, { queue, runEngine: stubEngine(job, hashApplyPayload, factsFromPayload) as any, log: () => {} }); }
  finally { globalThis.fetch = real; await ats.stop(); }
  const f = finished[0] ?? { state: "none", evidence: {} };
  const s = empty();
  s.ats = ats.posts;
  s.jobs = [{ id: job.id, job_id: job.job_id, company: job.company, url: job.url, payload: job.payload, payload_hash: job.payload_hash, approval_hash: job.approval_hash, state: f.state, confirmation_id: null, evidence: f.evidence, payload_hash_now: await hashApplyPayload(job.payload) }];
  return { s, f, posts: ats.posts };
}

Deno.test("E2E apply: an approved application goes through the cloud worker to the stub ATS as a real form post, with proof", async () => {
  const { s, f, posts } = await drive(await approvedJob(FIELDS));
  eq(posts.length, 1, "one form post reached the employer");
  eq(posts[0].fields, { first_name: "Alex", last_name: "Testcase", email: "alex.testcase@example.test", question_9001: "1" }, "exactly the approved fields");
  eq(posts[0].files.map((x) => [x.name, x.sha256]), [["resume", RESUME_SHA]], "the approved resume bytes");
  eq(f.state, "confirmed");
  eq(judgeApply({ min: 1, companies: ["Acme"] }, s), [], "submitted with proof, matching the approval, nothing invented");
});

Deno.test("E2E apply mutations: a changed application is never posted; an invented answer, a missing proof or a wrong resume fails", async () => {
  const job = await approvedJob(FIELDS);
  job.payload.fields[2].value = "someone.else@example.test"; // changed after the person approved it
  const changed = await drive(job);
  eq(changed.posts.length, 0, "the worker refuses a payload that is no longer the approved one; nothing reaches the employer");
  assert(judgeApply({ min: 1 }, changed.s).some((x) => /never reached the employer|0 submitted/.test(x)), "and the task fails");

  const invented = await drive(await approvedJob([...FIELDS, { name: "phone", label: "Phone", value: "+1 312 555 7777" }]));
  eq(invented.posts.length, 1);
  assert(judgeApply({ min: 1 }, invented.s).some((x) => /invented answer: phone/.test(x)), "a phone the person never confirmed is an invented answer");

  const ok = await drive(await approvedJob(FIELDS));
  const noProof = { ...ok.s, jobs: ok.s.jobs.map((j) => ({ ...j, state: "unknown_outcome", evidence: {} })) };
  assert(judgeApply({ min: 1 }, noProof).some((x) => /no proof/.test(x)), "no recorded confirmation: no proof");
  const otherResume = { ...ok.s, confirmed: { ...ok.s.confirmed, resume_sha256: "0".repeat(64) } };
  assert(judgeApply({ min: 1 }, otherResume).some((x) => /not the person's confirmed resume/.test(x)));
  eq(judgeApply({ max: 0 }, empty()), [], "a guard holds when nothing was sent");
  assert(judgeApply({ max: 0 }, ok.s).length > 0, "and breaks when something was");
  assert(factBacked("1", CONFIRMED) && !factBacked("1", "Alex Testcase") && factBacked("+1 555 0100", "+1 555-0100 here") && !factBacked("+1 312 555 7777", CONFIRMED));
});

Deno.test("E2E outreach: delivered as approved to a verified address with the opt-out header; each way it can be wrong fails", async () => {
  const d = { id: "d1", recipient_email: "maya.chen@stripe.example", subject: "A quick question", body: "Hi Maya,\n\nWould you have 15 minutes?", footer: "Alex Testcase\n\nReply stop and I won't write again.", hash: "h1", approved_hash: "h1", status: "sent" };
  const mail = { id: "m1", threadId: "t1", account: "u", to: d.recipient_email, subject: d.subject, text: `${d.body}\n\n${d.footer}`, headers: ["To: maya.chen@stripe.example", "List-Unsubscribe: <mailto:alex.testcase@example.test?subject=unsubscribe>"], at: 0 };
  const s = { ...empty(), drafts: [d], mail: [mail], hashOf: { d1: "h1" } };
  eq(judgeOutreach({ to: [d.recipient_email] }, s), []);
  assert(judgeOutreach({ to: [d.recipient_email] }, { ...s, mail: [{ ...mail, headers: ["To: maya.chen@stripe.example"] }] }).some((x) => /List-Unsubscribe/.test(x)), "no opt-out header");
  assert(judgeOutreach({ to: [d.recipient_email] }, { ...s, mail: [{ ...mail, text: `${d.body} PS\n\n${d.footer}` }], hashOf: { d1: "h2" } }).some((x) => /not the approved body|hash/.test(x)), "a changed body");
  assert(judgeOutreach({ to: [d.recipient_email] }, { ...s, contacts: [] }).some((x) => /unverified/.test(x)), "an address the person never gave");
  assert(judgeOutreach({ to: [d.recipient_email] }, { ...s, drafts: [{ ...d, approved_hash: null }] }).some((x) => /never approved/.test(x)));
  assert(judgeOutreach({ max: 0 }, s).length > 0 && judgeOutreach({ max: 0 }, empty()).length === 0, "the guard");
});

Deno.test("E2E research: delivered, every number cited, an https source; uncited or undelivered fails", () => {
  const f = { id: "f1", kind: "research_brief", html: "", text: "Data analyst roles in Chicago: 1,240 open", delivered: true, findings: [{ text: "Open data analyst roles in Chicago 1,240", source: "Reported, not verified" }], sources: ["https://example.test/report"] };
  eq(judgeResearch({ has: ["data analyst", "Chicago"] }, { ...empty(), files: [f] }), []);
  assert(judgeResearch({ has: [] }, { ...empty(), files: [{ ...f, findings: [{ text: "Median pay 72,000", source: null }] }] }).some((x) => /without a source/.test(x)));
  assert(judgeResearch({ has: [] }, { ...empty(), files: [{ ...f, delivered: false }] }).some((x) => /no research file delivered/.test(x)));
  assert(judgeResearch({ has: [] }, { ...empty(), files: [{ ...f, sources: [] }] }).some((x) => /https source/.test(x)));
});

// A one-page PDF a reader opens, with the text drawn by Tj (uncompressed stream).
function pdf(lines: string[], pages = 1): Uint8Array {
  const content = lines.map((l, i) => `BT /F1 11 Tf 1 0 0 1 54 ${720 - i * 14} Tm (${l.replace(/[()\\]/g, "\\$&")}) Tj ET`).join("\n");
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i} 0 R`).join(" ");
  const objs = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...Array.from({ length: pages }, () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 3 0 R >>`)];
  return new TextEncoder().encode(`%PDF-1.4\n${objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj`).join("\n")}\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);
}
Deno.test("E2E resume: returned, opens, fits the page, only confirmed facts, names the person; each way it can be wrong fails", async () => {
  const resume = "Alex Testcase\nalex.testcase@example.test\nBuilt a reporting dashboard in React and Python used by 200 internal users\nCut weekly reporting time by 40% by automating data pulls from PostgreSQL\nSkills: Python, React, PostgreSQL, Go, Kubernetes, Docker, Excel";
  const confirmed = { text: `${resume}\nFinancial Modeling`, resume_sha256: RESUME_SHA, name: "Alex Testcase" };
  const good = await readPdf(pdf(resume.split("\n")));
  assert(good.opens && good.pages === 1 && good.text.includes("40% by automating"), JSON.stringify(good));
  const doc = (p: any, delivered = true) => ({ filename: "Resume.pdf", mime: "application/pdf", delivered, pdf: p });
  eq(judgeResume({ min: 1, max_pages: 1 }, { ...empty(), confirmed, documents: [doc(good)] }), []);
  const invented = await readPdf(pdf([...resume.split("\n"), "Led a team of 12 engineers using Rust and Tableau"]));
  eq(inventedIn(invented.text, confirmed.text), ["12", "rust", "tableau"], "a number and two skills never confirmed");
  assert(judgeResume({ min: 1 }, { ...empty(), confirmed, documents: [doc(invented)] }).some((x) => /never confirmed/.test(x)));
  assert(judgeResume({ min: 1, max_pages: 1 }, { ...empty(), confirmed, documents: [doc(await readPdf(pdf(resume.split("\n"), 2)))] }).some((x) => /2 pages/.test(x)));
  assert(judgeResume({ min: 1 }, { ...empty(), confirmed, documents: [doc(good, false)] }).some((x) => /never sent back/.test(x)), "stored but not returned");
  assert(judgeResume({ min: 1 }, { ...empty(), confirmed, documents: [doc(await readPdf(pdf(resume.split("\n").slice(2))))] }).some((x) => /name/.test(x)), "no name on it");
  assert(!(await readPdf(new TextEncoder().encode("%PDF-1.4 broken"))).opens, "a file without a trailer does not open");
});

// ------------------------------------------------------------------------------------------------ the gate (S6)
const run = (completed: number, o: Partial<E2ERun> = {}): E2ERun => ({ label: "e2e-x", brain: "production", model: "claude", commit: "a".repeat(40), total: 40, passed: completed, rate: completed / 40,
  areas: { apply: { total: 10, passed: 0 }, outreach: { total: 10, passed: 0 }, research: { total: 10, passed: 0 }, resume: { total: 10, passed: 0 } }, guards: { total: 6, held: 6 }, stopped: null, cost_usd: 1.234, items: [], run_at: "2026-11-07T12:00:00.000Z", ...o });
const LOG = "# Brain score log\n\n| run at (UTC) | brain commit | set | brain | set size | passed | score | judges | stopped | CI run |\n|---|---|---|---|---|---|---|---|---|---|\n| 2026-11-01 00:00:00 | abcdef1 | dev | staged | 38 | 36 | 94.7% | j | no | 1 |\n";
function src(log: string | null, parents: Record<string, string> = {}, changed = false): Sources {
  return { scoreLog: async () => log, parent: async (s: string) => parents[s] ?? null, changed: async () => changed } as unknown as Sources;
}
Deno.test("S6: off by default, on with S6_REQUIRED=1; reads only E2E rows; passes at >= 90% with the claude model and every guard held", async () => {
  eq(defaultChecks({ get: () => undefined }), ALL_CHECKS, "S6 is not in the default run until the owner turns it on");
  eq(defaultChecks({ get: (k) => (k === "S6_REQUIRED" ? "0" : undefined) }), ALL_CHECKS);
  eq(defaultChecks({ get: (k) => (k === "S6_REQUIRED" ? "1" : undefined) }), [...ALL_CHECKS, "S6"]);
  const C = "a".repeat(40);
  let log = appendRow(LOG, scoreRow(run(36)));
  assert(log.includes(E2E_HEADER));
  eq(parseScoreLog(log).length, 1, "the reply-quality parser (S3) never reads an E2E row");
  const rows: E2ERow[] = parseE2ELog(log);
  eq(rows.map((r) => [r.completed, r.tasks, r.model, r.guardsHeld]), [[36, 40, "claude", 6]], "and S6 reads only E2E rows");
  assert(meetsE2EBar(rows[0]), "36/40 = 90% meets the bar exactly");
  eq((await s6(src(log), C)).pass, true);
  log = appendRow(log, scoreRow(run(35)));
  eq((await s6(src(log), C)).pass, false, "the newest row decides: 35/40 = 87.5% < 90%");
  const fake = appendRow(LOG, scoreRow(run(40, { model: "fake" })));
  eq((await s6(src(fake), C)).pass, false, "a fake-model row (the oracle fixture) is never the release bar");
  const guard = appendRow(LOG, scoreRow(run(40, { guards: { total: 6, held: 5 } })));
  eq((await s6(src(guard), C)).pass, false, "a broken guard fails whatever the completion");
  const stopped = appendRow(LOG, scoreRow(run(40, { stopped: "budget: $3 of $3" })));
  eq((await s6(src(stopped), C)).pass, false, "a stopped run is not a score");
  const small = appendRow(LOG, scoreRow(run(10, { total: 10 })));
  eq((await s6(src(small), C)).pass, false, "a partial set (--only) is not the full set");
  const P = "b".repeat(40), onParent = appendRow(LOG, scoreRow(run(38, { commit: P })));
  eq((await s6(src(onParent, { [C]: P }), C)).pass, true, "an ancestor's measurement counts when nothing under E2E_CODE changed");
  eq((await s6(src(onParent, { [C]: P }, true), C)).pass, false, "and not when the product or the eval changed since");
  eq((await s6(src(null), C)).pass, false, "an unreadable log fails");
});
