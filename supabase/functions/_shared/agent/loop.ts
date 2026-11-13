// The agent loop (WO-002): the model decides what to do, code enforces it. Each turn the model reads the conversation
// and the tools' schemas, calls tools, and writes the reply. Policy lives here, at the tool boundary:
//   read       runs freely
//   write_own  changes only this person's own state; runs freely
//   external   touches the world (send, submit, message); NEVER runs here. It becomes a pending approval the
//              person approves on its exact payload (WO-005), and the model is told it is waiting.
// Messages use the Anthropic block shape (text / tool_use / tool_result); _shared/model_gateway.ts converts to OpenAI.
import { bracketUntraced, credentialAsks, factSources, missingAck, multiAsk, unbackedPromises, secretIn, stripSecrets, leakedWords, pieces, plainQuotes, postingsOf, rebuild, stripLeaks, closedNotes, misquotedAsks, smallTalkPitch, unsourcedFigures, untracedFacts, waiverSolicits } from "./reply_guards.ts";
import { urlsIn } from "../channel_shape.ts";
import { STANDING_REFUSED, standingRefusal } from "./memory.ts";
export type Effect = "read" | "write_own" | "external";
// `turn` is this turn's own record, filled by runAgentTurn: the person's message (a confirmation must come from it) and
// the ids of facts added during the turn (a fact can never be confirmed in the turn that added it).
// `show` (WO-033): a tool whose output the person must read exactly (a batch of outreach drafts, each in full) sets it;
// the reply is then code's text, never the model's retelling, and `intent` makes the next text an answer to it. `parts`
// (WO-038's contract): the same text as separate messages, so a texting channel delivers each whole and in order.
// `before` (WO-091b): the previous turn's reply as the person saw it ("" on a first turn), so a tool can check that "the
// first one" is a posting that reply showed. Undefined only for a caller that runs a tool without the loop's history.
export interface ToolCtx { userId: string; threadId: string; now: number; state: Record<string, unknown>; turn?: { message: string; added: string[]; before?: string; attached?: string; attachments?: { filename: string; content: string }[]; fileLinks?: string[]; paySources?: PaySource[]; guard?: (text: string) => string[]; seen?: string[]; show?: { intent: string; text: string; parts?: string[]; meta?: Record<string, unknown> }; typed?: string; askOnly?: boolean; draft?: { label: string; body: string; recheck: (body: string) => boolean }; counts?: { applied: number } } }
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[] };
  effect: Effect;
  // The effect a call actually had, from its result, when it depends on what the call did (research_market: "write_own" only
  // when it published a File). Absent: `effect`.
  effectOf?: (out: unknown) => Effect;
  run(input: any, ctx: ToolCtx): Promise<unknown>;
}
export type ModelFn = (payload: { system: string; messages: any[]; tools: { name: string; description: string; input_schema: unknown }[]; max_tokens: number; tool_choice?: { type: "none" } }) =>
  Promise<{ content: any[]; stop_reason: string; usage?: unknown }>;
// D-070: a posting whose pay a tool returned this turn, with the link it was read from.
// D-073: `place`, the posting's own location as the tool returned it (payWithSource names it beside its pay).
export interface PaySource { company: string | null; title: string | null; pay: string; url: string; place?: string | null }
export function payPostingsOf(out: unknown): PaySource[] {
  const o = out && typeof out === "object" ? out as any : null;
  if (!o) return [];
  const one = (x: any, url: unknown, inner?: any): PaySource | null => {
    const pay = typeof inner?.pay === "string" && inner.pay.trim() ? inner.pay : typeof x?.pay === "string" && x.pay.trim() ? x.pay : null;
    const byPlace = Array.isArray(inner?.pay_by_place) ? inner.pay_by_place.map((r: any) => `${r?.place ?? ""}: ${r?.pay ?? ""}`).join("; ") : "";
    const u = String(url ?? "");
    const place = String(inner?.location ?? x?.location ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    return (pay || byPlace) && /^https:\/\//.test(u) ? { company: (inner?.company ?? x?.company ?? null) || null, title: (inner?.title ?? x?.title ?? null) || null, pay: [pay, byPlace].filter(Boolean).join("; "), url: u, ...(place ? { place } : {}) } : null;
  };
  const xs: (PaySource | null)[] = [];
  if (Array.isArray(o.postings)) for (const p of o.postings.slice(0, 50)) xs.push(one(p, p?.url));
  if (o.posting && typeof o.posting === "object") xs.push(one(o, o.url ?? o.posting.url, o.posting));
  else xs.push(one(o, o.url));
  return xs.filter(Boolean) as PaySource[];
}
export interface TurnResult {
  reply: string;
  steps: number;
  // WO-080: a failed call carries `error`, its reason cleaned by scrubError; a call that ran carries none.
  // D-071 (live-8 C1: NVIDIA's remote posting was not returned and the trace held no search words): what a search or research
  // call asked (argsOf), recorded in the turn's meta.
  tool_calls: { name: string; ok: boolean; effect: Effect | null; error?: string; args?: Record<string, unknown> }[];
  pending_approvals: { tool: string; input: unknown; summary: string }[];
  stopped: "final" | "max_steps" | "model_error" | "incomplete_reply";
  // Meta only, never changes the reply: a final draft that still asked several things or promised an alert after the one rewrite.
  flags?: string[];
  show?: { intent: string; text: string; parts?: string[]; meta?: Record<string, unknown> };
  // JOB CARDS: the postings the turn's last successful search_jobs returned, for channels that show them as cards.
  postings?: unknown[];
  // REPLY SHAPE: the documents the turn staged with attach_document (each passed the fact guards), and the URLs the turn may
  // show (those a tool returned or the person typed).
  attachments?: { filename: string; content: string }[];
  linksSeen?: string[];
  paySources?: PaySource[]; // D-070: postings a tool read this turn that state pay, each with its link
  fileLinks?: string[]; // FILE KINDS: links to the files create_file made this turn, minted by code; the channel sends them, the model never writes them
}

// D-073: how the process check starts its ask when a create_file call was refused (career_brain.ts processCheck).
export const REFUSED_FILE_TODO = "Your create_file call was refused";
export const MAX_STEPS_REPLY = "I couldn't finish that in one reply because it needed more steps than one reply allows, so I stopped partway. Nothing was sent or submitted. Tell me which part to do first.";
export const MODEL_ERROR_REPLY = "I can't answer right now because the AI service isn't responding. Nothing was sent, saved or submitted. Try again in a minute.";
// When a turn saved something before it stopped, it says so: "nothing saved" would be false.
export const MAX_STEPS_AFTER_SAVE_REPLY = "I couldn't finish all of that because it needed more steps than one reply allows; what you told me is saved. Nothing was sent or submitted. Tell me which part to do next.";
export const MODEL_ERROR_AFTER_SAVE_REPLY = "I couldn't finish because the AI service stopped responding; what you told me is saved. Nothing was sent or submitted. Try again in a minute.";
export const INCOMPLETE_REPLY = "I couldn't produce a complete answer because the AI's reply came back unfinished, so I stopped. Nothing was sent, saved or submitted. Please try again.";
// D-067 (live-6 C9, D-024): a reply that came out empty after code's checks is never sent blank; it says the turn did not finish.
export const EMPTY_REPLY = "I couldn't finish this answer, so I stopped here. Nothing was sent or submitted. Ask me again and I'll pick it up.";
export const EMPTY_AFTER_SAVE_REPLY = "I couldn't finish this answer, so I stopped here; what you told me is saved. Nothing was sent or submitted. Ask me again and I'll pick it up.";
export const INCOMPLETE_AFTER_SAVE_REPLY = "I couldn't produce a complete answer because the AI's reply came back unfinished; what you told me is saved. Nothing was sent or submitted. Please try again.";
// WO-077: a reply never claims a change that did not happen this turn (battery run 39485101366, T12: "Kept for good" after
// only a read). Each kind of claim names the tools that make it true. WO-091a (audit chat-brain F5; battery run
// 39500971945, BR-062/036/042): a claim is first-person past or present-perfect action language ("I've set…", "I saved…",
// "Saved:", "Done — alerts…", "I queued/sent…"); advice and imperatives ("keep job alerts on", "set an alert for…", "as I
// noted") are not; a negation anywhere in the sentence clears it, and so does a condition before it or in its own clause.
// An unbacked claim is put to the model once (do it, or say it plainly); if it stands, only its sentences go. With
// nothing left, the reply is this line: it promises nothing, because code cannot know a tool could do it.
export const CLAIM_UNBACKED_REPLY = "I didn't change anything this time.";
// A reply whose every sentence carried a key-shaped string (ADVERSARIAL ROUND 2): nothing of it is shown.
export const SECRET_DROPPED_REPLY = "I can't share keys, tokens or passwords because they never go through chat, and I didn't change anything.";
const ALERT_NOUN = "(?:(?:an?|your|the|new|these|those|\\d+) )?(?:(?:job|daily|instant|new) )?(?:alerts?|job watch(?:es)?)\\b";
const I_HAVE = "\\bi(?:'ve| have)? (?:just |now |also )?";
// D-066 (P5/P6, the owner's Behavior Guide: "a claim without an artifact is a hard fail"): a reply that says a file, page, PDF or
// tracker was made or is attached needs a tool that made one this turn and succeeded: create_file, export_tracker, tailor_resume,
// attach_document, or a research tool that published a File (its effect, from its result, is write_own). Otherwise the claim goes
// back to the model once, like every claim here; the link itself is always code's (file_tool.ts), never the model's.
// A backed file claim is the deliverable itself (its link rides the answer), never a bare receipt (missingAnswerBody).
const FILE_CLAIM = "a file made";
// D-072 (files reachable): open_record_file makes a record-backed File family page (file_family_make.ts); only a made one backs a claim.
export const FILE_MAKERS = ["create_file", "open_record_file", "export_tracker", "tailor_resume", "attach_document", "research_market", "research_company", "research_career_question"];
const FILE_NOUN = "(?:file|pdf|page|tracker|spreadsheet|sheet|doc(?:ument)?|word (?:file|copy)|resume|cv|cover letter)";
const CLAIMS: { kind: string; said: RegExp; by: string[] | "any_write"; wrote?: string[] }[] = [
  { kind: FILE_CLAIM, by: FILE_MAKERS, wrote: ["research_market", "research_company", "research_career_question"], said: new RegExp(`${I_HAVE}(?:made|created|built|generated|put together|attached|uploaded|exported)(?: you)? (?:a|an|the|your|this)(?: [\\w-]+){0,3} ${FILE_NOUN}\\b|\\b(?:your|the|this)(?: [\\w-]+){0,3} ${FILE_NOUN} (?:is|are) (?:attached|ready|made|linked|below|done)\\b|^(?:here(?:'s| is) (?:your|the)(?: [\\w-]+){0,3} ${FILE_NOUN})\\b|\\battached (?:is|are|here)\\b|^attached\\b`, "i") },
  { kind: "an alert set", by: ["set_job_alerts"], said: new RegExp(`${I_HAVE}(?:set|created|turned on|switched on|enabled|added)(?: up)? ${ALERT_NOUN}|\\balerts? (?:is|are) now (?:set|on|live|active)\\b|\\balerts? (?:has|have) been (?:set|turned on|switched on|created|enabled)\\b|^(?:done|all set)\\b.{0,40}\\balerts?\\b`, "i") },
  { kind: "postings queued", by: ["queue_applications"], said: new RegExp(`\\b(?:were|was|have been|has been|are now|is now) queued\\b|${I_HAVE}queued\\b|^queued\\b|(?:^|${I_HAVE})added (?:\\d+|them|it|these|those|all)\\b[^.]{0,30}\\bto your (?:apply )?queue`, "i") },
  { kind: "an application tracked", by: ["track_application"], said: new RegExp(`\\bi(?:'m| am) (?:now )?tracking\\b|\\bnow tracking\\b|(?:^|${I_HAVE})added (?:it|this|that|them)\\b[^.]{0,20}\\bto your (?:tracker|applications)|\\b(?:is|are) now (?:on|in) your tracker|${I_HAVE}(?:tracked|logged)\\b|^tracked\\b`, "i") },
  { kind: "something saved", by: "any_write", said: new RegExp(`\\bkept for good\\b|\\b(?:saved|kept)(?::| as (?:an?|your)\\b| for good\\b| it\\b| that\\b| this\\b| your\\b)|${I_HAVE}(?:saved|kept|stored|recorded|remembered|added|updated) (?:it|that|this|them|these|those|your|to your|the (?:fact|instruction|preference|rule|note|setting)s?\\b|as (?:an?|your)\\b|for (?:good|you|later)\\b)|\\bi(?:'ll| will) (?:keep|remember) (?:that|this|it)\\b|^(?:done|all set)\\b.{0,60}\\b(?:saved|kept|remembered|standing instruction|your profile|your preferences?)\\b`, "i") },
  // ADVERSARIAL ROUND 2 (2026-10-30): "I've confirmed your GPA 4.0" when no confirmation ran (a posting told the model to
  // mark it confirmed) is a false record: only confirm_profile_fact, on the person's own yes, confirms a fact.
  { kind: "a fact confirmed", by: ["confirm_profile_fact"], said: new RegExp(`${I_HAVE}(?:confirmed|verified|marked (?:(?:it|that|this|them|your [\\w ]{1,30}) )?(?:as )?(?:confirmed|verified))\\b|\\b(?:has|have) been (?:confirmed|verified)\\b|\\b(?:is|are) now (?:confirmed|verified)\\b`, "i") },
  // D-067 (owner, must-fix (e): "no 'made' or 'attached' without the File arriving"): a page, File, tracker, PDF or brief said to be
  // made, attached or holding something is backed only by a call this turn that made one (its link minted by code, or its file
  // riding the reply): create_file, export_tracker, attach_document, tailor_resume, or research that published its brief.
  // (Merged with D-066's file claim above: the same kind and the same backing; these are the phrasings D-066's pattern does not read.)
  { kind: FILE_CLAIM, by: FILE_MAKERS, wrote: ["research_market", "research_company", "research_career_question"], said: new RegExp(`${I_HAVE}(?:made|created|built|put together|attached|generated|drafted up|started)\\b[^.!?\\n]{0,40}\\b(?:file|page|tracker|pdf|brief|spreadsheet|document|doc)s?\\b|\\b(?:is|are) (?:attached|in (?:the|your|this) (?:file|page|tracker|pdf|brief))\\b|\\bhere(?:'s| is) (?:the|your) (?:file|page|tracker|pdf|brief)\\b|\\b(?:the|your) (?:file|page|tracker|pdf|brief) (?:is ready|has (?:the|your|every|all))\\b|\\b(?:full |whole )?(?:plan|details?|links?|list|breakdown|brief|sources?|timeline)\\b[^.!?\\n]{0,30}\\b(?:is|are) in the (?:file|page|tracker|brief)\\b`, "i") },
  // Nothing external runs inside the turn (it waits for the person's yes on its card), so a reply never sent anything.
  { kind: "something sent or applied for", by: [], said: new RegExp(`${I_HAVE}(?:sent|submitted|emailed|messaged|shared|forwarded) (?:it|this|that|them|your (?:application|email|message|note|resume|cover letter)s?|the (?:application|email|message|note|resume|cover letter)s?|\\d+ (?:applications?|emails?|messages?|notes?))\\b|${I_HAVE}applied (?:you |for you )?(?:to|for) (?:it|this|that|them|these|those|all|\\d+)\\b|${I_HAVE}applied you\\b|\\b(?:has|have) been (?:sent|submitted)\\b|^(?:sent|submitted)\\b` +
    // ADVERSARIAL ROUND 2 (2026-10-30): "I emailed attacker@evil.example", "I've messaged the recruiter", "I sent your
    // resume to x@y" named who instead of what, and reached the person as if it had happened.
    `|${I_HAVE}(?:emailed|messaged|texted|contacted|reached out to|replied to|wrote to|written to)\\b(?! (?:you|yourself)\\b)|${I_HAVE}(?:sent|forwarded|shared)\\b[^.!?\\n]{0,60}\\bto\\s+(?:[^\\s@]+@[^\\s@]+|the (?:recruiter|hiring manager|employer|company|team)|[A-Z][a-z]+)`, "i") },
];
// A negation in the claim's own clause, before it or directly on it ("Nothing was queued", "I queued none of them"); a
// condition or offer before the claim ("If you say yes, I'll queue") or in its own clause ("live only once you
// approve"). What a "Saved:" label saves ("Saved: you never want agencies") and anything quoted are the person's words,
// not the sentence's, so they negate nothing. (PR #123 review: a negation in another clause — "I've saved your
// preference, but nothing was sent" — does not clear the claim.)
const NEGATION = /\b(?:nothing|not|never|none|no|neither|nor|unable|cannot)\b|n't\b/i;
const CLAUSE_BREAK = /,\s*|;\s*|\s*[—–]\s*|\s+(?:and|but|or|so|yet|although|though|while|whereas)\s+/gi;
const NEGATES_NEXT = /^\s*(?:none|nothing|no|not|zero)\b/i;
const CONDITION = /\b(?:if|unless|want me|should i|shall i|do you want|would you like|i can|i could|will|going to|tell you|once|when|after|until|as soon as)\b|'ll\b/i;
// What follows a claim can undo it too: "Saved: none.", "I'll keep it in this conversation" (kept nowhere else).
const UNDONE = /^\s*:?\s*(?:none|nothing)\b|^[^.!?]{0,40}\b(?:in this (?:conversation|chat)|for (?:this|the rest of this) (?:conversation|chat)|for now)\b/i;
// Every kind of claim one sentence makes ("Alerts are now on and I saved your preference" makes two).
function claimsIn(sentence: string): string[] {
  const x = plainQuotes(sentence).trim().replace(/^(?:[-*•]|\d+[.)])\s+/, "");
  const kinds: string[] = [];
  if (!x || /\?["')\]]*\s*$/.test(x)) return kinds;
  for (const c of CLAIMS) {
    const m = c.said.exec(x);
    if (!m) continue;
    const end = m.index + m[0].length, after = x.slice(end);
    if (UNDONE.test(after)) continue;
    // A negation counts only in the claim's own clause: before the claim ("Nothing was queued") or directly on it ("I
    // queued none"). One in another clause ("I've saved your preference, but nothing was sent") leaves it standing.
    const unquoted = x.replace(/"[^"]*"/g, (q) => " ".repeat(q.length));
    const lead = unquoted.slice(0, m.index);
    const opens = [...lead.matchAll(CLAUSE_BREAK)].map((b) => (b.index ?? 0) + b[0].length);
    if (NEGATION.test(lead.slice(opens.length ? opens[opens.length - 1] : 0))) continue;
    if (!/^\s*:/.test(after) && NEGATES_NEXT.test(after)) continue;
    if (CONDITION.test(x.slice(0, m.index)) || CONDITION.test(after.split(/[,;—–]|\b(?:and|but|so)\b/)[0])) continue;
    kinds.push(c.kind);
  }
  return kinds;
}
type Call = { name: string; ok: boolean; effect: Effect | null };
const backedBy = (kind: string, calls: Call[]) => {
  const c = CLAIMS.find((x) => x.kind === kind)!;
  return calls.some((t) => t.ok && (c.by === "any_write" ? t.effect === "write_own" : c.by.includes(t.name) && (!c.wrote?.includes(t.name) || t.effect === "write_own")));
};
// The sentences of a reply that claim a change no tool made this turn, with the kind of each claim.
export function unbackedClaims(reply: string, calls: Call[]): { index: number; kind: string }[] {
  const out: { index: number; kind: string }[] = [];
  pieces(reply).forEach((p, index) => { const kind = claimsIn(p.text).find((k) => !backedBy(k, calls)); if (kind) out.push({ index, kind }); });
  return out;
}
export function unbackedClaim(reply: string, calls: Call[]): string | null {
  return unbackedClaims(reply, calls)[0]?.kind ?? null;
}
// WO-080: a failed tool call's record carries its reason, so a diagnosis starts from the record, not from the code. The
// reason is cleaned first: tokens, keys, long secrets, database URLs, secret-carrying query values, emails and phone
// numbers become [bracketed] placeholders; the words that say what went wrong, and record ids (UUIDs), stay. Pure; at
// most 300 characters.
// (What the model is told about the failure is unchanged.)
export const ERROR_CHARS = 300;
const SCRUB: [RegExp, string][] = [
  [/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[db-url]"],
  [/\b(authorization["']?\s*[:=]\s*)(?:(?:Bearer|Basic|Token|Digest)\s+)?[^\s,;)}\]]+/gi, "$1[redacted]"],
  [/\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+\/=-]*\d)[A-Za-z0-9._~+\/=-]{8,}/gi, "$1 [token]"],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/g, "[jwt]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "[key]"],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[key]"],
  [/([?&#][^=&\s#"']*(?:secret|token|key|password|passwd|sig|signature|auth|code)[^=&\s#"']*=)[^&\s#"']*/gi, "$1[redacted]"],
  [/\b((?:api[_-]?key|apikey|password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|authorization|client[_-]?secret)["']?\s*[:=]\s*)(?!\[)(?:"[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi, "$1[redacted]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]"],
  [/(?<![\w.\/-])\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)|\d{1,4})(?:[\s.-]?\d{2,4}){2,4}(?![\w-])/g, "[phone]"],
  [/(?<![\w.\/-])(?:\([2-9]\d{2}\)|[2-9]\d{2})[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])/g, "[phone]"],
  [/\b[A-Fa-f0-9]{24,}\b/g, "[secret]"],
  [/(?<![A-Za-z0-9+\/_-])(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9+\/_-]))(?=[A-Za-z0-9+\/_-]*\d)(?=[A-Za-z0-9+\/_-]*[A-Za-z])[A-Za-z0-9+\/_-]{24,}={0,2}/g, "[secret]"],
];
function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  try { return JSON.stringify(e) ?? String(e); } catch { return String(e); }
}
export function scrubError(text: string): string {
  let s = errorText(text);
  for (const [re, to] of SCRUB) s = s.replace(re, to);
  s = s.replace(/\s+/g, " ").trim();
  return s.length > ERROR_CHARS ? `${s.slice(0, ERROR_CHARS - 1)}…` : s;
}
// WO-085: a refusal that means "the next move is the person's" (a resume waiting on their yes). The model reads its
// message like any refusal; the loop then forbids tools on the next call, so the model writes the question and the turn
// ends on its words, never on max steps.
export class AskPerson extends Error {}
const MAX_TOKENS = 1200;
const RESULT_CHARS = 12000; // a tool result larger than this is cut, and the cut is said

function resultText(v: unknown): string {
  let s: string;
  try { s = typeof v === "string" ? v : JSON.stringify(v ?? null); } catch { s = String(v); }
  return s.length > RESULT_CHARS ? `${s.slice(0, RESULT_CHARS)}… [cut: ${s.length - RESULT_CHARS} more characters]` : s;
}

// A structural check, not a semantic judge: a deictic closing question or an acknowledgement cannot stand in for
// the requested answer. Check AFTER the truth filters, which may have removed the entire answer body. Concrete
// clarification questions, short factual answers and a phrase the person explicitly asked to copy remain valid.
const CLOSING_ONLY = /^(?:is (?:that|this) (?:right|correct|accurate|okay|ok)|does (?:that|this) (?:help|work|make sense|sound (?:right|good))|(?:would|will) (?:that|this) work|are we (?:aligned|on the same page)|tell me if (?:that|this|anything) (?:is |sounds )?(?:off|wrong|right)|let me know if (?:that|this) (?:helps|works|sounds (?:right|good)))$/i;
const ACK_ONLY = /^(?:ok(?:ay)?|got it|understood|noted|sure|thanks|thank you|will do|done|all set|sounds good)$/i;
// A bare acknowledgement is enough for a purely social turn, not an arbitrary work request. Using a list of request
// verbs let imperative requests outside that list (for example prepare/find) silently pass without work or a question.
const SOCIAL_MESSAGE = /^(?:hi|hello|hey(?: there)?|thanks(?: a lot)?|thank you(?: very much)?|ok(?:ay)?|got it|understood|noted|sure|yes|yep|no|nope|cool|great|nice|perfect|sounds good|done)[.!?\s]*$/i;
// Pre-tool progress is not the completed work. In particular, keeping an earlier promise to write a plan must not
// suppress repair when the last text is only a closing question. A colon or another substantive sentence can carry
// actual content, and is left alone; this does not attempt to grade the semantic quality of a plan.
const PROGRESS_ONLY = /^(?:let me|i(?:'ll| will| am going to|'m going to))\s+(?:(?:just|first|now)\s+)?(?:check|look|search|find|read|review|save|record|prepare|draft|write|create|build|make|put together|work on|gather|think)\b[^:\n]*$/i;
const ANSWER_WORDS = /\b(?:what|why|how|which|when|where|who|give|show|list|explain|draft|write|compare|outline|plan|recommend|suggest|summari[sz]e|help)\b/i;
const ANSWER_REQUEST = new RegExp("\\?|" + ANSWER_WORDS.source, "i");
const RECEIPT_REQUEST = /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:save|remember|keep|store|record|note)\b/i;
const QUESTION_LEAD = /^\s*(?:am|is|are|was|were|do|does|did|can|could|should|would|will|have|has|had)\b/i;
function requestsAnswerBody(message: string): boolean {
  return pieces(plainQuotes(message)).flatMap(({ text }) => text.split(/[;—–]/)).some((text) => {
    const request = text.trim();
    const receipt = RECEIPT_REQUEST.exec(request);
    if (!receipt) return ANSWER_REQUEST.test(request);
    const note = request.slice(receipt[0].length);
    // "Can you remember which..." asks for recall; an instruction to remember a supplied note asks for a write.
    if (/\byou\s+(?:please\s+)?remember$/i.test(receipt[0]) && /^\s*(?:what|why|how|which|when|where|who)\b/i.test(note)) return true;
    // The saved note can contain words such as "plan" or "how". Check additional coordinated requests and
    // independent questions, rather than treating the note or its question mark as another requested answer.
    return note.split(/[,;—–]|\b(?:and|then|also|but)\b/i).slice(1).some((clause) =>
      ANSWER_WORDS.test(clause) || (QUESTION_LEAD.test(clause) && /\?/.test(clause)));
  });
}
// These are the fact guard's fill-in fields. They are useful in requested drafts, but cannot stand in for a fact
// when answering a question. This authorizes an output format, never chooses an answer or a tool by topic.
const FACT_PLACEHOLDER = /\[(?:your (?:skill|title|degree)|number|result|month|employer or school)\]/gi;
function unresolvedFactFields(reply: string, message: string, sources: string[]): boolean {
  const fields = reply.match(FACT_PLACEHOLDER) ?? [];
  if (!fields.length || fields.every((f) => plainQuotes(message).toLowerCase().includes(f.toLowerCase()))) return false;
  const contentRequest = /(?:^|[.!?]\s+)\s*(?:(?:please|(?:can|could|would|will) you(?: please)?)\s+)?(?:write|draft|compose|rewrite|revise|edit|rephrase|shorten|give|show|make|create|prepare|i (?:need|want|would like)|i'd like)\b/i.test(plainQuotes(message));
  const draftFormat = /\b(?:templates?|fill[- ]in|placeholders?|emails?|messages?|letters?|notes?|repl(?:y|ies)|essays?|resumes?|bios?|scripts?)\b/i.test(message);
  if (contentRequest && draftFormat) return false;
  const sourceWords = new Set(sources.join(" ").toLowerCase().match(/[\p{L}\p{N}+#]+/gu) ?? []);
  // A surviving supported explanation remains useful. A placeholder plus generic praise supplies none, whereas
  // a qualifier naming actual recorded work can carry an answer independently of the missing field.
  const clauses = pieces(reply).map((p) => p.text.trim()).filter(Boolean);
  return clauses.length > 0 && clauses.every((clause) => {
    if (!(clause.match(FACT_PLACEHOLDER) ?? []).length) return CLOSING_ONLY.test(clause.replace(/[.!?]+$/, "")) || ACK_ONLY.test(clause.replace(/[.!?]+$/, ""));
    const context = /\b(?:from|at|using|with|through|during)\s+([^.!?\n\[\]]+)/gi;
    return ![...clause.matchAll(context)].some((m) => (m[1].toLowerCase().match(/[\p{L}\p{N}+#]+/gu) ?? []).some((w) => w.length > 3 && sourceWords.has(w)));
  });
}
function missingAnswerBody(reply: string, message: string, receiptOnly = false, sources: string[] = []): boolean {
  if (!/[\p{L}\p{N}]/u.test(reply)) return true;
  const quoted = [...plainQuotes(message).matchAll(/"([^"\n]+)"/g)].map((m) => m[1]);
  if (/\b(?:reply|respond|say|repeat|copy)\b[^\n]{0,40}\b(?:exactly|verbatim)\b/i.test(message) && quoted.includes(plainQuotes(reply))) return false;
  // In a drafted message, "I'll review the role tonight" can be the requested deliverable, not this agent's
  // promise. Preserve an utterance the person actually supplied, including its contracted spelling. A general
  // request to draft something does not exempt the agent's own "I'll draft it" preamble.
  const utterance = (s: string) => plainQuotes(s).toLowerCase().replace(/\bi'll\b/g, "i will").replace(/[.!?]+$/, "").trim().replace(/\s+/g, " ");
  if (/\b(?:write|draft|compose|word|say|saying|tell|respond)\b/i.test(message) &&
    /\b(?:reply|message|email|text|note|letter|sentence|script)\b/i.test(message) && utterance(message).includes(utterance(reply))) return false;
  if (unresolvedFactFields(reply, message, sources)) return true;
  const clauses = pieces(plainQuotes(reply).replace(/\b(that|this|it)'s\b/gi, "$1 is").replace(/[*_`~]/g, "")).flatMap((p) => p.text.split(/[;—–]/)).map((s) => s.trim().replace(/^(?:[-•]|\d+[.)])\s+/, "").replace(/[.!?]+$/, "").trim()).filter(Boolean);
  return clauses.length > 0 && clauses.every((s) => CLOSING_ONLY.test(s) || (!SOCIAL_MESSAGE.test(message.trim()) && (ACK_ONLY.test(s) || PROGRESS_ONLY.test(s))) || (receiptOnly && claimsIn(s).some((k) => k !== FILE_CLAIM)));
}
// REPLY SHAPE: what the turn staged and which links it may show ride the result, whichever way the turn ended.
// The flag-only reply checks of a turn (missing_ack, many_asks, unbacked_promise), as the meta the career handler saves with
// the response and the assistant message. Empty when the turn raised none (Greptile on #566).
export function replyFlagsMeta(turn: { flags?: unknown } | null | undefined): { reply_flags?: string[] } {
  const f = Array.isArray(turn?.flags) ? turn!.flags.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  return f.length ? { reply_flags: f } : {};
}

export async function runAgentTurn(o: Parameters<typeof runAgentTurnInner>[0]): Promise<TurnResult> {
  const r = await runAgentTurnInner(o);
  const attachments = o.ctx.turn?.attachments ?? [];
  const seen = o.ctx.turn?.seen ?? [];
  const typed = [o.said ?? o.message, ...o.history.filter((m: any) => m && m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))].join("\n");
  const fileLinks = o.ctx.turn?.fileLinks ?? [], paySources = o.ctx.turn?.paySources ?? [];
  return { ...r, ...(attachments.length ? { attachments } : {}), ...(fileLinks.length ? { fileLinks } : {}), ...(paySources.length ? { paySources } : {}), linksSeen: urlsIn(`${typed}\n${seen.join("\n")}`) };
}
const COMPLETENESS_REPAIR = "The previous draft did not contain an answer body after output validation. Answer the person's original request using only the conversation and successful tool results already available. Give the requested content, or ask a concrete question for missing information. A generic acknowledgement, action receipt, closing confirmation or unresolved fill-in field is not the requested answer. Keep placeholders only in a draft or template the person requested. Do not invent personal facts or claim actions. Tools are disabled for this single repair; do not repeat any action.";

// `said` (ADVERSARIAL ROUND 2, 2026-10-30): the person's own words when `message` also carries what code appended to them
// (an attached file's name and text). The model reads `message`; every tool check that asks "did the person say this"
// (a confirmation, a kept instruction, a fact, a contact) reads `said`, and the appended text rides `turn.attached`.
// `shown` (D-070, live-7 C22): pay lines Trainee's own earlier replies showed (turn_notes.ts shownPayOf), each from the posting or
// source it named then: a figure on one of them may be said again (D-067 (10)); the reply carries its link (career_brain.ts).
// `process` (D-065): the turn's process check. Given the model's draft reply and the calls made so far, it returns what the turn
// still has to do (call the draft tool, search before the plan, cover a part they asked about) or null. Put to the model once,
// with its tools, the same way as the reply guards' review; whatever stands after that is kept and flagged (process_unmet).
// D-071: the words a search or research call used (no person's data: a search query, a company, research queries), for the trace.
const ARGS_OF: Record<string, string[]> = { search_jobs: ["query", "limit"], research_market: ["companies", "queries", "format"], research_company: ["company", "role", "focus"] };
export function argsOf(name: string, input: unknown): Record<string, unknown> | null {
  const keys = ARGS_OF[name], i = input && typeof input === "object" ? input as Record<string, unknown> : null;
  if (!keys || !i) return null;
  const clip = (v: unknown): unknown => typeof v === "string" ? v.slice(0, 200) : typeof v === "number" ? v : Array.isArray(v) ? v.slice(0, 6).map(clip) : null;
  const out = Object.fromEntries(keys.filter((k) => i[k] !== undefined && i[k] !== null).map((k) => [k, clip(i[k])]));
  return Object.keys(out).length ? out : null;
}
async function runAgentTurnInner(o: { system: string; history: any[]; message: string; said?: string; tools: ToolSpec[]; model: ModelFn; ctx: ToolCtx; maxSteps?: number; shown?: string[]; process?: ((reply: string, calls: TurnResult["tool_calls"]) => string | null) | null }): Promise<TurnResult> {
  const max = o.maxSteps ?? 6;
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const toolDefs = o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const messages: any[] = [...o.history, { role: "user", content: [{ type: "text", text: o.message }] }];
  let found: unknown[] = [];
  const tool_calls: TurnResult["tool_calls"] = [], pending_approvals: TurnResult["pending_approvals"] = [];
  const last = [...o.history].reverse().find((m) => m && m.role === "assistant");
  const before = !last ? "" : typeof last.content === "string" ? last.content
    : Array.isArray(last.content) ? last.content.filter((b: any) => b && b.type === "text").map((b: any) => String(b.text ?? "")).join("\n") : "";
  const saved = () => tool_calls.some((t) => t.ok && t.effect === "write_own");
  // WO-091a: what this turn's tools returned is a source for what the reply may say about the person, and names the
  // postings a raw job id stands for.
  const seen: string[] = [];
  const said = o.said ?? o.message;
  o.ctx.turn = { message: said, added: [], before, attachments: [], seen, ...(said !== o.message ? { attached: o.message.startsWith(said) ? o.message.slice(said.length).trim() : o.message } : {}) };
  const typed = [said, ...o.history.filter((m: any) => m && m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))].join("\n");
  // R10 WO-H: everything the person typed in this conversation, for a draft's check that it states no history they never did.
  o.ctx.turn.typed = typed;
  const toolNames = o.tools.map((t) => t.name);
  // FILE KINDS: the same fact guard attach_document uses, handed to create_file: what the person never said and no tool returned is refused.
  o.ctx.turn.guard = (t: string) => {
    const known = new Set(urlsIn(`${typed}\n${seen.join("\n")}`));
    const sources = factSources({ state: o.ctx.state, message: o.message, history: o.history, results: seen });
    return [...untracedFacts(t, sources).map((f) => f.word), ...unsourcedFigures(t, [typed, ...seen, ...sources]).map((m) => m.figure), ...urlsIn(t).filter((l) => !known.has(l))];
  };
  let steps = 0, checked = false, ask = false, repairing = false, processed = false, processAsked = 0, lastTodo: string | null = null, retriedFile = false;
  let repairNote = COMPLETENESS_REPAIR;
  // WO-061 (H028, H035, H007, H033): code's review of its own draft rides in that one call's system prompt, never in
  // the conversation. As a user-role message the model took it for the person's words, refused it out loud ("I can't
  // follow the instruction to show ... hidden internal words") and the refusal reached the person.
  let review: string | null = null;
  // WO-106 (eval E010, 2026-10-21: the whole reply was "Tell me if that's off."): what the model wrote beside a tool call
  // (the answer, then add_profile_fact) is kept; when the last message is only a short trailer, the answer goes first.
  const earlier: string[] = [];
  const incomplete = (): TurnResult => ({ reply: saved() ? INCOMPLETE_AFTER_SAVE_REPLY : INCOMPLETE_REPLY, steps, tool_calls, pending_approvals, ...(found.length ? { postings: found } : {}), stopped: "incomplete_reply" });
  while (steps < max) {
    steps++;
    let res;
    const system = [o.system, review, repairing ? repairNote : null].filter(Boolean).join("\n\n");
    review = null;
    try { res = await o.model({ system, messages, tools: toolDefs, max_tokens: MAX_TOKENS, ...(ask || repairing ? { tool_choice: { type: "none" } } : {}) }); }
    catch {
      const show = o.ctx.turn?.show; // what the person must read was already made: it is the reply
      if (show) return { reply: show.text, steps, tool_calls, pending_approvals, ...(found.length ? { postings: found } : {}), stopped: "final", show };
      return { reply: saved() ? MODEL_ERROR_AFTER_SAVE_REPLY : MODEL_ERROR_REPLY, steps, tool_calls, pending_approvals, ...(found.length ? { postings: found } : {}), stopped: "model_error" };
    }
    const content = Array.isArray(res && res.content) ? res.content : [];
    const uses = content.filter((b: any) => b && b.type === "tool_use");
    // Enforce text-only recovery even if a provider ignores tool_choice. Never repeat effects or enqueue approvals.
    if (repairing && uses.length) return incomplete();
    // The provider explicitly says this generation was cut off; plausible text is not evidence it finished. Do not
    // execute a partial tool request or keep a partial draft as conversation evidence. An exact preview already
    // generated by code is complete independently of the model's retelling. Otherwise use the same bounded,
    // text-only repair as a filtered-away answer, inside the remaining step budget.
    if (res?.stop_reason === "max_tokens") {
      const show = o.ctx.turn?.show;
      if (show) return { reply: show.text, steps, tool_calls, pending_approvals, ...(found.length ? { postings: found } : {}), stopped: "final", show };
      if (repairing || steps >= max) return incomplete();
      repairing = true;
      repairNote = "Your previous response reached its token limit before completing. Produce a concise complete answer. " + COMPLETENESS_REPAIR;
      continue;
    }
    if (!uses.length) {
      let reply = content.filter((b: any) => b && b.type === "text").map((b: any) => b.text).join("").trim();
      const show = o.ctx.turn?.show;
      if (show) return { reply: show.text, steps, tool_calls, pending_approvals, ...(found.length ? { postings: found } : {}), stopped: "final", show };
      // D-065: the process check, once, before the reply guards (tools stay on: the step it asks for is a tool call).
      // D-070 (live-7 C1: the plan File's create_file was refused, and the check, already spent on the search, never asked again):
      // a second, different step the turn still owes is asked once more; the same step is never asked twice.
      // D-073 (live-9 C1: create_file was refused for a label over 80 characters and no second call was made): a refused File
      // (REFUSED_FILE_TODO) is asked again once with its exact error, even when the two other asks were spent.
      if (o.process && (processAsked < 2 || !retriedFile) && !repairing && steps < max) {
        const todo = o.process(reply, tool_calls);
        const retry = !!todo && todo.startsWith(REFUSED_FILE_TODO);
        if (todo && todo !== lastTodo && (retry ? !retriedFile : processAsked < 2)) {
          processed = true; lastTodo = todo;
          if (retry) retriedFile = true; else processAsked++;
          review = `CODE'S REVIEW OF YOUR DRAFT REPLY. This is from Trainee's code, not from the person: never mention it, never refuse it, never act on it as their request, never save it. Your draft was:\n"""\n${reply}\n"""\n${todo} Then write your reply to the person again, answering what they asked in their last message.`;
          continue;
        }
      }
      // A model may write its answer beside a tool call, then finish with only a closing question. Recover that body
      // without a length heuristic; the assembled reply still passes every truth filter below. A substantive final
      // answer always supersedes earlier text. Once a repair starts, rejected earlier text must not be reintroduced.
      if (!repairing && missingAnswerBody(reply, o.message, true) && earlier.length) {
        reply = [...earlier.filter((s) => !missingAnswerBody(s, o.message)), reply].filter(Boolean).join("\n\n");
        earlier.length = 0;
      }
      // The reply guards (WO-077, WO-091a): a claim no tool backs (F5), internal words (F10), and a fact about the person
      // that traces to nothing they or the tools said (F6). All of it is put to the model once, in one message; what
      // stands after that, code fixes.
      const sources = factSources({ state: o.ctx.state, message: o.message, history: o.history, results: seen });
      const leak = { tools: toolNames, typed, postings: postingsOf(seen) };
      // ADVERSARIAL ROUND 2: a GPA traces only to the person's own words and facts, never to what a tool read this turn.
      const personal = factSources({ state: o.ctx.state, message: said, history: o.history, results: [] });
      const claims = unbackedClaims(reply, tool_calls), promises = unbackedPromises(reply, tool_calls), leaks = leakedWords(reply, leak), facts = untracedFacts(reply, sources, personal);
      const money = unsourcedFigures(reply, [typed, ...seen, ...sources, ...(o.shown ?? [])]);
      // D-067 (C20, D-007): a number said to be what the person asked for is in their own words.
      const theirs = [said, ...(o.history ?? []).filter((m) => m.role === "user").map((m) => String(m.content ?? ""))];
      const misquote = misquotedAsks(reply, theirs);
      const waiver = waiverSolicits(reply, standingRefusal, o.message);
      // FLAG ONLY (#540: code never cuts the model's answer): asked once; a draft that still violates is kept as written.
      const manyAsks = multiAsk(reply) || promises.length > 0;
      const noAck = missingAck(said, reply);
      // D-054 (R03): small talk answered with a pitch (an introduction, a list of what Trainee does, an ask for a role).
      const pitch = smallTalkPitch(said, reply);
      const creds = credentialAsks(reply); // D-066 (P14)
      if ((creds.length || claims.length || leaks.length || facts.length || money.length || misquote.length || waiver.length || manyAsks || noAck || pitch.length) && !checked && !repairing && steps < max) {
        checked = true;
        const told = [
          pitch.length ? `They made small talk. Answer it in one plain sentence, as a person would. Remove these sentences: ${pitch.map((k) => `"${pieces(reply.trim())[k]?.text ?? ""}"`).join(" ")}. No introduction, no list of what you do, no question about a role or a search; only if SITUATION shows something waiting on them, name that one thing as your last sentence.` : "",
          noAck ? `Your first sentence was: "${pieces(reply.trim())[0]?.text ?? ""}". They said they feel overwhelmed. Replace that opening with one short, warm sentence acknowledging how they feel; the nothing-sent line comes after it, never first.` : "",
          creds.length ? "Your reply asks the person to send a password, code, key or login in this chat. Never ask for one: secrets never go through chat, and a login is the person signing in themselves on the site's own page. Remove that ask." : "",
          claims.length ? `Your reply says ${[...new Set(claims.map((c) => c.kind))].join(" and ")}, but no tool that does that succeeded this turn. Either call the tool now, or rewrite the reply without saying it happened.` : "",
          leaks.length ? `Your reply shows internal words the person must never see: ${leaks.join(", ")}. Say it in plain words; name a posting by its title and company.` : "",
          misquote.length ? `Your reply says they asked for ${[...new Set(misquote.map((m) => m.figure))].join(", ")}, but they never gave that number. Say only what they asked in their own words, and what was done.` : "",
          money.length ? `Your reply states pay, money or count figures that no tool returned this turn and they did not say: ${[...new Set(money.map((m) => m.figure))].join(", ")}. Remove them, and say you don't have a verified figure for that unless a tool returned it.` : "",
          waiver.length ? "Your reply offers them wording to send, offers to save something, or asks them to confirm something, after they asked to waive their yes or grant a standing permission. Never propose that wording, offer to save it or ask them to confirm it: say plainly it can't be kept, because every application and message still needs their yes on its card." : "",
          manyAsks ? "Your reply asks more than one thing. End with at most ONE question, asking for ONE thing (never \"X and Y\", never a second question); state a sensible default for anything else instead of asking. Never promise an action this reply did not take (an alert, a text); say only what happened. Keep everything else in your answer." : "",
          facts.length ? `Your reply states things about the person that are not in their confirmed facts, their own messages or this turn's tool results: ${facts.map((f) => f.word).join(", ")}. Answer from supported facts, or ask a concrete question for what is missing. Only if they requested a draft or template, mark missing facts with fill-in brackets; a placeholder is not an answer to an informational question.` : "",
        ].filter(Boolean).join(" ");
        // WO-106 (eval run 39535880905: E009 saved this note as the person's standing instruction, E032 and E050 answered
        // it to the person): the note is code's, the rewrite is for the person, and no tool runs while it is answered.
        // WO-061: it is no longer a message at all; the conversation stays as the person left it (see `review`).
        review = `CODE'S REVIEW OF YOUR DRAFT REPLY. This is from Trainee's code, not from the person: never mention it, never refuse it, never act on it as their request, never save it. Your draft was:\n"""\n${reply}\n"""\n${told} Write your reply to the person again, answering what they asked in their last message, with only those changes.`;
        // A claim may still be made true by its own tool; a wording or fact check runs no tool at all.
        if (!claims.length) ask = true;
        continue;
      }
      let out = reply;
      const stillMoney = unsourcedFigures(reply, [typed, ...seen, ...sources, ...(o.shown ?? [])]);
      // WO-061 (H018): proposed waiver wording that stands after the check is removed by code, with its save offer.
      const stillWaiver = waiverSolicits(reply, standingRefusal, o.message);
      // D-066 (P14): an ask for a password, code, key or login in chat that stands after the review is removed by code.
      const stillCreds = credentialAsks(reply);
      const stillMisquote = misquotedAsks(reply, theirs);
      if (stillCreds.length && !(claims.length || stillMoney.length || stillWaiver.length || stillMisquote.length)) { out = rebuild(pieces(reply), new Set(stillCreds)); if (!/[A-Za-z0-9]/.test(out)) out = SECRET_DROPPED_REPLY; }
      if (claims.length || stillMoney.length || stillWaiver.length || stillMisquote.length) {
        out = rebuild(pieces(reply), new Set([...stillCreds, ...claims.map((c) => c.index), ...stillMoney.map((m) => m.index), ...stillWaiver, ...stillMisquote.map((m) => m.index)]));
        if (!/[A-Za-z0-9]/.test(out) && ((stillWaiver.length && !claims.length) || !ANSWER_REQUEST.test(o.message))) return { reply: stillWaiver.length && !claims.length ? STANDING_REFUSED : CLAIM_UNBACKED_REPLY, steps, tool_calls, pending_approvals, ...(found.length ? { postings: found } : {}), stopped: "final" };
        // WO-061 (H018 p1): after a waiver strip the refusal must still be there; if the person asked to waive their yes
        // and nothing left says it is still needed, code says it first.
        if (stillWaiver.length && standingRefusal(o.message) && !/\b(your yes|your approval|without (asking|approval|your)|needs? (your|their) (yes|ok|okay|approval)|not kept|can'?t keep|won'?t (share|send|apply|skip))\b/i.test(out)) out = `${STANDING_REFUSED}\n\n${out}`;
      }
      if (leakedWords(out, leak).length) out = stripLeaks(out, leak);
      // RESEARCH ROUND 3: a posting read as closed this turn is never left sounding open.
      const closed = closedNotes(out, seen);
      if (closed.length) out = `${closed.join(" ")}\n\n${out}`;
      if (untracedFacts(out, sources, personal).length) out = bracketUntraced(out, sources, personal);
      // ADVERSARIAL ROUND 2: a key-shaped string never reaches the person (reply_guards.ts stripSecrets).
      if (secretIn(out)) { out = stripSecrets(out); if (!/[A-Za-z0-9]/.test(out)) out = SECRET_DROPPED_REPLY; }
      // A successful write backs its receipt, but does not answer a request for content. A plain fact statement
      // can still end with a backed receipt; use the existing answer-request check rather than grading its prose.
      if (missingAnswerBody(out, o.message, requestsAnswerBody(o.message), sources)) {
        if (repairing || steps >= max) return incomplete();
        // Keep code's instruction out of conversation history and user-fact sources. This uses the remaining turn
        // budget, is attempted once, and cannot execute tools. The repaired answer passes the same filters again.
        repairing = true;
        if (!out.trim()) repairNote = "Your last answer was empty. " + COMPLETENESS_REPAIR;
        continue;
      }
      const flags = [...(processed && o.process?.(out, tool_calls) ? ["process_unmet"] : []), ...(missingAck(said, out) ? ["missing_ack"] : []), ...(multiAsk(out) ? ["many_asks"] : []), ...(unbackedPromises(out, tool_calls).length ? ["unbacked_promise"] : []), ...(smallTalkPitch(said, out).length ? ["small_talk_pitch"] : [])];
      return { reply: out, steps, tool_calls, pending_approvals, ...(found.length ? { postings: found } : {}), ...(flags.length ? { flags } : {}), stopped: "final" };
    }
    const pre = content.filter((b: any) => b && b.type === "text").map((b: any) => String(b.text ?? "")).join("").trim();
    if (pre) earlier.push(pre);
    messages.push({ role: "assistant", content });
    const results: any[] = [];
    for (const u of uses) {
      const t = byName.get(u.name);
      const args = argsOf(u.name, u.input);
      const fail = (effect: Effect | null, msg: string, why: unknown = msg) => { tool_calls.push({ name: u.name, ok: false, effect, error: scrubError(why as string), ...(args ? { args } : {}) }); results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: msg }); };
      if (!t) { fail(null, `unknown tool: ${u.name}`); continue; }
      const input = u.input && typeof u.input === "object" ? u.input : {};
      const missing = (t.input_schema.required || []).filter((k) => input[k] === undefined || input[k] === null || input[k] === "");
      if (missing.length) { fail(t.effect, `missing required input: ${missing.join(", ")}`); continue; }
      if (t.effect === "external") {
        pending_approvals.push({ tool: t.name, input: JSON.parse(JSON.stringify(input)), summary: t.description });
        // Review of #790: one yes never means two things. A question code asked about a set-aside fact (its marker is restore_ask)
        // is not shown in a turn that also asks for an approval, and tools see that one is waiting.
        if (o.ctx.turn) { (o.ctx.turn as { pendingApprovals?: number }).pendingApprovals = pending_approvals.length; if (o.ctx.turn.show?.meta?.restore_ask) o.ctx.turn.show = undefined; }
        tool_calls.push({ name: t.name, ok: true, effect: t.effect });
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify({ status: "needs_approval", note: "Nothing has been sent. The person must approve this exact action first." }) });
        continue;
      }
      try {
        const out = await t.run(input, o.ctx);
        // REPLY SHAPE: a staged document passes the same guards as a reply (facts about the person, money, links) or the model is told why not.
        const att = u.name === "attach_document" && out && typeof out === "object" ? (out as any).attachment : null;
        if (att) {
          const knownLinks = new Set(urlsIn(`${typed}\n${seen.join("\n")}`));
          const sources = factSources({ state: o.ctx.state, message: o.message, history: o.history, results: seen });
          const bad = [...untracedFacts(att.content, sources).map((f) => f.word), ...unsourcedFigures(att.content, [typed, ...seen, ...sources]).map((m) => m.figure),
            ...urlsIn(att.content).filter((l) => !knownLinks.has(l))]; // exact match against links the person typed or a tool returned, never a substring (a cut-off or prefix URL is a different link)
          if (bad.length) { throw new Error(`not attached: the file states things no tool returned this turn and the person did not say: ${[...new Set(bad)].slice(0, 8).join(", ")}. Remove them or mark them "not verified", then attach again.`); }
          o.ctx.turn!.attachments!.push({ filename: att.filename, content: att.content });
        }
        tool_calls.push({ name: t.name, ok: true, effect: t.effectOf ? t.effectOf(out) : t.effect, ...(args ? { args } : {}) });
        results.push({ type: "tool_result", tool_use_id: u.id, content: resultText(out) });
        seen.push(resultText(out));
        if (u.name === "search_jobs" && out && Array.isArray((out as any).postings)) found = (out as any).postings.slice(0, 50);
        // D-070 (live-7 C11): every posting a tool read this turn with its stated pay and link (get_posting, inspect_apply_flow,
        // check_posting_open, search_jobs), so a reply that gives that pay carries that posting's link (career_brain.ts payWithSource).
        const ps = payPostingsOf(out);
        if (ps.length && o.ctx.turn) (o.ctx.turn.paySources ??= []).push(...ps);
      } catch (e) { if (e instanceof AskPerson) ask = true; fail(t.effect, e instanceof Error ? e.message : String(e), e); }
    }
    messages.push({ role: "user", content: results });
  }
  const show = o.ctx.turn?.show;
  if (show) return { reply: show.text, steps, tool_calls, pending_approvals, ...(found.length ? { postings: found } : {}), stopped: "final", show };
  return { reply: saved() ? MAX_STEPS_AFTER_SAVE_REPLY : MAX_STEPS_REPLY, steps, tool_calls, pending_approvals, ...(found.length ? { postings: found } : {}), stopped: "max_steps" };
}
