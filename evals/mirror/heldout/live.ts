// MIRROR HELD-OUT (P2), the live scorer hook (architect builder, 2026-11-11). For later use; it has not been run. It sends a
// seeded sample of N held-out conversations through the same real handler with the REAL model, under production's release
// flags (harness.ts, P4: no test-only switch), and scores every turn on code's decisions AND the text (score.ts, mode live).
// A held-out run measures; it never tunes (P2). Only the model host and the database double are reachable: nothing can be
// submitted or sent, and every other request is refused and recorded.
//
//   MIRROR_SPEND_APPROVED=D-0xx ANTHROPIC_API_KEY=... CI=true deno run -A --no-check --import-map=tests/flow/supabase-npm.json \
//     evals/mirror/heldout/live.ts --sample 20 --budget-usd 3 [--seed 7] [--label name] [--split heldout|dev]
//
// Refuses to start without MIRROR_SPEND_APPROVED (the DECISIONS.md line of the owner's written spend approval; D-060 is $10
// for this effort), ANTHROPIC_API_KEY and --budget-usd, and when the preflight quote (turns x PER_TURN_USD per
// turn, setup turns included) is over the cap. D-065: the per-turn estimate is the live round's measured rate, about $0.10 a brain
// turn (live-5: $1.8375 over 18 metered turns, C1 alone $0.37 with its web searches), not D-055's $0.0108, so a cap is real. Stops at the cap, metered at the D-038 claude-sonnet-5-5 prices.
// --plan prints the sample and the quote and exits, with no key, no spend and no database.
import { DEV_PATH, HELDOUT_PATH, loadSplit } from "./generate.ts";
import { runConversations } from "./harness.ts";
import { printSummary, scoreTurn, summarize } from "./score.ts";

export const PER_TURN_USD = 0.10; // D-065: live-5 measured $1.8375 / 18 brain turns = $0.102 (evals/mirror/instinct-wa-batch1/results/live-5/)
const a = Deno.args, opt = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const n = Number(opt("--sample") ?? 0), budget = Number(opt("--budget-usd") ?? 0), seed = Number(opt("--seed") ?? 7), label = opt("--label") ?? `live-${new Date().toISOString().slice(0, 10)}`;
const split = opt("--split") ?? "heldout", plan = a.includes("--plan");
if (!(n > 0)) { console.log("usage: live.ts --sample N --budget-usd <cap> [--seed S] [--label name] [--split heldout|dev] [--plan]"); Deno.exit(2); }

// The sample: a seeded draw spread over the families (round robin over the families, seeded order inside each).
export function sample<T extends { family: string; id: string }>(xs: T[], k: number, s: number): T[] {
  let x = s >>> 0 || 1;
  const rnd = () => ((x = (Math.imul(x ^ (x >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296);
  const fams = [...new Set(xs.map((c) => c.family))].sort();
  const queues = fams.map((f) => xs.filter((c) => c.family === f).map((c) => [rnd(), c] as const).sort((p, q) => p[0] - q[0]).map(([, c]) => c));
  const out: T[] = [];
  for (let i = 0; out.length < Math.min(k, xs.length); i++) { const q = queues[i % queues.length]; if (q.length) out.push(q.shift()!); }
  return out;
}

const convs = sample(await loadSplit(split === "dev" ? DEV_PATH : HELDOUT_PATH), n, seed);
const turns = convs.reduce((s, c) => s + c.turns.length + c.setup.turns.length, 0), quote = turns * PER_TURN_USD;
console.log(`plan: ${convs.length} ${split} conversations (${convs.map((c) => c.id).join(" ")}), ${turns} turns with setup; quote $${quote.toFixed(2)} at $${PER_TURN_USD}/turn; cap $${budget}`);
if (plan) Deno.exit(0);
if (!/^D-\d{3}[a-z]?$/.test(Deno.env.get("MIRROR_SPEND_APPROVED") ?? "")) { console.log("refused: needs MIRROR_SPEND_APPROVED=<the DECISIONS.md line of the owner's written spend approval>"); Deno.exit(3); }
const key = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
if (!key) { console.log("refused: needs ANTHROPIC_API_KEY"); Deno.exit(3); }
if (!(budget > 0)) { console.log("refused: needs --budget-usd <cap>"); Deno.exit(3); }
if (quote > budget) { console.log(`refused: the quote $${quote.toFixed(2)} is over the cap $${budget}; sample fewer conversations`); Deno.exit(3); }

const byId = new Map(convs.flatMap((c) => c.turns.map((t) => [t.id, t] as const)));
const { records, spent, outbound, stopped } = await runConversations(convs, { mode: "live", budgetUsd: budget, liveKey: key });
const scores = records.map((r) => scoreTurn(byId.get(r.id)!.expect, r, "live"));
const RESULTS = new URL("./results/", import.meta.url).pathname;
await Deno.mkdir(RESULTS, { recursive: true });
// Replies are the model's words about fictional people; the transcript stays local until read (like evals/mirror/results).
await Deno.writeTextFile(`${RESULTS}${label}.jsonl`, records.map((r, i) => JSON.stringify({ ...r, rulings: scores[i].rulings, why: scores[i].why })).join("\n") + "\n");
const s = summarize(`${split} live sample`, convs, scores);
await Deno.writeTextFile(`${RESULTS}${label}-summary.json`, JSON.stringify({ seed, sample: convs.map((c) => c.id), spent_usd: Number(spent.toFixed(4)), outbound, stopped, summary: s }, null, 1) + "\n");
console.log(printSummary(s));
console.log(`MIRROR-HELDOUT live turns=${records.length} spent_usd=${spent.toFixed(4)} external_requests=${outbound.filter((h) => !h.includes("anthropic")).length}${stopped ? ` (stopped: ${stopped})` : ""}`);
