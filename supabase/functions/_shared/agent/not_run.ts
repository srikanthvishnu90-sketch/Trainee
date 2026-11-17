// A tool call that did not run has no result (D-024; benchmark gap #5: live-12 C19's find_people was refused for "missing
// required input: school, employers" and the reply said "The search found no public page ..."; C1's remember_instruction was
// refused the same way and nothing said so). Pure and structural: no sentence of the reply is classified by its words.
//   1. a call missing a required input is refused before it runs, with each input named and described from the tool's own
//      schema, and the brain may call it ONCE more; a second refusal ends that tool for the turn;
//   2. the refusal is a structured fact for the brain ({"status":"not_run","not_run":"<label>"}), never a result;
//   3. when a refused call never ran, code ALWAYS adds its line (notRunLine) to the reply, whatever the reply says; a retry that
//      ran and threw is said to have failed. Architect ruling (2026-11-16): that line is a fact stated by code under D-024,
//      like STANDING_REFUSED, not reply prose. A claim in the reply that would need the refused call's result is left to the
//      reply verifier (PR #849): a refused call contributes no evidence, so such a claim has no support there.

// Every tool the brain can be offered, by a human label (never its name). Closed: a tool not here is the "requested step".
export const LABELS: Readonly<Record<string, string>> = Object.freeze({
  add_profile_fact: "save of that fact", attach_document: "attached file", brief_from_invite: "interview brief from that invite",
  career_path_answer: "career path answer", check_posting_open: "open check on that posting", compare_paths: "comparison of those paths",
  confirm_profile_fact: "confirmation of that fact", contact_list: "contact list", correct_profile_fact: "correction to that fact",
  create_file: "file", draft_email_reply: "email reply draft", draft_followup: "message draft", draft_outreach: "outreach draft",
  export_tracker: "tracker", find_email: "inbox search", find_people: "people search", forget_instruction: "removal of that instruction",
  get_interview_questions: "interview questions lookup", get_job_alerts: "job alerts lookup", get_memory: "read of what you told me",
  get_outreach_conversations: "outreach conversations lookup", get_posting: "read of that posting", get_profile: "read of your profile",
  get_situation: "read of where things stand", inspect_apply_flow: "read of that application", interview_brief: "interview brief",
  list_applications: "check of your applications", offer_benchmark: "offer benchmark", open_record_file: "file from your records",
  queue_applications: "apply queue", read_application_mail: "mail check", read_resume: "resume read", recall: "recall of our earlier messages",
  record_list_cost: "list cost record", referral_map: "referral map", remember_instruction: "save of that instruction",
  research_career_question: "research", research_company: "company research", research_market: "market research",
  save_resume_persona: "save of that resume version", score_interview_answer: "answer scoring", search_jobs: "job search",
  set_job_alerts: "job alert setup", set_outreach_signature: "signature update", set_resume_contact: "resume contact update",
  set_weekly_digest: "weekly digest setup", stop_job_alerts: "job alert stop", tailor_resume: "resume build", track_application: "tracker update",
  use_resume_persona: "switch of resume version", verify_contacts: "contact check", where_do_i_stand: "read of where things stand",
});
export const labelOf = (name: string): string => LABELS[name] ?? "requested step";

type Call = { name: string; ok: boolean };
// Tools with at least one failed call and no successful one this turn.
export function neverRan(calls: Call[]): string[] {
  const ok = new Set(calls.filter((c) => c.ok).map((c) => c.name));
  return [...new Set(calls.filter((c) => !c.ok && !ok.has(c.name)).map((c) => c.name))];
}
export function notRunLine(name: string, failed = false): string {
  return failed ? `The ${labelOf(name)} failed this time, so there is no result from it.` : `The ${labelOf(name)} did not run this time, so there is no result from it.`;
}

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
