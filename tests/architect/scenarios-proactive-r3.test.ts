// Proactive job alerts, daily reports, briefs and digests, round 3 (2026-11-01): about 10,000 generated scenarios (seed
// 20261101, this file's own generator) through the real code of what Trainee sends without being asked: the planner
// (career_alerts.ts planProactive), the scheduled alerts run (career_proactive_run.ts runAlerts over the memory alert store),
// delivery (channel.ts deliverDue over channel.ts's memory store, or channel_memory.ts's world of contacts and channels, with
// the delivery checks of career_watch_alerts.ts) and the weekly digest (career_digest.ts buildDigest). A fixed clock, no
// network, no model. Rounds 1 and 2 are scenarios-proactive.test.ts and scenarios-proactive-r2.test.ts; these are the
// categories they did not try. Every expectation comes from how the scenario was built, never from the product's code:
//   changed   a posting that changed between the alert's plan and its delivery (title, company, place, link; closed or
//             gone; quiet hours or a slow run in between): the alert says the posting as it is when it goes, with its age
//             then, or is not sent (with the reason); never the old words, never "first seen 3 min ago" nine hours on.
//   twins     the same job through other boards and aggregators ("Acme, Inc." for "Acme", "Austin, TX, United States",
//             the employer's own link behind an aggregator's), arriving in the same run, the next, or days later: one
//             alert per job; two openings on one board, and other jobs alike, are each still news.
//   channels  a person on two or three channels: each alert, report and digest goes once, on the home channel only; a
//             new home channel gets what is left; STOP on any of them holds everything, with the reason.
//   dst       quiet hours on the person's own clock across the US daylight-saving change (1 November 2026) and other
//             zones: nothing Trainee starts is planned or delivered inside them, and what waits goes at the first quarter
//             hour after; one daily report per local day across the 25-hour day.
//   search    the person changes their search (title, place, remote, their watch) after alerts and a report were queued:
//             nothing of the old search goes out; a report keeps only the lines that fit the new search and says how many.
//   people    paused, STOP, account deleted, no confirmed resume: what may go (answers to what they text after STOP; with
//             no resume, alerts are still news) and what may not; every row not sent records why.
//   burst     500 new postings at once: never more alerts in a local day than the person asked for, each posting at most
//             once, one report a day that counts what it lists, and a run that stays fast.
//   brief     an interview cancelled or moved after its brief was queued: the brief is not sent (with the reason); the
//             weekly digest never lists a cancelled interview, or the old time of a moved one, as coming up.
//   unicode   emoji, flags, skin tones, CJK, right-to-left letters, combining marks and very long names in alerts, reports
//             and digests: whole characters only (never half of one), a cut field says it was cut, the rest verbatim.
//   fit       the fit an alert is ranked by never shows in what is sent: no reason, no score (a reason can cite a fact the
//             person never confirmed; only the person's confirmed facts are scored, and none is said).
// Run: deno test -A --no-check tests/architect/scenarios-proactive-r3.test.ts (no network, no database, no real model).
import assertNode from "node:assert/strict";
import { chance, clock, DAY, firstAwake, HOUR, int, MIN, pick, quietOn, type R, rng } from "./scenarios/proactive-generator.ts";
import { type AlertFits, type AlertPrefs, planProactive } from "../../supabase/functions/_shared/career_alerts.ts";
import { type AlertRow, memoryAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { runAlerts } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { alertStillWanted, freshAlertText } from "../../supabase/functions/_shared/career_watch_alerts.ts";
import * as channel from "../../supabase/functions/_shared/channel.ts";
import { type ChannelStore, deliverDue, memoryChannel, type OutboxRow } from "../../supabase/functions/_shared/channel.ts";
import { memoryChannelWorld } from "../../supabase/functions/_shared/channel_memory.ts";
import { type Channel, channelOf, type DeliveryAdapter } from "../../supabase/functions/_shared/channel_adapters.ts";
import { buildDigest } from "../../supabase/functions/_shared/career_digest.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SEED = 20261101;
const iso = (t: number) => new Date(t).toISOString();
const quietLogs = async <T>(f: () => Promise<T>): Promise<T> => {
  const e = console.error;
  console.error = () => {};
  try { return await f(); } finally { console.error = e; }
};
// Sunday 1 November 2026, 15:00 UTC: 10:00 in New York, the first day of standard time.
const T0 = Date.parse("2026-11-01T15:00:00Z");
const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix", "America/Anchorage", "Pacific/Honolulu",
  "America/St_Johns", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Kathmandu", "Australia/Lord_Howe", "Pacific/Chatham", "UTC"];
const US_DST = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Anchorage", "America/St_Johns"];

// ------------------------------------------------------------------------------------------------ the report
type Failure = { why: string; input: unknown };
class Report {
  total = 0; byCat: Record<string, number> = {}; failures = new Map<string, Failure[]>();
  constructor(public name: string) {}
  grade(cat: string, why: string | null, input: unknown = "") {
    this.total++;
    this.byCat[cat] = (this.byCat[cat] ?? 0) + 1;
    if (!why) return;
    if (!this.failures.has(cat)) this.failures.set(cat, []);
    this.failures.get(cat)!.push({ why, input });
  }
  assertClean() {
    const failed = [...this.failures.values()].reduce((a, b) => a + b.length, 0);
    const lines = [`[proactive r3] ${this.name}: ${this.total} scenarios (${Object.entries(this.byCat).map(([k, v]) => `${k} ${v}`).join(", ")}), ${failed} failures`];
    for (const [k, xs] of [...this.failures.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 3)) lines.push(`    ${x.why} | input ${JSON.stringify(x.input).slice(0, Number(Deno.env.get("R3_INPUT") ?? 300))}`);
    }
    console.log(lines.join("\n"));
    const first = [...this.failures.entries()].slice(0, 4).map(([k, xs]) => `${k} x${xs.length}: ${xs[0].why}`).join(" || ");
    eq(failed, 0, `${this.name}: ${failed} scenarios failed: ${first}`);
  }
}
const TOTALS: Record<string, number> = {};

// ------------------------------------------------------------------------------------------------ the oracle's own words
// How an alert says its age (the rule WO-007 set: under a minute, minutes up to two hours, then hours).
const age = (mins: number) => (mins < 1 ? "under a minute ago" : mins < 120 ? `${mins} min ago` : `${Math.round(mins / 60)} hours ago`);
const said = (p: { title: string; company: string; location: string }) => `${p.title} at ${p.company}${p.location ? ` (${p.location})` : ""}`;
const alertWords = (p: Post, at: number) => `New match: ${said(p)}, first seen ${age(Math.floor((at - p.seen) / MIN))}.\n${p.url}`;
const wordsOf = (s: string) => s.toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean);
// The person's search, as WO-007 states it: every word of a keyword in the title; a remote posting only when remote is ok;
// another place only when it names one of theirs (or they named none).
interface Search { keywords: string[]; locations: string[]; remote_ok: boolean }
const fits = (p: Post, s: Search) => {
  const t = new Set(wordsOf(p.title));
  if (!s.keywords.some((k) => wordsOf(k).every((w) => t.has(w)))) return false;
  if (/^remote$/i.test(p.location)) return s.remote_ok;
  return !s.locations.length || s.locations.some((l) => p.location.toLowerCase().includes(l));
};
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// ------------------------------------------------------------------------------------------------ the world
interface Post { job_id: string; title: string; company: string; location: string; url: string; seen: number; closed?: number | null; gone?: boolean }
const row = (p: Post) => ({ job_id: p.job_id, title: p.title, company: p.company, location: p.location, url: p.url, first_seen_at: iso(p.seen), closed_at: p.closed ? iso(p.closed) : null });
const prefsOf = (s: Search, o: Partial<AlertPrefs> = {}): AlertPrefs => ({ on: true, keywords: s.keywords, locations: s.locations, remote_ok: s.remote_ok, report_hour: 8, quiet_start: 22, quiet_end: 7, max_instant_per_day: 10, ...o });
const person = (id: string, tz: string, prefs: AlertPrefs, now: number, o: Partial<AlertRow> = {}): AlertRow =>
  ({ id, tz, prefs, last_checked_at: iso(now - HOUR), instant_sent_today: 0, sent_on: null, last_report_on: clock(now, tz).date, held: [], ...o });
// One scheduled alerts run over the memory store and the boards as they are at `now`.
async function run(store: ReturnType<typeof memoryAlertStore>, posts: Post[], now: number, watches?: Map<string, unknown>) {
  const live = () => posts.filter((p) => !p.gone && p.seen <= now);
  return await quietLogs(() => runAlerts({ store, outbox: store, now,
    recentPostings: async (since) => live().filter((p) => p.seen >= Date.parse(since)).map(row),
    postingsById: async (ids) => live().filter((p) => ids.includes(p.job_id)).map(row),
    ...(watches ? { watches: async () => watches } : {}) }));
}
// Delivery over channel.ts's memory store with the checks a real store makes, read from the scenario's state now.
type Sent = { id: string; to: string; text: string; at: number };
function deliveryStore(rows: OutboxRow[], st: { prefs: () => AlertPrefs | null; tz: string; record?: () => unknown; posts: Post[]; interviews?: Map<string, { moved_at?: string | null; cancelled_at?: string | null }> }) {
  const mem = memoryChannel(rows);
  const byId = () => new Map(st.posts.filter((p) => !p.gone).map((p) => [p.job_id, row(p)]));
  const byUrl = () => new Map(st.posts.filter((p) => !p.gone).map((p) => [p.url, row(p)]));
  const now = () => ({ row: st.prefs() ? { prefs: st.prefs()! } : null, record: st.record?.() ?? null });
  const store: ChannelStore & ReturnType<typeof memoryChannel> = Object.assign(mem, {
    async alertWanted(m: OutboxRow) { return alertStillWanted(m.key, { ...now(), posting: byId().get(m.key.slice("alert:".length)) }); },
    async freshText(m: OutboxRow, at: number) { return freshAlertText(m.key, m.text, { ...now(), postings: m.key.startsWith("alert:") ? byId() : byUrl(), at }); },
    async closedLinks(urls: string[]) { return new Set(st.posts.filter((p) => !p.gone && p.closed && urls.includes(p.url)).map((p) => p.url)); },
    async quietHours() { const p = st.prefs(); return p ? { tz: st.tz, quiet_start: p.quiet_start, quiet_end: p.quiet_end } : null; },
    async briefWanted(m: OutboxRow) { return channel.briefStillTrue(m.key, st.interviews?.get(m.key.split(":")[1]) ?? null); },
  });
  return store;
}
async function deliverAll(store: ChannelStore & { rows(): any[] }, from: number, sent: Sent[], adapters?: Partial<Record<Channel, DeliveryAdapter>>, until = from + 3 * DAY) {
  let t = from;
  for (let i = 0; i < 8 && t <= until; i++) {
    const at = t;
    await quietLogs(() => deliverDue({ store, now: at, limit: 100, ...(adapters ? { adapters } : { send: async (to: string, b: string[]) => { sent.push({ id: "", to, text: b.join("\n"), at }); return { ok: true, id: `m${sent.length}` }; } }) }));
    const next = store.rows().filter((r) => r.status === "queued").map((r) => r.deliver_at).filter((x) => x > at);
    if (!next.length) break;
    t = Math.min(...next);
  }
}
const asRows = (dump: { outbox: { userId: string; key: string; text: string; at: number }[] }, contact: string): OutboxRow[] =>
  dump.outbox.map((o, i) => ({ id: String(i + 1), userId: o.userId, contact, key: o.key, text: o.text, deliver_at: o.at, attempts: 0 }));

// ------------------------------------------------------------------------------------------------ changed
const COMPANIES = ["Northwind", "Contoso", "Fabrikam", "Tailspin", "Woodgrove", "Litware", "Adatum", "Proseware", "Wingtip", "Lucerne"];
type Change = "none" | "title_kept" | "title_lost" | "company" | "place_kept" | "place_lost" | "link" | "closed" | "gone";
const CHANGES: Change[] = ["none", "title_kept", "title_lost", "company", "place_kept", "place_lost", "link", "closed", "gone"];
async function changedScenario(r: R, n: number): Promise<{ cat: string; why: string | null; input: unknown }> {
  const tz = pick(r, ZONES), qs = int(r, 0, 23), qe = int(r, 0, 23);
  const now = T0 + int(r, -36, 36) * HOUR + int(r, 0, 59) * MIN;
  const s: Search = { keywords: ["data analyst"], locations: chance(r, 0.5) ? ["new york"] : [], remote_ok: chance(r, 0.7) };
  const prefs = prefsOf(s, { quiet_start: qs, quiet_end: qe, report_hour: 23 });
  const store = memoryAlertStore({ rows: { u: person("u", tz, prefs, now, { last_report_on: clock(now, tz).date }) }, outbox: [] });
  const k = int(r, 1, 3);
  const posts: Post[] = Array.from({ length: k }, (_, i) => ({ job_id: `greenhouse:ch${n}:${i}`, title: pick(r, ["Data Analyst", "Analyst, Data", "Data Analyst II"]), company: pick(r, COMPANIES),
    location: s.locations.length ? "New York, NY" : pick(r, ["New York, NY", "Austin, TX", ...(s.remote_ok ? ["Remote"] : [])]), url: `https://boards.greenhouse.io/ch${n}/jobs/${i}`, seen: now - int(r, 1, 50) * MIN }));
  await run(store, posts, now);
  const queued = store.dump().outbox.filter((o) => o.kind === "alert");
  if (queued.length !== k) return { cat: "changed/plan", why: `${queued.length} alerts queued for ${k} matching postings`, input: { tz, qs, qe, posts } };
  const was = new Map(posts.map((p) => [p.job_id, { ...p }]));
  const change = new Map<string, Change>();
  for (const p of posts) {
    const c = pick(r, CHANGES.filter((x) => x !== "place_lost" || s.locations.length));
    change.set(p.job_id, c);
    if (c === "title_kept") p.title = pick(r, ["Senior Data Analyst", "Data Analyst (Contract)", "Lead Data Analyst"]);
    if (c === "title_lost") p.title = pick(r, ["Data Engineer", "Business Analyst", "Product Manager"]);
    if (c === "company") p.company = `${p.company} Labs`;
    if (c === "place_kept") p.location = s.locations.length ? "New York, NY (Hybrid)" : "Chicago, IL";
    if (c === "place_lost") p.location = "Austin, TX";
    if (c === "link") p.url = `${p.url}-v2`;
    if (c === "closed") p.closed = now + MIN;
    if (c === "gone") p.gone = true;
  }
  const delay = pick(r, [0, 0, int(r, 1, 59) * MIN, int(r, 1, 20) * HOUR]);
  const sent: Sent[] = [];
  const ds = deliveryStore(asRows(store.dump(), "+15550100001"), { prefs: () => prefs, tz, posts });
  await deliverAll(ds, Math.max(now + delay, Math.min(...queued.map((q) => q.at))), sent);
  const rows = ds.rows();
  for (const p of posts) {
    const c = change.get(p.job_id)!, old = was.get(p.job_id)!;
    const r0 = rows.find((x) => x.key === `alert:${p.job_id}`)!;
    const out = sent.filter((x) => x.text.includes(p.url) || x.text.includes(old.url));
    const goes = !p.gone && !p.closed && fits(p, s);
    if (!goes) {
      if (out.length) return { cat: `changed/${c}`, why: `the alert for ${p.job_id} went after its posting ${c === "gone" ? "went" : c === "closed" ? "closed" : "stopped fitting the search"}: ${out[0].text}`, input: { p, s } };
      if (r0.status !== "skipped_opt_out" || !r0.error) return { cat: `changed/${c}`, why: `the alert for ${p.job_id} was not sent but ${r0.status} with no reason (${r0.error})`, input: { p } };
      continue;
    }
    if (out.length !== 1) return { cat: `changed/${c}`, why: `the alert for ${p.job_id} went ${out.length} times (status ${r0.status}, ${r0.error})`, input: { p, s, tz, qs, qe, delay } };
    const want = alertWords(p, out[0].at);
    if (out[0].text !== want) return { cat: `changed/${c}`, why: `${JSON.stringify(out[0].text)} is not the posting as it is when it went: ${JSON.stringify(want)}`, input: { was: old, now: p, delay } };
    if (quietOn(out[0].at, tz, qs, qe)) return { cat: `changed/${c}`, why: `went at ${iso(out[0].at)}, inside quiet hours ${qs}-${qe} on ${tz}`, input: {} };
    if (r0.text !== out[0].text) return { cat: `changed/${c}`, why: `the outbox row says ${JSON.stringify(r0.text)}, not the words that went`, input: {} };
  }
  return { cat: `changed/${[...new Set(change.values())].sort().join("+").split("+")[0]}`, why: null, input: null };
}

// ------------------------------------------------------------------------------------------------ twins
const LEGAL = [" Inc.", ", Inc.", " Inc", ", LLC", " Corp.", " Corporation", ", Ltd."];
const COUNTRY = [", United States", ", USA", ", US", " (United States)"];
async function twinsScenario(r: R, n: number): Promise<{ cat: string; why: string | null; input: unknown }> {
  const tz = pick(r, ["America/New_York", "America/Chicago", "Europe/London"]);
  const s: Search = { keywords: ["ux designer"], locations: [], remote_ok: true };
  const start = T0 + int(r, -10, 10) * HOUR;
  const prefs = prefsOf(s, { quiet_start: 0, quiet_end: 0, report_hour: 23 });
  const store = memoryAlertStore({ rows: { u: person("u", tz, prefs, start, { last_checked_at: iso(start - 5 * MIN), last_report_on: "2099-01-01" }) }, outbox: [] });
  const posts: Post[] = [];
  const jobs: { name: string; ids: string[] }[] = [];
  const groups = int(r, 2, 5);
  const titles = ["UX Designer", "Senior UX Designer", "Lead UX Designer", "UX Designer II", "Staff UX Designer", "Principal UX Designer"];
  let kinds = "";
  for (let g = 0; g < groups; g++) {
    const company = pick(r, COMPANIES), title = titles[g], location = pick(r, ["Austin, TX", "New York, NY", "Chicago, IL", "Seattle, WA"]);
    const url = `https://boards.greenhouse.io/${company.toLowerCase()}/jobs/${n}${g}`;
    const t = start + int(r, 0, 3) * MIN;
    posts.push({ job_id: `greenhouse:${company.toLowerCase()}:${n}${g}`, title, company, location, url, seen: t });
    const job = { name: `${title} at ${company}`, ids: [posts.at(-1)!.job_id] };
    jobs.push(job);
    const copies = int(r, 1, 3);
    for (let c = 0; c < copies; c++) {
      const v = pick(r, ["legal", "country", "both", "link", "case"] as const);
      kinds += `${v} `;
      const later = pick(r, [int(r, 1, 4) * MIN, int(r, 10, 59) * MIN, int(r, 1, 30) * HOUR, int(r, 31, 66) * HOUR]);
      // An aggregator copies the employer's board after it (a minute to days later), each copy on a board of its own.
      const src = ["adzuna:feed", "lever:" + company.toLowerCase(), "themuse:jobs", "ashby:" + company.toLowerCase()][(c + g) % 4];
      posts.push({ job_id: `${src}:${n}${g}c${c}`, title: v === "case" ? title.toUpperCase() : title,
        company: v === "legal" || v === "both" ? `${company}${pick(r, LEGAL)}` : v === "link" ? `${company} Careers Portal` : v === "case" ? company.toLowerCase() : company,
        location: v === "country" || v === "both" ? `${location}${pick(r, COUNTRY)}` : v === "link" ? pick(r, ["Hybrid", "Multiple locations"]) : location,
        url: v === "link" ? `${url}?utm_source=${src.split(":")[0]}` : `https://${src.split(":")[0]}.example/jobs/${n}${g}${c}`, seen: t + later });
      job.ids.push(posts.at(-1)!.job_id);
    }
  }
  // Two openings alike on one board (two requisitions), and the same title at another firm: each its own job.
  if (chance(r, 0.6)) {
    const company = pick(r, COMPANIES), t = start + int(r, 0, 120) * MIN;
    for (const k of [1, 2]) { posts.push({ job_id: `greenhouse:twoopen:${n}-${k}`, title: "Product UX Designer", company, location: "Denver, CO", url: `https://boards.greenhouse.io/x/jobs/${n}0${k}`, seen: t }); jobs.push({ name: `opening ${k}`, ids: [posts.at(-1)!.job_id] }); }
  }
  if (chance(r, 0.5)) {
    posts.push({ job_id: `adzuna:feed:other${n}`, title: titles[0], company: "Someone Else Entirely", location: "Austin, TX", url: `https://adzuna.example/other/${n}`, seen: start + int(r, 0, 300) * MIN });
    jobs.push({ name: "same title, another firm", ids: [posts.at(-1)!.job_id] });
  }
  // A run a few minutes after each arrival (the 5-minute schedule, thinned to the runs that see something new).
  const times = [...new Set(posts.map((p) => p.seen + int(r, 1, 6) * MIN))].sort((a, b) => a - b);
  for (const t of times) await run(store, posts, t);
  const alerted = new Set(store.dump().outbox.filter((o) => o.kind === "alert").map((o) => o.key.slice("alert:".length)));
  for (const j of jobs) {
    const got = j.ids.filter((id) => alerted.has(id));
    if (got.length !== 1) return { cat: `twins/${got.length > 1 ? "twice" : "never"}`, why: `${j.name}: ${got.length} alerts (${got.join(", ")}) for one job`, input: { kinds, posts: posts.filter((p) => j.ids.includes(p.job_id)).map((p) => ({ ...p, seen: iso(p.seen) })) } };
  }
  return { cat: `twins/${groups}`, why: null, input: null };
}

// ------------------------------------------------------------------------------------------------ channels
function adapters(sent: Sent[], clockAt: () => number): Partial<Record<Channel, DeliveryAdapter>> {
  const make = (ch: Channel): DeliveryAdapter => ({ channel: ch, limits: ch === "whatsapp" ? { windowMs: 24 * HOUR } : {}, render: (t: string) => [t],
    send: async (to: string, b: string[]) => { sent.push({ id: "", to: `${ch === "imessage" ? "" : ch === "whatsapp" ? "wa:" : "tg:"}${to}`, text: b.join("\n"), at: clockAt() }); return { ok: true, id: `${ch}-${sent.length}` }; } });
  return { imessage: make("imessage"), whatsapp: make("whatsapp"), telegram: make("telegram") };
}
async function channelsScenario(r: R, n: number): Promise<{ cat: string; why: string | null; input: unknown }> {
  const w = memoryChannelWorld(), u = w.newUser(), now = T0 + int(r, 0, 12) * HOUR;
  const all = [`+1555020${String(n).padStart(4, "0")}`, `tg:${700000 + n}`, `wa:1555030${String(n).padStart(4, "0")}`];
  const mine = all.filter(() => chance(r, 0.7));
  if (mine.length < 2) mine.splice(0, mine.length, all[0], all[1]);
  const home = pick(r, mine);
  for (const c of mine) w.link(c, u, now - 10 * DAY, { home: c === home, lastInboundAt: now - int(r, 1, 300) * MIN });
  const kinds = ["alert", "report", "digest", "receipt", "status", "brief"];
  const k = int(r, 2, 8);
  for (let i = 0; i < k; i++) { const kind = pick(r, kinds); w.queue(u, { key: `${kind}:${n}-${i}${kind === "brief" ? ":1" : ""}`, kind, text: `${kind} ${i} for ${n}`, at: now - int(r, 0, 30) * MIN }); }
  const twist = pick(r, ["none", "none", "stop_other", "stop_home", "new_home"] as const);
  const sent: Sent[] = [];
  let t = now;
  const ad = adapters(sent, () => t);
  if (twist === "stop_other" || twist === "stop_home") { const c = twist === "stop_home" ? home : pick(r, mine.filter((x) => x !== home)); await w.inbound.setOptOut(c, true, now - MIN); }
  let newHome: string | null = null;
  const firstBatch = new Set<string>();
  if (twist === "new_home") {
    await quietLogs(() => deliverDue({ store: w.delivery(), adapters: ad, now: t, limit: Math.max(1, Math.floor(k / 2)) }));
    for (const o of w.outbox) if (o.userId === u && o.status === "delivered") firstBatch.add(o.id);
    newHome = pick(r, mine.filter((x) => x !== home));
    w.setHome(u, channelOf(newHome));
  }
  for (let i = 0; i < 4; i++) { t = now + i * MIN; await quietLogs(() => deliverDue({ store: w.delivery(), adapters: ad, now: t, limit: 100 })); }
  const rows = w.outbox.filter((o) => o.userId === u);
  if (twist.startsWith("stop")) {
    if (sent.length) return { cat: `channels/${twist}`, why: `${sent.length} sent after STOP on ${twist === "stop_home" ? "the home" : "another"} channel: ${sent[0].to}`, input: { mine, home } };
    const silent = rows.filter((o) => o.status !== "skipped_opt_out" || !o.error);
    if (silent.length) return { cat: `channels/${twist}`, why: `held by STOP without a reason recorded: ${silent.map((o) => `${o.key} ${o.status} ${o.error}`).join("; ")}`, input: { mine } };
    return { cat: `channels/${twist}`, why: null, input: null };
  }
  if (sent.length !== k) return { cat: `channels/${twist}`, why: `${sent.length} sends for ${k} rows`, input: { mine, home, rows: rows.map((o) => [o.key, o.status, o.contact]) } };
  for (const o of rows) {
    const went = sent.filter((x) => x.text === o.text);
    if (went.length !== 1) return { cat: `channels/${twist}`, why: `${o.key} went ${went.length} times`, input: { mine, home } };
    const want = newHome && !firstBatch.has(o.id) ? newHome : home;
    if (went[0].to !== want) return { cat: `channels/${twist}`, why: `${o.key} went to ${went[0].to}, not the home channel ${want}`, input: { mine, home, newHome } };
  }
  return { cat: `channels/${twist}`, why: null, input: null };
}

// ------------------------------------------------------------------------------------------------ dst
async function dstScenario(r: R, n: number): Promise<{ cat: string; why: string | null; input: unknown }> {
  const tz = chance(r, 0.7) ? pick(r, US_DST) : pick(r, ZONES), qs = int(r, 0, 23), qe = int(r, 0, 23);
  const now = Date.parse("2026-10-31T12:00:00Z") + int(r, 0, 60 * 48) * MIN;
  const s: Search = { keywords: ["nurse"], locations: [], remote_ok: true };
  const prefs = prefsOf(s, { quiet_start: qs, quiet_end: qe, report_hour: int(r, 0, 23) });
  const u: AlertRow = person("u", tz, prefs, now, { last_report_on: "2099-01-01" });
  const p: Post = { job_id: `greenhouse:dst:${n}`, title: "Registered Nurse", company: "Mercy", location: "Remote", url: `https://boards.greenhouse.io/dst/jobs/${n}`, seen: now - 2 * MIN };
  const plan = planProactive({ users: [u], postings: [row(p)], now });
  const a = plan.find((x) => x.kind === "alert") as { at: number } | undefined;
  if (!a) return { cat: "dst/plan", why: "no alert planned", input: { tz, qs, qe, now: iso(now) } };
  const want = quietOn(now, tz, qs, qe) ? firstAwake(now, tz, qs, qe) : now;
  if (a.at !== want) return { cat: `dst/plan${US_DST.includes(tz) ? "-us" : ""}`, why: `planned for ${iso(a.at)} (${clock(a.at, tz).hour}:${clock(a.at, tz).minute} on ${tz}); quiet ${qs}-${qe} says ${iso(want)}`, input: { now: iso(now) } };
  // Delivery: a row due at a random moment of the two days; inside quiet hours it waits for the first quarter hour after.
  const due = Date.parse("2026-10-31T12:00:00Z") + int(r, 0, 60 * 48) * MIN;
  const sent: Sent[] = [];
  const ds = deliveryStore([{ id: "1", userId: "u", contact: "+15550990000", key: `receipt:dst${n}`, text: "Applied to Mercy: submitted.", deliver_at: due, attempts: 0 }], { prefs: () => prefs, tz, posts: [] });
  await deliverAll(ds, due, sent);
  if (sent.length !== 1) return { cat: "dst/deliver", why: `${sent.length} sends`, input: { tz, qs, qe, due: iso(due) } };
  const wantAt = quietOn(due, tz, qs, qe) ? firstAwake(due + MIN, tz, qs, qe) : due;
  if (quietOn(sent[0].at, tz, qs, qe) || sent[0].at > wantAt + 15 * MIN || sent[0].at < due)
    return { cat: `dst/deliver${US_DST.includes(tz) ? "-us" : ""}`, why: `went at ${iso(sent[0].at)}; due ${iso(due)} with quiet ${qs}-${qe} on ${tz}: the first time awake is ${iso(wantAt)}`, input: {} };
  return { cat: `dst/${US_DST.includes(tz) ? "us" : "other"}`, why: null, input: null };
}
// One report a local day across the 25-hour day, at or after the person's hour, never inside quiet hours.
async function dstDaysScenario(r: R, n: number): Promise<{ cat: string; why: string | null; input: unknown }> {
  const tz = pick(r, US_DST), qs = int(r, 0, 23), qe = int(r, 0, 23), hour = int(r, 0, 23);
  const from = Date.parse("2026-10-31T00:00:00Z");
  const s: Search = { keywords: ["welder"], locations: [], remote_ok: true };
  const prefs = prefsOf(s, { quiet_start: qs, quiet_end: qe, report_hour: hour });
  const store = memoryAlertStore({ rows: { u: person("u", tz, prefs, from, { last_report_on: null }) }, outbox: [] });
  const step = 30 * MIN;
  for (let t = from + int(r, 0, 29) * MIN; t < from + 3 * DAY; t += step) await run(store, [], t);
  const reports = store.dump().outbox.filter((o) => o.kind === "report");
  const days = reports.map((o) => o.key.slice("report:".length));
  if (new Set(days).size !== days.length) return { cat: "dst/days", why: `two reports on one local day: ${days}`, input: { tz } };
  for (const o of reports) {
    if (quietOn(o.at, tz, qs, qe)) return { cat: "dst/days", why: `the report for ${o.key} goes at ${iso(o.at)}, inside quiet hours ${qs}-${qe} on ${tz}`, input: {} };
  }
  // Every full local day the runs covered, from the first that started after the first run, has its report.
  for (const d of ["2026-11-01"]) if (!days.includes(d)) return { cat: "dst/days", why: `no report on ${d} (report hour ${hour}, ${tz}): ${days}`, input: {} };
  return { cat: "dst/days", why: null, input: null };
}

// ------------------------------------------------------------------------------------------------ search
async function searchScenario(r: R, n: number): Promise<{ cat: string; why: string | null; input: unknown }> {
  const tz = pick(r, ZONES), now = T0 + int(r, -20, 20) * HOUR;
  const before: Search = { keywords: ["data analyst"], locations: chance(r, 0.4) ? ["new york"] : [], remote_ok: chance(r, 0.8) };
  const viaWatch = chance(r, 0.4);
  const watch = (s: Search) => ({ type: "career_watch_profile", interests: [{ role: { terms: s.keywords, blockers: [] }, filters: { locations: s.locations, remote_ok: s.remote_ok } }] });
  let record: unknown = watch(before);
  let prefs = prefsOf(before, { quiet_start: 0, quiet_end: 0, report_hour: 0, max_instant_per_day: int(r, 1, 6), ...(viaWatch ? { interests: [{ keywords: before.keywords, locations: before.locations, remote_ok: before.remote_ok }] } : {}) });
  const store = memoryAlertStore({ rows: { u: person("u", tz, prefs, now, { last_report_on: null }) }, outbox: [] });
  const titles = ["Data Analyst", "Senior Data Analyst", "Data Analyst, Product", "Product Analyst"];
  const places = ["New York, NY", "Chicago, IL", "Remote", "Austin, TX"];
  const posts: Post[] = Array.from({ length: int(r, 2, 9) }, (_, i) => ({ job_id: `greenhouse:se${n}:${i}`, title: pick(r, titles), company: `${pick(r, COMPANIES)} ${i}`, location: pick(r, places),
    url: `https://boards.greenhouse.io/se${n}/jobs/${i}`, seen: now - int(r, 1, 55) * MIN }));
  await run(store, posts, now, viaWatch ? new Map([["u", record]]) : undefined);
  const out = store.dump().outbox;
  const change = pick(r, ["none", "title", "place", "remote_off", "remote_only", "both"] as const);
  const after: Search = { ...before, keywords: change === "title" || change === "both" ? ["product analyst"] : before.keywords,
    locations: change === "place" || change === "both" ? ["chicago"] : change === "remote_only" ? ["remote only"] : before.locations,
    remote_ok: change === "remote_off" ? false : change === "remote_only" ? true : before.remote_ok };
  if (viaWatch) record = watch(after); // the watch record is the truth; the settings' copy may lag behind it
  else prefs = { ...prefs, keywords: after.keywords, locations: after.locations, remote_ok: after.remote_ok };
  const sent: Sent[] = [];
  const ds = deliveryStore(asRows({ outbox: out }, "+15550200000"), { prefs: () => prefs, tz, record: () => record, posts });
  await deliverAll(ds, now + int(r, 0, 120) * MIN, sent);
  const rows = ds.rows();
  for (const o of rows) {
    const went = sent.filter((x) => x.text.startsWith(o.key.startsWith("alert:") ? "New match" : "Your daily job report") && (o.key.startsWith("report:") || x.text.includes(posts.find((p) => `alert:${p.job_id}` === o.key)!.url)));
    if (o.key.startsWith("alert:")) {
      const p = posts.find((x) => `alert:${x.job_id}` === o.key)!;
      if (fits(p, after) !== (went.length === 1)) return { cat: `search/${change}${viaWatch ? "-watch" : ""}`, why: `the alert for "${p.title}" in ${p.location} ${went.length ? "went" : "did not go"}; under the new search ${JSON.stringify(after)} it ${fits(p, after) ? "fits" : "does not fit"}`, input: { before } };
      if (!went.length && !o.error) return { cat: `search/${change}`, why: `${o.key} not sent with no reason`, input: {} };
      continue;
    }
    const listed = posts.filter((p) => o.text.includes(p.url));
    const keep = listed.filter((p) => fits(p, after));
    if (!listed.length) { if (went.length !== 1) return { cat: "search/report-empty", why: "the no-matches report did not go", input: {} }; continue; }
    if (!keep.length) {
      if (went.length) return { cat: `search/${change}${viaWatch ? "-watch" : ""}`, why: `a report of the old search went: ${went[0].text}`, input: { after } };
      if (!o.error) return { cat: "search/report", why: "the report was held with no reason", input: {} };
      continue;
    }
    if (went.length !== 1) return { cat: `search/${change}`, why: `the report went ${went.length} times (${o.status} ${o.error})`, input: {} };
    const text = went[0].text;
    for (const p of listed) if (text.includes(p.url) !== fits(p, after)) return { cat: `search/${change}${viaWatch ? "-watch" : ""}`, why: `the report ${text.includes(p.url) ? "lists" : "drops"} "${p.title}" in ${p.location}, which ${fits(p, after) ? "fits" : "does not fit"} the new search: ${text}`, input: { after } };
    const head = /^Your daily job report: (\d+) match/.exec(text);
    const lines = text.split("\n").filter((l) => l.startsWith("- ")).length;
    if (!head || (keep.length < listed.length && Number(head[1]) !== lines)) return { cat: `search/${change}`, why: `the report says ${head?.[1]} matches and lists ${lines}: ${text}`, input: {} };
  }
  return { cat: `search/${change}${viaWatch ? "-watch" : ""}`, why: null, input: null };
}

// ------------------------------------------------------------------------------------------------ people
async function peopleScenario(r: R, n: number): Promise<{ cat: string; why: string | null; input: unknown }> {
  const w = memoryChannelWorld(), u = w.newUser(), now = T0 + int(r, 0, 6) * HOUR;
  const c = chance(r, 0.5) ? `+1555040${String(n).padStart(4, "0")}` : `tg:${800000 + n}`;
  w.link(c, u, now - 5 * DAY, { home: true, lastInboundAt: now - HOUR });
  const state = pick(r, ["active", "paused", "stop", "deleted", "no_resume", "stop_then_text"] as const);
  const kinds = ["alert", "report", "digest", "receipt", "status", "brief", "followup"];
  const k = int(r, 1, 6);
  for (let i = 0; i < k; i++) { const kind = pick(r, kinds); w.queue(u, { key: `${kind}:${n}-${i}`, kind, text: `${kind} ${i} for ${n}`, at: now - int(r, 0, 20) * MIN }); }
  const stopAt = now - 30 * MIN;
  if (state === "paused") w.paused.add(u);
  if (state === "stop" || state === "stop_then_text") await w.inbound.setOptOut(c, true, stopAt);
  if (state === "stop_then_text") await w.inbound.enqueueReply(u, `reply:${n}`, "Here is what you asked for.", stopAt + 10 * MIN);
  if (state === "deleted") w.deleteUser(u);
  const sent: Sent[] = [];
  let t = now;
  const ad = adapters(sent, () => t);
  for (let i = 0; i < 3; i++) { t = now + i * MIN; await quietLogs(() => deliverDue({ store: w.delivery(), adapters: ad, now: t, limit: 100 })); }
  const rows = w.outbox.filter((o) => o.userId === u);
  const started = sent.filter((x) => !x.text.startsWith("Here is what"));
  if ((state === "paused" || state.startsWith("stop") || state === "deleted") && started.length)
    return { cat: `people/${state}`, why: `${started.length} sent on Trainee's own to a ${state} person: ${started[0].text}`, input: {} };
  if (state === "stop_then_text" && sent.filter((x) => x.text.startsWith("Here is what")).length !== 1) return { cat: `people/${state}`, why: "the answer to what they texted after STOP did not go once", input: {} };
  if ((state === "active" || state === "no_resume") && sent.length !== k) return { cat: `people/${state}`, why: `${sent.length} of ${k} sent`, input: rows.map((o) => [o.key, o.status, o.error]) };
  const silent = rows.filter((o) => (o.status === "skipped_opt_out" || o.status === "failed") && !o.error);
  if (silent.length) return { cat: `people/${state}`, why: `not sent with no reason recorded: ${silent.map((o) => `${o.key} ${o.status}`).join(", ")}`, input: {} };
  if (state === "deleted" && rows.length) return { cat: "people/deleted", why: "rows outlived the account", input: {} };
  return { cat: `people/${state}`, why: null, input: null };
}

// ------------------------------------------------------------------------------------------------ burst
async function burstScenario(r: R, n: number): Promise<{ cat: string; why: string | null; input: unknown }> {
  const tz = pick(r, ZONES), cap = int(r, 0, 10), rate = pick(r, [0.05, 0.3, 1]);
  const t0 = Date.parse("2026-11-02T00:00:00Z") + int(r, 0, 23) * HOUR;
  const s: Search = { keywords: ["software engineer"], locations: [], remote_ok: true };
  const prefs = prefsOf(s, { quiet_start: 0, quiet_end: 0, report_hour: int(r, 0, 23), max_instant_per_day: cap });
  const store = memoryAlertStore({ rows: { u: person("u", tz, prefs, t0, { last_checked_at: iso(t0 - 5 * MIN), last_report_on: null }) }, outbox: [] });
  const drop = t0 + int(r, 1, 60) * MIN;
  const posts: Post[] = Array.from({ length: 500 }, (_, i) => ({ job_id: `greenhouse:burst${n}:${i}`, title: r() < rate ? pick(r, ["Software Engineer", "Senior Software Engineer", "Software Engineer II"]) : "Account Manager",
    company: `Co ${i}`, location: "Remote", url: `https://boards.greenhouse.io/b${n}/jobs/${i}`, seen: drop + (i % 7) * 1000 }));
  const matching = posts.filter((p) => fits(p, s));
  let slow = 0;
  for (let t = t0; t < t0 + 30 * HOUR; t += 30 * MIN) { const a = performance.now(); await run(store, posts, t); slow = Math.max(slow, performance.now() - a); }
  const out = store.dump().outbox;
  const alerts = out.filter((o) => o.kind === "alert");
  if (new Set(alerts.map((o) => o.key)).size !== alerts.length) return { cat: "burst", why: "a posting alerted twice", input: {} };
  const byDay = new Map<string, number>();
  for (const o of alerts) byDay.set(clock(o.at, tz).date, (byDay.get(clock(o.at, tz).date) ?? 0) + 1);
  for (const [d, k] of byDay) if (k > cap) return { cat: `burst/${rate}`, why: `${k} alerts on ${d} for a cap of ${cap}`, input: { tz } };
  if (alerts.length !== Math.min(cap, matching.length)) return { cat: `burst/${rate}`, why: `${alerts.length} alerts for ${matching.length} matches and a cap of ${cap} (the burst's day must be full)`, input: { tz } };
  for (const o of out.filter((x) => x.kind === "report")) {
    const lines = o.text.split("\n").filter((l) => l.startsWith("- ")).length;
    if (lines > 10) return { cat: "burst/report", why: `a report of ${lines} lines`, input: {} };
    const head = /^Your daily job report: (\d+) match/.exec(o.text);
    if (head && Number(head[1]) < lines) return { cat: "burst/report", why: `says ${head[1]} and lists ${lines}`, input: {} };
    for (const p of posts) if (o.text.includes(`${p.url}\n`) || o.text.endsWith(p.url)) if (!fits(p, s)) return { cat: "burst/report", why: `lists ${p.title}`, input: {} };
  }
  if (slow > 5000) return { cat: "burst/pace", why: `a run took ${Math.round(slow)} ms over 500 postings`, input: {} };
  return { cat: `burst/${rate}`, why: null, input: null };
}

// ------------------------------------------------------------------------------------------------ brief
async function briefScenario(r: R, n: number): Promise<{ cat: string; why: string | null; input: unknown }> {
  const tz = pick(r, ZONES), now = T0 + int(r, 0, 48) * HOUR;
  const k = int(r, 1, 5);
  const ivs = Array.from({ length: k }, (_, i) => {
    const fate = pick(r, ["on", "on", "cancelled", "moved"] as const);
    const date = new Date(now + int(r, 1, 10) * DAY).toISOString().slice(0, 10);
    return { fate, row: { key: `${String(n).padStart(8, "0")}${i}`.padEnd(64, "a"), source: "mail" as const, ref: null, company: `Interviewer ${n}-${i} Corp`, role: "Data Analyst", when_said: [], date, time: "14:00", zone: null,
      starts_at: null, format: null, interviewers: [], mail_at: iso(now - DAY), seen_at: iso(now - DAY), brief_at: iso(now - DAY), brief_ms: 1000,
      moved_at: fate === "moved" ? iso(now - HOUR) : null, cancelled_at: fate === "cancelled" ? iso(now - HOUR) : null } };
  });
  const d = buildDigest({ queue: [], tracker: [], mail: [], interviews: ivs.map((x) => x.row) as any, drafts: [], alerts: [{ created_at: iso(now - HOUR) }], events: [] }, { now, tz });
  const text = d?.text ?? "";
  for (const x of ivs) if (text.includes(x.row.company) !== (x.fate === "on")) return { cat: `brief/digest-${x.fate}`, why: `the digest ${text.includes(x.row.company) ? "lists" : "leaves out"} a ${x.fate} interview as coming up: ${text}`, input: {} };
  // The briefs queued before the later email: the ones whose interview moved or was cancelled since do not go.
  const rows: OutboxRow[] = ivs.flatMap((x, i) => [1, 2].map((p) => ({ id: `${i}-${p}`, userId: "u", contact: "+15550300000", key: `brief:${x.row.key}:${p}`, text: `Brief ${i} part ${p}: ${x.row.company}`, deliver_at: now - MIN, attempts: 0 })));
  const sent: Sent[] = [];
  const ds = deliveryStore(rows, { prefs: () => null, tz, posts: [], interviews: new Map(ivs.map((x) => [x.row.key, x.row])) });
  await deliverAll(ds, now, sent);
  for (const x of ivs) {
    const went = sent.filter((s) => s.text.includes(x.row.company)).length;
    if ((x.fate === "on") !== (went === 2)) return { cat: `brief/${x.fate}`, why: `${went} brief parts went for a ${x.fate} interview`, input: {} };
    const held = ds.rows().filter((o) => o.key.includes(x.row.key) && o.status !== "delivered");
    if (held.some((o) => !o.error)) return { cat: `brief/${x.fate}`, why: "a brief held with no reason", input: {} };
  }
  return { cat: `brief/${ivs.map((x) => x.fate).includes("cancelled") ? "cancelled" : ivs.map((x) => x.fate).includes("moved") ? "moved" : "on"}`, why: null, input: null };
}

// ------------------------------------------------------------------------------------------------ unicode
const PIECES = ["🦄", "🚀", "👍🏽", "🇺🇸", "🇯🇵", "é", "é", "ñ", "日本語", "株式会社", "데이터", "مرحبا", "שלום", "Ω", "ﬁ", "𝔘𝔫𝔦", "😀😃", "ไทย", "हिन्दी", "Ğ", " ", " ", "Data", "Analyst"];
const graphemes = (s: string) => Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment);
function fieldProblem(shown: string, source: string, limit: number): string | null {
  const full = source.replace(/\s+/g, " ").trim();
  if (LONE.test(shown)) return `half a character: ${JSON.stringify(shown)}`;
  if (shown === full) return full.length <= limit ? null : `${full.length} characters shown where ${limit} fit`;
  if (!shown.endsWith("…")) return `cut without saying so: ${JSON.stringify(shown)} of ${JSON.stringify(full)}`;
  const head = shown.slice(0, -1);
  if (!full.startsWith(head)) return `not the posting's words: ${JSON.stringify(shown)} of ${JSON.stringify(full)}`;
  if (shown.length > limit) return `${shown.length} characters for ${limit}`;
  let at = 0;
  for (const g of graphemes(full)) { if (at >= head.length) break; at += g.length; }
  if (at !== head.length) return `cut inside a character: ${JSON.stringify(shown.slice(-6))}`;
  return null;
}
async function unicodeScenario(r: R, n: number): Promise<{ cat: string; why: string | null; input: unknown }> {
  const mk = (len: number) => { let s = ""; while (s.length < len) s += pick(r, PIECES) + (chance(r, 0.3) ? " " : ""); return s.trim(); };
  const long = pick(r, ["short", "long", "very_long"] as const);
  const L = long === "short" ? 30 : long === "long" ? 110 : 420;
  const p: Post = { job_id: `greenhouse:uni:${n}`, title: `Data Analyst ${mk(int(r, 1, L))}`, company: mk(int(r, 1, L)) || "X", location: mk(int(r, 1, Math.min(L, 120))) || "Remote", url: `https://boards.greenhouse.io/uni/jobs/${n}`, seen: T0 - 2 * MIN };
  const s: Search = { keywords: ["data analyst"], locations: [], remote_ok: true };
  const u = person("u", "UTC", prefsOf(s, { quiet_start: 0, quiet_end: 0, report_hour: 0 }), T0, { last_report_on: null });
  const plan = planProactive({ users: [u], postings: [row(p)], now: T0 });
  const a = plan.find((x) => x.kind === "alert") as { text: string } | undefined;
  const rep = plan.find((x) => x.kind === "report") as { text: string } | undefined;
  if (!a || !rep) return { cat: `unicode/${long}`, why: "no alert or report planned", input: { p } };
  for (const text of [a.text, rep.text]) {
    if (LONE.test(text)) return { cat: `unicode/${long}`, why: `half a character in ${JSON.stringify(text.slice(0, 300))}`, input: { p } };
    if (new TextDecoder().decode(new TextEncoder().encode(text)) !== text) return { cat: `unicode/${long}`, why: "not valid UTF-8 once encoded", input: {} };
  }
  const m = /^New match: (.*) at (.*) \((.*)\), first seen /su.exec(a.text);
  if (!m) return { cat: `unicode/${long}`, why: `the alert's shape: ${a.text.slice(0, 200)}`, input: {} };
  // The title is cut at 120, the company and the place at 80 (WO-007's room for each).
  const why = fieldProblem(m[1], p.title, 120) ?? (m[2].includes(" at ") ? null : fieldProblem(m[2], p.company, 80)) ?? (m[3].includes("(") ? null : fieldProblem(m[3], p.location, 80));
  if (why) return { cat: `unicode/${long}`, why, input: { p } };
  // The weekly digest says names too (status changes from mail).
  const d = buildDigest({ queue: [], tracker: [], mail: [{ ref: "mail:1", company: p.company, role: p.title, kind: "interview", stage: "interview", at: iso(T0 - HOUR) } as any], interviews: [], drafts: [], alerts: [], events: [] }, { now: T0, tz: "UTC" });
  if (d && LONE.test(d.text)) return { cat: "unicode/digest", why: `half a character in the digest: ${JSON.stringify(d.text.slice(0, 300))}`, input: { company: p.company } };
  return { cat: `unicode/${long}`, why: null, input: null };
}

// ------------------------------------------------------------------------------------------------ fit
async function fitScenario(r: R, n: number): Promise<{ cat: string; why: string | null; input: unknown }> {
  const k = int(r, 1, 6), s: Search = { keywords: ["accountant"], locations: [], remote_ok: true };
  const u = person("u", "UTC", prefsOf(s, { quiet_start: 0, quiet_end: 0, report_hour: 0, max_instant_per_day: int(r, 0, 4), min_fit: chance(r, 0.5) ? int(r, 0, 90) : undefined }), T0, { last_report_on: null });
  const posts: Post[] = Array.from({ length: k }, (_, i) => ({ job_id: `greenhouse:fit${n}:${i}`, title: "Staff Accountant", company: `Ledger ${i}`, location: "Remote", url: `https://boards.greenhouse.io/acct/jobs/${n}${i}`, seen: T0 - (i + 1) * MIN }));
  const UNCONFIRMED = ["holds a CPA license", "speaks fluent German", "has 10 years at a Big Four firm", "has a security clearance"];
  const fits: AlertFits = new Map([["u", new Map(posts.map((p) => [p.job_id, { score: int(r, 0, 100), excluded: chance(r, 0.1), reasons: [pick(r, UNCONFIRMED), `fit ${int(r, 0, 100)}`] }]))]]);
  const plan = planProactive({ users: [u], postings: posts.map(row), now: T0, fits });
  for (const x of plan) if ("text" in x) {
    const leak = UNCONFIRMED.find((f) => x.text.includes(f)) ?? (/\bfit\b|score|\d+%/.test(x.text) ? "a fit score" : null);
    if (leak) return { cat: "fit", why: `"${leak}" is said in what is sent: ${x.text}`, input: {} };
  }
  return { cat: "fit", why: null, input: null };
}

// ------------------------------------------------------------------------------------------------ the battery
const COUNTS = { changed: 1500, twins: 1300, channels: 900, dst: 1500, dst_days: 150, search: 1300, people: 900, burst: 40, brief: 900, unicode: 1500, fit: 500 } as const;
const RUNNERS: Record<keyof typeof COUNTS, (r: R, n: number) => Promise<{ cat: string; why: string | null; input: unknown }>> = {
  changed: changedScenario, twins: twinsScenario, channels: channelsScenario, dst: dstScenario, dst_days: dstDaysScenario, search: searchScenario,
  people: peopleScenario, burst: burstScenario, brief: briefScenario, unicode: unicodeScenario, fit: fitScenario,
};
const TITLES: Record<keyof typeof COUNTS, string> = {
  changed: "a posting that changed between the plan and the delivery: said as it is when it goes, or not sent",
  twins: "the same job through other boards and aggregators, now or days later: one alert per job",
  channels: "a person on two or three channels: once, on the home channel only; STOP anywhere holds everything",
  dst: "quiet hours on the person's clock across the 1 November 2026 change and other zones",
  dst_days: "one daily report a local day across the 25-hour day, never inside quiet hours",
  search: "a search changed after alerts and a report were queued: nothing of the old search goes",
  people: "paused, STOP, deleted, no confirmed resume: what may go and what may not, each skip with its reason",
  burst: "500 new postings at once: the day's pacing, once per posting, one report that counts what it lists",
  brief: "an interview cancelled or moved after its brief was queued; the digest's interviews coming up",
  unicode: "emoji, flags, CJK, right-to-left and very long names: whole characters, a cut says so",
  fit: "the fit an alert is ranked by is never said",
};
for (const kind of Object.keys(COUNTS) as (keyof typeof COUNTS)[]) {
  Deno.test({ name: `proactive round 3 (${kind}): ${TITLES[kind]}: ${COUNTS[kind]} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
    const rep = new Report(kind);
    const r = rng(SEED + Object.keys(COUNTS).indexOf(kind) * 7919);
    for (let i = 0; i < COUNTS[kind]; i++) {
      let got: { cat: string; why: string | null; input: unknown };
      try { got = await RUNNERS[kind](r, i); } catch (e) { got = { cat: `${kind}/threw`, why: `threw: ${e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" ") : String(e)}`, input: { i } }; }
      rep.grade(got.cat, got.why, got.input);
    }
    TOTALS[kind] = rep.total;
    rep.assertClean();
  } });
}
Deno.test("the battery is about 10,000 scenarios", () => {
  const n = Object.values(COUNTS).reduce((a, b) => a + b, 0);
  assertNode.ok(n >= 10000 && n <= 11000, `${n} scenarios`);
});
