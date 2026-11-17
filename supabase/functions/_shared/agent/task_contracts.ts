// TASK CONTRACTS (benchmark gap #2, "coach depth"; the 10/10 rubric for evals/mirror/instinct-wa-batch1/, its depth and form
// elements): what a reply to each kind of task must contain to read like a good coach, handed to the brain as structured
// instructions for this one turn. Instructions, never wording: no item is reply text, none names a person, employer or school,
// and every item applies only when this turn's facts allow it (a number without its inputs is not given; a gap is named, never
// filled). The model writes every word of the reply. Pure.
//
// contractOf(message, history) reads the kind of task from the person's words (with the practice and draft readers turn_notes.ts
// already has); contractNote(intent) is the note career_brain.ts puts in the system prompt. One contract per turn.
import { capacityAskOf, draftAskOf, historyAskOf, hypotheticalOf, planSearchAskOf, practiceAnswerOf, replyKind, roastOf } from "./turn_notes.ts";

type Msg = { role: string; content: unknown };
const lc = (s: unknown) => String(s ?? "").replace(/[‘’`]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();

// Scope (owner, 2026-11-16: "the priority is now mass applying only"): the job-search, apply, batch and application-status tasks.
// Practice, advice, research, drafts and the other kinds of task get no contract yet.
export type TaskIntent = "plan" | "search" | "applications" | "tracker" | "tailor" | "apply_requirements" | "capacity" | "posting_check";

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
const ALL: Core[] = ["answer", "why", "number", "tradeoff", "verify", "next", "size"];

export interface Contract { label: string; core: Core[]; items: string[] }
export const TASK_CONTRACTS: Record<TaskIntent, Contract> = {
  plan: { label: "a plan to land roles", core: ALL, items: [
    "Order the plan by time, with the concrete first action this week (for example, the open role to prepare before its deadline, or the one fix to make before applying).",
    "Cover the three levers that land roles, each with a weekly volume or cadence: applications, referrals and outreach, interview practice.",
    "Say where the hiring cycle for their target stands now and what that means for volume, sourced or labelled as your judgement.",
    "Name each listed role's hard requirements to confirm before applying, and offer to prepare the top role for their approval.",
  ] },
  search: { label: "a search for postings", core: ["answer", "verify", "next", "size"], items: [
    "First sentence: the count found against the count they asked for, and the scope searched; fewer than asked gives the exact count and one widening that would find more.",
    "Each posting on its own line: employer, title, place, link; its pay and deadline when the posting states them.",
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
    "File first, then the concrete changes: what moved up and why (the posting's skills it shows), what was cut or shortened, which posting keywords were matched.",
    "The entries most relevant to the posting lead; a role unrelated to the posting never leads.",
    "Name the posting requirements their record cannot show yet, to confirm before applying, and one change that would raise fit without inventing it.",
    "For an edit to a version already made, say what changed and, where the record cannot support more detail, propose lines marked as needing their confirmation instead of writing them in.",
    "It is a review draft and nothing was submitted; end with the one blocking question.",
  ] },
  apply_requirements: { label: "what applying needs", core: ["number", "verify", "next", "size"], items: [
    "A short checklist: the posting's hard requirements against their record (met, not on file, to confirm), the personal fields still missing, and the deadline with the days left.",
    "The account reality: an employer account or sign-in they do themselves; no password ever goes through chat.",
    "What happens after: the exact answers and resume are shown as one payload, their yes to that payload submits it, and the receipt is the proof (HOW APPROVAL WORKS).",
    "What stays unknown until sign-in, and a rough estimate of their effort.",
    "End with the first fact to give.",
  ] },
  capacity: { label: "whether a volume of work is realistic", core: ["number", "tradeoff", "next", "size"], items: [
    "How many qualifying roles the search has now, against the volume asked, and what a larger number needs.",
    "The facts asked once for the whole batch, and the account reality (sites that need their own sign-in cannot be done without them).",
    "The real mechanism, exactly as HOW APPROVAL WORKS says (one card, one yes for exactly that batch, a receipt each).",
    "A realistic pace and why (simple forms fast; account sites limited by their sign-ins; captchas stop and are never solved), stated as unverified.",
    "The quality tradeoff with a recommended first batch size and its reason, and what they would see afterwards (each application's state).",
  ] },
  posting_check: { label: "whether a posting is open", core: ["answer", "number", "next"], items: [
    "First sentence: open or closed, citing the employer's page read this turn, with the deadline in the posting's words and the link.",
    "The days left to that deadline from today's date, and that a posting can close early or by time zone (judgement), so aim to apply ahead of it.",
    "What still blocks applying (their unresolved facts, requirements to confirm) and one offer: prepare it for their approval.",
  ] },
};

const APPLY_NEEDS = /\bwhat (?:would|do|will|does) (?:you|it|trainee) (?:need|take)\b[^?.!]{0,60}\b(?:submit|apply|application)\b|\bwhat (?:do|would|will) i need\b[^?.!]{0,40}\b(?:submit|apply)\b|\bwhat(?:'s| is) (?:needed|required) to (?:apply|submit)\b/;
const TAILOR = /\b(?:tailor(?:ed)?|customi[sz]e[ds]?)\b[^.?!]{0,40}\b(?:resume|cv)\b|\b(?:resume|cv)\b[^.?!]{0,40}\bfor (?:that|the|this|my)\b[^.?!]{0,40}\b(?:posting|role|job|internship|position|application)\b|\b(?:condense|expand|shorten|cut|trim)\b[^.?!]{0,60}\b(?:resume|line|part|section|bullet)s?\b|\b(?:that|the|my)\s+\w+\s+resume\b[^.?!]{0,40}\b(?:condense|expand|shorten|change|move)\b/;
const POSTING_OPEN = /\bstill (?:open|up|live|accepting|taking)\b|\b(?:has|is) (?:it|that|the)\b[^.?!]{0,40}\b(?:closed|open)\b/;
const TRACKER = /\btracker\b|\bspreadsheet\b[^.?!]{0,40}\bapplications?\b/;
const APPLIED = /\bhave i applied\b|\bdid i apply\b|\bwhere (?:do|are) my applications\b/;
const PLAN = /\bwhat should i (?:actually |really |even )?(?:be )?(?:do|doing|focus on)\b|\b(?:a|my|the|weekly)\s+(?:plan|roadmap|strategy|game ?plan)\b|\block in\b|\bwhere (?:do|should) i (?:start|begin)\b/;
const JOBS = /(?:internships?|jobs?|roles?|postings?|openings?|positions?|recruiting|hired|offers?)/;
const SEARCH = /\b(?:find|search|show|list|look for|get) (?:me )?(?:\w+ ){0,4}?(?:internships?|jobs?|roles?|postings?|openings?|positions?)\b/;

// The kind of task the message is, or null when it is none of these (no contract is added then). A practice session, a draft and
// a hypothetical are never one of these tasks.
export function contractOf(message: string, history: Msg[] = []): TaskIntent | null {
  const t = lc(message);
  if (!t || hypotheticalOf(message) || draftAskOf(message) || replyKind(message, history) === "question" || roastOf(message, history) || practiceAnswerOf(message, history)) return null;
  if (capacityAskOf(message)) return "capacity";
  if (APPLY_NEEDS.test(t)) return "apply_requirements";
  if (TAILOR.test(t)) return "tailor";
  if (POSTING_OPEN.test(t)) return "posting_check";
  if (TRACKER.test(t)) return "tracker";
  if (historyAskOf(message) || APPLIED.test(t)) return "applications";
  if (planSearchAskOf(message) || (PLAN.test(t) && JOBS.test(t))) return "plan";
  if (SEARCH.test(t)) return "search";
  return null;
}

// The note for the system prompt: the intent's own items, then the common ones it uses.
export function contractNote(intent: TaskIntent): string {
  const c = TASK_CONTRACTS[intent];
  return [
    `TASK CONTRACT FOR THIS REPLY (code read the kind of task from their words: ${c.label}). How to answer, never wording to copy; each item applies when this turn's facts allow it, and nothing is filled in with a guess:`,
    ...c.items.map((x) => `- ${x}`),
    ...c.core.map((k) => `- ${CORE[k]}`),
  ].join("\n");
}
