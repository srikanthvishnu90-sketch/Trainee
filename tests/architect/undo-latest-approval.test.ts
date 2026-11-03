// C21 / C22 (behavior map; spec 16 "reversal symmetry"): "undo" / "cancel that" right after an approval resolves against
// the LATEST thing the person approved and is answered from the database in one line:
//   - an application still queued (not yet claimed by a worker) is cancelled: the row ends not_submitted, nothing went out;
//   - one being sent, or already sent, is said plainly, with what can still be done; nothing is claimed;
//   - the email(s) one approval covered and the send rail has not claimed are withdrawn (approved -> skipped, which the
//     rail's claim turns into a cancelled send); one already out is said to be out;
//   - a second "undo" says "already cancelled" and never reaches an older approval; another person's rows are never read;
//   - when the conversation moved on after the approval ("undo that" about a newer act), the turn is not this one's.
// Through the REAL handler (handleChat) on a real Postgres 16 with every migration; outcomes asserted on career_apply_jobs and
// career_outreach_drafts. Fail-first on trunk 5d6857219: "undo" is not read by any code turn (intent is the router's), and
// every row is left as it was (the queued application would still go out).
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/undo-latest-approval.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
// Loaded when used, so on a base without the module the handler steps still run and fail on what they assert.
const undoModule = () => import("../../supabase/functions/_shared/career_undo.ts");
const UNDO_INTENT = "career_undo";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CI = Deno.env.get("CI") === "true";
const ID = (n: number) => `7b0f8f8e-6a43-4a49-9d2c-0000000a${String(n).padStart(4, "0")}`;
const PEOPLE: Record<string, string> = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`tok-${i + 1}`, ID(i + 1)]));
const H = (c: string) => c.repeat(64);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function app(pg: Pg, user: string, company: string, state: string, ago: string, extra = "", source: string | null = null, attempts?: number) {
  const job = `greenhouse:${company.toLowerCase().replace(/\W+/g, "")}:${crypto.randomUUID().slice(0, 6)}`;
  const driving = state === "driving";
  await pg.sql(`set session_replication_role = replica;
    insert into public.career_apply_jobs (user_id, job_id, company, url, payload, payload_hash, approval_hash, state, attempts, claimed_at, lease_token, created_at, updated_at, source${extra ? ", reason" : ""})
    values ('${user}', '${job}', '${company}', 'https://${company.toLowerCase().replace(/\W+/g, "")}.example.test/apply', '{}'::jsonb, ${`'${H("c")}'`}, ${`'${H("c")}'`}, '${state}',
      ${attempts ?? (driving || state !== "queued" ? 1 : 0)}, ${driving || state !== "queued" || attempts ? "now()" : "null"}, ${driving ? "gen_random_uuid()" : "null"}, now() - interval '${ago}', now() - interval '${ago}', ${source ? `'${source}'` : "null"}${extra ? `, '${extra}'` : ""});
    set session_replication_role = origin;`);
  return job;
}
// approvedAt: one instant for every draft of one approval, as the outreach turn stamps them (new Date(o.now)).
async function mail(pg: Pg, user: string, batch: string, n: number, name: string, status: string, approvedAt: string) {
  const sent = ["sent", "replied", "bounced", "sending"].includes(status);
  await pg.sql(`insert into public.career_outreach_drafts (user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at, sent_at, result)
    values ('${user}', '${batch}', ${n}, '${JSON.stringify({ name, firm: "Acme", title: "Analyst", email: `${name.split(" ")[0].toLowerCase()}@acme.example.test` })}'::jsonb,
      '${name.split(" ")[0].toLowerCase()}@acme.example.test', 'Hello', 'Would you have 15 minutes?', 'Sam', '${H(String(n))}', '${status}',
      ${status === "approved" ? `'${H(String(n))}'` : "null"}, '${approvedAt}', ${sent ? `'${approvedAt}'` : "null"}, ${status === "sending" ? "'send_rail'" : "null"})`);
}
const jobs = async (pg: Pg, user: string) => JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('company', company, 'state', state) order by created_at), '[]') from public.career_apply_jobs where user_id = '${user}'`));
const mails = async (pg: Pg, user: string) => JSON.parse(await pg.sql(`select coalesce(json_agg(json_build_object('n', n, 'status', status) order by n), '[]') from public.career_outreach_drafts where user_id = '${user}'`));

Deno.test({ name: "C21/C22: undo / cancel that resolves against the latest approval, cancels it while it has not gone out, and says plainly when it has", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  try {
    await supabaseParity(pg);
    for (const id of Object.values(PEOPLE)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    handler = await careerHandler(pg, PEOPLE);
    const say = async (c: Chat, message: string) => { const r = await c.say(message); eq(r.status, 200, r.reply); return r; };

    await t.step("1. a queued application approved a minute ago: 'undo' cancels it before it goes out; a second 'undo' never reaches the older one", async () => {
      const u = ID(1);
      await app(pg, u, "Globex", "queued", "1 hour");
      await app(pg, u, "Acme Analytics", "queued", "1 minute");
      const c = handler!.chat("tok-1");
      const r = await say(c, "undo");
      eq(r.intent, UNDO_INTENT, r.reply);
      eq(r.reply, "Cancelled: your application to Acme Analytics was stopped before it went out, so this one was not sent.");
      eq(await jobs(pg, u), [{ company: "Globex", state: "queued" }, { company: "Acme Analytics", state: "not_submitted" }], "only the latest is cancelled");
      const again = await say(c, "undo");
      eq(again.reply, "Already cancelled: your application to Acme Analytics never went out.");
      eq(await jobs(pg, u), [{ company: "Globex", state: "queued" }, { company: "Acme Analytics", state: "not_submitted" }], "the older approval is untouched by a second undo");
    });

    await t.step("2. being sent right now: said plainly, nothing claimed, nothing changed", async () => {
      const u = ID(2);
      await app(pg, u, "Initech", "driving", "2 minutes");
      const r = await say(handler!.chat("tok-2"), "wait, cancel that");
      eq(r.intent, UNDO_INTENT, r.reply);
      eq(r.reply, "Too late to cancel: your application to Initech is being sent right now and can't be stopped midway. Once it's in, you can withdraw it with Initech directly.");
      eq(await jobs(pg, u), [{ company: "Initech", state: "driving" }]);
    });

    await t.step("3. already sent: says it went out and what can be done; the record is unchanged", async () => {
      const u = ID(3);
      await app(pg, u, "Hooli", "submitted_unconfirmed", "3 minutes");
      const r = await say(handler!.chat("tok-3"), "undo that");
      eq(r.reply, "That already went out: your application to Hooli was sent, and Trainee can't pull back a sent application. To withdraw it, contact Hooli or use their candidate portal.");
      eq(await jobs(pg, u), [{ company: "Hooli", state: "submitted_unconfirmed" }]);
    });

    await t.step("4. the latest approval is two emails ('send all'): both withdrawn before the rail sends them; an older queued application stays", async () => {
      const u = ID(4), batch = crypto.randomUUID(), at4 = minutesAgo(1);
      await app(pg, u, "Umbrella", "queued", "30 minutes");
      await mail(pg, u, batch, 1, "Jane Doe", "approved", at4);
      await mail(pg, u, batch, 2, "Raj Patel", "approved", at4);
      const c4 = handler!.chat("tok-4");
      const r = await say(c4, "cancel that");
      eq(r.intent, UNDO_INTENT, r.reply);
      eq(r.reply, "Cancelled 2 of 2: the emails to Jane Doe (Acme) and Raj Patel (Acme) won't be sent.");
      eq(await mails(pg, u), [{ n: 1, status: "skipped" }, { n: 2, status: "skipped" }]);
      eq(await jobs(pg, u), [{ company: "Umbrella", state: "queued" }], "the older application is not the latest approval");
      const again = await say(c4, "cancel that");
      eq([again.intent, again.reply], [UNDO_INTENT, "Nothing to undo: none of those 2 emails went out."], "a second undo stays on the same approval");
      eq(await jobs(pg, u), [{ company: "Umbrella", state: "queued" }], "and never reaches the older application");
    });

    await t.step("5. one email of the approval already went: the other is withdrawn, the sent one is said to be out", async () => {
      const u = ID(5), batch = crypto.randomUUID(), at5 = minutesAgo(4);
      await mail(pg, u, batch, 1, "Ana Lima", "sent", at5);
      await mail(pg, u, batch, 2, "Bo Chen", "approved", at5);
      const r = await say(handler!.chat("tok-5"), "oops undo");
      eq(r.reply, "Cancelled 1 of 2: the email to Bo Chen (Acme) won't be sent; Ana Lima (Acme) already went out and can't be unsent.");
      eq(await mails(pg, u), [{ n: 1, status: "sent" }, { n: 2, status: "skipped" }]);
    });

    await t.step("6. a single email already sent: email can't be unsent; a follow-up is what can be done", async () => {
      const u = ID(6);
      await mail(pg, u, crypto.randomUUID(), 1, "Kim Park", "sent", minutesAgo(2));
      const r = await say(handler!.chat("tok-6"), "take that back");
      eq(r.reply, "That already went out: your email to Kim Park (Acme) was sent, and email can't be unsent. You can send a short follow-up to correct it.");
      eq(await mails(pg, u), [{ n: 1, status: "sent" }]);
    });

    await t.step("7. the conversation moved on after the approval: 'undo that' is about the newer act, and the application is left queued", async () => {
      const u = ID(7), c = handler!.chat("tok-7");
      await say(c, "hi"); // a reply in this thread, written now
      await app(pg, u, "Wayne Enterprises", "queued", "30 minutes");
      const r = await say(c, "undo that");
      assert(r.intent !== UNDO_INTENT, `not the undo turn's: ${r.intent} ${r.reply}`);
      eq(await jobs(pg, u), [{ company: "Wayne Enterprises", state: "queued" }]);
    });

    await t.step("8. nothing approved: nothing to undo; another person's queued application is never read or touched", async () => {
      await app(pg, ID(9), "Stark Industries", "queued", "1 minute");
      await app(pg, ID(8), "Old Corp", "queued", "2 days"); // approved two days ago: not what "undo" means now
      const r = await say(handler!.chat("tok-8"), "undo");
      eq(r.reply, "There's nothing to undo: you haven't approved an application or an email in the last 24 hours.");
      eq(await jobs(pg, ID(9)), [{ company: "Stark Industries", state: "queued" }]);
      eq(await jobs(pg, ID(8)), [{ company: "Old Corp", state: "queued" }], "an approval older than 24 hours is not undone");
    });
    await t.step("9. queued on a route the cancel cannot pull back (the cloud): said plainly, never 'cancelled'", async () => {
      const u = ID(10);
      await app(pg, u, "Cyberdyne", "queued", "1 minute", "", "cloud");
      const r = await say(handler!.chat("tok-10"), "undo");
      eq(r.reply, "I couldn't stop your application to Cyberdyne from here: it is still queued and may go out. Nothing else was changed.");
      eq(await jobs(pg, u), [{ company: "Cyberdyne", state: "queued" }]);
    });

    await t.step("10. the email cancel is a compare-and-set on the person's own approved draft: a draft the rail took, or someone else's, is never touched", async () => {
      const { supabaseUndoStore } = await undoModule();
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { global: { fetch: handler!.double.fetch as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
      const store = supabaseUndoStore(admin), u = ID(11), batch = crypto.randomUUID(), at = minutesAgo(1);
      await mail(pg, u, batch, 1, "Lee Sato", "sending", at);
      await mail(pg, u, batch, 2, "Mo Diaz", "approved", at);
      const [d1, d2] = JSON.parse(await pg.sql(`select json_agg(id order by n) from public.career_outreach_drafts where user_id = '${u}'`));
      eq(await store.cancelEmail(u, d1), false, "a draft the rail is sending is not withdrawn");
      eq(await store.cancelEmail(ID(1), d2), false, "another person cannot withdraw it");
      eq(await mails(pg, u), [{ n: 1, status: "sending" }, { n: 2, status: "approved" }]);
      eq(await store.cancelEmail(u, d2), true, "the person's own approved draft is withdrawn");
      eq(await mails(pg, u), [{ n: 1, status: "sending" }, { n: 2, status: "skipped" }]);
      // The application cancel is the same: exactly this person's row, by id, and only while no worker has claimed it.
      await app(pg, u, "Soylent", "driving", "1 minute");
      await app(pg, u, "Tyrell", "queued", "1 minute");
      const ids = JSON.parse(await pg.sql(`select json_object_agg(company, id) from public.career_apply_jobs where user_id = '${u}'`));
      const claimed = await store.cancelApplyJob(u, ids.Soylent);
      eq([claimed.cancelled, claimed.row?.state], [false, "driving"], "a row a worker claimed between the read and the cancel is not cancelled, and is read back as it is");
      eq((await store.cancelApplyJob(ID(1), ids.Tyrell)).cancelled, false, "another person cannot cancel it");
      eq(await jobs(pg, u), [{ company: "Soylent", state: "driving" }, { company: "Tyrell", state: "queued" }]);
      eq((await store.cancelApplyJob(u, ids.Tyrell)).cancelled, true, "the person's own queued application is cancelled");
    });
    await t.step("11. two queued applications at the same company: undo cancels ONLY the one just approved; the earlier one still goes", async () => {
      const u = ID(12);
      await app(pg, u, "Acme Analytics", "queued", "1 hour");
      await app(pg, u, "Acme Analytics", "queued", "1 minute");
      const r = await say(handler!.chat("tok-12"), "undo");
      eq(await jobs(pg, u), [{ company: "Acme Analytics", state: "queued" }, { company: "Acme Analytics", state: "not_submitted" }], "exactly the latest job, by id");
      eq(r.reply, "Cancelled: your application to Acme Analytics was stopped before it went out, so this one was not sent.");
    });

    await t.step("12. the latest application was put back in the queue (attempts 1) and an earlier one to the same company went out: the latest is cancelled and the reply is about it, never 'already went out'", async () => {
      const u = ID(13);
      await app(pg, u, "Globex", "submitted_unconfirmed", "3 hours");
      await app(pg, u, "Globex", "queued", "1 minute", "", null, 1);
      const r = await say(handler!.chat("tok-13"), "undo");
      eq(await jobs(pg, u), [{ company: "Globex", state: "submitted_unconfirmed" }, { company: "Globex", state: "not_submitted" }], "the re-queued latest is cancelled");
      eq(r.reply, "Cancelled: your application to Globex was stopped before it went out, so this one was not sent.");
      assert(!/Nothing was sent to Globex/.test(r.reply), `never says nothing went to Globex: an earlier application did: ${r.reply}`);
    });
  } finally {
    handler?.restore();
    await pg.stop();
  }
} });

// The race the database settles: the send rail claimed the email between the read and the cancel. The reply says where it is
// now, never "cancelled".
Deno.test("C21: an email the rail claimed between the read and the cancel is said to be going out, never 'cancelled'", async () => {
  const Undo = await undoModule();
  const at = new Date().toISOString();
  const store = {
    latestApply: async () => null,
    latestEmails: async () => [{ id: "d1", status: "approved", approved_at: at, name: "Jane Doe", firm: "Acme" }],
    cancelApplyJob: async () => ({ cancelled: false, row: null }),
    cancelEmail: async () => false,
    emailStatus: async () => "sending",
    lastReplyAt: async () => null,
  };
  const r = await Undo.undoTurn({ message: "undo", userId: "u", threadId: null, now: Date.now(), store });
  eq(r?.reply, "Too late to cancel: your email to Jane Doe (Acme) is being sent right now. If it needs correcting, you can send a short follow-up.");
  const sent = await Undo.undoTurn({ message: "undo", userId: "u", threadId: null, now: Date.now(), store: { ...store, emailStatus: async () => "sent" } });
  // The same race for an application: the worker claimed it after the read; the reply is from the row as it is now.
  const raced = await Undo.undoTurn({ message: "undo", userId: "u", threadId: null, now: Date.now(), store: { ...store, latestEmails: async () => [],
    latestApply: async () => ({ id: "j1", company: "Acme", state: "queued", created_at: at }),
    cancelApplyJob: async () => ({ cancelled: false, row: { id: "j1", company: "Acme", state: "driving", created_at: at } }) } });
  eq(raced?.reply, "Too late to cancel: your application to Acme is being sent right now and can't be stopped midway. Once it's in, you can withdraw it with Acme directly.");
  eq(sent?.status, "too_late");
  assert(!/Cancelled/.test(sent!.reply), sent!.reply);
});

Deno.test("C22: the asks it reads, and the ones it leaves to their own turns", async () => {
  const Undo = await undoModule();
  for (const m of ["undo", "Undo.", "undo that", "cancel that", "wait, cancel that", "oops undo", "take that back", "don't send that", "cancel it please", "scratch that"]) assert(Undo.undoAsk(m), m);
  for (const m of ["cancel my application to Acme", "cancel my plan", "cancel", "stop", "undo my last resume edit and then apply to Acme", "cancel the interview", "unsubscribe"]) assert(!Undo.undoAsk(m), m);
});

Deno.test("C21: what was approved cannot be read: an honest line, and nothing is cancelled", async () => {
  const Undo = await undoModule();
  const calls: string[] = [];
  const store = {
    latestApply: async () => { throw new Error("read your latest application: connection reset"); },
    latestEmails: async () => [],
    cancelApplyJob: async () => { calls.push("cancelApplyJob"); return { cancelled: true, row: null }; },
    cancelApply: async () => { calls.push("cancelApply"); return { approved_cancelled: 1 }; },
    cancelEmail: async () => { calls.push("cancelEmail"); return true; },
    emailStatus: async () => null,
    lastReplyAt: async () => null,
  };
  const r = await Undo.undoTurn({ message: "undo", userId: "u", threadId: null, now: Date.now(), store: store as any });
  eq([r?.status, r?.reply], ["unreadable", "I couldn't read what you approved just now, so nothing was cancelled. Say undo again in a minute."]);
  eq(calls, [], "no cancel is attempted on an unreadable read");
  const mailsDown = await Undo.undoTurn({ message: "undo", userId: "u", threadId: null, now: Date.now(), store: { ...store, latestApply: async () => null, latestEmails: async () => { throw new Error("down"); } } as any });
  eq(mailsDown?.status, "unreadable");
  eq(calls, []);
});
