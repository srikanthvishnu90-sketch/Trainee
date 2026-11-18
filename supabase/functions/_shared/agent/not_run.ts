// A tool call that did not run has no result (D-024; benchmark gap #5: live-12 C19's find_people was refused for "missing
// required input: school, employers" and the reply said "The search found no public page ..."; C1's remember_instruction was
// refused the same way and nothing said so). Pure and structural: no sentence of the reply is classified by its words.
//   1. a call missing a required input is refused before it runs, with each input named and described from the tool's own
//      schema, and the brain may call it ONCE more; a second refusal ends that tool for the turn;
//   2. the refusal is a structured fact for the brain ({"status":"not_run","not_run":"<label>"}), never a result;
//   3. when a refused call never ran (per call: unrunCalls), code ALWAYS adds its line (notRunLine) wherever the turn's text goes
//      out (the reply, and a shown text and its parts), whatever the reply says; a retry that ran and threw is said to have failed. Architect ruling (2026-11-16): that line is a fact stated by code under D-024,
//      like STANDING_REFUSED, not reply prose. A claim in the reply that would need the refused call's result is left to the
//      reply verifier (PR #849): a refused call contributes no evidence, so such a claim has no support there.

import { leakedWords } from "./reply_guards.ts";

// Every tool the brain can be offered, by a human label (never its name). Closed: a tool not here is the "requested step".
export const LABELS: Readonly<Record<string, string>> = Object.freeze({
  add_profile_fact: "save of that fact", attach_document: "file attachment", brief_from_invite: "interview brief from that invite",
  career_path_answer: "career path lookup", check_posting_open: "open check on that posting", compare_paths: "path comparison",
  confirm_profile_fact: "confirmation of that fact", contact_list: "contact list lookup", correct_profile_fact: "correction to that fact",
  create_file: "file creation", draft_email_reply: "email reply drafting", draft_followup: "message drafting", draft_outreach: "outreach drafting",
  export_tracker: "tracker export", find_email: "inbox search", find_people: "people search", forget_instruction: "removal of that instruction",
  get_interview_questions: "interview questions lookup", get_job_alerts: "job alerts lookup", get_memory: "read of what you told me",
  get_outreach_conversations: "outreach conversations lookup", get_posting: "read of that posting", get_profile: "read of your profile",
  get_situation: "read of where things stand", inspect_apply_flow: "read of that application", interview_brief: "interview brief build",
  list_applications: "check of your applications", offer_benchmark: "offer benchmark lookup", open_record_file: "file build from your records",
  queue_applications: "apply queue update", read_application_mail: "mail check", read_resume: "resume read", recall: "recall of our earlier messages",
  record_list_cost: "list cost update", referral_map: "referral map lookup", remember_instruction: "save of that instruction",
  research_career_question: "career research", research_company: "company research", research_market: "market research",
  save_resume_persona: "save of that resume version", score_interview_answer: "answer scoring", search_jobs: "job search",
  set_job_alerts: "job alert setup", set_outreach_signature: "signature update", set_resume_contact: "resume contact update",
  set_weekly_digest: "weekly digest setup", stop_job_alerts: "job alert stop", tailor_resume: "resume build", track_application: "tracker update",
  use_resume_persona: "switch of resume version", verify_contacts: "contact check", where_do_i_stand: "read of where things stand",
});
export const labelOf = (name: string): string => LABELS[name] ?? "requested step";

// One entry per tool call this turn, in order (loop.ts keeps it on the turn's record): what it was asked and how it ended.
export type CallOutcome = "refused" | "ok" | "threw" | "asked";
// missing: the required inputs a refused call lacked (loop.ts), for the rule that resolves it (unrunCalls).
export interface CallRec { name: string; input: Record<string, unknown>; outcome: CallOutcome; missing?: string[] }
const filled = (v: unknown) => v !== undefined && v !== null && !(typeof v === "string" && !v.trim()) && !(Array.isArray(v) && !v.length);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b); // (only for code's own lists of subject words)
// Arguments are compared as VALUES, never as JSON (review rv5): a string and a one-item list are the same value, and case,
// whitespace, order and repeats do not matter. A number or a true/false (a count, a limit) is not a value that tells two calls
// apart (norm gives null).
const norm = (v: unknown): string[] | null => typeof v === "number" || typeof v === "boolean" ? null
  : [...new Set((Array.isArray(v) ? v : [v]).filter(filled).map((x) => String(x).trim().toLowerCase().replace(/\s+/g, " ")))].sort();
const sameValue = (a: unknown, b: unknown) => { const x = norm(a), y = norm(b); return x === null || y === null || JSON.stringify(x) === JSON.stringify(y); };
// A category the person named in place of employers ("trading firms", "big tech"): a later call may name the firms instead.
const CATEGORY = /\b(?:firms?|companies|startups?|banks?|funds?|shops|employers|big tech|faang)\b/i;
// Architect ruling (review rv6, D-097): a later call agrees with an input the refused call already had when its value holds that
// value: equal under norm, a list holding every item (a superset), and a category word met by any firm the refused call did
// not already name. A count-like input (a number or a true/false) may differ.
const holds = (refusedV: unknown, laterV: unknown): boolean => {
  const was = norm(refusedV), now = norm(laterV);
  if (was === null) return true;
  if (now === null || !now.length) return false;
  const extra = now.filter((x) => !was.includes(x));
  return was.every((x) => now.includes(x) || (CATEGORY.test(x) && extra.length > 0));
};
// Whether a later call repeats a refused one (for the retry count, loop.ts): the same tool, and no input the refused call had is
// given another value.
const repeats = (refused: CallRec, later: CallRec) => later.name === refused.name && Object.entries(refused.input ?? {}).filter(([, v]) => filled(v)).every(([k, v]) => !filled(later.input?.[k]) || sameValue(later.input?.[k], v));
// How many earlier refused calls this call repeats (loop.ts: one retry per call; a second refusal ends that call for the turn).
export const refusedBefore = (log: CallRec[], call: CallRec): number => log.filter((r) => r.outcome === "refused" && repeats(r, call)).length;
export function unrunCalls(log: CallRec[]): { name: string; args: string[]; failed: boolean }[] {
  const out: { name: string; args: string[]; failed: boolean }[] = [];
  log.forEach((r, i) => {
    if (r.outcome !== "refused") return;
    // Architect ruling (review rv6, D-097, superseding rv5's "whatever its other arguments"): a refused call is RESOLVED only by a
    // later call of the same tool that ran and (1) has every required input the refused call lacked and (2) holds every input the
    // refused call already had (holds: same value, a superset list, a category met by named firms; counts may differ). A run about
    // another subject (another employer) resolves nothing. Only a call never resolved gets the line; it "failed" when such a
    // later call ran and threw.
    const retries = log.slice(i + 1).filter((x) => x.name === r.name && x.outcome !== "refused" && (r.missing ?? []).every((k) => filled(x.input?.[k]))
      && Object.entries(r.input ?? {}).filter(([, v]) => filled(v)).every(([k, v]) => holds(v, x.input?.[k])));
    if (retries.some((x) => x.outcome === "ok")) return;
    const args = subjectArgs(r.input ?? {});
    const failed = retries.some((x) => x.outcome === "threw");
    if (!out.some((o) => o.name === r.name && same(o.args, args) && o.failed === failed)) out.push({ name: r.name, args, failed });
  });
  // A call refused with no arguments and the same call refused again later are one line; a fuller refused call covers an emptier one.
  return out.filter((o, i) => !out.some((p, j) => j !== i && p.name === o.name && p.failed === o.failed && o.args.length < p.args.length && o.args.every((a) => p.args.includes(a))));
}
// Review rv4 (A2: an id, F-002, and a draft body were echoed into the line): the line names only a call's human SUBJECT, the
// company, employer, firm, role, title or school it was about, from a closed list of argument names. Never an id, a draft body,
// a note, a recipient or any other free text; a value that is long, holds a link, a line break or a digit-bearing token, or that
// the leak guard (reply_guards.ts leakedWords) flags, is left out.
export const SUBJECT_ARGS: readonly string[] = Object.freeze(["company", "companies", "employer", "employers", "firm", "firms", "role", "roles", "title", "school"]);
const LEAK_FREE = { tools: [] as string[], typed: "", postings: new Map() };
const subjectOk = (v: string) => v.length <= 60 && v.split(/\s+/).length <= 6 && !/[\n\r]|https?:|www\.|[@<>{}\[\]|\\]/i.test(v) && !/\S*\d\S*[_-]\S*|\S*[_-]\S*\d\S*/.test(v) && !leakedWords(v, LEAK_FREE).length;
export function subjectArgs(input: Record<string, unknown>): string[] {
  return SUBJECT_ARGS.flatMap((k) => { const v = input?.[k]; return Array.isArray(v) ? v : [v]; })
    .filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim().replace(/\s+/g, " ")).filter(subjectOk);
}
export function notRunLine(name: string, failed = false, args: string[] = []): string {
  const say = (a: string[]) => { const what = `${labelOf(name)}${a.length ? ` for ${a.join(" and ")}` : ""}`; return failed ? `The ${what} failed this time, so there is no result from it.` : `The ${what} did not run this time, so there is no result from it.`; };
  const line = say(args.filter(subjectOk).slice(0, 2));
  // The whole line goes through the leak guard too; a line it flags names no subject.
  return leakedWords(line, LEAK_FREE).length ? say([]) : line;
}
// Review rv4 (A1: career_brain's length pass dropped the line): code's not-run lines are put back at the head of any text a later
// pass rewrote (a condense, a pipeline, an enforcer), once each, wherever the rewrite left them. Idempotent: a text that already
// opens with them is returned as it is.
export function withNotRun(text: string, lines: readonly string[] | undefined): string {
  const t = String(text ?? "");
  if (!lines?.length) return t;
  const lead = lines.join(" ");
  const rest = t.startsWith(lead) ? t.slice(lead.length) : null;
  if (rest !== null && lines.every((l) => !rest.includes(l))) return t;
  let body = t;
  for (const l of lines) body = body.split(`${l} `).join("").split(l).join("");
  body = body.trim().replace(/\n{3,}/g, "\n\n");
  return [lead, body].filter((x) => x.trim()).join("\n\n");
}
// Whether a required input is missing: absent, null, or empty or whitespace only (review rv3, N10).
export const missingRequired = (input: Record<string, unknown>, required: string[]): string[] => required.filter((k) => !filled(input[k]) || (Array.isArray(input[k]) && (input[k] as unknown[]).every((x) => !filled(x))));

// The refusal the brain reads, as a structured fact: not run, which inputs are missing (each with its schema description), and
// whether one more call is allowed.
export function missingInputResult(t: { name: string; input_schema: { properties: Record<string, unknown> } }, missing: string[], attempt: number): string {
  const needed = missing.map((k) => { const d = (t.input_schema.properties?.[k] as { description?: unknown } | undefined)?.description; return { input: k, ...(typeof d === "string" && d.trim() ? { means: d.trim().slice(0, 160) } : {}) }; });
  const label = labelOf(t.name), retry = attempt <= 1 && missing.length > 0;
  return JSON.stringify({
    status: "not_run", not_run: label, ...(missing.length ? { missing_required_input: needed } : {}), retry_allowed: retry,
    note: retry
      ? `missing required input: ${missing.join(", ")}. The ${label} did not run and has no result. Fill the missing input from their message, this conversation or their confirmed record and call it once more; if they did not give it, do not call it again and ask for the one missing thing.`
      : `The ${label} did not run and will not run this turn (${missing.length ? `missing required input: ${missing.join(", ")}; ` : ""}refused twice). Do not call it again and never describe a result from it; ask for the one missing thing.`,
  });
}
