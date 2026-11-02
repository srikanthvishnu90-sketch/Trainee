// Reqs doc 2 (tasks and follow-through) Q344 / Q322 / Q348 / Q355: a role on the person's apply list that has not been sent
// gets one text the day before its posting closes, and one line once the employer has taken the posting down. Nothing else:
// no reminder loop, no text for a role already applied to, none for a role whose posting states no closing date.
//   - The closing date is read only from the posting's own words (career_postings.description): a sentence that says the
//     applications close, are due, or must be in by a date written with its month's name or as YYYY-MM-DD. Day-first or
//     month-first numbers ("05/11/2026") are never read, since either reading could be wrong. A date with no year is the
//     first such day on or after the day Trainee first saw the posting. The text quotes the posting's sentence (D-007).
//   - "Closed" is the board's own record (career_postings.closed_at, set when the posting left its board).
//   - Who: career_apply_wanted rows still waiting (on the list, not sent), with no career_apply_jobs row for that posting.
//     What it is waiting on is said: its open questions (career_apply_questions), or that it has not been prepared yet.
//   - When: the day before the closing day on the person's own clock, from their report hour, never in quiet hours. Once per
//     posting ever (career_outbox key status:closing:<closing day>:<posting> / status:closed:<posting>, unique per person).
// The scheduled run (career-proactive) calls runClosing over the people who are not paused (its `awake` filter); delivery
// checks the account again before a text goes out (channel.ts deliverDue). Nothing is applied, approved or sent by this.
import { DEFAULT_PREFS, quietAt, zoneOr } from "./career_alerts.ts";
import type { Outbox } from "./career_alert_store.ts";

export interface ClosingRow {
  user_id: string; posting_key: string; company: string; title: string; url: string; queued_at: string;
  description: string; first_seen_at: string; closed_at: string | null;
  tz?: string | null; report_hour?: number; quiet_start?: number; quiet_end?: number;
  // The labels of the questions this posting is waiting on (career_apply_questions, state open).
  open_questions?: string[];
}

const MONTHS: Record<string, number> = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
const MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
// What makes a date a closing date: the sentence says APPLICATIONS close, are due, or must be in by it. A bare "deadline" or
// "no later than" is never enough ("thrive under deadlines", "start no later than June 1" are not closing dates).
const CUE = new RegExp("\\b(?:apply by|apply before|apply no later than|applications? (?:will )?(?:close|closes|closing|are due|is due|due|must be (?:received|submitted)(?: by| before| no later than)?)" +
  "|applications? (?:will be )?(?:accepted|reviewed|taken) (?:until|through|till)|application deadline|deadline (?:to apply|for applications|to submit (?:your |an )?application)" +
  "|closing date for applications|(?:this )?(?:posting|position|role|job|requisition) (?:will )?(?:close|closes|expires)(?: on)?|accepting applications (?:until|through|till)" +
  "|submit (?:your |an )?applications? (?:by|before|no later than))\\b", "gi");
// The dates read after a cue: a month's name with the day (either order), or YYYY-MM-DD. Never d/m or m/d numbers.
const MD = new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i");
const DM = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}(?:,?\\s+(\\d{4}))?\\b`, "i");
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;
// The clause a cue governs: up to 50 characters after it, ended by a sentence stop or a comma that starts new words
// ("Applications close 4 November, interviews on Nov 10": only "4 November" is the cue's).
function clauseAfter(text: string, from: number): string {
  const rest = text.slice(from, from + 50);
  const stop = rest.search(/[!?;\n]|\.(?=\s+[A-Z]|\s*$)|,(?=\s*[A-Za-z])/);
  return stop < 0 ? rest : rest.slice(0, stop);
}
const valid = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;
const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// The closing day the posting states (YYYY-MM-DD, the last day to apply) and the sentence that says it; null when it states
// none this reader can be sure of.
export function closingDateOf(description: string, firstSeenIso: string): { day: string; said: string } | null {
  const text = String(description ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").slice(0, 20000);
  const seen = Date.parse(firstSeenIso);
  if (!Number.isFinite(seen)) return null;
  const seenDay = new Date(seen).toISOString().slice(0, 10);
  let y: number | null = null, m = 0, d = 0, at = -1, len = 0;
  CUE.lastIndex = 0;
  for (let c = CUE.exec(text); c; c = CUE.exec(text)) {
    const from = c.index + c[0].length, clause = clauseAfter(text, from);
    // The date nearest after the cue in its clause.
    const hit = [MD.exec(clause), DM.exec(clause), ISO.exec(clause)].map((x, k) => x ? { x, k } : null).filter((v): v is { x: RegExpExecArray; k: number } => !!v)
      .sort((p, q) => p.x.index - q.x.index)[0];
    if (!hit) continue;
    const x = hit.x;
    if (hit.k === 2) { y = Number(x[1]); m = Number(x[2]); d = Number(x[3]); }
    else if (hit.k === 0) { m = MONTHS[x[1].toLowerCase().replace(/\.$/, "")]; d = Number(x[2]); y = x[3] ? Number(x[3]) : null; }
    else { d = Number(x[1]); m = MONTHS[x[2].toLowerCase().replace(/\.$/, "")]; y = x[3] ? Number(x[3]) : null; }
    at = c.index; len = from - c.index + x.index + x[0].length;
    break;
  }
  if (at < 0) return null;
  if (!m) return null;
  if (y === null) {
    // No year written: the first such day on or after the day the posting was first seen.
    const sy = Number(seenDay.slice(0, 4));
    y = ymd(sy, m, d) >= seenDay ? sy : sy + 1;
  }
  if (!valid(y, m, d)) return null;
  const day = ymd(y, m, d);
  // A stated date more than a year from when it was first seen is not trusted as this posting's close.
  if (Date.parse(day) - Date.parse(seenDay) > 366 * 86400000) return null;
  // The sentence it is in, for the text (bounded, the posting's own words).
  const start = Math.max(text.lastIndexOf(".", at) + 1, text.lastIndexOf("\n", at) + 1, 0);
  const endDot = text.slice(at + len).search(/[.!?\n]/);
  const end = endDot < 0 ? text.length : at + len + endDot + 1;
  const said = text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 200);
  return { day, said };
}

const fmt = new Map<string, Intl.DateTimeFormat>();
function clock(at: number, tz: string): { day: string; hour: number } {
  let f = fmt.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }); fmt.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const label = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const shortDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const one = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const nameOf = (r: ClosingRow) => `${one(r.title, 120) || "A role"} at ${one(r.company, 120) || "an employer"}`;

export const CLOSING_PREFIX = "status:closing:", CLOSED_PREFIX = "status:closed:", CLOSED_NEWS_MS = 7 * 86400000;
// Review of #378: a closing text held past its day (WhatsApp's 24-hour window holds a text until the person writes) is
// never sent after the role closed. Its key carries the closing day (status:closing:<YYYY-MM-DD>:<posting>); delivery
// (channel.ts) drops it from the start of that day in UTC, which is before the day ends anywhere in the Americas.
export function closingExpired(key: string, now: number): boolean {
  const m = /^status:closing:(\d{4}-\d{2}-\d{2}):/.exec(String(key ?? ""));
  if (!m) return false;
  const start = Date.parse(`${m[1]}T00:00:00Z`);
  return !Number.isFinite(start) || now >= start;
}

export function closingText(r: ClosingRow, close: { day: string; said: string }): string {
  const qs = (r.open_questions ?? []).map((q) => one(q, 140)).filter(Boolean);
  const waiting = qs.length
    ? `It's waiting on your answer to ${qs.length === 1 ? "one question" : `${qs.length} questions`}: ${qs.slice(0, 3).map((q) => `"${q}"`).join("; ")}${qs.length > 3 ? ` and ${qs.length - 3} more` : ""}.`
    : "It hasn't been prepared for your approval yet.";
  return `${nameOf(r)} closes ${label(close.day)} (the posting says: "${close.said}"). It's on your apply list and nothing has been sent. ${waiting} ` +
    `Say "don't apply to ${one(r.company, 120)}" to drop it. This is the only reminder about it.`;
}
export function closedText(r: ClosingRow): string {
  return `${nameOf(r)} is no longer posted: the employer took it down (Trainee saw it gone on ${shortDay(r.closed_at!)}). Nothing was sent for it, and it can't be applied to now.`;
}

// What one run queues: per row, the closed line (once the posting is gone) or the closing text (the day before it closes,
// in the person's waking hours from their report hour). Pure; the outbox decides "once".
export function planClosing(rows: ClosingRow[], now: number): { userId: string; key: string; text: string; at: number }[] {
  const out: { userId: string; key: string; text: string; at: number }[] = [];
  for (const r of rows) {
    if (!r.posting_key) continue;
    if (r.closed_at && Number.isFinite(Date.parse(r.closed_at))) {
      // Only a posting that left its board in the last week: a role that closed long ago is not news.
      if (Date.parse(r.closed_at) < now - CLOSED_NEWS_MS) continue;
      const tz = zoneOr(r.tz);
      if (quietAt(now, tz, { quiet_start: r.quiet_start ?? DEFAULT_PREFS.quiet_start, quiet_end: r.quiet_end ?? DEFAULT_PREFS.quiet_end })) continue;
      out.push({ userId: r.user_id, key: `${CLOSED_PREFIX}${r.posting_key}`, text: closedText(r), at: now });
      continue;
    }
    const close = closingDateOf(r.description, r.first_seen_at);
    if (!close) continue;
    const tz = zoneOr(r.tz), c = clock(now, tz);
    if (c.day !== dayBefore(close.day)) continue;
    if (c.hour < (r.report_hour ?? DEFAULT_PREFS.report_hour)) continue;
    if (quietAt(now, tz, { quiet_start: r.quiet_start ?? DEFAULT_PREFS.quiet_start, quiet_end: r.quiet_end ?? DEFAULT_PREFS.quiet_end })) continue;
    out.push({ userId: r.user_id, key: `${CLOSING_PREFIX}${close.day}:${r.posting_key}`, text: closingText(r, close), at: now });
  }
  return out;
}

export async function runClosing(o: { outbox: Outbox; now: number; rows: () => Promise<ClosingRow[]> }): Promise<number> {
  let n = 0;
  const failed: string[] = [];
  for (const m of planClosing(await o.rows(), o.now)) {
    try { if (await o.outbox.enqueue(m.userId, { key: m.key, kind: "status", text: m.text, at: m.at })) n++; }
    catch (e) { failed.push(e instanceof Error ? e.message : String(e)); }
  }
  if (failed.length) throw Object.assign(new Error(`closing texts failed for ${failed.length} roles (${n} queued): ${failed[0]}`), { partial: n });
  return n;
}

// The production reader (service role): the waiting rows, their postings, the person's zone and hours, and open questions.
// A posting not on file (a link read on demand and since dropped) or one with an application row is left out.
// deno-lint-ignore no-explicit-any
export function supabaseClosingRows(admin: any): () => Promise<ClosingRow[]> {
  return async () => {
    const w = await admin.from("career_apply_wanted").select("user_id,posting_key,company,title,url,queued_at").eq("state", "waiting").order("queued_at", { ascending: true }).limit(2000);
    if (w.error) throw new Error(`read the apply lists: ${w.error.message}`);
    const wanted = (w.data ?? []) as { user_id: string; posting_key: string; company: string; title: string; url: string; queued_at: string }[];
    if (!wanted.length) return [];
    const keys = [...new Set(wanted.map((x) => x.posting_key))], users = [...new Set(wanted.map((x) => x.user_id))];
    const [p, jobs, prefs, qs] = await Promise.all([
      admin.from("career_postings").select("job_id,description,first_seen_at,closed_at").in("job_id", keys),
      admin.from("career_apply_jobs").select("user_id,job_id").in("user_id", users).in("job_id", keys),
      admin.from("career_alert_prefs").select("user_id,tz,prefs").in("user_id", users),
      admin.from("career_apply_questions").select("user_id,label,job_ids").in("user_id", users).eq("state", "open"),
    ]);
    for (const [r, what] of [[p, "postings"], [jobs, "applications"], [prefs, "quiet hours"], [qs, "open questions"]] as const) if (r.error) throw new Error(`read the ${what}: ${r.error.message}`);
    const posting = new Map((p.data ?? []).map((x: any) => [x.job_id, x]));
    const applied = new Set((jobs.data ?? []).map((x: any) => `${x.user_id} ${x.job_id}`));
    const pref = new Map((prefs.data ?? []).map((x: any) => [x.user_id, x]));
    const out: ClosingRow[] = [];
    for (const x of wanted) {
      const pp: any = posting.get(x.posting_key);
      if (!pp || applied.has(`${x.user_id} ${x.posting_key}`)) continue;
      const pr: any = pref.get(x.user_id);
      const open = (qs.data ?? []).filter((q: any) => q.user_id === x.user_id && Array.isArray(q.job_ids) && q.job_ids.includes(x.posting_key)).map((q: any) => String(q.label));
      out.push({ ...x, description: String(pp.description ?? ""), first_seen_at: pp.first_seen_at, closed_at: pp.closed_at ?? null, tz: pr?.tz ?? null,
        report_hour: pr?.prefs?.report_hour, quiet_start: pr?.prefs?.quiet_start, quiet_end: pr?.prefs?.quiet_end, open_questions: open });
    }
    return out;
  };
}
