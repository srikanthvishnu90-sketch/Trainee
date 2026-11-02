// Eval runner and rubric judge (WO-003). Scores a brain (the CareerHost router or the agent) on the architect-owned set
// evals/career/messages.json. Each item runs in a fresh thread through the same conversation interface the product uses;
// a model judge grades the last reply (and the end state, where the item names one) against must / must_not.
//
//   deno run -A evals/career/run.ts --brain router|agent|staged --label <label> [--set official|heldout] [--only E001,E002]
//                                   [--budget-usd 15]
//
// --budget-usd (or EVAL_BUDGET_USD) is a total across runs: the spend already recorded in evals/career/results/*.json
// counts against it, and the run stops before the next item once the spend plus a reserve for one more item reaches it.
// A stopped run is written with "stopped", and is not a score.
// Needs OPENAI_API_KEY (the judge; and the agent brain). Without it: NOT RUN, exit 2. A score is never faked.
// Results: evals/career/results/<label>.json, plus the pass rate and failing ids on stdout.
// 2026-10-26 (sealed set): `category` names the journey stage; `expect` is the outcome counted by code from the end state
// (harness.ts outcomeOf: rows written or not), checked beside the judges: an item passes only when both judges pass it AND
// its outcome holds. `world` seeds postings for search_jobs and get_posting.
export interface EvalItem { id: string; persona: string; turns: string[]; must: string[]; must_not?: string[]; state?: string;
  category?: string; expect?: import("./harness.ts").Expect; world?: { postings?: Record<string, unknown>[] } }
// `trace` (WO-061): per turn, how the agent loop ended and every tool it called (name, ok, error). Never shown to a judge;
// it is there so a failure reply (the step-limit text) can be traced to its cause instead of guessed.
// FEATURE 13: under --brain staged each turn also says where it went (brain, router, or router_fallback after a model
// failure) and the router class that decided it.
export type Trace = { stopped: string; steps: number; tools: { name: string; ok: boolean; error?: string }[]; errors?: string[]; route?: string; intent?: string | null; reason?: string }[];
export type Brain = (turns: string[], item?: EvalItem) => Promise<{ replies: string[]; state: unknown; trace?: Trace }>;
export type Judge = (item: EvalItem, lastReply: string, state: unknown) => Promise<{ pass: boolean; failed: string[]; score: number; note: string }>;
export interface EvalItemResult { id: string; category?: string; outcome?: unknown; state_check?: { ok: boolean; failed: string[] }; pass: boolean; failed: string[]; score: number; replies: string[]; note: string; state?: unknown; trace?: Trace; judges?: { model: string; pass: boolean; failed: string[]; note: string }[] }
export interface EvalResult { total: number; passed: number; pass_rate: number; items: EvalItemResult[]; planned: number; stopped: string | null }

import { type BrainName, checkExpect, HARNESS, type ModelFn, outcomeOf } from "./harness.ts";
// stop: asked before each item; a reason ends the run there (the spend cap), and the items not run are not scored.
export async function runEval(items: EvalItem[], brain: Brain, judge: Judge, stop?: () => string | null): Promise<EvalResult> {
  const out: EvalItemResult[] = [];
  let stopped: string | null = null;
  for (const it of items) {
    stopped = stop ? stop() : null;
    if (stopped) break;
    let replies: string[] = [], state: unknown = null, trace: Trace | undefined;
    const cat = it.category ? { category: it.category } : {};
    try { const r = await brain(it.turns, it); replies = r.replies; state = r.state; trace = r.trace; }
    catch (e) { out.push({ id: it.id, ...cat, pass: false, failed: it.must, score: 1, replies, note: `brain error: ${e instanceof Error ? e.message : String(e)}` }); continue; }
    // The outcome is counted by code, never by a judge; a wrong outcome fails the item whatever the judges say.
    const outcome = outcomeOf(state), sc = checkExpect(it.expect, outcome);
    try {
      const j = await judge(it, replies[replies.length - 1] ?? "", state);
      // The end state the judges saw is kept, so a later re-score (rejudge.ts) grades exactly what they graded.
      out.push({ id: it.id, ...cat, pass: !!j.pass && sc.ok, failed: [...(j.failed || []), ...sc.failed.map((f) => `state: ${f}`)], score: Number(j.score) || 1, replies, note: j.note || "", ...((j as any).judges ? { judges: (j as any).judges } : {}), state: state ?? null, outcome, state_check: sc, ...(trace ? { trace } : {}) });
    } catch (e) {
      out.push({ id: it.id, ...cat, pass: false, failed: it.must, score: 1, replies, note: `judge error: ${e instanceof Error ? e.message : String(e)}`, outcome, state_check: sc });
    }
  }
  const passed = out.filter((x) => x.pass).length;
  return { total: out.length, passed, pass_rate: out.length ? passed / out.length : 0, items: out, planned: items.length, stopped };
}

// WO-061 (owner, 2026-10-21: "Two independent judges score each item. One judge's reading never decides an item alone;
// when judges disagree, the item counts as a failure until both pass it."): both verdicts are kept, and the item passes
// only when every judge passes it. A judge that errors fails the item.
export type Verdict = { pass: boolean; failed: string[]; score: number; note: string };
export function bothJudges(verdicts: { model: string; v: Verdict }[]): Verdict & { judges: { model: string; pass: boolean; failed: string[]; note: string }[] } {
  const judges = verdicts.map(({ model, v }) => ({ model, pass: !!v.pass, failed: v.failed || [], note: v.note || "" }));
  return {
    pass: judges.length > 0 && judges.every((j) => j.pass),
    failed: [...new Set(judges.flatMap((j) => j.failed))],
    score: Math.min(...verdicts.map(({ v }) => Number(v.score) || 1)),
    note: judges.map((j) => `[${j.model}: ${j.pass ? "pass" : "FAIL"}] ${j.note}`).join(" "),
    judges,
  };
}

// The spend already recorded: every result file's brain and judge cost, except the label being written now, plus the
// ledger's all-time baseline (spend-ledger.json). The result files of the runs before 2026-10-26 are not in any checkout
// (ci/brain-eval was rebuilt), so without the baseline the cap saw $0 spent of $35.50: run 40371458562 recorded
// spent_before_usd 0 while $15.508 had been spent (SCORE-LOG close line, 2026-10-21).
export type Ledger = { baseline_usd: number; baseline_as_of: string; counted_labels?: string[] };
export function spentUsd(results: { label?: string; run_at?: string; cost_usd?: { brain?: number; judge?: number } }[], label: string, ledger?: Ledger | null): number {
  const after = (r: { run_at?: string }) => !ledger || !r.run_at || r.run_at > ledger.baseline_as_of;
  const seen = new Set<string>();
  return (ledger?.baseline_usd ?? 0) + results.filter((r) => r.label !== label && after(r)).reduce((a, r) => {
    if (r.label && seen.has(r.label)) return a;
    if (r.label) seen.add(r.label);
    return a + (Number(r.cost_usd?.brain) || 0) + (Number(r.cost_usd?.judge) || 0);
  }, 0);
}

// The cap: stop when what is spent, plus a reserve for one more item, reaches the budget.
export function budgetStop(budget: number | null, spent: () => number, reserve = 0.25): () => string | null {
  return () => budget !== null && spent() + reserve >= budget ? `budget: $${spent().toFixed(3)} spent of $${budget.toFixed(2)}` : null;
}

export const JUDGE_PROMPT = `You grade one reply from a career agent. You are strict and literal.
User persona: {persona}
Conversation (user turns in order): {turns}
Agent's final reply: {reply}
End state after the conversation (JSON, may be null): {state}
Required (every one must hold): {must}
Forbidden (none may happen): {must_not}
Expected end state (if given): {state_expectation}
Return JSON only: {"pass": boolean, "failed": [the exact required/forbidden/state items that failed], "score": 1-5 for overall usefulness to this person, "note": one sentence}.
pass is true only if every required item holds, no forbidden item happens, and the expected end state (if given) holds.`;

export function judgePrompt(item: EvalItem, reply: string, state: unknown): string {
  const fill: Record<string, string> = {
    persona: item.persona, turns: JSON.stringify(item.turns), reply,
    // The outcome counts come first, so a long end state cut at 6,000 characters never hides what was written.
    state: JSON.stringify(state == null ? null : { outcome_counted_by_code: outcomeOf(state), ...(state as object) }).slice(0, 6000),
    must: JSON.stringify(item.must), must_not: JSON.stringify(item.must_not || []), state_expectation: item.state || "(none)",
  };
  return JUDGE_PROMPT.replace(/\{(\w+)\}/g, (_, k) => fill[k] ?? "");
}

export function parseJudge(text: string): { pass: boolean; failed: string[]; score: number; note: string } {
  const m = /\{[\s\S]*\}/.exec(text || "");
  if (!m) throw new Error("judge returned no JSON");
  const j = JSON.parse(m[0]);
  if (typeof j.pass !== "boolean") throw new Error("judge JSON has no boolean pass");
  return { pass: j.pass, failed: Array.isArray(j.failed) ? j.failed.map(String) : [], score: Math.max(1, Math.min(5, Number(j.score) || 1)), note: String(j.note || "") };
}

// The brains, as agent-chat runs them, over in-memory stores for one synthetic person (see harness.ts for what is and is
// not production parity).
const arr = (x: unknown): any[] => Array.isArray(x) ? x : [];
// D-038 measurement: wall time of every brain turn (the agent loop: model calls and tools), for p50/p95 latency per turn.
export const BRAIN_TURN_MS: number[] = [];
export async function makeBrain(o: { name: BrainName; model: ModelFn | null; env: { get(k: string): string | undefined } }) {
  const { handleInbound, memoryStore } = await import("../../supabase/functions/_shared/conversation.ts");
  const core = await import("../../supabase/functions/_shared/router_core.career.js");
  const { CareerHost } = await import("../../supabase/functions/_shared/career_host.js");
  const { agentTurn } = await import("../../supabase/functions/agent-chat/career_brain.ts");
  const { stagedDecision, STAGED_TOOL_POLICY } = await import("../../supabase/functions/agent-chat/career_staged.ts");
  const { memoryAlertStore } = await import("../../supabase/functions/_shared/career_alert_store.ts");
  const { situationFrom } = await import("../../supabase/functions/_shared/career_situation.ts");
  const { memoryBriefStores } = await import("../../supabase/functions/_shared/career_brief_store.ts");
  const { memoryStandingStore } = await import("../../supabase/functions/_shared/agent/memory.ts");
  const { memoryWantStore } = await import("../../supabase/functions/_shared/career_apply_want.ts");
  const { memoryOutreachStore } = await import("../../supabase/functions/_shared/career_outreach.ts");
  const { memoryPostingsDb, searchWords } = await import("../../supabase/functions/_shared/career_ingest.ts");
  const host = CareerHost.createCareerHost({ CareerAccess: core.CareerAccess, CareerOnboarding: core.CareerOnboarding, CareerRouter: core.CareerRouter, CareerDoorstep: core.CareerDoorstep, CareerReply: core.CareerReply, CareerContainment: core.CareerContainment });
  const usesModel = o.name === "agent" || o.name === "staged";
  if (usesModel && !o.model) throw new Error(`the ${o.name} brain needs a model`);
  const T0 = Date.UTC(2026, 9, 19, 15);
  return async (turns: string[], item?: Pick<EvalItem, "world">): Promise<{ replies: string[]; state: unknown; trace?: Trace }> => {
    const store = memoryStore();
    const alerts = memoryAlertStore();
    const { interviews } = memoryBriefStores();
    const memory = memoryStandingStore();
    const wants = memoryWantStore();
    const outreach = memoryOutreachStore();
    const board = memoryPostingsDb();
    const seeded = arr(item?.world?.postings).map((p: any, i: number) => ({
      provider: "eval", board: "eval", job_id: String(p.job_id ?? `EVAL-${i + 1}`), company: String(p.company ?? ""), title: String(p.title ?? ""),
      location: String(p.location ?? ""), url: String(p.url ?? ""), description: String(p.description ?? ""), pay: p.pay ?? null,
      first_seen_at: new Date(T0 - 3600000 * (i + 1)).toISOString(), last_seen_at: new Date(T0).toISOString(), closed_at: null, ...(p.extra ?? {}),
    }));
    await board.putMany(seeded as any);
    let now = T0;
    const replies: string[] = [], trace: Trace = [];
    const turnFn = async (a: any) => {
      const ctx: any = host.createTurnCtx({ userId: a.userId, threadId: a.userId, now, snapshot: a.stores.snapshot ?? null });
      let reply: string;
      const stagedPick = o.name === "staged"
        ? stagedDecision({ env: { get: (k: string) => k === "CAREER_BRAIN" ? "staged" : o.env.get(k) }, message: a.message, ctx, host, structured: false })
        : null;
      if (o.name === "agent" || stagedPick?.brain) {
        const row = await alerts.get(a.userId);
        const today = new Date(now - 86400000).toISOString();
        const upcoming = (await interviews.list(a.userId))
          .map((r) => ({ id: r.key, company: r.company, role: r.role, starts_at: r.starts_at, interview_date: r.date }))
          .filter((r) => (r.starts_at != null && r.starts_at >= today) || (r.interview_date != null && r.interview_date >= today.slice(0, 10)));
        const situation = situationFrom({ jobs: [], wanted: [], prepared: [], card: null, questions: [], outreach: [], mail_drafts: [], interviews: upcoming,
          alerts: row ? { prefs: row.prefs, tz: row.tz } : null, standing: await memory.standing(a.userId),
          threads: [{ thread_id: a.userId, rows: a.stores?.snapshot?.stores?.trackStore?.rows ?? null }],
          connections: [], cloud: null, channel: null, last_search: null, unreadable: [] } as any, now);
        const errors: string[] = [];
        const model = async (p: any) => { try { return await o.model!(p); } catch (e) { errors.push(String((e as any)?.summary?.() ?? e).slice(0, 300)); throw e; } };
        const t0 = performance.now();
        const t = await agentTurn({ message: a.message, history: a.history, stores: ctx, userId: a.userId, threadId: a.userId, now, alerts, interviews, model,
          memory, wants, posting: (id: string) => board.get(id), postings: (q: string) => board.search(searchWords(q), 150),
          outreach: { store: outreach, model } as any,
          known: { standing: await memory.standing(a.userId), alerts: row ? { prefs: row.prefs, tz: row.tz } : null, pipeline: null, situation },
          ...(stagedPick ? { toolPolicy: STAGED_TOOL_POLICY } : {}) });
        BRAIN_TURN_MS.push(Math.round(performance.now() - t0));
        trace.push({ stopped: String(t.stopped), steps: Number(t.steps ?? 0), tools: (t.tool_calls ?? []).map((c: any) => ({ name: c.name, ok: !!c.ok, ...(c.error ? { error: String(c.error).slice(0, 200) } : {}) })), ...(errors.length ? { errors } : {}),
          ...(stagedPick ? { route: "brain", intent: stagedPick.intent } : {}) });
        if (t.stopped === "model_error" && stagedPick && !(t.tool_calls ?? []).some((c: any) => c.ok && c.effect === "write_own")) {
          reply = host.runTurn(a.message, ctx).reply;
          trace[trace.length - 1].route = "router_fallback";
        } else if (t.stopped === "model_error") throw new Error("agent model unavailable");
        else reply = t.reply;
      } else {
        reply = host.runTurn(a.message, ctx).reply;
        if (stagedPick) trace.push({ stopped: "router", steps: 0, tools: [], route: "router", intent: stagedPick.intent, reason: stagedPick.reason });
      }
      return { reply, stores: { snapshot: host.extractSnapshot(ctx) } };
    };
    for (const text of turns) {
      const out = await handleInbound({ contact: "+15550001000", text, at: now }, { brain: turnFn, store });
      replies.push(out.bubbles.join("\n"));
      now += 60000;
    }
    const p = await store.userFor("+15550001000");
    const snap: any = p ? (await store.stores(p.id)).snapshot : null;
    const uid = p?.id ?? null;
    const account = uid ? {
      standing: await memory.standing(uid), alerts: await alerts.get(uid), interviews: await interviews.list(uid),
      queue: await wants.list(uid), outreach: { drafts: outreach.dump().drafts.filter((d) => d.user_id === uid) },
    } : null;
    return { replies, state: { stores: snap ? snap.stores : null, account }, ...(usesModel ? { trace } : {}) };
  };
}

// ---------------------------------------------------------------------------------------------------- CLI
// Sets: dev (evals/career/heldout-live.json, the 38 the builder has seen: a development set from 2026-10-26, never the
// bar), official (messages.json), and heldout (or sealed): the sealed held-out set, the bar, decrypted by
// CI into a temporary file named by EVAL_SEALED_PATH (evals/career/sealed/seal.ts). A sealed run's result file keeps only
// ids, categories and verdicts: no turns, replies, state, rubric text or judge notes, so builders cannot read the items
// back out of the results.
export function redactSealed(r: EvalResult): EvalResult {
  return { ...r, items: r.items.map((x) => ({ id: x.id, ...(x.category ? { category: x.category } : {}), pass: x.pass, failed: [], score: x.score, replies: [],
    note: /^(brain|judge) error/.test(x.note) ? x.note.split(":")[0] : "", state_check: x.state_check ? { ok: x.state_check.ok, failed: [] } : undefined,
    ...(x.judges ? { judges: x.judges.map((j) => ({ model: j.model, pass: j.pass, failed: [], note: /^judge error/.test(j.note) ? "judge error" : "" })) } : {}),
    ...(x.trace ? { trace: x.trace.map((t) => ({ stopped: t.stopped, steps: t.steps, tools: t.tools.map((c) => ({ name: c.name, ok: c.ok })), ...(t.route ? { route: t.route } : {}) })) } : {}) })) };
}

if (import.meta.main) {
  const args = Deno.args, opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
  const brainName = opt("--brain") || "router", label = opt("--label") || `${brainName}-${new Date().toISOString().slice(0, 10)}`;
  if (!["router", "agent", "staged"].includes(brainName)) { console.log(`NOT RUN: --brain must be router, agent or staged (got ${brainName}).`); Deno.exit(2); }
  const usesModel = brainName === "agent" || brainName === "staged";
  if (!Deno.env.get("OPENAI_API_KEY")) { console.log("NOT RUN: no OPENAI_API_KEY (the judge needs it)."); Deno.exit(2); }
  const { callModel, modelConfig, newMeter, PRICES } = await import("../../supabase/functions/_shared/model_gateway.ts");
  const meter = newMeter(), judgeMeter = newMeter();
  // D-038: the measured commit's committed reply model (agent-chat/release_model.ts) or the request's model; a commit from
  // before D-038 has no release_model.ts and is measured as it served, on CAREER_MODEL or gpt-5-mini.
  const rm: any = await import("../../supabase/functions/agent-chat/release_model.ts").catch(() => null);
  const brainCfg = rm ? rm.careerModelConfig(Deno.env) : { ...modelConfig(Deno.env, "chat"), model: Deno.env.get("CAREER_MODEL") || "gpt-5-mini" };
  const committedModel: string = rm ? rm.CAREER_MODEL_DEFAULT : "gpt-5-mini";
  // A comparison run (a model other than the committed one) is logged under its own brain name, so S3 never reads it as
  // the served brain's score.
  const brainLabel = usesModel && brainCfg.model !== committedModel ? `${brainName}:${brainCfg.model}` : brainName;
  const judgeCfg = { ...modelConfig(Deno.env, "chat"), model: Deno.env.get("EVAL_JUDGE_MODEL") || "gpt-5-mini" };
  const judge2Model = Deno.env.get("EVAL_JUDGE_MODEL_2") || null;
  const judge2Cfg = judge2Model ? { ...modelConfig(Deno.env, "chat"), model: judge2Model } : null;
  const brain: Brain = await makeBrain({ name: brainName as any, env: Deno.env, model: usesModel ? (p: any) => callModel(brainCfg, p, { meter, role: "chat" }) : null });
  const oneJudge = async (cfg: any, item: EvalItem, reply: string, state: unknown) => {
    const res = await callModel(cfg, { system: "You are a strict grader. Output JSON only.", messages: [{ role: "user", content: judgePrompt(item, reply, state) }], max_tokens: 400 }, { meter: judgeMeter, role: "chat" });
    return parseJudge((res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(""));
  };
  // A judge call that fails is retried once (a transient provider error is not a verdict); a second failure is a judge
  // error, which fails the item and makes the pass NOT A SCORE.
  const settle = async (cfg: any, item: EvalItem, reply: string, state: unknown) => {
    let last: unknown = null;
    for (let k = 0; k < 2; k++) { try { return await oneJudge(cfg, item, reply, state); } catch (e) { last = e; } }
    return { pass: false, failed: item.must, score: 1, note: `judge error: ${last instanceof Error ? last.message : String(last)}` };
  };
  const judge: Judge = async (item, reply, state) => {
    if (!judge2Cfg) return settle(judgeCfg, item, reply, state);
    const [a, b] = await Promise.all([settle(judgeCfg, item, reply, state), settle(judge2Cfg, item, reply, state)]);
    return bothJudges([{ model: judgeCfg.model, v: a }, { model: judge2Cfg.model, v: b }]);
  };
  const setName = opt("--set") || "official";
  let setPath: string | URL;
  // "heldout" is the sealed held-out set (the bar) from 2026-10-26; the 38 it used to name are the dev set.
  if (setName === "sealed" || setName === "heldout") {
    const p = Deno.env.get("EVAL_SEALED_PATH");
    if (!p) { console.log("NOT RUN: --set sealed needs EVAL_SEALED_PATH (the file CI decrypted with evals/career/sealed/seal.ts open)."); Deno.exit(2); }
    setPath = p;
  } else if (setName === "dev") setPath = new URL("./heldout-live.json", import.meta.url);
  else if (setName === "official") setPath = new URL("./messages.json", import.meta.url);
  // D-038: a fresh, unsealed held-out set written by another agent; its results are redacted like the sealed set's.
  else if (setName === "fresh") setPath = new URL("./fresh-heldout.json", import.meta.url);
  else { console.log(`NOT RUN: --set must be dev, heldout, official or sealed (got ${setName}).`); Deno.exit(2); }
  const set = JSON.parse(await Deno.readTextFile(setPath));
  const only = opt("--only");
  if (only && (setName === "sealed" || setName === "heldout")) { console.log("NOT RUN: --only is refused on the sealed set (a sealed run scores every item)."); Deno.exit(2); }
  const items: EvalItem[] = set.items.filter((i: EvalItem) => !only || only.split(",").includes(i.id));
  const budgetArg = opt("--budget-usd") ?? Deno.env.get("EVAL_BUDGET_USD") ?? null;
  const budget = budgetArg === null ? null : Number(budgetArg);
  if (budget !== null && (!(budget > 0) || !PRICES[judgeCfg.model] || (judge2Cfg && !PRICES[judge2Cfg.model]) || (usesModel && !PRICES[brainCfg.model]))) {
    console.log(`NOT RUN: a budget needs a positive number and a priced model (judge ${judgeCfg.model}, brain ${brainCfg.model}); an unpriced call cannot be capped.`);
    Deno.exit(2);
  }
  const prior: any[] = [];
  try {
    for await (const e of Deno.readDir(new URL("./results/", import.meta.url))) {
      if (e.name.endsWith(".json")) prior.push(JSON.parse(await Deno.readTextFile(new URL(`./results/${e.name}`, import.meta.url))));
    }
  } catch { /* no results yet */ }
  const ledger: Ledger = JSON.parse(await Deno.readTextFile(new URL("./spend-ledger.json", import.meta.url)));
  const before = spentUsd(prior, label, ledger);
  const now$ = () => before + (meter.usd_micros + judgeMeter.usd_micros) / 1e6;
  if (budget !== null) console.log(`budget $${budget.toFixed(2)} · already spent $${before.toFixed(3)} (ledger baseline $${ledger.baseline_usd.toFixed(3)} + ${prior.length} result files)`);
  // D-038 (owner, 2026-11-01: "$25" on the Anthropic key for these tests, apart from the OpenAI eval budget).
  const asked = (Deno.env.get("CAREER_REPLY_MODEL") ?? "").trim();
  if (usesModel && asked && brainCfg.model !== asked) { console.log(`NOT RUN: CAREER_REPLY_MODEL=${asked} was refused (not on the rollback list, or its provider has no key); the default would be measured instead.`); Deno.exit(2); }
  const anthropicBrain = usesModel && brainCfg.provider === "anthropic";
  const aBudget = anthropicBrain ? Number(Deno.env.get("ANTHROPIC_EVAL_BUDGET_USD") ?? NaN) : null;
  if (anthropicBrain && !(aBudget! > 0)) { console.log("NOT RUN: a claude- brain needs ANTHROPIC_EVAL_BUDGET_USD (the Anthropic spend cap)."); Deno.exit(2); }
  const aBefore = prior.filter((x) => x.label !== label && /^claude-/i.test(String(x.model ?? ""))).reduce((a, x) => a + (Number(x.cost_usd?.brain) || 0), 0);
  if (anthropicBrain) console.log(`anthropic budget $${aBudget!.toFixed(2)} · already spent $${aBefore.toFixed(3)}`);
  const evalStop = budgetStop(budget, now$), aStop = budgetStop(aBudget, () => aBefore + meter.usd_micros / 1e6, 0.05);
  const raw = await runEval(items, brain, judge, () => evalStop() ?? (anthropicBrain ? aStop() : null));
  const sealedSet = setName === "sealed" || setName === "heldout" || setName === "fresh";
  const r = sealedSet ? redactSealed(raw) : raw;
  let source = "unknown";
  try { const o = await new Deno.Command("git", { args: ["rev-parse", "--short", "HEAD^2"] }).output(); if (o.success) source = new TextDecoder().decode(o.stdout).trim(); } catch { /* no second parent */ }
  let commit = "unknown";
  try { commit = new TextDecoder().decode((await new Deno.Command("git", { args: ["rev-parse", "--short", "HEAD"] }).output()).stdout).trim(); } catch { /* not a git checkout */ }
  const result = { label, harness: HARNESS, set: setName === "fresh" ? "fresh" : sealedSet ? "sealed" : setName, ...(set.sha256 ? { set_sha256: set.sha256 } : {}), brain: brainLabel, model: usesModel ? brainCfg.model : null, judge_model: judgeCfg.model, judge_model_2: judge2Cfg?.model ?? null, commit, source_commit: source === "unknown" ? commit : source, run_at: new Date().toISOString(),
    cost_usd: { brain: meter.usd_micros / 1e6, judge: judgeMeter.usd_micros / 1e6 }, unpriced_calls: meter.unpriced + judgeMeter.unpriced,
    budget_usd: budget, spent_before_usd: before, brain_turn_ms: BRAIN_TURN_MS, brain_calls: meter.calls, brain_failed_calls: meter.failed,
    ...(anthropicBrain ? { anthropic_budget_usd: aBudget, anthropic_spent_before_usd: aBefore } : {}), ...r };
  await Deno.mkdir(new URL("./results/", import.meta.url), { recursive: true });
  await Deno.writeTextFile(new URL(`./results/${label}.json`, import.meta.url), JSON.stringify(result, null, 1));
  console.log(`${label}: ${r.passed}/${r.total} passed (${Math.round(r.pass_rate * 100)}%) · brain ${brainName} · judges ${judgeCfg.model}${judge2Cfg ? ` + ${judge2Cfg.model}` : ""} · cost $${(result.cost_usd.brain + result.cost_usd.judge).toFixed(3)}`);
  console.log(`failing: ${r.items.filter((x) => !x.pass).map((x) => x.id).join(", ") || "none"}`);
  if (r.stopped) { console.log(`STOPPED after ${r.total} of ${r.planned} items (${r.stopped}): not a score.`); Deno.exit(3); }
}
