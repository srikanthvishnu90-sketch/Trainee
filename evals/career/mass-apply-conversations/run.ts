// The mass-apply conversation eval (rubric.json, README.md): each scenario is one fictional person's whole mass-apply job,
// driven through the REAL agent-chat handler (the e2e eval's world: evals/career/e2e/run.ts runE2E, a throwaway Postgres,
// the hosted preparation and the cloud worker in-process, the stub ATS on 127.0.0.1 as every employer). Nothing reaches a real
// employer, inbox or person. Graded by code first (grade.ts), and by a subscription judge only for what code cannot read
// (judge.ts, a yes needs an exact quote).
//
//   deno run -A evals/career/mass-apply-conversations/run.ts --label <label>                    fake model ($0, the planner's oracle)
//   env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN deno run -A evals/career/mass-apply-conversations/run.ts --model subscription --judge --label <label>
//       the brain answered by the claude CLI on the owner's subscription (D-089; apiKeySource "none" checked; never CI, never an API key)
//   options: --only MA01,MA14   --out <file>
// Output: results/<label>.json (every scenario's snapshot, checks and score) and results/<label>.md (the scorecard).
// Needs Postgres 16 (PGBIN) and a short TMPDIR on macOS (the socket path limit: TMPDIR=/tmp/<short>).
// deno-lint-ignore-file no-explicit-any
import { type E2ETask, runE2E, type TaskTrace } from "../e2e/run.ts";
import { gradeCode, type Posting, type Result, type Scenario, score, type Snapshot } from "./grade.ts";

const HERE = new URL("./", import.meta.url), ROOT = new URL("../../../", import.meta.url).pathname;
const RUBRIC = JSON.parse(await Deno.readTextFile(new URL("rubric.json", HERE)));
const WORLD = JSON.parse(await Deno.readTextFile(new URL("world.json", HERE)));
const BASE = JSON.parse(await Deno.readTextFile(new URL("../tasks/tasks.json", HERE))), E2E = JSON.parse(await Deno.readTextFile(new URL("../e2e/tasks.json", HERE)));
export const SCENARIOS: Scenario[] = RUBRIC.scenarios;
export const ALL_POSTINGS: Posting[] = [...BASE.postings, ...E2E.extra_postings, ...WORLD.postings, ...WORLD.scale];

const j = async (pg: TaskTrace["pg"], sql: string): Promise<any> => JSON.parse((await pg.sql(`select coalesce((${sql})::text, 'null')`)).trim() || "null");

// The scenario's own turns among everything the person said (the rest are their answers to questions Trainee asked).
export function scriptedIndices(turns: string[], said: string[]): number[] {
  const out: number[] = [];
  let k = 0;
  said.forEach((m, i) => { if (k < turns.length && m === turns[k]) { out.push(i); k++; } });
  return out;
}

export async function snapshotOf(x: TaskTrace): Promise<Snapshot> {
  const u = x.user;
  const { hashApplyPayload } = await import("../../../supabase/functions/_shared/career_apply_store.ts");
  const jobsRaw: any[] = (await j(x.pg, `select json_agg(to_jsonb(r) order by r.created_at) from public.career_apply_jobs r where user_id = '${u}'`)) ?? [];
  const jobs = await Promise.all(jobsRaw.map(async (r) => ({ company: r.company, url: r.url, job_id: r.job_id, payload_hash: r.payload_hash, approval_hash: r.approval_hash,
    payload_hash_now: await hashApplyPayload(r.payload), state: r.state, confirmation_id: r.confirmation_id ?? null, resume_name: r.payload?.resume_filename ?? r.payload?.resume_name ?? null })));
  const mine = new Set(jobs.map((r) => /\/([^/?#]+)\/jobs\/(\d+)/.exec(String(r.url ?? ""))).filter(Boolean).map((m) => `${m![1]}/${m![2]}`));
  return {
    said: x.said, replies: x.replies, intents: x.intents, turnMs: x.turnMs.map(Math.round), scripted: scriptedIndices(x.task.turns, x.said),
    // The thread, then the texts Trainee queued to the person outside it (career_outbox: the scheduled receipts), in order.
    thread: [...x.thread.map((m) => ({ content: String(m.content ?? ""), meta: m.meta ?? null })),
      ...(((await j(x.pg, `select json_agg(json_build_object('content', text, 'kind', kind) order by created_at, key) from public.career_outbox where user_id = '${u}' and kind = 'receipt'`)) ?? []) as any[]).map((r) => ({ content: String(r.content ?? ""), meta: { outbox: r.kind } }))],
    // Only this person's: a send the cloud worker finishes during a later scenario's turns belongs to the person it was approved for.
    atsPosts: x.atsPosts.filter((p) => mine.has(`${p.board}/${p.job}`)).map((p) => ({ board: p.board, job: p.job, files: p.files, fields: p.fields, confirmation_id: p.confirmation_id })),
    postsAt: x.atsPostsAt, jobsAt: x.jobsAt, wallMs: x.wallMs.map(Math.round), requested: x.requested,
    wanted: (await j(x.pg, `select json_agg(json_build_object('company', company, 'title', title, 'url', url, 'posting_key', posting_key)) from public.career_apply_wanted where user_id = '${u}'`)) ?? [],
    jobs,
    questions: (await j(x.pg, `select json_agg(json_build_object('label', label, 'company', company, 'state', state) order by created_at) from public.career_apply_questions where user_id = '${u}'`)) ?? [],
    // D-094: the batch Files (a summary card's full list), as stored.
    files: (((await j(x.pg, `select json_agg(json_build_object('id', value->>'id', 'items', value->'data'->'batch'->'items')) from public.career_watch_kv where user_id = '${u}' and key like 'tf:file:%' and value->'data' ? 'batch'`)) ?? []) as any[])
      .map((f) => ({ id: String(f.id), items: (f.items ?? []).map((i: any) => ({ n: i.n, prepared_id: i.prepared_id, payload_hash: i.payload_hash, employer: i.employer, role: i.role, url: i.url })) })),
  };
}

export interface ScenarioResult { id: string; title: string; score: number; must: string; nice: string; ungraded: number; checks: Result[]; snapshot: Snapshot }

export async function runConversations(o: { label: string; model: "fake" | "subscription"; only?: string[]; judge?: boolean; quiet?: boolean }) {
  const scen = SCENARIOS.filter((s) => !o.only?.length || o.only.includes(s.id));
  const tasks: E2ETask[] = scen.map((s) => ({ id: s.id, area: "apply", kind: "task", setup: s.setup, turns: s.turns, oracle: s.oracle as any, expect: { apply: { min: 0 } }, ...(Deno.env.get("MAC_FIXTURE_PERSON") ? {} : { person: WORLD.person }) }));
  const snaps = new Map<string, Snapshot>();
  const t0 = performance.now();
  const run = await runE2E({ label: o.label, brain: "production", model: o.model, tasks, postings: [...WORLD.postings, ...WORLD.scale], openGate: true, quiet: true,
    onTask: async (x) => { snaps.set(x.task.id, await snapshotOf(x)); return {}; } });
  const results: ScenarioResult[] = [];
  for (const s of scen) {
    const snap = snaps.get(s.id);
    if (!snap) continue;
    const code = gradeCode(s, snap, ALL_POSTINGS);
    const judged: Result[] = o.judge && o.model === "subscription" ? await (await import("./judge.ts")).judgeChecks(s, snap)
      : s.checks.filter((c) => c.kind === "judge").map((c) => ({ id: c.id, level: c.level, pass: null, why: "not judged (run with --model subscription --judge)" }));
    const checks = [...code, ...judged], sc = score(checks);
    results.push({ id: s.id, title: s.title, ...sc, checks, snapshot: snap });
    if (!o.quiet) console.log(`${s.id} ${sc.score.toFixed(1)}/10  MUST ${sc.must}  NICE ${sc.nice}${sc.ungraded ? `  (${sc.ungraded} not judged)` : ""}  ${s.title}\n${checks.filter((c) => c.pass === false).map((c) => `    x ${c.level} ${c.id}: ${c.why}`).join("\n")}`);
  }
  const mean = results.length ? results.reduce((a, r) => a + r.score, 0) / results.length : 0;
  return { label: o.label, model: o.model, commit: run.commit, run_at: run.run_at, seconds: Math.round((performance.now() - t0) / 1000), mean: Math.round(mean * 100) / 100, results };
}

export function scorecard(r: Awaited<ReturnType<typeof runConversations>>): string {
  const L = [`# Mass-apply conversations: ${r.label}`, "", `Commit ${r.commit} · model ${r.model} · ${r.seconds} s · mean ${r.mean.toFixed(2)}/10`, "",
    "| Scenario | Score | MUST | NICE | Failed checks |", "|---|---|---|---|---|"];
  for (const x of r.results) L.push(`| ${x.id} ${x.title.replace(/\|/g, "/")} | ${x.score.toFixed(1)} | ${x.must} | ${x.nice} | ${x.checks.filter((c) => c.pass === false).map((c) => `${c.level === "MUST" ? "**" : ""}${c.id}${c.level === "MUST" ? "**" : ""}`).join(", ") || "none"} |`);
  const scale = r.results.find((x) => x.id === "MA14");
  if (scale) {
    const s = scale.snapshot, card = s.thread.filter((m) => m.meta?.intent === "career_apply_card" || /applications? (?:is|are) ready/.test(m.content));
    L.push("", "## Scale (MA14)", "", `- ask to card (preparation, stub world): ${((s.wallMs[0] ?? 0) / 1000).toFixed(1)} s; yes turn with sends: ${((s.wallMs[1] ?? 0) / 1000).toFixed(1)} s`,
      `- card messages: ${card.length}, longest ${Math.max(0, ...card.map((m) => m.content.length))} characters${card.some((m) => m.meta?.file_id) ? `; its File lists ${(s.files ?? []).find((f) => f.id === card.find((m) => m.meta?.file_id)?.meta?.file_id)?.items.length ?? 0}` : ""}`,
      `- approved ${s.jobs.length}, reached the employer ${s.atsPosts.length}, distinct postings sent ${new Set(s.atsPosts.map((p) => `${p.board}/${p.job}`)).size}`);
  }
  return L.join("\n") + "\n";
}

if (import.meta.main) {
  if (!Deno.env.get("E2E_UNDER_MAP")) {
    const p = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", "--no-check", `--import-map=${ROOT}tests/flow/supabase-npm.json`, new URL(import.meta.url).pathname, ...Deno.args], env: { E2E_UNDER_MAP: "1" }, stdout: "inherit", stderr: "inherit" }).output();
    Deno.exit(p.code);
  }
  const args = Deno.args, opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
  const model = (opt("--model") || "fake") as "fake" | "subscription";
  if (!["fake", "subscription"].includes(model)) { console.log("NOT RUN: --model fake|subscription (never an API key)"); Deno.exit(2); }
  if (model === "subscription") {
    if (Deno.env.get("CI")) { console.log("NOT RUN: --model subscription never runs in CI (D-089)"); Deno.exit(2); }
    if (Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("ANTHROPIC_AUTH_TOKEN")) { console.log("NOT RUN: start it with env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN (subscription only)"); Deno.exit(2); }
    await (await import("../../subscription/claude_cli.ts")).preflight();
  }
  // --regrade <results.json>: grade a run's saved snapshots again with this grader (code checks; judge results kept as they were).
  const again = opt("--regrade");
  if (again) {
    const r = JSON.parse(await Deno.readTextFile(again));
    for (const x of r.results) {
      const s = SCENARIOS.find((y) => y.id === x.id)!;
      const checks = [...gradeCode(s, x.snapshot, ALL_POSTINGS), ...x.checks.filter((c: Result) => s.checks.find((k) => k.id === c.id)?.kind === "judge")];
      Object.assign(x, { checks, ...score(checks) });
    }
    r.mean = Math.round((r.results.reduce((a: number, x: ScenarioResult) => a + x.score, 0) / r.results.length) * 100) / 100;
    await Deno.writeTextFile(again, JSON.stringify(r, null, 1));
    await Deno.writeTextFile(again.replace(/\.json$/, ".md"), scorecard(r));
    console.log(`regraded ${again}: mean ${r.mean.toFixed(2)}/10`);
    Deno.exit(0);
  }
  const label = opt("--label") || `mac-${model}-${new Date().toISOString().slice(0, 10)}`;
  const r = await runConversations({ label, model, only: opt("--only")?.split(",").filter(Boolean), judge: args.includes("--judge") });
  await Deno.mkdir(new URL("results/", HERE), { recursive: true });
  const out = opt("--out") || new URL(`results/${label}.json`, HERE).pathname;
  await Deno.writeTextFile(out, JSON.stringify(r, null, 1));
  await Deno.writeTextFile(out.replace(/\.json$/, ".md"), scorecard(r));
  console.log(`\n${r.label}: mean ${r.mean.toFixed(2)}/10 over ${r.results.length} scenario(s) -> ${out}`);
}
