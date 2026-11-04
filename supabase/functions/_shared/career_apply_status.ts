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
  .replace(/^[^\p{L}\p{N}"'(]+/u, "").replace(/^(?:(?:hey|hi|hello|ok|okay|pls|please)\b[,!:]?\s+)+/, "").replace(/,? (?:please|pls|thanks|thank you)$/, "")} `;
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
      return `${name}: stopped before it was sent; it needs you (${a.reason ?? "no reason recorded"}).`;
    case "failed":
    case "not_submitted":
      return `${name}: not sent (${a.reason ?? "no reason recorded"}).`;
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
