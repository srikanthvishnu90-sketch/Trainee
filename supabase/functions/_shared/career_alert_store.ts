// Where job alerts live (WO-007b): each person's alert preferences and counters, and the outbox of alerts and reports
// waiting to be delivered. The chat's tools write preferences; the scheduled runner (career-proactive) reads them, plans
// with career_alerts.ts, writes the outbox (one row per person and key, ever) and saves the counters. Delivery from the
// outbox is the texting channel's job (WO-013); the simulator drains its own in-memory queue.
// Tables: supabase/migrations/20261019010001_career_alerts.sql.
import { DEFAULT_PREFS, MAX_INSTANT_PER_DAY, WEEKLY_MAX, type AlertPrefs, type PlanUser } from "./career_alerts.ts";
import { validFloor } from "./career_floor.ts";

export interface AlertRow extends PlanUser { sent_on: string | null } // sent_on: the local day instant_sent_today counts
export type AlertCounters = Pick<AlertRow, "last_checked_at" | "instant_sent_today" | "sent_on" | "held" | "last_report_on">;
export interface AlertStore {
  get(userId: string): Promise<AlertRow | null>;
  save(row: AlertRow): Promise<void>;
  // WO-091c: the alerts run's own counters only, never the person's settings (prefs, tz): a stop that lands mid-run holds.
  // `counted`: the day's count was kept by enqueueAlert itself; instant_sent_today and sent_on are not written.
  saveCounters?(userId: string, c: AlertCounters, o?: { counted?: boolean }): Promise<void>;
  // The person's alert settings removed (they asked Trainee to forget everything): their words are not kept.
  remove?(userId: string): Promise<void>;
  active(): Promise<AlertRow[]>; // everyone with alerts on
  // WO-037: alerts per person whose delivery time is at or after `sinceIso` (the weekly cap's count). A store without it
  // sends no alerts (the run fails closed).
  alertsSince?(sinceIso: string): Promise<Map<string, number>>;
  // PROACTIVE SCENARIOS (2026-10-29): the keys of the alerts due at or after `sinceIso` (an alert is never due before it
  // was queued), by person, so alerts a run queued before dying (its counters never saved) count against the person's day
  // (career_proactive_run.ts runAlerts).
  alertKeysSince?(sinceIso: string): Promise<Map<string, Set<string>>>;
}
// first_seen_at (WO-037, alerts only): when Trainee first saw the posting, kept with the alert so the latency from
// first seen to delivered can be reported (career_alert_latency).
export interface Outbox {
  enqueue(userId: string, m: { key: string; kind: "alert" | "report" | "receipt" | "status" | "followup" | "brief" | "digest"; text: string; at: number; first_seen_at?: string }): Promise<boolean>; // false: that key was already queued or sent
  // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): one job alert, queued only if the person's settings as they are at that
  // moment still have room for it, with the count kept in the same step, one person at a time. Two runs at once that
  // read the boards at different moments each planned the person's whole day from the same counters and queued it: a cap
  // of 3 became 6. And a person who turned alerts off, asked for fewer or raised their fit floor while a run was going got
  // everything that run had planned. `day`: the person's local day (the run's); `weekSince`: the start of the rolling
  // week; `fit`: the alert's fit (null: none known). "queued", or why not: "duplicate" (that key was queued before),
  // "capped" (no room today or this week), "below_fit", "off" (alerts off, settings gone, or the account paused),
  // "unsupported" (the store cannot do it; the caller queues with enqueue and keeps the count itself).
  enqueueAlert?(userId: string, m: { key: string; text: string; at: number; first_seen_at?: string; fit: number | null }, c: { day: string; weekSince: string }): Promise<AlertQueued>;
}
export type AlertQueued = "queued" | "duplicate" | "capped" | "below_fit" | "off" | "unsupported";

// The person's words, checked: what the tools accept and what the table's constraint accepts are the same rules.
export function validPrefs(input: Record<string, unknown>, base: AlertPrefs = DEFAULT_PREFS): { ok: true; prefs: AlertPrefs } | { ok: false; error: string } {
  // A field left out keeps the alert's current value (an empty list clears it): "only 1 a day" never drops the place.
  const list = (v: unknown, name: string, kept: string[]): string[] | string => {
    if (v === undefined) return kept;
    if (!Array.isArray(v)) return `${name} must be a list`;
    const out = v.map((x) => String(x ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
    if (out.length > 10) return `at most 10 ${name}`;
    if (out.some((x) => x.length > 60)) return `each of the ${name} must be 60 characters or fewer`;
    return [...new Set(out.map((x) => x.toLowerCase()))];
  };
  const keywords = list(input.keywords, "keywords", base.keywords), locations = list(input.locations, "locations", base.locations);
  if (typeof keywords === "string") return { ok: false, error: keywords };
  if (typeof locations === "string") return { ok: false, error: locations };
  if (!keywords.length) return { ok: false, error: "say at least one kind of job to watch for (keywords)" };
  const hour = (v: unknown, d: number) => (v === undefined ? d : Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 23 ? (v as number) : NaN);
  const report_hour = hour(input.report_hour, base.report_hour);
  if (Number.isNaN(report_hour)) return { ok: false, error: "report_hour must be a whole hour from 0 to 23" };
  const quiet_start = hour(input.quiet_start, base.quiet_start), quiet_end = hour(input.quiet_end, base.quiet_end);
  if (Number.isNaN(quiet_start) || Number.isNaN(quiet_end)) return { ok: false, error: "quiet_start and quiet_end must be whole hours from 0 to 23" };
  const cap = input.max_instant_per_day === undefined ? base.max_instant_per_day : Number(input.max_instant_per_day);
  if (!Number.isInteger(cap) || cap < 0 || cap > MAX_INSTANT_PER_DAY) return { ok: false, error: `max_instant_per_day must be 0 to ${MAX_INSTANT_PER_DAY}` };
  const week = input.max_per_week === undefined ? base.max_per_week : Number(input.max_per_week);
  if (week !== undefined && (!Number.isInteger(week) || week < 0 || week > WEEKLY_MAX)) return { ok: false, error: `max_per_week must be 0 to ${WEEKLY_MAX}` };
  // F7: the lowest fit score the person wants alerted; null clears it, a field left out keeps the saved one.
  const minFit = input.min_fit === undefined ? base.min_fit : input.min_fit === null ? undefined : Number(input.min_fit);
  if (minFit !== undefined && (!Number.isInteger(minFit) || minFit < 0 || minFit > 100)) return { ok: false, error: "min_fit must be a whole number from 0 to 100" };
  if (input.remote_ok !== undefined && typeof input.remote_ok !== "boolean") return { ok: false, error: "remote_ok must be true or false" };
  // The relevance floor (C-04): only what the person stated; a floor not given keeps the one already saved.
  const fl = input.floor === undefined ? { ok: true as const, floor: base.floor } : validFloor(input.floor);
  if (!fl.ok) return { ok: false, error: fl.error };
  const floor = fl.floor && Object.keys(fl.floor).length ? fl.floor : undefined;
  // A new whole hour from a tool replaces the saved minute too (the minute belongs to the hour it was said with).
  const { min_fit: _was, ...kept } = base;
  if (input.report_hour !== undefined) delete (kept as Partial<AlertPrefs>).report_minute;
  return { ok: true, prefs: { ...kept, on: true, keywords, locations, remote_ok: input.remote_ok === undefined ? base.remote_ok : input.remote_ok as boolean, report_hour, quiet_start, quiet_end, max_instant_per_day: cap, floor, ...(week !== undefined ? { max_per_week: week } : {}), ...(minFit !== undefined ? { min_fit: minFit } : {}) } };
}
export function validZone(tz: unknown): string | null {
  if (typeof tz !== "string" || !tz || tz.length > 64) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
}

// Turning alerts on (or changing them) starts watching now: postings already on the boards are never alerted, and if
// today's report hour has passed, the first report is tomorrow's, not one sent minutes after the person asked.
export function startWatching(prev: AlertRow | null, o: { userId: string; prefs: AlertPrefs; tz: string; now: number }): AlertRow {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: o.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(o.now));
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "0";
  const today = `${g("year")}-${g("month")}-${g("day")}`, hour = Number(g("hour")) % 24, minute = Number(g("minute"));
  const past = hour * 60 + minute >= o.prefs.report_hour * 60 + (o.prefs.report_minute ?? 0);
  return { id: o.userId, tz: o.tz, prefs: o.prefs, last_checked_at: new Date(o.now).toISOString(),
    instant_sent_today: prev?.sent_on === today ? prev.instant_sent_today : 0, sent_on: today,
    last_report_on: past ? today : (prev?.last_report_on ?? null), held: prev?.held ?? [] };
}

// ------------------------------------------------------------------------------------------------ memory
export interface MemoryAlerts { rows: Record<string, AlertRow>; outbox: { userId: string; key: string; kind: string; text: string; at: number; first_seen_at?: string; fit?: number | null }[] }
export function memoryAlertStore(initial?: MemoryAlerts): AlertStore & Outbox & { dump(): MemoryAlerts } {
  const st: MemoryAlerts = initial ? JSON.parse(JSON.stringify(initial)) : { rows: {}, outbox: [] };
  return {
    async get(id) { return st.rows[id] ? JSON.parse(JSON.stringify(st.rows[id])) : null; },
    async save(row) { st.rows[row.id] = JSON.parse(JSON.stringify(row)); },
    async saveCounters(id, c, o) {
      if (!st.rows[id]) return;
      const { instant_sent_today, sent_on, ...rest } = JSON.parse(JSON.stringify(c));
      st.rows[id] = { ...st.rows[id], ...rest, ...(o?.counted ? {} : { instant_sent_today, sent_on }) };
    },
    // As career_alert_enqueue does it in the database (one person at a time): the settings as they are now decide. The
    // count is taken before anything can interleave and given back if the row is not written; the row is written through
    // this store's own enqueue (so a wrapper that fails it, fails this too).
    async enqueueAlert(this: Outbox, userId, m, c) {
      const row = st.rows[userId];
      if (!row || !row.prefs?.on) return "off";
      if (st.outbox.some((o) => o.userId === userId && o.key === m.key)) return "duplicate";
      if (typeof row.prefs.min_fit === "number" && !(typeof m.fit === "number" && m.fit >= row.prefs.min_fit)) return "below_fit";
      const today = row.sent_on === c.day ? Math.max(0, row.instant_sent_today | 0) : 0;
      if (today >= Math.min(MAX_INSTANT_PER_DAY, Math.floor(Number(row.prefs.max_instant_per_day) || 0))) return "capped";
      // No weekly count: owner rule "no caps"; career_alert_enqueue (20261030180000) dropped it. max_per_week is accepted and ignored.
      const was = { n: row.instant_sent_today, on: row.sent_on };
      row.instant_sent_today = today + 1;
      row.sent_on = c.day;
      let ok = false;
      try {
        ok = await this.enqueue(userId, { key: m.key, kind: "alert", text: m.text, at: m.at, ...(m.first_seen_at ? { first_seen_at: m.first_seen_at } : {}), ...(m.fit !== null ? { fit: m.fit } : {}) } as any);
      } finally {
        if (!ok) { row.instant_sent_today = was.n; row.sent_on = was.on; }
      }
      return ok ? "queued" : "duplicate";
    },
    async remove(id) { delete st.rows[id]; },
    async active() { return Object.values(st.rows).filter((r) => r.prefs.on).map((r) => JSON.parse(JSON.stringify(r))); },
    async alertsSince(since) {
      const t = Date.parse(since), out = new Map<string, number>();
      for (const o of st.outbox) if (o.kind === "alert" && o.at >= t) out.set(o.userId, (out.get(o.userId) ?? 0) + 1);
      return out;
    },
    // Memory rows keep no queue time; an alert's time is never before it was queued, so every alert due since counts.
    async alertKeysSince(since) {
      const t = Date.parse(since), out = new Map<string, Set<string>>();
      for (const o of st.outbox) if (o.kind === "alert" && o.at >= t) { if (!out.has(o.userId)) out.set(o.userId, new Set()); out.get(o.userId)!.add(o.key); }
      return out;
    },
    async enqueue(userId, m) {
      if (st.outbox.some((o) => o.userId === userId && o.key === m.key)) return false;
      st.outbox.push({ userId, ...m });
      return true;
    },
    dump() { return JSON.parse(JSON.stringify(st)); },
  };
}

// ------------------------------------------------------------------------------------------------ Supabase
const PAGE = 1000;
function must<T>(r: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}
const fromDb = (r: any): AlertRow => ({ id: r.user_id, tz: r.tz, prefs: r.prefs, last_checked_at: r.last_checked_at, instant_sent_today: r.instant_sent_today,
  sent_on: r.sent_on, last_report_on: r.last_report_on, held: r.held || [] });
const toDb = (r: AlertRow) => ({ user_id: r.id, tz: r.tz, prefs: r.prefs, last_checked_at: r.last_checked_at, instant_sent_today: r.instant_sent_today,
  sent_on: r.sent_on, last_report_on: r.last_report_on, held: (r.held || []).slice(0, 200), updated_at: new Date().toISOString() });

// deno-lint-ignore no-explicit-any
export function supabaseAlertStore(admin: any): AlertStore & Outbox {
  return {
    async get(id) { const r = must<any>(await admin.from("career_alert_prefs").select("*").eq("user_id", id).maybeSingle(), "read alert settings"); return r ? fromDb(r) : null; },
    async save(row) { must(await admin.from("career_alert_prefs").upsert(toDb(row), { onConflict: "user_id" }), "save alert settings"); },
    async remove(id) { must(await admin.from("career_alert_prefs").delete().eq("user_id", id), "remove alert settings"); },
    async saveCounters(id, c, o) {
      must(await admin.from("career_alert_prefs").update({ last_checked_at: c.last_checked_at, ...(o?.counted ? {} : { instant_sent_today: c.instant_sent_today, sent_on: c.sent_on }),
        last_report_on: c.last_report_on, held: (c.held || []).slice(0, 200), updated_at: new Date().toISOString() }).eq("user_id", id), "save alert counters");
    },
    // career_alert_enqueue (20261030070000_proactive_r2.sql): the person's row locked, their settings and counts read, the
    // alert inserted and counted, in one transaction. A project without that migration answers "unsupported".
    async enqueueAlert(userId, m, c) {
      const r = await admin.rpc("career_alert_enqueue", { p_user: userId, p_key: m.key, p_text: m.text, p_at: new Date(m.at).toISOString(),
        p_first_seen: m.first_seen_at ?? null, p_fit: typeof m.fit === "number" ? Math.round(m.fit) : null, p_day: c.day, p_week_since: c.weekSince });
      const said = `${(r.error as any)?.code ?? ""} ${r.error?.message ?? ""}`;
      if (r.error && /career_alert_enqueue|PGRST202/i.test(said) && /exist|find|no function|PGRST202/i.test(said)) return "unsupported";
      const v = String(must<any>(r, "queue an alert") ?? "");
      return (["queued", "duplicate", "capped", "below_fit", "off"].includes(v) ? v : "off") as AlertQueued;
    },
    async active() {
      const out: AlertRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const got = must<any[]>(await admin.from("career_alert_prefs").select("*").eq("prefs->>on", "true").order("user_id").range(from, from + PAGE - 1), "read alert settings") || [];
        out.push(...got.map(fromDb));
        if (got.length < PAGE) return out;
      }
    },
    // career_alerts_sent_since (20261021110000_career_board_state.sql): one row per person, counted in the database.
    async alertsSince(since) {
      const out = new Map<string, number>();
      for (const r of must<any[]>(await admin.rpc("career_alerts_sent_since", { p_since: since }), "count this week's alerts") || []) out.set(r.user_id, Number(r.n) || 0);
      return out;
    },
    async alertKeysSince(since) {
      const out = new Map<string, Set<string>>();
      for (let from = 0; ; from += PAGE) {
        const got = must<any[]>(await admin.from("career_outbox").select("user_id,key").eq("kind", "alert").gte("deliver_at", since).order("id").range(from, from + PAGE - 1), "read the alerts queued") || [];
        for (const r of got) { if (!out.has(r.user_id)) out.set(r.user_id, new Set()); out.get(r.user_id)!.add(String(r.key)); }
        if (got.length < PAGE) return out;
      }
    },
    async enqueue(userId, m) {
      const r = await admin.from("career_outbox").insert({ user_id: userId, key: m.key, kind: m.kind, text: m.text, deliver_at: new Date(m.at).toISOString(),
        ...(m.first_seen_at ? { posting_first_seen_at: m.first_seen_at } : {}) });
      if (r.error && (r.error.code === "23505" || /duplicate key/i.test(r.error.message))) return false; // queued or sent before: once per key, ever
      must(r, "queue an alert");
      return true;
    },
  };
}
