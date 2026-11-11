// MIRROR HELD-OUT (P2), the $0 scorer through the real handler with a scripted model (architect builder, 2026-11-11).
// Like tests/architect/mirror-wa-batch1-handler.test.ts, but over the generated conversations: every turn of every
// conversation, in order, on one fresh person each, production's release flags (harness.ts, P4), no request off the machine
// (asserted). It scores what CODE decides per turn (score.ts) and prints the per-ruling pass rates for each split.
//
//   CI=true deno run -A --no-check --import-map=tests/flow/supabase-npm.json evals/mirror/heldout/run.ts [--split dev|heldout|both] [--limit N] [--label name]
//
// Writes results/dry-<label>-<split>.jsonl (one compact line per turn: route, intent, tools, rows, verdicts) and
// results/dry-<label>-summary.json. Postgres 16 on PATH or PGBIN; as root, CI=true. The held-out file must match its seal.
import { DEV_PATH, HELDOUT_PATH, loadSplit } from "./generate.ts";
import { runConversations } from "./harness.ts";
import { printSummary, scoreTurn, summarize, type Summary } from "./score.ts";

const a = Deno.args, opt = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const which = opt("--split") ?? "both", limit = Number(opt("--limit") ?? 0), label = opt("--label") ?? "baseline";
const splits = which === "both" ? ["dev", "heldout"] : [which];
const RESULTS = new URL("./results/", import.meta.url).pathname;
await Deno.mkdir(RESULTS, { recursive: true });
const summaries: Record<string, Summary> = {};
const t0 = performance.now();
for (const split of splits) {
  let convs = await loadSplit(split === "dev" ? DEV_PATH : HELDOUT_PATH);
  if (limit > 0) convs = convs.slice(0, limit);
  const byId = new Map(convs.flatMap((c) => c.turns.map((t) => [t.id, t] as const)));
  const t1 = performance.now();
  const { records, outbound } = await runConversations(convs, { mode: "dry" });
  const scores = records.map((r) => scoreTurn(byId.get(r.id)!.expect, r, "dry"));
  const lines = records.map((r, i) => JSON.stringify({
    id: r.id, route: r.route, intent: r.intent, router_intent: r.router_intent, called: r.called, effects: r.effects, cards: r.cards, artifact: r.artifact,
    markers_hit: r.markers_hit, reply_head: r.reply.slice(0, 140), rulings: scores[i].rulings, why: scores[i].why,
  }));
  await Deno.writeTextFile(`${RESULTS}dry-${label}-${split}.jsonl`, lines.join("\n") + "\n");
  summaries[split] = summarize(split, convs, scores);
  console.log(printSummary(summaries[split]));
  console.log(`  ${records.length} turns in ${((performance.now() - t1) / 1000).toFixed(0)} s, external requests ${outbound.length}`);
  if (outbound.length) { console.log("a request left the machine in a dry run:", outbound.slice(0, 5)); Deno.exit(1); }
}
await Deno.writeTextFile(`${RESULTS}dry-${label}-summary.json`, JSON.stringify(summaries, null, 1) + "\n");
console.log(`MIRROR-HELDOUT dry ${splits.join("+")} in ${((performance.now() - t0) / 1000).toFixed(0)} s, $0`);
