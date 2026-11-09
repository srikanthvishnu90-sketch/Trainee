// R10 F.3 (stop/pause truth, owner finding 2026-11-08): a stop turn's reply says only the effect that was written AND
// read back. career_host.js classifies the stop (ctx._stopControl); this module does the database side:
//   - workflow stop ("stop the people list", "don't contact anyone", "leave everything unsent"): unsent approved outreach
//     drafts are held (back to waiting, approval cleared, so nothing sends without a new yes) and queued outreach emails
//     on the send rail are cancelled; the account is NOT paused;
//   - account pause ("pause everything", "stop all sending"): the pause rides the turn's commit (career_host_commit,
//     career:account paused) and is read back after it, with career_user_quiet, the predicate the send paths read.
// Counts come from the real tables (career_outreach_drafts, career_send_queue, career_apply_jobs) or are said unknown.
// No later reconciliation is promised: none is scheduled.

// The account control contract (career_user_quiet and career_apply_current, both reading career:account paused), audited
// 2026-11-09 against the latest migration of each function. Only the paths that refuse while paused are named as held.
export const PAUSE_HOLDS = [
  "new applications and cloud applications (enqueue, claim and the check before submit)",
  "outreach emails (refused when they are claimed to send)",
  "follow-ups",
  "job alerts, job cards and other messages I send on my own",
  "reminders",
] as const;
// Paths that do NOT read the pause today (blockers; career_send_go 20261031020000:123, runOutreachActions in
// career_outreach_replies.ts:1267 with sendUpdates=all invites). Said plainly, never claimed as stopped.
export const PAUSE_GAPS = [
  "an email batch already claimed before the pause (it can finish its next couple of minutes of sends)",
  "calendar invites for meetings you already approved from a reply",
] as const;

type Admin = { from(t: string): any; rpc(n: string, a: unknown): PromiseLike<{ data: any; error: { message: string } | null }> };
export interface StopControl { kind: "account" | "workflow" | "resume"; workflows?: string[]; boundary?: boolean; outstanding?: string | null; cancelled?: string[] }
export interface Counts {
  drafts: { waiting: number; approved: number; sending: number; out: number } | null;
  emails: { queued: number; sending: number; out: number } | null;
  applications: { waiting: number; inProgress: number; submitted: number; uncertain: number } | null;
}
export interface Hold { held: number | null; cancelledEmails: number | null; error: string | null }

const tally = (rows: { s: string }[], m: Record<string, string[]>) => {
  const out: Record<string, number> = {};
  for (const k of Object.keys(m)) out[k] = rows.filter((r) => m[k].includes(r.s)).length;
  return out;
};

// Hold every unsent approved outreach draft and cancel every queued outreach email for this person. Conditional on the
// row still being unsent, so a draft already sending is never touched (it is counted as uncertain instead).
export async function holdUnsent(admin: Admin, userId: string, now: number): Promise<Hold> {
  const at = new Date(now).toISOString();
  let held: number | null = null, cancelledEmails: number | null = null;
  const errors: string[] = [];
  try {
    const r = await admin.from("career_outreach_drafts").update({ status: "shown", approved_hash: null, approved_at: null, result: "held: the person stopped this in chat", updated_at: at })
      .eq("user_id", userId).eq("status", "approved").select("id");
    if (r.error) throw new Error(r.error.message);
    held = (r.data ?? []).length;
  } catch (e) { errors.push(`drafts: ${(e as Error)?.message ?? e}`); }
  try {
    const r = await admin.from("career_send_queue").update({ state: "cancelled", result: "cancelled by the person", updated_at: at })
      .eq("user_id", userId).eq("kind", "outreach").eq("state", "queued").select("id");
    if (r.error) throw new Error(r.error.message);
    cancelledEmails = (r.data ?? []).length;
  } catch (e) { errors.push(`emails: ${(e as Error)?.message ?? e}`); }
  return { held, cancelledEmails, error: errors.length ? errors.join("; ") : null };
}

export async function reconcile(admin: Admin, userId: string): Promise<Counts> {
  const read = async (table: string, col: string) => {
    try {
      const r = await admin.from(table).select(col).eq("user_id", userId).limit(5000);
      if (r.error) return null;
      return (r.data ?? []).map((x: any) => ({ s: String(x[col]) }));
    } catch { return null; }
  };
  const d = await read("career_outreach_drafts", "status");
  const q = await read("career_send_queue", "state");
  const a = await read("career_apply_jobs", "state");
  return {
    drafts: d && tally(d, { waiting: ["shown"], approved: ["approved"], sending: ["sending"], out: ["sent", "replied", "bounced"] }) as Counts["drafts"],
    emails: q && tally(q, { queued: ["queued"], sending: ["sending"], out: ["sent", "replied", "bounced"] }) as Counts["emails"],
    applications: a && tally(a, { waiting: ["queued", "needs_user"], inProgress: ["driving"], submitted: ["confirmed"], uncertain: ["submitted_unconfirmed", "unknown_outcome"] }) as Counts["applications"],
  };
}

// The authoritative state after the commit: career:account paused, the quiet predicate, and whether this thread still
// holds a people list (stores.plan, kind campaign_plan). null: could not be read.
export async function readControl(admin: Admin, userId: string, threadId: string): Promise<{ paused: boolean | null; quiet: boolean | null; planOpen: boolean | null }> {
  let paused: boolean | null = null, quiet: boolean | null = null, planOpen: boolean | null = null;
  try {
    const r = await admin.from("career_watch_kv").select("value").eq("user_id", userId).eq("key", "career:account").maybeSingle();
    if (!r.error) paused = r.data?.value?.paused === true;
  } catch { /* unknown */ }
  try {
    const r = await admin.rpc("career_user_quiet", { p_user: userId });
    if (!r.error && typeof r.data === "boolean") quiet = r.data;
  } catch { /* unknown */ }
  try {
    const r = await admin.from("agent_flow_state").select("state").eq("thread_id", threadId).eq("user_id", userId).maybeSingle();
    if (!r.error) planOpen = r.data?.state?.career?.stores?.plan?.kind === "campaign_plan";
  } catch { /* unknown */ }
  return { paused, quiet, planOpen };
}

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
function countLines(c: Counts): string[] {
  const out: string[] = [];
  out.push(c.drafts
    ? `Outreach drafts on record: ${c.drafts.waiting} waiting for your yes, ${c.drafts.approved} approved, ${c.drafts.sending} sending (outcome uncertain), ${c.drafts.out} already out.`
    : "I could not read your outreach drafts, so their counts are unknown.");
  out.push(c.emails
    ? `Emails on the send rail: ${c.emails.queued} queued, ${c.emails.sending} sending (outcome uncertain), ${c.emails.out} already out.`
    : "I could not read the send rail, so its email counts are unknown.");
  out.push(c.applications
    ? `Applications on record: ${c.applications.waiting} waiting, ${c.applications.inProgress} in progress, ${c.applications.submitted} confirmed by the employer, ${c.applications.uncertain} with the outcome unknown.`
    : "I could not read your applications, so their counts are unknown.");
  return out;
}

export function workflowReply(o: { stop: StopControl; hold: Hold; counts: Counts; accountPaused?: boolean }): string {
  const s = o.stop, lines: string[] = [];
  lines.push(s.cancelled?.includes("people_list") ? "Stopped: the people list in this conversation is cancelled, and no one on it was contacted." : "No people list was being built in this conversation, so there was none to cancel.");
  if (o.hold.held === null) lines.push("I could not hold your approved outreach drafts (the write failed), so any approved draft is NOT stopped.");
  else if (o.hold.held > 0) lines.push(`Held ${n(o.hold.held, "approved outreach draft", "approved outreach drafts")}: ${o.hold.held === 1 ? "it goes" : "they go"} back to waiting and won't send without a new yes.`);
  if (o.hold.cancelledEmails === null) lines.push("I could not cancel queued outreach emails (the write failed), so any queued email is NOT stopped.");
  else if (o.hold.cancelledEmails > 0) lines.push(`Cancelled ${n(o.hold.cancelledEmails, "queued outreach email", "queued outreach emails")}.`);
  lines.push(...countLines(o.counts));
  const a = o.counts.applications;
  const live = a ? a.waiting + a.inProgress : null;
  if (o.accountPaused) lines.push("Your account is still paused, as it was before this message; this stop did not change that.");
  else lines.push(`Your account is not paused${live ? `, so ${n(live, "application you already approved or started still goes", "applications you already approved or started still go")}` : ""}. Say "pause everything" to stop all sending.`);
  if (s.outstanding) lines.push(`Your ask for ${s.outstanding} is still open: I have not answered it in this message.`);
  return lines.join("\n");
}

export function pauseReply(o: { counts: Counts }): string {
  return [
    "Paused your account: the pause is saved and I read it back.",
    `While it is on, nothing new starts, and these refuse to send: ${PAUSE_HOLDS.join("; ")}.`,
    `Not covered by the pause today: ${PAUSE_GAPS.join("; ")}.`,
    ...countLines(o.counts),
    "It stays on until you text \"resume career work\".",
  ].join("\n");
}

export const resumeReply = "The account pause is lifted: I read it back. Earlier cancelled or uncertain work was not restarted. Ask for the next action explicitly.";

// After the commit, when the read-back does not show the effect the reply stated.
export function notConfirmedReply(kind: StopControl["kind"], why: string): string {
  if (kind === "account") return `I could not confirm the pause: ${why}. Treat your account as NOT paused, so nothing is stopped by it yet. Say "pause everything" again.`;
  if (kind === "resume") return `I could not confirm the pause was lifted: ${why}. Treat it as still on.`;
  return `I could not confirm the stop: ${why}. Treat the people list as not cancelled. Nothing was sent by me in this message.`;
}
// The turn's commit failed: nothing this turn wrote is saved.
// The drafts hold is its own write, before the commit: what it did is said either way.
export function unsavedStopReply(kind: StopControl["kind"], hold: Hold | null = null): string {
  if (kind === "account") return "The stop is not confirmed: I could not save the pause, so your account is NOT paused and nothing is stopped by it. Say \"pause everything\" again in a moment.";
  if (kind === "resume") return "I could not save that, so the pause is still on. Nothing was restarted.";
  const held = hold && hold.held ? ` I did hold ${n(hold.held, "approved outreach draft", "approved outreach drafts")} back to waiting, so ${hold.held === 1 ? "it won't" : "they won't"} send without a new yes.` : "";
  return `The stop is not confirmed: I could not save it, so the people list is not cancelled.${held} Your account is not paused. Say "pause everything" to stop all sending.`;
}
