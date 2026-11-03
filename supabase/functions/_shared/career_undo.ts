// C21/C22 (behavior map; spec 16 "reversal symmetry"): "undo" / "cancel that" right after the person approved something.
// It resolves against the LATEST thing they approved (an application, or the email(s) one approval covered), never
// anything older, and is answered by code from what the database says, in one line:
//   - still waiting to go (an application queued and not yet claimed by a worker; an approved email the send rail has not
//     claimed): it is cancelled, and the line says so;
//   - being sent right now: said plainly, nothing claimed;
//   - already out: said plainly, with what can still be done (withdraw with the employer; a follow-up email);
//   - already cancelled, or never sent: said so; nothing older is touched by a second "undo".
// The cancels are the existing, race-safe ones: career_apply_cancel_for (queued, attempts 0, under the person's lock; the
// claims take only 'queued') and the outreach draft's approved -> skipped compare-and-set, which the send rail's claim
// reads under FOR UPDATE and turns into a cancelled queue row ("approval withdrawn"). A store that cannot be read says so;
// nothing is guessed.
export const UNDO_INTENT = "career_undo";
export const UNDO_LOOKBACK_MS = 24 * 3600_000; // "undo" is about what was just approved, not last week's
// "undo" means the conversation's latest act. When this thread's last reply came well after the approval (the person went on
// to tailor a resume or set a reminder, then said "undo that"), the undo is about that, not the approval: not this turn's.
export const UNDO_THREAD_SLACK_MS = 2 * 60_000;

// The ask, whole: "undo", "undo that", "cancel that", "wait, cancel it", "oops undo", "take that back", "don't send that".
// A named cancel ("cancel my application to Acme") is the cancel turn's; "cancel my plan" is billing's.
const UNDO = /^(?:(?:wait|no|oops|oh no|nvm|never ?mind|actually|hold on|stop|ugh|sorry|hmm)[,.! ]+)*(?:please |pls )?(?:undo(?: (?:that|it|this|the last one|that one))?|cancel (?:that|it|this|that one|the last one)|take (?:that|it) back|don'?t send (?:that|it|this)|unsend(?: (?:that|it))?|reverse (?:that|it)|scratch that)(?:,? (?:please|pls|now))?$/i;
export function undoAsk(message: string): boolean {
  const t = String(message ?? "").replace(/[’`]/g, "'").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").trim();
  return t.length <= 60 && UNDO.test(t);
}

export interface UndoApply { id: string; company: string; state: string; created_at: string; reason?: string | null; source?: string | null }
export interface UndoEmail { id: string; status: string; approved_at: string; result?: string | null; name: string; firm?: string | null }
// The reason the queue's readers already show for an application the person cancelled (career_apply_cancel_for's words).
export const CANCELLED_REASON = "not sent: you cancelled it before it was sent";
export interface UndoStore {
  latestApply(userId: string, sinceIso: string): Promise<UndoApply | null>;
  // Every draft of the latest approval (one "send all" approves several at the same instant).
  latestEmails(userId: string, sinceIso: string): Promise<UndoEmail[]>;
  // Exactly this application, only while it is still queued (no worker has claimed it): queued -> not_submitted. Returns
  // whether this call cancelled it and the row as it stands afterwards (null: not this person's, or gone).
  cancelApplyJob(userId: string, id: string): Promise<{ cancelled: boolean; row: UndoApply | null }>;
  cancelEmail(userId: string, id: string): Promise<boolean>; // approved -> skipped, only if still approved
  emailStatus(userId: string, id: string): Promise<string | null>;
  lastReplyAt(threadId: string): Promise<string | null>; // when this thread's last assistant reply was written
}

const who = (e: UndoEmail) => `${e.name}${e.firm ? ` (${e.firm})` : ""}`;
const list = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const WENT = new Set(["sent", "replied", "bounced"]);

export async function undoTurn(o: { message: string; userId: string; threadId: string | null; now: number; store: UndoStore }): Promise<{ reply: string; status: string; intent: string } | null> {
  if (!undoAsk(o.message)) return null;
  const since = new Date(o.now - UNDO_LOOKBACK_MS).toISOString();
  let app: UndoApply | null, mails: UndoEmail[];
  try { [app, mails] = await Promise.all([o.store.latestApply(o.userId, since), o.store.latestEmails(o.userId, since)]); }
  catch { return { reply: "I couldn't read what you approved just now, so nothing was cancelled. Say undo again in a minute.", status: "unreadable", intent: UNDO_INTENT }; }
  const appAt = app ? Date.parse(app.created_at) : -Infinity, mailAt = mails.length ? Date.parse(mails[0].approved_at) : -Infinity;
  const latest = Math.max(appAt, mailAt);
  // The thread moved on after the approval: "undo" is about the newer act, so the turn is not this one's.
  const replyAt = o.threadId ? Date.parse(String(await o.store.lastReplyAt(o.threadId).catch(() => null) ?? "")) : NaN;
  if (Number.isFinite(replyAt) && replyAt - (Number.isFinite(latest) ? latest : -Infinity) > UNDO_THREAD_SLACK_MS) return null;
  if (!app && !mails.length) return { reply: "There's nothing to undo: you haven't approved an application or an email in the last 24 hours.", status: "none", intent: UNDO_INTENT };
  if (app && appAt >= mailAt) return await undoApply(o, app);
  return await undoEmails(o, mails);
}

async function undoApply(o: { userId: string; store: UndoStore }, app: UndoApply) {
  const r = (reply: string, status: string) => ({ reply, status, intent: UNDO_INTENT });
  let row = app;
  if (app.state === "queued") {
    let got: { cancelled: boolean; row: UndoApply | null };
    try { got = await o.store.cancelApplyJob(o.userId, app.id); }
    catch { return r(`I couldn't cancel your application to ${app.company} just now, so it is still queued and may go out. Say undo again in a minute.`, "unreadable"); }
    // Only this application, and only what this call did: the words come from this row as it stands now.
    if (got.cancelled) return r(`Cancelled: your application to ${app.company} was stopped before it went out, so this one was not sent.`, "cancelled");
    if (!got.row) return r(`I couldn't find your application to ${app.company} just now, so nothing was cancelled. Say undo again in a minute.`, "unreadable");
    row = got.row;
  }
  return describe(row, r);
}
// What this one application is now, said plainly; nothing is claimed that its row does not say.
function describe(app: UndoApply, r: (reply: string, status: string) => { reply: string; status: string; intent: string }) {
  const co = app.company;
  if (app.state === "queued") return r(`I couldn't stop your application to ${co} from here: it is still queued and may go out. Nothing else was changed.`, "not_cancellable");
  if (app.state === "driving") return r(`Too late to cancel: your application to ${co} is being sent right now and can't be stopped midway. Once it's in, you can withdraw it with ${co} directly.`, "too_late");
  if (app.state === "confirmed" || app.state === "submitted_unconfirmed") return r(`That already went out: your application to ${co} was sent, and Trainee can't pull back a sent application. To withdraw it, contact ${co} or use their candidate portal.`, "too_late");
  if (app.state === "unknown_outcome") return r(`Your application to ${co} may already have gone out (its last step wasn't recorded), so it can't be cancelled. To be sure it's withdrawn, contact ${co} directly.`, "too_late");
  if (/cancel/i.test(String(app.reason ?? ""))) return r(`Already cancelled: your application to ${co} never went out.`, "already");
  return r(`Nothing to undo: your application to ${co} was not sent.`, "not_sent");
}

async function undoEmails(o: { userId: string; store: UndoStore }, mails: UndoEmail[]) {
  const r = (reply: string, status: string) => ({ reply, status, intent: UNDO_INTENT });
  const cancelled: UndoEmail[] = [], went: UndoEmail[] = [], flying: UndoEmail[] = [], before: UndoEmail[] = [];
  for (const e of mails) {
    if (e.status === "approved") {
      let ok = false;
      try { ok = await o.store.cancelEmail(o.userId, e.id); } catch { ok = false; }
      if (ok) { cancelled.push(e); continue; }
      // The send rail took it between the read and the cancel: say where it is now, never "cancelled".
      const now = await o.store.emailStatus(o.userId, e.id).catch(() => null);
      if (now && WENT.has(now)) went.push(e); else flying.push(e);
      continue;
    }
    if (e.status === "sending") flying.push(e);
    else if (WENT.has(e.status)) went.push(e);
    else before.push(e); // skipped (already withdrawn), failed, shown again: not out
  }
  const one = mails.length === 1;
  if (one && cancelled.length) return r(`Cancelled: your email to ${who(cancelled[0])} won't be sent.`, "cancelled");
  if (one && went.length) return r(`That already went out: your email to ${who(went[0])} was sent, and email can't be unsent. You can send a short follow-up to correct it.`, "too_late");
  if (one && flying.length) return r(`Too late to cancel: your email to ${who(flying[0])} is being sent right now. If it needs correcting, you can send a short follow-up.`, "too_late");
  if (one) return r(/cancel/i.test(String(mails[0].result ?? "")) ? `Already cancelled: your email to ${who(mails[0])} was never sent.` : `Nothing to undo: your email to ${who(mails[0])} was not sent.`, "already");
  const bits: string[] = [];
  if (cancelled.length) bits.push(`Cancelled ${cancelled.length} of ${mails.length}: the email${cancelled.length === 1 ? "" : "s"} to ${list(cancelled.map(who))} won't be sent`);
  if (flying.length) bits.push(`${list(flying.map(who))} ${flying.length === 1 ? "is" : "are"} being sent right now`);
  if (went.length) bits.push(`${list(went.map(who))} already went out and can't be unsent`);
  if (!bits.length) return r(`Nothing to undo: none of those ${mails.length} emails went out.`, "already");
  return r(`${bits.join("; ")}.`, cancelled.length ? (went.length || flying.length ? "partly_cancelled" : "cancelled") : "too_late");
}

const APPLY_COLS = "id,company,state,created_at,reason,source";
// deno-lint-ignore no-explicit-any
export function supabaseUndoStore(admin: any): UndoStore {
  const must = (x: any, what: string) => { if (x.error) throw new Error(`${what}: ${x.error.message}`); return x.data; };
  return {
    async latestApply(u, since) {
      const rows = must(await admin.from("career_apply_jobs").select(APPLY_COLS).eq("user_id", u).gte("created_at", since)
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1), "read your latest application") ?? [];
      return rows[0] ?? null;
    },
    async latestEmails(u, since) {
      const last = must(await admin.from("career_outreach_drafts").select("approved_at").eq("user_id", u).not("approved_at", "is", null).gte("approved_at", since)
        .order("approved_at", { ascending: false }).limit(1), "read your latest approved email") ?? [];
      if (!last.length) return [];
      const rows = must(await admin.from("career_outreach_drafts").select("id,n,status,approved_at,result,recipient").eq("user_id", u).eq("approved_at", last[0].approved_at).order("n"), "read that approval") ?? [];
      return rows.map((x: any) => ({ id: x.id, status: x.status, approved_at: x.approved_at, result: x.result, name: String(x.recipient?.name ?? "the recipient"), firm: x.recipient?.firm ?? null }));
    },
    async cancelApplyJob(u, id) {
      // One row, by id, under its own row lock: the claims take only 'queued' rows (FOR UPDATE), so a claimed one matches
      // nothing here. source null: the routes career_apply_cancel_for also cancels (a cloud-bound row is the cloud's).
      const done = must(await admin.from("career_apply_jobs").update({ state: "not_submitted", reason: CANCELLED_REASON, updated_at: new Date().toISOString() })
        .eq("id", id).eq("user_id", u).eq("state", "queued").is("source", null).select("id"), "cancel the application") ?? [];
      const rows = must(await admin.from("career_apply_jobs").select(APPLY_COLS).eq("id", id).eq("user_id", u).limit(1), "read the application") ?? [];
      return { cancelled: done.length === 1, row: rows[0] ?? null };
    },
    async cancelEmail(u, id) {
      // approved_at is kept: the cancelled draft stays this approval's, so a second "undo" says "already cancelled" and never
      // reaches an older approval.
      const rows = must(await admin.from("career_outreach_drafts").update({ status: "skipped", approved_hash: null, result: "cancelled by you (undo)", updated_at: new Date().toISOString() })
        .eq("id", id).eq("user_id", u).eq("status", "approved").select("id"), "cancel the email") ?? [];
      return rows.length === 1;
    },
    async lastReplyAt(threadId) {
      const rows = must(await admin.from("agent_messages").select("created_at").eq("thread_id", threadId).eq("role", "assistant").order("id", { ascending: false }).limit(1), "read the last reply") ?? [];
      return rows[0]?.created_at ?? null;
    },
    async emailStatus(u, id) {
      const rows = must(await admin.from("career_outreach_drafts").select("status").eq("id", id).eq("user_id", u).limit(1), "read the email") ?? [];
      return rows[0]?.status ?? null;
    },
  };
}
