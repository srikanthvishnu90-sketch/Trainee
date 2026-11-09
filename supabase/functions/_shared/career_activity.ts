// REQS DOC 1 (Q21, Q249, Q34): "what did you do today?", "how much did we get done this week?", "what did you send
// today?", "how many applications did you send this week?" answered by code with counts from the records, the window
// named and the counting method said. Before this, these asks reached the router's fallback, and "what did you send
// today" was read as a receipt ask for a company called "today".
//   applications  career_apply_jobs: queued in the window by created_at (the moment the approved application was queued);
//                 sent by the receipt's finished_at (career_apply_receipts, the moment the send finished), never by
//                 updated_at, which moves again when the employer's confirmation arrives days later; a confirmation by
//                 email_confirmed_at (the employer's matched email), only in state confirmed; stopped for the person and
//                 did not go by updated_at (the moment that status was set). A sent application with no receipt has no
//                 send time on record: named, not counted by day.
//   emails        career_outreach_drafts that left the person's mailbox (sent, replied or bounced), by sent_at. The send
//                 rail and the follow-up sends both write this record, so each email is counted once.
// The window is the person's own day (career_alert_prefs.tz; UTC when none is saved, and said). A record that cannot be
// read is named and not counted; nothing is estimated. Read only: nothing is changed or sent.
export const ACTIVITY_INTENT = "career_activity";
export type Span = "today" | "yesterday" | "week";
export interface ActivityAsk { span: Span; said: boolean }

// sent_at: the receipt's finished_at (null: no receipt); email_confirmed_at: when the employer's confirmation email arrived.
export interface ActivityApp { company: string; state: string; created_at: string; updated_at: string; sent_at?: string | null; email_confirmed_at?: string | null; title?: string | null }
export interface ActivityEmail { status: string; sent_at: string; name?: string | null; firm?: string | null }
// null: that record could not be read.
// receipts: false when the receipts could not be read (then no send can be dated, and that is said).
export interface ActivityRows { apps: ActivityApp[] | null; emails: ActivityEmail[] | null; tz: string | null; receipts?: boolean }
export type ReadActivity = (userId: string, fromIso: string) => Promise<ActivityRows>;

const plain = (s: string) => ` ${String(s ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[?!.]+\s*$/, "").replace(/\s+/g, " ").trim()
  .replace(/^[^\p{L}\p{N}"'(]+/u, "").replace(/^(?:(?:hey|hi|hello|ok|okay|so|pls|please|yo)\b[,!:]?\s+)+/, "").replace(/,? (?:please|pls|thanks|thank you)$/, "")} `;
const SPAN = "(?:so far )?(?:today|this morning|tonight|yesterday|this week|this past week|(?:in |over )?the (?:last|past) (?:7|seven) days|(?:in |over )?the (?:last|past) week|lately|recently)";
const WHO = "(?:you|u|we|trainee)";
const ASKS = [
  new RegExp(`^ (?:what|how much|what all|what else) (?:did|have|has) ${WHO} (?:do|done|get done|gotten done|got done|accomplish|accomplished|work on|worked on|send|sent|been up to|been doing|handle|handled)(?: for me)?(?: ${SPAN})? $`),
  new RegExp(`^ (?:what|how much) (?:got|has gotten|has been|was|did we get) (?:done|sent|accomplished)(?: for me)?(?: ${SPAN})? $`),
  new RegExp(`^ what (?:emails?|applications?|apps|messages|jobs) (?:did|have|has) ${WHO} (?:send|sent|submit|submitted|apply to|applied to|apply for|applied for)(?: for me)?(?: ${SPAN})? $`),
  new RegExp(`^ how many (?:applications?|apps|emails?|jobs|things|messages) (?:did|have|has) ${WHO} (?:send|sent|submit|submitted|apply to|applied to|apply for|applied for|do|done|queue|queued)(?: for me)?(?: ${SPAN})? $`),
  new RegExp(`^ (?:(?:give|send|show) me )?(?:a |an |my |the )?(?:recap|activity|activity report|work log|log)(?: of| for)? (?:what you did )?${SPAN} $`),
  new RegExp(`^ (?:(?:give|send|show) me )?(?:a |an |my |the )?(?:daily|weekly|today'?s|this week'?s|yesterday'?s) (?:recap|activity|activity report|summary|report|work log)(?: please)? $`),
];
const spanOf = (t: string): Span =>
  / yesterday/.test(t) ? "yesterday" : / (?:today|this morning|tonight|daily)/.test(t) ? "today" : "week";
const SAID = new RegExp(` ${SPAN} $|(?:daily|weekly|today'?s|this week'?s|yesterday'?s) `);

// The ask, if this text is one: its window, and whether the person named it (the default is the last 7 days, said).
export function activityAsk(message: string): ActivityAsk | null {
  const t = plain(message);
  if (!ASKS.some((re) => re.test(t))) return null;
  return { span: spanOf(t), said: SAID.test(t) };
}

// ------------------------------------------------------------------------------------------------ the window
const DAY = 86_400_000;
function validZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
}
// Minutes the zone is ahead of UTC at an instant.
function offsetMin(at: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(at)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(at / 1000) * 1000) / 60_000);
}
// The local calendar date (y, m, d) of an instant in a zone.
function localDate(at: number, tz: string): { y: number; m: number; d: number } {
  const local = new Date(at + offsetMin(at, tz) * 60_000);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
}
// The instant local midnight of (y, m, d) begins in the zone (a daylight-saving change on that day is honoured).
export function localMidnight(y: number, m: number, d: number, tz: string): number {
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) guess = Date.UTC(y, m - 1, d) - offsetMin(guess, tz) * 60_000;
  return guess;
}
const dayKey = (at: number, tz: string) => { const x = localDate(at, tz); return `${x.y}-${x.m}-${x.d}`; };
const short = (at: number, tz: string) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });

export interface ActivityWindow { span: Span; from: number; to: number; tz: string; zoneSaid: boolean; label: string }
export function windowOf(span: Span, now: number, tz: string | null): ActivityWindow {
  const zone = validZone(tz) ?? "UTC", zoneSaid = !validZone(tz);
  const today = localDate(now, zone);
  const todayStart = localMidnight(today.y, today.m, today.d, zone);
  const back = (n: number) => { const x = new Date(Date.UTC(today.y, today.m - 1, today.d) - n * DAY); return localMidnight(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate(), zone); };
  const where = zoneSaid ? "UTC, since I don't have your time zone" : zone;
  if (span === "today") return { span, from: todayStart, to: now, tz: zone, zoneSaid, label: `Today (since midnight, ${where})` };
  if (span === "yesterday") { const from = back(1); return { span, from, to: todayStart, tz: zone, zoneSaid, label: `Yesterday (${short(from, zone)}, ${where})` }; }
  const from = back(6);
  return { span, from, to: now, tz: zone, zoneSaid, label: `The last 7 days (${short(from, zone)} to ${short(now, zone)}, ${where})` };
}

// ------------------------------------------------------------------------------------------------ the reply
const MAX_NAMED = 8;
const inWin = (iso: string | null | undefined, w: ActivityWindow) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) && t >= w.from && t < w.to + 1; };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const names = (xs: string[]) => {
  const u = [...new Set(xs.map((x) => String(x ?? "").replace(/\s+/g, " ").trim()).filter(Boolean))];
  return u.length > MAX_NAMED ? `${u.slice(0, MAX_NAMED).join(", ")} and ${u.length - MAX_NAMED} more` : u.join(", ");
};
const SENT = new Set(["confirmed", "submitted_unconfirmed"]);
const DID_NOT_GO = new Set(["failed", "not_submitted"]);

export const METHOD = "How I counted: an application as queued by when you approved it into the queue, as sent by when its send finished (its receipt), and as confirmed by when the employer's confirmation email arrived. Stopped and failed applications by when that status was set. Each email by when it was sent. Days with work are days with a send, a confirmation or an email sent. Only what is on record is counted, nothing is estimated.";

export function activityText(rows: ActivityRows, w: ActivityWindow, ask: ActivityAsk): { reply: string; status: string } {
  const apps = rows.apps ?? [], emails = rows.emails ?? [];
  const receipts = rows.apps !== null && rows.receipts !== false;
  const queued = apps.filter((a) => inWin(a.created_at, w));
  const sent = receipts ? apps.filter((a) => SENT.has(a.state) && inWin(a.sent_at, w)) : [];
  const sentConfirmed = sent.filter((a) => a.state === "confirmed");
  const sentOpen = sent.filter((a) => a.state !== "confirmed");
  const confirmations = apps.filter((a) => a.state === "confirmed" && inWin(a.email_confirmed_at, w));
  const undated = receipts ? apps.filter((a) => SENT.has(a.state) && !a.sent_at && inWin(a.updated_at, w)) : [];
  const changed = apps.filter((a) => inWin(a.updated_at, w));
  const unknown = changed.filter((a) => a.state === "unknown_outcome");
  const needsYou = changed.filter((a) => a.state === "needs_user");
  const notGone = changed.filter((a) => DID_NOT_GO.has(a.state));
  const pending = queued.filter((a) => a.state === "queued" || a.state === "driving");
  const mailed = emails.filter((e) => ["sent", "replied", "bounced"].includes(e.status) && inWin(e.sent_at, w));
  const bounced = mailed.filter((e) => e.status === "bounced");
  const lost = [...(rows.apps === null ? ["your application queue"] : !receipts ? ["your application receipts (so no send is counted)"] : []), ...(rows.emails === null ? ["your email log"] : [])];
  const L: string[] = [];
  if (!ask.said) L.push("You didn't say when, so this is the last 7 days.");
  const parts: string[] = [];
  if (rows.apps !== null) {
    parts.push(`${plural(queued.length, "application")} approved and queued`);
    if (receipts) parts.push(`${sent.length} sent to the employer (${sentConfirmed.length} confirmed by the employer so far, ${sentOpen.length} not confirmed yet)`);
    parts.push(`${plural(confirmations.length, "employer confirmation")} received`);
  }
  if (rows.emails !== null) parts.push(`${plural(mailed.length, "email")} sent from your account`);
  // Nothing only when every bucket is empty: a send or a confirmation in the window is work even when the row changed later.
  const nothing = rows.apps !== null && rows.emails !== null && !queued.length && !sent.length && !confirmations.length && !undated.length && !changed.length && !mailed.length;
  if (!parts.length) {
    L.push(`${w.label}: I couldn't read your application queue or your email log just now, so I can't count anything. Ask me again in a minute.`);
    return { reply: L.join("\n"), status: "unreadable" };
  }
  if (nothing) {
    L.push(`${w.label}: nothing happened. No application was queued or sent, and no email went out from your account.`);
  } else {
    L.push(`${w.label}: ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]}.`);
    if (sentConfirmed.length) L.push(`Sent and confirmed by the employer: ${names(sentConfirmed.map((a) => a.company))}.`);
    if (sentOpen.length) L.push(`Sent, no confirmation from the employer yet: ${names(sentOpen.map((a) => a.company))}.`);
    if (confirmations.length) L.push(`Employer confirmations received: ${names(confirmations.map((a) => a.company))}.`);
    if (undated.length) L.push(`Sent, but the send time is not on record, so not counted as sent here: ${names(undated.map((a) => a.company))}.`);
    if (unknown.length) L.push(`Submission may have landed, not confirmed (it will not be sent again): ${names(unknown.map((a) => a.company))}.`);
    if (needsYou.length) L.push(`Stopped, waiting on you: ${names(needsYou.map((a) => a.company))}.`);
    if (notGone.length) L.push(`Did not go through: ${names(notGone.map((a) => a.company))}.`);
    if (pending.length) L.push(`Queued and not sent yet: ${names(pending.map((a) => a.company))}.`);
    if (mailed.length) L.push(`Emails went to: ${names(mailed.map((e) => [e.name, e.firm].filter(Boolean).join(" at ") || "a contact"))}${bounced.length ? ` (${bounced.length} bounced back)` : ""}.`);
    if (w.span === "week") {
      // Only completed work: a send that finished, a confirmation that arrived, an email that went out.
      const days = new Set<string>();
      for (const a of sent) days.add(dayKey(Date.parse(a.sent_at!), w.tz));
      for (const a of confirmations) days.add(dayKey(Date.parse(a.email_confirmed_at!), w.tz));
      for (const e of mailed) days.add(dayKey(Date.parse(e.sent_at), w.tz));
      L.push(`Days with work: ${days.size} of 7.`);
    }
  }
  if (lost.length) L.push(`Not read just now, so not counted: ${lost.join(" and ")}.`);
  L.push(METHOD);
  return { reply: L.join("\n"), status: lost.length ? "partial" : nothing ? "none" : "shown" };
}

// One chat turn: the read only for an activity ask; a read that fails is said, never guessed.
export async function activityTurn(o: { message: string; userId: string; now: number; read: ReadActivity }): Promise<{ reply: string; status: string; intent: string } | null> {
  const ask = activityAsk(o.message);
  if (!ask) return null;
  // The read covers 8 days back so every zone's window is inside it; the window itself is cut in activityText.
  let rows: ActivityRows;
  try { rows = await o.read(o.userId, new Date(o.now - 8 * DAY).toISOString()); } catch (e) {
    console.error("activity:", e instanceof Error ? e.message : String(e));
    rows = { apps: null, emails: null, tz: null };
  }
  const w = windowOf(ask.span, o.now, rows.tz);
  return { ...activityText(rows, w, ask), intent: ACTIVITY_INTENT };
}

// The production read: the person's own rows since `from`, each record on its own (a failure is null, never guessed).
// deno-lint-ignore no-explicit-any
export function supabaseActivity(admin: any): ReadActivity {
  return async (userId, from) => {
    const q = async <T>(name: string, p: PromiseLike<{ data: any; error: any }>, map: (rows: any[]) => T): Promise<T | null> => {
      try { const r = await p; if (r.error) throw new Error(r.error.message ?? String(r.error)); return map(r.data ?? []); } catch (e) {
        console.error(`activity: ${name}:`, e instanceof Error ? e.message : String(e)); return null;
      }
    };
    // Every send or confirmation in the window moved updated_at into it, so this filter reads every row the window needs.
    const [jobs, receipts, emails, tz] = await Promise.all([
      q("applications", admin.from("career_apply_jobs").select("id,company,state,created_at,updated_at,email_confirmed_at,title:payload->>title").eq("user_id", userId)
        .or(`created_at.gte.${from},updated_at.gte.${from}`).order("updated_at", { ascending: false }).limit(1000), (r) => r as (ActivityApp & { id: string })[]),
      q("receipts", admin.from("career_apply_receipts").select("application_id,finished_at").eq("user_id", userId).gte("finished_at", from).limit(1000),
        (r) => new Map(r.map((x) => [String(x.application_id), String(x.finished_at)]))),
      q("emails", admin.from("career_outreach_drafts").select("status,sent_at,recipient").eq("user_id", userId).in("status", ["sent", "replied", "bounced"])
        .gte("sent_at", from).order("sent_at", { ascending: false }).limit(1000),
        (r) => r.map((x): ActivityEmail => ({ status: x.status, sent_at: x.sent_at, name: x.recipient?.name ?? null, firm: x.recipient?.firm ?? null }))),
      q("time zone", admin.from("career_alert_prefs").select("tz").eq("user_id", userId).limit(1), (r) => (r[0]?.tz ?? null) as string | null),
    ]);
    const apps = jobs === null ? null : jobs.map(({ id, ...a }) => ({ ...a, sent_at: receipts?.get(String(id)) ?? null }));
    return { apps, emails, tz, receipts: receipts !== null };
  };
}
