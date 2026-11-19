// TASK CONTRACTS (benchmark gap #2, "coach depth"; the 10/10 rubric for evals/mirror/instinct-wa-batch1/, its depth and form
// elements): what a reply about a tool's result must contain to read like a good coach. Instructions, never wording: no item is
// reply text, none names a person, employer or school, and every item applies only when this turn's facts allow it.
//
// Attached STRUCTURALLY (architect direction after review rv3: every regex over the person's message failed): a contract is not
// read from the message. It is attached to the tool whose result the reply is about, as part of that tool's run note, only when
// the brain actually calls the tool (withContracts, used by career_brain.ts). Scope (owner, 2026-11-16): mass applying, so the
// job-search, apply, batch and application-status tools. The apply turn code answers itself (career_apply_chat.ts applyTurn)
// writes its reply in code, with no brain turn to carry a contract.
//
// Review rv4 (architect ruling, 2026-11-17): ONE contract system. The reply pipeline's message-read contracts (reply_pipeline.ts
// contractsFor(null, message): referral, draft, requirements by a regex over the person's words) no longer pick anything; the
// two that existed only there are tool-attached here (draft: draft_followup, draft_outreach; requirements: inspect_apply_flow,
// apply_requirements), and the pipeline's checks for this turn come from the contracts the tools attached (pipelineContracts),
// plus answer_first, which holds for every reply and reads nothing. A contract is chosen by the tool's RESULT: a call refused
// before it ran, a call that threw, or a result that says the work was not done (not_readable, unknown, an error) carries none;
// an open check that read the posting carries the open or the closed contract, never "prepare it" for a closed one.
import type { ToolSpec } from "./loop.ts";
import { type Contract as PipelineContract, CONTRACTS as CHECKS } from "./reply_pipeline.ts";

export type TaskIntent = "search" | "apply" | "status" | "applications" | "tracker" | "tailor" | "apply_requirements" | "posting_check" | "posting_closed" | "draft";

// The common depth and form items (the rubric's "10/10 standard"), each used by the intents that list it.
export const CORE = {
  answer: "First sentence: the key fact that answers them (the role, the number, yes or no), never a sentence about a file, a tool or what you are about to do.",
  why: "Why it matters for them, in one clause, tied to their confirmed situation (their goal, a posting open in this conversation and its deadline, what their record shows so far).",
  number: "One number where this turn has its inputs: days left to a deadline counted from today's date, a weekly volume, or the arithmetic behind a comparison. A figure that is your judgement is labelled as yours; a figure without inputs is not given.",
  tradeoff: "The tradeoff in one line: what this choice costs them or what it gives up.",
  verify: "What to verify first: the hard requirements of the posting in question (work authorization, enrollment or graduation dates, location), whether it is still open, and each of their own facts that is waiting for their yes or that they flagged as unsure and that this task touches, named as unresolved, never filled in.",
  next: "One prioritised next step, then end with one concrete offer or question that can be answered in a word.",
  size: "Size: keep the chat to what LENGTH OF THIS REPLY says (about 600 characters for an answer); depth beyond that goes in a File (create_file) whose contents you name in a few words once it is made.",
} as const;
type Core = keyof typeof CORE;

// checks: the reply pipeline's code checks (reply_pipeline.ts CONTRACTS) that this contract's reply is held to.
export interface Contract { label: string; core: Core[]; items: string[]; checks?: (keyof typeof CHECKS)[] }
export const TASK_CONTRACTS: Record<TaskIntent, Contract> = {
  search: { label: "a search for postings", core: ["answer", "verify", "next", "size"], items: [
    "First sentence: the count found against the count they asked for, and the scope searched; fewer than asked gives the exact count and one widening that would find more.",
    "One posting: its employer, title, place and link, with its pay and deadline when the posting states them. More than one: never a list of raw links in chat (RESPONSE-RULES 3.1); the postings go in a File (create_file), and the chat names the one or two to look at first by employer and title.",
    "Label reach or stretch roles with the one reason from the posting; say which to apply to first, ordered by deadline or fit.",
    "Say which ones need the person's own employer account and sign-in.",
  ] },
  applications: { label: "where their applications stand", core: ["answer", "why", "next", "size"], items: [
    "First sentence: the count from the record, and how many of those match the role they are targeting now (none matching means that pipeline is at zero; say so).",
    "One line per application: employer, role, date, status.",
    "State the coverage: which mailboxes and what date window were read, and that Trainee's own record was checked; then what the record cannot see (portal-only submissions, other mailboxes, anything older than the window).",
    "Keep roles researched in this conversation apart from applications.",
    "The next move toward their target (an open role and its deadline), then offer a tracker.",
  ] },
  tracker: { label: "a tracker", core: ["next", "size"], items: [
    "Say what it holds: applications with dates, researched roles, unsubmitted drafts, each with its status, and any correction to what you said before.",
    "Say how it stays current and what it cannot see (portal-only status changes, mailboxes not connected).",
    "Name the columns that make it useful (company, role, date, source, status, next step, follow-up date) only as the tracker holds them.",
    "Suggest the first follow-up from what it shows.",
  ] },
  tailor: { label: "a tailored resume", core: ["verify", "next", "size"], items: [
    "File first, then the concrete changes exactly as the tool's changelog reports them (what leads and why, what was cut or shortened, which posting keywords were matched); never an order, a split or a change it does not report.",
    "Name the posting requirements their record cannot show yet, to confirm before applying, and one change that would raise fit without inventing it.",
    "For an edit to a version already made, say what changed and, where the record cannot support more detail, propose lines marked as needing their confirmation instead of writing them in.",
    "It is a review draft and nothing was submitted; end with the one blocking question.",
  ] },
  apply_requirements: { label: "what applying needs", core: ["number", "verify", "next", "size"], checks: ["requirements"], items: [
    "A short checklist: the posting's hard requirements against their record (met, not on file, to confirm), the personal fields still missing, and the deadline with the days left.",
    "The account reality: an employer account or sign-in they do themselves; no password ever goes through chat.",
    "What happens after: the exact answers and resume are shown as one payload, their yes to that payload submits it, and the receipt is the proof (HOW APPROVAL WORKS).",
    "What stays unknown until sign-in, and a rough estimate of their effort.",
    "End with the first fact to give.",
  ] },
  apply: { label: "an ask to apply to postings", core: ["number", "verify", "next", "size"], items: [
    "Queue only the postings they chose (by their number, their employer or their link) with queue_applications; first sentence: how many were queued against how many they asked for, and each refused one with its reason.",
    "Say how they go out exactly as HOW APPROVAL WORKS says: one card shows the batch, one yes approves exactly what it shows, and nothing is sent before that yes.",
    "The facts the batch still needs from them, asked once for the whole batch (the single most important one as the question), and any site that needs their own sign-in.",
    "Any deadline among them with the days left, and what they will see next (the card, then a receipt for each one that goes).",
  ] },
  status: { label: "where their applications stand", core: ["answer", "next", "size"], items: [
    "First sentence: how many are in flight and the one thing waiting on them, if any.",
    "One line per application from SITUATION or the tool this turn: employer, role, and its state in plain words (waiting for their yes, being prepared, sent with its receipt, stopped and why), newest first.",
    "Say what the record cannot see (a reply only the employer's portal shows), and never a state no record shows.",
  ] },
  posting_check: { label: "whether a posting is open", core: ["answer", "number", "next"], items: [
    "First sentence: it is open, citing the employer's page read this turn, with the deadline in the posting's words and the link.",
    "The days left to that deadline from today's date, and that a posting can close early or by time zone (judgement), so aim to apply ahead of it.",
    "What still blocks applying (their unresolved facts, requirements to confirm) and one offer: prepare it for their approval.",
  ] },
  posting_closed: { label: "a posting that is closed", core: ["answer", "next"], items: [
    "First sentence: it is closed, citing the employer's page read this turn, with the link; nothing was applied for.",
    "Never offer to prepare or apply to it; offer instead a search for open roles like it.",
  ] },
  draft: { label: "a message draft", core: ["next"], checks: ["draft"], items: [
    "A draft the person sends themselves says, after it, that it was not sent.",
    "A message that asks for a referral asks for the referral itself, plainly.",
  ] },
};

// The contracts each tool can carry: its result is what the reply then reports (contractFor picks one by that result).
export const TOOL_CONTRACTS: Readonly<Record<string, readonly TaskIntent[]>> = Object.freeze({
  search_jobs: ["search"], check_posting_open: ["posting_check", "posting_closed"], inspect_apply_flow: ["apply_requirements"], queue_applications: ["apply"],
  list_applications: ["status"], get_situation: ["status"], where_do_i_stand: ["status"], read_application_mail: ["applications"],
  export_tracker: ["tracker"], tailor_resume: ["tailor"], draft_followup: ["draft"], draft_outreach: ["draft"],
});
// A result that says the work was not done: its status or state, case aside (a posting not read, a check that did not finish, a
// refusal, an error, a source not connected).
const NOT_DONE = new Set(["not_readable", "unknown", "not_run", "refused", "error", "failed", "not_wired", "not_connected", "unavailable", "blocked", "needs_approval"]);
const said = (v: unknown) => typeof v === "string" ? v.trim().toLowerCase() : "";
// The contract for this result of this tool, or none. Pure: it reads only the tool's name and its result.
export function contractFor(tool: string, out: unknown): TaskIntent | null {
  const can = TOOL_CONTRACTS[tool];
  if (!can || !out || typeof out !== "object" || Array.isArray(out)) return null;
  const r = out as Record<string, unknown>;
  if (r.error || r.ok === false || NOT_DONE.has(said(r.status)) || NOT_DONE.has(said(r.state))) return null;
  if (tool === "check_posting_open") return said(r.state) === "open" ? "posting_check" : said(r.state) === "closed" ? "posting_closed" : null;
  return can[0];
}
// Each listed tool, its result carrying the contract its result calls for in its run note (appended to the note the tool wrote,
// or as the note), and the contract recorded on the turn (ctx.turn.contracts) for the reply pipeline's checks.
export function withContracts(tools: ToolSpec[]): ToolSpec[] {
  return tools.map((t) => {
    if (!TOOL_CONTRACTS[t.name]) return t;
    return { ...t, run: async (input: any, ctx: any) => {
      const out = await t.run(input, ctx);
      const intent = contractFor(t.name, out);
      if (!intent) return out;
      if (ctx?.turn) { const c = (ctx.turn.contracts ??= []) as TaskIntent[]; if (!c.includes(intent)) c.push(intent); }
      const note = (out as { note?: unknown }).note;
      return { ...(out as Record<string, unknown>), note: [typeof note === "string" ? note : "", contractNote(intent)].filter(Boolean).join("\n\n") };
    } };
  });
}
// The reply pipeline's checks for this turn (reply_pipeline.ts runReplyPipeline): answer_first for every reply, then each check
// of a contract a tool attached this turn. Nothing here reads the person's message.
export function pipelineContracts(attached: readonly TaskIntent[] | undefined): PipelineContract[] {
  const ids = ["answer_first", ...(attached ?? []).flatMap((i) => TASK_CONTRACTS[i]?.checks ?? [])] as (keyof typeof CHECKS)[];
  return [...new Set(ids)].map((id) => CHECKS[id]);
}

// The note for the system prompt: the intent's own items, then the common ones it uses.
export function contractNote(intent: TaskIntent): string {
  const c = TASK_CONTRACTS[intent];
  return [
    `TASK CONTRACT FOR YOUR REPLY ABOUT THIS RESULT (${c.label}). How to answer, never wording to copy; each item applies when this turn's facts allow it, and nothing is filled in with a guess:`,
    ...c.items.map((x) => `- ${x}`),
    ...c.core.map((k) => `- ${CORE[k]}`),
  ].join("\n");
}
