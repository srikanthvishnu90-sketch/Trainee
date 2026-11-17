// Gap #8, approval half (2026-11-16; live-12 C12) through the REAL career handler at $0 (Postgres 16, production's release flags,
// a scripted model): every turn's prompt carries HOW APPROVAL WORKS exactly as approval_rules.ts builds it from the approval code,
// and no prompt says applications are approved one by one or per card.
//   TMPDIR=/private/tmp/claude-501/pg CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/approval-rules-handler-20261116.test.ts
import assertNode from "node:assert/strict";
import { canRun } from "../helpers/response_world.ts";
import { runConversation, type Step, TURNS } from "../helpers/mirror_process.ts";
import { approvalRulesText, PER_ITEM_APPROVAL } from "../../../supabase/functions/_shared/agent/approval_rules.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const script: Record<string, Step[]> = {};

Deno.test({ name: 'CH-2 the benchmark through the real handler: HOW APPROVAL WORKS on every turn, never per item', sanitizeOps: false, sanitizeResources: false, ignore: canRun() !== null && canRun() !== "FAIL", fn: async () => {
  if (canRun() === "FAIL") throw new Error("needs Postgres 16 in CI");
  const { seen, close } = await runConversation(script);
  try {
    const brain = TURNS.filter((t) => seen[t.id] && !seen[t.id].code);
    ok(brain.length >= 20, `turns that reached the brain: ${brain.map((t) => t.id).join(",")}`);
    for (const t of brain) {
      const sys = seen[t.id].system;
      ok(sys.includes(approvalRulesText()), `${t.id}: HOW APPROVAL WORKS is not in the prompt as approval_rules.ts builds it`);
      ok(!PER_ITEM_APPROVAL.test(sys), `${t.id}: the prompt says approval is per item: ${PER_ITEM_APPROVAL.exec(sys)?.[0]}`);
    }
  } finally { await close(); }
} });
