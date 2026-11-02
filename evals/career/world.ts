// WO-100: one seeded person (evals/career/worlds/*.json, SYNTHETIC) and one turn through agent-chat's career dispatch, in
// the handler's order over in-memory stores: the situation read once -> the chat input (redaction) -> card -> questions ->
// outreach -> the brain (router: CareerHost.runTurn; agent: agentTurn with the person block and the tools). Each thread
// keeps its own snapshot and history; a new thread starts empty, as the web app's ownerThread does. The database reads
// readSituation makes go through a fake client whose tables are the stores here, so the production read path runs.
// Used by tests/architect/wo-100-situation-conversations.test.ts, scripts/text.ts --world and run-conversations --set in-flight.
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { CareerPool } from "../../supabase/functions/_shared/career_pool.js";
import { agentTurn } from "../../supabase/functions/agent-chat/career_brain.ts";
import { chatInput } from "../../supabase/functions/agent-chat/_shared/chat_input.ts";
import { redactionNote } from "../../supabase/functions/_shared/identity_redact.ts";
import { memoryStandingStore, summarizePipeline } from "../../supabase/functions/_shared/agent/memory.ts";
import { memoryPostingsDb, searchWords } from "../../supabase/functions/_shared/career_ingest.ts";
import { memoryAlertStore, startWatching, validPrefs } from "../../supabase/functions/_shared/career_alert_store.ts";
import { DEFAULT_PREFS } from "../../supabase/functions/_shared/career_alerts.ts";
import { memoryWantStore } from "../../supabase/functions/_shared/career_apply_want.ts";
import { CARD_INTENT, cardTurn } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { QUESTIONS_INTENT, questionsTurn } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { memoryOutreachStore, outreachTurn } from "../../supabase/functions/_shared/career_outreach.ts";
import { memoryEventStore } from "../../supabase/functions/_shared/agent/timeline.ts";
import { appsFromQueue, appsFromTracker } from "../../supabase/functions/_shared/career_mail_store.ts";
import { mergeApps } from "../../supabase/functions/_shared/career_mail.ts";
import { missingIntegration } from "../../supabase/functions/_shared/agent/integrations.ts";
// Absent before WO-100 (the fail-first run measures trunk without them).
const S: any = await import("../../supabase/functions/_shared/career_situation.ts").catch(() => null);
const C: any = await import("../../supabase/functions/_shared/career_capabilities.ts").catch(() => null);

export const USER = "TEST-U";
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// A client that answers readSituation's selects from the stores; filters are the caller's business (situationFrom
// filters again in code). A table named in `fail` answers with an error.
export function fakeAdmin(tables: Record<string, () => unknown>, fail: Set<string> = new Set()) {
  return {
    from(t: string) {
      let single = false;
      const b: any = {
        then(ok: any, bad: any) {
          const run = async () => {
            if (fail.has(t)) return { data: null, error: { message: `${t} is down (test)` } };
            const rows = (await tables[t]?.()) ?? [];
            return { data: single ? (rows as any[])[0] ?? null : rows, error: null };
          };
          return run().then(ok, bad);
        },
      };
      for (const m of ["select", "eq", "in", "or", "order", "limit", "gte", "not", "neq"]) b[m] = () => b;
      b.maybeSingle = () => { single = true; return b; };
      return b;
    },
  };
}

export async function openWorld(file: any, o: { postings?: any[]; fail?: Set<string> } = {}) {
  const now = Date.parse(file.now);
  const jobs = clone(file.apply_jobs ?? []), prepared = clone(file.prepared ?? []), questions = clone(file.questions ?? []);
  const cards: any[] = []; let shown: any = null;
  const threads = new Map<string, { snapshot: any; history: { role: "user" | "assistant"; content: string }[]; intent: string | null }>();
  const th = (id: string) => { if (!threads.has(id)) threads.set(id, { snapshot: null, history: [], intent: null }); return threads.get(id)!; };
  const cardStore = {
    async pending() { return prepared.filter((p: any) => p.state === "ready" || p.state === "shown").map((p: any) => ({ id: p.id, company: p.company, card_lines: p.card_lines, created_at: p.created_at })); },
    async open(_u: string, ids: string[]) { const c = { id: `card-${cards.length + 1}`, items: ids.map((id, i) => ({ n: i + 1, prepared_id: id, payload_hash: "x" })), shown_at: new Date(now).toISOString(), state: "open" }; cards.push(c); for (const p of prepared) if (ids.includes(p.id)) p.state = "shown"; return c; },
    async latestOpen() { return cards.filter((c) => c.state === "open").at(-1) ?? null; },
    async answer(_u: string, id: string, approve: number[]) {
      const c = cards.find((x) => x.id === id)!; c.state = "answered";
      return c.items.map((it: any) => { const p = prepared.find((x: any) => x.id === it.prepared_id)!; const ok = approve.includes(it.n); p.state = ok ? "approved" : "declined"; return { n: it.n, company: p.company, result: ok ? "queued" : "declined" }; });
    },
    async lastAssistantIntent(t: string) { return th(t).intent; },
  };
  const questionStore = {
    async open(_u: string, limit: number) { return questions.filter((q: any) => q.answer === null).slice(0, limit); },
    async countOpen() { return questions.filter((q: any) => q.answer === null).length; },
    async get(_u: string, ids: string[]) { return questions.filter((q: any) => ids.includes(q.id)); },
    async answer(_u: string, id: string, a: string) { const q = questions.find((x: any) => x.id === id); if (q) q.answer = a; },
    async shown() { return shown; }, async setShown(_u: string, s: any) { shown = clone(s); },
    async lastAssistantIntent(t: string) { return th(t).intent; },
  };
  const outreach = memoryOutreachStore();
  if (file.outreach?.length) await outreach.saveBatch(USER, "A", clone(file.outreach), Date.parse(file.outreach[0].created_at));
  const wants = memoryWantStore();
  await wants.put(USER, (file.wanted ?? []).map(({ state: _s, taken_at: _t, ...w }: any) => w));
  const alerts = memoryAlertStore();
  if (file.alerts) {
    const v = validPrefs(file.alerts.input, DEFAULT_PREFS);
    if (!v.ok) throw new Error(v.error);
    await alerts.save(startWatching(null, { userId: USER, prefs: v.prefs, tz: file.alerts.tz, now: Date.parse(file.alerts.since) }));
  }
  const memory = memoryStandingStore({ [USER]: clone(file.standing ?? []) });
  const all = [...(o.postings ?? []), ...(file.postings ?? [])];
  const postingsDb = memoryPostingsDb();
  await postingsDb.putMany(all.map((p: any) => ({ ...p, provider: p.job_id.split(":")[0], board: p.job_id.split(":")[1], last_seen_at: p.first_seen_at, closed_at: null })));
  const kb = all.map((p: any) => CareerPool.mapKbPosting({ posting_key: p.job_id, title: p.title, company: p.company, location: p.location, url: p.url, text_excerpt: p.description, source: p.job_id.split(":")[0], posted_at: p.posted_at, fetched_on: file.now.slice(0, 10) },
    { roleFamily: core.CareerJobs.roleFamily, seniorityBand: core.CareerJobs.seniorityBand, stripHtml: core.CareerJobs.stripHtml })).filter(Boolean);
  const events = memoryEventStore();
  const trackRows = () => [...threads.values()].flatMap((t) => t.snapshot?.stores?.trackStore?.rows ?? []);
  const mail = { async applications() { return mergeApps(appsFromQueue(jobs), appsFromTracker(trackRows())); }, async events() { return []; } };
  const admin = fakeAdmin({
    career_apply_jobs: () => jobs, career_apply_prepared: () => prepared.filter((p: any) => ["ready", "shown"].includes(p.state)),
    career_apply_wanted: async () => (await wants.list(USER)).map((w: any) => ({ ...w, taken_at: null })),
    career_apply_cards: () => cards.filter((c) => c.state === "open").reverse(),
    career_apply_questions: () => questions.filter((q: any) => q.answer === null),
    career_outreach_drafts: () => outreach.dump().drafts.filter((d) => d.user_id === USER),
    career_alert_prefs: async () => { const r = await alerts.get(USER); return r ? [{ prefs: r.prefs, tz: r.tz }] : []; },
    career_watch_kv: async () => [{ key: "career:standing", value: { items: await memory.standing(USER) } }],
    agent_flow_state: () => [...threads.entries()].map(([thread_id, t]) => ({ thread_id, rows: t.snapshot?.stores?.trackStore?.rows ?? null })),
    user_oauth_connections: () => clone(file.connections ?? []),
    career_apply_cloud_optin: () => (file.cloud ? [file.cloud] : []), channel_contacts: () => (file.channel ? [file.channel] : []),
    career_events: () => events.recall(USER, { kinds: ["search"], limit: 1 }),
  }, o.fail);
  const H = CareerHost.createCareerHost({ CareerAccess: core.CareerAccess, CareerOnboarding: core.CareerOnboarding, CareerRouter: core.CareerRouter, CareerDoorstep: core.CareerDoorstep, CareerReply: core.CareerReply, CareerContainment: core.CareerContainment });
  // Thread A is the person's earlier conversation: their facts confirmed, Plaid in the tracker.
  const ctx: any = H.createTurnCtx({ userId: USER, threadId: "A", now: now - 86400000, snapshot: null });
  ctx.profile = core.CareerProfile.createProfile({});
  for (const f of file.facts ?? []) { const x = core.CareerProfile.addFact(ctx.profile, { ...f, needs_confirmation: true, status: "draft" }); core.CareerProfile.confirmFact(ctx.profile, x.id); }
  ctx.trackStore = core.CareerTrack.createMemoryStore([]);
  for (const a of file.tracked ?? []) core.CareerTrack.addApplication(ctx.trackStore, a, { now: now - 86400000 });
  th("A").snapshot = H.extractSnapshot(ctx);
  return { now, file, jobs, prepared, questions, cards, cardStore, questionStore, outreach, wants, alerts, memory, postingsDb, events, mail, threads, th, kb, admin, H, account: { stated_facts: null as any } };
}
export type World = Awaited<ReturnType<typeof openWorld>>;

export interface Seen { system: string; calls: { name: string; input: unknown }[]; results: { tool: string; content: string; is_error: boolean }[] }
// One turn. The model (agent brain) is any ModelFn; what it was shown (system prompt, tool results) comes back in `seen`.
// Review of #368 (2026-11-02): handler-career.ts runs these code turns before the router, in this order (the order is read
// from the handler's source by tests/architect/one-v-one-texting.test.ts, which fails when the two differ). With
// o.production the harness runs every one marked "runs", in the handler's order, over the world's stores; the others need a
// live service, a flag that is off by default, or a structured request a texted message never carries, and say which.
export const CODE_TURN_ORDER: { name: string; harness: "runs" | string }[] = [
  { name: "connectorChatTurn", harness: "needs the live connector service (connect links)" },
  { name: "siteRefusedTurn", harness: "needs the people-finding site list (live fetch)" },
  { name: "outlookChatTurn", harness: "needs the live Outlook (Microsoft Graph) service" },
  { name: "cardTurn", harness: "runs" },
  { name: "mockTurn", harness: "needs the mock-interview store (Supabase only)" },
  { name: "plannerTurn", harness: "CAREER_PLANNER is off by default" },
  { name: "questionsTurn", harness: "runs" },
  { name: "confirmWhichTurn", harness: "answers only a pending which-one ask the world never holds" },
  { name: "emailTurn", harness: "needs the live employer-email code service" },
  { name: "outreachTurn", harness: "runs" },
  { name: "repliesTurn", harness: "needs the outreach-replies store (Supabase only)" },
  { name: "cloudTurn", harness: "needs the cloud opt-in store (Supabase only)" },
  { name: "cloudCardYesTurn", harness: "needs a signed-in session (bridge calls skip it)" },
  { name: "paceTurn", harness: "needs the pace RPC (Supabase only)" },
  { name: "screenTapTurn", harness: "answers only a Telegram button tap" },
  { name: "screenAnswerTurn", harness: "answers only a pending screening question the world never holds" },
  { name: "employerAnswerTurn", harness: "answers only a pending employer question the world never holds" },
  { name: "billingTurn", harness: "needs Stripe (billing)" },
  { name: "cancelTurn", harness: "needs the cancel RPC (Supabase only)" },
  { name: "undoTurn", harness: "needs the undo store (Supabase only)" },
  { name: "applyHereTurn", harness: "Telegram only, with CAREER_APPLY_HERE and a live board fetch" },
  { name: "applyTurn", harness: "runs" },
  { name: "receiptTurn", harness: "needs the receipts table (Supabase only)" },
  { name: "followupTurn", harness: "runs" },
  { name: "standingTurn", harness: "runs" },
  { name: "reminderTurn", harness: "runs" },
  { name: "overviewTurn", harness: "runs" },
  { name: "applicationsTurn", harness: "runs" },
  { name: "networkingTurn", harness: "runs" },
  { name: "offerChatTurn", harness: "runs" },
  { name: "outreachStatusTurn", harness: "needs the send-rail RPC (Supabase only)" },
];

export async function worldTurn(w: World, o: { brain: "agent" | "router"; threadId: string; message: string; now: number; model?: (p: any) => Promise<any>; channel?: string; production?: boolean }) {
  const t = w.th(o.threadId), now = o.now;
  const situation = S ? await S.readSituation(w.admin, USER, now) : null;
  const input: any = (chatInput as any)(o.message, [], 4000, { codePending: S ? S.codePending(situation) : false });
  const message: string = input.message, note = redactionNote(input.redacted);
  const ctx: any = w.H.createTurnCtx({ userId: USER, threadId: o.threadId, now, accountPersistence: true, snapshot: t.snapshot, account: w.account, postings: w.kb });
  if (situation && C) ctx.statusRecords = C.statusRecordsFrom(situation.capabilities);
  const controlled = w.H.isHostControlled(message, ctx);
  let out: { reply: string; intent: string | null; handler: string }, seen: Seen | null = null;
  const card = !controlled ? await cardTurn({ message, userId: USER, threadId: o.threadId, now, store: w.cardStore as any }) : null;
  const asked = !card && !controlled ? await questionsTurn({ message, userId: USER, threadId: o.threadId, now, store: w.questionStore as any, situation } as any) : null;
  const gmailOn = situation ? situation.capabilities.some((c: any) => c.id === "gmail_send" && c.status === "on") : false;
  const outAns = !card && !asked && !controlled
    ? await outreachTurn({ message, userId: USER, threadId: o.threadId, now, store: w.outreach, gmailConnected: async () => gmailOn, connectAsk: missingIntegration("gmail") }).catch(() => null) : null;
  // o.production: the rest of the handler's code turns, in its order (CODE_TURN_ORDER), each only when none before it answered.
  const later = o.production && !card && !asked && !outAns && !controlled ? await productionTurns(w, { message, threadId: o.threadId, now, ctx, situation, snapshot: t.snapshot, channel: o.channel ?? null }) : null;
  if (card) out = { reply: card.reply, intent: ["shown", "not_on_card", "change"].includes(card.status) ? CARD_INTENT : "career_apply_card_answer", handler: "code:cards" };
  else if (asked) out = { reply: asked.reply, intent: ["shown", "partial"].includes(asked.status) ? QUESTIONS_INTENT : "career_apply_questions_answer", handler: "code:questions" };
  else if (outAns) out = { reply: outAns.reply, intent: outAns.intent, handler: "code:outreach" };
  else if (later) out = later;
  else if (o.brain === "agent" && !controlled) {
    const s: Seen = { system: "", calls: [], results: [] };
    let step = 0;
    const model = async (p: any) => {
      if (!s.system) s.system = p.system;
      const last = p.messages.at(-1);
      if (step++ > 0 && Array.isArray(last?.content)) for (const b of last.content) if (b.type === "tool_result") s.results.push({ tool: (s.calls as any[]).find((c) => c.id === b.tool_use_id)?.name, content: String(b.content), is_error: !!b.is_error });
      const r = await o.model!(p);
      for (const b of r.content ?? []) if (b.type === "tool_use") (s.calls as any[]).push({ id: b.id, name: b.name, input: b.input });
      return r;
    };
    const alertRow = await w.alerts.get(USER);
    const since = now - 3 * 86400000;
    const pipeline = S ? null : summarizePipeline({ prepared: w.prepared.filter((p: any) => ["ready", "shown"].includes(p.state)), openCard: null, openQuestions: w.questions.filter((q: any) => q.answer === null).length,
      jobs: w.jobs.filter((j: any) => Date.parse(j.updated_at) >= since || ["queued", "driving", "needs_user"].includes(j.state)) }, now);
    const r = await agentTurn({ message, history: t.history, stores: ctx, userId: USER, threadId: o.threadId, now, model, postings: (q: string) => w.postingsDb.search(searchWords(q), 150), alerts: w.alerts,
      known: { standing: await w.memory.standing(USER), alerts: alertRow ? { prefs: alertRow.prefs, tz: alertRow.tz } : null, pipeline, situation } as any,
      memory: w.memory, mail: w.mail as any, events: w.events, wants: w.wants, posting: (id: string) => w.postingsDb.get(id), outreach: { store: w.outreach, model: null }, channel: o.channel ?? null });
    seen = s;
    out = { reply: r.reply, intent: (r as any).show?.intent ?? "agent", handler: "agent" };
  } else {
    const r = w.H.runTurn(message, ctx);
    out = { reply: r.reply, intent: r.intent, handler: `router:${r.intent}` };
  }
  t.snapshot = w.H.extractSnapshot(ctx);
  if (ctx._hostPatch?.stated_facts) w.account.stated_facts = ctx._hostPatch.stated_facts;
  t.history.push({ role: "user", content: message }, { role: "assistant", content: out.reply });
  t.intent = out.intent; w.outreach.setIntent(o.threadId, out.intent);
  return { ...out, reply: note ? `${note} ${out.reply}` : out.reply, message, seen, situation };
}

// The handler's code turns after outreach (CODE_TURN_ORDER "runs"), with the world's stores in place of Supabase's. Each runs
// only when none before it answered, as in handler-career.ts.
async function productionTurns(w: World, a: { message: string; threadId: string; now: number; ctx: any; situation: any; snapshot: any; channel: string | null }): Promise<{ reply: string; intent: string | null; handler: string } | null> {
  const { applyTurn } = await import("../../supabase/functions/_shared/career_apply_chat.ts");
  const { supabaseApplications } = await import("../../supabase/functions/_shared/career_apply_status.ts");
  const { applicationsTurn } = await import("../../supabase/functions/_shared/career_apply_status.ts");
  const { standingTurn, supabaseStanding } = await import("../../supabase/functions/_shared/career_standing.ts");
  const { reminderTurn, memoryReminderStore } = await import("../../supabase/functions/_shared/career_reminders.ts");
  const { overviewTurn } = await import("../../supabase/functions/_shared/career_overview.ts");
  const { followupTurn } = await import("../../supabase/functions/_shared/career_inbox_followups.ts");
  const { networkingTurn } = await import("../../supabase/functions/_shared/career_networking.ts");
  const { offerChatTurn } = await import("../../supabase/functions/_shared/career_offer_chat.ts");
  const quiet = <T>(p: Promise<T>) => p.catch(() => null);
  const { message, now } = a;
  const apps = () => supabaseApplications(w.admin)(USER);
  const applied: any = await quiet(applyTurn({ message, userId: USER, now, postings: w.postingsDb as any, wants: w.wants as any, apps, facts: [],
    shortlist: a.snapshot?.stores?.discovery?.lastShortlist ?? null } as any));
  if (applied) return { reply: applied.reply, intent: "career_apply_queue", handler: "code:apply" };
  const f08: any = await quiet(followupTurn({ message, userId: USER, threadId: a.threadId, now, deps: {
    read: supabaseStanding(w.admin), outreach: w.outreach, events: w.events, lastAssistant: async () => null, addressOnRecord: async () => null, name: () => null,
    markSent: async () => {}, mailOn: false, readNow: async () => null, sendOn: false, canSend: async () => false, send: async () => { throw new Error("no send in the harness"); },
    connectAsk: missingIntegration("gmail") } } as any));
  if (f08) return { reply: f08.reply, intent: f08.intent ?? "career_followup", handler: "code:followup" };
  const stood: any = (await quiet(standingTurn({ message, userId: USER, now, read: supabaseStanding(w.admin) })))
    // A person texting on iMessage, SMS, WhatsApp or Telegram is reachable there (their own linked channel); on the web app,
    // nothing links one in the world.
    ?? (await quiet(reminderTurn({ message, userId: USER, now, store: (w as any).reminders ??= memoryReminderStore({ zones: { [USER]: "America/Chicago" }, reachable: { [USER]: !!a.channel && a.channel !== "web" } }) })))
    ?? overviewTurn({ message, situation: a.situation, now } as any);
  if (stood) return { reply: stood.reply, intent: stood.intent ?? "career_status", handler: "code:standing" };
  const status: any = await quiet(applicationsTurn({ message, userId: USER, now, read: supabaseApplications(w.admin) }));
  if (status) return { reply: status.reply, intent: status.intent ?? "career_apply_status", handler: "code:applications" };
  const net: any = await quiet(networkingTurn({ message, userId: USER, threadId: a.threadId, now, state: a.ctx, store: w.outreach as any, events: w.events as any, model: null, people: null }));
  if (net) return { reply: net.reply, intent: net.intent, handler: "code:networking" };
  const offered: any = await quiet(offerChatTurn({ message, now, state: a.ctx.offerBenchmark ?? null, postings: w.postingsDb as any }));
  if (offered?.state) a.ctx.offerBenchmark = offered.state;
  if (offered?.answer) return { reply: offered.answer.reply, intent: offered.answer.intent ?? "career_offer", handler: "code:offer" };
  return null;
}
