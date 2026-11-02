// The scheduled alerts run (WO-007b), as a function of its inputs so it is testable without a database. pg_cron calls it
// every 5 minutes (scripts/launch/schedule-career-proactive.sql, run by the owner) with the shared secret. It plans and
// queues alerts and reports (career_outbox, once per key); delivery is the texting channel's (WO-013). Every run is
// recorded so a silent stop is visible.
// WO-091c: each rail runs on its own. A rail that fails (for one person or for all) is recorded in the run row (`errors`,
// by rail, and `error`, the first) with the counts of everything that did run; it never stops the rails after it. With
// `quiet`, a person who is paused, opted out or erased gets nothing started on their behalf: no alerts planned, no card,
// question or ask pushed, no mail read, no interview draft or digest queued. Outreach's claim reads the same state in
// the database, and delivery checks it again before a queued text goes out (channel.ts deliverDue).
import { equalSecret } from "../_shared/message_service.ts";
import { type QuestionRow, type ReceiptDue, runAlerts, runAsks, runCards, runDigest, runInterviewDrafts, runMail, runPrepareAhead, runQuestions, runReceipts, type ReadyRow, type RunStats } from "../_shared/career_proactive_run.ts";
import type { AheadCandidate, AheadOutcome, AheadStore } from "../_shared/career_prepare_ahead.ts";
import type { AskStore, ConfirmStore } from "../_shared/career_apply_confirm.ts";
import type { AlertStore, Outbox } from "../_shared/career_alert_store.ts";
import type { MailStore } from "../_shared/career_mail_store.ts";
import type { ReadResult } from "../_shared/career_mail_gmail.ts";
import type { MailModelWiring } from "../_shared/career_mail_model.ts";
import type { EventStore } from "../_shared/agent/timeline.ts";
import type { DigestStore, InterviewStore } from "../_shared/career_brief_store.ts";
import { type IntroDueRow, runIntroReminders } from "../_shared/career_people_reminders.ts";
import { runPeopleSweeps } from "../_shared/career_people_sweep.ts";
import { type ClosingRow, runClosing } from "../_shared/career_closing.ts";

export interface ProactiveDeps {
  env: { get(k: string): string | undefined };
  store: () => AlertStore & Outbox;
  recentPostings: (sinceIso: string) => Promise<any[]>;
  postingsById: (ids: string[]) => Promise<any[]>;
  // Applications that finished since a time (career_apply_jobs), for their receipts. Absent: no receipts this run.
  finishedApplications?: (sinceIso: string) => Promise<ReceiptDue[]>;
  // Applications prepared on the person's computer, not yet shown, and the push of one card (WO-022 step 3). Absent: no
  // cards this run.
  readyApplications?: () => Promise<ReadyRow[]>;
  pushCard?: (userId: string, ids: string[], text: string) => Promise<string | null>;
  // Mail tracking (WO-024): where events, drafts and cursors live, and the read of one person's new mail. Absent: no mail
  // is read this run. Nothing here sends mail.
  // WO-032: with `confirm`, the same mail confirms applications in the queue (only from the employer's own email).
  // model (WO-040): the second pass on ambiguous mail, only with CAREER_MAIL_MODEL=on. Absent: the rules alone.
  mail?: { store: () => MailStore; read: (userId: string, sinceMs: number, nowMs: number) => Promise<ReadResult>; confirm?: () => ConfirmStore; model?: () => MailModelWiring };
  // WO-032: open questions pushed once (career_apply_questions_push_as), and the asks about which application an
  // employer's email confirms. Absent: neither this run.
  questions?: { open: () => Promise<QuestionRow[]>; push: (userId: string, ids: string[], text: string) => Promise<boolean> };
  asks?: () => Pick<AskStore, "pending" | "push">;
  // The account timeline each receipt is also written to (WO-027). Absent: receipts only.
  events?: () => EventStore;
  // WO-034: interviews (an invite read by mail tracking is briefed in the same run; a dated interview gets its thank-you
  // and nudge drafted) and the weekly digest. Absent: none of the three this run. Nothing here sends mail.
  briefs?: { interviews: () => InterviewStore; drafts: () => Pick<MailStore, "applications" | "events" | "saveDraft">; digest: () => DigestStore };
  // WO-033: approved outreach (everything approved and due; only Gmail refusing slows a person, NO LIMITS), and the replies on threads already sent. Absent: none.
  // A failure here is reported in the run's answer and never stops the alerts.
  outreach?: (now: number) => Promise<Record<string, unknown>>;
  // MASS NETWORKING M5: replies understood, follow-ups and calls (career_outreach_replies.ts runRepliesLane). Absent: none.
  replies?: (now: number) => Promise<Record<string, unknown>>;
  // D-033 (people finding): introduction reminders whose date has come, queued to the outbox (the reminder only,
  // never the note). Wired only with CAREER_INTRO_REMINDERS=on. Absent: reminders stay in-chat only.
  introReminders?: { due: (nowIso: string) => Promise<IntroDueRow[]>; markReminded: (userId: string, n: number) => Promise<void>; canText?: (userId: string) => Promise<boolean> };
  // People finding: unfinished Gmail reads carried on in leased batches (career_people_sweep.ts runPeopleSweeps). Wired only
  // with CAREER_PEOPLE_SWEEP=on. Absent: a read goes on at the person's next ask.
  peopleSweeps?: Omit<Parameters<typeof runPeopleSweeps>[0], "awake">;
  // Reqs doc 2 Q344/Q322/Q348/Q355: the roles on people's apply lists not sent yet, with their postings (career_closing.ts):
  // one text the day before a stated closing date, one line once the posting is taken down. CAREER_CLOSING_NUDGE=off turns
  // it off. Absent: none this run.
  closing?: () => Promise<ClosingRow[]>;
  // WO-091c: who among these people is paused, opted out or erased (career_quiet_users). Absent: nobody is.
  quiet?: (userIds: string[]) => Promise<Set<string>>;
  // The watch records of people whose alerts were set by text (career_watch_kv, career:watch-profile:<user>), by user.
  // Absent, or a read that fails: those people get no alerts this run (career_proactive_run.ts, verifiedWatches).
  watches?: (userIds: string[]) => Promise<Map<string, unknown>>;
  // FEATURE 3 (D-011; G4): applications prepared before the person asks, and one card a day. Runs only with
  // CAREER_PREPARE_AHEAD=on. `prepare` is the queue path's preparation (workers/career-browser/prepare-ahead.ts
  // prepareOne), which needs the engine; absent, nothing is prepared this run.
  prepareAhead?: { store: () => AheadStore; prepare: (c: AheadCandidate) => Promise<AheadOutcome> };
  recordRun: (r: RunStats & { ms: number; error: string | null; at: string; errors?: Record<string, string> | null }) => Promise<void>;
  now: () => number;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleProactive(req: Request, d: ProactiveDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = d.env.get("CAREER_PROACTIVE_SECRET") || "";
  if (secret.length < 32) return json({ error: "not configured: CAREER_PROACTIVE_SECRET must be set, 32 characters or more" }, 503);
  if (!equalSecret(req.headers.get("x-trainee-proactive-secret") || "", secret)) return json({ error: "Unauthorized" }, 401);
  const started = d.now(), at = new Date(started).toISOString();
  const stats: RunStats = { users: 0, alerts: 0, held: 0, reports: 0, duplicates: 0, postings: 0 };
  const errors: Record<string, string> = {};
  // One rail: its result is taken; its failure is recorded with what it did for the people it reached (`partial`).
  const step = async <T>(name: string, run: () => Promise<T>, take: (v: T) => void) => {
    try { take(await run()); } catch (e) {
      errors[name] = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
      console.error(`career-proactive ${name} failed:`, errors[name]);
      const partial = (e as { partial?: T } | null)?.partial;
      if (partial !== undefined) take(partial);
    }
  };
  // The people a rail would act for, less those who are quiet. A control state that cannot be read starts nothing.
  const awake = async <T>(rows: T[], id: (r: T) => string): Promise<T[]> => {
    if (!d.quiet || !rows.length) return rows;
    const quiet = await d.quiet([...new Set(rows.map(id))]);
    return rows.filter((r) => !quiet.has(id(r)));
  };
  const store = d.store();
  const alertStore = d.quiet ? { ...store, active: async () => awake(await store.active(), (r) => r.id) } : store;
  await step("alerts", () => runAlerts({ store: alertStore, outbox: store, now: started, recentPostings: d.recentPostings, postingsById: d.postingsById, watches: d.watches }), (s) => Object.assign(stats, s));
  // FEATURE 3: before the cards rail, so the day's card (with its coverage and stops) is the one shown, and a card held
  // back is tried again here first.
  if (d.prepareAhead && d.env.get("CAREER_PREPARE_AHEAD") === "on") {
    const pa = d.prepareAhead;
    await step("prepare_ahead", () => runPrepareAhead({ store: alertStore, now: started, recentPostings: d.recentPostings, watches: d.watches, ahead: pa.store(), prepare: pa.prepare }), (s) => {
      Object.assign(stats, { ahead_people: s.people, ahead_picked: s.picked, ahead_ready: s.ready, ahead_cards: s.cards });
    });
  }
  // PROACTIVE SCENARIOS (2026-10-29): receipts too wait for a quiet person. They were queued for a paused or opted-out
  // person and then dropped at delivery (skipped_opt_out, once per key ever), so the person who resumed the next morning
  // never heard how their application ended. Now nothing is queued while they are quiet, and a resume inside the receipt
  // window (26 hours) says it then.
  if (d.finishedApplications) {
    const finished = d.finishedApplications;
    await step("receipts", () => runReceipts({ outbox: store, now: started, finished: async (since) => awake(await finished(since), (r) => r.user_id), events: d.events ? d.events() : null }), (n) => { stats.receipts = n; });
  }
  if (d.closing && d.env.get("CAREER_CLOSING_NUDGE") !== "off") {
    const closing = d.closing;
    await step("closing", () => runClosing({ outbox: store, now: started, rows: async () => awake(await closing(), (r) => r.user_id) }), (n) => { stats.closing = n; });
  }
  if (d.readyApplications && d.pushCard) {
    const ready = d.readyApplications;
    await step("cards", () => runCards({ now: started, ready: async () => awake(await ready(), (r) => r.user_id), push: d.pushCard! }), (n) => { stats.cards = n; });
  }
  const interviews = d.briefs ? d.briefs.interviews() : null;
  if (d.mail) {
    const mail = d.mail, mailStore = mail.store();
    const people = d.quiet ? { ...mailStore, people: async (n: number) => awake(await mailStore.people(n), (p) => p.user_id) } : mailStore;
    await step("mail", () => runMail({ outbox: store, now: started, store: people, read: mail.read, briefs: interviews, confirm: mail.confirm ? mail.confirm() : null, model: mail.model ? mail.model() : null }), (m) => {
      if (m.model) Object.assign(stats, { mail_model: m.model, mail_model_calls: m.model_calls ?? 0, mail_model_decided: m.model_decided ?? 0, mail_model_capped: m.model_capped ?? 0 }, m.model_ask ? { mail_model_ask: m.model_ask } : {});
      stats.statuses = m.statuses;
      stats.followups = m.followups;
      stats.briefs = m.briefs;
      stats.brief_ms_max = m.brief_ms_max;
      if (mail.confirm) stats.confirmations = m.confirmations;
    });
  }
  if (d.briefs && interviews) {
    const iv = d.quiet ? { ...interviews, dated: async (a: string, b: string) => awake(await interviews.dated(a, b), (p) => p.user_id) } : interviews;
    const digest = d.briefs.digest(), dg = d.quiet ? { ...digest, people: async (now: number) => awake(await digest.people(now), (p) => p.user_id) } : digest;
    await step("interview_drafts", () => runInterviewDrafts({ outbox: store, now: started, interviews: iv, drafts: d.briefs!.drafts() }), (n) => { stats.followups = (stats.followups ?? 0) + n; });
    await step("digest", () => runDigest({ outbox: store, now: started, store: dg }), (n) => { stats.digests = n; });
  }
  // After cards and mail: a card or an ask pushed this run keeps the thread busy, so these wait their turn.
  if (d.asks) {
    const asks = d.asks();
    await step("asks", () => runAsks({ now: started, store: { pending: async () => awake(await asks.pending(), (a) => a.user_id), push: asks.push } }), (n) => { stats.asks = n; });
  }
  if (d.questions) {
    const q = d.questions;
    await step("questions", () => runQuestions({ now: started, open: async () => awake(await q.open(), (r) => r.user_id), push: q.push }), (n) => { stats.questions = n; });
  }
  if (d.introReminders) {
    const ir = d.introReminders;
    await step("intro_reminders", () => runIntroReminders({ due: async (iso) => awake(await ir.due(iso), (r) => r.userId), outbox: store, now: started, markReminded: ir.markReminded, canText: ir.canText }), (n) => { stats.intro_reminders = n; });
  }
  if (d.peopleSweeps) {
    const ps = d.peopleSweeps;
    await step("people_sweeps", () => runPeopleSweeps({ ...ps, awake: (rows) => awake(rows, (r) => r.user_id) }), (n) => { stats.people_sweeps = n; });
  }
  const sent: { outreach?: Record<string, unknown>; replies?: Record<string, unknown> } = {};
  if (d.outreach) await step("outreach", () => d.outreach!(started), (r) => { sent.outreach = r; });
  if (errors.outreach) sent.outreach = { error: errors.outreach };
  if (d.replies) await step("replies", () => d.replies!(started), (r) => { sent.replies = r; });
  if (errors.replies) sent.replies = { error: errors.replies };
  const ms = d.now() - started;
  const failed = Object.keys(errors);
  const error = failed.length ? errors[failed[0]] : null;
  try {
    await d.recordRun({ ...stats, ms, error, at, errors: failed.length ? errors : null });
  } catch (e) {
    console.error("career-proactive: the run was not recorded:", e instanceof Error ? e.message : String(e));
    if (!failed.length) return json({ error: "run not recorded", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
  const body = { ...stats, ...sent, ms, ...(failed.length ? { errors } : {}) };
  return failed.length ? json({ error: "alerts run failed", detail: error, ...body }, 500) : json(body);
}
