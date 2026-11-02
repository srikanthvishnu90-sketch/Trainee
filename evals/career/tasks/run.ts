// Task-completion eval: does Trainee get the job DONE? Judged by the person's end state, never by the reply's wording.
// Each task in tasks.json runs, for one fresh synthetic person, through the REAL agent-chat handler (handler-career.ts
// handleChat, unchanged) on a throwaway Postgres (tests/flow/pg.ts), then judge.ts reads their rows.
//
//   deno run -A --import-map=evals/career/tasks/import-map.json evals/career/tasks/run.ts --brain router|staged|planner --model fake
//   deno run -A --import-map=evals/career/tasks/agent-import-map.json evals/career/tasks/run.ts --brain agent --model fake
//   (paid, never in CI's gate: --model openai with OPENAI_API_KEY and --budget-usd; see .github/workflows/brain-eval.yml,
//    workflow_dispatch suite=tasks)
//
// Brains (production's own switches, read per request by the handler):
//   router   CAREER_BRAIN=router: the code-first chain, then the regex router (named, not unset: after D-035 unset serves
//            the release config's brain)
//   staged   CAREER_BRAIN=staged: questions and advice to the model, every action to code
//   planner  CAREER_BRAIN=staged and CAREER_PLANNER=on: compound asks planned into steps over the code paths
//   agent    CAREER_BRAIN=agent: the full agent brain behind the chain. It is pinned off in production
//            (AGENT_BRAIN_RELEASED = false); agent-import-map.json lifts the pin for this process only by mapping
//            agent-chat/career_brain.ts to released/career_brain.ts. Run without that map, --brain agent is NOT RUN.
// Every brain also runs with CAREER_NETWORKING_DRAFT=on (drafting outreach is a model call on every brain).
// Models: fake (fake_model.ts plays each task's oracle: what the code paths complete when the model plans right; free,
// deterministic, CI) or openai (the real model; needs OPENAI_API_KEY; spend read from agent_turn_costs, capped by
// --budget-usd, stops before the next task at the cap; a stopped run is not a score).
// Setup turns (paste and confirm the resume, send the contacts file) always run on the router, before the brain is set.
// Output: evals/career/tasks/results/<label>.json and one summary line (completion rate, invariant breaks, failing ids).
// deno-lint-ignore-file no-explicit-any
import { pgBinDir, type Pg, startPg } from "../../../tests/flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../../../tests/flow/handler.ts";
import { type EndState, type Expect, judge } from "./judge.ts";
import { calls as fakeCalls, clearOracle, fakeOpenAI, type OracleStep, setMutation, setOracle } from "./fake_model.ts";

export type BrainName = "router" | "staged" | "planner" | "agent";
export interface Task { id: string; family: string; setup: string[]; turns: string[]; oracle: Record<string, OracleStep[]>; expect: Expect; note?: string }
export interface TaskResult { id: string; family: string; pass: boolean; failed: string[]; replies: string[]; intents: (string | null)[]; state: EndState; planner?: unknown[]; tools?: string[] }
export interface RunResult { label: string; brain: BrainName; model: string; total: number; passed: number; rate: number; invariant_breaks: number; stopped: string | null; cost_usd: number; items: TaskResult[]; run_at: string }

const ROOT = new URL("../../../", import.meta.url).pathname;
const SET = JSON.parse(await Deno.readTextFile(new URL("./tasks.json", import.meta.url)));
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const CONTACTS = await Deno.readTextFile(new URL("./contacts.csv", import.meta.url));
export const TASKS: Task[] = SET.tasks;
const ENV_KEYS = ["CAREER_BRAIN", "CAREER_PLANNER", "CAREER_PLANNER_USERS", "CAREER_NETWORKING_DRAFT", "OPENAI_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_BRAIN_ROUTER_INTENTS"];
const q = (s: string) => s.replace(/'/g, "''");
const uid = (i: number) => `7b0f8f8e-6a43-4a49-9d2c-${String(7_000_000_000_000 + i).slice(-12)}`;

async function seed(pg: Pg, ids: string[]) {
  const P: any[] = SET.postings;
  await pg.sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
    ${P.map((p) => `('${p.job_id}', 'greenhouse', '${p.job_id.split(":")[1]}', '${q(p.company)}', '${q(p.title)}', '${q(p.location)}', '${p.url}', '${q(p.description)}', now(), now())`).join(",\n")};
    insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
    ${P.map((p, i) => `('${p.job_id}', 'greenhouse', '${p.job_id.split(":")[1]}', '${q(p.company)}', '${q(p.title)}', '${q(p.location)}', '${p.url}', now() - interval '${i} hours', '${q(p.description)}', 'k${i}')`).join(",\n")};`);
  for (const id of ids) {
    await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
      insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
  }
}

const json = async (pg: Pg, sql: string): Promise<any> => JSON.parse((await pg.sql(`select coalesce((${sql})::text, 'null')`)).trim() || "null");
export async function endState(pg: Pg, u: string): Promise<EndState & { metas: any[] }> {
  const metas: any[] = (await json(pg, `select json_agg(m.meta order by m.id) from public.agent_messages m join public.agent_threads t on t.id = m.thread_id where t.user_id = '${u}' and m.role = 'assistant'`)) ?? [];
  const flows: any[] = (await json(pg, `select json_agg(state) from public.agent_flow_state where user_id = '${u}'`)) ?? [];
  const stores = flows.map((f) => f?.career?.stores ?? f?.stores ?? {});
  const kv = async (key: string) => await json(pg, `select value from public.career_watch_kv where user_id = '${u}' and key = '${key}'`);
  const tool = (name: string) => metas.some((m) => (m?.tool_calls ?? []).some((c: any) => c?.name === name && c?.ok));
  const planned = (cap: string) => metas.some((m) => (m?.planner?.steps ?? []).some((s: any) => s.capability === cap && s.status === "done"));
  const watchKv = (await json(pg, `select json_agg(value) from public.career_watch_kv where user_id = '${u}' and key like 'career:watch%'`)) ?? [];
  const prefs = (await json(pg, `select json_agg(prefs) from public.career_alert_prefs where user_id = '${u}'`)) ?? [];
  return {
    queued: (await json(pg, `select json_agg(json_build_object('posting_key', posting_key, 'company', company, 'title', title) order by posting_key) from public.career_apply_wanted where user_id = '${u}'`)) ?? [],
    drafts: (await json(pg, `select json_agg(json_build_object('email', recipient_email, 'status', status)) from public.career_outreach_drafts where user_id = '${u}'`)) ?? [],
    send_queue: Number(await json(pg, `select count(*) from public.career_send_queue where user_id = '${u}'`)),
    apply_jobs: Number(await json(pg, `select count(*) from public.career_apply_jobs where user_id = '${u}'`)),
    outbox: Number(await json(pg, `select count(*) from public.career_outbox where user_id = '${u}'`)),
    tracker: stores.flatMap((s) => Array.isArray(s?.trackStore?.rows) ? s.trackStore.rows : []).map((r: any) => ({ company: String(r.company ?? ""), stage: String(r.stage ?? ""), next_when: r.next_when ?? null })),
    reminders: ((await kv("career:reminders"))?.items ?? []).map((r: any) => ({ what: r.what, when: r.when, due_date: r.due_date })),
    watch: JSON.stringify([watchKv, prefs]),
    standing: ((await kv("career:standing"))?.items ?? []).map((x: any) => String(x?.text ?? "")),
    // Two tailored resumes can be the same bytes (the store keeps one copy): the postings a planned step tailored count too.
    tailored: Math.max(Number(await json(pg, `select count(*) from public.channel_artifacts where user_id = '${u}' and mime = 'application/pdf'`)),
      new Set(metas.flatMap((m) => (m?.planner?.steps ?? []).flatMap((s: any) => s?.detail?.tailored ?? []))).size),
    prep: metas.some((m) => /prep|interview_brief/.test(String(m?.intent ?? ""))) || planned("interview.prep") || tool("interview_brief"),
    searched: stores.some((s) => Array.isArray(s?.discovery?.lastShortlist) && s.discovery.lastShortlist.length > 0) || tool("search_jobs"),
    metas,
  };
}

function brainEnv(brain: BrainName | "setup") {
  for (const k of ["CAREER_BRAIN", "CAREER_PLANNER"]) Deno.env.delete(k);
  if (brain === "router" || brain === "setup") Deno.env.set("CAREER_BRAIN", "router");
  if (brain === "staged" || brain === "planner") Deno.env.set("CAREER_BRAIN", "staged");
  if (brain === "planner") Deno.env.set("CAREER_PLANNER", "on");
  if (brain === "agent") Deno.env.set("CAREER_BRAIN", "agent");
}

export async function runTasks(o: { brain: BrainName; model: "fake" | "openai"; label: string; only?: string[]; budgetUsd?: number | null; mutate?: ((s: OracleStep[]) => OracleStep[]) | null; quiet?: boolean }): Promise<RunResult> {
  const tasks = TASKS.filter((t) => !o.only?.length || o.only.includes(t.id));
  const saved: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, Deno.env.get(k)]));
  const realFetch = globalThis.fetch;
  const pg = await startPg();
  let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const items: TaskResult[] = [];
  let stopped: string | null = null;
  try {
    await supabaseParity(pg);
    const people: Record<string, string> = {};
    tasks.forEach((t) => { people[`tok-${t.id}`] = uid(TASKS.indexOf(t) + 1); });
    await seed(pg, Object.values(people));
    if (o.model === "fake") Deno.env.set("OPENAI_API_KEY", "sk-fake-tasks-not-a-key");
    else if (!Deno.env.get("OPENAI_API_KEY")) throw new Error("NOT RUN: --model openai needs OPENAI_API_KEY");
    // The outside world, as the eval sees it: the model (the fake, or OpenAI itself on a paid run), and the job boards of
    // the seeded postings, which answer as live (the brain's link check drops a posting whose board says 404). Nothing
    // else is reachable.
    const jobNumbers = new Set((SET.postings as any[]).map((p) => p.job_id.split(":")[2]));
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      const url = new URL(req.url);
      if (url.hostname === "api.openai.com") return o.model === "fake" ? await fakeOpenAI(req) : await realFetch(req);
      if (/(^|\.)greenhouse\.io$/.test(url.hostname)) {
        const n = /\/jobs\/(\d+)/.exec(url.pathname)?.[1];
        return n && jobNumbers.has(n) ? new Response(JSON.stringify({ id: Number(n) }), { status: 200, headers: { "content-type": "application/json" } }) : new Response("not found", { status: 404 });
      }
      return new Response("not reachable in the task eval", { status: 404 });
    }) as typeof fetch;
    Deno.env.delete("MODEL_PROVIDER");
    Deno.env.set("CAREER_MODEL", Deno.env.get("CAREER_MODEL") || "gpt-5-mini");
    Deno.env.set("CAREER_NETWORKING_DRAFT", "on");
    setMutation(o.mutate ?? null);
    h = await careerHandler(pg, people);
    const spent = async () => Number(await json(pg, "select coalesce(sum(usd_micros), 0) from public.agent_turn_costs")) / 1e6;
    for (const t of tasks) {
      if (o.budgetUsd != null && await spent() + 0.05 >= o.budgetUsd) { stopped = `budget: $${(await spent()).toFixed(3)} of $${o.budgetUsd}`; break; }
      const chat: Chat = h.chat(`tok-${t.id}`), u = people[`tok-${t.id}`];
      const say = async (m: string, extra: Record<string, unknown> = {}) => { const r = await chat.say(m, extra); if (r.status !== 200) throw new Error(`${t.id}: HTTP ${r.status}: ${r.reply.slice(0, 200)}`); return r; };
      brainEnv("setup");
      clearOracle();
      if (t.setup.includes("resume")) { await say(`here is my resume:\n${RESUME}`); await say("yes, that's my resume"); }
      if (t.setup.includes("contacts")) await say("here are my contacts", { attachments: [{ name: "contacts.csv", mime: "text/csv", text: CONTACTS }] });
      if (t.setup.includes("signature")) await pg.sql(`insert into public.career_outreach_prefs (user_id, signature) values ('${u}', 'Alex Testcase') on conflict (user_id) do update set signature = excluded.signature`);
      brainEnv(o.brain);
      setOracle(t.oracle);
      const replies: string[] = [], intents: (string | null)[] = [];
      const metasBefore = ((await endState(pg, u)).metas ?? []).length;
      for (const m of t.turns) { const r = await say(m); replies.push(r.reply); intents.push(r.intent); }
      const s = await endState(pg, u);
      const { metas, ...state } = s;
      const j = judge(t.expect, state, Date.now());
      const planner = metas.slice(metasBefore).map((m: any) => m?.planner ?? null).filter(Boolean);
      // The brain's tool calls (name, ok, the error it met), for tracing a failure to its cause; never judged.
      const tools = metas.slice(metasBefore).flatMap((m: any) => (m?.tool_calls ?? []).map((c: any) => `${c.name}:${c.ok ? "ok" : `error ${String(c.error ?? "").slice(0, 160)}`}`));
      items.push({ id: t.id, family: t.family, pass: j.pass, failed: j.failed, replies, intents, state, ...(planner.length ? { planner } : {}), ...(tools.length ? { tools } : {}) });
      if (!o.quiet) console.log(`${t.id} ${j.pass ? "PASS" : "FAIL"} ${t.family}${j.pass ? "" : `: ${j.failed.join("; ")}`}`);
    }
    const passed = items.filter((x) => x.pass).length;
    return { label: o.label, brain: o.brain, model: o.model, total: items.length, passed, rate: items.length ? passed / items.length : 0,
      invariant_breaks: items.filter((x) => x.failed.some((f) => f.startsWith("INVARIANT"))).length, stopped, cost_usd: o.model === "fake" ? 0 : await spent(), items, run_at: new Date().toISOString() };
  } finally {
    setMutation(null);
    clearOracle();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
    h?.restore();
    globalThis.fetch = realFetch;
    await pg.stop();
  }
}

export function summaryLine(r: RunResult): string {
  return `${r.label}: ${r.passed}/${r.total} tasks completed (${Math.round(r.rate * 100)}%) · brain ${r.brain} · model ${r.model} · invariant breaks ${r.invariant_breaks} · cost $${r.cost_usd.toFixed(3)}${r.stopped ? ` · STOPPED (${r.stopped}): not a score` : ""}\nfailing: ${r.items.filter((x) => !x.pass).map((x) => x.id).join(", ") || "none"}`;
}

if (import.meta.main) {
  const args = Deno.args, opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
  const brain = (opt("--brain") || "router") as BrainName, model = (opt("--model") || "fake") as "fake" | "openai";
  if (!["router", "staged", "planner", "agent"].includes(brain) || !["fake", "openai"].includes(model)) { console.log("NOT RUN: --brain router|staged|planner|agent, --model fake|openai"); Deno.exit(2); }
  if (!pgBinDir()) { console.log("NOT RUN: no Postgres 16 binaries (PGBIN or /usr/lib/postgresql/16/bin)"); Deno.exit(2); }
  if (brain === "agent") {
    const { AGENT_BRAIN_RELEASED } = await import("../../../supabase/functions/agent-chat/career_brain.ts");
    if (!AGENT_BRAIN_RELEASED) { console.log("NOT RUN: --brain agent needs --import-map=evals/career/tasks/agent-import-map.json (the production pin AGENT_BRAIN_RELEASED=false holds otherwise)"); Deno.exit(2); }
  }
  if (model === "openai" && !Deno.env.get("OPENAI_API_KEY")) { console.log("NOT RUN: --model openai needs OPENAI_API_KEY"); Deno.exit(2); }
  const budgetArg = opt("--budget-usd") ?? Deno.env.get("EVAL_BUDGET_USD") ?? null;
  if (model === "openai" && budgetArg === null) { console.log("NOT RUN: --model openai needs --budget-usd (or EVAL_BUDGET_USD): an uncapped paid run is never started"); Deno.exit(2); }
  const label = opt("--label") || `tasks-${brain}-${model}-${new Date().toISOString().slice(0, 10)}`;
  // --mutate drop_last (fake model only): the planner is handed every plan without its last step, so the eval's own
  // guard can be shown to catch a dropped part (tests/architect/task-completion-eval.test.ts).
  const mutation = opt("--mutate");
  if (mutation && (mutation !== "drop_last" || model !== "fake")) { console.log("NOT RUN: --mutate drop_last needs --model fake"); Deno.exit(2); }
  const r = await runTasks({ brain, model, label, only: opt("--only")?.split(",").filter(Boolean), budgetUsd: budgetArg === null ? null : Number(budgetArg),
    mutate: mutation === "drop_last" ? (steps) => steps.slice(0, -1) : null });
  await Deno.mkdir(new URL("./results/", import.meta.url), { recursive: true });
  const out = opt("--out") || new URL(`./results/${label}.json`, import.meta.url).pathname;
  await Deno.writeTextFile(out, JSON.stringify({ ...r, fake_calls: model === "fake" ? fakeCalls.length : undefined }, null, 1));
  console.log(summaryLine(r));
  if (r.stopped) Deno.exit(3);
}
