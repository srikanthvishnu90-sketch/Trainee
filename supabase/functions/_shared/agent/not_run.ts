// A tool call that did not run has no result (D-024; benchmark gap #5: live-12 C19's find_people was refused for "missing
// required input: school, employers" and the reply said "The search found no public page ..."; C1's remember_instruction was
// refused the same way and nothing said so). Pure. The loop (loop.ts) uses it three ways:
//   1. a call missing a required input is refused before it runs, with the inputs named and described from the tool's own
//      schema, and the brain may call it ONCE more with them filled; a second refusal ends that tool for the turn;
//   2. a reply that reports a result from such a tool that never succeeded this turn ("found nobody", "no postings") is put back
//      to the brain once, then those sentences are removed by code;
//   3. a tool refused for a missing input that never ran is said not to have run: the brain is asked once, then code adds the
//      one plain line (notRunLine) when the reply still does not say so.
import { pieces } from "./reply_guards.ts";

// What each tool's result is about, so a sentence that reports one can be told from the rest of the reply. A tool not listed
// here is never judged for result talk (rule 3 still holds for it).
const ABOUT: Record<string, RegExp> = {
  find_people: /\b(?:people|persons?|alumni|leads?|contacts?|profiles?|engineers?|employees?|nobody|no one|anyone|someone|names?)\b/i,
  search_jobs: /\b(?:postings?|roles?|jobs?|internships?|openings?|positions?|listings?|matches)\b/i,
  check_posting_open: /\b(?:open|closed|still (?:accepting|live|listed|up)|deadline)\b/i,
  inspect_apply_flow: /\b(?:requires?|requirements?|questions?|asks?|form)\b/i,
  read_application_mail: /\b(?:applications?|applied|confirmations?|emails?|inbox|mail(?:box)?)\b/i,
  list_applications: /\b(?:applications?|applied|record|tracker)\b/i,
  research_company: /\b(?:sources?|research|pages?|reports?|data|figures?)\b/i,
  research_market: /\b(?:sources?|research|pages?|reports?|data|figures?|range|rates?)\b/i,
  research_career_question: /\b(?:sources?|research|guides?|pages?)\b/i,
  remember_instruction: /\b(?:instructions?|rules?|preferences?)\b/i,
};
const RESULT = /\b(?:found|finds?|turned up|came back|returned|shows?|showed|shown|matched|searched|checked|looked|read|results?|no(?:thing|body| one)?|none|zero|saved|kept|noted|remembered|is (?:open|closed)|are (?:open|closed))\b/i;
// A sentence that already says the call did not run, or could not be done.
const NOT_RUN = /\b(?:did(?:n't| not) run|not run|could(?:n't| not)|was(?:n't| not) able|were(?:n't| not) able|unable|went wrong|failed|did(?:n't| not) (?:go through|work|finish|complete|happen)|nothing (?:was )?(?:changed|saved|searched|checked|run))\b/i;
// A boundary line ("Nobody was contacted.", "Nothing was sent.") reports what Trainee did not do, not a tool's result.
const BOUNDARY = /\b(?:contacted|messaged|sent|emailed|reached out|submitted|applied)\b/i;
const OFFER = /^\W*(?:i can|i could|want me|should i|shall i|if you|would you like|tell me|send me|give me|once you)\b/i;

const LABEL: Record<string, string> = {
  find_people: "people search", search_jobs: "job search", check_posting_open: "open check on that posting", inspect_apply_flow: "read of that application",
  read_application_mail: "mail check", list_applications: "check of your applications", remember_instruction: "save of that instruction",
  add_profile_fact: "save of that fact", correct_profile_fact: "correction", tailor_resume: "resume build", create_file: "file",
  research_company: "company research", research_market: "market research", research_career_question: "research",
};
export const labelOf = (name: string): string => LABEL[name] ?? `${name.replace(/_/g, " ")} step`;

type Call = { name: string; ok: boolean };
// Tools with at least one failed call and no successful one this turn.
export function neverRan(calls: Call[]): string[] {
  const ok = new Set(calls.filter((c) => c.ok).map((c) => c.name));
  return [...new Set(calls.filter((c) => !c.ok && !ok.has(c.name)).map((c) => c.name))];
}
// The sentences (piece indexes, reply_guards.ts pieces) that report a result from a tool that never ran.
export function unranReports(reply: string, never: string[]): number[] {
  const about = never.map((n) => ABOUT[n]).filter(Boolean);
  if (!about.length) return [];
  const out: number[] = [];
  pieces(reply).forEach((p, i) => {
    const t = p.text.trim();
    if (!t || /\?["')\]]*$/.test(t) || NOT_RUN.test(t) || OFFER.test(t) || BOUNDARY.test(t)) return;
    if (RESULT.test(t) && about.some((a) => a.test(t))) out.push(i);
  });
  return out;
}
// Whether the reply says that this tool's action did not run.
export function saysNotRun(reply: string): boolean {
  return pieces(reply).some((p) => NOT_RUN.test(p.text));
}
export function notRunLine(name: string): string {
  return `The ${labelOf(name)} did not run this time, so there is no result from it.`;
}

// The refusal the brain reads for a call missing required inputs: each input named with its schema description; the first
// refusal allows one more call, the second ends that tool for this turn.
export function missingInputMessage(t: { name: string; input_schema: { properties: Record<string, unknown> } }, missing: string[], attempt: number): string {
  if (!missing.length) return `Not run: ${t.name} was already refused twice this turn for a missing input and will not run again; do not call it again. Say plainly that the ${labelOf(t.name)} did not run (never describe a result from it).`;
  const what = missing.map((k) => { const d = (t.input_schema.properties?.[k] as { description?: unknown } | undefined)?.description; return typeof d === "string" && d.trim() ? `${k} (${d.trim().slice(0, 160)})` : k; }).join("; ");
  const head = `missing required input: ${missing.join(", ")}. Not run: ${t.name} did not run and has no result.`;
  return attempt <= 1
    ? `${head} Needed: ${what}. Fill ${missing.length > 1 ? "them" : "it"} from their message, this conversation or their confirmed record and call ${t.name} once more. If they did not give it, do not call it again: say plainly that the ${labelOf(t.name)} did not run, and ask for the one missing thing.`
    : `${head} This was the second try, so ${t.name} will not run this turn: do not call it again. Say plainly that the ${labelOf(t.name)} did not run (never describe a result from it), and ask for the one missing thing: ${what}.`;
}
