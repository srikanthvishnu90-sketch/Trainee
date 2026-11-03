// Situation-knowledge eval: does the chat understand THIS person's situation and answer specifically, truthfully, with one
// next step? 130 synthetic situations (situations.json; 21 are "deep"). Deterministic: no model judge, no network, no key.
//
//   deno run -A evals/career/situations/situation-knowledge.ts                      retrieval + pack check (free, offline): are the right playbooks picked, is the pack honest
//   deno run -A evals/career/situations/situation-knowledge.ts --replay replies.json score recorded replies { "S001": "reply text", ... }
//   deno run -A evals/career/situations/situation-knowledge.ts --brain agent --arm knowledge|baseline [--label L] [--only S001,S002]
//        asks the model (needs ANTHROPIC_API_KEY; this is the spend, there is no judge). baseline = today's prompt, knowledge = + pack and playbooks.
//   ... --emit-judge judge-batch.json      with --replay: writes the model-judge requests (judge-prompt.md filled in) for a later paid run; calls nothing
//
// Rubric: rubric.md. Results: evals/career/results/situation-knowledge.<label>.json. A check with no evidence is never a pass.
import { knowledgeFor } from "../../../supabase/functions/_shared/agent/knowledge/index.ts";

export type Dim = "specific" | "truthful" | "actionable" | "question" | "natural";
export const DIMS: Dim[] = ["specific", "truthful", "actionable", "question", "natural"];
export interface Situation {
  id: string; title: string; deep: boolean;
  facts: { id: string; kind: string; text: string; confirmed: boolean }[]; standing: string[]; history: { role: "user" | "assistant"; content: string }[];
  message: string; expect_playbooks: string[]; none_of: string[];
  must_use: string[][]; must_cover: string[][]; must_not_ask: string[]; forbid: string[];
}
export interface CheckResult { id: string; d: Dim; ok: boolean; hard: boolean; why: string }

export const profileOf = (s: Situation) => ({
  facts: s.facts.map((f) => ({ id: f.id, kind: f.kind, text: f.text, status: f.confirmed ? "confirmed" : "draft", needs_confirmation: !f.confirmed })),
});
export const standingOf = (s: Situation) => s.standing.map((text, i) => ({ id: `S-${String(i + 1).padStart(3, "0")}`, text, said: text, at: "2026-10-01T00:00:00Z" }));
export const knowledgeOf = (s: Situation) => knowledgeFor({ profile: profileOf(s), standing: standingOf(s), history: s.history, message: s.message });

// ---------------------------------------------------------------------------------------------- retrieval check (free)
export function retrievalCheck(s: Situation): { ok: boolean; picked: string[]; missing: string[]; unwanted: string[] } {
  const picked = knowledgeOf(s).playbooks;
  const missing = s.expect_playbooks.filter((id) => !picked.includes(id));
  const unwanted = s.none_of.filter((id) => picked.includes(id));
  return { ok: !missing.length && !unwanted.length, picked, missing, unwanted };
}

// ---------------------------------------------------------------------------------------------- reply checks
const norm = (t: string) => t.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ");
const has = (reply: string, group: string[]) => group.some((w) => norm(reply).includes(norm(w)));
const sentences = (s: string) => s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
// Questions put to the person: not bulleted sample questions, not inside a quoted or bracketed draft.
export function questionsIn(reply: string): string[] {
  const body = reply.replace(/"[^"]{3,}"/g, " ").replace(/\[[^\]]*\]/g, " ");
  return sentences(body).filter((x) => !/^[·\-*•]|^\d+[.)]\s/.test(x) && /\?\s*["')\]]*$/.test(x));
}
const CANNED = [
  "i hope this helps", "great question", "as an ai", "best of luck", "good luck out there", "it's important to", "there are many factors", "everyone's journey is different",
  "don't be afraid to", "put yourself out there", "think outside the box", "reach out to your network", "leverage your", "it depends on many", "every situation is unique",
  "keep your head up", "stay positive", "you've got this", "the sky is the limit", "hard work pays off", "i'm just an ai", "feel free to ask", "let me know if you have any questions",
  "here are some tips", "in today's competitive job market", "job market is tough",
];
const JARGON = ["playbook", "context pack", "signal:", "stage:", "topic:", "tool call", "payload", "system prompt", "snapshot", "backend", "schema", "router", "intent", "knock-out"];
const MONTHS = /\b(january|february|march|april|june|july|august|september|october|november|december)\b\s*(\d{1,2}(st|nd|rd|th)?\b|,?\s*20\d\d)/i;
const COMPANIES = ["google", "amazon", "microsoft", "meta", "apple", "netflix", "goldman", "morgan stanley", "jpmorgan", "jp morgan", "mckinsey", "bain", "bcg", "deloitte", "pwc", "kpmg", "ey", "stripe", "ramp", "plaid", "brex", "figma", "airtable", "notion", "salesforce", "oracle", "ibm", "intel", "nvidia", "tesla", "spacex", "openai", "anthropic", "uber", "lyft", "airbnb", "linkedin learning", "walmart", "target corp", "citi", "blackrock", "palantir", "boeing", "lockheed", "nasa", "google summer", "step program", "explore program"];
// A capitalized word in the middle of a sentence that the person never said and that is not a generic term: likely an invented name.
const GENERIC_CAPS = new Set(["I", "I'm", "I'll", "I've", "I'd", "LinkedIn", "Indeed", "GPA", "SQL", "Excel", "Python", "HR", "UX", "UI", "AI", "OPT", "CPT", "STEM", "PDF", "CS", "MBA", "PhD", "ATS", "GitHub", "Handshake", "Gmail", "H-1B", "F-1", "Trainee", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "REU", "URL", "API", "Word", "Google", "Docs", "Sheets", "Notion", "Tableau", "Looker"]);
export function unsupportedProperNouns(reply: string, seen: string): string[] {
  const out = new Set<string>();
  const seenN = norm(seen);
  const body = reply.replace(/\[[^\]]*\]/g, " ");
  for (const line of body.split("\n")) {
    const text = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "");
    const re = /[A-Za-z][A-Za-z'’.-]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const w = m[0].replace(/[.'’-]+$/, "");
      const before = text.slice(0, m.index).trimEnd();
      const sentenceStart = before === "" || /[.?!:"“—–(]$/.test(before);
      if (sentenceStart || !/^[A-Z]/.test(w) || GENERIC_CAPS.has(w)) continue;
      if (w.length < 2 || seenN.includes(norm(w))) continue;
      out.add(w);
    }
  }
  return [...out];
}
const wordCount = (t: string) => (t.match(/\S+/g) ?? []).length;
const NEXT_ANCHOR = /\b(this week|today|tonight|tomorrow|first thing|first,|start with|next step|your next|before (?:monday|tuesday|wednesday|thursday|friday|the weekend)|by (?:friday|monday|tuesday|wednesday|thursday|sunday)|in the next|right now|then,|step 1|1\.)/i;
const STEPS = /(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+\S/g;
const SAFETY_ONLY = (s: Situation) => s.expect_playbooks.length === 0 && s.must_use.length === 0;

export function checkReply(s: Situation, reply: string): CheckResult[] {
  const out: CheckResult[] = [];
  const add = (d: Dim, ok: boolean, why: string, hard = false) => out.push({ id: s.id, d, ok, hard, why });
  const r = reply.trim();
  const seen = [s.message, ...s.history.map((h) => h.content), ...s.facts.map((f) => f.text), ...s.standing].join(" ");
  // specific: this person's own facts appear, and the substance this situation needs
  s.must_use.forEach((g, i) => add("specific", has(r, g), `uses their fact #${i + 1} [${g.join(" | ")}]`));
  s.must_cover.forEach((g, i) => add("specific", has(r, g), `covers the substance #${i + 1} [${g.join(" | ")}]`));
  // truthful (hard): no invented figures, dates, companies, names; no false action claims; no situation-specific forbidden claim
  const figures = r.match(/\$\s?\d[\d,.]*\s?[kKmM]?|\b\d+(?:\.\d+)?\s?%|\b\d+\s?k\b/g) ?? [];
  const unsaid = figures.filter((f) => !norm(seen).includes(norm(f).replace(/\s/g, "")) && !norm(seen).includes(norm(f)));
  add("truthful", !unsaid.length, `no pay or percent figure the person did not give (${unsaid.join(", ")})`, true);
  add("truthful", !MONTHS.test(r) || MONTHS.test(seen), "no specific date the person did not give", true);
  const word = (text: string, c: string) => new RegExp(`(^|[^a-z])${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(norm(text));
  const named = COMPANIES.filter((c) => word(r, c) && !word(seen, c));
  add("truthful", !named.length, `no company or program named that nobody gave (${named.join(", ")})`, true);
  const nouns = unsupportedProperNouns(r, seen);
  add("truthful", nouns.length === 0, `no unexplained proper name (${nouns.slice(0, 5).join(", ")})`, true);
  add("truthful", !/\bi(?:'ve| have)? (?:just )?(?:sent|submitted|applied|emailed|messaged|connected)\b/i.test(r.replace(/"[^"]*"/g, "")), "no claim that Trainee sent or applied", true);
  for (const f of s.forbid) add("truthful", !new RegExp(f, "i").test(r), `does not say /${f}/`, true);
  // actionable: a concrete next step, in order, with a time anchor
  const steps = (r.match(STEPS) ?? []).length;
  add("actionable", SAFETY_ONLY(s) || steps >= 2 || sentences(r).length >= 3, "gives steps or a plan, not a single remark");
  add("actionable", NEXT_ANCHOR.test(r) || SAFETY_ONLY(s), "names when to start (this week, today, first, next step)");
  // question: at most one; never one the facts already answer
  const qs = questionsIn(r);
  add("question", qs.length <= 1, `at most one question (found ${qs.length})`, qs.length > 2);
  for (const pat of s.must_not_ask) add("question", !qs.some((q) => new RegExp(pat, "i").test(q)), `does not ask /${pat}/ (already known)`, true);
  // natural: plain, specific prose
  const canned = CANNED.filter((c) => norm(r).includes(c));
  add("natural", !canned.length, `no canned filler (${canned.join(", ")})`);
  const jargon = JARGON.filter((j) => norm(r).includes(j));
  add("natural", !jargon.length && !/\b[A-Z]{2,}(?:_[A-Z]{2,})+\b|\bundefined\b|\[object|\{\w+\}|^#{1,6}\s/m.test(r), `no internal words or leaked tokens (${jargon.join(", ")})`);
  const wc = wordCount(r);
  add("natural", wc >= 25 && wc <= 380, `a text-message length answer (${wc} words)`);
  add("natural", !/^\s*(?:you said|you mentioned that you)\b/i.test(r), "does not open by repeating their message");
  add("natural", !/[^\n] {2,}\S/.test(r) && !/\b(\w{3,})\s+\1\b/i.test(r), "no double spaces or repeated words");
  return out;
}

export interface Score { dims: Record<Dim, number | null>; overall: number | null; failed: CheckResult[]; clean: boolean }
export function score(results: CheckResult[]): Score {
  const dims = {} as Record<Dim, number | null>;
  for (const d of DIMS) {
    const rs = results.filter((r) => r.d === d);
    if (!rs.length) { dims[d] = null; continue; }
    const raw = (5 * rs.filter((r) => r.ok).length) / rs.length;
    dims[d] = rs.some((r) => r.hard && !r.ok) ? Math.min(raw, 2) : raw;
  }
  const have = DIMS.map((d) => dims[d]).filter((x): x is number => x !== null);
  return { dims, overall: have.length ? have.reduce((a, b) => a + b, 0) / have.length : null, failed: results.filter((r) => !r.ok), clean: results.every((r) => r.ok) };
}

// ---------------------------------------------------------------------------------------------- model judge requests (for later)
export function judgeRequest(s: Situation, reply: string, template: string): { id: string; prompt: string } {
  const person = [
    ...s.facts.map((f) => `- [${f.confirmed ? "confirmed" : "said, not confirmed"}] (${f.kind}) ${f.text}`),
    ...s.standing.map((t) => `- [standing instruction] ${t}`),
    ...(s.history.length ? ["Earlier in the chat:", ...s.history.map((h) => `${h.role}: ${h.content}`)] : []),
  ].join("\n") || "- nothing on file";
  return { id: s.id, prompt: template.replace("{{PERSON}}", person).replace("{{MESSAGE}}", s.message).replace("{{REPLY}}", reply) };
}

// ---------------------------------------------------------------------------------------------- runner
async function main() {
  const args = Deno.args, arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dir = new URL("./", import.meta.url);
  const all: Situation[] = JSON.parse(Deno.readTextFileSync(new URL("situations.json", dir))).situations;
  const only = arg("--only")?.split(",");
  const sits = only ? all.filter((s) => only.includes(s.id)) : all;
  const label = arg("--label") ?? "run";
  const outDir = new URL("../results/", dir);
  const replayFile = arg("--replay"), brain = arg("--brain");

  if (!replayFile && !brain) {
    const rs = sits.map((s) => ({ s, r: retrievalCheck(s) }));
    const bad = rs.filter((x) => !x.r.ok);
    const noPick = rs.filter((x) => !x.r.picked.length).length;
    console.log(`retrieval: ${rs.length - bad.length}/${rs.length} situations pick the expected playbooks (${noPick} pick none)`);
    for (const x of bad) console.log(`  ${x.s.id} ${x.s.title}: picked [${x.r.picked.join(", ")}] missing [${x.r.missing.join(", ")}] unwanted [${x.r.unwanted.join(", ")}]`);
    Deno.mkdirSync(outDir, { recursive: true });
    Deno.writeTextFileSync(new URL(`situation-knowledge.retrieval-${label}.json`, outDir), JSON.stringify({ total: rs.length, ok: rs.length - bad.length, items: rs.map((x) => ({ id: x.s.id, ...x.r })) }, null, 1));
    Deno.exit(bad.length ? 1 : 0);
  }

  let replies: Record<string, string> = {};
  if (replayFile) replies = JSON.parse(Deno.readTextFileSync(replayFile));
  else {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) { console.error("NOT RUN: --brain agent needs ANTHROPIC_API_KEY (the model is the spend). Nothing was faked."); Deno.exit(2); }
    const arm = arg("--arm") ?? "knowledge";
    const { callModel, modelConfigFor } = await import("../../../supabase/functions/_shared/model_gateway.ts");
    const { careerSystemPrompt } = await import("../../../supabase/functions/_shared/agent/prompt.ts");
    const { styleBlock } = await import("../../../supabase/functions/_shared/agent/style.ts");
    const cfg = modelConfigFor(Deno.env, Deno.env.get("CAREER_REPLY_MODEL") || "claude-haiku-5-5");
    for (const s of sits) {
      const system = careerSystemPrompt("2026-10-28") + "\n\n" + styleBlock(s.message) + (arm === "knowledge" ? "\n\n" + knowledgeOf(s).text : "");
      const res = await callModel(cfg, { system, messages: [...s.history.map((h) => ({ role: h.role, content: [{ type: "text", text: h.content }] })), { role: "user", content: [{ type: "text", text: s.message }] }], tools: [], max_tokens: 900 });
      replies[s.id] = (res.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("").trim();
    }
  }

  const emit = arg("--emit-judge");
  if (emit) {
    const template = Deno.readTextFileSync(new URL("judge-prompt.md", dir));
    Deno.writeTextFileSync(emit, JSON.stringify(sits.filter((s) => replies[s.id]).map((s) => judgeRequest(s, replies[s.id], template)), null, 1));
    console.log(`wrote ${emit}: judge requests, nothing sent`);
    Deno.exit(0);
  }

  const per = sits.filter((s) => replies[s.id] !== undefined).map((s) => ({ s, res: checkReply(s, replies[s.id]) }));
  const unscored = sits.length - per.length;
  const scored = per.map((x) => ({ id: x.s.id, title: x.s.title, deep: x.s.deep, ...score(x.res), reply: replies[x.s.id] }));
  const mean = (d: Dim) => { const v = scored.map((x) => x.dims[d]).filter((n): n is number => n !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  console.log(`scored ${scored.length} situations (${unscored} had no reply, unscored); clean ${scored.filter((x) => x.clean).length}`);
  for (const d of DIMS) console.log(`  ${d.padEnd(11)} ${mean(d)?.toFixed(2) ?? "n/a"}`);
  for (const x of scored.filter((y) => !y.clean).slice(0, 25)) console.log(`  ${x.id} ${x.title}: ${x.failed.map((f) => f.why).join("; ")}`);
  Deno.mkdirSync(outDir, { recursive: true });
  Deno.writeTextFileSync(new URL(`situation-knowledge.${label}.json`, outDir), JSON.stringify({ label, arm: arg("--arm") ?? null, scored: scored.length, unscored, means: Object.fromEntries(DIMS.map((d) => [d, mean(d)])), items: scored }, null, 1));
  Deno.exit(scored.every((x) => x.clean) && !unscored ? 0 : 1);
}
if (import.meta.main) await main();
