// The judge for the checks code cannot answer (rubric.json kind "judge"): one question about one reply, answered on the
// owner's Claude subscription through the claude CLI bridge (evals/subscription/claude_cli.ts: ANTHROPIC_API_KEY and
// ANTHROPIC_AUTH_TOKEN removed from the child, apiKeySource "none" checked before the first call; D-089). A yes counts only
// with a quote that is found word for word in that reply; otherwise the check fails. Never run in CI.
// deno-lint-ignore-file no-explicit-any
import type { Check, Result, Scenario, Snapshot } from "./grade.ts";

const SCHEMA = { type: "object", properties: { answer: { enum: ["yes", "no"] }, quote: { type: "string" }, why: { type: "string" } }, required: ["answer", "quote", "why"] };
const SYSTEM = "You grade one reply of a career assistant against one yes/no question. Answer yes only if the reply itself clearly does what the question asks; quote the exact sentence of the reply that shows it (copied word for word). If it does not, answer no and quote nothing.";
const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export async function judgeChecks(s: Scenario, x: Snapshot, o: { model?: string } = {}): Promise<Result[]> {
  const cli = await import("../../subscription/claude_cli.ts");
  const out: Result[] = [];
  for (const c of s.checks.filter((c: Check) => c.kind === "judge")) {
    const reply = x.replies[x.scripted[c.turn ?? 0]] ?? "";
    const prompt = `The person said: ${JSON.stringify(s.turns[c.turn ?? 0])}\n\nThe assistant replied:\n<<<\n${reply}\n>>>\n\nQuestion: ${c.question}`;
    try {
      const res: any = await cli.messages({ model: o.model ?? "claude-sonnet-5-5", system: SYSTEM, messages: [{ role: "user", content: prompt }], output_config: { format: { type: "json_schema", schema: SCHEMA } } });
      const v = JSON.parse(res.content?.[0]?.text ?? "{}");
      const quoted = typeof v.quote === "string" && v.quote.trim().length >= 8 && squash(reply).includes(squash(v.quote));
      out.push({ id: c.id, level: c.level, pass: v.answer === "yes" && quoted, why: v.answer === "yes" && !quoted ? `judge said yes without a quote found in the reply (${String(v.quote).slice(0, 80)})` : `judge ${v.answer}: ${String(v.why ?? "").slice(0, 160)}` });
    } catch (e) {
      out.push({ id: c.id, level: c.level, pass: null, why: `judge failed: ${(e as Error).message.slice(0, 160)}` });
    }
  }
  return out;
}
