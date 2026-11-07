// END-TO-END TASK COMPLETION (release 9, workstream D): does Trainee finish the job in the world, not just in its own rows?
// The task eval (evals/career/tasks/) stops at queue rows and stored artifacts. This one keeps going: each task runs, for one
// fresh synthetic person, through the REAL agent-chat handler (handler-career.ts handleChat, unchanged) on a throwaway
// Postgres (tests/flow/pg.ts), and after every turn the product's own background workers run in-process, as the scheduler
// runs them, against stub worlds (worlds.ts):
//   the sending rail   runSendWorker (career_send_rail.ts, as career-send calls it) -> the rail's fake Gmail
//   the cloud apply    restQueue + runCloudJob (workers/career-cloud/worker.ts, the product's own door: the database's
//                      claim, authorize, resume and finish) -> the stub ATS. The engine step is the one stand-in: the eval runs
//                      without a browser, so the eval's engine (worlds.ts stubEngine) does what scripts/apply.ts does at Submit and nothing
//                      more: it refuses a changed application (the approved hash over factsFromPayload), asks the queue to
//                      authorize the one effect, and makes a real multipart form post of exactly the approved fields and the
//                      approved resume bytes, then reports the employer's confirmation.
//   the file fetch     a File page through the product's renderer (file_kinds.ts bodyHtml); a research report and a
//                      tailored PDF read back from the document store (channel_artifacts) byte for byte, then opened.
// The judge (judge.ts) reads only what the worlds received. A task passes only on the real outcome.
//
//   deno run -A evals/career/e2e/run.ts --label <label>                      (fake model: free, deterministic)
//   deno run -A evals/career/e2e/run.ts --label <label> --model claude --budget-usd 3   (paid: ANTHROPIC_API_KEY, capped)
//   options: --brain production|router|staged|planner (default production: the release config's brain, D-035, with
//            the release flags as committed, D-036), --only E01,E11, --out <file>, --no-log (do not append to SCORE-LOG.md)
// The import map (tests/flow/supabase-npm.json: supabase-js from npm, where esm.sh is unreachable) is applied by the
// runner itself: run.ts re-executes itself under it when started without one.
// Model: fake (evals/career/tasks/fake_model.ts plays each task's oracle: what the code paths complete when the model plans
// right; it is a fixture, never a score of a model) or claude (Anthropic only; spend read from agent_turn_costs, stopped
// before the next task at --budget-usd; a stopped run is not a score). Nothing here may reach OpenAI: every OPENAI_* variable
// is cleared for the run.
// Output: results/<label>.json, a printed completion %, a per-area breakdown and a failure list, and one row appended to
// the E2E section of evals/career/SCORE-LOG.md (read by deploy-standard.ts S6).
// deno-lint-ignore-file no-explicit-any
import { pgBinDir, type Pg, startPg } from "../../../tests/flow/pg.ts";
import { careerHandler, type Chat, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../../../tests/flow/handler.ts";
import { evalNow, PIN_DB_SQL, pinClock } from "../tasks/clock.ts";
import { clearOracle, fakeAnthropic, type OracleStep, setOracle } from "../tasks/fake_model.ts";
import { AREAS, type Area, type E2EState, type Expect, judgeE2E, type ResearchFile, type ResumeDoc } from "./judge.ts";
import { FakeGmail, htmlText, readPdf, sha256Hex, stubEngine, StubAts } from "./worlds.ts";
import { isStubWebHost, stubWebFetch } from "./web.ts";
import type { FileRecord } from "../../../supabase/functions/_shared/file_kinds.ts";
import { appendRow, type E2EItem, type E2ERun, scoreRow } from "./score_log.ts";
export type { E2EItem, E2ERun };

export interface E2ETask { id: string; area: Area; kind: "task" | "multi" | "guard"; setup: string[]; turns: string[]; oracle: Record<string, OracleStep[]>; expect: Expect; note?: string }

const HERE = new URL("./", import.meta.url), ROOT = new URL("../../../", import.meta.url).pathname;
const SET = JSON.parse(await Deno.readTextFile(new URL("tasks.json", HERE)));
const BASE = JSON.parse(await Deno.readTextFile(new URL("../tasks/tasks.json", HERE)));
const POSTINGS: any[] = [...BASE.postings, ...SET.extra_postings];
export const TASKS: E2ETask[] = SET.tasks;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
// The name on the confirmed resume (its first line naming the person; the fixture marks it "(TEST)").
const RESUME_NAME = (/^([A-Z][a-z]+ [A-Z][a-z]+) \(TEST\)$/m.exec(RESUME)?.[1]) ?? null;
const CONTACTS = await Deno.readTextFile(new URL("../tasks/contacts.csv", HERE));
const CONTACT_EMAILS = [...CONTACTS.matchAll(/[^\s,]+@[^\s,]+/g)].map((m) => m[0].toLowerCase());
// The stub worlds' own link hosts and keys: made up, for links minted inside this process only (no real host serves them).
const WORLD_ENV: Record<string, string> = {
  TRAINEE_FILE_BASE_URL: "https://file.e2e.test", TRAINEE_FILE_LINK_SECRET: "e2e-stub-world-file-link-key-not-real",
  TRAINEE_REPORT_BASE: "https://report.e2e.test", TRAINEE_REPORT_SECRET: "e2e-stub-world-report-key-not-real",
  // R9-F: market research and its brief File, for this eval's run only (the release config keeps both off: RELEASE_NEVER_ON).
  // With no search key the research tool reads the sites it is given (research_search.ts firstPartyProvider): the stub web.
  CAREER_RESEARCH_REPLY: "on", CAREER_RESEARCH_BRIEF: "on",
};
// Unset for the run, so research never reaches a real search provider or SEC with a declared contact.
const RESEARCH_UNSET = ["BRAVE_SEARCH_API_KEY", "RESEARCH_SEARCH_PROVIDER", "RESEARCH_SEARCH_ENDPOINT", "RESEARCH_USER_AGENT"];
const ENV_KEYS = ["CAREER_BRAIN", "CAREER_PLANNER", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_REPLY_MODEL", ...RESEARCH_UNSET, ...Object.keys(WORLD_ENV)];
const q = (s: string) => s.replace(/'/g, "''");
// The machine's own clock, taken before the pin: the sending rail's database functions stamp next_at with the database's
// real clock (clock_timestamp; the pin moves only column defaults), so the rail's worker is handed the same clock.
const machineNow = Date.now.bind(Date);
const uid = (i: number) => `7e2e0000-6a43-4a49-9d2c-${String(9_000_000_000_000 + i).slice(-12)}`;
const json = async (pg: Pg, sql: string): Promise<any> => JSON.parse((await pg.sql(`select coalesce((${sql})::text, 'null')`)).trim() || "null");

async function seed(pg: Pg, ids: string[], at: string) {
  const T = `'${at}'::timestamptz`;
  await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
    ${POSTINGS.map((p) => `('${p.job_id}', 'greenhouse', '${p.job_id.split(":")[1]}', '${q(p.company)}', '${q(p.title)}', '${q(p.location)}', '${p.url}', '${q(p.description)}', ${T}, ${T})`).join(",\n")};
    insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
    ${POSTINGS.map((p, i) => `('${p.job_id}', 'greenhouse', '${p.job_id.split(":")[1]}', '${q(p.company)}', '${q(p.title)}', '${q(p.location)}', '${p.url}', ${T} - interval '${i} hours', '${q(p.description)}', 'e${i}')`).join(",\n")};`);
  for (const id of ids) {
    await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
      insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
      insert into public.channel_contacts (contact, user_id) values ('+1556' || lpad((abs(hashtext('${id}')) % 10000000)::text, 7, '0'), '${id}');`);
  }
}

function brainEnv(brain: string) {
  for (const k of ["CAREER_BRAIN", "CAREER_PLANNER"]) Deno.env.delete(k);
  if (brain === "setup" || brain === "router") { Deno.env.set("CAREER_BRAIN", "router"); Deno.env.set("CAREER_PLANNER", "off"); }
  if (brain === "staged") { Deno.env.set("CAREER_BRAIN", "staged"); Deno.env.set("CAREER_PLANNER", "off"); }
  if (brain === "planner") { Deno.env.set("CAREER_BRAIN", "staged"); Deno.env.set("CAREER_PLANNER", "on"); }
  // production: nothing set, so the handler serves the committed release config (PRODUCTION_BRAIN, RELEASE_FLAGS).
}

export async function runE2E(o: { label: string; brain: string; model: "fake" | "claude"; only?: string[]; budgetUsd?: number | null; quiet?: boolean }): Promise<E2ERun> {
  const tasks = TASKS.filter((t) => !o.only?.length || o.only.includes(t.id));
  const openaiVars = Object.keys(Deno.env.toObject()).filter((k) => /^OPENAI_/.test(k));
  const saved: Record<string, string | undefined> = Object.fromEntries([...ENV_KEYS, ...openaiVars].map((k) => [k, Deno.env.get(k)]));
  const realFetch = globalThis.fetch;
  const ats = await new StubAts(POSTINGS.map((p) => ({ board: p.job_id.split(":")[1], job: p.job_id.split(":")[2], title: p.title, company: p.company }))).start();
  const gmail = new FakeGmail();
  const pg = await startPg();
  let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const items: E2EItem[] = [];
  let stopped: string | null = null, unpin: (() => void) | null = null;
  const runAt = new Date().toISOString(), at = evalNow();
  try {
    unpin = pinClock(at);
    await supabaseParity(pg);
    await pg.sql(PIN_DB_SQL(at));
    const people: Record<string, string> = {};
    tasks.forEach((t) => { people[`tok-${t.id}`] = uid(TASKS.indexOf(t) + 1); });
    await seed(pg, Object.values(people), at);
    for (const k of openaiVars) Deno.env.delete(k);
    if (o.model === "fake") Deno.env.set("ANTHROPIC_API_KEY", "sk-ant-fake-e2e-not-a-key");
    else if (!Deno.env.get("ANTHROPIC_API_KEY")) throw new Error("NOT RUN: --model claude needs ANTHROPIC_API_KEY");
    for (const [k, v] of Object.entries(WORLD_ENV)) Deno.env.set(k, v);
    Deno.env.delete("MODEL_PROVIDER");
    for (const k of RESEARCH_UNSET) Deno.env.delete(k);
    Deno.env.delete("CAREER_MODEL");
    Deno.env.set("CAREER_REPLY_MODEL", Deno.env.get("CAREER_REPLY_MODEL") || "claude-haiku-5-5");
    // The outside world: the model (the fake, or Anthropic on a paid run), every *.greenhouse.io host (the stub ATS, over a
    // real HTTP hop), Gmail (the rail's fake), and the stub web's own .e2e.test sites (web.ts). Nothing else is reachable.
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      const url = new URL(req.url);
      if (url.hostname === "api.anthropic.com") return o.model === "fake" ? await fakeAnthropic(req) : await realFetch(req);
      if (/(^|\.)greenhouse\.io$/.test(url.hostname)) return await ats.forward(req, realFetch);
      if (url.hostname === "gmail.googleapis.com") return await gmail.fetch(req);
      if (isStubWebHost(url.hostname)) return stubWebFetch(req);
      return new Response("not reachable in the e2e eval", { status: 404 });
    }) as typeof fetch;
    h = await careerHandler(pg, people);
    // The product's own modules, loaded after the handler pointed fetch at the database double.
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { runSendWorker, mailHash } = await import("../../../supabase/functions/_shared/career_send_rail.ts");
    const { supabaseOutreachStore } = await import("../../../supabase/functions/_shared/career_outreach.ts");
    const { restQueue, runCloudJob } = await import("../../../workers/career-cloud/worker.ts");
    const { factsFromPayload } = await import("../../../workers/career-browser/approve-first.ts");
    const { hashApplyPayload } = await import("../../../supabase/functions/_shared/career_apply_store.ts");
    const outreach = supabaseOutreachStore(admin);
    const queue = restQueue({ url: SUPABASE_URL, key: SERVICE_KEY });
    const workerLog: string[] = [], sendLog: string[] = [];
    // One scheduler tick: the sending rail (as career-send runs it) and the cloud apply worker (as cloudLoop runs one job).
    const tick = async () => {
      await runSendWorker({ rpc: (n: string, a: any) => admin.rpc(n, a), fetch: gmail.fetch as typeof fetch, now: machineNow,
        token: (u: string, scope: string) => Promise.resolve(`tok-${scope.endsWith("gmail.send") ? "send" : "read"}-${u}`), drafts: (u: string, ids: string[]) => outreach.drafts!(u, ids) },
        { worker: "e2e-eval", accounts: 20, perAccount: 25, leaseSeconds: 120, deadlineMs: 20_000 })
        .then((st: any) => { if (st.claims || st.error || st.errors) sendLog.push(`outreach: send worker claimed ${st.claims}, sent ${st.sent}, retry ${st.retry}, refused ${st.refused}, failed ${st.failed}${st.error ? `, error ${String(st.error).slice(0, 160)}` : ""}`); })
        .catch((e: any) => sendLog.push(`outreach: send worker threw ${String(e?.message ?? e).slice(0, 160)}`));
      let jobs: any[] = [];
      try { jobs = await queue.claim(25); } catch (e: any) { workerLog.push(`apply claim: ${String(e?.message ?? e).slice(0, 200)}`); }
      for (const job of jobs) await runCloudJob(job, { queue, runEngine: stubEngine(job, hashApplyPayload, factsFromPayload) as any, log: (l: string) => workerLog.push(l) });
    };
    const spent = async () => Number(await json(pg, "select coalesce(sum(usd_micros), 0) from public.agent_turn_costs")) / 1e6;
    for (const t of tasks) {
      if (o.budgetUsd != null && await spent() + 0.05 >= o.budgetUsd) { stopped = `budget: $${(await spent()).toFixed(3)} of $${o.budgetUsd}`; break; }
      const chat: Chat = h.chat(`tok-${t.id}`), u = people[`tok-${t.id}`];
      const sentBefore = gmail.sent.length, postsBefore = ats.posts.length;
      workerLog.length = 0; sendLog.length = 0;
      const say = async (m: string, extra: Record<string, unknown> = {}) => { const r = await chat.say(m, extra); if (r.status !== 200) throw new Error(`${t.id}: HTTP ${r.status}: ${r.reply.slice(0, 200)}`); return r; };
      brainEnv("setup");
      clearOracle();
      if (t.setup.includes("resume")) { await say(`here is my resume:\n${RESUME}`); await say("yes, that's my resume"); }
      if (t.setup.includes("contacts")) await say("here are my contacts", { attachments: [{ name: "contacts.csv", mime: "text/csv", text: CONTACTS }] });
      if (t.setup.includes("signature")) await pg.sql(`insert into public.career_outreach_prefs (user_id, signature) values ('${u}', 'Alex Testcase') on conflict (user_id) do update set signature = excluded.signature`);
      // The person connected their own Gmail for sending (the grant row; the fake Gmail stands for the account).
      if (t.setup.includes("gmail")) await pg.sql(`insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${u}', 'google_career', 'oauth_google_career_${u}', 'alex.testcase@example.test', 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send') on conflict do nothing`);
      // The person turned on cloud applying in their own words (the opt-in's terms, then their yes).
      if (t.setup.includes("cloud")) { await say("turn on cloud"); await say("yes, turn it on"); }
      const metasBefore = Number(await json(pg, `select count(*) from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${u}' and m.role = 'assistant'`));
      brainEnv(o.brain);
      setOracle(t.oracle);
      const replies: string[] = [], intents: (string | null)[] = [], bodies: any[] = [];
      for (const m of t.turns) { const r = await say(m); replies.push(r.reply); intents.push(r.intent); bodies.push(r.body); await tick(); }
      const state = await worldState(pg, u, { ats: ats.posts.slice(postsBefore), mail: gmail.sent.slice(sentBefore), replies, bodies, metasBefore, mailHash, hashApplyPayload });
      state.stage.push(`${t.area}: turns handled as ${intents.map((x) => x ?? "none").join(" > ")}`, ...new Set(sendLog));
      state.stage.push(...workerLog.filter((l) => !/: (confirmed|submitted_unconfirmed) /.test(l)).map((l) => `apply: worker ${l.slice(0, 160)}`));
      const j = judgeE2E(t.expect, state);
      items.push({ id: t.id, area: t.area, kind: t.kind, pass: j.pass, failed: j.failed, stage: state.stage, replies, intents });
      if (!o.quiet) console.log(`${t.id} ${j.pass ? "PASS" : "FAIL"} ${t.area}/${t.kind}${j.pass ? "" : `: ${j.failed.join("; ")}`}`);
    }
    const scored = items.filter((x) => x.kind !== "guard"), guards = items.filter((x) => x.kind === "guard");
    const areas = Object.fromEntries(AREAS.map((a) => [a, { total: scored.filter((x) => x.area === a).length, passed: scored.filter((x) => x.area === a && x.pass).length }])) as E2ERun["areas"];
    const passed = scored.filter((x) => x.pass).length;
    return { label: o.label, brain: o.brain, model: o.model, commit: await headCommit(), total: scored.length, passed, rate: scored.length ? passed / scored.length : 0, areas,
      guards: { total: guards.length, held: guards.filter((x) => x.pass).length }, stopped, cost_usd: o.model === "fake" ? 0 : await spent(), items, run_at: runAt };
  } finally {
    unpin?.();
    clearOracle();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    h?.restore();
    globalThis.fetch = realFetch;
    await ats.stop();
    await pg.stop();
  }
}

// What the worlds received for one person, and the rows that say where each pipeline stopped.
async function worldState(pg: Pg, u: string, w: { ats: any[]; mail: any[]; replies: string[]; bodies: any[]; metasBefore: number; mailHash: (m: any) => Promise<string>; hashApplyPayload: (x: unknown) => Promise<string> }): Promise<E2EState> {
  const stage: string[] = [];
  const wanted: any[] = (await json(pg, `select json_agg(json_build_object('company', company, 'title', title)) from public.career_apply_wanted where user_id = '${u}'`)) ?? [];
  const jobsRaw: any[] = (await json(pg, `select json_agg(to_jsonb(j)) from public.career_apply_jobs j where user_id = '${u}'`)) ?? [];
  const jobs = await Promise.all(jobsRaw.map(async (j) => ({ id: j.id, job_id: j.job_id, company: j.company, url: j.url, payload: j.payload, payload_hash: j.payload_hash, approval_hash: j.approval_hash, state: j.state, confirmation_id: j.confirmation_id, evidence: j.evidence, payload_hash_now: await w.hashApplyPayload(j.payload) })));
  const cards = Number(await json(pg, `select count(*) from public.career_watch_kv where user_id = '${u}' and key like 'career:apply-card%'`));
  if (wanted.length || jobs.length) stage.push(`apply: ${wanted.length} on the apply list, ${cards} card(s) shown, ${jobs.length} approved${jobs.length ? ` (${jobs.map((j) => j.state).join(", ")})` : ""}, ${w.ats.length} reached the employer`);
  // The confirmed facts: the resume the person confirmed (its text) and every value on their profile's facts.
  const flows: any[] = (await json(pg, `select json_agg(state) from public.agent_flow_state where user_id = '${u}'`)) ?? [];
  const facts = flows.flatMap((f) => (f?.career?.profile?.facts ?? f?.profile?.facts ?? []) as any[]).map((x) => String(x?.value ?? x?.text ?? "")).filter(Boolean);
  // The resume the person confirmed: the product's record of it (career_resume_record, state confirmed), never the payload's own claim.
  const resumeSha: string | null = (await json(pg, `select to_json(sha256) from public.career_resume_record where user_id = '${u}' and state = 'confirmed'`)) ?? null;
  const hasResume = resumeSha !== null || flows.some((f) => JSON.stringify(f ?? {}).includes("Alex Testcase"));
  const drafts: any[] = (await json(pg, `select json_agg(json_build_object('id', id, 'recipient_email', recipient_email, 'subject', subject, 'body', body, 'footer', footer, 'hash', hash, 'approved_hash', approved_hash, 'status', status)) from public.career_outreach_drafts where user_id = '${u}'`)) ?? [];
  const sendQueue: any[] = (await json(pg, `select json_agg(json_build_object('recipient_email', recipient_email, 'state', state, 'next_at', next_at)) from public.career_send_queue where user_id = '${u}'`)) ?? [];
  const hashOf: Record<string, string> = {};
  for (const m of w.mail) { const d = drafts.find((x) => x.recipient_email.toLowerCase() === String(m.to).toLowerCase()); if (d) hashOf[d.id] = await w.mailHash({ to: String(m.to).toLowerCase(), subject: m.subject, text: m.text }); }
  if (drafts.length || sendQueue.length) stage.push(`outreach: ${drafts.length} drafted (${drafts.map((d) => `${d.recipient_email} ${d.status}`).join(", ")}), ${sendQueue.length} on the sending rail${sendQueue.length ? ` (${sendQueue.map((s) => `${s.state}${s.state === "queued" && s.next_at ? ` until ${String(s.next_at).slice(0, 16)}` : ""}`).join(", ")})` : ""}, ${w.mail.length} delivered`);
  // Research: File pages (tf:file:<id>) and research reports (channel_artifacts HTML), each delivered only if a reply carried its link.
  // What reached the person: each reply, and each link the channel sends after it (the reply's shape.links: a File link that
  // code minted, channel_inbound.ts sends it as its own message).
  const text = [...w.replies, ...w.bodies.flatMap((b: any) => Array.isArray(b?.shape?.links) ? b.shape.links.map(String) : [])].join("\n");
  const fileRecs: FileRecord[] = (await json(pg, `select json_agg(value) from public.career_watch_kv where user_id = '${u}' and key like 'tf:file:%'`)) ?? [];
  const { fileHtml } = await import("./worlds.ts");
  // A File link is https://file.e2e.test?t=v1.<claims>.<sig> (file_link.ts): its claims name the File it opens (r).
  const linkedFiles = new Set([...text.matchAll(/https:\/\/file\.e2e\.test\/?\?t=v1\.([A-Za-z0-9_-]+)\./g)].map((m) => {
    try { return String(JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(m[1].length / 4) * 4, "="))).r ?? ""); } catch { return ""; }
  }).filter(Boolean));
  const files: ResearchFile[] = [];
  for (const rec of fileRecs.filter((r: any) => ["research_brief", "comparison"].includes(r?.kind))) {
    const d: any = rec.data ?? {}, html = fileHtml(rec);
    // The market brief (research_brief variant "market"): the summary facts and the comparison cells carry a source label; the
    // conditions and risks are Trainee's reading, each citing its numbered sources.
    const market = rec.kind === "research_brief" && d.variant === "market";
    const findings = market ? [...(d.summary ?? []).map((f: any) => ({ text: String(f?.text ?? ""), source: typeof f?.source === "string" && f.source ? f.source : null })),
        ...(d.comparison?.rows ?? []).flatMap((r: any) => (r.cells ?? []).filter(Boolean).map((c: any) => ({ text: String(c?.value ?? ""), source: typeof c?.source === "string" && c.source ? c.source : null }))),
        ...[...(d.conditions ?? []), ...(d.risks ?? [])].map((f: any) => ({ text: String(f?.text ?? ""), source: Array.isArray(f?.cite) && f.cite.length ? `[${f.cite.join("][")}]` : null }))]
      : rec.kind === "research_brief" ? (d.findings ?? []).map((f: any) => ({ text: `${f.label ?? ""} ${f.value ?? f.text ?? ""}`.trim(), source: typeof f.source === "string" && f.source ? f.source : null }))
      : (d.rows ?? []).flatMap((r: any) => (r.cells ?? []).map((c: any) => ({ text: String(c?.value ?? ""), source: c?.source ?? null })));
    files.push({ id: rec.id, kind: rec.kind, html, text: htmlText(html), delivered: text.includes(rec.id) || linkedFiles.has(rec.id) || /https:\/\/file\.e2e\.test[/?]/.test(text) && fileRecs.length === 1, findings, sources: (d.sources ?? []).map((s: any) => String(s?.url ?? "")) });
  }
  const arts: any[] = (await json(pg, `select json_agg(json_build_object('id', id, 'filename', filename, 'mime', mime, 'b64', bytes_b64)) from public.channel_artifacts where user_id = '${u}'`)) ?? [];
  for (const a of arts.filter((x) => /html/.test(x.mime) && /report/i.test(x.filename))) {
    const html = new TextDecoder().decode(Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0)));
    const blocks = [...html.matchAll(/<(p|li|tr|td|h\d)[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
    files.push({ id: a.id, kind: "research_report", html, text: htmlText(html), delivered: /https:\/\/report\.e2e\.test\//.test(text),
      findings: blocks.map((b) => ({ text: htmlText(b), source: /<a\s[^>]*href="https:|\[\d+\]|<sup/i.test(b) ? "cited" : null })), sources: [...html.matchAll(/href="(https:[^"]+)"/g)].map((m) => m[1]) });
  }
  if (files.length) stage.push(`research: ${files.length} file(s) stored, ${files.filter((f) => f.delivered).length} delivered`);
  // A document is returned when a reply carried its reference (handler-career.ts: the reply's `artifacts`, each { ref, filename, mime }).
  const docsSent = w.bodies.flatMap((b) => [...(b?.artifacts ?? []), ...(b?.result?.documents ?? [])]);
  const documents: ResumeDoc[] = [];
  for (const a of arts.filter((x) => /pdf/.test(x.mime))) {
    const bytes = Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0)), sha = await sha256Hex(bytes);
    const delivered = docsSent.some((d: any) => d?.ref === a.id || d?.sha256 === sha);
    const dump = Deno.env.get("E2E_DUMP_DIR"); // to look at a returned document by hand
    if (dump) await Deno.writeFile(`${dump}/${u.slice(-6)}-${a.filename}`, bytes);
    documents.push({ filename: a.filename, mime: a.mime, delivered, pdf: await readPdf(bytes) });
  }
  if (arts.some((x) => /pdf/.test(x.mime)) || /tailor/.test(text)) stage.push(`resume: ${documents.length} PDF(s) stored, ${documents.filter((d) => d.delivered).length} returned in a reply`);
  return { wanted, jobs, ats: w.ats, confirmed: { text: hasResume ? [RESUME, ...facts].join("\n") : facts.join("\n"), resume_sha256: resumeSha, name: hasResume ? RESUME_NAME : null }, drafts, sendQueue, mail: w.mail, contacts: CONTACT_EMAILS,
    hashOf, files, documents, stage };
}

async function headCommit(): Promise<string> {
  try { const r = await new Deno.Command("git", { args: ["rev-parse", "HEAD"], cwd: ROOT, stdout: "piped", stderr: "null" }).output(); return new TextDecoder().decode(r.stdout).trim() || "unknown"; } catch { return "unknown"; }
}

const pct = (n: number, d: number) => d ? `${((n / d) * 100).toFixed(1)}%` : "-";
export function report(r: E2ERun): string {
  const L = [`${r.label}: ${r.passed}/${r.total} tasks completed end to end (${pct(r.passed, r.total)}) · brain ${r.brain} · model ${r.model} · cost $${r.cost_usd.toFixed(3)}${r.stopped ? ` · STOPPED (${r.stopped}): not a score` : ""}`];
  for (const a of AREAS) L.push(`  ${a.padEnd(9)} ${r.areas[a].passed}/${r.areas[a].total} (${pct(r.areas[a].passed, r.areas[a].total)})`);
  L.push(`  guards    ${r.guards.held}/${r.guards.total} held (nothing done that the person did not ask for)`);
  const bad = r.items.filter((x) => !x.pass);
  L.push(bad.length ? "failures:" : "failures: none");
  for (const x of bad) L.push(`  ${x.id} ${x.area}/${x.kind}: ${x.failed.join("; ").slice(0, 400)}`);
  return L.join("\n");
}

if (import.meta.main) {
  // supabase-js from npm where esm.sh is unreachable: re-run under the flow harness's import map unless already under one.
  if (!Deno.env.get("E2E_UNDER_MAP")) {
    const p = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", `--import-map=${ROOT}tests/flow/supabase-npm.json`, new URL(import.meta.url).pathname, ...Deno.args], env: { E2E_UNDER_MAP: "1" }, stdout: "inherit", stderr: "inherit" }).output();
    Deno.exit(p.code);
  }
  const args = Deno.args, opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
  const brain = opt("--brain") || "production", model = (opt("--model") || "fake") as "fake" | "claude";
  if (!["production", "router", "staged", "planner"].includes(brain) || !["fake", "claude"].includes(model)) { console.log("NOT RUN: --brain production|router|staged|planner, --model fake|claude"); Deno.exit(2); }
  if (!pgBinDir()) { console.log("NOT RUN: no Postgres 16 binaries (PGBIN or /usr/lib/postgresql/16/bin)"); Deno.exit(2); }
  if (model === "claude" && !Deno.env.get("ANTHROPIC_API_KEY")) { console.log("NOT RUN: --model claude needs ANTHROPIC_API_KEY"); Deno.exit(2); }
  const budgetArg = opt("--budget-usd") ?? Deno.env.get("ANTHROPIC_EVAL_BUDGET_USD") ?? null;
  if (model === "claude" && budgetArg === null) { console.log("NOT RUN: --model claude needs --budget-usd: an uncapped paid run is never started"); Deno.exit(2); }
  const label = opt("--label") || `e2e-${brain}-${model}-${new Date().toISOString().slice(0, 10)}`;
  const r = await runE2E({ label, brain, model, only: opt("--only")?.split(",").filter(Boolean), budgetUsd: budgetArg === null ? null : Number(budgetArg) });
  await Deno.mkdir(new URL("results/", HERE), { recursive: true });
  await Deno.writeTextFile(opt("--out") || new URL(`results/${label}.json`, HERE).pathname, JSON.stringify(r, null, 1));
  console.log(report(r));
  if (!args.includes("--no-log") && !opt("--only")) {
    const path = new URL("../SCORE-LOG.md", HERE).pathname;
    await Deno.writeTextFile(path, appendRow(await Deno.readTextFile(path), scoreRow(r)));
    console.log(`appended to evals/career/SCORE-LOG.md: ${scoreRow(r)}`);
  }
  if (r.stopped) Deno.exit(3);
}
