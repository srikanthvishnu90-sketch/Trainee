// Gap #2, scoped to mass applying (2026-11-16) through the REAL career handler at $0 (Postgres 16, production's release flags, a
// scripted model; tests/architect/helpers/mirror_process.ts). Architect direction (review rv3): no turn's prompt carries a task
// contract read from the message; a contract comes back only in the run note of a contracted tool the brain calls (C18's open
// check here).
//   TMPDIR=/private/tmp/claude-501/pg CI=true deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/coach-depth-handler-20261116.test.ts
import assertNode from "node:assert/strict";
import { canRun } from "../helpers/response_world.ts";
import { PAYPAL, runConversation, type Step, TURNS } from "../helpers/mirror_process.ts";
import { contractNote } from "../../../supabase/functions/_shared/agent/task_contracts.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const script: Record<string, Step[]> = { C18: [{ tool: "check_posting_open", input: { url: PAYPAL.url } }, { text: "It is open." }] };

Deno.test({ name: "CH-1 the benchmark through the real handler: no contract from the message; C18's open check returns its contract", sanitizeOps: false, sanitizeResources: false, ignore: canRun() !== null && canRun() !== "FAIL", fn: async () => {
  if (canRun() === "FAIL") throw new Error("needs Postgres 16 in CI");
  // Review rv4: a contract is chosen by the tool's result, so C18's open check must READ the posting: the Greenhouse posting API
  // answers with this posting (a check that does not finish, "unknown", carries no contract; CU-6).
  const serve = (req: Request) => new URL(req.url).hostname === "boards-api.greenhouse.io" && new URL(req.url).pathname === "/v1/boards/paypalwa1/jobs/9101"
    ? Response.json({ id: 9101, title: "Software Engineer Intern", absolute_url: PAYPAL.url, location: { name: "San Jose, CA" }, updated_at: "2026-11-10T00:00:00Z" }) : null;
  const { seen, close } = await runConversation(script, { serve });
  try {
    const brain = TURNS.filter((t) => seen[t.id] && !seen[t.id].code);
    ok(brain.length >= 20, `turns that reached the brain: ${brain.map((t) => t.id).join(",")}`);
    for (const t of brain) ok(!/TASK CONTRACT/.test(seen[t.id].system), `${t.id}: a contract in the prompt`);
    // Review rv4: trunk's reply pipeline read contracts from the message too ("THIS REPLY MUST: ..."); none is in any prompt.
    for (const t of brain) ok(!/THIS REPLY MUST/.test(seen[t.id].system), `${t.id}: a message-read contract (contractsFor) in the prompt`);
    const c18 = seen.C18;
    ok(c18 && !c18.code && c18.tools.includes("check_posting_open"), `C18 offered: ${c18?.tools.join(",")}`);
    const call = c18.calls.find((c) => c.name === "check_posting_open");
    ok(call && call.result.includes(contractNote("posting_check").slice(0, 80)), `C18's result: ${call?.result.slice(0, 300)}`);
  } finally { await close(); }
} });
