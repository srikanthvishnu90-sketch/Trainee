// SUBMIT-STEER-1130 / SPLIT-1146 (c): "where are my applications", "did my application to Acme go through?", read back
// from career_apply_jobs, the one record of what was sent.
//
// The queue records each application's outcome there (career_apply_finish_own, the cloud worker, the employer's email
// confirmation). Before this the chat never read it: "where are my applications" answered from the router's own tracker,
// and a question about one employer got the banner. This answers from the record only:
//   - "submitted" only as recorded; "confirmed" only when the record says the employer confirmed it (their email). A
//     page's thank-you is "submitted, not confirmed yet"; an unknown outcome is unknown, and never sent again;
//   - an employer with no record is said to have none, never assumed sent;
//   - a record that cannot be read is said so; nothing is guessed.
// Anything that is not a question about where applications stand returns null, and the turn goes on as before.
import { sameCompany } from "./career_mail.ts";

export const STATUS_INTENT = "career_apply_status";
const MAX_LISTED = 8, RECENT_DAYS = 30;

// One application as career_apply_jobs keeps it (the columns read; no answer's text).
export interface AppRow {
  id: string; company: string; state: string; reason?: string | null; confirmation_id?: string | null;
  email_confirmed_at?: string | null; created_at: string; updated_at: string; title?: string | null; url?: string | null;
}
export type ReadApplications = (userId: string) => Promise<AppRow[]>;

// The production read: the person's rows, newest first (their own; the service role reads for the person who texted).
// deno-lint-ignore no-explicit-any
export function supabaseApplications(admin: any): ReadApplications {
  return async (userId) => {
    const r = await admin.from("career_apply_jobs").select("id,company,url,state,reason,confirmation_id,email_confirmed_at,created_at,updated_at,title:payload->>title")
      .eq("user_id", userId).order("updated_at", { ascending: false }).limit(500);
    if (r.error) throw new Error(`read the applications: ${r.error.message}`);
    return (r.data ?? []) as AppRow[];
  };
}

const plain = (s: string) => ` ${String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[?!.]+\s*$/, "").replace(/\s+/g, " ").trim()
  .replace(/^[^\p{L}\p{N}"'(]+/u, "").replace(/^(?:(?:hey|hi|hello|ok|okay|pls|please)\b[,!:]?\s+)+/, "").replace(/,? (?:please|pls|thanks|thank you)$/, "")
  // TELEGRAM BRIEF (brief P7 target 2): "did my Acme application actually go through" is the same question without "actually".
  .replace(/ (?:actually|really|even|ever|already) (?=(?:go|gone|get|been|send|sent|submit|submitted|work|land)\b)/g, " ")} `;
// ROUTING SCENARIOS (2026-10-29): "apps" is "applications"; "what did I apply to" / "what have I applied to" / "show me
// what I applied to" are the whole list; a greeting before the ask ("hey", "ok so", "please") is not part of it.
const ALL = /^ (?:so )?(?:where are|where'?s|how are|what'?s the status of|what is the status of|status of|any updates? on|update on|check on|show me the status of) (?:all )?(?:of )?my (?:job )?(?:applications?|apps) $|^ (?:did|have) (?:my|any of my) (?:applications?|apps) (?:go through|gone through|get sent|been sent|get submitted|been submitted) $|^ (?:so )?(?:what|which (?:jobs|companies|roles|employers)|where) (?:did i apply(?: to| for)?|have i applied(?: to| for)?|i'?ve applied(?: to| for)?)(?: so far| yet)? $|^ (?:show me|tell me|list) (?:what|where) i(?:'?ve| have)? applied(?: to| for)?(?: so far)? $/;
const ONE = [
  /^ (?:did|has|have) my application (?:to|for|at|with) (.+?) (?:go through|gone through|get sent|been sent|get submitted|been submitted|send|submit|work|land) $/,
  /^ was my application (?:to|for|at|with) (.+?) (?:sent|submitted|received|accepted) $/,
  /^ (?:did|have) you (?:apply|applied|submit|submitted|send|sent)(?: (?:it|my application))? (?:to|for|at|with) (.+?)(?: yet)? $/,
  /^ (?:what'?s|what is) the status of my application (?:to|for|at|with) (.+?) $/,
  /^ (?:where is|where'?s|how is|how'?s) my application (?:to|for|at|with) (.+?) $/,
  /^ did (?:the|my) (.+?) application (?:go through|get sent|get submitted|submit) $/,
];
// FEATURE 16: "did it go through?", "did that get sent?", "has it been submitted yet": the person's latest application.
const LATEST = /^ (?:so |and |ok |okay )?(?:did|has|have|was) (?:it|that|this|that one|that application|my application|the application) (?:go through|gone through|get sent|been sent|get submitted|been submitted|sent|submitted|send|submit|work|land)(?: yet)? $/;
// The question, if this text is one: every application, or the ones to one employer (named as the person typed it), or
// the latest one ("did it go through?").
export function statusAsk(message: string): { company: string | null; latest?: true } | null {
  const t = plain(message);
  if (ALL.test(t)) return { company: null };
  if (LATEST.test(t)) return { company: null, latest: true };
  for (const re of ONE) {
    const m = re.exec(t);
    if (!m) continue;
    const lower = m[1].replace(/^(?:the|a) /, "").trim();
    if (!lower || lower.length > 80) return null;
    const i = String(message).toLowerCase().indexOf(lower);
    return { company: i >= 0 ? String(message).slice(i, i + lower.length) : lower };
  }
  return null;
}

const date = (iso: string | null | undefined) =>
  iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
// What a stop that needs the person is, in their words (the queue keeps a code).
export const NEEDS_YOU_WORDS: Record<string, string> = {
  captcha: "a verification check on the employer's page, which Trainee never solves; finish it yourself at the link",
  bot_check: "a verification check on the employer's page, which Trainee never solves; finish it yourself at the link",
  login_required: "the employer's site asks you to sign in to an account first; Trainee never signs in for you",
  needs_answers: "the form asks a question you haven't answered yet; Trainee asked you instead of guessing",
};
// Submit worker round (2026-10-31): the queue keeps the worker's reason codes (HOST_RATE_LIMITED, RESUME_CHANGED,
// CARD_CLOUD_AUTHORIZATION_REFUSED, needs_answers, worker_stopping, ...), and "where are my applications" printed them as
// they are: "not sent (HOST_RATE_LIMITED)", "not sent (not sent: the posting closed ...)", "it needs you (needs_answers)".
// Every ended application now says why in the person's words; a code this table does not know says what its state means,
// never the code. Each says nothing was sent only where nothing was (a stop before the engine's Submit).
const NOTHING_SENT = "nothing was sent";
const CODE_WORDS: [RegExp, string][] = [
  [/^(HOST_RATE_LIMITED|rate_limited|DRIVER_HOST_REFUSED|HOST_HELD)$/, `the employer's site kept asking us to slow down; ${NOTHING_SENT}`],
  [/^(CAPTCHA_AT_SUBMIT|captcha|bot_check)$/, "the employer's page showed a verification check, which Trainee never solves; finish it yourself at the link"],
  [/^(login_required|ACCOUNT_LOGIN_REQUIRED|SIGNED_OUT|SIGN_IN_TIMEOUT|EMAIL_CODE_NEEDS_SIGN_IN)$/, "the employer's site asks you to sign in first; Trainee never signs in for you"],
  [/^needs_answers$/, `the form asks a question you haven't answered yet; Trainee asked you instead of guessing, and ${NOTHING_SENT}`],
  [/^(APPROVED_APPLICATION_CHANGED|APPROVED_BODY_MISMATCH|APPROVED_MANIFEST_CHANGED|INVALID_APPROVED_SCHEMA|CONTRACT_REFUSED|CONFLICTING_APPROVED_ANSWERS|PAYLOAD_CHANGED_BEFORE_CLICK|CODE_REQUEST_CHANGED_APPLICATION|FACTS_CHANGED|FORM_SCHEMA_CHANGED|POSTING_BINDING_MISMATCH|STATE_BINDING_MISMATCH|APPROVED_SOURCE_WITHDRAWN|approval_changed)$/, `the application or the form changed after you approved it, so it was not sent as approved; ${NOTHING_SENT}`],
  [/^(RESUME_CHANGED|RESUME_NOT_IN_CLOUD|NO_RESUME|RESUME_SHA_MISMATCH|resume_not_in_cloud|RESUME_INPUT_NOT_OBSERVED)$/, `the resume you approved could not be attached exactly as approved; ${NOTHING_SENT}`],
  [/^(FACTS_EXPIRED|approval_expired)$/, `your approval expired before it could be sent; ${NOTHING_SENT}`],
  [/^(ACCOUNT_PAUSED|person_paused)$/, `Trainee is paused for you; ${NOTHING_SENT}`],
  [/^FACTS_ERASED$/, `your Trainee data was erased; ${NOTHING_SENT}`],
  [/^(FACT_OWNER_MISMATCH|CONFIRMED_FACT_OWNER_REQUIRED)$/, `an answer was not one of your own confirmed facts, so it was not sent; ${NOTHING_SENT}`],
  [/^(duplicate_job|duplicate_posting)$/, `you already applied to this exact posting; ${NOTHING_SENT}`],
  [/^(daily_cap|daily_limit)$/, `you had reached the daily pace you set; ${NOTHING_SENT}`],
  [/^IDENTITY_NUMBER_REQUESTED$/, `the form asks for an identity number, which only you type; ${NOTHING_SENT}`],
  [/^(UNCONFIRMED_HIDDEN_FIELD|UNSUPPORTED_FILE_ARTIFACT|SUBMIT_DESTINATION_NOT_BOUND|SUBMIT_DESTINATION_UNEXPECTED|SUBMIT_DESTINATION_CHANGED|SCRIPT_SUBMIT_FAMILY_MISMATCH|HOST_REDIRECT_REFUSED|portal_not_cloud|person_submits)$/, `the employer's form works in a way Trainee does not submit for you; finish it at the link. ${NOTHING_SENT[0].toUpperCase()}${NOTHING_SENT.slice(1)}`],
  [/^(PERSON_SUBMITS_NEEDS_HEADED|HANDOFF_NEEDS_HEADED|PERSON_DID_NOT_SUBMIT|user_declined)$/, `this one is yours to submit at the link; ${NOTHING_SENT}`],
  [/^(CARD_CLOUD_[A-Z_]+|NO_ENGINE_APPROVAL|NOT_APPROVED|not_approved|stale|INCOMPLETE_CLOUD_CARD|posting_closed)$/, `the last check before Submit did not pass (your approval, your account or the posting changed); ${NOTHING_SENT}`],
  [/^(worker_stopping|WORKER_STOPPING|not_started_in_lease|NOT_STARTED_IN_LEASE|host_held|journal_unwritable|JOURNAL_BAD_ID|APPLY_CLAIM_CLOSED)$/, `it could not start in time; ${NOTHING_SENT}`],
];
// The apply VM worker's own stop codes (workers/career-browser): a required question it will not guess (the question follows the
// code: "missing_required_answer: Why Acme?"), a page it could not read or is not allowed to send to. Nothing was sent for any.
CODE_WORDS.push(
  [/^missing_required_answer$/, `the form asks a required question you have not answered; Trainee asked you instead of guessing, and ${NOTHING_SENT}`],
  [/^field_not_filled$/, `a required question could not be filled in and checked on the employer's form; Trainee did not guess, and ${NOTHING_SENT}`],
  [/^(host_not_allowed|host_denied|site_not_supported|invalid_url)$/, `Trainee does not apply on this site; ${NOTHING_SENT}`],
  [/^no_application_form_found$/, `no application form was found on the employer's page; ${NOTHING_SENT}`],
  [/^(retries_exhausted|page_load_\d+)$/, `the employer's page did not load; ${NOTHING_SENT}`],
  [/^WORKER_ERROR$/, `something went wrong on our side before it was sent; ${NOTHING_SENT}`],
  [/^(redirect_not_allowed|form_action_not_allowed)$/, `the employer's page pointed somewhere Trainee does not send to; ${NOTHING_SENT}`],
  [/^(resume_mismatch|invalid_payload)$/, `what was approved could not be read back exactly; ${NOTHING_SENT}`],
);
const NAMES_THE_QUESTION = /^(missing_required_answer|field_not_filled)$/;
const RAW_CODE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|^[a-z]+(?:_[a-z0-9]+)+$/;
// Why an application ended, in the person's words (no trailing period); `state` decides what a code nobody named means.
export function reasonWords(state: string, reason: string | null | undefined): string {
  const r = String(reason ?? "").replace(/\s+/g, " ").trim();
  const code = r.split(/[:\s]/)[0];
  for (const [re, words] of CODE_WORDS) {
    if (!(re.test(code) || re.test(r))) continue;
    // The question the worker would not guess is named: required question "Why do you want to work at Acme?".
    const q = NAMES_THE_QUESTION.test(code) ? r.slice(code.length).replace(/^:\s*/, "").slice(0, 90) : "";
    return q ? `${words} (the question: "${q}")` : words;
  }
  // Already prose (the database's own reasons): kept, without a "not sent:" the line already says.
  if (r && /\s/.test(r) && !RAW_CODE.test(r)) return r.replace(/^not sent:\s*/i, "").replace(/[.\s]+$/, "");
  if (state === "failed") return "the employer's site did not accept it";
  if (state === "needs_user") return "it needs you at the employer's page; it was not sent";
  return `it stopped before it could be sent; ${NOTHING_SENT}`;
}
export function statusLine(a: AppRow): string {
  const who = a.company || "An employer", name = `${who}${a.title ? ` (${a.title})` : ""}`, on = date(a.updated_at), conf = a.confirmation_id;
  switch (a.state) {
    case "confirmed":
      return `${name}: submitted, and ${who} confirmed it${conf ? ` (confirmation ${conf})` : ""}.`;
    case "submitted_unconfirmed":
      return `${name}: submitted${on ? ` on ${on}` : ""}; ${who} has not confirmed it yet${conf ? ` (their page showed ${conf})` : ""}.`;
    case "unknown_outcome":
      return `${name}: I can't tell whether it reached ${who}. It will not be sent again.`;
    case "needs_user":
      // Round 2 of the apply scenarios (2026-10-30): an emailed code is asked AFTER the application went (the receipt says
      // so); "stopped before it was sent" was untrue for it, and the reason was the queue's own code ("email_code").
      if (a.reason === "email_code") return `${name}: sent, but not finished: ${who} emailed you a code to finish it. Type it on their page yourself; it will not be sent again.`;
      return `${name}: stopped before it was sent; it needs you (${NEEDS_YOU_WORDS[String(a.reason)] ?? reasonWords(a.state, a.reason)}).`;
    case "failed":
    case "not_submitted":
      return `${name}: not sent (${reasonWords(a.state, a.reason)}).`;
    case "queued":
      // A site that asked us to slow down before anything was sent: the same application waits and goes by itself
      // (20261029180000 writes the reason, with when).
      return /^waiting: /.test(String(a.reason ?? "")) ? `${name}: approved, not sent yet; ${String(a.reason).slice(0, 240)}.` : `${name}: approved, not sent yet.`;
    case "driving":
      return `${name}: being sent now; not submitted yet.`;
    default:
      return `${name}: ${a.state}; not known to be sent.`;
  }
}

// The reply to a status question, from the rows (null: they could not be read). Null when the text is not one.
export function statusReply(message: string, rows: AppRow[] | null, now: number): { reply: string; status: string; intent: string } | null {
  const ask = statusAsk(message);
  if (!ask) return null;
  if (!rows) return { reply: "I couldn't read your applications just now, so I can't say whether any were sent. Ask me again in a minute.", status: "unreadable", intent: STATUS_INTENT };
  if (ask.latest) {
    const last = [...rows].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
    if (!last) return { reply: "I have no application on record for you, so nothing was sent through Trainee.", status: "none", intent: STATUS_INTENT };
    return { reply: statusLine(last), status: "shown", intent: STATUS_INTENT };
  }
  if (ask.company) {
    const mine = rows.filter((a) => sameCompany(a.company, ask.company));
    if (!mine.length) {
      return { reply: `I have no application to ${ask.company} on record, so I can't say it went through. Nothing was sent to ${ask.company} through Trainee.`, status: "none", intent: STATUS_INTENT };
    }
    return { reply: mine.slice(0, MAX_LISTED).map(statusLine).join("\n"), status: "shown", intent: STATUS_INTENT };
  }
  const recent = rows.filter((a) => Date.parse(a.updated_at) >= now - RECENT_DAYS * 86_400_000 || ["queued", "driving", "needs_user"].includes(a.state));
  if (!recent.length) return { reply: `No applications are on record from the last ${RECENT_DAYS} days: nothing was sent for you through Trainee.`, status: "none", intent: STATUS_INTENT };
  const more = recent.length > MAX_LISTED ? `\n…and ${recent.length - MAX_LISTED} more.` : "";
  return { reply: `Your applications, newest first:\n${recent.slice(0, MAX_LISTED).map((a) => `- ${statusLine(a)}`).join("\n")}${more}`, status: "shown", intent: STATUS_INTENT };
}

// One chat turn: the read only for a status question; a read that fails is said, never guessed.
export async function applicationsTurn(o: { message: string; userId: string; now: number; read: ReadApplications }) {
  if (!statusAsk(o.message)) return null;
  let rows: AppRow[] | null;
  try {
    rows = await o.read(o.userId);
  } catch (e) {
    console.error("applications status:", e instanceof Error ? e.message : String(e));
    rows = null;
  }
  return statusReply(o.message, rows, o.now);
}
