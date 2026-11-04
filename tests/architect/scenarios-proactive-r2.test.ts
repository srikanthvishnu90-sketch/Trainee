// Proactive briefs, job alerts, digests, interview briefs and follow-up nudges at scale, round 2 (2026-10-30): 10,000
// generated scenarios (tests/architect/scenarios/proactive-r2-generator.ts, seeded) through the real code of what Trainee
// sends without being asked, with a fixed clock, a fake model provider, a fake WhatsApp and memory stores. Round 1 is
// scenarios-proactive.test.ts; this round is its "not fixed" list and the categories it did not try. Every expectation
// comes from how the scenario was built:
//   overlap   runs at once that read the boards at different moments plan different postings: never more than the
//             person's day or week cap, each posting once, a full day's alerts when there are enough; a person who turns
//             alerts off or asks for fewer while the runs go gets nothing more, or no more than the new cap.
//   whatsapp  a channel connected days later gets no flood of stale alerts and reports (the rest still goes); a row held
//             by WhatsApp's window goes out whole when the person writes, however late; the waiting-updates template is
//             sent at most WHATSAPP_DAILY_TEMPLATES times a day across delivery runs at once, never to someone who said
//             STOP, once per silence.
//   content   an alert or report carries only a posting's visible words: no direction-override or control characters, no
//             markup, one line per field, never the pay; the same job on two boards is one alert; a posting closed before
//             the plan is never alerted, and one closed before delivery is not sent (an alert) or is said to be closed (a
//             line of the daily report).
//   interview a stated time is shown in the person's own zone with the zone named; no zone, or one the reader cannot pin
//             down, is said as such and never converted; a meeting password, PIN or portal login is never echoed; the
//             same invite twice is one brief; a reschedule is said with its new time, a cancellation is said, and neither
//             the moved-away date nor a cancelled interview gets a thank-you; an invite from a company the person never
//             applied to is not briefed; a brief is queued whole or not at all.
//   prefs     changes after queueing and before delivery: a pause, alerts off and STOP send nothing more; "fewer alerts"
//             holds the new cap that day; a higher fit floor holds; a new zone inside quiet hours waits for them to end;
//             a new home channel gets what is left.
//   budget    invites the rules are unsure of, read by the model behind a nearly spent budget: no request without a
//             reservation, a reply without usage counted at worst case, nothing left reserved; briefs queued whole.
// Run: deno test -A --no-check tests/architect/scenarios-proactive-r2.test.ts (no network, no database, no real model).
import assertNode from "node:assert/strict";
import {
  type BriefBudgetScenario, clock, type ContentScenario, COUNTS, DAY, firstAwake, generate, HOUR, type InterviewScenario, INVISIBLE, localTime, MARKUP, MIN,
  type OverlapScenario, type PrefsScenario, quietOn, type R2Person, type R2Posting, type R2Scenario, type WaRow, type WaScenario,
} from "./scenarios/proactive-r2-generator.ts";
import { type AlertRow, memoryAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { runAlerts, runInterviewDrafts, runMail } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { type ChannelStore, deliverDue, type DeliveryMark, type OutboxRow } from "../../supabase/functions/_shared/channel.ts";
import { type DeliveryAdapter, WHATSAPP_WINDOW_MS } from "../../supabase/functions/_shared/channel_adapters.ts";
import { alertStillWanted, alertWithinLimits } from "../../supabase/functions/_shared/career_watch_alerts.ts";
import { memoryMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { memoryBriefStores } from "../../supabase/functions/_shared/career_brief_store.ts";
import { mailModelWiring } from "../../supabase/functions/_shared/career_mail_model.ts";
import { type BudgetGate, memoryBudgetGate, resetLocalBudgetGate } from "../../supabase/functions/_shared/model_budget.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SCENARIOS = generate({ seed: 20261030 });
const of = <K extends R2Scenario["kind"]>(k: K) => SCENARIOS.filter((s): s is Extract<R2Scenario, { kind: K }> => s.kind === k);
const iso = (t: number) => new Date(t).toISOString();
const ms = (t: string) => Date.parse(t);
const quietLogs = async <T>(f: () => Promise<T>): Promise<T> => {
  const e = console.error;
  console.error = () => {};
  try { return await f(); } finally { console.error = e; }
};

// ------------------------------------------------------------------------------------------------ the report
type Failure = { why: string; got: unknown; input: unknown };
class Report {
  total = 0; byCat: Record<string, number> = {}; failures = new Map<string, Failure[]>();
  constructor(public name: string) {}
  grade(cat: string, why: string | null, got: unknown = "", input: unknown = "") {
    this.total++;
    this.byCat[cat] = (this.byCat[cat] ?? 0) + 1;
    if (!why) return;
    if (!this.failures.has(cat)) this.failures.set(cat, []);
    this.failures.get(cat)!.push({ why, got, input });
  }
  assertClean() {
    const failed = [...this.failures.values()].reduce((a, b) => a + b.length, 0);
    const lines = [`[proactive r2] ${this.name}: ${this.total} scenarios (${Object.entries(this.byCat).map(([k, v]) => `${k} ${v}`).join(", ")}), ${failed} failures`];
    for (const [k, xs] of [...this.failures.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 3)) lines.push(`    ${x.why} | got ${JSON.stringify(x.got).slice(0, 400)} | input ${JSON.stringify(x.input).slice(0, 300)}`);
    }
    console.log(lines.join("\n"));
    const first = [...this.failures.entries()].slice(0, 4).map(([k, xs]) => `${k} x${xs.length}: ${xs[0].why} | got ${JSON.stringify(xs[0].got).slice(0, 200)}`).join(" || ");
    eq(failed, 0, `${this.name}: ${failed} scenarios failed: ${first}`);
  }
}

// ------------------------------------------------------------------------------------------------ shared
const words = (s: string) => String(s ?? "").toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean);
const matchesKeyword = (title: string, keyword: string) => { const t = new Set(words(title)); return words(keyword).every((w) => t.has(w)); };
const asRow = (u: R2Person, now: number, o: { reportDue?: boolean } = {}): AlertRow => ({
  id: u.id, tz: u.tz, last_checked_at: iso(u.lastChecked), instant_sent_today: u.sentToday, sent_on: clock(now, u.tz).date,
  last_report_on: o.reportDue ? null : clock(now, u.tz).date, held: [],
  prefs: { on: true, keywords: [u.keyword], locations: [], remote_ok: true, report_hour: 0, quiet_start: u.qs, quiet_end: u.qe, max_instant_per_day: u.cap, max_per_week: u.week },
});
const postingRow = (p: R2Posting) => ({ job_id: p.job_id, provider: p.provider, title: p.title, company: p.company, location: p.location, url: p.url, first_seen_at: p.first_seen_at, posted_at: p.posted_at, closed_at: p.closed_at, pay: p.pay ?? null });

// A delivery database of the test's own, as the Supabase store behaves: rows claimed (two runs never share one), each
// person's home contact resolved at the claim, WhatsApp's window from the contact's last message, held rows marked and
// put back by the person's next message, STOP per person, the template budget counted per day, quiet hours read from the
// person's alert settings, a queued alert checked against what the person wants now.
type DbRow = OutboxRow & { kind: string; status: string; heldAt: number | null; sentAt: number | null; error: string | null; retryAt: number | null; fit?: number | null };
interface Person { userId: string; home: string; paused?: boolean; prefs?: any; tz?: string }
function deliveryDb(o: { people: Person[]; rows: (Omit<DbRow, "status" | "heldAt" | "sentAt" | "error" | "retryAt" | "attempts" | "contact"> & { contact?: string })[]; postings?: Map<string, any>; closedUrls?: Set<string>; withQuietHours?: boolean }) {
  const rows: DbRow[] = o.rows.map((r) => ({ attempts: 0, contact: "", status: "queued", heldAt: null, sentAt: null, error: null, retryAt: null, ...r }));
  const contacts = new Map<string, { userId: string; lastInboundAt: number | null; nudgedAt: number | null; optedOut: boolean; optedOutAt: number | null }>();
  for (const p of o.people) contacts.set(p.home, { userId: p.userId, lastInboundAt: null, nudgedAt: null, optedOut: false, optedOutAt: null });
  const people = new Map(o.people.map((p) => [p.userId, p]));
  const sends: { contact: string; text: string; at: number }[] = [], templates: { contact: string; at: number }[] = [];
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const claimedBy = new Map<string, string>();
  const store = (run: string, only?: (r: DbRow) => boolean): ChannelStore & { release(): void } => ({
    async due(now, limit) {
      await Promise.resolve();
      const got: OutboxRow[] = [];
      for (const r of rows.filter((x) => (x.status === "queued" || (x.status === "failed" && x.retryAt !== null && x.retryAt <= now)) && x.deliver_at <= now && (!only || only(x))).sort((a, b) => a.deliver_at - b.deliver_at)) {
        if (got.length >= limit) break;
        const home = people.get(r.userId)?.home;
        if (!home || !contacts.has(home)) continue; // no channel yet: stays queued (the dashboard lists it)
        r.status = "sending"; r.contact = home; claimedBy.set(r.id, run);
        const c = contacts.get(home)!;
        got.push({ id: r.id, userId: r.userId, contact: r.contact, key: r.key, text: r.text, deliver_at: r.deliver_at, attempts: r.attempts,
          ...(home.startsWith("wa:") ? { lastInboundAt: c.lastInboundAt, nudgedAt: c.nudgedAt } : {}), heldAt: r.heldAt } as OutboxRow);
      }
      return got;
    },
    async optedOut(c) { const u = contacts.get(c)?.userId; return [...contacts.values()].some((x) => x.userId === u && x.optedOut); },
    async optedOutAt(c) { const u = contacts.get(c)?.userId; const at = [...contacts.values()].filter((x) => x.userId === u && x.optedOut && x.optedOutAt !== null).map((x) => x.optedOutAt!); return at.length ? Math.max(...at) : null; },
    async quiet(u) { return !!people.get(u)?.paused; },
    async alertWanted(m: OutboxRow) {
      const p = people.get(m.userId);
      if (!p?.prefs) return true;
      const posting = m.key.startsWith("alert:") ? o.postings?.get(m.key.slice(6)) ?? null : null;
      return alertStillWanted(m.key, { row: { prefs: p.prefs }, record: null, posting });
    },
    // As the Supabase store reads it: the fit the alert was queued with, and the alerts delivered today on their clock.
    async alertWithinLimits(m: OutboxRow, now: number) {
      const p = people.get(m.userId), r = rows.find((x) => x.id === m.id)!;
      if (!p?.prefs) return true;
      const tz = p.tz ?? "America/New_York", today = clock(now, tz).date;
      const sentToday = rows.filter((x) => x.userId === m.userId && x.kind === "alert" && x.status === "delivered" && x.sentAt !== null && clock(x.sentAt, tz).date === today).length;
      return alertWithinLimits(p.prefs, r.fit ?? null, sentToday);
    },
    ...(o.closedUrls ? { async closedLinks(urls: string[]) { return new Set(urls.filter((u) => o.closedUrls!.has(u))); } } : {}),
    ...(o.withQuietHours ? { async quietHours(u: string) { const p = people.get(u); return p?.prefs ? { tz: p.tz ?? null, quiet_start: p.prefs.quiet_start, quiet_end: p.prefs.quiet_end } : null; } } : {}),
    async setOptOut(c, out, at) { const x = contacts.get(c); if (x) { x.optedOut = out; x.optedOutAt = out ? at : null; } },
    async contactsSentOn(d) { return new Set(rows.filter((x) => x.status === "delivered" && x.sentAt !== null && day(x.sentAt) === d).map((x) => x.contact)).size; },
    async sentTo(c, d) { return rows.some((x) => x.contact === c && x.status === "delivered" && x.sentAt !== null && day(x.sentAt) === d); },
    async mark(id, m: DeliveryMark) {
      const r = rows.find((x) => x.id === id);
      if (!r || r.status !== "sending") return;
      claimedBy.delete(id);
      r.status = m.status; r.error = m.error ?? null;
      if (m.status === "delivered") r.sentAt = m.at;
      if (m.status === "held") r.heldAt ??= m.at;
      if (m.status === "failed") { r.attempts++; r.retryAt = m.retryAt ?? null; }
      if ((m as any).status === "queued") r.deliver_at = (m as any).deliverAt ?? r.deliver_at;
    },
    async heldFor(u) { return rows.filter((x) => x.userId === u && x.status === "held").length; },
    async nudgesOn(d) { await Promise.resolve(); return [...contacts.values()].filter((c) => c.nudgedAt !== null && day(c.nudgedAt) === d).length; },
    async setNudged(c, at) { await Promise.resolve(); const x = contacts.get(c); if (x) x.nudgedAt = at; },
    // The database's own claim of a template slot: counted and recorded in one step, once per silence.
    async claimTemplate(c: string, d: string, cap: number, at: number) {
      const x = contacts.get(c);
      if (!x) return false;
      if (x.nudgedAt !== null && (x.lastInboundAt === null || x.nudgedAt >= x.lastInboundAt)) return false;
      const used = [...contacts.values()].filter((y) => y.nudgedAt !== null && day(y.nudgedAt) === d).length;
      if (used >= cap) return false;
      x.nudgedAt = at;
      return true;
    },
    release() { for (const r of rows) if (r.status === "sending" && claimedBy.get(r.id) === run) { r.status = "queued"; claimedBy.delete(r.id); } },
  } as ChannelStore & { release(): void });
  return {
    rows, contacts, sends, templates, store,
    connect(contact: string, userId: string, at: number | null) { contacts.set(contact, { userId, lastInboundAt: at, nudgedAt: null, optedOut: false, optedOutAt: null }); const p = people.get(userId); if (p) p.home = contact; },
    // A message from the person: the window opens, and what was held goes back in the queue (channel_inbound_seen).
    writes(contact: string, at: number) {
      const c = contacts.get(contact)!; c.lastInboundAt = at;
      for (const r of rows) if (r.userId === c.userId && r.status === "held") { r.status = "queued"; r.deliver_at = Math.min(r.deliver_at, at); r.error = null; }
    },
    adapter(channel: "imessage" | "whatsapp" | "telegram", o2: { cap?: number | null; template?: boolean; tick?: () => Promise<void> } = {}): DeliveryAdapter {
      return {
        channel, limits: channel === "whatsapp" ? { windowMs: WHATSAPP_WINDOW_MS, dailyTemplates: o2.cap ?? null } : {},
        render: (t) => [t],
        send: async (address, bubbles) => { sends.push({ contact: address, text: bubbles.join("\n"), at: (globalThis as any).__r2now ?? 0 }); return { ok: true, id: `p${sends.length}` }; },
        ...(channel === "whatsapp" ? { sendTemplate: async (address: string) => { if (o2.tick) await o2.tick(); if (!o2.template) return null; templates.push({ contact: address, at: 0 }); return { ok: true as const, id: `t${templates.length}` }; } } : {}),
      };
    },
  };
}
const withNow = async <T>(now: number, f: () => Promise<T>): Promise<T> => { (globalThis as any).__r2now = now; try { return await f(); } finally { delete (globalThis as any).__r2now; } };

// ------------------------------------------------------------------------------------------------ overlap
async function checkOverlap(s: OverlapScenario): Promise<{ why: string | null; got: unknown }> {
  const priorWeek = s.people.flatMap((u) => Array.from({ length: u.sentWeek }, (_, k) => ({ userId: u.id, key: `alert:greenhouse:old:${u.id}:${k}`, kind: "alert", text: "old", at: s.now - (2 + (k % 4)) * DAY })));
  const store = memoryAlertStore({ rows: Object.fromEntries(s.people.map((u) => [u.id, asRow(u, s.now)])), outbox: priorWeek });
  const before = new Set(store.dump().outbox.map((o) => `${o.userId}|${o.key}`));
  const all = [...s.base, ...s.runs.flatMap((r) => r.extra)];
  // Every run reads the people, then waits until every run has: the change (if any) lands, then they all plan and queue.
  let read = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const run = async (j: number) => {
    const world = [...s.base, ...s.runs.slice(0, j + 1).flatMap((r) => r.extra)];
    const st = { ...store, active: async () => { const a = await store.active(); if (++read === s.runs.length) { if (s.change) { const u = s.people[s.change.who]; const row = (await store.get(u.id))!; row.prefs = s.change.what === "alerts_off" ? { ...row.prefs, on: false } : { ...row.prefs, max_instant_per_day: s.change.to }; await store.save(row); } release(); } return a; } };
    try {
      await runAlerts({ store: st as any, outbox: store, now: s.now + s.runs[j].lag,
        recentPostings: async (since) => { await gate; return world.filter((p) => !p.closed_at && ms(p.first_seen_at) > ms(since)).map(postingRow); },
        postingsById: async (ids) => all.filter((p) => ids.includes(p.job_id)).map(postingRow) });
    } catch { /* a run's failure is recorded by the handler; the other runs carry on */ }
  };
  await Promise.all(s.runs.map((_, j) => run(j)));
  const fresh = store.dump().outbox.filter((o) => !before.has(`${o.userId}|${o.key}`) && o.kind === "alert");
  for (const [k, u] of s.people.entries()) {
    const mine = fresh.filter((o) => o.userId === u.id);
    const keys = mine.map((o) => o.key);
    if (new Set(keys).size !== keys.length) return { why: `${u.id}: a posting alerted twice`, got: keys };
    const eligible = all.filter((p) => matchesKeyword(p.title, u.keyword) && ms(p.first_seen_at) >= u.lastChecked).map((p) => `alert:${p.job_id}`);
    for (const key of keys) if (!eligible.includes(key)) return { why: `${u.id}: an alert for a posting that is not news to them`, got: key };
    const ch = s.change?.who === k ? s.change : null;
    const cap = ch?.what === "cap_down" ? ch.to : u.cap;
    const room = ch?.what === "alerts_off" ? 0 : Math.max(0, cap - u.sentToday);
    const want = Math.min(room, eligible.length);
    if (mine.length > room) return { why: `${u.id}: ${mine.length} alerts queued today; room for ${room} (cap ${cap}${ch ? ` after "${ch.what}"` : ""}, ${u.sentToday} already today; week ${u.week}, ${u.sentWeek} already) across ${s.runs.length} runs at once`, got: keys };
    if (!ch && mine.length < want) return { why: `${u.id}: ${mine.length} alerts, ${want} were due (room ${room}, ${eligible.length} news)`, got: keys };
  }
  return { why: null, got: null };
}
Deno.test(`proactive r2, runs at once on different postings (overlap): ${of("overlap").length} scenarios`, async () => {
  const rep = new Report("overlap");
  await quietLogs(async () => { for (const s of of("overlap")) { const r = await checkOverlap(s); rep.grade(s.category, r.why, r.got, { now: iso(s.now), people: s.people.map((u) => [u.cap, u.sentToday, u.week, u.sentWeek]), change: s.change }); } });
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ whatsapp
const STALE_MS = 48 * HOUR;
async function checkWhatsapp(s: WaScenario): Promise<{ why: string | null; got: unknown }> {
  if (s.category === "backlog") {
    const db = deliveryDb({ people: [{ userId: s.userId, home: "" }], rows: s.rows.map((r) => ({ ...r })) });
    db.connect(s.contact, s.userId, s.connectedAt);
    await withNow(s.now, () => deliverDue({ store: db.store("a"), adapters: { whatsapp: db.adapter("whatsapp", { cap: 250, template: true }) }, now: s.now, limit: 100 }));
    for (const r of s.rows) {
      const row = db.rows.find((x) => x.id === r.id)!;
      const stale = (r.kind === "alert" || r.kind === "report") && s.now - r.deliver_at > STALE_MS;
      const want = stale ? "skipped_opt_out" : "delivered";
      if (row.status !== want) return { why: `connected ${Math.round((s.now - s.connectedAt) / MIN)} min ago: a ${r.kind} ${Math.round((s.now - r.deliver_at) / HOUR)} h past its time is ${row.status}, must be ${want}`, got: { key: r.key, error: row.error } };
    }
    return { why: null, got: null };
  }
  if (s.category === "held") {
    const db = deliveryDb({ people: [{ userId: s.userId, home: s.contact }], rows: s.rows.map((r) => ({ ...r })) });
    db.connect(s.contact, s.userId, s.lastInbound);
    const adapters = { whatsapp: db.adapter("whatsapp", { cap: 250, template: true }) };
    await withNow(s.queuedAt + 10 * MIN, () => deliverDue({ store: db.store("a"), adapters, now: s.queuedAt + 10 * MIN, limit: 100 }));
    if (db.rows.some((r) => r.status !== "held")) return { why: "outside the 24-hour window a row was not held", got: db.rows.map((r) => r.status) };
    if (db.templates.length !== 1) return { why: `${db.templates.length} waiting-updates templates for one silence`, got: db.templates };
    db.writes(s.contact, s.writesAt);
    await withNow(s.now, () => deliverDue({ store: db.store("b"), adapters, now: s.now, limit: 100 }));
    for (const r of s.rows) {
      const row = db.rows.find((x) => x.id === r.id)!;
      if (row.status !== "delivered") return { why: `a row held by the window is ${row.status} after the person wrote (${Math.round((s.now - r.deliver_at) / DAY)} days later); it must go out whole`, got: { key: r.key, error: row.error } };
    }
    if (db.sends.length !== s.rows.length || s.rows.some((r) => !db.sends.some((x) => x.text === r.text))) return { why: "the held rows did not go out exactly once each, whole", got: db.sends.length };
    return { why: null, got: null };
  }
  // budget: many people held at once, across delivery runs at the same time
  const people = s.people.map((p) => ({ userId: p.userId, home: p.contact }));
  const rows = s.people.flatMap((p, k) => Array.from({ length: p.rows }, (_, j) => ({ id: `b${k}-${j}`, userId: p.userId, key: `receipt:app-${k}-${j}`, kind: "receipt", text: `Applied to Firm ${k}-${j}.`, deliver_at: s.now - (j + 1) * MIN })));
  const db = deliveryDb({ people, rows });
  for (const p of s.people) { db.connect(p.contact, p.userId, p.lastInbound); if (p.optedOut) await db.store("x").setOptOut(p.contact, true, s.now - DAY); }
  // Every run reaches the template step before any of them sends one (or has finished without one).
  let entered = 0, finished = 0;
  const waiters: (() => void)[] = [];
  const check = () => { if (entered + finished >= s.runs) while (waiters.length) waiters.shift()!(); };
  const seen = new Set<string>();
  const barrier = async (run: string) => { if (!seen.has(run)) { seen.add(run); entered++; check(); } if (entered + finished < s.runs) await new Promise<void>((r) => waiters.push(r)); };
  await withNow(s.now, () => Promise.all(Array.from({ length: s.runs }, async (_, k) => {
    // each run claims every person's j-th rows (a person with two rows is held in two runs at once)
    const run = `r${k}`, base = db.store(run, (r) => Number(r.id.slice(1).split("-")[1]) % s.runs === k);
    const st = { ...base, nudgesOn: async (d: string) => { await barrier(run); return base.nudgesOn!(d); }, claimTemplate: async (c: string, d: string, cap: number, at: number) => { await barrier(run); return (base as any).claimTemplate(c, d, cap, at); } };
    try { await deliverDue({ store: st as ChannelStore, adapters: { whatsapp: db.adapter("whatsapp", { cap: s.cap, template: s.template, tick: () => new Promise((r) => setTimeout(r, 0)) }) }, now: s.now, limit: 100 }); }
    finally { finished++; check(); }
  })));
  const eligible = s.people.filter((p) => !p.optedOut).length;
  const want = s.template ? Math.min(s.cap, eligible) : 0;
  const to = db.templates.map((t) => t.contact);
  if (to.length > s.cap) return { why: `${to.length} waiting-updates templates on a day budget of ${s.cap} (${s.runs} delivery runs at once)`, got: to.length };
  if (new Set(to).size !== to.length) return { why: "two templates to one person for one silence", got: to };
  if (to.some((c) => s.people.find((p) => p.contact.slice(3) === c.replace(/^wa:/, "") || p.contact === c)?.optedOut)) return { why: "a template to a person who said STOP", got: to };
  if (to.length !== want) return { why: `${to.length} templates; ${want} were due (budget ${s.cap}, ${eligible} people waiting)`, got: to.length };
  if (db.rows.some((r) => r.status === "delivered")) return { why: "a row went out free text outside the window", got: db.rows.filter((r) => r.status === "delivered").map((r) => r.key) };
  return { why: null, got: null };
}
Deno.test(`proactive r2, WhatsApp: backlog, held rows, the template budget (whatsapp): ${of("whatsapp").length} scenarios`, async () => {
  const rep = new Report("whatsapp");
  await quietLogs(async () => { for (const s of of("whatsapp")) { const r = await checkWhatsapp(s); rep.grade(s.category, r.why, r.got, s.category === "budget" ? { cap: s.cap, runs: s.runs, people: s.people.length } : { now: iso(s.now) }); } });
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ content
async function checkContent(s: ContentScenario): Promise<{ why: string | null; got: unknown }> {
  const u = s.person;
  const postings = s.postings.map((p) => ({ ...p, closed_at: s.closedBeforePlan.includes(p.job_id) ? iso(s.now - 30 * MIN) : null }));
  const store = memoryAlertStore({ rows: { [u.id]: asRow(u, s.now, { reportDue: true }) }, outbox: [] });
  await runAlerts({ store, outbox: store, now: s.now,
    recentPostings: async (since) => postings.filter((p) => !p.closed_at && ms(p.first_seen_at) > ms(since)).map(postingRow),
    postingsById: async (ids) => postings.filter((p) => ids.includes(p.job_id)).map(postingRow) });
  const out = store.dump().outbox;
  const alerts = out.filter((o) => o.kind === "alert"), report = out.find((o) => o.kind === "report");
  const byKey = new Map(postings.map((p) => [`alert:${p.job_id}`, p]));
  const groups = new Map<string, number>();
  for (const a of alerts) {
    const p = byKey.get(a.key);
    if (!p) return { why: "an alert for a posting not on the boards", got: a.key };
    if (p.closed_at) return { why: "an alert for a posting closed before the run", got: a.key };
    const [head, link, ...more] = a.text.split("\n");
    if (more.length || link !== p.url) return { why: `an alert is not one line and the posting's own link (${p.twist})`, got: a.text };
    if (INVISIBLE.test(head)) return { why: `an alert carries invisible direction or control characters (${p.twist})`, got: JSON.stringify(head) };
    if (MARKUP.test(head)) return { why: `an alert carries the posting's markup (${p.twist})`, got: head };
    if (head.length > 340) return { why: `an alert line of ${head.length} characters`, got: head.slice(0, 120) };
    if (p.pay && head.includes(p.pay)) return { why: "an alert states pay", got: head };
    if (/\$\s?\d/.test(head) && !/\$\s?\d/.test(p.title + p.company + p.location)) return { why: "an alert states a pay figure the posting's title does not", got: head };
    const first = words(p.title.replace(/<[^>]*>/g, " ").replace(/[​-‏‪-‮⁠-⁩﻿]/g, ""))[0];
    if (first && !words(head).includes(first)) return { why: `an alert does not say the posting's own title (${p.twist})`, got: head };
    const g = p.twinOf ?? p.job_id;
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }
  for (const [g, n] of groups) if (n > 1) return { why: `the same job on two boards (same company, title and place) was alerted ${n} times`, got: alerts.map((a) => a.key) };
  if (report) {
    if (INVISIBLE.test(report.text)) return { why: "the daily report carries invisible direction or control characters", got: JSON.stringify(report.text.slice(0, 300)) };
    if (MARKUP.test(report.text)) return { why: "the daily report carries the postings' markup", got: report.text.slice(0, 300) };
    for (const id of s.closedBeforePlan) { const p = postings.find((x) => x.job_id === id)!; if (report.text.includes(p.url)) return { why: "the daily report lists a posting closed before it was written", got: p.url }; }
  }
  // Closed between the plan and the delivery.
  const closed = new Set(s.closedAfterPlan);
  const now2 = s.now + 5 * MIN;
  const live = new Map(postings.map((p) => [p.job_id, postingRow({ ...p, closed_at: p.closed_at ?? (closed.has(p.job_id) ? iso(s.now + MIN) : null) })]));
  const closedUrls = new Set(postings.filter((p) => closed.has(p.job_id)).map((p) => p.url));
  const db = deliveryDb({ people: [{ userId: u.id, home: "+15550001111", prefs: asRow(u, s.now).prefs, tz: u.tz }], postings: live, closedUrls,
    rows: out.map((o, k) => ({ id: `c${k}`, userId: u.id, key: o.key, kind: o.kind, text: o.text, deliver_at: o.at })) });
  db.connect("+15550001111", u.id, null);
  await withNow(now2, () => deliverDue({ store: db.store("a"), adapters: { imessage: db.adapter("imessage") }, now: now2, limit: 100 }));
  for (const r of db.rows) {
    if (r.kind === "alert" && closed.has(r.key.slice(6)) && r.status === "delivered") return { why: "an alert for a posting that closed after it was queued went out", got: r.key };
    if (r.kind === "report" && r.status === "delivered") {
      const sent = db.sends.find((x) => x.text.startsWith("Your daily job report"))!.text;
      for (const url of closedUrls) {
        const lines = sent.split("\n"), i = lines.findIndex((l) => l.trim() === url);
        if (i > 0 && !/closed/i.test(lines[i - 1] + lines[i])) return { why: "the daily report lists a posting that closed after it was written without saying so", got: lines.slice(Math.max(0, i - 1), i + 1) };
      }
    }
  }
  return { why: null, got: null };
}
Deno.test(`proactive r2, adversarial postings (content): ${of("content").length} scenarios`, async () => {
  const rep = new Report("content");
  await quietLogs(async () => { for (const s of of("content")) { const r = await checkContent(s); rep.grade(s.category, r.why, r.got, { twists: s.postings.map((p) => p.twist) }); } });
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ interview
const AUTH = (d: string) => [`mx.google.com; dkim=pass header.i=@${d} header.s=s1; spf=pass smtp.mailfrom=${d}; dmarc=pass (p=REJECT) header.from=${d}`];
const shortDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
function zonedInstant(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number), [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const off = (at: number) => { const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at)); const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0); return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) - at; };
  const first = wall - off(wall);
  return wall - off(first);
}
async function checkInterview(s: InterviewScenario): Promise<{ why: string | null; got: unknown }> {
  const user = "iv-user", domain = `${s.company.toLowerCase()}.com`;
  const people = [{ user_id: user, read_through: iso(s.now - 2 * HOUR), tz: s.personTz }];
  const tracker: Record<string, any[]> = s.applied ? { [user]: [{ app_id: "a1", company: s.company, stage: "Submitted", applied_at: iso(s.now - 12 * DAY), events: [], role: s.role }] } : {};
  const mail = memoryMailStore({ people, tracker });
  const briefs = memoryBriefStores({ people: [{ user_id: user, tz: s.personTz }] });
  const box = memoryAlertStore();
  let faulted = false;
  const outbox = { enqueue: async (u: string, m: any) => { if (s.faultPart2 && !faulted && /^brief:.*:2$/.test(m.key)) { faulted = true; throw new Error("insert timed out"); } return box.enqueue(u, m); } };
  // An email read by the second run arrived after the first one.
  const mails = s.invites.map((v, k) => ({ hash: v.hash, from: `${s.company} Recruiting <recruiting@${domain}>`, subject: v.subject, snippet: v.body, date: iso(s.split !== null && k >= s.split ? s.now + (15 + k) * MIN : v.sent), auth: AUTH(domain) }));
  const runAt = async (now: number, upto: number) => {
    try {
      await runMail({ outbox, now, store: mail, briefs: briefs.interviews,
        read: async (_u, since) => { const m = mails.slice(0, upto).filter((x) => ms(x.date) >= since); return { status: "ok", mails: m, readThrough: now, listed: m.length }; } });
    } catch { /* recorded by the handler; the next run reads again */ }
  };
  if (s.split !== null) { await runAt(s.now, s.split); await runAt(s.now + 30 * MIN, mails.length); }
  else await runAt(s.now, mails.length);
  await runAt(s.now + 60 * MIN, mails.length); // the next scheduled run
  const texts = box.dump().outbox;
  const all = texts.map((t) => t.text).join("\n\n");
  for (const v of s.invites) for (const secret of v.secrets) if (all.includes(secret)) return { why: `a secret from the invite was echoed (${s.category})`, got: secret };
  if (!s.applied) return texts.length ? { why: "an invite from a company the person never applied to was told or briefed", got: texts.map((t) => t.key) } : { why: null, got: null };
  const parts = new Map<string, Set<string>>();
  for (const t of texts.filter((x) => x.kind === "brief")) { const [, h, n] = t.key.split(":"); if (!parts.has(h)) parts.set(h, new Set()); parts.get(h)!.add(n); }
  for (const [h, ns] of parts) if (ns.has("2") !== ns.has("1") || (ns.has("2") && !ns.has("1"))) return { why: `a brief half queued: ${[...ns].join(",")} of ${h.slice(0, 8)}${s.faultPart2 ? " (a queue write failed between its parts)" : ""}`, got: [...ns] };
  const full = [...parts.values()].filter((ns) => ns.has("2")).length;
  const first = texts.find((t) => /^brief:.*:1$/.test(t.key));
  const v0 = s.invites[0];
  if (s.category === "twice" && full !== 1) return { why: `the same invite twice: ${full} briefs`, got: [...parts.keys()] };
  if (["zone_stated", "zone_iana", "secrets", "twice", "reschedule", "cancel", "late_cancel"].includes(s.category)) {
    if (!first) return { why: "no brief for an invite with a stated date, time and zone", got: texts.map((t) => t.key) };
    const start = zonedInstant(v0.date!, v0.time!, v0.zone!);
    const want = localTime(start, s.personTz);
    if (!first.text.includes(want) || !first.text.includes(s.personTz)) return { why: `the brief does not show the time in the person's zone (${want}, ${s.personTz}); the invite said ${v0.time} ${v0.zone}`, got: first.text.split("\n")[1] };
  }
  if (["no_zone", "odd_abbrev", "all_day"].includes(s.category) && first) {
    if (/your time/i.test(first.text)) return { why: `the brief converts a time the invite gave no usable zone for (${s.category})`, got: first.text.split("\n")[1] };
    if (s.category === "odd_abbrev" && /no time zone stated/i.test(first.text)) return { why: "the invite named a zone (an abbreviation the reader cannot place) and the brief says none was stated", got: first.text.split("\n")[1] };
  }
  if (s.category === "language" && first) {
    const when = first.text.split("\n")[1] ?? "";
    if (/\b(AM|PM)\b/.test(when) && /your time/i.test(when)) return { why: "an invite in another language had a time converted that was never read", got: when };
  }
  if (s.category === "reschedule") {
    const v1 = s.invites[1];
    const start = zonedInstant(v1.date!, v1.time!, v1.zone!);
    const said = texts.filter((t) => t.kind === "brief" || t.kind === "status").map((t) => t.text).join("\n");
    if (!said.includes(localTime(start, s.personTz)) || !said.includes(localDateWords(start, s.personTz))) return { why: "the reschedule's new time was never said to the person, in their zone", got: texts.filter((t) => !/:2$/.test(t.key)).map((t) => [t.key, t.text.slice(0, 400)]) };
  }
  if (s.category === "cancel" || s.category === "late_cancel") {
    if (!texts.some((t) => /cancel/i.test(t.text))) return { why: "the cancellation was never said to the person", got: texts.map((t) => [t.key, t.text.slice(0, 100)]) };
  }
  // The thank-you and the nudge, after the interview: only for an interview that is still on, on its date.
  const dated = s.invites.filter((v) => v.date);
  const drafts = memoryAlertStore();
  for (const v of dated) {
    for (const at of [v.time && v.zone ? zonedInstant(v.date!, v.time, v.zone) + 3 * HOUR : zonedInstant(v.date!, "23:00", s.personTz) + 3 * HOUR, zonedInstant(v.date!, "12:00", s.personTz) + 8 * DAY]) {
      await runInterviewDrafts({ outbox: drafts, now: at, interviews: briefs.interviews, drafts: mail });
    }
  }
  const dk = drafts.dump().outbox.map((o) => o.key);
  const cancelled = s.category === "cancel" || s.category === "late_cancel";
  const moved = s.category === "reschedule" ? s.invites[0].date : null;
  for (const k of dk) {
    if (cancelled) return { why: "a thank-you or nudge drafted for a cancelled interview", got: dk };
    if (moved && k.endsWith(`:${moved}`) && s.invites[1].date !== moved) return { why: `a thank-you drafted for ${shortDay(moved)}, the date the interview was moved away from`, got: dk };
  }
  return { why: null, got: null };
}
const localDateWords = (at: number, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", day: "numeric" }).format(new Date(at));
Deno.test(`proactive r2, interview briefs and follow-ups (interview): ${of("interview").length} scenarios`, async () => {
  const rep = new Report("interview");
  await quietLogs(async () => { for (const s of of("interview")) { const r = await checkInterview(s); rep.grade(s.category, r.why, r.got, { tz: s.personTz, invites: s.invites.map((v) => v.body.slice(0, 160)) }); } });
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ prefs
async function checkPrefs(s: PrefsScenario): Promise<{ why: string | null; got: unknown }> {
  const userId = "pf-user";
  const prefs = { on: s.category !== "alerts_off", keywords: ["data analyst"], locations: [], remote_ok: true, report_hour: 8, quiet_start: s.qs, quiet_end: s.qe,
    max_instant_per_day: s.newCap ?? s.cap, ...(s.newMinFit !== null ? { min_fit: s.newMinFit } : s.minFit !== null ? { min_fit: s.minFit } : {}) };
  const tz = s.newTz ?? s.tz;
  const postings = new Map(s.rows.filter((r) => r.kind === "alert").map((r) => { const id = r.key.slice(6); return [id, { job_id: id, title: "Data Analyst", company: "Firm", location: "Remote", url: `https://boards.greenhouse.io/x/${id}`, first_seen_at: iso(s.now - 3 * HOUR), closed_at: null }]; }));
  const person: Person = { userId, home: s.homeFrom, paused: s.category === "pause", prefs, tz };
  const earlier = Array.from({ length: s.deliveredToday }, (_, k) => ({ id: `e${k}`, userId, key: `alert:greenhouse:earlier:${k}`, kind: "alert", text: "earlier", deliver_at: s.now - 30 * MIN }));
  const db = deliveryDb({ people: [person], postings, withQuietHours: true,
    rows: [...earlier, ...s.rows.map((r, k) => ({ id: `p${k}`, userId, key: r.key, kind: r.kind, text: `${r.kind} ${k}`, deliver_at: r.deliver_at, fit: r.fit }))] });
  db.connect(s.homeFrom, userId, null);
  for (const r of db.rows) if (r.id.startsWith("e")) { r.status = "delivered"; r.sentAt = s.now - 30 * MIN; r.contact = s.homeFrom; }
  // the earlier ones went out today on the person's clock
  if (s.deliveredToday && clock(s.now - 30 * MIN, tz).date !== clock(s.now, tz).date) for (const r of db.rows) if (r.id.startsWith("e")) r.sentAt = s.now;
  if (s.category === "stop") await db.store("x").setOptOut(s.homeFrom, true, s.now - MIN);
  if (s.homeTo) db.connect(s.homeTo, userId, null);
  const adapters = { imessage: db.adapter("imessage"), telegram: db.adapter("telegram") };
  await withNow(s.now, () => deliverDue({ store: db.store("a"), adapters, now: s.now, limit: 100 }));
  const mine = db.rows.filter((r) => r.id.startsWith("p"));
  const delivered = mine.filter((r) => r.status === "delivered");
  const alertsOut = delivered.filter((r) => r.kind === "alert");
  const quietNow = s.newTz !== null && quietOn(s.now, s.newTz, s.qs, s.qe);
  switch (s.category) {
    case "pause": case "stop":
      if (delivered.length) return { why: `${s.category}: ${delivered.length} rows went out`, got: delivered.map((r) => r.key) }; break;
    case "alerts_off":
      if (delivered.some((r) => r.kind !== "receipt")) return { why: "alerts off: an alert or report went out", got: delivered.map((r) => r.key) };
      if (delivered.length !== mine.filter((r) => r.kind === "receipt").length) return { why: "alerts off: a receipt was held back", got: mine.map((r) => [r.key, r.status]) }; break;
    case "fewer": {
      const room = Math.max(0, s.newCap! - s.deliveredToday);
      if (alertsOut.length > room) return { why: `"fewer alerts" (cap ${s.cap} to ${s.newCap}, ${s.deliveredToday} already today): ${alertsOut.length} alerts went out`, got: alertsOut.map((r) => r.key) };
      if (delivered.filter((r) => r.kind === "receipt").length !== mine.filter((r) => r.kind === "receipt").length) return { why: "fewer alerts held back a receipt", got: mine.map((r) => [r.key, r.status]) };
      break;
    }
    case "min_fit_up":
      for (const r of alertsOut) if (r.fit !== null && r.fit !== undefined && r.fit < s.newMinFit!) return { why: `an alert of fit ${r.fit} went out after the person raised their floor to ${s.newMinFit}`, got: r.key };
      break;
    case "tz_change":
      if (quietNow) {
        if (delivered.length) return { why: `the person moved to ${s.newTz}, where it is now inside their quiet hours ${s.qs}-${s.qe}; ${delivered.length} rows went out`, got: delivered.map((r) => r.key) };
        const at = firstAwake(s.now, s.newTz!, s.qs, s.qe);
        for (const r of mine) if (r.status !== "queued" || r.deliver_at < at || r.deliver_at >= at + 15 * MIN) return { why: `a row held for quiet hours on the new clock is ${r.status} at ${iso(r.deliver_at)}, not queued for ${iso(at)}`, got: r.key };
      }
      break;
    case "home_channel":
      for (const x of db.sends) if (x.contact !== s.homeTo!.replace(/^tg:/, "")) return { why: "a row went to the old home channel after the person moved", got: x.contact };
      if (delivered.length !== mine.length) return { why: "rows were held after a home channel change", got: mine.map((r) => [r.key, r.status]) };
      break;
    default:
      if (!quietNow && delivered.length !== mine.length) return { why: `${s.category}: rows held with nothing changed`, got: mine.map((r) => [r.key, r.status, r.error]) };
  }
  return { why: null, got: null };
}
Deno.test(`proactive r2, preference changes before delivery (prefs): ${of("prefs").length} scenarios`, async () => {
  const rep = new Report("prefs");
  await quietLogs(async () => { for (const s of of("prefs")) { const r = await checkPrefs(s); rep.grade(s.category, r.why, r.got, { now: iso(s.now), tz: s.tz, newTz: s.newTz, q: [s.qs, s.qe], cap: [s.cap, s.newCap], fit: [s.minFit, s.newMinFit] }); } });
  rep.assertClean();
});

// ------------------------------------------------------------------------------------------------ budget
const UNSURE = [
  ["Asana - next steps", "Hi Sam, thanks for your patience. The team would like to set up some time with you about the Account Manager role. Are you free on Thursday, November 12, 2026 at 2:00 PM ET?"],
  ["Asana - Account Manager", "Thanks for applying. If your background fits, we will reach out to schedule an interview for the Account Manager role."],
];
const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MODEL_BUDGET_PAUSED"];
async function briefRun(s: BriefBudgetScenario, gate: BudgetGate | null, request: typeof fetch) {
  const people = Array.from({ length: s.people }, (_, i) => ({ user_id: `bb${i}`, read_through: iso(s.now - HOUR), tz: "America/Chicago" }));
  const tracker = Object.fromEntries(people.map((p) => [p.user_id, [{ app_id: `a-${p.user_id}`, company: "Asana", stage: "Submitted", applied_at: iso(s.now - 10 * DAY), events: [], role: "Account Manager", url: "https://asana.com/jobs/1" }]]));
  const base = memoryMailStore({ people, tracker });
  const store = { ...base, claimModelCalls: async (_u: string, want: number) => want };
  const box = memoryAlertStore();
  const briefs = memoryBriefStores({ people: people.map((p) => ({ user_id: p.user_id, tz: p.tz })) });
  let faulted = 0;
  const outbox = { enqueue: async (u: string, m: any) => { if (s.faultPart2 && faulted < 1 && /^brief:.*:2$/.test(m.key)) { faulted++; throw new Error("insert timed out"); } return box.enqueue(u, m); } };
  const mails = (u: string) => UNSURE.slice(0, s.perPerson).map(([subject, snippet], i) => ({ hash: `${u}-${i}`.padEnd(64, "e").replace(/[^0-9a-f]/g, "f"), from: "Asana Recruiting <recruiting@asana.com>", subject, snippet, date: iso(s.now - (10 - i) * MIN), auth: AUTH("asana.com") }));
  const model = gate ? mailModelWiring({ get: (k: string) => (k === "ANTHROPIC_API_KEY" ? "sk-test-not-a-real-key" : undefined) }, { from: () => ({ insert: async () => ({ error: null }) }) }, request) : null;
  resetLocalBudgetGate(gate);
  try {
    for (const now of [s.now, s.now + 5 * MIN]) {
      try { await runMail({ outbox, now, store, briefs: briefs.interviews, read: async (u, since) => { const m = mails(u).filter((x) => ms(x.date) >= since); return { status: "ok", mails: m, readThrough: now, listed: m.length }; }, model }); } catch { /* the next run reads again */ }
    }
    return { texts: box.dump().outbox.map((o) => [o.userId, o.key, o.text] as [string, string, string]) };
  } finally { resetLocalBudgetGate(null); }
}
Deno.test(`proactive r2, the model reads invites within a reserved budget; briefs whole (budget): ${of("budget").length} scenarios`, async () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, Deno.env.get(k)]));
  for (const k of ENV_KEYS) Deno.env.delete(k);
  try {
    const rep = new Report("budget");
    let worst = 0;
    {
      const probe = memoryBudgetGate(10 ** 12);
      const g: BudgetGate = { reserve: async (m, meta) => { worst = Math.max(worst, m); return probe.reserve(m, meta); }, settle: probe.settle, release: probe.release };
      await quietLogs(() => briefRun({ kind: "budget", category: "probe", now: Date.parse("2026-11-03T15:00:00Z"), people: 1, perPerson: 2, limitCalls: 9, usage: "proven", faultPart2: false }, g, (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "interview", confidence: 0.95 }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))) as typeof fetch));
    }
    if (!(worst > 0)) throw new Error("the probe reserved nothing: no invite was asked about");
    await quietLogs(async () => {
      for (const s of of("budget")) {
        const limit = s.limitCalls * worst;
        const inner = memoryBudgetGate(Math.max(1, limit));
        const log: { id: string; micros: number; actual?: number | null; released?: boolean }[] = [];
        const gate: BudgetGate = {
          reserve: async (m, meta) => { const r = await inner.reserve(m, meta); if (r.ok) log.push({ id: r.id, micros: m }); return r; },
          settle: async (id, a) => { const x = log.find((y) => y.id === id); if (x) x.actual = a; return inner.settle(id, a); },
          release: async (id) => { const x = log.find((y) => y.id === id); if (x) x.released = true; return inner.release(id); },
        };
        let requests = 0, n = 0;
        const provider = (async () => {
          requests++;
          const usage = s.usage === "proven" || (s.usage === "mixed" && n++ % 2 === 0) ? { usage: { prompt_tokens: 400, completion_tokens: 30 } } : {};
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: "interview", confidence: 0.95 }) } }], ...usage }), { status: 200 });
        }) as typeof fetch;
        const got = await briefRun(s, gate, provider);
        const snap = inner.snapshot();
        let why: string | null = null;
        const parts = new Map<string, Set<string>>();
        for (const [u, k] of got.texts) if (k.startsWith("brief:")) { const [, h, p] = k.split(":"); const id = `${u}|${h}`; if (!parts.has(id)) parts.set(id, new Set()); parts.get(id)!.add(p); }
        if (requests !== log.length) why = `${requests} requests to the provider for ${log.length} reservations: a call went without its budget`;
        else if (snap.reserved !== 0) why = `${snap.reserved} micro-dollars left reserved after the runs`;
        else if (snap.spent > limit && limit > 0) why = `spent ${snap.spent} over the budget of ${limit}`;
        else if (snap.spent !== log.reduce((a, x) => a + (x.released ? 0 : x.actual ?? x.micros), 0)) why = "spent is not the proven costs plus the worst case of every call without usage";
        else if (s.usage === "missing" && log.some((x) => x.actual !== null && x.actual !== undefined)) why = "a reply with no usage was settled below its worst case";
        else if (s.limitCalls === 0 && requests !== 0) why = "the provider was asked with no budget at all";
        else if ([...parts.values()].some((ps) => ps.has("1") !== ps.has("2"))) why = `a brief half queued${s.faultPart2 ? " after a queue write failed between its parts" : ""}`;
        rep.grade(s.category, why, { requests, log: log.length, snap, limit, worst, parts: [...parts.entries()].map(([k, v]) => [k.slice(0, 12), [...v]]) });
      }
    });
    rep.assertClean();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
    resetLocalBudgetGate(null);
  }
});

Deno.test("the round 2 battery is 10,000 scenarios", () => {
  eq(SCENARIOS.length, Object.values(COUNTS).reduce((a, b) => a + b, 0));
  assertNode.ok(SCENARIOS.length >= 10000, `${SCENARIOS.length} scenarios`);
});
