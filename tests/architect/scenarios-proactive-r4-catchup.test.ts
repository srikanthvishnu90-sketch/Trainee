// Proactive round 4, second half (catchup, briefs, budget; the first half is scenarios-proactive-r4.test.ts, split so each
// file stays well under a minute in CI). Round 4 as a whole: about 10,000 generated
// scenarios (seed 20261105, scenarios/proactive-r4-generator.ts) through the real code of what Trainee sends without being
// asked: the scheduled alerts run (career_proactive_run.ts runAlerts over the memory alert store, with the alert settings
// tool's startWatching for a zone change), the weekly digest (runDigest), mail tracking's interview briefs (runMail) with
// and without the model's second pass, and the scheduled run's handler (career-proactive/handler.ts handleProactive). A
// fixed clock, no network, no model (a scripted fake that refuses as the budget does). Rounds 1 to 3 are
// scenarios-proactive*.test.ts; these are the categories they did not try (see the generator). Every expectation comes
// from how the scenario was built, never from the product's code. The invariants:
//   - at most one daily report for a local date, and never one for a date earlier than one already sent (a move west);
//   - never more alerts than the person's daily number for a day already counted (a move west keeps the count); never
//     more than two days' worth in any 24 hours unless the person moved east;
//   - nothing planned inside quiet hours on the person's clock as it is when planned;
//   - no alert and no report line for a job the person applied to (or its copy on another board), or one that closed;
//     every other new job is still news, up to their number;
//   - after an outage, one daily report and one weekly digest at most in what goes out together, the newest one, and
//     each one set aside says why;
//   - no interview brief for an interview already over; one still to come is briefed once (both texts), with the
//     invite's company and the time on the person's own clock;
//   - a refused model budget changes nothing that is queued (exactly the rules' texts), half-builds nothing, says nothing
//     about the model, and asks no more calls than were granted;
//   - no rail that reads a person as paused, stopped or erased starts anything for them; others still get everything.
// Run: deno test -A --no-check tests/architect/scenarios-proactive-r4-catchup.test.ts
import { runAlerts, runDigest, runInterviewDrafts, runMail } from "../../supabase/functions/_shared/career_proactive_run.ts";
import { memoryAlertStore, startWatching, type AlertRow } from "../../supabase/functions/_shared/career_alert_store.ts";
import { DEFAULT_PREFS } from "../../supabase/functions/_shared/career_alerts.ts";
import { memoryMailStore } from "../../supabase/functions/_shared/career_mail_store.ts";
import { memoryBriefStores } from "../../supabase/functions/_shared/career_brief_store.ts";
import { handleProactive } from "../../supabase/functions/career-proactive/handler.ts";
import { ModelBudgetBlockedError } from "../../supabase/functions/_shared/model_calls.ts";
import { ALERT_STALE_MS } from "../../supabase/functions/_shared/channel.ts";
import { isoWeekOf } from "./scenarios/proactive-generator.ts";
import { localTime } from "./scenarios/proactive-r2-generator.ts";
import {
  type AppliedScenario, type BriefScenario, type BudgetScenario, type CatchupScenario, clock, COUNTS, DAY, generate, HOUR, MIN, offsetMin,
  type PauseScenario, type Posting, quietOn, type R4Scenario, SEED, type ZoneScenario,
} from "./scenarios/proactive-r4-generator.ts";

const ALL = generate({ seed: SEED, only: ["catchup", "briefs", "budget"] }); // zones, applied, pause: scenarios-proactive-r4.test.ts
const of = <K extends R4Scenario["kind"]>(k: K) => ALL.filter((s) => s.kind === k) as Extract<R4Scenario, { kind: K }>[];
const iso = (t: number) => new Date(t).toISOString();
const ms = (t: unknown) => Date.parse(String(t ?? ""));
const AUTH = (d: string) => [`mx.google.com; dkim=pass header.i=@${d} header.s=s1; spf=pass smtp.mailfrom=${d}; dmarc=pass (p=REJECT) header.from=${d}`];
const hex = (s: string) => Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("").padEnd(64, "0").slice(0, 64);

interface Failure { why: string; input: unknown }
class Report {
  total = 0; byCat: Record<string, number> = {}; failures = new Map<string, Failure[]>(); notes: Record<string, number> = {};
  constructor(public name: string) {}
  grade(cat: string, why: string | null, input: unknown = "") {
    this.total++;
    this.byCat[cat] = (this.byCat[cat] ?? 0) + 1;
    if (!why) return;
    if (!this.failures.has(cat)) this.failures.set(cat, []);
    this.failures.get(cat)!.push({ why, input });
  }
  note(k: string, n = 1) { this.notes[k] = (this.notes[k] ?? 0) + n; }
  assertClean() {
    const failed = [...this.failures.values()].reduce((a, b) => a + b.length, 0);
    const lines = [`[proactive r4] ${this.name}: ${this.total} scenarios (${Object.entries(this.byCat).map(([k, v]) => `${k} ${v}`).join(", ")}), ${failed} failures${Object.keys(this.notes).length ? `; ${Object.entries(this.notes).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`];
    for (const [k, xs] of [...this.failures.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 3)) lines.push(`    ${x.why} | input ${JSON.stringify(x.input).slice(0, Number(Deno.env.get("R4_INPUT") ?? 400))}`);
    }
    console.log(lines.join("\n"));
    if (failed) throw new Error(lines.join("\n"));
  }
}
// The product logs every rail's failure (and the scenarios make some on purpose); the report says what matters.
async function quietLogs<T>(f: () => Promise<T>): Promise<T> {
  const e = console.error, w = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return await f(); } finally { console.error = e; console.warn = w; }
}
const prefsOf = (p: { cap: number; report_hour: number; quiet_start: number; quiet_end: number }) =>
  ({ ...DEFAULT_PREFS, keywords: ["data analyst"], report_hour: p.report_hour, quiet_start: p.quiet_start, quiet_end: p.quiet_end, max_instant_per_day: p.cap });
const seenBy = (ps: Posting[], t: number) => ps.filter((p) => ms(p.first_seen_at) <= t);

// ------------------------------------------------------------------------------------------------ catchup
interface Row { key: string; kind: string; text: string; at: number; status: "queued" | "delivered" | "stale" | "superseded"; batch?: number; seq: number }
async function checkCatchup(s: CatchupScenario, rep: Report): Promise<{ why: string | null; got: unknown }> {
  const u = "c-user", base = memoryAlertStore(), pf = prefsOf(s.prefs);
  await base.save(startWatching(null, { userId: u, prefs: pf, tz: s.tz, now: s.start - HOUR }));
  const rows: Row[] = [];
  let seq = 0;
  const outbox = {
    async enqueue(id: string, m: any) { const ok = await base.enqueue(id, m); if (ok) rows.push({ key: m.key, kind: m.kind, text: m.text, at: m.at, status: "queued", seq: seq++ }); return ok; },
    enqueueAlert: base.enqueueAlert,
    async supersede(_id: string, kind: "report" | "digest", keep: string) { let n = 0; for (const r of rows) if (r.kind === kind && r.key !== keep && r.status === "queued") { r.status = "superseded"; n++; } return n; },
  };
  const weekly: { created_at: string }[] = [];
  for (let t = s.start - 7 * DAY; t < s.end; t += 12 * HOUR) weekly.push({ created_at: iso(t) });
  const briefs = memoryBriefStores({ digest: { [u]: { prefs: { on: true, day: s.digest.day, hour: s.digest.hour }, tz: s.tz } } as any, rows: { [u]: { alerts: weekly } } as any });
  const once = async (t: number) => {
    await runAlerts({ store: base, outbox, now: t, recentPostings: async (since) => seenBy(s.postings, t).filter((p) => ms(p.first_seen_at) >= ms(since)), postingsById: async (ids) => seenBy(s.postings, t).filter((p) => ids.includes(p.job_id)) }).catch(() => {});
    await runDigest({ outbox, now: t, store: { ...briefs.digest, rows: async (id: string, since: string) => { const r = await briefs.digest.rows(id, since); return { ...r, alerts: r.alerts.filter((a: any) => ms(a.created_at) <= t) }; } } }).catch(() => {});
  };
  const deliver = (t: number) => {
    for (const r of rows) {
      if (r.status !== "queued" || r.at > t) continue;
      if (/^(alert|report):/.test(r.key) && t - r.at > ALERT_STALE_MS) { r.status = "stale"; continue; }
      if (quietOn(t, s.tz, s.prefs.quiet_start, s.prefs.quiet_end)) continue;
      r.status = "delivered"; r.batch = t;
    }
  };
  const events: { t: number; f: () => Promise<void> | void }[] = [
    ...s.runs.map((g) => ({ t: g[0], f: async () => { if (g.length === 2 && g[0] === g[1]) await Promise.all([once(g[0]), once(g[1])]); else for (const t of g) await once(t); } })),
    ...s.deliveries.map((t) => ({ t, f: () => deliver(t) })),
  ].sort((a, b) => a.t - b.t);
  for (const e of events) await e.f();
  const batches = new Map<number, Row[]>();
  for (const r of rows) if (r.status === "delivered") batches.set(r.batch!, [...(batches.get(r.batch!) ?? []), r]);
  for (const [t, rs] of batches) {
    const rp = rs.filter((r) => r.kind === "report"), dg = rs.filter((r) => r.kind === "digest");
    if (rp.length > 1) return { why: `${rp.length} daily reports sent together at ${iso(t)} after the outage`, got: rp.map((r) => r.key) };
    if (dg.length > 1) return { why: `${dg.length} weekly digests sent together at ${iso(t)}`, got: dg.map((r) => r.key) };
  }
  const sentReports = rows.filter((r) => r.kind === "report" && r.status === "delivered").sort((a, b) => a.batch! - b.batch! || a.seq - b.seq);
  for (let i = 1; i < sentReports.length; i++) if (sentReports[i].key <= sentReports[i - 1].key) return { why: "an older daily report sent after a newer one", got: sentReports.map((r) => r.key) };
  for (const r of rows.filter((x) => x.status === "superseded")) if (!rows.some((x) => x.kind === r.kind && x.seq > r.seq)) return { why: "a text set aside with nothing newer in its place", got: r.key };
  const keys = rows.map((r) => r.key);
  if (new Set(keys).size !== keys.length) return { why: "a key queued twice", got: keys };
  const digests = rows.filter((r) => r.kind === "digest");
  for (const d of digests) if (d.key !== `digest:${isoWeekOf(clock(rows.length ? d.at : 0, s.tz).date)}` && !/^digest:\d{4}-W\d{2}$/.test(d.key)) return { why: "a digest key that is not its week", got: d.key };
  // Liveness: the newest report goes once delivery is back (unless it is no longer news, or still waiting its turn).
  const last = [...rows].reverse().find((r) => r.kind === "report");
  const chance = last && s.deliveries.some((d) => d >= last.at && d - last.at <= ALERT_STALE_MS && !quietOn(d, s.tz, s.prefs.quiet_start, s.prefs.quiet_end));
  if (last && chance && !["delivered", "stale"].includes(last.status)) return { why: `the newest daily report (${last.key}) was never sent (${last.status})`, got: rows.filter((r) => r.kind === "report").map((r) => [r.key, r.status]) };
  rep.note("set_aside", rows.filter((r) => r.status === "superseded").length);
  return { why: null, got: null };
}
Deno.test({ name: `proactive round 4 (catchup): delivery or the run down for days, a run retried and two at once: ${COUNTS.catchup} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("catchup");
  await quietLogs(async () => { for (const s of of("catchup")) { const r = await checkCatchup(s, rep); rep.grade(s.category, r.why, { tz: s.tz, prefs: s.prefs, digest: s.digest, down: s.deliveryDown.map(iso), got: r.got }); } });
  rep.assertClean();
  if (!rep.notes.set_aside) throw new Error("no outage set a report or digest aside: the battery does not reach the case");
} });

// ------------------------------------------------------------------------------------------------ briefs
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const longDate = (d: string) => { const t = new Date(`${d}T12:00:00Z`); return `${WD[t.getUTCDay()]}, ${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`; };
const ampm = (time: string) => { const [h, m] = time.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
async function checkBrief(s: BriefScenario): Promise<{ why: string | null; got: unknown }> {
  const u = "iv-user", domain = `${s.company.toLowerCase()}.com`;
  const mail = memoryMailStore({ people: [{ user_id: u, read_through: s.firstRead ? null : iso(s.sent - HOUR), tz: s.personTz } as any],
    tracker: { [u]: [{ app_id: "a1", company: s.company, stage: "Submitted", applied_at: iso(s.sent - 12 * DAY), events: [], role: s.role }] } });
  const briefs = memoryBriefStores({ people: [{ user_id: u, tz: s.personTz }] });
  const box = memoryAlertStore();
  const intro = `Hi Sam, thank you for your interest in the ${s.role} role at ${s.company}.`;
  const body = s.time ? `${intro} We'd like to invite you to a video interview on Zoom for the ${s.role} role on ${longDate(s.date)} at ${ampm(s.time)} ${s.zoneSaid}.`
    : `${intro} Your onsite interview for the ${s.role} role is on ${longDate(s.date)} (all day) at our office.`;
  const hash = hex(`iv-${s.sent}-${s.company}-${s.date}`);
  const mails = [{ hash, from: `${s.company} Recruiting <recruiting@${domain}>`, subject: `Interview invitation - ${s.role}`, snippet: body, date: iso(s.sent), auth: AUTH(domain) }];
  const run = (t: number) => runMail({ outbox: box, now: t, store: mail, briefs: briefs.interviews,
    read: async (_u, since) => { const m = mails.filter((x) => ms(x.date) >= since && ms(x.date) <= t); return { status: "ok", mails: m, readThrough: t, listed: m.length }; } }).catch(() => {});
  for (const g of s.runs) { if (g.length === 2 && g[0] === g[1]) await Promise.all(g.map(run)); else for (const t of g) await run(t); }
  const out = box.dump().outbox, read = s.firstRead ? s.sent >= s.read - 3 * DAY : true;
  const bs = out.filter((x) => x.kind === "brief");
  for (const x of out) if (quietOn(x.at, s.personTz, DEFAULT_PREFS.quiet_start, DEFAULT_PREFS.quiet_end) || x.at < s.read) return { why: "a text planned inside the person's quiet hours", got: [x.key, iso(x.at)] };
  if (s.over) return bs.length ? { why: `an interview brief for an interview already over (${s.start ? iso(s.start) : s.date}; mail read ${iso(s.read)}, ${s.personTz})`, got: bs.map((b) => b.key) } : { why: null, got: null };
  // (a follow-up offer on an application gone quiet is not made from this mail; it may go either way)
  if (!read) return out.some((x) => x.kind === "brief" || x.kind === "status") ? { why: "mail outside the first read's window was said", got: out.map((x) => x.key) } : { why: null, got: null };
  const keys = bs.map((b) => b.key).sort();
  if (keys.join() !== [`brief:${hash}:1`, `brief:${hash}:2`].join()) return { why: `the brief for an interview still to come is ${keys.length ? keys.join(", ") : "missing"} (want both texts once)`, got: out.map((x) => x.key) };
  const one = bs.find((b) => b.key.endsWith(":1"))!.text;
  if (!one.includes(s.company)) return { why: "the brief does not name the invite's company", got: one.split("\n")[0] };
  if (s.start !== null && !(one.includes(localTime(s.start, s.personTz)) && one.includes(s.personTz))) return { why: `the brief's time on the person's clock is not the invite's (${localTime(s.start, s.personTz)} ${s.personTz})`, got: one.split("\n")[1] };
  if (s.start === null && /your time/i.test(one)) return { why: "a time converted that the invite never stated", got: one.split("\n")[1] };
  if (!(briefs.dump().interviews[u] ?? []).some((r: any) => r.key === hash)) return { why: "the invite was not stored", got: null };
  return { why: null, got: null };
}
Deno.test({ name: `proactive round 4 (briefs): interview invites read late, over or still to come, retried and two runs at once: ${COUNTS.briefs} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("briefs");
  let over = 0, upcoming = 0;
  await quietLogs(async () => { for (const s of of("briefs")) { const r = await checkBrief(s); s.over ? over++ : upcoming++; rep.grade(s.category, r.why, { start: s.start && iso(s.start), date: s.date, read: iso(s.read), sent: iso(s.sent), tz: s.personTz, got: r.got }); } });
  if (over < 300 || upcoming < 300) throw new Error(`the battery reaches too few of one side: ${over} over, ${upcoming} still to come`);
  rep.note("over", over); rep.note("upcoming", upcoming);
  rep.assertClean();
} });

// ------------------------------------------------------------------------------------------------ budget
async function budgetRun(s: BudgetScenario, model: "none" | "refusing"): Promise<{ out: any[]; calls: number; granted: number; costs: number }> {
  const people = s.people.map((p) => ({ user_id: p.id, read_through: iso(s.now - 2 * HOUR), tz: "America/New_York" }));
  const tracker = Object.fromEntries(s.people.map((p) => [p.id, [{ app_id: `a-${p.id}`, company: p.company, stage: "Submitted", applied_at: iso(s.now - 9 * DAY), events: [], role: "Account Manager" }]]));
  const base = memoryMailStore({ people: people as any, tracker });
  let granted = 0;
  const gate = new Map(s.people.map((p) => [p.id, p.gate]));
  const store = { ...base, claimModelCalls: async (u: string, want: number, cap: number, now: number) => { const g = Math.min(await base.claimModelCalls!(u, want, cap, now), gate.get(u) ?? 0); granted += g; return g; } };
  const briefs = memoryBriefStores({ people: people.map((p) => ({ user_id: p.user_id, tz: p.tz })) });
  const box = memoryAlertStore();
  const mails = new Map(s.people.map((p, k) => {
    const d = `${p.company.toLowerCase()}.com`, from = `${p.company} Recruiting <recruiting@${d}>`, at = (n: number) => iso(s.now - (30 - n) * MIN);
    const m: any[] = [];
    for (let i = 0; i < p.vague; i++) m.push({ hash: hex(`v${k}${i}${p.id}`), from, subject: `${p.company} - update on your application`, snippet: "Hi Sam, thanks for your patience. We have news about the Account Manager role; please see the portal.", date: at(i), auth: AUTH(d) });
    if (p.invite) m.push({ hash: hex(`i${k}${p.id}`), from, subject: "Interview invitation - Account Manager", snippet: `Hi Sam, thank you for your interest in the Account Manager role at ${p.company}. We'd like to invite you to a phone interview for the Account Manager role on ${longDate(clock(s.now + 3 * DAY, "UTC").date)} at 2:00 PM ET.`, date: at(10), auth: AUTH(d) });
    if (p.clear) m.push({ hash: hex(`c${k}${p.id}`), from, subject: `Your ${p.company} application`, snippet: "Unfortunately, we have decided not to move forward with your application.", date: at(12), auth: AUTH(d) });
    return [p.id, m];
  }));
  let calls = 0, costs = 0;
  const wiring = model === "none" ? null : { status: "on" as const, deps: {
    call: async () => {
      calls++;
      if (s.category === "paused_by_env") throw new ModelBudgetBlockedError("paused", "MODEL_BUDGET_PAUSED is on");
      if (calls > s.refuseAfter) throw new ModelBudgetBlockedError("limit", "the global model budget is used up");
      return { content: [{ type: "text", text: "not a verdict" }], stop_reason: "end_turn" };
    },
    cost: async () => { costs++; },
  } };
  await runMail({ outbox: box, now: s.now, store, briefs: briefs.interviews, model: wiring,
    read: async (u, since) => { const m = (mails.get(u) ?? []).filter((x) => ms(x.date) >= since); return { status: "ok", mails: m, readThrough: s.now, listed: m.length }; } }).catch(() => {});
  return { out: box.dump().outbox, calls, granted, costs };
}
Deno.test({ name: `proactive round 4 (budget): the model budget refuses the mail second pass, globally, part way, or for some people today: ${COUNTS.budget} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("budget");
  await quietLogs(async () => {
    for (const s of of("budget")) {
      const rules = await budgetRun(s, "none"), refused = await budgetRun(s, "refusing");
      const shape = (xs: any[]) => JSON.stringify(xs.map((x) => [x.userId, x.key, x.kind, x.text, x.at]).sort());
      let why: string | null = null;
      if (shape(rules.out) !== shape(refused.out)) why = "what was queued with the budget refusing is not what the rules alone queue";
      else if (refused.calls > refused.granted) why = `${refused.calls} model calls asked, ${refused.granted} granted by the per-person gate`;
      else if (refused.out.some((x) => /budget|model|\bAI\b|Claude|Anthropic/i.test(x.text))) why = "a text speaks of the model or its budget";
      else {
        const parts = new Map<string, Set<string>>();
        for (const x of refused.out.filter((y) => y.kind === "brief")) { const [, h, n] = x.key.split(":"); if (!parts.has(h)) parts.set(h, new Set()); parts.get(h)!.add(n); }
        for (const ns of parts.values()) if (!(ns.has("1") && ns.has("2"))) why = "a brief half queued";
      }
      rep.note("calls_refused", Math.max(0, refused.calls - s.refuseAfter));
      rep.grade(s.category, why, { people: s.people, rules: rules.out.map((x) => x.key), refused: refused.out.map((x) => x.key) });
    }
  });
  if (!rep.notes.calls_refused) throw new Error("the model was never refused: the battery does not reach the case");
  rep.assertClean();
} });


// ------------------------------------------------------------------------------------------------ the bugs, one by one
const eqv = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
Deno.test("round 4 regression: yesterday's report and last week's digest, still unsent, are set aside by the new ones (never two at once)", async () => {
  const u = "late", base = memoryAlertStore(), asides: string[] = [];
  const outbox = { ...base, supersede: async (id: string, kind: string, keep: string) => { asides.push(`${id}|${kind}|${keep}`); return 1; } };
  const t1 = Date.parse("2026-11-05T14:02:00Z"), t2 = t1 + DAY; // 9:02 in New York, two days running
  await base.save({ id: u, tz: "America/New_York", prefs: prefsOf({ cap: 3, report_hour: 8, quiet_start: 0, quiet_end: 0 }), last_checked_at: iso(t1 - HOUR), instant_sent_today: 0, sent_on: null, last_report_on: null, held: [] });
  for (const t of [t1, t2]) await runAlerts({ store: base, outbox, now: t, recentPostings: async () => [], postingsById: async () => [] });
  eqv(asides, [`${u}|report|report:2026-11-05`, `${u}|report|report:2026-11-06`], "each new report sets the older unsent ones aside");
  const briefs = memoryBriefStores({ digest: { [u]: { prefs: { on: true, day: 4, hour: 8 }, tz: "America/New_York" } } as any, rows: { [u]: { alerts: [{ created_at: iso(t1 - DAY) }] } } as any });
  eqv(await runDigest({ outbox, now: t1, store: briefs.digest }), 1, "the digest is queued");
  eqv(asides.at(-1), `${u}|digest|digest:2026-W45`, "and sets last week's aside");
});
Deno.test("round 4 regression: an invite read after its interview is not briefed; its status is still said", async () => {
  const u = "late-iv", sent = Date.parse("2026-11-01T15:00:00Z"), read = Date.parse("2026-11-05T15:00:00Z");
  const mail = memoryMailStore({ people: [{ user_id: u, read_through: iso(sent - HOUR), tz: "America/New_York" } as any], tracker: { [u]: [{ app_id: "a1", company: "Acme", stage: "Submitted", applied_at: iso(sent - 9 * DAY), events: [], role: "Data Analyst" }] } });
  const briefs = memoryBriefStores({ people: [{ user_id: u, tz: "America/New_York" }] }), box = memoryAlertStore();
  const m = { hash: hex("late-invite"), from: "Acme Recruiting <recruiting@acme.com>", subject: "Interview invitation - Data Analyst", date: iso(sent), auth: AUTH("acme.com"),
    snippet: "Hi Sam, thank you for your interest in the Data Analyst role at Acme. We'd like to invite you to a video interview on Zoom for the Data Analyst role on Tuesday, November 3, 2026 at 2:00 PM ET." };
  await runMail({ outbox: box, now: read, store: mail, briefs: briefs.interviews, read: async () => ({ status: "ok", mails: [m], readThrough: read, listed: 1 }) });
  const out = box.dump().outbox;
  eqv(out.filter((x) => x.kind === "brief").length, 0, "no brief for 3 November, read on 5 November");
  if (!out.some((x) => x.kind === "status")) throw new Error(`the interview's status was not said: ${JSON.stringify(out.map((x) => x.key))}`);
  eqv((briefs.dump().interviews[u] ?? []).length, 1, "the invite is stored");
});
void runInterviewDrafts; void handleProactive; void startWatching;
