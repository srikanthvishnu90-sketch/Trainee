// Gap #5 (2026-11-16; live-12 C19) through the REAL career handler at $0 (every migration on a throwaway Postgres 16, production's
// release flags, a scripted model; tests/architect/helpers/mirror_process.ts): a people search refused twice for missing inputs is
// reported as not run, and "found no public page" never reaches the person (D-024).
//   TMPDIR=/private/tmp/claude-501/pg CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/not-run-handler-20261116.test.ts
import assertNode from "node:assert/strict";
import { canRun } from "../helpers/response_world.ts";
import { runConversation, type Step, TURNS } from "../helpers/mirror_process.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const LIE = "The search found no public page listing Lakeshore University alumni at Google or the trading firms. Try your school's alumni directory. Nobody was contacted.";
const script: Record<string, Step[]> = { C19: [{ tool: "find_people", input: { count: 3 } }, { tool: "find_people", input: { count: 3 } }, { text: LIE }] };

Deno.test({ name: 'CH-3 C19 through the real handler: a people search that never ran is reported as not run, never as a result', sanitizeOps: false, sanitizeResources: false, ignore: canRun() !== null && canRun() !== "FAIL", fn: async () => {
  if (canRun() === "FAIL") throw new Error("needs Postgres 16 in CI");
  const { seen, close } = await runConversation(script);
  try {
    const brain = TURNS.filter((t) => seen[t.id] && !seen[t.id].code);
    ok(brain.length >= 20, `turns that reached the brain: ${brain.map((t) => t.id).join(",")}`);
    const c19 = seen.C19;
    ok(c19 && !c19.code, "C19 reached the brain");
    ok(c19.calls.filter((c) => c.name === "find_people").length === 2 && c19.calls.every((c) => /missing required input/.test(c.result)), JSON.stringify(c19.calls));
    ok(!/found no public page/.test(c19.reply), `C19 reported a result from a search that never ran: ${c19.reply}`);
    ok(/people search did not run/.test(c19.reply), `C19 does not say the search did not run: ${c19.reply}`);
  } finally { await close(); }
} });
