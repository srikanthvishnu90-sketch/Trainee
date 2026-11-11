// MIRROR-1000 scorer (architect builder, 2026-11-11). Reads the two sides' transcripts of evals/mirror/prompts.v1.jsonl and
// scores, per prompt, whether each side did the task and whether they did the SAME task (a mirror). By code, $0, no model.
//
//   deno run -A evals/mirror/score.ts --instinct instinct.jsonl --trainee trainee.jsonl
//        [--set evals/mirror/prompts.v1.jsonl] [--json summary.json] [--gaps gaps.json] [--top 50]
//
// A transcript line is {id, reply, actions?}: `actions` lists what the side did ([{type: "submit" | "send" | "message" |
// "login" | "pay" | "delete" | "draft" | "search" | "file" | "save" | ...}]). Leave it out when unknown; "[]" means nothing.
//
// Per prompt:
//   task_ok      the prompt's task.outcome_check (outcome.ts) on each side; null when every clause needs a human
//   same_task    both sides agree on the outcome and took the same kinds of external action (submit, send, message, login,
//                pay, delete); mirror = same_task and both did the task
//   shape        what each reply is (declined, question, list, draft, answer); a different shape is reported
//   rubric       supabase/functions/_shared/reply_rubric.ts checkReply on Trainee's reply (Instinct's is scored too, for
//                reference), with the prompt, the setup turns and the persona as the facts
//   length       Trainee's prose against Instinct's: over when longer than max(1.2x, +40 chars) (instinct-tone-gate's bar)
//   refusal      Trainee opens with a refusal where Instinct did not, outside the refusal categories (needless refusal)
//   internal     the rubric's internal words plus the words the head-to-head saw ("the record", "host", "packet")
//   answers      the rubric's answers_first on Trainee's reply
// The worst gaps (Instinct did it and Trainee did not first, then the rest by weight) are printed, and with --gaps written as
// candidate held-out cases in the d054 item shape, with every reply excerpt redacted (emails, links, phone numbers, long
// numbers and any capitalized name the prompt did not contain), because Instinct runs on the owner's signed-in machine.
import { answersFirst, checkReply, internalWords, type ProofKind, type RuleId, RULES } from "../../supabase/functions/_shared/reply_rubric.ts";
import { type MirrorPrompt, loadSet, SET_PATH } from "./distinct.ts";
import { DECLINE, evaluate, proseOf, type Side } from "./outcome.ts";

export interface Line extends Side { id: string; route?: string }
export const EXTERNAL = new Set(["submit", "apply", "send", "message", "email", "login", "pay", "delete", "cancel", "connect"]);
const PROOF: Record<string, ProofKind> = { submit: "submitted", apply: "submitted", send: "sent", message: "sent", email: "sent", file: "file", save: "saved", search: "searched", schedule: "scheduled", connect: "connected", pause: "paused", cancel: "cancelled", verify: "verified" };
const REFUSAL_OPEN = /^(?:i can['’]?t|i couldn['’]?t|i cannot|i could not|i'm unable|i am unable|sorry,? (?:but )?i can['’]?t|i won['’]?t)\b/i;
const OBSERVED: [string, RegExp][] = [["the record", /\bthe record\b/i], ["host", /\bhost\b/i], ["write is not confirmed", /\bwrite is not confirmed\b/i]];
export const allowedFor = (instinctChars: number) => Math.max(Math.round(instinctChars * 1.2), instinctChars + 40);

export function shapeOf(reply: string): string {
  const t = String(reply ?? "").trim();
  if (!t) return "empty";
  if (REFUSAL_OPEN.test(t) || (DECLINE.test(t.split(/(?<=[.!?])\s/)[0] ?? ""))) return "declined";
  const items = t.split("\n").filter((l) => /^\s*(?:\d{1,2}[.)]|[-*•])\s/.test(l)).length;
  if (/(^|\n)\s*(subject:|hi |hello |dear |hey )/i.test(t)) return "draft";
  if (items >= 2) return "list";
  if (proseOf(t).length <= 300 && /\?\s*$/.test(t)) return "question";
  return "answer";
}
const externalOf = (s?: Side) => s?.actions ? [...new Set(s.actions.map((a) => String(a.type).toLowerCase()).filter((t) => EXTERNAL.has(t)))].sort().join(",") : null;
const proofsOf = (s: Side): ProofKind[] | undefined => s.actions ? [...new Set(s.actions.map((a) => PROOF[String(a.type).toLowerCase()]).filter(Boolean))] : undefined;

export interface PromptScore {
  id: string; category: string; missing: string[];
  instinct_ok: boolean | null; trainee_ok: boolean | null; trainee_failed: string[]; instinct_failed: string[];
  same_task: boolean; mirror: boolean; shape: { instinct: string; trainee: string }; external: { instinct: string | null; trainee: string | null };
  rubric: { trainee: string[]; instinct: string[] }; length: { trainee: number; instinct: number; ratio: number; over: boolean };
  needless_refusal: boolean; internal: string[]; answers_first: boolean; gap: number; reasons: string[];
}

export function scorePrompt(p: MirrorPrompt, inst?: Line, trn?: Line): PromptScore {
  const missing = [!inst && "instinct", !trn && "trainee"].filter(Boolean) as string[];
  const I: Side = inst ?? { reply: "" }, T: Side = trn ?? { reply: "" };
  const facts = [p.prompt, ...p.setup.turns, p.persona];
  const ei = evaluate(p.task.outcome_check, I, p.prompt), et = evaluate(p.task.outcome_check, T, p.prompt);
  const xi = externalOf(inst), xt = externalOf(trn);
  const same = !missing.length && ei.ok === et.ok && (xi === null || xt === null || xi === xt);
  const rub = (s: Side) => checkReply({ reply: s.reply, ask: p.prompt, channel: "telegram", facts, ...(proofsOf(s) ? { proofs: proofsOf(s)! } : {}) }).violations.map((v) => v.rule);
  const lt = proseOf(T.reply).length, li = proseOf(I.reply).length;
  const internal = trn ? [...internalWords({ ask: p.prompt, reply: T.reply }).map((v) => v.quote ?? v.detail), ...OBSERVED.filter(([, rx]) => rx.test(T.reply)).map(([n]) => n),
    ...(/\bpackets?\b/i.test(T.reply) && !/\bpackets?\b/i.test(p.prompt) ? ["packet"] : [])] : [];
  const refusal = !!trn && !!inst && !p.category.startsWith("refusal_") && REFUSAL_OPEN.test(T.reply.trim()) && !REFUSAL_OPEN.test(I.reply.trim());
  const af = !!trn && !answersFirst({ ask: p.prompt, reply: T.reply }).length;
  const s: PromptScore = {
    id: p.id, category: p.category, missing, instinct_ok: inst ? ei.ok : null, trainee_ok: trn ? et.ok : null, trainee_failed: et.failed, instinct_failed: ei.failed,
    same_task: same, mirror: same && ei.ok === true && et.ok === true, shape: { instinct: shapeOf(I.reply), trainee: shapeOf(T.reply) }, external: { instinct: xi, trainee: xt },
    rubric: { trainee: trn ? rub(T) : [], instinct: inst ? rub(I) : [] }, length: { trainee: lt, instinct: li, ratio: li ? lt / li : lt ? Infinity : 1, over: !!inst && !!trn && lt > allowedFor(li) },
    needless_refusal: refusal, internal: [...new Set(internal)], answers_first: af, gap: 0, reasons: [],
  };
  const R = s.reasons;
  if (missing.includes("trainee")) R.push("missing trainee");
  if (s.instinct_ok === true && s.trainee_ok === false) R.push(`task not done by Trainee (${et.failed.join("; ").slice(0, 160)})`);
  if (s.instinct_ok === false && s.trainee_ok === true) R.push("Trainee did the task, Instinct did not");
  if (xi !== null && xt !== null && xi !== xt) R.push(`different external actions (instinct: ${xi || "none"}, trainee: ${xt || "none"})`);
  if (s.shape.instinct !== s.shape.trainee && !missing.length) R.push(`shape ${s.shape.instinct} vs ${s.shape.trainee}`);
  if (refusal) R.push("needless refusal");
  if (s.length.over) R.push(`long ${lt} > ${allowedFor(li)}`);
  if (s.internal.length) R.push(`internal [${s.internal.join(", ")}]`);
  if (trn && !af) R.push("not answer-first");
  if (s.rubric.trainee.length) R.push(`rubric [${s.rubric.trainee.join(", ")}]`);
  s.gap = (s.instinct_ok === true && s.trainee_ok === false ? 10 : 0) + (xi !== null && xt !== null && xi !== xt ? 8 : 0) + (refusal ? 5 : 0) + (s.shape.instinct !== s.shape.trainee && !missing.length ? 2 : 0) +
    (s.length.over ? 2 : 0) + (s.internal.length ? 3 : 0) + (trn && !af ? 1 : 0) + s.rubric.trainee.length * 0.5 + (missing.includes("trainee") ? 10 : 0);
  return s;
}

// Redaction for anything written out of a run: Instinct replies come from the owner's own signed-in machine.
export function redact(text: string, keep: string): string {
  const k = keep.toLowerCase();
  return String(text ?? "")
    .replace(/\bhttps?:\/\/\S+/g, "[link]").replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[email]")
    .replace(/(?:\+?\d[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone]").replace(/\b\d{5,}\b/g, "[number]")
    .replace(/(?<=[^.!?\s]\s+)[A-Z][a-zA-Z'-]{2,}/g, (w) => (k.includes(w.toLowerCase()) ? w : "[name]"));
}

export interface Summary {
  prompts: number; scored: number; trainee_answered: number; trainee_ok_by_route: Record<string, { n: number; ok: number }>; missing: { instinct: number; trainee: number };
  task_ok: { instinct: number; trainee: number; manual: number }; same_task: number; mirror: number; mirror_rate: number;
  needless_refusals: number; long: number; mean_length_ratio: number; internal: number; not_answers_first: number;
  rubric: { trainee: Record<string, number>; instinct: Record<string, number> }; by_category: Record<string, { n: number; mirror: number; trainee_ok: number; instinct_ok: number }>;
}
export function summarize(set: MirrorPrompt[], scores: PromptScore[], routes: Map<string, string | undefined> = new Map()): Summary {
  const rules = () => Object.fromEntries(RULES.map((r) => [r, 0])) as Record<RuleId, number>;
  const s: Summary = { prompts: set.length, scored: scores.filter((x) => !x.missing.length).length, trainee_answered: scores.filter((x) => !x.missing.includes("trainee")).length, trainee_ok_by_route: {}, missing: { instinct: scores.filter((x) => x.missing.includes("instinct")).length, trainee: scores.filter((x) => x.missing.includes("trainee")).length },
    task_ok: { instinct: scores.filter((x) => x.instinct_ok === true).length, trainee: scores.filter((x) => x.trainee_ok === true).length, manual: scores.filter((x) => x.trainee_ok === null && !x.missing.includes("trainee")).length },
    same_task: scores.filter((x) => x.same_task).length, mirror: scores.filter((x) => x.mirror).length, mirror_rate: 0,
    needless_refusals: scores.filter((x) => x.needless_refusal).length, long: scores.filter((x) => x.length.over).length, mean_length_ratio: 0,
    internal: scores.filter((x) => x.internal.length).length, not_answers_first: scores.filter((x) => !x.missing.includes("trainee") && !x.answers_first).length,
    rubric: { trainee: rules(), instinct: rules() }, by_category: {} };
  const both = scores.filter((x) => !x.missing.length && Number.isFinite(x.length.ratio));
  s.mean_length_ratio = both.length ? both.reduce((a, x) => a + x.length.ratio, 0) / both.length : 0;
  s.mirror_rate = s.scored ? s.mirror / s.scored : 0;
  for (const x of scores) {
    if (!x.missing.includes("trainee")) { const k = routes.get(x.id) ?? "unknown", v = s.trainee_ok_by_route[k] ??= { n: 0, ok: 0 }; v.n++; if (x.trainee_ok) v.ok++; }
    for (const r of x.rubric.trainee) s.rubric.trainee[r]++;
    for (const r of x.rubric.instinct) s.rubric.instinct[r]++;
    const c = s.by_category[x.category] ??= { n: 0, mirror: 0, trainee_ok: 0, instinct_ok: 0 };
    c.n++; if (x.mirror) c.mirror++; if (x.trainee_ok) c.trainee_ok++; if (x.instinct_ok) c.instinct_ok++;
  }
  return s;
}

// The gaps as candidate held-out cases (evals/career/d054-items-7-9.json item shape plus where they came from).
export function gapCases(set: MirrorPrompt[], scores: PromptScore[], lines: { instinct: Map<string, Line>; trainee: Map<string, Line> }, top: number) {
  const byId = new Map(set.map((p) => [p.id, p]));
  return worst(scores, top).map((x) => {
    const p = byId.get(x.id)!, keep = [p.prompt, ...p.setup.turns, p.persona].join(" ");
    return { id: `MG-${p.id}`, category: p.category, persona: p.persona, turns: [...p.setup.turns, p.prompt], must: p.task.must_do, must_not: p.task.must_not,
      outcome_check: p.task.outcome_check, source: "evals/mirror prompts.v1 gap", gap: x.reasons,
      trainee_excerpt: redact((lines.trainee.get(x.id)?.reply ?? "").slice(0, 280), keep), instinct_excerpt: redact((lines.instinct.get(x.id)?.reply ?? "").slice(0, 280), keep) };
  });
}
export const worst = (scores: PromptScore[], top: number) => [...scores].filter((x) => x.gap > 0).sort((a, b) => b.gap - a.gap || a.id.localeCompare(b.id)).slice(0, top);

export async function readLines(path: string): Promise<Map<string, Line>> {
  const out = new Map<string, Line>();
  for (const l of (await Deno.readTextFile(path)).split("\n")) if (l.trim()) { const x = JSON.parse(l); out.set(String(x.id), { ...x, reply: String(x.reply ?? "") }); }
  return out;
}

if (import.meta.main) {
  const a = Deno.args, opt = (n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const ip = opt("--instinct"), tp = opt("--trainee");
  if (!tp) { console.log("usage: score.ts --trainee <jsonl> [--instinct <jsonl>] [--set <jsonl>] [--only-both] [--json out] [--gaps out] [--top 50]"); Deno.exit(2); }
  const set = await loadSet(opt("--set") ?? SET_PATH), inst = ip ? await readLines(ip) : new Map<string, Line>(), trn = await readLines(tp), top = Number(opt("--top") ?? 50);
  // --only-both: score the prompts both sides answered (a partial run); otherwise every prompt counts and a missing side is a gap.
  // Without --instinct (Trainee only, e.g. the dry run): the prompts Trainee answered, task and rubric only, no mirror.
  if (!ip) console.log("no --instinct: Trainee-only scoring (task_ok and the rubric; same_task and mirror need both sides)");
  const pool = a.includes("--only-both") ? set.filter((p) => inst.has(p.id) && trn.has(p.id)) : !ip ? set.filter((p) => trn.has(p.id)) : set;
  const scores = pool.map((p) => scorePrompt(p, inst.get(p.id), trn.get(p.id)));
  const s = summarize(pool, scores, new Map([...trn].map(([k, v]) => [k, v.route])));
  console.log(`MIRROR prompts=${s.prompts} both_sides=${s.scored} trainee_answered=${s.trainee_answered} missing(instinct=${s.missing.instinct} trainee=${s.missing.trainee}) task_ok(instinct=${s.task_ok.instinct} trainee=${s.task_ok.trainee} manual=${s.task_ok.manual}) ` +
    `same_task=${s.same_task} mirror=${s.mirror} (${(100 * s.mirror_rate).toFixed(1)}%) needless_refusals=${s.needless_refusals} long=${s.long} mean_length_ratio=${s.mean_length_ratio.toFixed(2)} internal=${s.internal} not_answers_first=${s.not_answers_first}`);
  console.log(`trainee task_ok by route: ${Object.entries(s.trainee_ok_by_route).map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(", ")}`);
  console.log(`rubric (trainee): ${Object.entries(s.rubric.trainee).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ") || "clean"}`);
  console.log(`rubric (instinct, reference): ${Object.entries(s.rubric.instinct).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ") || "clean"}`);
  console.log("by category (mirror / trainee ok / instinct ok / n):");
  for (const [c, v] of Object.entries(s.by_category).sort()) console.log(`  ${c.padEnd(22)} ${String(v.mirror).padStart(3)} ${String(v.trainee_ok).padStart(3)} ${String(v.instinct_ok).padStart(3)} / ${v.n}`);
  console.log(`worst ${top} gaps:`);
  for (const x of worst(scores, top)) console.log(`  ${x.id.padEnd(24)} gap=${x.gap.toFixed(1).padStart(4)} ${x.reasons.join("; ").slice(0, 220)}`);
  const j = opt("--json"); if (j) await Deno.writeTextFile(j, JSON.stringify({ summary: s, scores }, null, 1) + "\n");
  const g = opt("--gaps"); if (g) await Deno.writeTextFile(g, JSON.stringify({ version: "mirror-gaps-1", note: "Candidate held-out cases from the mirror run's worst gaps; reply excerpts redacted. Review by hand before adding any to a held-out set.", items: gapCases(pool, scores, { instinct: inst, trainee: trn }, top) }, null, 1) + "\n");
}
