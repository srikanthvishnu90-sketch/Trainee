// REQS DOC 1 (Q21, Q249, Q34): "what did you do today?", "what did you send this week?", "how many applications did you
// send?" answered by code with counts from the records, the window named, the counting method said. Outcome checks: the
// counts equal the seeded career_apply_jobs and career_outreach_drafts rows inside the person's own day, through the REAL
// handler (handleChat) on real Postgres; the pure parts (the asks, the window across a daylight-saving change, the text)
// are checked on their own first.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/reqs-doc1-activity.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import { activityAsk, activityText, activityTurn, localMidnight, METHOD, windowOf, type ActivityRows } from "../../supabase/functions/_shared/career_activity.ts";
import { receiptAsk } from "../../supabase/functions/_shared/career_apply_receipt_read.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const HOUR = 3_600_000, DAY = 86_400_000;
// Tuesday 2026-11-03, 3:00 PM in Chicago (CST, after the daylight-saving change on Nov 1) = 21:00 UTC.
const T0 = Date.UTC(2026, 10, 3, 21, 0);
const CHI = "America/Chicago";
const iso = (t: number) => new Date(t).toISOString();
const BANNED = /great question|let me know if|anything else|happy to help|how can i help/i;

Deno.test("ACT/1 the asks: today, yesterday and the week; a receipt, a status or a search ask is not one", () => {
  eq(activityAsk("how much did we do today?"), { span: "today", said: true });
  eq(activityAsk("what did you do today"), { span: "today", said: true });
  eq(activityAsk("hey what did you send today?"), { span: "today", said: true });
  eq(activityAsk("What have you done for me this week?"), { span: "week", said: true });
  eq(activityAsk("how many applications did you send this week"), { span: "week", said: true });
  eq(activityAsk("how many emails have you sent"), { span: "week", said: false });
  eq(activityAsk("what did you get done yesterday"), { span: "yesterday", said: true });
  eq(activityAsk("give me a recap of today"), { span: "today", said: true });
  eq(activityAsk("daily recap"), { span: "today", said: true });
  eq(activityAsk("what did you send"), { span: "week", said: false });
  eq(activityAsk("what have you been up to lately"), { span: "week", said: true });
  eq(activityAsk("what emails did you send today"), { span: "today", said: true });
  eq(activityAsk("what applications have you submitted this week?"), { span: "week", said: true });
  for (const m of ["what did you send to Acme", "what did you send Acme exactly", "what emails did you send to Acme", "what applications did you send to Stripe", "where are my applications", "any update?", "find me data analyst jobs today",
    "what did you do with my resume", "what should I do today", "recap", "summary", "what did I apply to", "show me the receipt for Stripe"]) eq(activityAsk(m), null, m);
  // Before: the receipt ask read "today" as a company. The handler now asks the activity turn first (ACT/5).
  assert(receiptAsk("what did you send today"), "the receipt ask still matches it on its own, so the handler's order is what fixes it");
});

Deno.test("ACT/2 the window: the person's own midnight, across a daylight-saving change; no zone is UTC and said", () => {
  eq(localMidnight(2026, 11, 3, CHI), Date.UTC(2026, 10, 3, 6), "CST midnight is 06:00 UTC");
  eq(localMidnight(2026, 10, 31, CHI), Date.UTC(2026, 9, 31, 5), "CDT midnight is 05:00 UTC");
  eq(localMidnight(2026, 11, 1, CHI), Date.UTC(2026, 10, 1, 5), "the change day starts in CDT");
  const today = windowOf("today", T0, CHI);
  eq([today.from, today.to, today.zoneSaid], [Date.UTC(2026, 10, 3, 6), T0, false]);
  assert(/^Today \(since midnight, America\/Chicago\)$/.test(today.label), today.label);
  const y = windowOf("yesterday", T0, CHI);
  eq([y.from, y.to], [Date.UTC(2026, 10, 2, 6), Date.UTC(2026, 10, 3, 6)]);
  const w = windowOf("week", T0, CHI);
  eq(w.from, Date.UTC(2026, 9, 28, 5), "7 calendar days: Oct 28 (CDT) to today");
  assert(/^The last 7 days \(Oct 28 to Nov 3, America\/Chicago\)$/.test(w.label), w.label);
  const u = windowOf("today", T0, null);
  eq([u.from, u.zoneSaid], [Date.UTC(2026, 10, 3), true]);
  assert(/UTC, since I don't have your time zone/.test(u.label), u.label);
  eq(windowOf("today", T0, "Not/AZone").zoneSaid, true, "an unusable zone is never used");
});

// created: queued; sent: the receipt's finish (null: no receipt); confirmed: the employer's email; updated: the status's last change.
const app = (company: string, state: string, o: { created: number; sent?: number | null; confirmed?: number; updated?: number }) => ({ company, state,
  created_at: iso(o.created), sent_at: o.sent == null ? null : iso(o.sent), email_confirmed_at: o.confirmed == null ? null : iso(o.confirmed),
  updated_at: iso(o.updated ?? Math.max(o.created, o.sent ?? 0, o.confirmed ?? 0)) });
const mail = (name: string, firm: string, status: string, at: number) => ({ name, firm, status, sent_at: iso(at) });

Deno.test("ACT/3 the text: a send counted on its receipt's day, a confirmation on its email's day; days with work only completed work; the method said", () => {
  const start = Date.UTC(2026, 10, 3, 6); // Nov 3 midnight in Chicago
  const rows: ActivityRows = { tz: CHI, receipts: true, apps: [
    app("Acme", "confirmed", { created: start + HOUR, sent: start + 2 * HOUR, confirmed: start + 3 * HOUR }),
    app("Globex", "submitted_unconfirmed", { created: start + HOUR, sent: start + 3 * HOUR }),
    app("Hooli", "needs_user", { created: start + 4 * HOUR }),
    app("Umbrella", "queued", { created: start + 5 * HOUR }),
    app("Initech", "failed", { created: start - 2 * DAY, updated: start + 6 * HOUR }),
    app("Oldco", "confirmed", { created: start - 3 * DAY, sent: start - 3 * DAY, confirmed: start - 3 * DAY }), // Oct 31
    app("Lastnight", "submitted_unconfirmed", { created: start - 1, sent: start - 1 }), // one millisecond before midnight
    // The review's case: sent Oct 30, the employer's confirmation arrived today. Sent on Oct 30, confirmed today.
    app("Latecon", "confirmed", { created: start - 4 * DAY, sent: start - 4 * DAY + HOUR, confirmed: start + HOUR }),
    // Sent, no receipt: its status changed today, but its send time is not on record.
    app("Nosend", "submitted_unconfirmed", { created: start - 5 * DAY, updated: start + 2 * HOUR }),
    // Confirmed Oct 31, the row touched again today (updated_at today): the confirmation is Oct 31's, never today's.
    app("Retouch", "confirmed", { created: start - 3 * DAY, sent: start - 3 * DAY, confirmed: start - 3 * DAY + HOUR, updated: start + 4 * HOUR }),
    // A day with only a failure (Oct 29) is no day with work.
    app("Failday", "failed", { created: start - 5 * DAY, updated: start - 5 * DAY + HOUR }),
  ], emails: [mail("Maya Chen", "Ramp", "sent", start + HOUR), mail("Leo Park", "Stripe", "bounced", start + 2 * HOUR), mail("Old Sent", "Brex", "sent", start - DAY),
    mail("Still Sending", "Mercury", "sending", start + 3 * HOUR), mail("Failed Send", "Plaid", "failed", start + 3 * HOUR)] };
  const t = activityText(rows, windowOf("today", T0, CHI), { span: "today", said: true });
  eq(t.status, "shown");
  eq(t.reply.split("\n")[0], "Today (since midnight, America/Chicago): 4 applications approved and queued, 2 sent to the employer (1 confirmed by the employer so far, 1 not confirmed yet), 2 employer confirmations received and 2 emails sent from your account.");
  assert(/^Sent and confirmed by the employer: Acme\.$/m.test(t.reply) && /^Sent, no confirmation from the employer yet: Globex\.$/m.test(t.reply), t.reply);
  assert(/^Employer confirmations received: Acme, Latecon\.$/m.test(t.reply), `a confirmation counts on the day its email arrived: ${t.reply}`);
  assert(!/^Sent[^\n]*Latecon/m.test(t.reply), `Latecon was sent Oct 30, not today: ${t.reply}`);
  assert(/^Sent, but the send time is not on record, so not counted as sent here: Nosend\.$/m.test(t.reply), t.reply);
  assert(/Stopped, waiting on you: Hooli\./.test(t.reply) && /Did not go through: Initech\./.test(t.reply) && /Queued and not sent yet: Umbrella\./.test(t.reply), t.reply);
  assert(/Emails went to: Maya Chen at Ramp, Leo Park at Stripe \(1 bounced back\)\./.test(t.reply), t.reply);
  assert(!/Oldco|Lastnight|Brex|Failday|Retouch/.test(t.reply), `nothing outside the window: ${t.reply}`);
  assert(!/Mercury|Plaid/.test(t.reply), `an email still sending or that failed was not sent: ${t.reply}`);
  eq(t.reply.split("\n").at(-1), METHOD);
  assert(/as sent by when its send finished \(its receipt\), and as confirmed by when the employer's confirmation email arrived/.test(METHOD) && /Days with work are days with a send, a confirmation or an email sent/.test(METHOD), METHOD);
  assert(!/status last changed/.test(METHOD), "the old method is gone");
  assert(!BANNED.test(t.reply) && !/—|;/.test(t.reply), `plain, no banned phrase, no em-dash or semicolon: ${t.reply}`);
  // The week: Latecon is sent and confirmed inside it; days with work are only sends, confirmations and emails.
  const wk = activityText(rows, windowOf("week", T0, CHI), { span: "week", said: false });
  assert(/^You didn't say when, so this is the last 7 days\.\nThe last 7 days/.test(wk.reply), wk.reply);
  assert(/: 11 applications approved and queued, 6 sent to the employer \(4 confirmed by the employer so far, 2 not confirmed yet\), 4 employer confirmations received and 3 emails sent/.test(wk.reply), wk.reply);
  assert(/Days with work: 4 of 7\./.test(wk.reply), `Oct 30, Oct 31, Nov 2, Nov 3 (Chicago); Oct 29 (only a failure) and Nov 1 (only a queue) are not: ${wk.reply}`);
  // Review: a send that finished yesterday and was confirmed today is yesterday's work, never "nothing happened".
  const yApps: ActivityRows = { tz: CHI, receipts: true, emails: [], apps: [app("Yesterco", "confirmed", { created: start - DAY - 3 * HOUR, sent: start - DAY + 2 * HOUR, confirmed: start + HOUR })] };
  const yest = activityText(yApps, windowOf("yesterday", T0, CHI), { span: "yesterday", said: true });
  eq(yest.status, "shown", yest.reply);
  assert(!/nothing happened/.test(yest.reply), yest.reply);
  eq(yest.reply.split("\n")[0], "Yesterday (Nov 2, America/Chicago): 0 applications approved and queued, 1 sent to the employer (1 confirmed by the employer so far, 0 not confirmed yet), 0 employer confirmations received and 0 emails sent from your account.");
  // A confirmation alone (sent before the window, row last changed after it) is work in its window too.
  const cOnly: ActivityRows = { tz: CHI, receipts: true, emails: [], apps: [app("Confco", "confirmed", { created: start - 5 * DAY, sent: start - 5 * DAY, confirmed: start - DAY + HOUR, updated: start + HOUR })] };
  const conf = activityText(cOnly, windowOf("yesterday", T0, CHI), { span: "yesterday", said: true });
  assert(conf.status === "shown" && /1 employer confirmation received/.test(conf.reply) && !/nothing happened/.test(conf.reply), conf.reply);
  // Nothing on record: said, never padded.
  const none = activityText({ tz: CHI, apps: [], emails: [], receipts: true }, windowOf("today", T0, CHI), { span: "today", said: true });
  eq(none.status, "none");
  assert(/nothing happened\. No application was queued or sent, and no email went out/.test(none.reply), none.reply);
  // A record that could not be read is named and not counted; the others are still counted.
  const lost = activityText({ ...rows, emails: null }, windowOf("today", T0, CHI), { span: "today", said: true });
  eq(lost.status, "partial");
  assert(/Not read just now, so not counted: your email log\./.test(lost.reply) && !/emails? sent from your account/.test(lost.reply), lost.reply);
  const noReceipts = activityText({ ...rows, receipts: false }, windowOf("today", T0, CHI), { span: "today", said: true });
  eq(noReceipts.status, "partial");
  assert(/your application receipts \(so no send is counted\)/.test(noReceipts.reply) && !/sent to the employer/.test(noReceipts.reply) && /2 employer confirmations received/.test(noReceipts.reply), noReceipts.reply);
  const noQueue = activityText({ ...rows, apps: null }, windowOf("today", T0, CHI), { span: "today", said: true });
  eq(noQueue.status, "partial");
  assert(/Not read just now, so not counted: your application queue\./.test(noQueue.reply) && !/applications? approved/.test(noQueue.reply) && /2 emails sent/.test(noQueue.reply), noQueue.reply);
  const gone = activityText({ tz: null, apps: null, emails: null }, windowOf("today", T0, null), { span: "today", said: true });
  eq(gone.status, "unreadable");
  assert(/can't count anything/.test(gone.reply) && !/\d+ applications?/.test(gone.reply), gone.reply);
});

Deno.test("ACT/4 the turn: the read is asked only for an activity ask; a failed read is said", async () => {
  let reads = 0;
  const read = async () => { reads++; return { tz: CHI, apps: [], emails: [] } as ActivityRows; };
  eq(await activityTurn({ message: "where are my applications", userId: "U", now: T0, read }), null);
  eq(reads, 0);
  const r = (await activityTurn({ message: "what did you do today", userId: "U", now: T0, read }))!;
  eq([r.intent, r.status, reads], ["career_activity", "none", 1]);
  const f = (await activityTurn({ message: "what did you do today", userId: "U", now: T0, read: async () => { throw new Error("down"); } }))!;
  eq(f.status, "unreadable");
});

const PEOPLE: Record<string, string> = { "tok-a1": "7b0f8f8e-6a43-4a49-9d2c-0000000ac701", "tok-a2": "7b0f8f8e-6a43-4a49-9d2c-0000000ac702" };
const HASH = "a".repeat(64);

Deno.test({ name: "ACT/5 the real handler on real Postgres: counts equal the seeded rows in the person's day; another person's rows never counted", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const realNow = Date.now;
  try {
    await supabaseParity(pg);
    for (const [tok, id] of Object.entries(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${tok}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    const [A1, A2] = [PEOPLE["tok-a1"], PEOPLE["tok-a2"]];
    await pg.sql(`insert into public.career_alert_prefs (user_id, tz, prefs, last_checked_at) values ('${A1}', '${CHI}', '{"on": false, "keywords": ["data analyst"], "locations": [], "remote_ok": true, "report_hour": 8, "quiet_start": 22, "quiet_end": 7, "max_instant_per_day": 3}', now());`);
    const start = Date.UTC(2026, 10, 3, 6); // midnight in Chicago
    // An application row as the worker leaves it, with its receipt when it was sent (career_apply_receipts.finished_at is
    // the send's time) and the employer's matched email when confirmed (email_confirmed_at is the confirmation's time).
    const jobId = (n: number) => `00000000-0000-4000-8000-0000000a0${String(n).padStart(3, "0")}`;
    const job = (u: string, n: number, company: string, state: string, o: { created: number; sent?: number; confirmed?: number; updated?: number }) => {
      const tried = state === "confirmed" || state === "submitted_unconfirmed" || state === "failed";
      const updated = o.updated ?? Math.max(o.created, o.sent ?? 0, o.confirmed ?? 0);
      return `insert into public.career_apply_jobs (id, user_id, job_id, company, url, payload, payload_hash, approval_hash, state, created_at, updated_at, attempts, email_confirmed_at, confirmation_mail_hash)
       values ('${jobId(n)}', '${u}', 'gh:${n}', '${company}', 'https://example.test/${n}', '{"title":"Data Analyst"}', '${HASH}', '${HASH}', '${state}', '${iso(o.created)}', '${iso(updated)}', ${tried ? 1 : 0}, ${o.confirmed ? `'${iso(o.confirmed)}'` : "null"}, ${o.confirmed ? `'${"b".repeat(64)}'` : "null"});`
        + (o.sent == null ? "" : `
       insert into public.career_apply_receipts (application_id, user_id, company, url, state, reached_employer, payload_hash, approval_hash, approved_at, finished_at, pictures_keep_until)
       values ('${jobId(n)}', '${u}', '${company}', 'https://example.test/${n}', 'submitted_unconfirmed', 'yes', '${HASH}', '${HASH}', '${iso(o.created)}', '${iso(o.sent)}', '${iso(o.sent + 30 * DAY)}');`);
    };
    // Setup, not the person acting: past rows written as the worker left them, so the queue's write-time guards (the
    // resume sent, the employer's matched email) are off for this seed only; every check constraint still holds.
    await pg.sql(["set session_replication_role = replica;",
      job(A1, 1, "Acme", "confirmed", { created: start + HOUR, sent: start + 2 * HOUR, confirmed: start + 3 * HOUR }),
      job(A1, 2, "Globex", "submitted_unconfirmed", { created: start + HOUR, sent: start + 3 * HOUR }),
      job(A1, 3, "Hooli", "needs_user", { created: start + 4 * HOUR }),
      job(A1, 4, "Umbrella", "queued", { created: start + 5 * HOUR }),
      job(A1, 5, "Oldco", "confirmed", { created: start - 3 * DAY, sent: start - 3 * DAY, confirmed: start - 3 * DAY }),
      job(A1, 6, "Lastnight", "submitted_unconfirmed", { created: start - 60_000, sent: start - 60_000 }),
      // The review's case: sent Oct 30, the employer's confirmation arrived today (its updated_at is today).
      job(A1, 8, "Latecon", "confirmed", { created: start - 4 * DAY, sent: start - 4 * DAY + HOUR, confirmed: start + HOUR }),
      // Oct 29: only a failure, no day with work.
      job(A1, 9, "Failday", "failed", { created: start - 5 * DAY, updated: start - 5 * DAY + HOUR }),
      job(A2, 7, "Otherco", "confirmed", { created: start + HOUR, sent: start + HOUR, confirmed: start + HOUR }),
      "set session_replication_role = origin;",
    ].join("\n"));
    const draft = (u: string, n: number, name: string, firm: string, status: string, at: number) =>
      `insert into public.career_outreach_drafts (user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at, sent_at, gmail_id)
       values ('${u}', '00000000-0000-4000-8000-00000000000${u === A1 ? 1 : 2}', ${n}, '${JSON.stringify({ name, firm, title: "", school: "", email: `x${n}@example.test`, source: "test" })}',
       'x${n}@example.test', 'Hello', 'Body', 'Footer', '${HASH}', '${status}', ${status === "shown" ? "null" : `'${HASH}'`}, ${status === "shown" ? "null" : `'${iso(at)}'`}, ${status === "shown" ? "null" : `'${iso(at)}'`}, ${status === "shown" ? "null" : `'g${n}'`});`;
    await pg.sql([
      draft(A1, 1, "Maya Chen", "Ramp", "sent", start + HOUR),
      draft(A1, 2, "Leo Park", "Stripe", "replied", start + 2 * HOUR),
      draft(A1, 3, "Not Sent", "Brex", "shown", start + 3 * HOUR),
      draft(A1, 6, "Still Sending", "Brex", "sending", start + 3 * HOUR),
      draft(A1, 4, "Old Sent", "Plaid", "sent", start - 2 * DAY),
      draft(A2, 5, "Other Person", "Mercury", "sent", start + HOUR),
    ].join("\n"));
    handler = await careerHandler(pg, PEOPLE);
    const say = async (c: Chat, text: string, at = T0) => {
      Date.now = () => at;
      try { const r = await c.say(text); eq(r.status, 200, r.reply); return r; } finally { Date.now = realNow; }
    };
    const c1 = handler.chat("tok-a1");
    const before = await pg.sql(`select count(*) from public.career_apply_jobs; select count(*) from public.career_outreach_drafts; select count(*) from public.career_apply_receipts`);

    await t.step("today: the exact counts of the seeded rows inside Chicago's day, the window and the method said", async () => {
      const r = await say(c1, "how much did we do today?");
      eq(r.intent, "career_activity", r.reply);
      eq(r.resultStatus, "shown", r.reply);
      assert(r.reply.startsWith("Today (since midnight, America/Chicago): 4 applications approved and queued, 2 sent to the employer (1 confirmed by the employer so far, 1 not confirmed yet), 2 employer confirmations received and 2 emails sent from your account."), r.reply);
      assert(/^Employer confirmations received: Acme, Latecon\.$/m.test(r.reply) && !/^Sent[^\n]*Latecon/m.test(r.reply), `Latecon: confirmed today, sent Oct 30: ${r.reply}`);
      eq(r.reply.split("\n").at(-1), METHOD);
      assert(!/Oldco|Lastnight|Brex|Plaid|Otherco|Mercury|Failday/.test(r.reply), `outside the window, not sent, or another person's: ${r.reply}`);
    });

    await t.step("'what did you send today' is this ask, never a receipt for a company called today", async () => {
      const r = await say(c1, "what did you send today?");
      eq(r.intent, "career_activity", r.reply);
      assert(r.reply.startsWith("Today (since midnight, America/Chicago): 4 applications") && !/receipt for|no application to today/i.test(r.reply), r.reply);
    });

    await t.step("the week, no window said: the last 7 days, said; days with work counted", async () => {
      const r = await say(c1, "how many applications have you sent");
      eq(r.intent, "career_activity", r.reply);
      assert(/^You didn't say when, so this is the last 7 days\./.test(r.reply), r.reply);
      assert(/8 applications approved and queued, 5 sent to the employer \(3 confirmed by the employer so far, 2 not confirmed yet\), 3 employer confirmations received and 3 emails sent/.test(r.reply), r.reply);
      assert(/Days with work: 5 of 7\./.test(r.reply), `Oct 30, Oct 31, Nov 1 (an email), Nov 2 and Nov 3 in Chicago; Oct 29 had only a failure: ${r.reply}`);
    });

    await t.step("another person: their own rows only, in UTC since no zone is saved (said)", async () => {
      const r = await say(handler!.chat("tok-a2"), "what did you do today");
      eq(r.intent, "career_activity", r.reply);
      assert(/^Today \(since midnight, UTC, since I don't have your time zone\): 1 application approved and queued, 1 sent to the employer \(1 confirmed by the employer so far, 0 not confirmed yet\), 1 employer confirmation received and 1 email sent/.test(r.reply), r.reply);
      assert(!/Acme|Ramp|Maya/.test(r.reply), r.reply);
    });

    eq(await pg.sql(`select count(*) from public.career_apply_jobs; select count(*) from public.career_outreach_drafts; select count(*) from public.career_apply_receipts`), before, "read only: nothing written");
  } finally {
    Date.now = realNow;
    handler?.restore();
    await pg.stop();
  }
} });
