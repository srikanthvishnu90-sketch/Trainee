// WO-G (R10 fix 13; spec B.3, C.12, C.23 item 10, E.3 #25/#26/#32/#33, E.11 "employer-form fill, final application
// submission, receipt reconciliation"), end to end on a real Postgres 16 (the flow harness: every migration in production
// order) with the eval world's stub employer (evals/career/e2e/worlds.ts StubAts, a real HTTP form post on 127.0.0.1) and
// the production cloud worker (workers/career-cloud/worker.ts runCloudJob). No model, no real host.
//   approve  the person's approved payload is queued (career_apply_enqueue, approval hash = payload hash): "Approved, not sent".
//   send     the worker claims it (career_apply_sweep + career_apply_claim_fair): "Sending, not confirmed"; the engine (the eval's
//            stub engine) checks the approved hash, asks for the one Submit authorization and posts the form once.
//   uncertain the employer took the post but its answer never came back (the final click timed out): the worker records
//            unknown_outcome. Every surface says "Submission uncertain", never "Submitted", and no confirmation id exists.
//   no retry the queue hands it out again to nobody, the same approval cannot be queued twice, and a second worker pass posts
//            nothing more: the stub employer holds exactly one application.
//   reconcile the employer's own email (planConfirmations over the queue's rows, career_apply_confirm_as) makes it confirmed;
//            only then does the closeout read "Submitted <role> at <employer> at <time>. Confirmation: <their email>."
// Fail-first: on trunk 5cb45c83 the proof File for the claimed row said "Prepared" (sending was not its own state), there was
// no closeout in spec B.3's shape, and the File of an application confirmed by the employer's email alone could not be made.
import { pgBinDir, startPg } from "../flow/pg.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts"; // OWNER RULE 2026-10-26: a confirmed resume file
import { ATS_HOST, StubAts, stubEngine } from "../../evals/career/e2e/worlds.ts";
import { runCloudJob, type CloudQueue } from "../../workers/career-cloud/worker.ts";
import { factsFromPayload } from "../../workers/career-browser/approve-first.ts";
import { hashApplyPayload, supabaseApplyStore } from "../../supabase/functions/_shared/career_apply_store.ts";
import { planConfirmations, supabaseConfirmStore } from "../../supabase/functions/_shared/career_apply_confirm.ts";
import { closeoutLine, stageOf } from "../../supabase/functions/_shared/application_review.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { textOf } from "../../supabase/functions/_shared/file_kinds.ts";
import { statusLine } from "../../supabase/functions/_shared/career_apply_status.ts";
import { receiptText } from "../../supabase/functions/_shared/career_apply_receipts.ts";

const CI = Deno.env.get("CI") === "true";
function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const U = "dddddddd-0000-4000-8000-00000000a0c1";
const URL_ = "https://boards.greenhouse.io/wogacme/jobs/4242", JOB = "greenhouse:wogacme:4242", CO = "TEST Acme Analytics", ROLE = "TEST Operations Analyst";
const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

Deno.test({ name: "WO-G 13: approve -> send -> uncertain -> no blind retry -> the employer's email reconciles -> confirmed, each state said as it is", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (CI) throw Error("needs Postgres 16"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg = await startPg();
  const ats = await new StubAts([{ board: "wogacme", job: "4242", title: ROLE, company: CO }]).start();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as never, init);
    return ATS_HOST.test(new URL(req.url).hostname) ? await ats.forward(req, realFetch) : new Response("not reachable here", { status: 404 });
  }) as typeof fetch;
  try {
    const RESUME = "%PDF-1.4\n% TEST resume for the WO-G reconcile test\n%%EOF\n";
    const resume = new TextEncoder().encode(RESUME), sha = hex(await crypto.subtle.digest("SHA-256", resume));
    await pg.sql(`insert into auth.users(id,email) values ('${U}','wog@example.test'); insert into profiles(id) values ('${U}');
      insert into career_watch_kv(user_id,key,value) values ('${U}','career:account','{"epoch":1,"version":1,"paused":false}');
      insert into storage.objects(bucket_id,name) values ('career-resumes', '${U}/${sha}.pdf');
      ${confirmedResumeSql(U, RESUME)}
      insert into career_postings(job_id,provider,board,ats_id,company,title,url,first_seen_at,last_seen_at) values ('${JOB}','greenhouse','wogacme','4242','${CO}','${ROLE}','${URL_}',now(),now());`);
    // The approved payload: the person's own answers to the stub employer's form, their resume by hash, bound to this posting.
    const base = { version: 1, user_id: U, job_id: JOB, company: CO, title: ROLE, url: URL_, destination: URL_, resume_sha256: sha, page_field_names: [],
      fields: [{ name: "first_name", label: "First Name", value: "Ada", factId: "F-1" }, { name: "last_name", label: "Last Name", value: "Lovelace", factId: "F-2" },
        { name: "email", label: "Email", value: "ada@example.test", factId: "F-3" }, { name: "question_9001", label: "Are you legally authorized to work in the United States?", value: "1", factId: "F-4" }],
      privacy_epoch: 1, account_version: 1, expires_at: new Date(Date.now() + 86_400_000).toISOString() };
    const payload = { ...base, engine_approval: await hashApplyPayload(factsFromPayload(base).saved) };
    const hash = await hashApplyPayload(payload);
    const lit = (x: unknown) => `'${JSON.stringify(x).replace(/'/g, "''")}'::jsonb`;
    eq((await pg.sql(`select career_apply_payload_hash(${lit(payload)})`)).trim(), hash, "the database and the worker hash the approval the same way");
    await pg.sql(`select (career_apply_enqueue(${lit(payload)}, '${hash}', '${hash}')).id`);
    const row = async () => JSON.parse((await pg.sql(`select row_to_json(x)::text from (select id,state,reason,confirmation_id,email_confirmed_at,confirmation_mail_hash,created_at,updated_at,claimed_at,company,url,payload,payload->>'title' as title, evidence->>'finished_at' as sent_at from career_apply_jobs where user_id='${U}') x`)).trim());
    const files = memoryFileStore(), svc = createFileService({ store: files, env: { get: (k) => ENV[k] }, now: () => Date.now(), records: { application: async () => await row() } });
    const fileStatus = async () => {
      const r = await svc.create(U, "application_proof", { application_id: JOB });
      if (!r.ok) return `no file: ${r.error}`;
      return textOf(files.all().find((f) => f.id === (r as { id: string }).id)!, { now: Date.now() }).split("\n").find((l) => l.startsWith("Status: "))!;
    };

    // approve
    let r = await row();
    eq([r.state, stageOf(r)], ["queued", "approved"], "approved");
    assert((await fileStatus()).startsWith("Status: Approved, not sent yet."), "the File says approved, not sent");
    eq(ats.posts.length, 0, "nothing reached the employer before the send");

    // send: claimed by the queue's own fair claim, as the worker does
    const admin = pg.asService(), store = supabaseApplyStore(admin);
    const rpc = async (name: string, args: Record<string, unknown>) => { const x = await admin.rpc(name, args); if (x.error) throw Object.assign(Error(x.error.message), { body: x.error.message }); return x.data; };
    const claim = async () => { const t = new Date().toISOString(); await rpc("career_apply_sweep", { p_now: t }); return (await rpc("career_apply_claim_fair", { p_now: t, p_limit: 5, p_per_person: 1 })) ?? []; };
    const jobs = await claim();
    eq(jobs.length, 1, "one approved application to claim");
    r = await row();
    eq([r.state, stageOf(r)], ["driving", "sending"], "sending");
    const sending = await fileStatus();
    assert(sending.startsWith("Status: Approved, sending not confirmed."), `the File says sending, not prepared: ${sending}`);
    const queue: CloudQueue = {
      claim: async () => [], gatePresent: async () => true, ask: async () => 0,
      authorize: async (j) => { if ((await row()).state !== "driving" || j.payload_hash !== hash) throw Error("invalid apply claim"); },
      resume: async () => ({ b64: btoa(String.fromCharCode(...resume)), sha256: sha, filename: "TEST_Resume_v3.pdf" }),
      finish: (j, state, evidence) => store.finish(j as never, state as never, evidence),
    };
    // The employer takes the post; its answer never comes back (the final click timed out after Submit was authorized).
    const timedOut = (job: any) => async (args: string[], env?: Record<string, string>, controls?: { beforeEffect?: () => Promise<void> }) => {
      await stubEngine(job, hashApplyPayload, factsFromPayload)(args, env, controls);
      return { result: { state: "not_submitted", reason: "DRIVER_ERROR" }, evidence: null };
    };
    const done = await runCloudJob(jobs[0], { queue, runEngine: timedOut(jobs[0]) as never, log: () => {} });
    eq(done.state, "unknown_outcome", "a run that reached Submit and then lost its answer is uncertain, never not-sent");
    eq(ats.posts.length, 1, "the employer holds exactly one application");
    eq(ats.posts[0].files[0].sha256, sha, "the approved resume bytes went, checked by hash");
    eq(ats.posts[0].fields.first_name, "Ada", "the approved answers went");

    // uncertain: said as uncertain everywhere, with no confirmation id
    r = await row();
    eq([r.state, stageOf(r), r.confirmation_id], ["unknown_outcome", "uncertain", null], "uncertain");
    const uncFile = await fileStatus();
    assert(uncFile.startsWith("Status: Submission may have landed."), `the proof File shows the uncertain state (architect ruling, fix 13): ${uncFile}`);
    const unc = closeoutLine(r, "America/Chicago");
    assert(/may have landed/.test(unc) && /won't send it again/.test(unc) && !/^Submitted|Confirmation:/.test(unc), unc);
    assert(!/\bsubmitted\b(?! only once)/i.test(statusLine(r).replace(/not submitted/i, "")) && /will not be sent again/.test(statusLine(r)), statusLine(r));
    assert(/will not send it again/.test(receiptText(r)), receiptText(r));

    // no blind retry: not handed out again, not queued twice, a second pass posts nothing
    eq(await claim(), [], "the queue never hands an uncertain application out again");
    const again = await admin.rpc("career_apply_enqueue", { p_payload: payload, p_payload_hash: hash, p_approval_hash: hash });
    const refused = !!again.error || String(JSON.stringify(again.data)).includes("duplicate") || (await pg.sql(`select count(*) from career_apply_jobs where user_id='${U}'`)).trim() === "1";
    assert(refused, `the same approval is not queued a second time: ${JSON.stringify(again)}`);
    for (const j of await claim()) await runCloudJob(j, { queue, runEngine: stubEngine(j, hashApplyPayload, factsFromPayload) as never, log: () => {} });
    eq(ats.posts.length, 1, "still exactly one application at the employer");

    // reconcile: the employer's own email, matched to this application by the product's matcher
    const from = "TEST Acme Analytics <no-reply@us.greenhouse-mail.io>", d = "us.greenhouse-mail.io";
    const mail = { hash: "f".repeat(64), date: new Date(Date.now() + 60_000).toISOString(), from, subject: `Thank you for applying to ${CO}`,
      snippet: `We have received your application for the ${ROLE} role and will review it shortly.`,
      auth: [`mx.google.com; dkim=pass header.i=@${d} header.s=s1 header.b=AbC; spf=pass smtp.mailfrom=bounce@${d}; dmarc=pass (p=REJECT) header.from=${d}`] };
    const plan = planConfirmations([mail as never], [{ id: r.id, company: r.company, title: ROLE, url: r.url, state: r.state, submitted_at: r.claimed_at ?? r.created_at, confirmation_hash: null }]);
    eq(plan.map((p) => p.kind), ["confirm"], "the employer's email fits exactly this application");
    await supabaseConfirmStore(admin).confirm(U, plan[0] as never);
    r = await row();
    eq([r.state, stageOf(r), !!r.email_confirmed_at, r.confirmation_id], ["confirmed", "employer_confirmed", true, null], "confirmed by the employer's email; no id was made up");
    assert((await fileStatus()).startsWith("Status: Employer confirmation verified."), "the File says confirmed, from the employer's email");
    const close = closeoutLine(r, "America/Chicago");
    assert(new RegExp(`^Submitted ${ROLE} at ${CO} at [A-Z][a-z]{2} \\d{1,2}, \\d{1,2}:\\d{2} [AP]M C[SD]T\\. Confirmation: ${CO}'s confirmation email \\(`).test(close), close);
    console.log(`closeout: ${close}`);
  } finally {
    globalThis.fetch = realFetch;
    await ats.stop();
    await pg.stop();
  }
} });
