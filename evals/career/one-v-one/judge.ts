// 1v1 judge (review of #368, 2026-11-02): an OpenAI model grades each reply against the scenario's gold, beside the regex
// rubric (score.ts). A scenario passes only when the regex rubric AND the judge pass it.
//
// The judge: OpenAI only (no Anthropic spend), temperature 0, a fixed seed, a strict JSON schema; called twice and the two
// verdicts must agree that it passes. A reply the judge cannot parse, a field of the wrong type, a "pass" that does not equal
// the AND of the four criteria, a model error, or two verdicts that disagree: each is a FAIL, never a pass.
//
// Spend: gpt-4.1-mini at $0.40 / $1.60 per million tokens in / out (model_gateway.ts PRICES). One call is about 1,500 tokens
// in and 120 out, about $0.0008; two calls a reply, 120 replies: about $0.20 a judged run. Every call is metered and the
// run's recorded cost is the meter's, not this estimate.
import type { Scenario, State } from "./scenarios.ts";

export const JUDGE_MODEL = "gpt-4.1-mini";
export const JUDGE_SEED = 1101;
export const JUDGE_CRITERIA = ["answers", "facts", "style", "links"] as const;
export type Criterion = typeof JUDGE_CRITERIA[number];
export interface JudgeVerdict { pass: boolean; answers: boolean; facts: boolean; style: boolean; links: boolean; note: string }
export interface JudgeResult { pass: boolean; verdicts: (JudgeVerdict | { error: string })[]; why: string }

export const STATE_FACTS: Record<State, string> = {
  new: "Nothing on file: no resume, no facts, no applications, no alerts, Gmail not connected.",
  profile: "Confirmed facts: data analyst with 2 years of SQL and Tableau, based in Chicago. Standing rule: needs visa sponsorship (F-1 OPT). One tracked application: Plaid, Business Analyst, submitted. No alerts. Gmail not connected.",
  inflight: "Confirmed facts: data analyst with 2 years of SQL and Tableau, based in Chicago; needs visa sponsorship (F-1 OPT). Applications: Notion confirmed (NOT-55812); Plaid stopped on a code the employer emailed; Ramp failed (phone number required); Brex queued for the extension; Figma prepared with 2 open questions (work authorization, salary expectation); Airtable asked for, not yet taken by the extension. A draft email to Jordan Lee, Plaid technical recruiter, waits for approval. Gmail not connected. Job alert on: data analyst, Chicago or remote.",
};

export const JUDGE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "one_v_one_verdict", strict: true,
    schema: {
      type: "object", additionalProperties: false, required: ["answers", "facts", "style", "links", "pass", "note"],
      properties: { answers: { type: "boolean" }, facts: { type: "boolean" }, style: { type: "boolean" }, links: { type: "boolean" }, pass: { type: "boolean" }, note: { type: "string" } },
    },
  },
} as const;

export function judgePrompt(s: Scenario, reply: string[], postings: { company: string; title: string; location: string; url: string; description: string }[]): string {
  return `You grade one reply from Trainee, a career agent people text, against a reference reply. Be strict and literal.

Channel: ${s.channel}. Account state (the only facts about the person that exist): ${STATE_FACTS[s.state]}
Job postings that exist (anything else is invented): ${JSON.stringify(postings.map((p) => ({ company: p.company, title: p.title, location: p.location, url: p.url, description: p.description })))}
${s.prior?.length ? `Earlier messages from the person, in order: ${JSON.stringify(s.prior)}\n` : ""}The person's message: ${JSON.stringify(s.msg)}

Reference reply (what a sharp texting career agent sends; one message per item): ${JSON.stringify(s.gold)}
Reply to grade (one message per item): ${JSON.stringify(reply)}

Criteria, each true or false:
- answers: the reply does what the person asked, as the reference does: it answers the question or does the task, or says plainly why it cannot and gives the useful next step. A generic menu, a deflection, an echo of the message, or keywords without sentences is false.
- facts: every fact the reference relies on that matters for the person is present or correctly paraphrased, and the reply adds nothing invented: no employer, posting, pay figure, person, date, sponsorship status, account fact or completed action that is not in the account state, the postings or the person's words. A claim that something was sent, submitted, set or saved that the state does not show is false.
- style: plain texting: short (about the reference's length or less), no markdown symbols, no internal or technical words, at most one question, no filler opener or closer.
- links: every link the reply carries is a posting URL above or one the person gave, and each link is alone on its own line or message right after the line saying what it is; a link the reference carries is present unless the reply says why not. No links in either: true.
pass is true only if all four are true. Output only the JSON object.`;
}

// Strict: the whole text is one JSON object of the schema's shape, and pass equals the AND of the criteria.
export function parseVerdict(text: string): JudgeVerdict {
  const j = JSON.parse(String(text ?? "").trim());
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not a JSON object");
  for (const k of [...JUDGE_CRITERIA, "pass"]) if (typeof j[k] !== "boolean") throw new Error(`${k} is not a boolean`);
  if (typeof j.note !== "string") throw new Error("note is not a string");
  const all = JUDGE_CRITERIA.every((k) => j[k] === true);
  if (j.pass !== all) throw new Error(`pass (${j.pass}) is not the AND of the criteria (${all})`);
  return { pass: j.pass, answers: j.answers, facts: j.facts, style: j.style, links: j.links, note: j.note.slice(0, 300) };
}

export type ModelCall = (payload: any) => Promise<{ content?: { type: string; text?: string }[] }>;
// Two calls, same prompt, temperature 0, fixed seed. Pass only when both parse and both pass.
export async function judgeReply(call: ModelCall, prompt: string): Promise<JudgeResult> {
  const one = async (): Promise<JudgeVerdict | { error: string }> => {
    try {
      const res = await call({ system: "You are a strict grader. Output JSON only.", messages: [{ role: "user", content: prompt }], max_tokens: 300, temperature: 0, seed: JUDGE_SEED, response_format: JUDGE_SCHEMA });
      return parseVerdict((res.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(""));
    } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  };
  const verdicts = [await one(), await one()];
  const bad = verdicts.find((v) => "error" in v) as { error: string } | undefined;
  if (bad) return { pass: false, verdicts, why: `judge error: ${bad.error}` };
  const [a, b] = verdicts as JudgeVerdict[];
  if (a.pass !== b.pass) return { pass: false, verdicts, why: "the two judgements disagree" };
  return { pass: a.pass && b.pass, verdicts, why: a.pass ? "" : a.note };
}
