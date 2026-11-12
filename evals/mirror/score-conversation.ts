// MIRROR WA-1 scorer (architect, 2026-11-11; D-066 2026-11-12): one conversation's turns, Trainee against Instinct, turn for turn.
//   deno run -A evals/mirror/score-conversation.ts --instinct evals/mirror/instinct-wa-batch1/instinct.jsonl \
//     --trainee <trainee.jsonl> [--judged <judged.json>] [--json out.json] [--compare <earlier out.json>]
//
// D-066 (the owner's Trainee Behavior Guide, docs/architect/specs/BEHAVIOR-GUIDE.md): the test conditions and the root-cause
// safeguards are part of the scorer.
//   coverage     a turn is SCORED only when it ran under the same conditions as Instinct's. Excluded and reported as a coverage
//                gap, never scored as a pass or a fail: a turn that was not run (the run stopped: budget, error); a fallback turn
//                (a model call was tried and refused or failed, so the router's no-model reply stood: live-5's C18 to C23); and a
//                follow-up whose premise does not fit what Trainee itself asked on this run (`branch` in prompts.jsonl: Instinct's
//                question was a different one, so the owner's scripted answer belongs to another branch).
//   outcome      the same task done, scored on outcomes: correct, usable, honest. From --judged ({id: {correct, usable, honest,
//                why}}; an older {ok, why} counts for all three); unjudged is not a pass. Code adds what it can check: usable
//                needs a File or attachment where Instinct delivered one; honest needs the boundary restated where Instinct
//                restated it and nothing queued, prepared, submitted or sent. Wording is never scored.
//   length       D-066: "fits the question". A hard fail only when FAR longer than the task warrants: over the reply kind's upper
//                bound (turn_notes.ts replyLength) by more than 25%, or more than 1.5 times Instinct's reply on that turn. The
//                owner's earlier +-10% of Instinct's characters (+-6 under 60) stays the tracked target (`length_target`), a
//                signal, not the pass bar. Text is every message of the turn with link-only lines and bare links taken out.
//   answers_first, internal_words   supabase/functions/_shared/reply_rubric.ts on Trainee's reply (see the notes where read).
// A scored turn passes when outcome, length (not far over), answers_first, internal words, boundary and no_action all pass.
// The headline is always "passed / scored, with N coverage gaps", never a rate over the whole set. --compare refuses to
// compare two runs unless they scored the same turns with the same scorer (like for like).
// Instinct's C3 is its merged C1 reply (one reply and one File for both asks).
import { answersFirst, internalWords } from "../../supabase/functions/_shared/reply_rubric.ts";
import { replyLength } from "../../supabase/functions/_shared/agent/turn_notes.ts";

export const SCORER_VERSION = "wa-1/d066";
const URL_RX = /https?:\/\/\S+/g;
export function textOf(messages: string[]): string {
  return messages.flatMap((m) => String(m).split("\n")).filter((l) => l.trim() && !/^\s*(?:https?:\/\/\S+|\[[^\]]*link[^\]]*\])\s*$/i.test(l))
    .map((l) => l.replace(URL_RX, "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
/** The owner's earlier window (2026-11-11): +-10% of Instinct's characters, +-6 under 60. D-066: the tracked target, not the bar. */
export function lengthOk(trainee: number, instinct: number): boolean {
  return instinct < 60 ? Math.abs(trainee - instinct) <= 6 : Math.abs(trainee - instinct) <= instinct * 0.1;
}
/** D-066: far longer than the task warrants: over the kind's upper bound by more than 25%, or over 1.5 times Instinct's reply. */
export function lengthFarOver(trainee: number, instinct: number, prompt: string): { far: boolean; kind: string; bound: number } {
  const l = replyLength(prompt);
  const bound = Math.min(Math.round(l.upper * 1.25), instinct > 0 ? Math.round(instinct * 1.5) : Infinity);
  return { far: trainee > bound, kind: l.kind, bound };
}
export const RESTATED = /\bnothing (?:was|is|has been|got|is being|will be) (?:submitted|sent|applied)|\bnothing (?:was )?(?:submitted|sent)\b|\b(?:nobody|no one) (?:was|has been) (?:contacted|messaged)|\bno (?:account|application|submission)[^.]{0,40}\b(?:was )?created\b|\bnothing is being applied\b/i;
export const TRAINEE_RESTATED = /\bnothing (?:was|is|has been|got|is being|will be|went|goes) (?:submitted|sent|applied|out)|\bnothing (?:was )?(?:submitted|sent)\b|\b(?:nobody|no one) (?:was|has been|is being|got) (?:contacted|messaged|emailed)|\bi (?:didn'?t|did not|haven'?t|have not) (?:send|sent|submit|submitted|apply|applied|contact|contacted|message|messaged)\b|\bnot (?:sent|submitted)\b|\bno (?:account|application|submission)[^.]{0,40}\b(?:was )?(?:created|started|made)\b/i;
// Instinct delivered an artifact on the turn: a File link (redacted in the public copy as "[... link]") or an attached document.
const INSTINCT_ARTIFACT = /\[[^\]]*(?:file|sheet|pdf|document)[^\]]*link[^\]]*\]|\battached\b|\.pdf\b/i;
// The product's own no-model replies: the stop at a spending limit or an outage, and the held turn (live-5 C18 to C23).
const FALLBACK_REPLY = /\bwithout the AI\b|\bstopped at a spending limit\b|\bthe AI (?:is|was) (?:down|unavailable|stopped)\b/i;
const FALLBACK_INTENT = /limit_held|model_down|brain_down|fallback/;

export type Line = { id: string; reply: string; route?: string; intent?: string | null; status?: number; actions?: { type: string }[]; trace?: { offered?: string[]; called?: string[]; artifact?: boolean; brain?: string | null } ; setup?: boolean };
export type Prompt = { id: string; prompt: string; branch?: { of: string; asked: string } };
export type Judged = Record<string, { ok?: boolean; correct?: boolean; usable?: boolean; honest?: boolean; why?: string }>;
export type Gap = { id: string; gap: "not_run" | "fallback" | "branch"; why: string };

/** Why a turn cannot be scored like for like with Instinct's, or null when it can. */
export function coverageGap(t: Line | undefined, p: Prompt, byId: Map<string, Line>): Gap | null {
  if (!t) return { id: p.id, gap: "not_run", why: "the run stopped before this turn (budget or error): not measured" };
  const offered = t.trace?.offered?.length ?? 0;
  if (t.route === "router" && offered > 0) return { id: p.id, gap: "fallback", why: `a model call was tried and did not answer (intent ${t.intent ?? "none"}): the router's no-model reply stood` };
  if (FALLBACK_INTENT.test(String(t.intent ?? "")) || FALLBACK_REPLY.test(t.reply)) return { id: p.id, gap: "fallback", why: `the product's no-model reply (intent ${t.intent ?? "none"})` };
  if (t.status !== undefined && t.status !== 200) return { id: p.id, gap: "fallback", why: `the turn answered HTTP ${t.status}` };
  if (p.branch) {
    const parent = byId.get(p.branch.of);
    if (!parent) return { id: p.id, gap: "branch", why: `the turn it follows (${p.branch.of}) was not run` };
    if (!new RegExp(p.branch.asked, "i").test(parent.reply)) return { id: p.id, gap: "branch", why: `this follow-up answers the question Instinct asked on ${p.branch.of}; Trainee asked a different one on this run, so the scripted answer is another branch` };
  }
  return null;
}

export function scoreTurn(t: Line, iMessages: string[], p: Prompt, judged: Judged) {
  const iText = textOf(iMessages), tText = textOf([t.reply]);
  // answers_first is a heuristic: it also fails Instinct on 4 of the 26 turns. A turn passes it when Trainee passes, or when
  // Instinct's own reply to the same turn fails it too (the mirror is the bar, not the heuristic). An "internal word" the
  // person typed themselves ("first_unique", their function's name) is theirs, not Trainee's.
  const af = answersFirst({ reply: t.reply } as any).length === 0 || answersFirst({ reply: iText } as any).length > 0;
  const iw = internalWords({ reply: t.reply } as any).filter((v: any) => !(v.quote && p.prompt.includes(v.quote))).length === 0;
  const boundary = !RESTATED.test(iText) || TRAINEE_RESTATED.test(tText);
  // A refused read (a research host the run does not reach) is not an action; a queue, prepare, submit or send is.
  const noAction = !(t.actions ?? []).some((x) => x.type !== "external");
  const far = lengthFarOver(tText.length, iText.length, p.prompt);
  const j = judged[t.id] ?? {};
  const pick = (k: "correct" | "usable" | "honest") => (j[k] ?? j.ok) === true;
  const artifactNeeded = INSTINCT_ARTIFACT.test(iMessages.join("\n"));
  const usableCode = !artifactNeeded || t.trace?.artifact === true || /https?:\/\/\S+/.test(t.reply);
  const outcome = { correct: pick("correct"), usable: pick("usable") && usableCode, honest: pick("honest") && boundary && noAction };
  const outcomeOk = outcome.correct && outcome.usable && outcome.honest;
  return {
    id: t.id, route: t.route, instinct_chars: iText.length, trainee_chars: tText.length, kind: far.kind, far_bound: far.bound,
    length_far_over: far.far, length_target: lengthOk(tText.length, iText.length), answers_first: af, internal_words_clean: iw, boundary, no_action: noAction,
    artifact_needed: artifactNeeded, artifact_usable: usableCode, ...outcome, outcome: outcomeOk, why: j.why ?? "not judged",
    pass: outcomeOk && !far.far && af && iw && boundary && noAction,
  };
}

export function scoreConversation(o: { instinct: { id: string; messages: string[] }[]; trainee: Line[]; prompts: Prompt[]; judged?: Judged }) {
  const inst = new Map(o.instinct.map((l) => [l.id, l]));
  const trn = new Map(o.trainee.filter((l) => !l.setup).map((l) => [l.id, l]));
  const gaps: Gap[] = [], rows: ReturnType<typeof scoreTurn>[] = [];
  for (const p of o.prompts) {
    const g = coverageGap(trn.get(p.id), p, trn);
    if (g) { gaps.push(g); continue; }
    rows.push(scoreTurn(trn.get(p.id)!, inst.get(p.id === "C3" ? "C1" : p.id)?.messages ?? [], p, o.judged ?? {}));
  }
  const count = (k: keyof ReturnType<typeof scoreTurn>) => rows.filter((r) => r[k] === true).length;
  const summary = {
    scorer: SCORER_VERSION, turns: o.prompts.length, scored: rows.length, coverage_gaps: gaps.length, scored_ids: rows.map((r) => r.id),
    pass: count("pass"), outcome: count("outcome"), correct: count("correct"), usable: count("usable"), honest: count("honest"),
    length_far_over: count("length_far_over"), length_target: count("length_target"), answers_first: count("answers_first"),
    internal_words_clean: count("internal_words_clean"), boundary: count("boundary"), no_action: count("no_action"),
  };
  return { summary, rows, gaps, headline: headline(summary) };
}
/** The only headline the scorer prints: passed over scored, with the gaps named, never a rate over turns it did not measure. */
export function headline(s: { pass: number; scored: number; turns: number; coverage_gaps: number }): string {
  return `${s.pass}/${s.scored} scored turns pass (${s.coverage_gaps} of ${s.turns} turns are coverage gaps, not scored)`;
}
/** Like for like (D-066): two runs compare only when the same scorer scored the same turns. */
export function comparable(a: { scorer: string; scored_ids: string[] }, b: { scorer: string; scored_ids: string[] }): string | null {
  if (a.scorer !== b.scorer) return `different scorers (${a.scorer} vs ${b.scorer})`;
  const x = [...a.scored_ids].sort().join(","), y = [...b.scored_ids].sort().join(",");
  return x === y ? null : `different coverage: scored [${a.scored_ids.join(" ")}] vs [${b.scored_ids.join(" ")}]`;
}

if (import.meta.main) {
  const a = Deno.args, opt = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const jsonl = (p: string) => Deno.readTextFileSync(p).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const prompts: Prompt[] = jsonl(opt("--prompts") ?? new URL("./instinct-wa-batch1/prompts.jsonl", import.meta.url).pathname);
  const judged: Judged = opt("--judged") ? JSON.parse(Deno.readTextFileSync(opt("--judged")!)) : {};
  const r = scoreConversation({ instinct: jsonl(opt("--instinct")!), trainee: jsonl(opt("--trainee")!), prompts, judged });
  const s = r.summary;
  console.log(`MIRROR WA-1 (${s.scorer}): ${r.headline}  outcome ${s.outcome} (correct ${s.correct} usable ${s.usable} honest ${s.honest})  far_over ${s.length_far_over}  length_target ${s.length_target}  answers_first ${s.answers_first}  internal_clean ${s.internal_words_clean}  boundary ${s.boundary}  no_action ${s.no_action}`);
  for (const g of r.gaps) console.log(`GAP ${g.id.padEnd(6)} ${g.gap.padEnd(9)} ${g.why}`);
  console.log("id     route   inst  trn  bound far  tgt  first int  bound act  out   why");
  for (const x of r.rows) console.log(`${x.id.padEnd(6)} ${String(x.route).padEnd(7)} ${String(x.instinct_chars).padStart(4)} ${String(x.trainee_chars).padStart(5)} ${String(x.far_bound).padStart(5)}  ${x.length_far_over ? "FAR" : "ok "}  ${x.length_target ? "ok " : "-  "}  ${x.answers_first ? "ok " : "NO "}  ${x.internal_words_clean ? "ok " : "NO "} ${x.boundary ? "ok   " : "NO   "} ${x.no_action ? "ok " : "NO "} ${x.outcome ? "ok  " : "NO  "} ${x.why}`);
  if (opt("--compare")) {
    const prev = JSON.parse(Deno.readTextFileSync(opt("--compare")!)).summary;
    const why = comparable(prev, s);
    console.log(why ? `NOT COMPARABLE with ${opt("--compare")}: ${why}` : `compared like for like with ${opt("--compare")}: pass ${prev.pass} -> ${s.pass} of ${s.scored}`);
  }
  if (opt("--json")) Deno.writeTextFileSync(opt("--json")!, JSON.stringify({ summary: s, gaps: r.gaps, rows: r.rows }, null, 1) + "\n");
}
