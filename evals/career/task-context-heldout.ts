// Held-out task-and-context eval (independent judge). Same rubric, checker and scoring as task-context-brutal.ts; different people, different
// scenarios. Fixture: task-context-heldout.json. Reference set proving every check is satisfiable: task-context-heldout.reference.json.
//
//   deno run -A evals/career/task-context-heldout.ts --brain router [--label L] [--only H01,H02]
//   deno run -A evals/career/task-context-heldout.ts --brain agent  [--label L]      needs OPENAI_API_KEY
//   deno run -A evals/career/task-context-heldout.ts --replay evals/career/task-context-heldout.reference.json
//
// Differences from the brutal runner: (1) production dispatch also runs billingTurn first (code-first, as handler-career does), against a
// seeded subscription and a fake Stripe, so "cancel my plan" is scored on what the handler does; (2) state adds billing.cancelled,
// billing.cancel_calls, channel.opted_out and erased, which a live transcript supplies and an offline run keeps false. A claim of "cancelled",
// "opted out" or "deleted" is therefore scored against that state, never against the words.
import { DIMS, scoreAll, worldIndex, worldState, worst, type Run, type Scenario } from "./task-context-brutal.ts";

const args = Deno.args, opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null; };
const fix = JSON.parse(await Deno.readTextFile(new URL("./task-context-heldout.json", import.meta.url)));
const only = opt("--only");
const scenarios: Scenario[] = fix.scenarios.filter((s: Scenario) => !only || only.split(",").includes(s.id));
const loadWorld = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(`./${fix.worlds[name]}`, import.meta.url)));
const worlds: Record<string, { urls: string[]; text: string }> = {};
for (const n of Object.keys(fix.worlds)) worlds[n] = worldIndex(await loadWorld(n));
const replay = opt("--replay"), brainName = replay ? "replay" : opt("--brain") || "router";
const label = opt("--label") || `heldout-${brainName}-${new Date().toISOString().slice(0, 10)}`;

async function offlineBrain(kind: "router" | "agent", model?: (p: any) => Promise<any>) {
  const { openWorld, worldTurn, USER } = await import("./world.ts");
  const { standingTurn, supabaseStanding } = await import("../../supabase/functions/_shared/career_standing.ts");
  const { billingTurn } = await import("../../supabase/functions/_shared/career_billing.ts");
  return async (sc: Scenario): Promise<Run> => {
    const file = await loadWorld(sc.world);
    const w = await openWorld(file, {});
    let now = w.now;
    const meta = new Map<string, Record<string, unknown>>(), billing = { cancelled: false, cancel_calls: 0 };
    const sub = file.subscription ? { ...file.subscription } : null;
    const store = { async subscription() { return sub; }, async lastMeta(t: string) { return meta.get(t) ?? null; }, async markCancelling() { sub.cancel_at_period_end = true; } };
    const stripe = { async cancelAtPeriodEnd() { billing.cancelled = true; billing.cancel_calls++; return { cancel_at_period_end: true, current_period_end: Date.parse(sub.current_period_end) / 1000 }; }, async listInvoices() { return []; } };
    const replies: string[] = [], state: unknown[] = [];
    for (const t of sc.turns) {
      const th = t.thread ?? "A";
      const bill = await billingTurn({ message: t.user, userId: USER, threadId: th, now, store, stripe } as any).catch(() => null);
      let reply: string;
      if (bill) { reply = bill.reply; meta.set(th, { intent: bill.intent, ...(bill.meta ?? {}) }); w.th(th).intent = bill.intent; }
      else {
        const st = await standingTurn({ message: t.user, userId: USER, now, read: supabaseStanding(w.admin) }).catch(() => null);
        reply = st ? st.reply : (await worldTurn(w, { brain: kind, threadId: th, message: t.user, now, model })).reply;
        meta.set(th, { intent: null });
      }
      replies.push(reply);
      state.push({ ...(await worldState(w, USER) as object), billing: { ...billing }, channel: { opted_out: false }, erased: false });
      now += 90000;
    }
    return { id: sc.id, replies, state };
  };
}

let brain: (sc: Scenario) => Promise<Run>;
if (replay) {
  const rec = JSON.parse(await Deno.readTextFile(replay));
  brain = async (sc) => { const r = rec[sc.id]; if (!r) throw new Error("no recorded replies"); return { id: sc.id, replies: r.replies, state: sc.turns.map((_, i) => r.state?.[i] ?? null) }; };
} else if (brainName === "agent") {
  if (!Deno.env.get("OPENAI_API_KEY")) { console.log("NOT RUN: no OPENAI_API_KEY (the agent brain calls the model)."); Deno.exit(2); }
  const { callModel, modelConfig, newMeter } = await import("../../supabase/functions/_shared/model_gateway.ts");
  const meter = newMeter(), cfg = { ...modelConfig(Deno.env, "chat"), model: Deno.env.get("CAREER_MODEL") || "gpt-5-mini" };
  brain = await offlineBrain("agent", (p: any) => callModel(cfg, p, { meter, role: "chat" }));
} else if (brainName === "router") brain = await offlineBrain("router");
else { console.log(`NOT RUN: --brain must be router or agent (got ${brainName}).`); Deno.exit(2); }

const runs: Run[] = [], errors: Record<string, string> = {};
for (const sc of scenarios) { try { runs.push(await brain(sc)); } catch (e) { errors[sc.id] = e instanceof Error ? e.message : String(e); } }
const { results, score } = scoreAll(scenarios, runs, worlds);
const w10 = worst(results, 10);
let commit = "unknown";
try { commit = new TextDecoder().decode((await new Deno.Command("git", { args: ["rev-parse", "--short", "HEAD"] }).output()).stdout).trim(); } catch { /* not a checkout */ }
const out = { label, brain: brainName, commit, run_at: new Date().toISOString(), score, errors, worst: w10, unmeasured: results.filter((r) => r.ok === null).map((r) => `${r.scenario}.${r.turn} ${r.t}: ${r.why}`), runs, results };
await Deno.mkdir(new URL("./results/", import.meta.url), { recursive: true });
await Deno.writeTextFile(new URL(`./results/task-context-heldout.${label}.json`, import.meta.url), JSON.stringify(out, null, 1));
console.log(`${label} (${brainName}): scenarios clean ${score.scenarios.passed}/${score.scenarios.total}; checks ${results.filter((r) => r.ok === true).length} pass, ${results.filter((r) => r.ok === false).length} fail, ${results.filter((r) => r.ok === null).length} unmeasured`);
for (const d of DIMS) { const s = score.dims[d]; console.log(`  ${d.padEnd(10)} ${s.score === null ? "n/a" : s.score.toFixed(1)}/5  (${s.passed} pass, ${s.failed} fail${s.unmeasured ? `, ${s.unmeasured} unmeasured` : ""}${s.hard_failures ? `, ${s.hard_failures} hard` : ""})`); }
console.log(`  TASK ORIENTATION ${score.task ?? "n/a"}/5 · INDIVIDUAL CONTEXT ${score.context ?? "n/a"}/5 · overall ${score.overall ?? "n/a"}/5`);
if (Object.keys(errors).length) console.log(`errors: ${JSON.stringify(errors)}`);
console.log("\nworst:");
for (const r of w10) console.log(`  ${r.scenario}.${r.turn} [${r.d}${r.hard ? ",hard" : ""}] ${r.why}\n    U: ${r.user}\n    A: ${r.reply.replace(/\n/g, " / ").slice(0, 400)}\n    -> ${r.detail}`);
Deno.exit(DIMS.every((d) => score.dims[d].score === 5) ? 0 : 1);
