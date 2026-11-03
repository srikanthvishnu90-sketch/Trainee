// Text simulator (WO-004): text the agent from a terminal through the same conversation interface the real channel will
// use (_shared/conversation.ts): signup by first text, history, per-person state, attachments, bubbles, and
// agent-initiated messages delivered when the fake clock reaches them.
//
//   deno run -A scripts/text.ts [--brain router|agent] [--as +15550000001] [--transcript file.md] [--script file.txt] [--fresh]
//                               [--postings postings.json] [--at 2026-10-19T15:00:00Z]   (real postings saved by supabase/functions/career-ingest/local.ts --out)
//
// Commands: /attach <path>   attach a file to the next text
//           /as <contact>    switch person          /reset   forget this person
//           /clock +2h|+1d|+30m  advance the clock, run the job-alerts planner (WO-007), deliver what is due
//           /alerts data analyst, analyst | new york, remote   turn alerts on without the brain (a test shortcut)
//           /post Data Analyst | Stripe | Remote - US   add a TEST posting first seen now (example.test link)
//           /state           print this person's stored state          /quit
// --brain agent needs ANTHROPIC_API_KEY (Claude only: model CAREER_REPLY_MODEL, default claude-haiku-5-5); nothing is sent anywhere else.
// State lives in .simulator/state.json (gitignored) so a session resumes; --fresh starts over.
import { handleInbound, memoryStore, type Brain, type Attachment, type MemoryState } from "../supabase/functions/_shared/conversation.ts";
import { memoryChannel } from "../supabase/functions/_shared/channel.ts";
import { CareerAccess, CareerOnboarding, CareerRouter, CareerDoorstep, CareerReply, CareerContainment, CareerJobs } from "../supabase/functions/_shared/router_core.career.js";
import { CareerPool } from "../supabase/functions/_shared/career_pool.js";
import { CareerHost } from "../supabase/functions/_shared/career_host.js";
import { agentTurn } from "../supabase/functions/agent-chat/career_brain.ts";
import { callModel, modelConfigFor, newMeter } from "../supabase/functions/_shared/model_gateway.ts";
import { memoryPostingsDb, searchWords, type Posting } from "../supabase/functions/_shared/career_ingest.ts";
import { memoryAlertStore, startWatching, validPrefs, type MemoryAlerts } from "../supabase/functions/_shared/career_alert_store.ts";
import { runAlerts } from "../supabase/functions/_shared/career_proactive_run.ts";
import { draftFor, memoryOutreachStore, outreachTurn, runOutreachSends } from "../supabase/functions/_shared/career_outreach.ts";
import { dohMx } from "../supabase/functions/_shared/career_contacts.ts";

const args = Deno.args;
const opt = (name: string, dflt: string | null = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const brainName = opt("--brain", "router")!;
const transcript = opt("--transcript");
const script = opt("--script");
const postingsFile = opt("--postings");
const STATE_DIR = ".simulator", STATE_FILE = `${STATE_DIR}/state.json`;
const MIME: Record<string, string> = { txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", heic: "image/heic" };

if (brainName !== "router" && brainName !== "agent") { console.error("--brain must be router or agent"); Deno.exit(2); }
if (brainName === "agent" && !opt("--world") && !Deno.env.get("ANTHROPIC_API_KEY")) { console.log("NOT CONFIGURED: --brain agent needs ANTHROPIC_API_KEY in the environment."); Deno.exit(2); }

type Saved = { mem: MemoryState; now: number; as: string; alerts?: MemoryAlerts; posts?: Posting[]; optedOut?: string[] };
let saved: Saved | null = null;
if (!args.includes("--fresh")) { try { saved = JSON.parse(Deno.readTextFileSync(STATE_FILE)); } catch { saved = null; } }
const mem = memoryStore(saved?.mem);
const alerts = memoryAlertStore(saved?.alerts);
// STOP / START / HELP go through the channel rules exactly as on a phone (WO-013a); a contact who texted STOP gets nothing.
const channel = memoryChannel();
for (const c of saved?.optedOut ?? []) await channel.setOptOut(c, true, 0);
const startAt = opt("--at"); // e.g. 2026-10-19T15:00:00Z: start the clock here (demos and tests)
let now = startAt && Number.isFinite(Date.parse(startAt)) ? Date.parse(startAt) : saved?.now ?? Date.now();
let as = opt("--as", saved?.as ?? "+15550000001")!;
let pending: Attachment[] = [];
const meter = newMeter();
// Job search reads the same store interface production does (supabasePostingsDb there, memory here).
const jobs = memoryPostingsDb();
if (saved?.posts) await jobs.putMany(saved.posts);
if (postingsFile) {
  try { const rows = JSON.parse(Deno.readTextFileSync(postingsFile)) as Posting[]; await jobs.putMany(rows); console.log(`(${rows.length} postings loaded from ${postingsFile})`); }
  catch (e) { console.error(`couldn't read --postings ${postingsFile}: ${e instanceof Error ? e.message : e}`); Deno.exit(2); }
}

const host = CareerHost.createCareerHost({ CareerAccess, CareerOnboarding, CareerRouter, CareerDoorstep, CareerReply, CareerContainment });
// The router's discovery pool, loaded per turn the way agent-chat loads it (handler-career.ts: CareerPool's KB loader,
// then the named-company supplement), but over the simulator's postings, each given the KB row shape the loader maps.
// Without it the router's searches always answered "the current list is empty", whatever /post or --postings held.
const kbRow = (p: Posting) => ({ posting_key: p.job_id, title: p.title, company: p.company, location: p.location ?? "", url: p.url ?? "",
  text_excerpt: String(p.description ?? "").slice(0, 4000), source: p.provider, posted_at: p.posted_at ?? p.first_seen_at, board: p.board,
  fetched_on: String(p.last_seen_at ?? p.first_seen_at ?? "").slice(0, 10) || null, corpus_vintage: null });
const pool = CareerPool.createKbPoolLoader({
  readRows: async (spec: any) => {
    let rows = (await jobs.open()).map(kbRow);
    for (const f of spec.filters ?? []) {
      const v = String(f.value).toLowerCase();
      rows = rows.filter((r: any) => {
        const x = String(r[f.column] ?? "").toLowerCase();
        return f.op === "eq" ? x === v : f.op === "ilike" ? x.includes(v.replace(/^%|%$/g, "")) : true;
      });
    }
    return rows.slice(0, spec.limit);
  },
  jobs: { roleFamily: CareerJobs.roleFamily, seniorityBand: CareerJobs.seniorityBand, stripHtml: CareerJobs.stripHtml },
});
async function routerPostings(message: string) {
  let postings: any[] = (await pool.loadPool()).postings;
  const target = typeof (CareerRouter as any).namedRoleTargetOf === "function" ? (CareerRouter as any).namedRoleTargetOf(message, null) : null;
  if (target && target.company && typeof (pool as any).loadTargeted === "function") {
    const extra = await (pool as any).loadTargeted(target);
    const seen = new Set(postings.map((p: any) => p.job_id));
    postings = postings.concat((extra.postings ?? []).filter((p: any) => !seen.has(p.job_id)));
  }
  return postings;
}
function turnCtx(userId: string, stores: Record<string, unknown>, postings?: any[]) {
  return host.createTurnCtx({ userId, threadId: userId, now, snapshot: (stores.snapshot as any) ?? null, ...(postings ? { postings } : {}) });
}
function withFiles(message: string, files: { name: string; mime: string; text: string | null }[]) {
  return [message, ...files.map((f) => f.text !== null ? `[Attached file: ${f.name}]\n${f.text}` : `[Attached file: ${f.name} (${f.mime}) — this file type can't be read yet]`)].join("\n\n");
}
const routerBrain: Brain = async (a) => {
  const ctx = turnCtx(a.userId, a.stores, await routerPostings(a.message));
  const out = host.runTurn(withFiles(a.message, a.attachments), ctx);
  return { reply: out.reply, stores: { snapshot: host.extractSnapshot(ctx) } };
};
// WO-033: outreach drafts and approvals live in memory for this session; sends go to a simulated Gmail that only prints
// (/clock runs the scheduled send, one per person per 5-minute step). Nothing is ever emailed from the simulator.
const outreach = memoryOutreachStore();
const agentBrain: Brain = async (a) => {
  const ctx = turnCtx(a.userId, a.stores) as Record<string, unknown>;
  const cfg = modelConfigFor(Deno.env, Deno.env.get("CAREER_REPLY_MODEL") || "claude-haiku-5-5");
  const model = (p: any) => callModel(cfg, p, { meter, role: "chat" });
  const ans = await outreachTurn({ message: a.message, userId: a.userId, threadId: a.userId, now, store: outreach, gmailConnected: async () => true,
    redraft: (d) => draftFor({ model, facts: ((ctx as any).profile?.facts ?? []), r: d.recipient, previous: d.body }) });
  if (ans) { outreach.setIntent(a.userId, ans.intent); return { reply: ans.reply, stores: { snapshot: host.extractSnapshot(ctx as any) } }; }
  const t = await agentTurn({ message: a.message, attachments: a.attachments, mx: dohMx(fetch), outreach: { store: outreach, model }, history: a.history, stores: ctx, userId: a.userId, threadId: a.userId, now,
    model, postings: (q) => jobs.search(searchWords(q), 150), alerts });
  outreach.setIntent(a.userId, t.show?.intent ?? "agent");
  if (t.tool_calls.length) console.log(`   · tools: ${t.tool_calls.map((c) => `${c.name}${c.ok ? "" : " ✗"}`).join(", ")}`);
  if (t.stopped !== "final") console.log(`   · stopped: ${t.stopped}`);
  return { reply: t.reply, stores: { snapshot: host.extractSnapshot(ctx as any) } };
};
const brain = brainName === "agent" ? agentBrain : routerBrain;

const log = (line: string) => { console.log(line); if (transcript) Deno.writeTextFileSync(transcript, line + "\n", { append: true }); };
// WO-100: --world evals/career/worlds/in-flight.json seeds one SYNTHETIC person with tasks in flight and runs each text
// through agent-chat's dispatch (evals/career/world.ts). /thread B opens a new conversation. --model scripted (no key):
// a scripted model that calls get_situation (with the employer the text names) and says its text, so the demo shows
// exactly what the agent is given; it is labeled, never passed off as the model's own words.
if (opt("--world")) {
  const { openWorld, worldTurn } = await import("../evals/career/world.ts");
  const file = JSON.parse(Deno.readTextFileSync(opt("--world")!));
  const set = JSON.parse(Deno.readTextFileSync(new URL("../evals/career/conversations.json", import.meta.url)));
  const scripted = opt("--model") === "scripted";
  if (brainName === "agent" && !scripted && !Deno.env.get("ANTHROPIC_API_KEY")) { console.log("NOT CONFIGURED: --brain agent needs ANTHROPIC_API_KEY, or --model scripted."); Deno.exit(2); }
  const w = await openWorld(file, { postings: set.postings });
  const cfg = modelConfigFor(Deno.env, Deno.env.get("CAREER_REPLY_MODEL") || "claude-haiku-5-5");
  const firms = [...new Set((file.postings ?? []).map((p: any) => String(p.company)))] as string[];
  const scriptedModel = (message: string) => async (p: any) => {
    const last = p.messages.at(-1);
    const result = Array.isArray(last?.content) ? last.content.find((b: any) => b.type === "tool_result") : null;
    if (!result) return { content: [{ type: "tool_use", id: "s1", name: "get_situation", input: { company: firms.find((f) => new RegExp(`\\b${f}\\b`, "i").test(message)) } }], stop_reason: "tool_use" };
    let text = String(result.content); try { text = JSON.parse(text).text ?? text; } catch { /* the error text as is */ }
    return { content: [{ type: "text", text: `[scripted model: get_situation's text]\n${text}` }], stop_reason: "end_turn" };
  };
  let thread = "A", now = w.now;
  log(`Trainee text simulator · world ${opt("--world")} · brain: ${brainName}${brainName === "agent" ? scripted ? " (scripted model)" : ` (${cfg.model})` : ""} · ${new Date(now).toISOString()}`);
  const lines = script ? Deno.readTextFileSync(script).split("\n") : null;
  for (let i = 0; ; i++) {
    const t = (lines ? lines[i] : prompt(">"))?.trim();
    if (t === undefined || t === null || t === "/quit") break;
    if (!t) continue;
    if (t.startsWith("/thread ")) { thread = t.slice(8).trim(); log(`  (new conversation: thread ${thread})`); continue; }
    log(`⟶ [${thread}] ${t}`);
    const r = await worldTurn(w, { brain: brainName as "agent" | "router", threadId: thread, message: t, now, model: scripted ? scriptedModel(t) : (p: any) => callModel(cfg, p, { meter, role: "chat" }) });
    log(`  ⟵ (${r.handler}) ${r.reply.replace(/\n/g, "\n     ")}`);
    now += 60000;
  }
  if (meter.calls) log(`(model calls: ${meter.calls}, est. cost $${(meter.usd_micros / 1e6).toFixed(4)})`);
  Deno.exit(0);
}
async function save() { Deno.mkdirSync(STATE_DIR, { recursive: true }); Deno.writeTextFileSync(STATE_FILE, JSON.stringify({ mem: mem.dump(), now, as, alerts: alerts.dump(), posts: await jobs.all(), optedOut: channel.optOuts() } satisfies Saved)); }
// The same alerts run the scheduled function does, over the simulator's postings and people; new outbox rows go to the
// conversation store's proactive queue, which deliver() drains.
async function planAlerts() {
  const s = await runAlerts({ store: alerts, now, recentPostings: (since) => jobs.newSince(since), postingsById: (ids) => jobs.getMany(ids),
    outbox: { enqueue: async (userId, m) => { const fresh = await alerts.enqueue(userId, m); if (fresh) await mem.enqueueProactive(userId, { key: m.key, text: m.text, at: m.at }); return fresh; } } });
  if (s.alerts || s.reports || s.held) log(`  (alerts run: ${s.alerts} alert${s.alerts === 1 ? "" : "s"}, ${s.reports} report${s.reports === 1 ? "" : "s"}, ${s.held} held for the report)`);
}
function show(kind: string, bubbles: string[]) { for (const b of bubbles) log(`${kind === "proactive" ? "  ⟵ (Trainee, unprompted)" : "  ⟵"} ${b.replace(/\n/g, "\n     ")}`); }
async function deliver() {
  for (const o of await mem.drainProactive(now)) {
    if (await channel.optedOut(o.contact)) { log(`  (not sent to ${o.contact}: they texted STOP)`); continue; }
    if (o.contact === as) show("proactive", o.bubbles); else log(`  (queued for ${o.contact} delivered: ${o.bubbles[0].slice(0, 60)}…)`);
  }
}
const parseDelta = (s: string) => { const m = /^\+?(\d+)\s*(m|h|d)$/.exec(s.trim()); return m ? Number(m[1]) * ({ m: 60000, h: 3600000, d: 86400000 } as any)[m[2]] : null; };

async function line(input: string): Promise<boolean> {
  const t = input.trim();
  if (!t) return true;
  if (t === "/quit") return false;
  if (t.startsWith("/attach ")) {
    const path = t.slice(8).trim();
    try { const bytes = Deno.readFileSync(path); const ext = (path.split(".").pop() || "").toLowerCase(); pending.push({ name: path.split("/").pop()!, mime: MIME[ext] || "application/octet-stream", bytes }); log(`  (attached ${path}; it goes with your next text)`); }
    catch (e) { log(`  (couldn't read ${path}: ${e instanceof Error ? e.message : e})`); }
    return true;
  }
  // Attachments belong to the person they were attached for: switching person or forgetting one drops them.
  const dropPending = () => { if (pending.length) log(`  (dropped ${pending.length} attachment${pending.length === 1 ? "" : "s"} meant for ${as})`); pending = []; };
  if (t.startsWith("/as ")) { dropPending(); as = t.slice(4).trim(); log(`  (now texting as ${as})`); return true; }
  if (t === "/reset") { dropPending(); const p = await mem.userFor(as); if (p) await mem.forget(p.id); log(`  (forgot ${as}, including anything queued for them)`); return true; }
  if (t.startsWith("/alerts ")) {
    const [kw, places] = t.slice(8).split("|").map((x) => (x || "").split(",").map((w) => w.trim()).filter(Boolean));
    const p = await mem.ensureUser(as, now);
    const prev = await alerts.get(p.id);
    const v = validPrefs({ keywords: kw, locations: (places || []).filter((x) => x.toLowerCase() !== "remote"), remote_ok: true });
    if (!v.ok) { log(`  (${v.error})`); return true; }
    await alerts.save(startWatching(prev, { userId: p.id, prefs: v.prefs, tz: prev?.tz ?? "America/New_York", now }));
    log(`  (simulator: alerts on for ${as}: ${v.prefs.keywords.join(", ")}${v.prefs.locations.length ? ` in ${v.prefs.locations.join(", ")}` : " anywhere"}, remote ok; ${v.prefs.max_instant_per_day} instant a day, report at ${v.prefs.report_hour}:00)`);
    return true;
  }
  if (t === "/alerts-off") { const p = await mem.userFor(as); const r = p ? await alerts.get(p.id) : null; if (r) await alerts.save({ ...r, prefs: { ...r.prefs, on: false } }); log(`  (simulator: alerts off for ${as})`); return true; }
  if (t.startsWith("/post ")) {
    const [title, company, location] = t.slice(6).split("|").map((x) => x.trim());
    if (!title || !company) { log("  (use /post Title | Company | Location)"); return true; }
    const id = `${Math.floor(now / 1000)}-${Math.random().toString(36).slice(2, 6)}`, iso = new Date(now).toISOString();
    await jobs.putMany([{ job_id: `lever:simtest:${id}`, provider: "lever", board: "simtest", company, title, location: location || "", url: `https://example.test/jobs/${id}`, description: "", first_seen_at: iso, last_seen_at: iso, closed_at: null }]);
    log(`  (test posting added: ${title} at ${company}${location ? `, ${location}` : ""})`);
    return true;
  }
  if (t === "/state") { const p = await mem.userFor(as); log(JSON.stringify(p ? await mem.stores(p.id) : {}, null, 1)); return true; }
  if (t.startsWith("/clock")) {
    const d = parseDelta(t.slice(6)); if (d === null) { log("  (use /clock +30m, +2h or +1d)"); return true; }
    // Step in 5-minute runs, like the schedule, so quiet hours and the report hour land when they would.
    const end = now + d;
    const gmail = { send: async (_u: string, m: { to: string; subject: string }) => { log(`  (simulated Gmail, nothing really sent: to ${m.to}, "${m.subject}")`); return { status: "sent" as const, id: `sim-${now}`, thread_id: `sim-${now}` }; } };
    while (now < end) { now = Math.min(end, now + 300000); await planAlerts(); await deliver(); await runOutreachSends({ store: outreach, sender: gmail, now }); }
    log(`  (clock: ${new Date(now).toISOString()})`); return true;
  }
  log(`⟶ ${as}: ${t}`);
  const out = await handleInbound({ contact: as, text: t, at: now, attachments: pending }, { brain, store: mem, channel });
  pending = [];
  show("reply", out.bubbles);
  now += 60000;
  await deliver();
  return true;
}

log(`Trainee text simulator · brain: ${brainName} · you are ${as} · ${new Date(now).toISOString()}${saved ? " (resumed)" : ""}`);
if (script) {
  // A script line starting with "# " is a comment, never texted.
  for (const l of Deno.readTextFileSync(script).split("\n")) { if (l.startsWith("# ")) continue; if (!(await line(l))) break; }
} else {
  while (true) { const l = prompt(">"); if (l === null || !(await line(l))) break; }
}
await save();
if (meter.calls) log(`(model calls: ${meter.calls}, est. cost $${(meter.usd_micros / 1e6).toFixed(4)})`);
