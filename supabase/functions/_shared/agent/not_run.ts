// A tool call that did not run has no result (D-024; benchmark gap #5: live-12 C19's find_people was refused for "missing
// required input: school, employers" and the reply said "The search found no public page ..."; C1's remember_instruction was
// refused the same way and nothing said so). Pure. The loop (loop.ts) uses it three ways:
//   1. a call missing a required input is refused before it runs, with the inputs named and described from the tool's own
//      schema, and the brain may call it ONCE more with them filled; a second refusal ends that tool for the turn;
//   2. a sentence that reports a result from such a call ("found nobody", "I couldn't find any ...", "turned up zero", "you have
//      applied to 3 roles") is attributed to it by the call's own subject (its domain and the words of its arguments) and put
//      back to the brain once, then removed by code; a sentence a tool that DID run this turn supports is never removed;
//   3. the reply says that call did not run (or, when its retry ran and threw, that it failed): unless the reply already admits
//      it in so many words, code adds the one plain line (notRunLine). Architect ruling (2026-11-16): that line is a fact stated
//      by code under D-024, like STANDING_REFUSED, not reply prose.
import { pieces } from "./reply_guards.ts";

// What each tool's result is about (its domain), and for a tool that reads the person's own record, the states a sentence can
// only know from that record. A sentence is attributed to a refused call only through its own tool's entry here.
const SUBJECT: Record<string, { domain: RegExp; states?: RegExp; label: string }> = {
  find_people: { label: "people search", domain: /\b(?:alumni|alum|people|persons?|leads?|contacts?|profiles?|nobody|anybody|no one|anyone|someone|somebody)\b/i },
  search_jobs: { label: "job search", domain: /\b(?:postings?|roles?|jobs?|internships?|openings?|positions?|listings?)\b/i },
  check_posting_open: { label: "open check on that posting", domain: /\b(?:posting|role|job|internship|listing)\b/i, states: /\b(?:is|are) (?:still )?(?:open|closed|live|accepting)\b|\bstill (?:open|accepting|live)\b|\bhas closed\b/i },
  inspect_apply_flow: { label: "read of that application", domain: /\b(?:requirements?|questions?|form|application)\b/i, states: /\b(?:requires|asks for|asks)\b/i },
  read_application_mail: { label: "mail check", domain: /\b(?:applications?|applied|confirmations?|emails?|inbox|mail(?:box)?)\b/i, states: /\byou(?:'ve| have)? (?:applied|submitted)\b|\b(?:are|is) (?:still )?under review\b|\bconfirm(?:ed|ation)\b/i },
  list_applications: { label: "check of your applications", domain: /\b(?:applications?|applied|submitted|tracker)\b/i, states: /\byou(?:'ve| have)? (?:applied|submitted)\b|\b(?:are|is) (?:still )?under review\b|\byour applications? (?:is|are)\b/i },
  remember_instruction: { label: "save of that instruction", domain: /\b(?:instructions?|rules?|preferences?|gpa)\b/i, states: /\b(?:saved|kept|noted|remembered|will remember)\b/i },
  add_profile_fact: { label: "save of that fact", domain: /\b(?:facts?|profile|record)\b/i, states: /\b(?:saved|added|noted)\b/i },
  research_company: { label: "company research", domain: /\b(?:sources?|research|reports?|pages?)\b/i },
  research_market: { label: "market research", domain: /\b(?:sources?|research|range|rates?|figures?)\b/i },
  research_career_question: { label: "research", domain: /\b(?:sources?|research|guides?)\b/i },
};
export const labelOf = (name: string): string => SUBJECT[name]?.label ?? `${name.replace(/_/g, " ")} step`;
// A result: something found, not found, counted or seen. "Couldn't find", "unable to find", "no", "zero" and "none" are results
// (architect ruling, 2026-11-16), never admissions that the action did not happen.
const RESULT = /\b(?:found|finds?|turned up|came back|returned|shows?|showed|shown|matched|searched|checked|looked|results?|see|saw|seen|spotted|no(?:thing|body| one)?|none|zero|could(?:n't| not) (?:find|see|locate|spot)|unable to (?:find|see|locate)|was(?:n't| not) able to (?:find|see|locate)|\d+)\b/i;
// An admission: an explicit statement that the action did not happen.
const ADMIT = /\b(?:did(?:n't| not) (?:run|search|check|look(?: it)? up|save|read|happen|go through)|(?:was|were)(?:n't| not) (?:run|searched|checked|saved|read)|could(?:n't| not) run|never ran|has(?:n't| not) run|not run)\b/i;
const FAILED = /\b(?:failed|errored|broke|went wrong|did(?:n't| not) (?:work|go through|finish|complete))\b/i;
// A boundary line ("Nobody was contacted.", "Nothing was sent.") reports what Trainee did not do, not a tool's result.
const BOUNDARY = /^[^,;]*\b(?:contacted|messaged|sent|emailed|reached out|submitted|applied for you)\b[^,;]*$/i;
const OFFER = /^\W*(?:i can|i could|want me|should i|shall i|if you|would you like|tell me|send me|give me|once you|here are|try)\b/i;

type Call = { name: string; ok: boolean };
// Tools with at least one failed call and no successful one this turn.
export function neverRan(calls: Call[]): string[] {
  const ok = new Set(calls.filter((c) => c.ok).map((c) => c.name));
  return [...new Set(calls.filter((c) => !c.ok && !ok.has(c.name)).map((c) => c.name))];
}
// The words of the refused calls' own arguments (a school, an employer, a query), for attribution.
const argWords = (args: unknown[]): RegExp | null => {
  const words = args.flatMap((a) => a && typeof a === "object" ? Object.values(a as Record<string, unknown>).flatMap((v) => Array.isArray(v) ? v : [v]) : [])
    .filter((v): v is string => typeof v === "string").flatMap((v) => v.split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 4);
  return words.length ? new RegExp(`\\b(?:${[...new Set(words)].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i") : null;
};
// The sentences (piece indexes, reply_guards.ts pieces) that report a result from a call that never ran. `ran`: the tools that
// ran this turn; a sentence their domain covers is theirs and is kept. `args`: the refused calls' inputs, by tool.
export function unranReports(reply: string, never: string[], ran: string[] = [], args: Record<string, unknown[]> = {}): number[] {
  const refused = never.filter((n) => SUBJECT[n]);
  if (!refused.length) return [];
  const theirs = ran.filter((n) => SUBJECT[n] && !never.includes(n));
  const out: number[] = [];
  pieces(reply).forEach((p, i) => {
    const t = p.text.trim();
    if (!t || /\?["')\]]*$/.test(t) || ADMIT.test(t) || OFFER.test(t) || BOUNDARY.test(t)) return;
    if (theirs.some((n) => SUBJECT[n].domain.test(t))) return; // a run tool's result covers it
    const hit = refused.some((n) => {
      const s = SUBJECT[n], own = argWords(args[n] ?? []);
      const about = s.domain.test(t) || (own ? own.test(t) : false);
      return about && (RESULT.test(t) || (s.states ? s.states.test(t) : false));
    });
    if (hit) out.push(i);
  });
  return out;
}
// Whether the reply already says, in so many words, that this call did not run (or that it failed, when it ran and threw). The
// admission must be about the call: its label or its domain in the same sentence.
export function saysNotRun(reply: string, name: string, failed = false): boolean {
  const s = SUBJECT[name], words = labelOf(name).split(/\s+/).filter((w) => w.length >= 4);
  const about = (t: string) => (s ? s.domain.test(t) : false) || words.some((w) => new RegExp(`\\b${w}`, "i").test(t)) || /\b(?:search|check|save|lookup|look-up)\b/i.test(t);
  return pieces(reply).some((p) => (failed ? FAILED.test(p.text) || ADMIT.test(p.text) : ADMIT.test(p.text)) && about(p.text));
}
export function notRunLine(name: string, failed = false): string {
  return failed ? `The ${labelOf(name)} failed this time, so there is no result from it.` : `The ${labelOf(name)} did not run this time, so there is no result from it.`;
}

// The refusal the brain reads for a call missing required inputs: each input named with its schema description; the first
// refusal allows one more call, the second ends that tool for this turn.
export function missingInputMessage(t: { name: string; input_schema: { properties: Record<string, unknown> } }, missing: string[], attempt: number): string {
  if (!missing.length) return `Not run: this tool was already refused twice this turn for a missing input and will not run again; do not call it again. Say plainly that the ${labelOf(t.name)} did not run (never describe a result from it).`;
  const what = missing.map((k) => { const d = (t.input_schema.properties?.[k] as { description?: unknown } | undefined)?.description; return typeof d === "string" && d.trim() ? `${k} (${d.trim().slice(0, 160)})` : k; }).join("; ");
  const head = `missing required input: ${missing.join(", ")}. Not run: the ${labelOf(t.name)} did not run and has no result.`;
  return attempt <= 1
    ? `${head} Needed: ${what}. Fill ${missing.length > 1 ? "them" : "it"} from their message, this conversation or their confirmed record and call it once more. If they did not give it, do not call it again: say plainly that the ${labelOf(t.name)} did not run, and ask for the one missing thing.`
    : `${head} This was the second try, so it will not run this turn: do not call it again. Say plainly that the ${labelOf(t.name)} did not run (never describe a result from it), and ask for the one missing thing: ${what}.`;
}
