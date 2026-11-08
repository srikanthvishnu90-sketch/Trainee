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
//            the release flags as committed, D-036), --only E01,E11, --out <file>, --no-log (do not append to SCORE-LOG.md),
//            --replies (keep each task's replies and intents in the result file of a generated set)
//   SETS (release 9, workstream H): --set core40|full|adversarial|heldout (default core40: tasks.json, the 40 tasks and 6
//            guards, run exactly as before). full is the 1,000 generated completion tasks (generate.ts: about 250 per area),
//            adversarial the 150 generated guards (must all hold), heldout the 20% of full the seed holds out. --sample N
//            runs a seeded, area-stratified sample (--seed S), --budget-usd caps a paid run as before. A generated set's
//            world is the product after its cloud gate opened (the gate testers' three confirmations per family: the
//            gate's function answers open, as tests/architect/flow-scenarios-apply-r4.test.ts does); everything else is
//            the 40-task world. Its report adds per-family and per-ATS completion, the top 10 failure clusters, guards by
//            category, the held-out split against the rest, and the estimated cost of the same run on the real model.
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
import { addPostings, clearOracle, fakeAnthropic, type OracleStep, setOracle } from "../tasks/fake_model.ts";
import { AREAS, type Area, type E2EState, type Expect, judgeE2E, linkedFileIds, type ResearchFile, type ResumeDoc } from "./judge.ts";
import { ATS_HOST, atsRef, FakeGmail, htmlText, personAnswers, readPdf, resumePdf, sha256Hex, stubDryRunEngine, stubEngine, StubAts, stubSubmitEngine } from "./worlds.ts";
import { type Contact, contactsCsv, generate, type Person, sampleTasks, SEED } from "./generate.ts";
import { PRICES } from "../../../supabase/functions/_shared/model_gateway.ts";
import { askedPart, questionLine } from "../../../tests/helpers/one_question.ts";
import { addStubPages, isStubWebHost, type StubPage, stubWebFetch } from "./web.ts";
import type { FileRecord } from "../../../supabase/functions/_shared/file_kinds.ts";
import { appendRow, appendSetRow, type CallEstimate, type E2EItem, type E2ERun, parseBudgetUsd, scoreRow, scoreSetRow } from "./score_log.ts";
export type { E2EItem, E2ERun };

export interface E2ETask { id: string; area: Area; kind: "task" | "multi" | "guard"; setup: string[]; turns: string[]; oracle: Record<string, OracleStep[]>; expect: Expect; note?: string;
  // A generated task's own world (generate.ts): its person and resume, contacts, opted-out addresses, stub pages, family tags.
  family?: string; style?: string; ats?: string; heldout?: boolean; person?: Person; contacts?: Contact[]; dnc?: string[]; pages?: Record<string, StubPage>; secret?: string }
export type SetName = "core40" | "full" | "adversarial" | "heldout";
export const SETS: SetName[] = ["core40", "full", "adversarial", "heldout"];

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
// The 40-task set's one person (the fixture resume): every core40 task runs as them, as before.
const CORE_PERSON: Person = { first: "Alex", last: "Testcase", name: RESUME_NAME ?? "Alex Testcase", city: "Chicago, IL", email: "alex.testcase@example.test", phone: "+1 555-0100", resume: RESUME, shape: "student", workAuth: false };
// A set's tasks and the postings its world serves (the generated set is regenerated from its seed on every run).
export function loadSet(set: SetName, o: { sample?: number | null; seed?: number } = {}): { tasks: E2ETask[]; postings: any[]; scaled: boolean } {
  if (set === "core40") return { tasks: TASKS, postings: POSTINGS, scaled: false };
  const g = generate(SEED);
  const pool = (set === "adversarial" ? g.adversarial : set === "heldout" ? g.full.filter((t) => t.heldout) : g.full) as unknown as E2ETask[];
  const tasks = o.sample ? sampleTasks(pool as any[], o.sample, o.seed ?? SEED) as E2ETask[] : pool;
  return { tasks, postings: [...POSTINGS, ...g.postings], scaled: true };
}
// The real-model cost of one model request the fake answered: its prompt at four characters a token, an answer of at most
// 400 tokens, at the product's own prices (an unpriced model at the highest price in the table, as the gateway reserves).
export function estimateCall(body: any): CallEstimate {
  const input = Math.ceil(JSON.stringify({ s: body?.system ?? "", m: body?.messages ?? [], t: body?.tools ?? [] }).length / 4);
  const output = Math.min(Number(body?.max_tokens) || 1024, 400);
  const p = (PRICES as any)[String(body?.model ?? "")] ?? Object.values(PRICES as any).reduce((a: any, b: any) => (b.input > a.input ? b : a));
  const x = p.long_context && input > p.long_context.over_tokens ? p.long_context.multiplier : 1;
  return { calls: 1, input_tokens: input, output_tokens: output, usd: (x * (input * p.input + output * p.output)) / 1e6 };
}
const addEst = (a: CallEstimate, b: CallEstimate): CallEstimate => ({ calls: a.calls + b.calls, input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens, usd: a.usd + b.usd });
const NO_EST: CallEstimate = { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0 };
// The stub worlds' own link hosts and keys: made up, for links minted inside this process only (no real host serves them).
const WORLD_ENV: Record<string, string> = {
  TRAINEE_FILE_BASE_URL: "https://file.e2e.test", TRAINEE_FILE_LINK_SECRET: "e2e-stub-world-file-link-key-not-real",
  TRAINEE_REPORT_BASE: "https://report.e2e.test", TRAINEE_REPORT_SECRET: "e2e-stub-world-report-key-not-real",
  // R9-F: market research and its brief File, for this eval's run only (the release config keeps both off: RELEASE_NEVER_ON).
  // With no search key the research tool reads the sites it is given (research_search.ts firstPartyProvider): the stub web.
  CAREER_RESEARCH_REPLY: "on", CAREER_RESEARCH_BRIEF: "on",
  // R9-F: the hosted preparation's door (cloud_runner_http.ts, in this process at a made-up host), so an application queued
  // from chat is prepared at once and its card shown, as the owner's configured runner does (CAREER_PREPARE_AHEAD_URL).
  CAREER_PREPARE_AHEAD_URL: "https://runner.e2e.test/functions/v1/career-cloud-runner/prepare", CAREER_PREPARE_AHEAD_TOKEN: "e2e-stub-prepare-door-token-not-real-000",
};
// The runner's own settings for the eval's door (its environment, not the chat's): preparation on, sending through the
// runner on (a card-approved application goes by the card-cloud route: the runner's dispatch and its send sandbox; any other
// approved application by the eval's cloud worker, restQueue + runCloudJob), made-up secrets for links minted in this process.
const RUNNER_ENV: Record<string, string> = {
  CLOUD_RUNNER_SECRET: "e2e-stub-runner-secret-not-real-0123456789abcdef", CLOUD_DISPATCH_SECRET: "e2e-stub-dispatch-secret-not-real-0123456789",
  CAREER_PREPARE_AHEAD_TOKEN: WORLD_ENV.CAREER_PREPARE_AHEAD_TOKEN, CLOUD_PREPARE_ENABLED: "on", CLOUD_RUNNER_ENABLED: "on",
  CLOUD_BRIDGE_URL: "https://runner.e2e.test/functions/v1/career-cloud-runner",
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

async function seed(pg: Pg, ids: string[], at: string, postings: any[] = POSTINGS) {
  const T = `'${at}'::timestamptz`;
  await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
    ${postings.map((p) => `('${p.job_id}', '${p.job_id.split(":")[0]}', '${p.job_id.split(":")[1]}', '${q(p.company)}', '${q(p.title)}', '${q(p.location)}', '${p.url}', '${q(p.description)}', ${T}, ${T})`).join(",\n")};
    insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
    ${postings.map((p, i) => `('${p.job_id}', '${p.job_id.split(":")[0]}', '${p.job_id.split(":")[1]}', '${q(p.company)}', '${q(p.title)}', '${q(p.location)}', '${p.url}', ${T} - interval '${i} hours', '${q(p.description)}', 'e${i}')`).join(",\n")};`);
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

export async function runE2E(o: { label: string; brain: string; model: "fake" | "claude"; only?: string[]; budgetUsd?: number | null; quiet?: boolean; set?: SetName; sample?: number | null; seed?: number }): Promise<E2ERun> {
  const set = o.set ?? "core40", loaded = loadSet(set, { sample: o.sample, seed: o.seed });
  const tasks = loaded.tasks.filter((t) => !o.only?.length || o.only.includes(t.id));
  const POSTINGS = loaded.postings;
  if (loaded.scaled) { addPostings(POSTINGS); for (const t of tasks) if (t.pages) addStubPages(t.pages); }
  const openaiVars = Object.keys(Deno.env.toObject()).filter((k) => /^OPENAI_/.test(k));
  const saved: Record<string, string | undefined> = Object.fromEntries([...ENV_KEYS, ...openaiVars].map((k) => [k, Deno.env.get(k)]));
  const realFetch = globalThis.fetch;
  const ats = await new StubAts(POSTINGS.map((p) => ({ board: p.job_id.split(":")[1], job: p.job_id.split(":").slice(2).join(":"), title: p.title, company: p.company, family: atsRef(p.url)?.family ?? "greenhouse", url: p.url }))).start();
  const gmail = new FakeGmail();
  // As production's database: the migrations and the card-cloud bridge go-live applies (apply-rails-and-seed.sh), with its
  // claim guards reconciled as go-live does (the hosted apply flow test's database, R9-F).
  const pg = await startPg({ includeBridge: true });
  let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
  let runner: ((req: Request) => Promise<Response>) | null = null;
  const items: E2EItem[] = [];
  let stopped: string | null = null, unpin: (() => void) | null = null;
  const requested: string[] = [];
  let est: CallEstimate = NO_EST;
  const runAt = new Date().toISOString(), at = evalNow();
  try {
    unpin = pinClock(at);
    await pg.sql((await Deno.readTextFile(`${ROOT}scripts/launch/verify-claim-guards.sql`)).replace(/^\\.*$/gm, ""));
    await supabaseParity(pg);
    await pg.sql(PIN_DB_SQL(at));
    // R9-F: the apply pipeline's database functions (the preparation's claim and its 24-hour expiry, the card, the cloud
    // job's claim and lease) read the database's real clock (clock_timestamp), so its own tables keep their real-clock defaults (now()):
    // pinned, a request made "3 days ago" by its default is expired by the claim before it is ever prepared.
    await pg.sql(`do $u$ declare r record; begin for r in select c.relname as t, a.attname as col from pg_attrdef d
      join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum join pg_class c on c.oid = d.adrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'career\\_apply\\_%' and pg_get_expr(d.adbin, d.adrelid) ~ 'clock_timestamp\\(\\) - '
      loop execute format('alter table public.%I alter column %I set default now()', r.t, r.col); end loop; end $u$;`);
    const people: Record<string, string> = {};
    tasks.forEach((t, i) => { people[`tok-${t.id}`] = uid(set === "core40" ? TASKS.indexOf(t) + 1 : i + 1); });
    await seed(pg, Object.values(people), at, POSTINGS);
    // R9-F: the database switches as go-live writes them (release-db-switches.sql, D-041: real employer submission on), and the portal gate:
    // the cloud sends on Greenhouse only after the owner's gate testers proved 3 confirmed applications there, or under the
    // owner's waiver for one person (career_apply_cloud_gate_waivers: at most 5 sends, at most 7 days; D-010 option (a)).
    // The eval world has no gate testers, so each person carries the owner's waiver: at most 5 cloud sends each.
    await pg.sql(`insert into public.career_cloud_settings (key, value) select k, 'on' from unnest(array['CAREER_AGENT_SUBMIT', 'CAREER_CLOUD_APPLY', 'CAREER_CLOUD_TEXT_CARDS', 'APPLY_VM']) k on conflict (key) do update set value = excluded.value;
      insert into public.career_apply_cloud_gate_waivers (user_id, portal, max_sends, expires_at, note)
      select u, 'greenhouse', 5, clock_timestamp() + interval '6 days', 'e2e eval world: the owner''s waiver for this synthetic person' from unnest(array[${Object.values(people).map((x) => `'${x}'::uuid`).join(",")}]) u;`);
    // A generated set's world: the product after its gate opened (the owner's gate testers' three confirmed applications on
    // each family), so a batch is bounded by the product's own rules (pace, the daily cap, the families it sends on), never
    // by a five-send waiver. Only the gate's answer is the world's; every other check is the product's.
    if (loaded.scaled) await pg.sql(`create or replace function public.career_apply_cloud_open(p_portal text) returns boolean language sql stable as $g$ select p_portal is not null $g$;`);
    // R9-G2 (E05): a batch of 20 hosted Greenhouse sends is possible only once the Greenhouse gate is OPEN (D-010): the
    // waiver above allows at most 5 per person per portal (career_apply_cloud_gate_waivers.max_sends between 1 and 5), and the
    // cloud sends to three families only (greenhouse, lever, ashby), so neither a bigger waiver (that is the production check)
    // nor mixing families (3 x 5 = 15) can make 20. The world therefore stands where the gate's own rule
    // (career_apply_cloud_open) opens it: the owner's gate tester recorded 3 Greenhouse applications by hand and each employer
    // confirmed it by email. Nothing in production changes: the gate, its rule and every cap are as they are.
    // Outside every task's id (uid(i) for task i: the full set has 1,000 tasks, so uid(999) was task 999's person).
    const tester = uid(999_999);
    await pg.sql(`insert into auth.users (id, email) values ('${tester}', 'gate-tester@example.test'); insert into public.profiles (id) values ('${tester}');
      insert into public.career_cloud_settings (key, value) values ('gate_user_ids', '{${tester}}') on conflict (key) do update set value = excluded.value;
      do $g$ declare j public.career_apply_jobs; i int; begin
        perform set_config('request.jwt.claim.sub', '${tester}', true);
        for i in 1..3 loop
          select * into j from public.career_apply_record_own('e2e-gate-' || i, 'Gate Employer ' || i, 'https://boards.greenhouse.io/e2egate' || i || '/jobs/' || i, 'submitted_unconfirmed');
          update public.career_apply_jobs set state = 'confirmed', email_confirmed_at = now(), confirmation_mail_hash = repeat(i::text, 64) where id = j.id;
          insert into public.career_mail_events (user_id, application_ref, kind, company, evidence, message_hash, mail_at)
          values ('${tester}', 'job:' || j.id, 'received', j.company, 'received: "thank you for applying" (e2e gate world)', repeat(i::text, 64), now());
        end loop;
      end $g$;`);
    if (await json(pg, "select public.career_apply_cloud_open('greenhouse')") !== true) throw new Error("e2e world: the Greenhouse gate did not open from its own rule");
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
      requested.push(url.hostname);
      if (url.hostname === "api.anthropic.com") {
        if (o.model === "fake") { try { est = addEst(est, estimateCall(await req.clone().json())); } catch { /* not a JSON body */ } return await fakeAnthropic(req); }
        return await realFetch(req);
      }
      if (ATS_HOST.test(url.hostname)) return await ats.forward(req, realFetch);
      if (url.hostname === "gmail.googleapis.com") return await gmail.fetch(req);
      if (isStubWebHost(url.hostname)) return stubWebFetch(req);
      if (url.hostname === "runner.e2e.test" && runner) return await runner(req);
      return new Response("not reachable in the e2e eval", { status: 404 });
    }) as typeof fetch;
    // The preparation sandbox host: a stand-in for Vercel that runs prepare-runner.ts's runPrepareRequest in this process,
    // with only the four values the dispatcher hands it, the production bridge, and the dry-run stand-in for the engine.
    const { createRunnerHandler } = await import("../../../supabase/functions/_shared/cloud_runner_http.ts");
    const { prepareBridge, runPrepareRequest } = await import("../../../workers/career-cloud/prepare-runner.ts");
    const { bridgeQueue } = await import("../../../workers/career-cloud/sandbox-runner.ts");
    const prepRuns: (() => Promise<unknown>)[] = [], prepWaits: Promise<unknown>[] = [], prepLog: string[] = [];
    let sandboxes = 0;
    const host = {
      create: async () => `sbx_e2e_${++sandboxes}`,
      run: async (sandbox: string, env: Record<string, string>, script?: string) => {
        if ((script ?? "workers/career-cloud/sandbox-runner.ts") === "workers/career-cloud/sandbox-runner.ts") {
          // The send sandbox, as sandbox-runner.ts's runSandboxJob runs it: the job read through the real bridge, the real
          // authorization before the engine and before the one Submit, and the engine stand-in (worlds.ts stubSubmitEngine).
          const bridge = bridgeQueue({ url: env.CLOUD_BRIDGE_URL, id: env.CLOUD_JOB_ID, sandbox, token: env.CLOUD_JOB_TOKEN });
          prepRuns.push(async () => { try { const job = await bridge.job();
            await runCloudJob(job, { queue: bridge.queue, runEngine: stubSubmitEngine(job, factsFromPayload) as any, log: (l: string) => workerLog.push(l) }); }
            catch (e: any) { workerLog.push(`send sandbox threw ${String(e?.message ?? e).slice(0, 160)}`); } });
          return;
        }
        if (script !== "workers/career-cloud/prepare-runner.ts") throw new Error(`the eval's sandbox host runs no ${script}`);
        prepRuns.push(() => runPrepareRequest({ bridge: prepareBridge({ url: env.CLOUD_BRIDGE_URL, id: env.CLOUD_PREPARE_ID, sandbox, token: env.CLOUD_JOB_TOKEN }),
          runEngine: stubDryRunEngine(), log: (l: string) => prepLog.push(l) }).catch((e: any) => prepLog.push(`prepare threw ${String(e?.message ?? e).slice(0, 160)}`)));
      },
      stop: async () => {},
    };
    runner = createRunnerHandler({ env: { get: (k: string) => RUNNER_ENV[k] ?? (k === "SUPABASE_URL" ? SUPABASE_URL : k === "SUPABASE_SERVICE_ROLE_KEY" ? SERVICE_KEY : undefined) }, host: host as any, fetch: ((i: any, n?: any) => globalThis.fetch(i, n)) as typeof fetch, waitUntil: (p) => { prepWaits.push(p); } });
    // A started sandbox runs on its own machine, with that machine's real clock (its card's expiry, its attempts' times),
    // between the person's turns: the pinned clock is lifted while it runs and pinned again where it stood.
    const settlePrepare = async () => {
      for (let i = 0; i < 6 && (prepWaits.length || prepRuns.length); i++) {
        await Promise.all(prepWaits.splice(0));
        const runs = prepRuns.splice(0);
        if (!runs.length) continue;
        const stood = new Date().toISOString();
        unpin?.();
        try { await Promise.all(runs.map((f) => f())); } finally { unpin = pinClock(stood); }
      }
    };
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
      // The preparation: what the door's kick started, then the minute's prepare-dispatch tick (career-cloud-runner's cron),
      // each run to its finish (the card shown in the person's thread, or the questions texted).
      await settlePrepare();
      // The card-cloud route's minute tick (career-cloud-runner /dispatch): claims card-approved applications, one send sandbox each.
      await runner!(new Request(`${RUNNER_ENV.CLOUD_BRIDGE_URL}/dispatch`, { method: "POST", headers: { "x-cloud-dispatch-secret": RUNNER_ENV.CLOUD_DISPATCH_SECRET } }))
        .then(async (r) => { const b = await r.text(); if (!r.ok) prepLog.push(`dispatch ${r.status} ${b.slice(0, 160)}`); });
      await runner!(new Request(`${RUNNER_ENV.CLOUD_BRIDGE_URL}/prepare-dispatch`, { method: "POST", headers: { "x-cloud-dispatch-secret": RUNNER_ENV.CLOUD_DISPATCH_SECRET } }))
        .then(async (r) => { const b = await r.text(); if (!r.ok) prepLog.push(`prepare-dispatch ${r.status} ${b.slice(0, 160)}`); });
      await settlePrepare();
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
      const P = t.person ?? CORE_PERSON, csv = t.contacts ? contactsCsv(t.contacts) : CONTACTS, answers = personAnswers(P);
      const sentBefore = gmail.sent.length, postsBefore = ats.posts.length;
      requested.length = 0; est = NO_EST;
      workerLog.length = 0; sendLog.length = 0; prepLog.length = 0;
      // A turn the product refuses (HTTP not 200) is the product's answer to that turn: on the 40-task set it stops the run as
      // before; on a generated set it is recorded where the task stopped, and the task is judged on what reached the world.
      const refused: string[] = [];
      const say = async (m: string, extra: Record<string, unknown> = {}) => {
        const r = await chat.say(m, extra);
        if (r.status !== 200) { if (!loaded.scaled) throw new Error(`${t.id}: HTTP ${r.status}: ${r.reply.slice(0, 200)}`); refused.push(`${t.area}: the product answered HTTP ${r.status} to a ${m.length}-character turn: ${String(r.reply ?? "").slice(0, 80)}`); }
        return r;
      };
      brainEnv("setup");
      clearOracle();
      if (t.setup.includes("resume")) { await say(`here is my resume:\n${P.resume}`); await say("yes, that's my resume"); }
      if (t.setup.includes("contacts")) await say("here are my contacts", { attachments: [{ name: "contacts.csv", mime: "text/csv", text: csv }] });
      if (t.setup.includes("signature")) await pg.sql(`insert into public.career_outreach_prefs (user_id, signature) values ('${u}', '${q(P.name)}') on conflict (user_id) do update set signature = excluded.signature`);
      // An address that asked this person to stop (the sending rail's opt-out list, as a "stop" reply records it).
      for (const e of t.dnc ?? []) await pg.sql(`insert into public.career_outreach_dnc (user_id, email_hash) values ('${u}', public.career_send_email_hash('${q(e)}')) on conflict do nothing`);
      // The person connected their own Gmail for sending (the grant row; the fake Gmail stands for the account).
      if (t.setup.includes("gmail")) await pg.sql(`insert into public.user_oauth_connections (user_id, provider, vault_name, email, scopes) values ('${u}', 'google_career', 'oauth_google_career_${u}', '${q(P.email)}', 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send') on conflict do nothing`);
      // The person turned on cloud applying in their own words (the opt-in's terms, then their yes).
      if (t.setup.includes("cloud")) { await say("turn on cloud"); await say("yes, turn it on"); }
      // ...and their resume as the file they sent and confirmed (the channel's file upload: career_resume_put, kind file),
      // which the product keeps for the cloud as is; the hosted preparation sends only that file (R9-F).
      if (t.setup.includes("cloud") && t.setup.includes("resume")) {
        const pdf = resumePdf(P.resume); let b = ""; for (const c of pdf) b += String.fromCharCode(c);
        await pg.sql(`select public.career_resume_put('${u}', '${await sha256Hex(pdf)}', 'file', 'e2e:resume-file', '${P.first}_${P.last}_Resume.pdf', decode('${btoa(b)}', 'base64'), 'e2e: the person confirmed their resume file')`);
      }
      const metasBefore = Number(await json(pg, `select count(*) from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${u}' and m.role = 'assistant'`));
      brainEnv(o.brain);
      setOracle(t.oracle);
      const replies: string[] = [], intents: (string | null)[] = [], bodies: any[] = [];
      // R9-F: a question the product texts (one at a time: the form asks something no confirmed fact answers) is answered by
      // the person from their own answers (PERSON_ANSWERS), as the hosted flow test's persona does, before their next turn;
      // a question they have no answer to is left open (the task then fails on its real outcome).
      // The thread's newest message from Trainee: what the person sees last (a reply, or a question the preparation pushed).
      const lastShown = async () => String(await json(pg, `select to_json(m.content) from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${u}' and m.role = 'assistant' order by m.created_at desc, m.id desc limit 1`) ?? "");
      const asks = (x: string) => /(?:One question|Question 1 of \d+) only you can answer/.test(askedPart(x));
      const answerAsked = async (last: string) => {
        for (let round = 0; round < 4; round++) {
          const shown = await lastShown();
          let text = round === 0 && asks(last) ? last : asks(shown) ? shown : "";
          if (!text) return;
          for (let n = 0; text && n < 12; n++) {
            const line = questionLine(text), a = answers.find(([re]) => re.test(line));
            if (!a) { prepLog.push(`the person has no answer to: ${line.slice(0, 100)}`); return; }
            const r = await say(a[1]);
            replies.push(r.reply); intents.push(r.intent); bodies.push(r.body);
            text = asks(r.reply) ? r.reply : "";
          }
          await tick();
        }
      };
      for (const m of t.turns) { const r = await say(m); replies.push(r.reply); intents.push(r.intent); bodies.push(r.body); await tick(); await answerAsked(r.reply); }
      const state = await worldState(pg, u, { ats: ats.posts.slice(postsBefore), mail: gmail.sent.slice(sentBefore), replies, bodies, metasBefore, mailHash, hashApplyPayload,
        resume: P.resume, name: t.person ? P.name : RESUME_NAME, contacts: t.contacts ? t.contacts.map((c) => c.email.toLowerCase()) : CONTACT_EMAILS, readStored: !!t.expect.secret });
      state.requested = [...requested];
      state.stage.push(...refused, `${t.area}: turns handled as ${intents.map((x) => x ?? "none").join(" > ")}`, ...new Set(sendLog));
      state.stage.push(...prepLog.map((l) => `apply: prepare ${l.slice(0, 160)}`));
      state.stage.push(...workerLog.filter((l) => !/: (confirmed|submitted_unconfirmed) /.test(l)).map((l) => `apply: worker ${l.slice(0, 160)}`));
      const j = judgeE2E(t.expect, state);
      items.push({ id: t.id, area: t.area, kind: t.kind, pass: j.pass, failed: j.failed, stage: state.stage, replies, intents,
        ...(loaded.scaled ? { family: t.family, style: t.style, ats: t.ats, heldout: !!t.heldout, est } : {}) });
      if (!o.quiet) console.log(`${t.id} ${j.pass ? "PASS" : "FAIL"} ${t.area}/${t.kind}${j.pass ? "" : `: ${j.failed.join("; ")}`}`);
    }
    const scored = items.filter((x) => x.kind !== "guard"), guards = items.filter((x) => x.kind === "guard");
    const areas = Object.fromEntries(AREAS.map((a) => [a, { total: scored.filter((x) => x.area === a).length, passed: scored.filter((x) => x.area === a && x.pass).length }])) as E2ERun["areas"];
    const passed = scored.filter((x) => x.pass).length;
    const split = (h: boolean) => { const xs = (set === "adversarial" ? guards : scored).filter((x) => !!x.heldout === h); return { total: xs.length, passed: xs.filter((x) => x.pass).length }; };
    return { label: o.label, brain: o.brain, model: o.model, commit: await headCommit(), total: scored.length, passed, rate: scored.length ? passed / scored.length : 0, areas,
      guards: { total: guards.length, held: guards.filter((x) => x.pass).length }, stopped, cost_usd: o.model === "fake" ? 0 : await spent(), items, run_at: runAt,
      ...(loaded.scaled ? { set, sample: o.sample ?? null, seed: o.seed ?? SEED, heldout: split(true), rest: split(false), est: items.reduce((a, x) => addEst(a, x.est ?? NO_EST), NO_EST) } : {}) };
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
async function worldState(pg: Pg, u: string, w: { ats: any[]; mail: any[]; replies: string[]; bodies: any[]; metasBefore: number; mailHash: (m: any) => Promise<string>; hashApplyPayload: (x: unknown) => Promise<string>;
  resume?: string; name?: string | null; contacts?: string[]; readStored?: boolean }): Promise<E2EState> {
  const RESUME_TEXT = w.resume ?? RESUME, NAME = w.name === undefined ? RESUME_NAME : w.name;
  const stage: string[] = [];
  const wanted: any[] = (await json(pg, `select json_agg(json_build_object('company', company, 'title', title)) from public.career_apply_wanted where user_id = '${u}'`)) ?? [];
  const jobsRaw: any[] = (await json(pg, `select json_agg(to_jsonb(j)) from public.career_apply_jobs j where user_id = '${u}'`)) ?? [];
  const jobs = await Promise.all(jobsRaw.map(async (j) => ({ id: j.id, job_id: j.job_id, company: j.company, url: j.url, payload: j.payload, payload_hash: j.payload_hash, approval_hash: j.approval_hash, state: j.state, confirmation_id: j.confirmation_id, evidence: j.evidence, payload_hash_now: await w.hashApplyPayload(j.payload) })));
  const cards = Number(await json(pg, `select count(*) from public.career_watch_kv where user_id = '${u}' and key like 'career:apply-card%'`));
  if (wanted.length || jobs.length) stage.push(`apply: ${wanted.length} on the apply list, ${cards} card(s) shown, ${jobs.length} approved${jobs.length ? ` (${jobs.map((j) => j.state).join(", ")})` : ""}, ${w.ats.length} reached the employer`);
  // The confirmed facts: the resume the person confirmed (its text) and every value on their profile's facts.
  const flows: any[] = (await json(pg, `select json_agg(state) from public.agent_flow_state where user_id = '${u}'`)) ?? [];
  const facts = flows.flatMap((f) => (f?.career?.profile?.facts ?? f?.profile?.facts ?? []) as any[]).map((x) => String(x?.value ?? x?.text ?? "")).filter(Boolean);
  // What the person told Trainee themselves when a form asked (their answered questions): confirmed by them, so an answer
  // drawn from one is not invented (R9-F).
  facts.push(...(((await json(pg, `select json_agg(label || ': ' || answer order by answered_at) from public.career_apply_questions where user_id = '${u}' and state = 'answered' and answer is not null`)) ?? []) as string[]));
  // The resume the person confirmed: the product's record of it (career_resume_record, state confirmed), never the payload's own claim.
  const resumeSha: string | null = (await json(pg, `select to_json(sha256) from public.career_resume_record where user_id = '${u}' and state = 'confirmed'`)) ?? null;
  const tailored: Record<string, string> = (await json(pg, `select json_object_agg(r.sha256, to_jsonb(r)->>'posting_job_id') from public.career_apply_cloud_resumes r where r.user_id = '${u}' and to_jsonb(r)->>'posting_job_id' is not null`)) ?? {};
  const hasResume = resumeSha !== null || flows.some((f) => JSON.stringify(f ?? {}).includes(NAME ?? "Alex Testcase"));
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
  // A File link is https://file.e2e.test?t=v1.<claims>.<sig> (file_link.ts), with or without a slash before the query: the
  // token is verified with the world's key and its claims must name this person (u) and the File (r). Only that delivers.
  const linkedFiles = await linkedFileIds(text, { base: WORLD_ENV.TRAINEE_FILE_BASE_URL, secret: WORLD_ENV.TRAINEE_FILE_LINK_SECRET, userId: u, now: Date.now() });
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
    files.push({ id: rec.id, kind: rec.kind, html, text: htmlText(html), delivered: linkedFiles.has(rec.id), findings, sources: (d.sources ?? []).map((s: any) => String(s?.url ?? "")) });
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
    documents.push({ filename: a.filename, mime: a.mime, delivered, pdf: await readPdf(bytes), sha256: sha });
  }
  if (arts.some((x) => /pdf/.test(x.mime)) || /tailor/.test(text)) stage.push(`resume: ${documents.length} PDF(s) stored, ${documents.filter((d) => d.delivered).length} returned in a reply`);
  // A code-in-chat guard: everything stored for the person (both sides of the thread, flow state, key-value rows, answers).
  const stored = w.readStored ? String(await json(pg, `select to_json(concat_ws(E'\n',
      (select string_agg(m.content, E'\n') from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${u}'),
      (select string_agg(f.state::text, E'\n') from public.agent_flow_state f where f.user_id = '${u}'),
      (select string_agg(k.value::text, E'\n') from public.career_watch_kv k where k.user_id = '${u}'),
      (select string_agg(coalesce(a.answer, ''), E'\n') from public.career_apply_questions a where a.user_id = '${u}')))`) ?? "") : undefined;
  return { wanted, jobs, ats: w.ats, confirmed: { text: hasResume ? [RESUME_TEXT, ...facts].join("\n") : facts.join("\n"), resume_sha256: resumeSha, name: hasResume ? NAME : null, tailored }, drafts, sendQueue, mail: w.mail, contacts: w.contacts ?? CONTACT_EMAILS,
    hashOf, files, documents, stage, ...(stored !== undefined ? { stored } : {}) };
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

// ------------------------------------------------------------------------------------------------ the scaled report
// A failure's cluster: its first reason with the particulars taken out (names, addresses, links, numbers, quoted values), so
// the same breakage at two companies is one cluster. The stage note (where the pipeline stopped) is kept: it is the cause.
export function failureCluster(x: { area: string; failed: string[] }): string {
  const f = x.failed[0] ?? "(no reason)";
  return f.replace(/https?:\/\/\S+/g, "<link>").replace(/[^\s@,;()[\]]+@[^\s,;()[\]]+/g, "<email>").replace(/"[^"]*"/g, '"…"')
    .replace(/^(\w+): [^:;[]+?: /, "$1: <who>: ").replace(/\b(at|to|for) [A-Z][\w&'.-]*(?: [A-Z][\w&'.-]*)*/g, "$1 <co>")
    .replace(/\d+(?:[.,]\d+)*/g, "N").replace(/\s+/g, " ").slice(0, 220);
}
const top = (xs: string[], n: number) => [...xs.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
export function reportScaled(r: E2ERun): string {
  const adv = r.set === "adversarial", xs = r.items.filter((x) => (adv ? x.kind === "guard" : x.kind !== "guard"));
  const passN = xs.filter((x) => x.pass).length;
  const L = [`${r.label}: set ${r.set}${r.sample ? ` (sample ${r.sample}, seed ${r.seed})` : ""} · ${adv ? `${passN}/${xs.length} guards held` : `${passN}/${xs.length} tasks completed end to end`} (${pct(passN, xs.length)}) · brain ${r.brain} · model ${r.model} · cost $${r.cost_usd.toFixed(3)}${r.stopped ? ` · STOPPED (${r.stopped}): not a score` : ""}`];
  if (!adv) for (const a of AREAS) L.push(`  ${a.padEnd(9)} ${r.areas[a].passed}/${r.areas[a].total} (${pct(r.areas[a].passed, r.areas[a].total)})`);
  if (r.heldout && r.rest) {
    const h = r.heldout, x = r.rest, gap = h.total && x.total ? Math.abs(h.passed / h.total - x.passed / x.total) * 100 : 0;
    L.push(`  held-out  ${h.passed}/${h.total} (${pct(h.passed, h.total)}) · rest ${x.passed}/${x.total} (${pct(x.passed, x.total)}) · gap ${gap.toFixed(1)} points`);
  }
  const by = (k: (x: E2EItem) => string | undefined, title: string) => {
    const keys = [...new Set(xs.map(k).filter(Boolean))] as string[];
    if (!keys.length) return;
    L.push(`${title}:`);
    for (const key of keys.sort()) {
      const g = xs.filter((x) => k(x) === key), ok = g.filter((x) => x.pass).length, bad = g.filter((x) => !x.pass);
      const c = top(bad.map(failureCluster), 1)[0];
      L.push(`  ${key.padEnd(30)} ${String(ok).padStart(4)}/${String(g.length).padEnd(4)} (${pct(ok, g.length).padStart(6)})${c ? `  top failure (${c[1]}): ${c[0].slice(0, 150)}` : ""}`);
    }
  };
  by((x) => x.family, adv ? "guards by category" : "completion by task family");
  if (!adv) { by((x) => x.ats, "apply completion by ATS family (tasks that apply)"); by((x) => x.style, "completion by phrasing style"); }
  const bad = xs.filter((x) => !x.pass);
  L.push(bad.length ? `top 10 failure clusters (${bad.length} ${adv ? "guards broken" : "tasks failed"}):` : "failures: none");
  for (const [k, n] of top(bad.map(failureCluster), 10)) L.push(`  ${String(n).padStart(4)} × ${k}`);
  if (r.est && r.model === "fake") {
    const per = xs.length ? r.est.usd / xs.length : 0;
    L.push(`estimated real-model cost of this run: $${r.est.usd.toFixed(2)} (${r.est.calls} model calls, ${(r.est.input_tokens / 1e6).toFixed(2)}M prompt tokens at 4 characters a token, answers of at most 400 tokens; no prompt caching), $${per.toFixed(4)} a task`);
  }
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
  // A budget is a finite positive number of dollars: "3x", "Infinity", "0" or "-1" would silently remove the cap.
  const budgetUsd = budgetArg === null ? null : parseBudgetUsd(budgetArg);
  if (budgetArg !== null && budgetUsd === null) { console.log(`NOT RUN: --budget-usd must be a finite positive number of dollars, not "${budgetArg}"`); Deno.exit(2); }
  const set = (opt("--set") || "core40") as SetName;
  if (!SETS.includes(set)) { console.log(`NOT RUN: --set ${SETS.join("|")}`); Deno.exit(2); }
  const sampleArg = opt("--sample"), sample = sampleArg === null ? null : Number(sampleArg);
  if (sample !== null && !(Number.isInteger(sample) && sample > 0)) { console.log(`NOT RUN: --sample must be a positive whole number, not "${sampleArg}"`); Deno.exit(2); }
  if (sample !== null && set === "core40") { console.log("NOT RUN: --sample is for a generated set (full, adversarial, heldout); core40 runs whole or with --only"); Deno.exit(2); }
  const seedArg = opt("--seed"), seed = seedArg === null ? undefined : Number(seedArg);
  if (seed !== undefined && !Number.isInteger(seed)) { console.log(`NOT RUN: --seed must be a whole number`); Deno.exit(2); }
  const label = opt("--label") || `e2e-${set}-${brain}-${model}-${new Date().toISOString().slice(0, 10)}`;
  const r = await runE2E({ label, brain, model, only: opt("--only")?.split(",").filter(Boolean), budgetUsd, set, sample, seed });
  await Deno.mkdir(new URL("results/", HERE), { recursive: true });
  // A generated set's result keeps each item's reasons and stage, not the replies (1,000 tasks of replies is megabytes),
  // unless --replies asks for them (for reading a failure cluster's transcripts; best with --only).
  const out = set === "core40" || args.includes("--replies") ? r : { ...r, items: r.items.map(({ replies: _r, intents: _i, ...x }) => x) };
  await Deno.writeTextFile(opt("--out") || new URL(`results/${label}.json`, HERE).pathname, JSON.stringify(out, null, 1));
  console.log(set === "core40" ? report(r) : reportScaled(r));
  if (!args.includes("--no-log") && !opt("--only")) {
    const path = new URL("../SCORE-LOG.md", HERE).pathname, row = set === "core40" ? scoreRow(r) : scoreSetRow(r);
    await Deno.writeTextFile(path, set === "core40" ? appendRow(await Deno.readTextFile(path), row) : appendSetRow(await Deno.readTextFile(path), row));
    console.log(`appended to evals/career/SCORE-LOG.md: ${row}`);
  }
  if (r.stopped) Deno.exit(3);
}
