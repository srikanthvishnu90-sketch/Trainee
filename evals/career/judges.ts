// The two eval judges (owner directive, 2026-11-02: Trainee is Claude only, judges included; no OpenAI call anywhere).
//
//   Judge A  claude-sonnet-5-5  the original JUDGE_PROMPT (run.ts), unchanged: 70 stored judgments were made with it.
//   Judge B  claude-haiku-5-5   a different TASK SHAPE on purpose: the item's must / must_not become a numbered checklist,
//                               and the judge must quote evidence for every check from the reply or the end state. Code
//                               derives pass from the checks and verifies each quote is really there; the model's own
//                               "pass" is never read. Two Claude judges share blind spots; a different framing and a
//                               code-verified quote are what keep B from being A's echo.
//
// Pass rule (unchanged, D-030 / WO-061): an item passes only when A AND B pass it (and its code-counted state check holds).
// Disagreement counts as a failure until both pass; a judge that errors fails the item. Every result records the A/B
// disagreement rate and the fingerprint of the frozen judge set (models, prompts, token limits, pass rule). Changing any of
// them changes the fingerprint and makes older S3 rows not comparable: re-judge the baselines (rejudge.ts).
//
// Pure module: no network, no model_gateway import (run.ts and rejudge.ts build the configs).
import type { EvalItem } from "./run.ts";

export const JUDGE_A_MODEL = "claude-sonnet-5-5";
export const JUDGE_B_MODEL = "claude-haiku-5-5";
export const JUDGE_A_SYSTEM = "You are a strict grader. Output JSON only.";
export const JUDGE_B_SYSTEM = "You are a meticulous auditor. Check every line of the checklist. Output JSON only.";
export const JUDGE_A_MAX_TOKENS = 400;
export const JUDGE_B_MAX_TOKENS = 800;
export const PASS_RULE = "item passes only when judge A passes, judge B passes and the code-counted state check holds; disagreement fails";

export const isClaude = (m: string | null | undefined) => /^claude-/i.test(String(m ?? ""));

// A judge id must be a Claude id and the Anthropic key must be there: a claude- id is sent to Anthropic with
// ANTHROPIC_API_KEY, anything else is refused (never POSTed to another provider).
export function judgeModelProblem(model: string | null | undefined, env: { get(k: string): string | undefined }): string | null {
  if (!model || !isClaude(model)) return `judge ${model || "(none)"} is not a claude- model; Trainee is Claude only`;
  if (!(env.get("ANTHROPIC_API_KEY") ?? "").trim()) return "no ANTHROPIC_API_KEY (the judges need it)";
  return null;
}

// ------------------------------------------------------------------------------------------------ judge B
export const JUDGE_B_PROMPT = `You audit one reply from a career agent against a checklist. Work line by line; do not grade style or tone.
User persona: {persona}
Conversation (user turns in order): {turns}
Agent's final reply: {reply}
End state after the conversation (JSON, may be null): {state}
Checklist:
{checklist}
For EVERY checklist line give a verdict and a verbatim quote (copied character for character) from the agent's final reply or from the end state that is your evidence.
"met" means: for a [must] line, the reply does it; for a [must_not] line, the reply does NOT do it; for a [state] line, the end state matches.
A line is met only if you can quote the evidence for it. For a [must_not] line that is met, quote "" (nothing in the reply does it).
If a line is not met, quote the offending text, or "" when the reply simply lacks it.
Return JSON only: {"checks": [{"n": 1, "met": true, "quote": "..."}, ...one object per checklist line, in order], "score": 1-5 for overall usefulness to this person, "note": one sentence}.`;

export function checklistOf(item: EvalItem): { n: number; kind: "must" | "must_not" | "state"; text: string }[] {
  const out: { n: number; kind: "must" | "must_not" | "state"; text: string }[] = [];
  for (const t of item.must) out.push({ n: out.length + 1, kind: "must", text: t });
  for (const t of item.must_not ?? []) out.push({ n: out.length + 1, kind: "must_not", text: t });
  if (item.state) out.push({ n: out.length + 1, kind: "state", text: item.state });
  return out;
}

export function judgeBPrompt(item: EvalItem, reply: string, state: unknown, outcomeOf: (s: unknown) => unknown): string {
  const checklist = checklistOf(item).map((c) => `${c.n}. [${c.kind}] ${c.text}`).join("\n");
  const fill: Record<string, string> = {
    persona: item.persona, turns: JSON.stringify(item.turns), reply,
    state: JSON.stringify(state == null ? null : { outcome_counted_by_code: outcomeOf(state), ...(state as object) }).slice(0, 6000),
    checklist,
  };
  return JUDGE_B_PROMPT.replace(/\{(\w+)\}/g, (_, k) => fill[k] ?? "");
}

const norm = (s: string) => String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

// Judge B's verdict, derived by code from the checks. A met line needs a quote that really occurs in the reply or in the end
// state (case and whitespace aside), except a met [must_not] line, whose evidence is an absence. A missing line, an unmet line
// or a quote that is not there fails the item and says which.
export function parseJudgeB(text: string, item: EvalItem, reply: string, state: unknown): { pass: boolean; failed: string[]; score: number; note: string } {
  const m = /\{[\s\S]*\}/.exec(text || "");
  if (!m) throw new Error("judge returned no JSON");
  const j = JSON.parse(m[0]);
  if (!Array.isArray(j.checks)) throw new Error("judge JSON has no checks array");
  const hay = norm(`${reply}\n${JSON.stringify(state ?? null)}`);
  const failed: string[] = [];
  for (const c of checklistOf(item)) {
    const got = j.checks.find((x: any) => Number(x?.n) === c.n);
    if (!got || typeof got.met !== "boolean") { failed.push(`${c.text} (no verdict for line ${c.n})`); continue; }
    if (!got.met) { failed.push(c.text); continue; }
    const q = typeof got.quote === "string" ? norm(got.quote) : "";
    if (c.kind === "must_not") { if (q && !hay.includes(q)) failed.push(`${c.text} (quoted text is not in the reply)`); continue; }
    if (!q) { failed.push(`${c.text} (met without a quote)`); continue; }
    if (!hay.includes(q)) failed.push(`${c.text} (quote not found in the reply or the end state)`);
  }
  return { pass: failed.length === 0, failed, score: Math.max(1, Math.min(5, Number(j.score) || 1)), note: String(j.note || "") };
}

// ------------------------------------------------------------------------------------------------ fingerprint
// A hash of everything that defines the judging, so a change is visible in every result and in JUDGES.md.
export async function judgeFingerprint(judgeAPrompt: string, models: { a: string; b: string } = { a: JUDGE_A_MODEL, b: JUDGE_B_MODEL }): Promise<string> {
  const body = JSON.stringify({ a: { model: models.a, system: JUDGE_A_SYSTEM, prompt: judgeAPrompt, max_tokens: JUDGE_A_MAX_TOKENS },
    b: { model: models.b, system: JUDGE_B_SYSTEM, prompt: JUDGE_B_PROMPT, max_tokens: JUDGE_B_MAX_TOKENS }, pass_rule: PASS_RULE });
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
