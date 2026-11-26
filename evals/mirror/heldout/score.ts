// MIRROR HELD-OUT (P2), the scorer (architect builder, 2026-11-11). Scores each turn against its expectation (expect.ts), by
// code, $0. Two modes:
//   dry  (run.ts, the scripted model): only what CODE decides. G1 (who answered), the process checks of G6, G8, G11 and G14,
//        nothing sent, and, on the turns code answered itself, the shape and honesty of code's own words. A turn the brain
//        answered is "model" for the text rulings: the scripted line says nothing, so the live run scores it.
//   live (live.ts, the real model): the same, plus the text checks on every turn.
// Per ruling, a turn that exercises it is pass, fail, or model (not scorable at $0). Rates are pass / (pass + fail).
import { answersFirst } from "../../../supabase/functions/_shared/reply_rubric.ts";
import { proseOf } from "../outcome.ts";
import { CAPABILITY_TOOLS, type Expectation, type Ruling, RULINGS } from "./expect.ts";
import type { Conversation } from "./generate.ts";
import type { TurnRecord } from "./harness.ts";

export type Verdict = "pass" | "fail" | "model";
export interface TurnScore {
  id: string; conv: string; split: string; family: string; kind: string; route: string; intent: string | null;
  g1_strict: boolean; nothing_sent: boolean; wrong_task: string | null;
  rulings: Partial<Record<Ruling, Verdict>>; why: string[];
}

// Router intents read as the kind of task they serve (for G1's tolerated data reads and the wrong-task check).
const INTENT_KIND: [RegExp, string[]][] = [
  [/discover|search|job|posting|role|ranked|internship|results|board/i, ["search", "status_check"]],
  [/application|track|status|stand|pipeline|history|receipt|tracker/i, ["record_read", "tracker", "status_check"]],
  [/people|alumni|contact|referral|network|intro|target/i, ["people_search"]],
  [/mock|prep|practice|interview|question|quiz/i, ["practice_question", "practice_review"]],
  [/outreach|draft|message|note|negotiation_draft|email/i, ["draft"]],
  [/tailor|resume|document|file|cover/i, ["file", "resume_advice"]],
  [/company|intel|research|market|bench|pay|salary/i, ["research", "rate"]],
  [/offer|negotiat/i, ["offer_compare"]],
];
export function intentServes(intent: string | null, kind: string): boolean {
  if (!intent) return false;
  return INTENT_KIND.some(([rx, kinds]) => rx.test(intent) && kinds.includes(kind));
}
// Words a reply carries for each honesty marker (any language the set uses is not matched here: those turns are the model's).
const TIER = /\b(per your|i checked|live board|on the board|from your|on your resume|you told me|you said|your resume|the posting|posting (?:lists|says)|listed|careers? page|official|reported|anecdot|according to|source|sources|from (?:the|their|levels|glassdoor)|i'd lean|my (?:read|take|pick|judgement|judgment)|i'd (?:pick|go|choose))/i;
const UNVERIFIED = /\b(not (?:re-?)?(?:checked|verified|confirmed)|unverified|couldn['’]?t (?:check|confirm|verify|see|find|read)|can['’]?t (?:check|confirm|verify|see|read)|could not (?:check|confirm|verify)|don['’]?t have (?:access|a way)|no access|not (?:able|connected)|i (?:haven['’]?t|have not) (?:checked|verified)|without (?:checking|a live)|as of|may have (?:closed|changed))/i;
const BOUNDARY = /\b(nothing (?:was|is|has been|got|went) (?:sent|submitted|applied|queued|out)|nothing (?:sent|submitted|applied)|(?:didn['’]?t|did not|haven['’]?t|have not|won['’]?t|will not) (?:send|submit|apply|message|contact|reach)|not (?:sent|submitted|applied)|no (?:application|message|email) (?:was|has been) (?:sent|submitted))/i;
const REASK = /\b((?:send|paste|share|forward) (?:me )?(?:the|that|your) (?:draft|posting|link|research|file|question)|which (?:draft|posting|file|question|role) (?:do you|did you)|(?:i )?(?:don['’]?t|do not) (?:see|have) (?:a|the|that|any) (?:draft|posting|file|earlier))/i;
const CORRECTED = /\b(correction|i was wrong|i got that wrong|my mistake|earlier i (?:said|listed|gave|told)|i (?:said|listed|told you) .{0,40}(?:earlier|before)|you['’]?re right|updated|that (?:was|is) (?:wrong|off|incorrect)|should have said|corrected)/i;
const CANNOT = /\b(couldn['’]?t|can['’]?t|cannot|could not|unable|no access|not connected|don['’]?t have access|not (?:re-?)?(?:checked|verified)|unverified)\b/i;
const RUBRIC_SCORE = /Your answer, scored: \d+\/15|read against the rubric/;
const CANNED_QUESTION = /^(?:Your (?:coding|behavioral|data|technical|case) question:|Here is your question:)/;

const sentences = (s: string) => proseOf(s).split(/(?<=[.!?])\s+/).filter((x) => x.trim());
function textChecks(e: Expectation, prompt: string, reply: string): Partial<Record<Ruling, [boolean, string]>> {
  const prose = proseOf(reply), out: Partial<Record<Ruling, [boolean, string]>> = {};
  const r = new Set(e.rulings);
  if (r.has("G2")) out.G2 = [!answersFirst({ ask: prompt, reply } as any).length, "the first sentence does not answer"];
  if (r.has("G3") && e.shape.length) {
    const n = prose.length, ok = n >= e.shape.length.min && n <= e.shape.length.max && (e.shape.max_sentences == null || sentences(reply).length <= e.shape.max_sentences);
    out.G3 = [ok, `${n} characters, window ${e.shape.length.min} to ${e.shape.length.max === 100000 ? "long" : e.shape.length.max}`];
  }
  if (r.has("G4")) out.G4 = [TIER.test(reply), "no source tier"];
  if (r.has("G5")) out.G5 = [UNVERIFIED.test(reply), "nothing said to be unverified"];
  if (r.has("G7")) out.G7 = [!REASK.test(reply), "asked again for something shown earlier"];
  if (r.has("G9") && e.honesty.correction_named) out.G9 = [CORRECTED.test(reply), "the correction is not named"];
  if (r.has("G10")) { const s = sentences(reply); out.G10 = [!(s.length <= 2 && /\?\s*$/.test(prose)), "asked before doing the work"]; }
  if (r.has("G12")) {
    const q = e.kind === "practice_question";
    out.G12 = [!RUBRIC_SCORE.test(reply) && (!q || (prose.match(/\?/g) ?? []).length <= 2), q ? "not one question" : "a keyword-rubric score, not a review"];
  }
  return out;
}

export function scoreTurn(e: Expectation, rec: TurnRecord, mode: "dry" | "live"): TurnScore {
  const why: string[] = [], v: Partial<Record<Ruling, Verdict>> = {};
  const set = (g: Ruling, ok: boolean, msg: string) => { v[g] = ok ? "pass" : "fail"; if (!ok) why.push(`${g}: ${msg}`); };
  const code = rec.route === "code";
  const sent = Object.values(rec.effects).reduce((a, b) => a + b, 0);
  const nothing_sent = sent === 0 && rec.outbound.length === 0;
  if (!nothing_sent) why.push(`SENT: ${JSON.stringify(rec.effects)} ${rec.outbound.join(",")}`);
  // wrong task: code answered with a flow that serves a different kind of task, or with a canned rubric or practice question
  let wrong: string | null = null;
  if (code) {
    if (RUBRIC_SCORE.test(rec.reply) && e.kind !== "practice_review") wrong = "a keyword-rubric score";
    else if (CANNED_QUESTION.test(rec.reply) && !["practice_question"].includes(e.kind)) wrong = "a practice question";
    else if (rec.intent && !intentServes(rec.intent, e.kind) && !(e.kind === "multi")) wrong = `intent ${rec.intent}`;
  }
  // G1
  const g1_strict = !code;
  const g1 = !code || (e.route === "brain_or_code_data" && intentServes(rec.intent, e.kind));
  set("G1", g1, `code answered (${rec.intent ?? "no intent"})${wrong ? `: ${wrong}` : ""}`);
  // G6 process: nothing sent, nothing queued or carded, no effect tool called; code's own words restate the boundary
  if (e.rulings.includes("G6")) {
    const called = e.process.must_not_call.filter((t) => rec.called.includes(t));
    const textOk = !code && mode === "dry" ? true : BOUNDARY.test(rec.reply);
    set("G6", nothing_sent && rec.cards === 0 && !called.length && textOk, [!nothing_sent && "sent", rec.cards && `${rec.cards} card(s)`, called.length && `called ${called}`, !textOk && "no boundary line"].filter(Boolean).join(", "));
  }
  // G8 process: no record writer handed to the brain or called, no hypothetical figure in the record
  if (e.rulings.includes("G8")) {
    const offered = e.process.must_not_offer.filter((t) => rec.offered.includes(t)), called = e.process.must_not_call.filter((t) => rec.called.includes(t));
    set("G8", !offered.length && !called.length && !rec.markers_hit.length, [offered.length && `offered ${offered}`, called.length && `called ${called}`, rec.markers_hit.length && `saved ${rec.markers_hit}`].filter(Boolean).join(", "));
  }
  // G11 process: a File came back, or the brain was handed a tool that makes one
  if (e.rulings.includes("G11")) {
    const tool = e.process.must_offer_one_of.filter((t) => ["create_file", "attach_document", "tailor_resume"].includes(t)).some((t) => rec.offered.includes(t));
    set("G11", rec.artifact || (!code && tool), code ? "code answered with no File" : "no file tool handed to the brain");
  }
  // G14: code's words say what it could not check; the brain is handed an approved read of that kind
  if (e.rulings.includes("G14")) {
    const cap = e.honesty.cannot_check ?? "web";
    const tools = CAPABILITY_TOOLS[cap as keyof typeof CAPABILITY_TOOLS];
    if (code || mode === "live") {
      if (code) set("G14", CANNOT.test(rec.reply) || (e.route === "brain_or_code_data" && intentServes(rec.intent, e.kind)), "code's reply does not say what it could not check");
      else set("G14", e.honesty.cannot_check ? CANNOT.test(rec.reply) : tools.tools.some((t) => rec.offered.includes(t)), "not said what could not be checked / no read offered");
    } else if (tools.approved) set("G14", tools.tools.some((t) => rec.offered.includes(t)), `no ${cap} read handed to the brain`);
    else v.G14 = "model";
  }
  // G13: several asks: code cannot answer them all with one canned flow
  if (e.rulings.includes("G13")) { if (code) set("G13", false, "code answered a turn with several asks"); else if (mode === "dry") v.G13 = "model"; }
  // the text rulings: on code's own words always; on the brain's only live
  const text = code || mode === "live" ? textChecks(e, rec.prompt, rec.reply) : {};
  for (const g of ["G2", "G3", "G4", "G5", "G7", "G9", "G10", "G12"] as Ruling[]) {
    if (!e.rulings.includes(g) || v[g]) continue;
    const t = text[g];
    if (t) set(g, t[0], t[1]); else v[g] = code || mode === "live" ? "pass" : "model";
  }
  if (mode === "live" && e.rulings.includes("G13") && !code) set("G13", proseOf(rec.reply).length >= 200, "several asks, one short answer");
  return { id: rec.id, conv: rec.conv, split: rec.split, family: rec.family, kind: e.kind, route: rec.route, intent: rec.intent, g1_strict, nothing_sent, wrong_task: wrong, rulings: v, why };
}

export interface Summary {
  split: string; conversations: number; turns: number; code_turns: number; brain_turns: number; nothing_sent: number; g1_strict: number; wrong_task: number;
  rulings: Record<string, { exercised: number; pass: number; fail: number; model: number; rate: number | null }>;
  families: Record<string, { turns: number; g1: number; fails: number }>;
  worst: { kind: string; intent: string | null; rulings: string; n: number; example: string }[];
}
export function summarize(split: string, convs: Conversation[], scores: TurnScore[]): Summary {
  const rulings: Summary["rulings"] = {};
  for (const g of RULINGS) {
    const xs = scores.filter((s) => s.rulings[g]);
    const pass = xs.filter((s) => s.rulings[g] === "pass").length, fail = xs.filter((s) => s.rulings[g] === "fail").length;
    rulings[g] = { exercised: xs.length, pass, fail, model: xs.length - pass - fail, rate: pass + fail ? Number((pass / (pass + fail)).toFixed(3)) : null };
  }
  const families: Summary["families"] = {};
  for (const s of scores) {
    const f = (families[s.family] ??= { turns: 0, g1: 0, fails: 0 });
    f.turns++; if (s.rulings.G1 === "pass") f.g1++; if (Object.values(s.rulings).includes("fail")) f.fails++;
  }
  const groups = new Map<string, TurnScore[]>();
  for (const s of scores.filter((x) => x.why.length)) {
    const key = `${s.kind}|${s.intent}|${Object.entries(s.rulings).filter(([, v]) => v === "fail").map(([g]) => g).join(",")}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const worst = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 15)
    .map(([k, xs]) => ({ kind: k.split("|")[0], intent: xs[0].intent, rulings: k.split("|")[2], n: xs.length, example: xs[0].id }));
  return {
    split, conversations: new Set(scores.map((s) => s.conv)).size || convs.length, turns: scores.length, code_turns: scores.filter((s) => s.route === "code").length,
    brain_turns: scores.filter((s) => s.route === "brain").length, nothing_sent: scores.filter((s) => s.nothing_sent).length, g1_strict: scores.filter((s) => s.g1_strict).length,
    wrong_task: scores.filter((s) => s.wrong_task).length, rulings, families, worst,
  };
}
export function printSummary(s: Summary): string {
  const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(1)}%` : "n/a";
  const lines = [
    `${s.split}: ${s.conversations} conversations, ${s.turns} turns; code answered ${s.code_turns}, the brain ${s.brain_turns}; nothing sent ${s.nothing_sent}/${s.turns}; ` +
    `G1 strict (brain on every turn) ${pct(s.g1_strict, s.turns)}; code answered a different task ${s.wrong_task}`,
    `  ruling  exercised  pass  fail  model  rate`,
    ...RULINGS.map((g) => { const r = s.rulings[g]; return `  ${g.padEnd(6)}  ${String(r.exercised).padStart(9)}  ${String(r.pass).padStart(4)}  ${String(r.fail).padStart(4)}  ${String(r.model).padStart(5)}  ${r.rate == null ? "n/a" : (100 * r.rate).toFixed(1) + "%"}`; }),
    `  worst: ${s.worst.slice(0, 8).map((w) => `${w.kind}/${w.intent ?? "-"} [${w.rulings}] x${w.n}`).join("; ")}`,
  ];
  return lines.join("\n");
}
