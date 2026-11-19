// D-098: the reply-quality eval runs the reply pipeline's support judge exactly as production does (before, run.ts gave the brain
// none, so every claim the judge decides failed closed and the eval measured a stricter product).
// Run: deno test -A --no-check tests/edge/eval-support-judge.test.ts
import { brainSupportJudge } from "../../evals/career/run.ts";
import { SUPPORT_JUDGE_SYSTEM } from "../../supabase/functions/_shared/agent/research/support.ts";
import { releaseFlagOn } from "../../supabase/functions/agent-chat/release_config.ts";
import RUN from "../../evals/career/run.ts" with { type: "text" };
import HANDLER from "../../supabase/functions/agent-chat/handler-career.ts" with { type: "text" };

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const env = (o: Record<string, string> = {}) => ({ get: (k: string) => o[k] });

Deno.test("D-098: with production's flag on, the eval brain gets the production support judge, over the brain's own call", async () => {
  assert(releaseFlagOn(env(), "CAREER_RESEARCH_REPLY"), "the committed release has CAREER_RESEARCH_REPLY on");
  const sent: any[] = [];
  const model = async (p: any) => { sent.push(p); return { content: [{ type: "text", text: '["yes","no"]' }] }; };
  const judge = brainSupportJudge(env(), model);
  assert(judge, "a judge, not null");
  eq(await judge!([{ claim: "a", source: "x" }, { claim: "b", source: "y" }]), ["yes", "no"]);
  eq(sent.length, 1);
  eq(sent[0].system, SUPPORT_JUDGE_SYSTEM, "production's judge prompt");
  eq(sent[0].temperature, 0);
  eq(sent[0].messages[0].content[0].type, "text");
  // (flag off, as production: no judge; no model: none)
  eq(brainSupportJudge(env({ CAREER_RESEARCH_REPLY: "off" }), model), null);
  eq(brainSupportJudge(env(), null), null);
});

Deno.test("D-098: run.ts hands the judge to the brain turn, and production builds the same judge", () => {
  assert(/const supportJudge = brainSupportJudge\(o\.env, o\.model\)/.test(RUN), "makeBrain builds it");
  assert(/agentTurn\(\{[\s\S]{0,900}\n\s*supportJudge,/.test(RUN), "and passes it to agentTurn");
  assert(/judge: supportJudgeVia\(\(payload\) => callModel\(cfg, payload, \{ meter, role: "chat", timeoutMs: SUPPORT_JUDGE_TIMEOUT_MS \}\)\)/.test(HANDLER), "handler-career.ts uses supportJudgeVia");
});
