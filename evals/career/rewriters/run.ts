// D-037 condition 3 (owner, 2026-11-01 20:04 CT: "turn these on: … Reply rewriters"): each reply rewriter goes into the
// release config only after it is measured: the career eval with the rewriter on against the same run with it off, and it
// goes ON only if its pass rate is no worse AND it adds no invented-fact failure (D-007).
//
//   deno run -A --import-map=tests/flow/supabase-npm.json evals/career/rewriters/run.ts \
//     --rewriter CAREER_REPLY_WRITER|CAREER_KNOWLEDGE|CAREER_JUDGE|all --set heldout --budget-usd 5 --label <label>
//
// Why not evals/career/run.ts itself: that harness (deploy standard S3's, on ci/brain-eval) drives the router and the
// brain directly, and none of the three rewriters lives there: the reply writer runs at the handler's final-reply boundary,
// the search judge after the router's search, and the knowledge library is passed to the brain by the handler. So this
// runner sends each item's turns through the REAL agent-chat handler (tests/flow/handler.ts, real Postgres with every
// migration, as the task eval and the Telegram acceptance suite do) on the release config, and grades the last reply with
// S3's own judge: the same prompt (JUDGE_PROMPT/judgePrompt), the same parse, the same two judges (EVAL_JUDGE_MODEL,
// default gpt-5-mini, and EVAL_JUDGE_MODEL_2 when set), both must pass (bothJudges).
//
// Spend: OpenAI only (the brain, the rewriter and the judges), never another provider. --budget-usd (default 5) is the
// total for the whole run: the handler's own spend (agent_turn_costs) plus the judges' metered spend; the run stops before
// the next item once spend plus a reserve reaches it, and a stopped comparison is not a verdict. Needs OPENAI_API_KEY;
// without it: NOT RUN, exit 2. Run as an unprivileged user (initdb refuses root).
//
// An invented-fact failure (D-007) is an item whose judges failed a must_not that forbids a claim the record does not
// carry (inventedFact below). Output: evals/career/rewriters/results/<label>.json and one line per rewriter:
//   REWRITER <name> off=<rate> on=<rate> invented_off=<n> invented_on=<n> spend=$<usd> verdict=ON|OFF (<why>)
// deno-lint-ignore-file no-explicit-any
import { bothJudges, type EvalItem, judgePrompt, parseJudge, type Verdict } from "../run.ts";

export const REWRITERS = ["CAREER_REPLY_WRITER", "CAREER_KNOWLEDGE", "CAREER_JUDGE"] as const;
export type Rewriter = typeof REWRITERS[number];

// A must_not that forbids saying something the person's record or the turn does not support.
const INVENTION = /\b(?:claim|claims|invent|invents|invented|made[- ]up|fabricat|guess|guesses|hallucinat|not (?:on|in) (?:the |their |your )?(?:record|resume|file|profile)|unconfirmed|a fact)\b/i;
export function inventedFact(item: EvalItem, failed: string[]): boolean {
  const forbidden = new Set(item.must_not ?? []);
  return failed.some((f) => forbidden.has(f) && INVENTION.test(f));
}

export interface Side { rate: number; passed: number; total: number; invented: number; failed_ids: string[]; invented_ids: string[] }
export interface Verdict3 { rewriter: Rewriter; off: Side; on: Side; on_release: boolean; why: string }

// The rule (D-037 condition 3), exact: no tolerance. A comparison that did not run every item on both sides is no verdict.
export function verdict(rewriter: Rewriter, off: Side, on: Side, complete: boolean): Verdict3 {
  if (!complete || off.total === 0 || off.total !== on.total) return { rewriter, off, on, on_release: false, why: "not measured: the run did not complete both sides on the same items" };
  if (on.passed < off.passed) return { rewriter, off, on, on_release: false, why: `pass rate fell: ${on.passed}/${on.total} on < ${off.passed}/${off.total} off` };
  if (on.invented > off.invented) return { rewriter, off, on, on_release: false, why: `added invented-fact failures: ${on.invented} on > ${off.invented} off (${on.invented_ids.filter((x) => !off.invented_ids.includes(x)).join(", ")})` };
  return { rewriter, off, on, on_release: true, why: `pass rate ${on.passed}/${on.total} >= ${off.passed}/${off.total}, invented-fact failures ${on.invented} <= ${off.invented}` };
}

export function side(items: EvalItem[], results: { id: string; pass: boolean; failed: string[] }[]): Side {
  const by = new Map(results.map((r) => [r.id, r]));
  const done = items.filter((i) => by.has(i.id));
  const passed = done.filter((i) => by.get(i.id)!.pass).length;
  const inv = done.filter((i) => inventedFact(i, by.get(i.id)!.failed)).map((i) => i.id);
  return { rate: done.length ? passed / done.length : 0, passed, total: done.length, invented: inv.length, failed_ids: done.filter((i) => !by.get(i.id)!.pass).map((i) => i.id), invented_ids: inv };
}

if (import.meta.main) {
  const args = Deno.args, opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
  const which = opt("--rewriter") ?? "all";
  const rewriters: Rewriter[] = which === "all" ? [...REWRITERS] : (REWRITERS as readonly string[]).includes(which) ? [which as Rewriter] : [];
  if (!rewriters.length) { console.log(`NOT RUN: --rewriter must be one of ${REWRITERS.join(", ")} or all`); Deno.exit(2); }
  if (!Deno.env.get("OPENAI_API_KEY")) { console.log("NOT RUN: no OPENAI_API_KEY (OpenAI only; the brain, the rewriter and the judges need it)."); Deno.exit(2); }
  const budget = Number(opt("--budget-usd") ?? "5");
  const setName = opt("--set") ?? "heldout";
  const label = opt("--label") ?? `rewriters-${new Date().toISOString().slice(0, 10)}`;
  const ROOT = new URL("../../../", import.meta.url).pathname;
  const file = setName === "heldout" ? "heldout-live.json" : "messages.json";
  const items: EvalItem[] = JSON.parse(await Deno.readTextFile(`${ROOT}evals/career/${file}`)).items;
  const { startPg } = await import("../../../tests/flow/pg.ts");
  const { careerHandler, supabaseParity } = await import("../../../tests/flow/handler.ts");
  const { callModel, modelConfig, newMeter, PRICES } = await import("../../../supabase/functions/_shared/model_gateway.ts");
  const judgeMeter = newMeter();
  const judgeCfg = { ...modelConfig(Deno.env, "chat"), model: Deno.env.get("EVAL_JUDGE_MODEL") || "gpt-5-mini" };
  const judge2 = Deno.env.get("EVAL_JUDGE_MODEL_2");
  const judge2Cfg = judge2 ? { ...modelConfig(Deno.env, "chat"), model: judge2 } : null;
  const oneJudge = async (cfg: any, item: EvalItem, reply: string): Promise<Verdict> => {
    try {
      const res = await callModel(cfg, { system: "You are a strict grader. Output JSON only.", messages: [{ role: "user", content: judgePrompt(item, reply, null) }], max_tokens: 400 }, { meter: judgeMeter, role: "chat" });
      return parseJudge((res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(""));
    } catch (e) { return { pass: false, failed: item.must, score: 1, note: `judge error: ${e instanceof Error ? e.message : String(e)}` }; }
  };
  const judgeSpend = () => judgeMeter.usd_micros / 1e6;
  // A judge model with no price would make the cap blind: refuse the run, as evals/career/run.ts does.
  if (!(budget > 0) || !PRICES[judgeCfg.model] || (judge2Cfg && !PRICES[judge2Cfg.model])) { console.log("NOT RUN: --budget-usd must be > 0 and every judge model must be priced (PRICES)."); Deno.exit(2); }
  const pg = await startPg();
  const realFetch = globalThis.fetch;
  const verdicts: Verdict3[] = [];
  let stopped: string | null = null;
  try {
    await supabaseParity(pg);
    const people: Record<string, string> = {};
    let n = 0;
    const plan: { rewriter: Rewriter; on: boolean; item: EvalItem; token: string }[] = [];
    for (const r of rewriters) for (const on of [false, true]) for (const item of items) {
      const token = `tok-${r}-${on ? "on" : "off"}-${item.id}`, id = `7b0f8f8e-6a43-4a49-9d2c-${String(8_000_000_000_000 + ++n).slice(-12)}`;
      people[token] = id; plan.push({ rewriter: r, on, item, token });
    }
    for (const id of Object.values(people)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    const h = await careerHandler(pg, people);
    const viaDouble = globalThis.fetch;
    // The outside world: OpenAI (the only paid host) and the Supabase double; nothing else is reachable.
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      if (new URL(req.url).hostname === "api.openai.com") return await realFetch(req);
      return await viaDouble(req);
    }) as typeof fetch;
    const handlerSpend = async () => Number((await pg.sql("select coalesce(sum(usd_micros), 0) from public.agent_turn_costs")).trim()) / 1e6;
    const spent = async () => await handlerSpend() + judgeSpend();
    const results = new Map<string, { id: string; pass: boolean; failed: string[] }[]>();
    for (const p of plan) {
      if (await spent() + 0.25 >= budget) { stopped = `budget: $${(await spent()).toFixed(3)} of $${budget}`; break; }
      // Each rewriter is measured alone on the release config: it on (or rolled back), the other two off.
      for (const r of REWRITERS) Deno.env.set(r, r === p.rewriter && p.on ? "on" : "off");
      const chat = h.chat(p.token);
      let last = "";
      for (const t of p.item.turns) last = (await chat.say(t)).reply;
      const a = await oneJudge(judgeCfg, p.item, last);
      const v = judge2Cfg ? bothJudges([{ model: judgeCfg.model, v: a }, { model: judge2Cfg.model, v: await oneJudge(judge2Cfg, p.item, last) }]) : a;
      const key = `${p.rewriter}:${p.on}`;
      results.set(key, [...(results.get(key) ?? []), { id: p.item.id, pass: !!v.pass, failed: v.failed ?? [] }]);
    }
    for (const r of rewriters) {
      const off = side(items, results.get(`${r}:false`) ?? []), on = side(items, results.get(`${r}:true`) ?? []);
      const v = verdict(r, off, on, !stopped && off.total === items.length && on.total === items.length);
      verdicts.push(v);
    }
    const usd = await spent();
    for (const v of verdicts) console.log(`REWRITER ${v.rewriter} off=${(v.off.rate * 100).toFixed(1)}% on=${(v.on.rate * 100).toFixed(1)}% invented_off=${v.off.invented} invented_on=${v.on.invented} spend=$${usd.toFixed(3)} verdict=${v.on_release ? "ON" : "OFF"} (${v.why})`);
    if (stopped) console.log(`STOPPED: ${stopped} (not a verdict)`);
    await Deno.mkdir(`${ROOT}evals/career/rewriters/results`, { recursive: true });
    await Deno.writeTextFile(`${ROOT}evals/career/rewriters/results/${label}.json`, JSON.stringify({ label, set: setName, budget_usd: budget, spend_usd: usd, stopped, judges: [judgeCfg.model, judge2Cfg?.model ?? null], verdicts, run_at: new Date().toISOString() }, null, 2));
    h.restore();
  } finally {
    globalThis.fetch = realFetch;
    for (const r of REWRITERS) Deno.env.delete(r);
    await pg.stop();
  }
}
