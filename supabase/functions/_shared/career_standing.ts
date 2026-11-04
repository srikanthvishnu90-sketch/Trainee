// WO-107 (F3, DIAGNOSIS-2026-10-25 §2.4, §2.5, §2.11): one read model on the live path. Four records of the person's
// applications never saw each other: career_apply_jobs (what Trainee sent and how it ended), career_mail_events (what the
// employer's mail said, read by the mail run), every thread's tracker (what the person told Trainee) and
// career_mail_drafts (follow-ups the mail run drafted, never sent). The router answered "where do I stand" from one
// thread's tracker alone, and nothing from the inbox reached chat. This builds the one model and answers three asks by
// code, before the router or any brain:
//   status      "where are my applications", "did my application to X go through", "where do I stand with X": the queue's
//               own wording (career_apply_status.ts, byte for byte) first, then the other records' lines, each named;
//   inbox       "who emailed me", "any news from X", "did X get back to me": the mail events only, newest first, with how
//               far the mail was read; nothing is read from the inbox here (the mail run reads; this reads its record);
//   follow-ups  "what follow-ups are due": the drafted rows, then what the mail run's own quiet-days rule (followUps) says
//               is due over the merged applications and not drafted yet; the text is shown so it is ready to send; nothing
//               is sent or saved by this turn.
// A record that cannot be read is named and never guessed; a missing mail record never lets a follow-up be called due.
import { type AppRow, type ReadApplications, statusAsk, statusReply, supabaseApplications } from "./career_apply_status.ts";
import { appsFromQueue, appsFromTracker } from "./career_mail_store.ts";
import { receiptCompanies } from "./career_apply_receipt_read.ts";
import { type Draft, FOLLOW_UP_DAYS, foldEvents, followUps, mergeApps, sameCompany, type StatusEvent, THANK_YOU_DAYS, type TrackedApp } from "./career_mail.ts";

export const STANDING_INTENT = "career_apply_status"; // the status ask keeps its intent: the queue-only turn's, now with the other records
export const INBOX_INTENT = "career_inbox";
export const FOLLOWUPS_INTENT = "career_followups_due";

export interface DraftRow { draft_key: string; application_ref: string; kind: "followup" | "thank_you"; company: string; role?: string | null; text: string; basis: string; state: string; created_at: string; sent_at?: string | null }
// What the reader read, one field per record; a record that failed is null and named in unreadable.
// receipts (FEATURE 14): the companies with a receipt on record (career_apply_receipts), for the link to it; absent or null: no link.
export interface StandingRows { jobs: AppRow[] | null; mail: StatusEvent[] | null; tracker: any[] | null; drafts: DraftRow[] | null; read_through?: string | null; receipts?: string[] | null; unreadable: string[] }
export type ReadStanding = (userId: string) => Promise<StandingRows>;
// apps: the merged applications (the mail run's mergeApps, then the mail events folded in); tracker: every tracker row as
// the person told it, unmerged, for the per-employer view.
// FEATURE 8: sent, the follow-ups the person approved in chat and Trainee sent from their Gmail (state "sent"); never due again.
export interface Standing { jobs: AppRow[] | null; apps: TrackedApp[]; tracker: TrackedApp[]; mail: StatusEvent[]; drafts: DraftRow[]; sent?: DraftRow[]; due: Draft[]; read_through: string | null; receipts: string[]; unreadable: string[] }

export function standingFrom(r: StandingRows, now: number): Standing {
  const queue = appsFromQueue(r.jobs ?? []), tracker = appsFromTracker(r.tracker ?? []);
  const merged = mergeApps(queue, tracker);
  // A tracker row the merge read as the queue's own application still carries what the person reported about it (an
  // interview, a rejection): those events count on the merged application, so a reply they told Trainee about is a reply.
  for (const t of tracker) {
    if (merged.includes(t)) continue;
    const q = merged.find((a) => a.source === "queue" && sameCompany(a.company, t.company));
    if (q && t.events?.length) q.events = [...(q.events ?? []), ...t.events.filter((e) => !(q.events ?? []).some((x) => x.kind === e.kind && x.at === e.at))];
  }
  const apps = foldEvents(merged, r.mail ?? []);
  const drafts = (r.drafts ?? []).filter((d) => d && d.state === "drafted");
  const sent = (r.drafts ?? []).filter((d) => d && d.state === "sent");
  // "No reply in N days" cannot be said when the mail record was not read. A follow-up drafted or sent is never due again.
  const due = r.mail === null ? [] : followUps(apps, now).filter((d) => !drafts.some((x) => x.draft_key === d.key) && !sent.some((x) => x.draft_key === d.key));
  return { jobs: r.jobs, apps, tracker, mail: r.mail ?? [], drafts, sent, due, read_through: r.read_through ?? null, receipts: r.receipts ?? [], unreadable: r.unreadable };
}

// The production reader: the four records in one parallel batch; each failure is logged, named and never guessed.
// deno-lint-ignore no-explicit-any
export function supabaseStanding(admin: any, read: ReadApplications = supabaseApplications(admin)): ReadStanding {
  return async (userId) => {
    const unreadable: string[] = [];
    const fail = (name: string) => (e: unknown) => { console.error(`standing: ${name}:`, e instanceof Error ? e.message : String(e)); unreadable.push(name); return null; };
    const q = async <T>(name: string, p: PromiseLike<{ data: any; error: any }>, map: (rows: any[]) => T): Promise<T | null> => {
      try { const r = await p; if (r.error) throw new Error(r.error.message ?? String(r.error)); return map(r.data ?? []); } catch (e) { return fail(name)(e); }
    };
    const [jobs, mail, tracker, drafts, cursor, receipts] = await Promise.all([
      read(userId).catch(fail("applications")),
      q("mail", admin.from("career_mail_events").select("application_ref,kind,company,role,stage,flagged,evidence,message_hash,mail_at").eq("user_id", userId).order("mail_at", { ascending: false }).limit(500),
        (rows) => rows.map((r): StatusEvent => ({ hash: r.message_hash, ref: r.application_ref, kind: r.kind, company: r.company, role: r.role ?? undefined, stage: r.stage, flagged: !!r.flagged, evidence: r.evidence, at: r.mail_at, new_app: false }))),
      q("tracker", admin.from("agent_flow_state").select("rows:state->career->stores->trackStore->rows").eq("user_id", userId).limit(200), (rows) => rows.flatMap((t) => (Array.isArray(t.rows) ? t.rows : []))),
      q("drafts", admin.from("career_mail_drafts").select("draft_key,application_ref,kind,company,role,text,basis,state,created_at,sent_at").eq("user_id", userId).in("state", ["drafted", "sent"]).order("created_at", { ascending: false }).limit(50), (rows) => rows as DraftRow[]),
      q("mail cursor", admin.from("career_mail_cursors").select("read_through").eq("user_id", userId).limit(1), (rows) => (rows[0]?.read_through ?? null) as string | null),
      // FEATURE 14: only for the link to the receipt; unread, the link is left out (the status itself never depends on it).
      receiptCompanies(admin, userId).catch((e) => { console.error("standing: receipts:", e instanceof Error ? e.message : String(e)); return null; }),
    ]);
    return { jobs, mail, tracker, drafts, read_through: cursor, receipts, unreadable };
  };
}

// ------------------------------------------------------------------------------------------------ the asks
// ROUTING SCENARIOS (2026-10-29): a greeting before the ask ("hey", "ok so", "please") or "please" after it is not part of it.
const plain = (s: string) => ` ${String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[?!.]+\s*$/, "").replace(/\s+/g, " ").trim()
  .replace(/^[^\p{L}\p{N}"'(]+/u, "").replace(/^(?:(?:hey|hi|hello|ok|okay|pls|please)\b[,!:]?\s+)+/, "").replace(/,? (?:please|pls|thanks|thank you)$/, "")} `;
const STAND_ALL = /^ (?:so )?(?:where do i stand|how do i stand|what'?s my standing) $/;
const STAND_ONE = /^ (?:so )?(?:where do i stand|how do i stand|what'?s my standing|how am i doing) (?:with|at|on) (.+?) $/;
const INBOX_ALL = /^ (?:so )?(?:who (?:has |'?s )?emailed me|who has written to me|who wrote to me|who (?:has )?(?:replied|responded|got back to me)|any news(?: from (?:employers|anyone|companies))?|any (?:replies|responses|emails?|mail)(?: from (?:employers|anyone|companies))?|(?:have i|did i) (?:hear|heard) (?:back|anything)(?: from anyone)?|(?:did|has) anyone (?:get back to me|gotten back to me|reply|replied|respond|responded|email me|emailed me|write back|written back)|what'?s in my inbox|anything in my inbox|any (?:rejections|interviews|offers)(?: yet)?) $/;
const INBOX_ONE = [
  /^ (?:so )?(?:any|anything|is there any|is there anything) (?:news|updates?|word|replies?|response|email|emails|mail) (?:from|on|about|at|with) (.+?) $/,
  /^ (?:so )?(?:did|has|have) (.+?) (?:get back to me|gotten back to me|got back to me|replied|reply|responded|respond|emailed me|written back|written to me|written|answered|said anything|reached out|contacted me) $/,
  /^ (?:so )?(?:have i|did i) (?:hear|heard) (?:back|anything) from (.+?) $/,
  /^ (?:so )?what did (.+?) (?:say|send me|email me|write) $/,
];
const FOLLOWUPS = /^ (?:so )?(?:(?:what|which|any|are there any|do i have any|are any|do i owe any|do i owe) follow[- ]?ups?(?: (?:are|is))?(?: (?:due|owed|pending|outstanding|waiting|ready|needed|coming up))?(?: (?:today|now|this week))?|(?:who|which (?:applications|employers|companies)) (?:should|do) i (?:need to )?follow up (?:with|on)(?: now| today| this week)?|(?:what|who) (?:do i need to|should i) follow up (?:on|with)|which (?:applications|employers|companies) need a follow[- ]?up|(?:any|my) follow[- ]?ups?|follow[- ]?ups?(?: due)?) $/;
export type StandingAsk = { kind: "status"; company: string | null } | { kind: "inbox"; company: string | null } | { kind: "followups" };
const asTyped = (message: string, lower: string) => { const i = String(message).toLowerCase().indexOf(lower); return i >= 0 ? String(message).slice(i, i + lower.length) : lower; };
const named = (message: string, m: string) => { const lower = m.replace(/^(?:the|a) /, "").trim(); return lower && lower.length <= 80 ? asTyped(message, lower) : null; };
export function standingAsk(message: string): StandingAsk | null {
  const t = plain(message);
  const status = statusAsk(message);
  if (status) return { kind: "status", company: status.company };
  if (STAND_ALL.test(t)) return { kind: "status", company: null };
  const one = STAND_ONE.exec(t);
  if (one) { const c = named(message, one[1]); return c ? { kind: "status", company: c } : null; }
  if (FOLLOWUPS.test(t)) return { kind: "followups" };
  if (INBOX_ALL.test(t)) return { kind: "inbox", company: null };
  for (const re of INBOX_ONE) {
    const m = re.exec(t);
    if (!m) continue;
    if (/^(?:anyone|anybody|they|them|it|you|i|we|my|the|that|this)$/.test(m[1])) return re === INBOX_ONE[1] ? null : { kind: "inbox", company: null };
    const c = named(message, m[1]);
    return c ? { kind: "inbox", company: c } : null;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ the replies
const day = (iso: string | null | undefined) => iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
const KIND_WORDS: Record<string, string> = { received: "confirmation they received it", rejection: "rejection", interview: "interview invitation", assessment: "assessment invitation", offer: "offer", recruiter_reply: "recruiter reply" };
const withRole = (company: string, role?: string | null) => `${company}${role ? ` (${role})` : ""}`;
const mailLine = (e: StatusEvent) => `${withRole(e.company, e.role)}: ${KIND_WORDS[e.kind] ?? e.kind} on ${day(e.at) ?? "a date not on record"}${e.stage ? ` (stage: ${e.stage})` : ""}${e.flagged ? "; noted, not applied to the stage" : ""}`;
const readNote = (s: Standing) => s.read_through ? ` (read through ${day(s.read_through)})` : " (Trainee has not read your mail yet: it reads it only with your Google connection, once the mail check has run)";
const of = (s: Standing, company: string) => ({
  tracker: s.tracker.filter((a) => sameCompany(a.company, company)),
  mail: s.mail.filter((e) => sameCompany(e.company, company) || s.apps.some((a) => a.ref === e.ref && sameCompany(a.company, company))).sort((x, y) => y.at.localeCompare(x.at)),
});
const trackerLine = (a: TrackedApp) => `applied on ${day(a.applied_at) ?? "a date not on record"}; stage ${a.stage}`;
const missing = (s: Standing, which: ("mail" | "tracker")[]) => which.filter((w) => s.unreadable.includes(w)).map((w) => w === "mail" ? "Your mail events could not be read just now." : "Your tracker could not be read just now.");

// The queue's own wording for the ask, byte for byte (career_apply_status.ts): for a company asked in a phrasing that turn
// does not parse ("where do I stand with Acme"), the same one-employer wording through the ask it does.
const queueText = (message: string, s: Standing, company: string | null, now: number) =>
  (statusReply(message, s.jobs, now) ?? statusReply(company ? `did my application to ${company} go through` : "where are my applications", s.jobs, now))!.reply;
function statusText(message: string, s: Standing, company: string | null, now: number): string {
  const lines = [queueText(message, s, company, now)];
  if (company) {
    const { tracker, mail } = of(s, company);
    for (const a of tracker) lines.push(`You told Trainee: ${trackerLine(a)}${a.role ? ` (${a.role})` : ""}.`);
    if (mail.length) for (const e of mail) lines.push(`${company}'s email: ${KIND_WORDS[e.kind] ?? e.kind} on ${day(e.at) ?? "a date not on record"}${e.stage ? ` (stage: ${e.stage})` : ""}${e.flagged ? "; noted, not applied to the stage" : ""}.`);
    else if (s.mail !== null || !s.unreadable.includes("mail")) lines.push(`No email from ${company} in the mail Trainee has read${readNote(s)}.`);
    // FEATURE 14: the receipt behind the status line, one ask away.
    const rc = s.receipts.find((c) => sameCompany(c, company));
    if (rc) lines.push(`Receipt on record: ask "show me the receipt for ${rc}" to see exactly what was sent, with the pictures.`);
  } else {
    const trackerOnly = s.tracker.filter((a) => !(s.jobs ?? []).some((j) => sameCompany(j.company, a.company)));
    if (trackerOnly.length) lines.push(`Also on your tracker (what you told Trainee): ${trackerOnly.slice(0, 8).map((a) => `${withRole(a.company, a.role)}: you told Trainee you applied on ${day(a.applied_at) ?? "a date not on record"}; stage ${a.stage}`).join("; ")}.`);
    const recent = [...s.mail].filter((e) => Date.parse(e.at) >= now - 30 * 86_400_000).sort((x, y) => y.at.localeCompare(x.at));
    if (recent.length) lines.push(`Employer email on record (last 30 days): ${recent.slice(0, 8).map(mailLine).join("; ")}.`);
    // FEATURE 14: which applications have a receipt, one ask away.
    if (s.receipts.length) lines.push(`Receipts on record for: ${s.receipts.slice(0, 8).join(", ")}. Ask "show me the receipt for ${s.receipts[0]}" to see exactly what was sent.`);
  }
  lines.push(...missing(s, ["tracker", "mail"]));
  return lines.join("\n");
}

function inboxText(s: Standing, company: string | null): string {
  if (s.mail === null || s.unreadable.includes("mail")) return "I couldn't read your mail events just now, so I can't say who emailed you. Ask me again in a minute.";
  if (company) {
    const { mail } = of(s, company);
    if (!mail.length) return `No email from ${company} in the mail Trainee has read${readNote(s)}.`;
    return mail.slice(0, 8).map((e) => `- ${mailLine(e)}`).join("\n");
  }
  const all = [...s.mail].sort((x, y) => y.at.localeCompare(x.at));
  if (!all.length) return `No employer email about your applications is on record${readNote(s)}.`;
  return [`Employer email about your applications, newest first${readNote(s)}:`, ...all.slice(0, 10).map((e) => `- ${mailLine(e)}`), ...(all.length > 10 ? [`…and ${all.length - 10} more.`] : [])].join("\n");
}

function followupsText(s: Standing): string {
  if (s.mail === null || s.unreadable.includes("mail")) return "I couldn't read your mail events just now, so I can't tell which applications are still unanswered; no follow-up is drafted or sent. Ask me again in a minute.";
  const drafted = s.drafts.map((d) => `- ${withRole(d.company, d.role)}: ${d.kind === "followup" ? "follow-up" : "thank-you"} drafted ${day(d.created_at) ?? ""} (${d.basis}); not sent.`);
  const due = s.due.map((d) => `- ${withRole(d.company, d.role)}: ${d.kind === "followup" ? "follow-up" : "thank-you"} due (${d.basis}); not drafted yet.`);
  const notes = missing(s, ["tracker"]);
  // FEATURE 8: what Trainee sent from the person's Gmail on their yes, from the record only.
  const sent = (s.sent ?? []).map((d) => `- ${withRole(d.company, d.role)}: ${d.kind === "followup" ? "follow-up" : "thank-you"} sent ${day(d.sent_at) ?? ""} from your Gmail, on your yes.`);
  if (!drafted.length && !due.length) {
    return [`No follow-up is due right now${readNote(s)}: an application gets one after ${FOLLOW_UP_DAYS} quiet days, an interview step after ${THANK_YOU_DAYS}.`, ...sent, ...notes].join("\n");
  }
  const texts = [...s.drafts.map((d) => ({ who: withRole(d.company, d.role), text: d.text })), ...s.due.map((d) => ({ who: withRole(d.company, d.role), text: d.text }))].slice(0, 3)
    .map((x) => `For ${x.who}:\n${x.text}`);
  const first = [...s.drafts, ...s.due][0];
  return [`Follow-ups:`, ...drafted, ...due, ...sent, ...texts, "Nothing is sent by Trainee without your yes: send one from your own mail if you want to, as it is or changed.",
    ...(first ? [`Or say "send the ${first.kind === "followup" ? "follow-up" : "thank-you"} to ${first.company}": you see the exact email from your Gmail first, and only your yes sends it.`] : []), ...notes].join("\n");
}

// One chat turn: null when the text is not one of these asks (nothing is read); the one model otherwise.
export async function standingTurn(o: { message: string; userId: string; now: number; read: ReadStanding }): Promise<{ reply: string; status: string; intent: string } | null> {
  const ask = standingAsk(o.message);
  if (!ask) return null;
  let s: Standing;
  try { s = standingFrom(await o.read(o.userId), o.now); }
  catch (e) {
    console.error("standing:", e instanceof Error ? e.message : String(e));
    s = standingFrom({ jobs: null, mail: null, tracker: null, drafts: null, unreadable: ["applications", "mail", "tracker", "drafts"] }, o.now);
  }
  if (ask.kind === "status") {
    const base = statusReply(o.message, s.jobs, o.now) ?? statusReply(ask.company ? `did my application to ${ask.company} go through` : "where are my applications", s.jobs, o.now);
    return { reply: statusText(o.message, s, ask.company, o.now), status: base?.status ?? "shown", intent: STANDING_INTENT };
  }
  if (ask.kind === "inbox") return { reply: inboxText(s, ask.company), status: s.mail === null ? "unreadable" : "shown", intent: INBOX_INTENT };
  return { reply: followupsText(s), status: s.mail === null ? "unreadable" : s.drafts.length || s.due.length ? "shown" : "none", intent: FOLLOWUPS_INTENT };
}
