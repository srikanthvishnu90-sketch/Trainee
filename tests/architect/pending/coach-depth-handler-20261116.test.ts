// The 10/10 rubric's gaps #2, #5 and #8 (2026-11-16; evals/mirror/instinct-wa-batch1/) through the REAL career handler at $0:
// every migration on a throwaway Postgres 16, production's release flags, a scripted model that records the system prompt code
// gave the brain on each turn (tests/architect/helpers/mirror_process.ts). It cannot judge what a real model writes; it pins what
// code hands the brain and what code lets through.
//   CH-1 (#2)  every job-search, apply, batch and application-status turn that reaches the brain carries the task contract for
//              its kind of task, exactly as task_contracts.ts builds it, and only one; the other turns carry none
//   CH-2 (#8)  every turn's prompt carries HOW APPROVAL WORKS exactly as approval_rules.ts builds it from the approval code, and no
//              prompt says applications are approved one by one (live-12 C12)
//   CH-3 (#5)  C19: a people search refused twice for missing inputs is reported as not run; "found no public page" never reaches
//              the person
//   CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/coach-depth-handler-20261116.test.ts
import assertNode from "node:assert/strict";
import { canRun } from "../helpers/response_world.ts";
import { runConversation, type Step, TURNS } from "../helpers/mirror_process.ts";
import { contractNote, type TaskIntent } from "../../../supabase/functions/_shared/agent/task_contracts.ts";
import { approvalRulesText, PER_ITEM_APPROVAL } from "../../../supabase/functions/_shared/agent/approval_rules.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);

// The kind of task each benchmark turn is (the rubric's "real task" line), for the job-search, apply, batch and application-status
// turns (owner's scope, 2026-11-16: mass applying first). Every other turn carries no contract.
const KIND: Record<string, TaskIntent> = {
  C1: "plan", C3: "search", C6: "applications", C10: "tailor", C11: "apply_requirements", C12: "capacity", C16: "tracker", C18: "posting_check", C20: "tailor",
};
const LIE = "The search found no public page listing Lakeshore University alumni at Google or the trading firms. Try your school's alumni directory. Nobody was contacted.";
const script: Record<string, Step[]> = { C19: [{ tool: "find_people", input: { count: 3 } }, { tool: "find_people", input: { count: 3 } }, { text: LIE }] };

Deno.test({ name: "CH-1..3 the benchmark through the real handler: task contracts, the approval rules, a people search that never ran", sanitizeOps: false, sanitizeResources: false, ignore: canRun() !== null && canRun() !== "FAIL", fn: async () => {
  if (canRun() === "FAIL") throw new Error("CH needs Postgres 16 in CI");
  const { seen, close } = await runConversation(script);
  try {
    const brain = TURNS.filter((t) => seen[t.id] && !seen[t.id].code);
    ok(brain.length >= 20, `turns that reached the brain: ${brain.map((t) => t.id).join(",")}`);
    // CH-1: each turn's contract, exactly, and no other.
    for (const t of brain) {
      const sys = seen[t.id].system, n = (sys.match(/TASK CONTRACT FOR THIS REPLY/g) ?? []).length;
      if (!KIND[t.id]) { ok(n === 0, `${t.id}: a contract outside the scope`); continue; }
      ok(sys.includes(contractNote(KIND[t.id])), `${t.id}: the ${KIND[t.id]} contract is not in the prompt`);
      ok(n === 1, `${t.id}: one contract`);
    }
    ok(Object.keys(KIND).filter((id) => seen[id] && !seen[id].code).length >= 6, "most scoped turns reached the brain");
    // CH-2: the approval rules as built from the code, on every turn; never "one by one".
    for (const t of brain) {
      const sys = seen[t.id].system;
      ok(sys.includes(approvalRulesText()), `${t.id}: HOW APPROVAL WORKS is not in the prompt as approval_rules.ts builds it`);
      ok(!PER_ITEM_APPROVAL.test(sys), `${t.id}: the prompt says approval is per application: ${PER_ITEM_APPROVAL.exec(sys)?.[0]}`);
    }
    // CH-3: C19's search never ran, so no result is reported and the reply says it did not run.
    const c19 = seen.C19;
    ok(c19 && !c19.code, "C19 reached the brain");
    ok(c19.calls.filter((c) => c.name === "find_people").length === 2 && c19.calls.every((c) => /missing required input/.test(c.result)), JSON.stringify(c19.calls));
    ok(!/found no public page/.test(c19.reply), `C19 reported a result from a search that never ran: ${c19.reply}`);
    ok(/people search did not run/.test(c19.reply), `C19 does not say the search did not run: ${c19.reply}`);
  } finally { await close(); }
} });
