// WO-027: the person never repeats themselves. Everything that happens on their account (an application prepared,
// approved or finished, an alert set, changed or stopped, an instruction kept or removed, a fact confirmed, a search) is
// written as one event in career_events, in code, from the path that did it, never from the model's words. The brain
// reads it back with the recall tool ("which bankers did I email in October?", "what did I apply to last week?"), and
// past the 40-message window a short summary of it goes into the system prompt (WO-023 B5).
// Writing an event never fails the person's action: recordEvent logs the failure and returns false.
// No imports: the cards, receipts and tools all write here. Words compared as memory.ts plain() compares them.
const plain = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9$%]+/g, " ").trim();

export const EVENT_KINDS = [
  "application_prepared", "application_approved", "application_finished",
  "alert_set", "alert_changed", "alert_stopped",
  "instruction_kept", "instruction_removed", "fact_confirmed",
  "search", "outreach_drafted", "outreach_sent", "intro_proposed", "intro_made",
  "mock_done", "status_change", "note",
  // WO-033: an outreach draft approved, answered, or bounced (20261021010000_career_outreach.sql widens the table's check).
  "outreach_approved", "outreach_replied", "outreach_bounced",
  // WO-100: queue_applications put postings in the person's apply queue (20261023100000_career_events_apply_queued.sql).
  "apply_queued",
] as const;
export type EventKind = typeof EVENT_KINDS[number];
export const SUBJECT_MAX = 200, DETAIL_MAX = 4096, RECALL_MAX = 50, SUMMARY_MAX = 1600;

export interface CareerEvent {
  id?: number;
  user_id: string;
  at: string; // ISO
  kind: EventKind;
  subject: string;
  detail: Record<string, unknown>;
  source: string;
}
export interface EventQuery { kinds?: string[]; subject?: string; from?: string; to?: string; limit?: number }
export interface EventStore {
  add(e: CareerEvent): Promise<void>;
  // SCALE (owner, 2026-10-27): many events in one write (a batch of hundreds approved by one yes). Absent: one add each.
  addMany?(es: CareerEvent[]): Promise<void>;
  recall(userId: string, q: EventQuery): Promise<CareerEvent[]>; // newest first
}

const isKind = (k: unknown): k is EventKind => (EVENT_KINDS as readonly string[]).includes(String(k));
const bytes = (s: string) => new TextEncoder().encode(s).length;

// One event, bounded the way the table is: a known kind, a subject of at most 200 characters, detail at most 4 KB (past
// it, only the key names are kept and the cut is said).
export function normalizeEvent(e: { user_id: string; kind: string; subject?: unknown; detail?: unknown; source?: unknown; at?: number | string }): CareerEvent {
  if (!e.user_id) throw new Error("an event needs the person");
  if (!isKind(e.kind)) throw new Error(`unknown event kind ${e.kind}`);
  const at = new Date(e.at ?? Date.now());
  if (Number.isNaN(at.getTime())) throw new Error("an event needs a time");
  let detail: Record<string, unknown> = e.detail && typeof e.detail === "object" && !Array.isArray(e.detail) ? JSON.parse(JSON.stringify(e.detail)) : {};
  if (bytes(JSON.stringify(detail)) > DETAIL_MAX) detail = { cut: "detail left out for length", keys: Object.keys(detail).slice(0, 20) };
  return {
    user_id: e.user_id, at: at.toISOString(), kind: e.kind,
    subject: String(e.subject ?? "").replace(/\s+/g, " ").trim().slice(0, SUBJECT_MAX),
    detail, source: String(e.source ?? "chat").slice(0, 40),
  };
}

export async function recordEvent(store: EventStore | null | undefined, e: Parameters<typeof normalizeEvent>[0]): Promise<boolean> {
  if (!store) return false;
  try {
    await store.add(normalizeEvent(e));
    return true;
  } catch (err) {
    console.error(`career event not recorded (${e?.kind}):`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

// Many events in one write where the store can (addMany), else one by one; a timeline that cannot be written never
// changes the caller's answer. Returns how many were recorded.
export async function recordEvents(store: EventStore | null | undefined, es: Parameters<typeof normalizeEvent>[0][]): Promise<number> {
  if (!store || !es.length) return 0;
  let rows: CareerEvent[];
  try { rows = es.map(normalizeEvent); } catch (err) {
    console.error("career events not recorded:", err instanceof Error ? err.message : String(err));
    return 0;
  }
  if (store.addMany) {
    try { await store.addMany(rows); return rows.length; } catch (err) {
      console.error(`career events not recorded (${rows.length}):`, err instanceof Error ? err.message : String(err));
      return 0;
    }
  }
  let n = 0;
  for (const e of rows) { try { await store.add(e); n++; } catch (err) { console.error(`career event not recorded (${e.kind}):`, err instanceof Error ? err.message : String(err)); } }
  return n;
}

// A subject matches when every word of it starts a word of the event's subject or detail ("JPM" finds "JPMorgan Chase";
// "bankers" finds "banker").
export function matchesSubject(e: CareerEvent, subject: string | undefined): boolean {
  const words = plain(subject).split(" ").filter(Boolean).map((w) => (w.length > 3 ? w.replace(/s$/, "") : w));
  if (!words.length) return true;
  const hay = ` ${plain(e.subject + " " + JSON.stringify(e.detail ?? {}))}`;
  return words.every((w) => hay.includes(` ${w}`));
}
function matches(e: CareerEvent, q: EventQuery): boolean {
  if (q.kinds?.length && !q.kinds.includes(e.kind)) return false;
  if (q.from && e.at < new Date(q.from).toISOString()) return false;
  if (q.to && e.at >= new Date(q.to).toISOString()) return false;
  return matchesSubject(e, q.subject);
}
const limitOf = (q: EventQuery) => Math.max(1, Math.min(200, Math.floor(Number(q.limit) || RECALL_MAX)));
const newestFirst = (a: CareerEvent, b: CareerEvent) => b.at.localeCompare(a.at) || (b.id ?? 0) - (a.id ?? 0);

export function memoryEventStore(initial: CareerEvent[] = []): EventStore & { dump(): CareerEvent[] } {
  const rows: CareerEvent[] = JSON.parse(JSON.stringify(initial));
  let id = rows.reduce((m, r) => Math.max(m, r.id ?? 0), 0);
  return {
    async add(e) { rows.push({ ...JSON.parse(JSON.stringify(e)), id: ++id }); },
    async addMany(es) { for (const e of es) rows.push({ ...JSON.parse(JSON.stringify(e)), id: ++id }); },
    async recall(u, q) { return JSON.parse(JSON.stringify(rows.filter((r) => r.user_id === u && matches(r, q)).sort(newestFirst).slice(0, limitOf(q)))); },
    dump() { return JSON.parse(JSON.stringify(rows)); },
  };
}

// The service client's store: every read names the person. Kinds and the window are filtered by the database, the
// subject here (the same rule as the memory store), over at most 500 rows of the window.
export function supabaseEventStore(admin: any): EventStore {
  return {
    async add(e) {
      const r = await admin.from("career_events").insert({ user_id: e.user_id, at: e.at, kind: e.kind, subject: e.subject, detail: e.detail, source: e.source });
      if (r.error) throw new Error(`record event: ${r.error.message}`);
    },
    async addMany(es) {
      if (!es.length) return;
      const r = await admin.from("career_events").insert(es.map((e) => ({ user_id: e.user_id, at: e.at, kind: e.kind, subject: e.subject, detail: e.detail, source: e.source })));
      if (r.error) throw new Error(`record events: ${r.error.message}`);
    },
    async recall(u, q) {
      let s = admin.from("career_events").select("id,user_id,at,kind,subject,detail,source").eq("user_id", u);
      if (q.kinds?.length) s = s.in("kind", q.kinds);
      if (q.from) s = s.gte("at", q.from);
      if (q.to) s = s.lt("at", q.to);
      const r = await s.order("at", { ascending: false }).limit(q.subject ? 500 : limitOf(q));
      if (r.error) throw new Error(`read the account's history: ${r.error.message}`);
      return ((r.data ?? []) as CareerEvent[]).filter((e) => matchesSubject(e, q.subject)).sort(newestFirst).slice(0, limitOf(q));
    },
  };
}

// ------------------------------------------------------------------------------------------------ time words
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RX = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monthIndex = (w: string) => MONTHS.findIndex((m) => m.startsWith(w.slice(0, 3)));
const zoneOf = (tz?: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz || "America/New_York" }); return tz || "America/New_York"; } catch { return "America/New_York"; } };

function partsIn(ms: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}
const offsetAt = (ms: number, tz: string) => { const p = partsIn(ms, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; };
// The instant a local calendar day starts in the zone (Date.UTC carries day and month overflow, so d+1 or m+1 works).
export function localMidnight(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetAt(guess, tz);
  const again = guess - offsetAt(t, tz);
  if (again !== t) t = again;
  return t;
}
export function dayIn(at: number | string, tz?: string): string {
  const p = partsIn(new Date(at).getTime(), zoneOf(tz));
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export interface Window { from: string; to: string; label: string }
// "in October", "last week", "yesterday", "this month" and their kin, read in the person's zone. Weeks start Monday. A
// month named without a year is the latest one that has started ("October" in March 2027 is October 2026). null when
// the words are not a time this reads.
export function windowOf(text: string, now: number, tz?: string): Window | null {
  const zone = zoneOf(tz), t = plain(text).replace(/\b(in|during|of|the|from|on)\b/g, " ").replace(/\s+/g, " ").trim();
  const p = partsIn(now, zone);
  const span = (a: number, b: number, label: string): Window => ({ from: new Date(a).toISOString(), to: new Date(b).toISOString(), label });
  const day = (offset: number) => localMidnight(p.y, p.m, p.d + offset, zone);
  const weekday = (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7; // Monday 0
  if (t === "today") return span(day(0), day(1), `today (${dayIn(day(0), zone)})`);
  if (t === "yesterday") return span(day(-1), day(0), `yesterday (${dayIn(day(-1), zone)})`);
  if (t === "this week") return span(day(-weekday), day(1), `this week (since ${dayIn(day(-weekday), zone)})`);
  if (t === "past week") return span(day(-6), day(1), "the last 7 days");
  if (t === "last week") return span(day(-weekday - 7), day(-weekday), `last week (${dayIn(day(-weekday - 7), zone)} to ${dayIn(day(-weekday - 1), zone)})`);
  if (t === "this month") return span(localMidnight(p.y, p.m, 1, zone), day(1), `${MONTHS[p.m - 1][0].toUpperCase()}${MONTHS[p.m - 1].slice(1)} ${p.y} so far`);
  if (t === "last month") { const y = p.m === 1 ? p.y - 1 : p.y, m = p.m === 1 ? 12 : p.m - 1; return monthSpan(y, m, zone); }
  if (t === "this year") return span(localMidnight(p.y, 1, 1, zone), day(1), `${p.y} so far`);
  if (t === "last year") return span(localMidnight(p.y - 1, 1, 1, zone), localMidnight(p.y, 1, 1, zone), `${p.y - 1}`);
  const n = t.match(/^(?:last|past) (\d{1,3}) (day|week)s?$/);
  if (n) { const days = Number(n[1]) * (n[2] === "week" ? 7 : 1); return days >= 1 ? span(day(1 - days), day(1), `the last ${n[1]} ${n[2]}${n[1] === "1" ? "" : "s"}`) : null; }
  const m = t.match(new RegExp(`^(last |this )?${MONTH_RX}(?: (\\d{4}))?$`));
  if (m) {
    const mi = monthIndex(m[2]) + 1;
    let y = m[3] ? Number(m[3]) : (mi > p.m ? p.y - 1 : p.y);
    if (!m[3] && m[1] === "last " && mi >= p.m) y = p.y - 1;
    return monthSpan(y, mi, zone);
  }
  return null;
}
function monthSpan(y: number, m: number, zone: string): Window {
  const name = MONTHS[m - 1];
  return { from: new Date(localMidnight(y, m, 1, zone)).toISOString(), to: new Date(localMidnight(y, m + 1, 1, zone)).toISOString(), label: `${name[0].toUpperCase()}${name.slice(1)} ${y}` };
}

// ------------------------------------------------------------------------------------------------ B5 summary
const SHORT = (at: string, tz: string, now: number) => {
  const d = new Date(at), year = dayIn(at, tz).slice(0, 4) !== dayIn(now, tz).slice(0, 4);
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) }).format(d);
};
const names = (list: string[], max = 5) => {
  const uniq = [...new Set(list.filter(Boolean))];
  return uniq.length > max ? `${uniq.slice(0, max).join(", ")} and ${uniq.length - max} more` : uniq.join(", ");
};
// Names, search text and stored details are data. Keep each generated bullet on one line so those values cannot
// create a new system-prompt section. Escape here, after composition, without rewriting the event or task record.
const summaryLine = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

// Past the 40-message window: what happened, written in code from the account's own events (counts and names, with
// dates), never a model's paraphrase of the person's words. Bounded; newest kept when over.
export function threadSummary(events: CareerEvent[], now: number, tz?: string): string {
  const zone = zoneOf(tz), on = (e: CareerEvent) => SHORT(e.at, zone, now);
  const all = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const of = (...k: EventKind[]) => all.filter((e) => k.includes(e.kind));
  const lines: { text: string; at: string }[] = [];
  const add = (text: string, rows: CareerEvent[]) => lines.push({ text: summaryLine(text), at: rows[rows.length - 1].at });
  const searches = of("search");
  if (searches.length) add(`- Searches: ${searches.length}, latest ${searches.slice(-3).reverse().map((e) => `"${e.subject}" (${on(e)})`).join(", ")}.`, searches);
  const alerts = of("alert_set", "alert_changed", "alert_stopped");
  if (alerts.length) {
    const word: Record<string, string> = { alert_set: "set", alert_changed: "changed", alert_stopped: "stopped" };
    add(`- Job alerts: ${alerts.slice(-4).map((e) => `${word[e.kind]} ${on(e)}${e.subject ? ` (${e.subject})` : ""}`).join("; ")}.`, alerts);
  }
  const kept = of("instruction_kept"), removed = of("instruction_removed");
  if (kept.length || removed.length) add(`- Standing instructions: ${[kept.length ? `kept ${kept.length} (${names(kept.map((e) => e.subject), 3)})` : "", removed.length ? `removed ${removed.length} (${names(removed.map((e) => e.subject), 3)})` : ""].filter(Boolean).join("; ")}.`, of("instruction_kept", "instruction_removed"));
  const facts = of("fact_confirmed");
  if (facts.length) add(`- Facts confirmed: ${facts.length}, latest ${on(facts[facts.length - 1])}.`, facts);
  // Queue writes have their own event kind. Keep that task after its chat has left the history window, without
  // turning retry no-ops into applications or treating an earlier queue action as a submission receipt.
  const queued = of("apply_queued").filter((e) => typeof e.detail?.queued === "number" && Number.isSafeInteger(e.detail.queued) && e.detail.queued > 0);
  if (queued.length) {
    // The display cap must retain the newest employers; totals and the immutable source history still cover all.
    const companies = queued.slice().reverse().flatMap((e) => Array.isArray(e.detail.companies) ? e.detail.companies.filter((x): x is string => typeof x === "string") : []);
    add(`- Postings queued: ${queued.reduce((n, e) => n + Number(e.detail.queued), 0)}${companies.length ? ` (${names(companies)})` : ""}, latest ${on(queued[queued.length - 1])}. Not sent by these queue actions; later receipts, if any, are separate.`, queued);
  }
  const prepared = of("application_prepared");
  if (prepared.length) add(`- Applications prepared: ${prepared.length} (${names(prepared.map((e) => e.subject))}).`, prepared);
  const approved = of("application_approved");
  if (approved.length) add(`- Cards answered, approved: ${approved.length} (${names(approved.map((e) => e.subject))}), latest ${on(approved[approved.length - 1])}.`, approved);
  const notSent = of("status_change").filter((e) => e.source === "card");
  if (notSent.length) add(`- Cards answered, not sent: ${notSent.length} (${names(notSent.map((e) => e.subject))}).`, notSent);
  const finished = of("application_finished");
  if (finished.length) add(`- Applications finished: ${finished.slice(-5).reverse().map((e) => `${e.subject} ${String(e.detail?.state ?? "").replace(/_/g, " ")} (${on(e)})`).join(", ")}${finished.length > 5 ? ` and ${finished.length - 5} more` : ""}.`, finished);
  const tracked = of("status_change").filter((e) => e.source !== "card");
  if (tracked.length) add(`- Applications they reported: ${tracked.slice(-5).reverse().map((e) => `${e.subject}${e.detail?.stage ? ` ${e.detail.stage}` : ""} (${on(e)})`).join(", ")}.`, tracked);
  for (const [k, label] of [["outreach_drafted", "Outreach drafted"], ["outreach_approved", "Outreach approved"], ["outreach_sent", "Outreach sent"], ["outreach_replied", "Outreach replies"], ["outreach_bounced", "Outreach bounced"], ["intro_proposed", "Intros proposed"], ["intro_made", "Intros made"], ["mock_done", "Mock interviews"], ["note", "Notes"]] as const) {
    const xs = of(k);
    if (xs.length) add(`- ${label}: ${xs.length} (${names(xs.map((e) => e.subject))}).`, xs);
  }
  const head = [
    "EARLIER IN THIS CONVERSATION. It is longer than the 40 messages shown. Upmore wrote this from its own record of what happened on the account, not from the person's words: use it to stay consistent, never quote it as theirs, and use the recall tool for details.",
  ];
  if (!lines.length) return [...head, "- Nothing else is on record."].join("\n");
  const out = [...head];
  let used = out[0].length;
  // A long older group must not consume the budget before a newer task outcome, or block a shorter group that fits.
  for (const { text } of lines.sort((a, b) => b.at.localeCompare(a.at))) {
    if (used + text.length + 1 > SUMMARY_MAX) continue;
    out.push(text); used += text.length + 1;
  }
  return out.join("\n");
}
export const SUMMARY_UNREADABLE = "EARLIER IN THIS CONVERSATION. It is longer than the 40 messages shown, and the record of what happened before could not be read this turn. If they ask about something older, say so and offer to look it up with the recall tool; never guess.";
