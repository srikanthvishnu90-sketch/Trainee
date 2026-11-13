// R10 F.3 (stop/pause truth, owner finding 2026-11-08): a stop turn's reply says only the effect that was written AND
// read back. career_host.js classifies the stop (stopControlOf); this module does the database side:
//   - workflow stop ("stop the people list", "don't contact anyone", "leave everything unsent"): everything approved and
//     not yet sent is held: outreach drafts and replies-lane actions go back to waiting (approval cleared, so nothing goes
//     without a new yes), queued outreach emails are cancelled, and queued applications are cancelled through the
//     race-safe career_apply_cancel_for; then it is all read back; the account is NOT paused;
//   - account pause ("pause everything", "stop all sending"): the pause rides the turn's commit (career_host_commit,
//     career:account paused) and is read back after it, with career_user_quiet, the predicate the send paths read.
// Counts come from the real tables (career_outreach_drafts, career_send_queue, career_outreach_actions,
// career_apply_jobs) or are said unknown.
// No later reconciliation is promised: none is scheduled.

// The account control contract (career_user_quiet and career_apply_current, both reading career:account paused), audited
// 2026-11-09 against the latest migration of each function. Only the paths that refuse while paused are named as held.
export const PAUSE_HOLDS = [
  "new applications, cloud ones included",
  "outreach emails, even in a batch already started",
  "follow-ups",
  "calendar invites from a reply you approved",
  "job alerts and other messages I send on my own",
  "reminders",
] as const;
// What the pause cannot reach: an email already handed to the mail provider when the pause lands is out of Trainee's
// hands (it is recorded as sent). career_send_go and the replies-lane action claim read the pause since
// 20261109120000_career_pause_send_paths.sql (#657). Networking introductions do not read it, but that connector is not wired.
export const PAUSE_GAPS = [
  "an email already handed to Gmail at the moment you paused",
] as const;

type Admin = { from(t: string): any; rpc(n: string, a: unknown): PromiseLike<{ data: any; error: { message: string } | null }> };
export interface StopControl { kind: "account" | "workflow" | "resume"; workflows?: string[]; boundary?: boolean; outstanding?: string | null; cancelled?: string[] }
export interface Counts {
  drafts: { waiting: number; approved: number; sending: number; out: number } | null;
  emails: { queued: number; sending: number; out: number } | null;
  applications: { waiting: number; inProgress: number; submitted: number; uncertain: number } | null;
  actions: { waiting: number; approved: number; running: number; done: number } | null;
}
// null: that write failed (or could not be read back), so that part is NOT stopped.
export interface Hold { held: number | null; cancelledEmails: number | null; actions: number | null; applications: number | null; wanted: number | null; error: string | null }

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
  // Replies-lane actions (follow-ups, scheduling replies, calendar invites) approved and not yet taken by a worker.
  let actions: number | null = null;
  try {
    const r = await admin.from("career_outreach_actions").update({ status: "shown", approved_hash: null, approved_at: null, result: "held: the person stopped this in chat", updated_at: at })
      .eq("user_id", userId).eq("status", "approved").select("id");
    if (r.error) throw new Error(r.error.message);
    actions = (r.data ?? []).length;
  } catch (e) { errors.push(`actions: ${(e as Error)?.message ?? e}`); }
  // Applications approved and not yet claimed: cancelled by the existing race-safe cancel, one employer at a time (queued,
  // no attempt yet, under the person's lock; a worker's claim takes only 'queued'). A cloud-bound or started one is not
  // touched here and is counted as waiting or in progress, so the reply says it still goes.
  // Applications asked for and still waiting to be prepared (career_apply_wanted 'waiting': preparing visits the employer's
  // site, new work the person said not to start) go the same way: the cancel removes them too.
  let applications: number | null = null, wanted: number | null = null;
  try {
    const j = await admin.from("career_apply_jobs").select("company").eq("user_id", userId).eq("state", "queued").eq("attempts", 0).is("source", null).limit(500);
    if (j.error) throw new Error(j.error.message);
    const wq = await admin.from("career_apply_wanted").select("company").eq("user_id", userId).eq("state", "waiting").limit(500);
    if (wq.error) throw new Error(wq.error.message);
    let a = 0, w = 0;
    for (const co of [...new Set([...(j.data ?? []), ...(wq.data ?? [])].map((x: any) => String(x.company ?? "")).filter(Boolean))]) {
      const c = await admin.rpc("career_apply_cancel_for", { p_user: userId, p_company: co });
      if (c.error) throw new Error(c.error.message);
      a += Number((c.data as any)?.approved_cancelled ?? 0);
      w += Number((c.data as any)?.queued_removed ?? 0);
    }
    applications = a; wanted = w;
  } catch (e) { errors.push(`applications: ${(e as Error)?.message ?? e}`); }
  return { held, cancelledEmails, actions, applications, wanted, error: errors.length ? errors.join("; ") : null };
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
  const x = await read("career_outreach_actions", "status");
  return {
    drafts: d && tally(d, { waiting: ["shown"], approved: ["approved"], sending: ["sending"], out: ["sent", "replied", "bounced"] }) as Counts["drafts"],
    emails: q && tally(q, { queued: ["queued"], sending: ["sending"], out: ["sent", "replied", "bounced"] }) as Counts["emails"],
    applications: a && tally(a, { waiting: ["queued", "needs_user"], inProgress: ["driving"], submitted: ["confirmed"], uncertain: ["submitted_unconfirmed", "unknown_outcome"] }) as Counts["applications"],
    actions: x && tally(x, { waiting: ["shown"], approved: ["approved"], running: ["running"], done: ["done"] }) as Counts["actions"],
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
  out.push(c.actions
    ? `Follow-ups and call invites on record: ${c.actions.waiting} waiting for your yes, ${c.actions.approved} approved, ${c.actions.running} being carried out now (outcome uncertain), ${c.actions.done} done.`
    : "I could not read your follow-ups and call invites, so their counts are unknown.");
  return out;
}

// researchBlocker: why the open ask cannot be answered in this turn, in plain words (the caller decides it from the release
// switches); null when no blocker is known.
export function workflowReply(o: { stop: StopControl; hold: Hold; counts: Counts; accountPaused?: boolean; researchBlocker?: string | null }): string {
  const s = o.stop, lines: string[] = [];
  lines.push(s.cancelled?.includes("people_list") ? "Stopped: the people list in this conversation is cancelled, and no one on it was contacted." : "No people list was being built in this conversation, so there was none to cancel.");
  if (o.hold.held === null) lines.push("I could not hold your approved outreach drafts (the write failed), so any approved draft is NOT stopped.");
  else if (o.hold.held > 0) lines.push(`Held ${n(o.hold.held, "approved outreach draft", "approved outreach drafts")}: ${o.hold.held === 1 ? "it goes" : "they go"} back to waiting and won't send without a new yes.`);
  if (o.hold.cancelledEmails === null) lines.push("I could not cancel queued outreach emails (the write failed), so any queued email is NOT stopped.");
  else if (o.hold.cancelledEmails > 0) lines.push(`Cancelled ${n(o.hold.cancelledEmails, "queued outreach email", "queued outreach emails")}.`);
  if (o.hold.actions === null) lines.push("I could not hold your approved follow-ups and call invites (the write failed), so any approved one is NOT stopped.");
  else if (o.hold.actions > 0) lines.push(`Held ${n(o.hold.actions, "approved follow-up or call invite", "approved follow-ups and call invites")}: back to waiting for a new yes.`);
  if (o.hold.applications === null) lines.push("I could not stop your approved applications (the write failed), so any approved application is NOT stopped.");
  else if (o.hold.wanted) lines.push(`Stopped ${n(o.hold.wanted, "application waiting to be prepared", "applications waiting to be prepared")}: nothing was prepared or sent, and ${o.hold.wanted === 1 ? "it starts" : "they start"} only if you ask again.`);
  if (o.hold.applications && o.hold.applications > 0) lines.push(`Stopped ${n(o.hold.applications, "approved application", "approved applications")} before ${o.hold.applications === 1 ? "it was" : "they were"} sent: ${o.hold.applications === 1 ? "it goes" : "they go"} only if you approve again.`);
  lines.push(...countLines(o.counts));
  const a = o.counts.applications;
  const live = a ? a.waiting + a.inProgress : null; // what is still standing after the holds, read back
  if (o.counts.drafts && o.counts.drafts.approved > 0 && o.hold.held !== null) lines.push(`${n(o.counts.drafts.approved, "approved outreach draft is", "approved outreach drafts are")} still on record as approved after the hold, so ${o.counts.drafts.approved === 1 ? "it is" : "they are"} NOT confirmed stopped.`);
  if (o.counts.actions && o.counts.actions.approved > 0 && o.hold.actions !== null) lines.push(`${n(o.counts.actions.approved, "approved follow-up or call invite is", "approved follow-ups and call invites are")} still on record as approved after the hold, so NOT confirmed stopped.`);
  if (o.accountPaused) lines.push("Your account is still paused, as it was before this message; this stop did not change that.");
  else lines.push(`Your account is not paused${live ? `, so ${n(live, "application you already approved or started still goes", "applications you already approved or started still go")}` : ""}. Say "pause everything" to stop all sending.`);
  if (s.outstanding) lines.push(o.researchBlocker
    ? `Your ask for ${s.outstanding} is still open, and I can't answer it here: ${o.researchBlocker}`
    : `Your ask for ${s.outstanding} is still open: I have not answered it in this message.`);
  return lines.join("\n");
}

// Review 2026-11-13 round 3: the one line for a hold that rode along with another ask ("find jobs at Plaid, don't contact
// anyone"): the ask was answered, and what was waiting to go out was held, said from the hold's own writes.
// Null when the hold found nothing waiting: the turn's own boundary line (D-061 G6) already says nothing was sent.
export function alongsideHoldLine(h: Hold): string | null {
  if ([h.held, h.cancelledEmails, h.actions, h.applications].some((x) => x === null)) return "I could not hold everything that was waiting to go out (a write failed), so something you approved earlier may NOT be stopped. Nothing was sent by me in this message.";
  const parts: string[] = [];
  if (h.held) parts.push(n(h.held, "approved outreach draft", "approved outreach drafts"));
  if (h.cancelledEmails) parts.push(n(h.cancelledEmails, "queued email", "queued emails"));
  if (h.actions) parts.push(n(h.actions, "approved follow-up or call invite", "approved follow-ups and call invites"));
  if (h.applications) parts.push(n(h.applications, "approved application", "approved applications"));
  if (h.wanted) parts.push(n(h.wanted, "application waiting to be prepared", "applications waiting to be prepared"));
  return parts.length ? `Held, as you asked: ${parts.join(", ")}. Nothing goes out without a new yes, and nothing was sent by me in this message.`
    : null;
}

// The same counts as countLines, said once for a pause (RESPONSE-RULES R2: a two-word ask gets about 600 characters): what
// already went out, what is still waiting, what is unverified, and each record that could not be read. Zeros are not listed.
export function pauseCountLine(c: Counts): string {
  const out: string[] = [], waiting: string[] = [], unsure: string[] = [], unread: string[] = [];
  const add = (to: string[], k: number, one: string, many: string) => { if (k > 0) to.push(n(k, one, many)); };
  if (c.drafts) { add(out, c.drafts.out, "outreach email", "outreach emails"); add(waiting, c.drafts.waiting, "draft waiting for your yes", "drafts waiting for your yes"); add(waiting, c.drafts.approved, "approved draft", "approved drafts"); add(unsure, c.drafts.sending, "draft sending", "drafts sending"); }
  else unread.push("outreach drafts");
  if (c.emails) { add(out, c.emails.out, "email from the send rail", "emails from the send rail"); add(waiting, c.emails.queued, "queued email", "queued emails"); add(unsure, c.emails.sending, "email sending", "emails sending"); }
  else unread.push("the send rail");
  if (c.applications) { add(out, c.applications.submitted, "application confirmed by the employer", "applications confirmed by the employer"); add(waiting, c.applications.waiting, "application waiting", "applications waiting"); add(waiting, c.applications.inProgress, "application in progress", "applications in progress"); add(unsure, c.applications.uncertain, "application with the outcome unknown", "applications with the outcome unknown"); }
  else unread.push("applications");
  if (c.actions) { add(out, c.actions.done, "follow-up or call invite done", "follow-ups and call invites done"); add(waiting, c.actions.waiting, "follow-up or call invite waiting for your yes", "follow-ups and call invites waiting for your yes"); add(waiting, c.actions.approved, "approved follow-up or call invite", "approved follow-ups and call invites"); add(unsure, c.actions.running, "follow-up or call invite being carried out", "follow-ups and call invites being carried out"); }
  else unread.push("follow-ups and call invites");
  const parts: string[] = [];
  parts.push(out.length ? `Already out: ${out.join(", ")}.` : "Nothing had gone out.");
  parts.push(waiting.length ? `Still waiting: ${waiting.join(", ")}.` : "Nothing was waiting.");
  if (unsure.length) parts.push(`Outcome not yet known: ${unsure.join(", ")}.`);
  if (unread.length) parts.push(`I could not read ${unread.join(", ")}, so those counts are unknown.`);
  return parts.join(" ");
}

export function pauseReply(o: { counts: Counts }): string {
  return [
    // Coordinator ruling 2026-11-10 (r-audit battery, R1): the outcome first, in a word any pause ask shares.
    "Done: your account is paused, and I read the pause back.",
    `While it is on, nothing new starts, and these refuse to send: ${PAUSE_HOLDS.join("; ")}.`,
    `Not covered by the pause today: ${PAUSE_GAPS.join("; ")}.`,
    pauseCountLine(o.counts),
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

// After a read-back mismatch the person is sent the "not confirmed" reply; the stored copy of the turn (the receipt a
// replay returns, and the assistant message in the thread) is rewritten to it, so what is stored is what was sent.
export async function storeSentReply(admin: Admin, o: { userId: string; threadId: string; turnKey: string; response: Record<string, unknown> }): Promise<boolean> {
  try {
    const key = `career:turn:${o.threadId}:${o.turnKey}`;
    const r = await admin.from("career_watch_kv").select("value").eq("user_id", o.userId).eq("key", key).maybeSingle();
    if (r.error || !r.data?.value) return false;
    const u = await admin.from("career_watch_kv").update({ value: { ...r.data.value, response: o.response }, updated_at: new Date().toISOString() }).eq("user_id", o.userId).eq("key", key);
    if (u.error) return false;
    const m = await admin.from("agent_messages").select("id,meta").eq("thread_id", o.threadId).eq("role", "assistant").order("id", { ascending: false }).limit(10);
    const row = (m.data ?? []).find((x: any) => x?.meta?.career_turn_key === o.turnKey);
    if (m.error || !row) return false;
    const w = await admin.from("agent_messages").update({ content: String(o.response.reply ?? "") }).eq("id", row.id);
    return !w.error;
  } catch { return false; }
}
