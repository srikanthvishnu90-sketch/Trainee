// R10 F.3 (docs/architect/specs/APP-LAYER-15-FIXES.md section F.3, D.4 rule 7): a stop is never claimed beyond what was
// written and read back. Through the real chat handler (handler-career.ts) on Postgres 16 with every migration, the
// model faked (no real call), Gmail and Telegram faked at the HTTP boundary. Every assertion reads the tables.
//   - the exact F.3 turn: the people list is cancelled, unsent drafts are held, nothing is sent, the account is NOT
//     paused, and every number in the reply is the table's;
//   - "pause everything" / "stop all sending": career:account paused, read back, and each send path the reply names
//     refuses while paused (one step per path); the two paths that do not yet (a batch already claimed, replies-lane
//     calendar invites) are named as not covered;
//   - a failed or contradicted write: the reply says the stop is not confirmed, and that is what is stored;
//   - resume only on an explicit ask.
import assertNode from "node:assert/strict";
import { pgBinDir } from "../flow/pg.ts";
import { CI, POSTINGS, resumeOf, startWorld, tokenOf, uidOf, type Person, type World } from "./scenarios/journeys-r2-world.ts";
import { approvedDrafts, draftsReader } from "../flow/send-rail-fixture.ts";
import { serviceRpc } from "../flow/pgwire.ts";
import { queueApproved, queueApprovedOutreach } from "../../supabase/functions/_shared/career_send_rail.ts";
import { payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { PAUSE_GAPS, PAUSE_HOLDS } from "../../supabase/functions/_shared/career_stop_truth.ts";
import { proposeEvent, supabaseRepliesStore } from "../../supabase/functions/_shared/career_outreach_replies.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const RUN = crypto.randomUUID().slice(0, 4);
const at = (local: string) => `${local}.${RUN}@example.test`;

const F3 = "Stop the people list. I didn't ask for analysts to contact, any drafts, or an application batch. Don't contact anyone or start any new work. I asked for company research, and you haven't answered it. Leave everything unsent.";
const FALSE_CLAIMS = [/global pause/i, /every send path/i, /the moment the queue records load/i, /you do not need to ask again/i];

Deno.test({
  name: "R10 F.3 stop/pause truth: the reply states only the effect written and read back",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const ids = [930001, 930002, 930003, 930004, 930005, 930006, 930007];
    const w: World = await startWorld({ tokens: Object.fromEntries(ids.map((j) => [tokenOf(j), uidOf(j)])) });
    const rpc = serviceRpc(w.conn as any);
    const outreachDeps = { ...rpc, drafts: draftsReader(w.conn as any) };
    const railDb = { sql: w.conn } as any;
    const n = async (s: string) => Number(await w.sql(s));
    const account = async (p: Person) => JSON.parse(await w.sql(`select coalesce((select value::text from public.career_watch_kv where user_id = ${q(p.uid)} and key = 'career:account'), '{}')`));
    const quiet = async (p: Person) => (await w.sql(`select public.career_user_quiet(${q(p.uid)})`)) === "t";
    const draftStates = async (p: Person) => Object.fromEntries((await w.json<{ status: string; n: number }[]>(`select status, count(*)::int n from public.career_outreach_drafts where user_id = ${q(p.uid)} group by status`)).map((r) => [r.status, r.n]));
    const plantPeopleList = async (p: Person) => {
      await w.sql(`update public.agent_flow_state set state = jsonb_set(state, '{career,stores,plan}', ${q(JSON.stringify({ kind: "campaign_plan", scheduled: 0, days: 0, deferred: [], lastAsk: "5 analysts at Stripe", count: 5, firms: ["Stripe"], firms_named: true, at: new Date().toISOString() }))}::jsonb, true) where user_id = ${q(p.uid)} and thread_id = ${q(p.web.thread!)}`);
      eq(await w.sql(`select state#>>'{career,stores,plan,kind}' from public.agent_flow_state where thread_id = ${q(p.web.thread!)}`), "campaign_plan", "setup: the people list stands in this thread");
    };
    const pause = async (p: Person, words = "pause everything") => {
      const r = await w.web(p, words);
      eq(r.intent, "career_paused", r.reply);
      eq((await account(p)).paused, true, `the account record holds the pause: ${r.reply}`);
      eq(await quiet(p), true, "the send paths' predicate reads it");
      return r;
    };
    try {
      await t.step("the exact F.3 turn: the people list is cancelled, unsent drafts held, nothing sent, the account not paused, the reply's numbers are the tables'", async () => {
        const p = await w.addPerson(ids[0], 0);
        await w.connectGmail(p);
        // An application asked for and waiting to be prepared (a confirmed resume first): new work not yet started.
        const up = await w.tgResumeFile(p, resumeOf(p.spec));
        assert(/15 facts/.test(up.said.join("\n")), up.said.join(" | "));
        await w.tg(p, "yes, that's my resume");
        eq((await w.web(p, `apply to the Data Analyst role at ${POSTINGS[0].company}`)).resultStatus, "queued", "setup: one application asked for");
        eq(await n(`select count(*) from public.career_apply_wanted where user_id = ${q(p.uid)} and state = 'waiting'`), 1, "setup: waiting to be prepared");
        await plantPeopleList(p);
        // A replies-lane calendar invite, approved and not yet created.
        const store = supabaseRepliesStore(w.admin);
        const now = Date.now();
        const th = await store.track({ user_id: p.uid, draft_id: null, provider: "gmail", provider_thread: `th-f3-${RUN}`, email: at("f3cal"), name: "Avery Synthetic", firm: "Beta", subject: "Hello", sent_at: new Date(now - 86_400_000).toISOString() });
        await store.applyReply(p.uid, th, `m-f3-${RUN}`, "wants_call", new Date(now).toISOString(), { who: "contact" });
        const inv = (await proposeEvent({ store, userId: p.uid, threadId: th, slot: { start: new Date(now + 3 * 86_400_000).toISOString(), end: new Date(now + 3 * 86_400_000 + 1_800_000).toISOString(), person: "Thu 10:00" } as any, now }))!;
        eq((await store.approve(p.uid, inv.batch_id, [{ n: inv.n, hash: inv.hash }], now)).length, 1, "setup: the invite is approved");
        // Outreach on record: two approved and unsent (one already handed to the send rail), one waiting, one already out.
        const [queuedOne, approvedOnly, waiting, out] = await approvedDrafts(railDb, p.uid, [at("f3q"), at("f3a"), at("f3w"), at("f3o")]);
        const queued = await queueApprovedOutreach(outreachDeps, p.uid, [queuedOne]);
        eq(queued.map((x) => x.status), ["queued"], "setup: one email on the send rail");
        await w.sql(`update public.career_outreach_drafts set status = 'shown', approved_hash = null, approved_at = null where id = ${q(waiting.draftId)};
          update public.career_outreach_drafts set status = 'sent', sent_at = now() - interval '1 day', gmail_id = 'g-${RUN}' where id = ${q(out.draftId)}`);
        void approvedOnly;
        const sentBefore = w.gmail.sent.length;

        const r = await w.web(p, F3);
        eq(r.intent, "career_stop_workflow", r.reply);
        for (const re of FALSE_CLAIMS) assert(!re.test(r.reply), `no claim beyond what was written (${re}): ${r.reply}`);
        // The account is untouched: no pause, no quiet state.
        eq((await account(p)).paused ?? false, false, "the account is NOT paused by a workflow stop");
        eq(await quiet(p), false);
        // The workflow is cancelled in the authoritative thread record.
        eq(await w.sql(`select coalesce(state#>>'{career,stores,plan,kind}', 'none') from public.agent_flow_state where thread_id = ${q(p.web.thread!)}`), "none", "the people list is gone from the thread");
        // Held: no approved draft is left; the queued email is cancelled; the sent one is untouched.
        const ds = await draftStates(p);
        eq(ds, { shown: 3, sent: 1 }, "both approved drafts are back to waiting; nothing else changed");
        eq(await w.sql(`select state from public.career_send_queue where source_id = ${q(queuedOne.draftId)}`), "cancelled");
        eq(await w.sql(`select status from public.career_outreach_actions where id = ${q(inv.id)}`), "shown", "the approved invite is back to waiting for a yes");
        eq(await n(`select count(*) from public.career_apply_wanted where user_id = ${q(p.uid)}`), 0, "the application waiting to be prepared is stopped");
        eq(await n(`select count(*) from public.career_apply_jobs where user_id = ${q(p.uid)}`), 0, "and nothing was ever queued to submit");
        // Nothing is sent, now or by the sender's next pass.
        await w.sendWorker();
        eq(w.gmail.sent.length, sentBefore, "nothing went out");
        // The reply's words are the state's, line by line.
        const lines = r.reply.split("\n");
        eq(lines[0], "Stopped: the people list in this conversation is cancelled, and no one on it was contacted.");
        eq(lines[1], "Held 2 approved outreach drafts: they go back to waiting and won't send without a new yes.");
        eq(lines[2], "Cancelled 1 queued outreach email.");
        eq(lines[3], "Held 1 approved follow-up or call invite: back to waiting for a new yes.");
        eq(lines[4], "Stopped 1 application waiting to be prepared: nothing was prepared or sent, and it starts only if you ask again.");
        lines.splice(3, 2);
        eq(lines[3], `Outreach drafts on record: ${ds.shown} waiting for your yes, 0 approved, 0 sending (outcome uncertain), ${ds.sent} already out.`);
        const rail = Object.fromEntries((await w.json<{ state: string; n: number }[]>(`select state, count(*)::int n from public.career_send_queue where user_id = ${q(p.uid)} group by state`)).map((x) => [x.state, x.n]));
        eq(lines[4], `Emails on the send rail: ${rail.queued ?? 0} queued, ${rail.sending ?? 0} sending (outcome uncertain), ${(rail.sent ?? 0) + (rail.replied ?? 0) + (rail.bounced ?? 0)} already out.`);
        eq(lines[5], `Applications on record: 0 waiting, 0 in progress, 0 confirmed by the employer, 0 with the outcome unknown.`);
        eq(await n(`select count(*) from public.career_apply_jobs where user_id = ${q(p.uid)} and state in ('queued', 'driving', 'needs_user', 'confirmed', 'submitted_unconfirmed', 'unknown_outcome')`), 0);
        eq(lines[6], `Follow-ups and call invites on record: 1 waiting for your yes, 0 approved, 0 being carried out now (outcome uncertain), 0 done.`);
        eq(lines[7], `Your account is not paused. Say "pause everything" to stop all sending.`);
        eq(lines[8], "Your ask for company research is still open, and I can't answer it here: company research isn't turned on in this version of Trainee yet, so I can't look it up for you. Nothing about it was sent anywhere.");
        eq(lines.length, 9, r.reply);
        // The stored reply is the one returned.
        eq(await w.sql(`select content from public.agent_messages where thread_id = ${q(p.web.thread!)} and role = 'assistant' order by id desc limit 1`), r.reply);
      });

      await t.step("a stop with nothing standing says so and still writes no pause; a question about stopping is not a stop", async () => {
        const p = await w.addPerson(ids[1], 1);
        const r = await w.web(p, F3);
        eq(r.intent, "career_stop_workflow", r.reply);
        assert(r.reply.startsWith("No people list was being built in this conversation, so there was none to cancel."), r.reply);
        assert(/Outreach drafts on record: 0 waiting for your yes, 0 approved, 0 sending \(outcome uncertain\), 0 already out\./.test(r.reply), r.reply);
        eq((await account(p)).paused ?? false, false);
        const ask = await w.web(p, "should I pause everything?");
        assert(ask.intent !== "career_paused", `a question pauses nothing: ${ask.intent} ${ask.reply}`);
        eq((await account(p)).paused ?? false, false);
        // 141's old halt words never reach a hosted reply again.
        for (const words of ["stop all outreach", "don't contact anyone"]) {
          const s = await w.web(p, words);
          for (const re of FALSE_CLAIMS) assert(!re.test(s.reply), `${words}: ${s.reply}`);
          eq((await account(p)).paused ?? false, false, `${words} is a workflow stop, not an account pause`);
        }
      });

      await t.step("'pause everything' and 'stop all sending': the pause is set and read back; the reply names only the paths that read it and the gaps", async () => {
        const p = await w.addPerson(ids[2], 2);
        const r = await pause(p);
        const lines = r.reply.split("\n");
        eq(lines[0], "Paused your account: the pause is saved and I read it back.");
        eq(lines[1], `While it is on, nothing new starts, and these refuse to send: ${PAUSE_HOLDS.join("; ")}.`);
        eq(lines[2], `Not covered by the pause today: ${PAUSE_GAPS.join("; ")}.`);
        for (const re of FALSE_CLAIMS) assert(!re.test(r.reply), r.reply);
        const p2 = await w.addPerson(ids[3], 3);
        await pause(p2, "stop all sending");
      });

      // One step per send path the pause reply names (PAUSE_HOLDS). Each person is paused by the chat turn itself.
      await t.step("paused: applications refuse (the Telegram Apply tap, the chat apply, and the apply authority check)", async () => {
        const p = await w.addPerson(ids[4], 4);
        const up = await w.tgResumeFile(p, resumeOf(p.spec));
        assert(/15 facts/.test(up.said.join("\n")), up.said.join(" | "));
        await w.tg(p, "yes, that's my resume");
        const before = w.bot.to(p.tg).length;
        await w.tg(p, "find data analyst jobs in Chicago");
        const applies = w.bot.to(p.tg).slice(before).flatMap((m) => m.buttons).map((b: any) => String(b.callback_data ?? "")).filter((d) => /^jca:/.test(d));
        assert(applies.length >= 1, "setup: the cards carry Apply");
        await pause(p);
        const tap = await w.tap(p, applies[0]);
        eq(await n(`select count(*) from public.career_apply_wanted where user_id = ${q(p.uid)}`), 0, `the tap queued nothing: ${tap.said.join(" | ")}`);
        const chat = await w.web(p, `apply to the Data Analyst role at ${POSTINGS[0].company}`);
        eq(await n(`select count(*) from public.career_apply_jobs where user_id = ${q(p.uid)}`), 0, chat.reply);
        // The apply authority itself: nothing stamped for this person is current while paused.
        // Stamped at the account's current version, so only the pause can make it stale.
        const cur = `select public.career_apply_current(${q(p.uid)}, (select jsonb_build_object('account_version', (value->>'version')::bigint, 'privacy_epoch', coalesce((value->>'epoch')::bigint, 0), 'expires_at', now() + interval '1 day') from public.career_watch_kv where user_id = ${q(p.uid)} and key = 'career:account'))`;
        eq(await w.sql(cur), "f", "an application approval is not current while paused");
      });

      await t.step("paused: outreach emails refuse at the claim (the direct claim and the send rail)", async () => {
        const p = await w.addPerson(ids[5], 5);
        await w.connectGmail(p);
        const [d, e] = await approvedDrafts(railDb, p.uid, [at("pz1"), at("pz2")]);
        eq((await queueApprovedOutreach(outreachDeps, p.uid, [d])).map((x) => x.status), ["queued"]);
        await pause(p);
        eq(await w.sql(`select public.career_outreach_claim(${q(p.uid)}, ${q(e.draftId)}, ${q(e.approvalHash)}, now(), now() - interval '1 hour')`), "paused", "the direct claim refuses");
        const sent = w.gmail.sent.length;
        await w.sendWorker();
        eq(w.gmail.sent.length, sent, "the rail sent nothing while paused");
        eq(await w.sql(`select state from public.career_send_queue where source_id = ${q(d.draftId)}`), "queued", "left queued, not sent");
        // A general email (follow-ups and status notes ride the same rail) is held the same way.
        const hash = await payloadHash({ to: at("pz3"), subject: "Following up", text: "Hi again" });
        eq((await queueApproved(rpc as any, p.uid, [{ kind: "general", sourceId: crypto.randomUUID(), approvalHash: hash, to: at("pz3"), subject: "Following up", text: "Hi again" }])).map((x) => x.status), ["queued"]);
        await w.sendWorker();
        eq(w.gmail.sent.length, sent, "no follow-up went out either");
        // Proves the path is live: lifted, the same queue sends.
        eq((await w.web(p, "resume career work")).intent, "career_resumed");
        await w.sendWorker();
        assert(w.gmail.sent.length > sent, "after the explicit resume the rail sends");
      });

      await t.step("paused: follow-ups, job alerts, cards and proactive messages, and reminders refuse", async () => {
        const p = await w.addPerson(ids[6], 6);
        await w.sql(`insert into public.career_alert_prefs(user_id, tz, prefs, last_checked_at, instant_sent_today, sent_on, last_report_on, held)
          values (${q(p.uid)}, 'America/Chicago', ${q(JSON.stringify({ on: true, keywords: ["analyst"], locations: [], remote_ok: true, report_hour: 8, quiet_start: 0, quiet_end: 0, max_instant_per_day: 5 }))}::jsonb, now(), 0, null, null, '{}')`);
        await pause(p);
        // Follow-ups and every proactive rail ask career_quiet_users once per run (career-proactive/handler.ts awake).
        eq(await w.sql(`select count(*) from public.career_quiet_users(array[${q(p.uid)}]::uuid[])`), "1");
        // A job alert is not even queued.
        eq(await w.sql(`select public.career_alert_enqueue(${q(p.uid)}, 'alert:job-${RUN}', 'A new role', now(), now(), 90, current_date, now() - interval '7 days')`), "off");
        // A card or message already in the outbox is held at delivery.
        await w.sql(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values (${q(p.uid)}, 'report:held-${RUN}', 'report', 'Your weekly report', now() - interval '1 minute')`);
        const { sentTo } = await w.deliverCron(2);
        eq(sentTo.get(p.uid) ?? 0, 0, "nothing delivered to them while paused");
        eq(await n(`select count(*) from public.career_outbox where user_id = ${q(p.uid)} and key = 'report:held-${RUN}' and delivered_at is not null`), 0);
        // A reminder is refused at enqueue.
        const a = await account(p);
        const rem = await w.admin.rpc("career_reminder_enqueue", { p_user: p.uid, p_reminder: { user_id: p.uid, reminder_id: `r-${RUN}` }, p_version: a.version, p_epoch: a.epoch ?? 0 });
        assert(rem.error && /paused/.test(rem.error.message), `the reminder is refused: ${JSON.stringify(rem)}`);
      });

      await t.step("resume only on an explicit ask: other words, 'resume' alone and a later stop never lift the pause", async () => {
        const p = w.people.find((x) => x.uid === uidOf(ids[2]))!;
        eq((await account(p)).paused, true, "setup: still paused from the earlier step");
        for (const words of ["resume", "yes", "find data analyst jobs in Chicago", F3, "ok go ahead"]) {
          const r = await w.web(p, words);
          eq((await account(p)).paused, true, `"${words}" lifted the pause: ${r.reply}`);
          eq(await quiet(p), true);
        }
        const r = await w.web(p, "resume career work");
        eq(r.intent, "career_resumed", r.reply);
        eq((await account(p)).paused, false, "lifted only by the explicit ask");
        eq(await quiet(p), false);
        assert(/read it back/.test(r.reply), r.reply);
        const again = await w.web(p, "resume career work");
        eq(again.intent, "career_not_paused", `no claim of lifting a pause that is not on: ${again.reply}`);
      });

      await t.step("a failed write: the commit refuses the pause, so the reply says the stop is not confirmed and nothing is paused", async () => {
        const p = w.people.find((x) => x.uid === uidOf(ids[3]))!;
        eq((await w.web(p, "resume career work")).intent, "career_resumed", "setup: not paused");
        await w.sql(`create or replace function public.r10_refuse_pause() returns trigger language plpgsql as $f$ begin
            if new.key = 'career:account' and new.user_id = ${q(p.uid)} and new.value->'paused' = 'true'::jsonb then raise exception 'r10 test: storage refused'; end if; return new; end $f$;
          create trigger r10_refuse_pause before insert or update on public.career_watch_kv for each row execute function public.r10_refuse_pause()`);
        try {
          const r = await w.web(p, "pause everything");
          assert(/^The stop is not confirmed: I could not save the pause, so your account is NOT paused/.test(r.reply ?? ""), `said: ${JSON.stringify(r)}`);
          for (const re of FALSE_CLAIMS) assert(!re.test(r.reply ?? ""), r.reply);
          eq((await account(p)).paused, false);
          eq(await quiet(p), false);
        } finally {
          await w.sql(`drop trigger r10_refuse_pause on public.career_watch_kv; drop function public.r10_refuse_pause()`);
        }
      });

      await t.step("a write that does not read back: the commit lands but the record does not show the pause, so it is not claimed", async () => {
        const p = w.people.find((x) => x.uid === uidOf(ids[3]))!;
        await w.sql(`create or replace function public.r10_drop_pause() returns trigger language plpgsql as $f$ begin
            if new.key = 'career:account' and new.user_id = ${q(p.uid)} then new.value := new.value - 'paused'; end if; return new; end $f$;
          create trigger r10_drop_pause before insert or update on public.career_watch_kv for each row execute function public.r10_drop_pause()`);
        try {
          const r = await w.web(p, "pause everything");
          assert(/^I could not confirm the pause: the account record does not show the pause\. Treat your account as NOT paused/.test(r.reply), r.reply);
          assert(!/Paused your account/.test(r.reply), r.reply);
          eq(await quiet(p), false);
          // What is stored is what was sent: the thread's message and the receipt a replay of this turn returns.
          eq(await w.sql(`select content from public.agent_messages where thread_id = ${q(p.web.thread!)} and role = 'assistant' order by id desc limit 1`), r.reply, "the thread shows the reply sent");
          eq(await w.sql(`select value->'response'->>'reply' from public.career_watch_kv where user_id = ${q(p.uid)} and key like ${q(`career:turn:${p.web.thread}:%`)} order by updated_at desc limit 1`), r.reply, "a replay returns the reply sent");
        } finally {
          await w.sql(`drop trigger r10_drop_pause on public.career_watch_kv; drop function public.r10_drop_pause()`);
        }
      });

      await t.step("a failed hold: the drafts write fails, so the reply says those drafts are NOT stopped", async () => {
        const p = w.people.find((x) => x.uid === uidOf(ids[1]))!;
        await approvedDrafts(railDb, p.uid, [at("fh1")]);
        await w.sql(`create or replace function public.r10_refuse_hold() returns trigger language plpgsql as $f$ begin
            if new.user_id = ${q(p.uid)} then raise exception 'r10 test: drafts refused'; end if; return new; end $f$;
          create trigger r10_refuse_hold before update on public.career_outreach_drafts for each row execute function public.r10_refuse_hold()`);
        try {
          const r = await w.web(p, F3);
          assert(r.reply.includes("I could not hold your approved outreach drafts (the write failed), so any approved draft is NOT stopped."), r.reply);
          assert(r.reply.includes("Outreach drafts on record: 0 waiting for your yes, 1 approved,"), `the count is the table's: ${r.reply}`);
          eq(await draftStates(p), { approved: 1 });
        } finally {
          await w.sql(`drop trigger r10_refuse_hold on public.career_outreach_drafts; drop function public.r10_refuse_hold()`);
        }
      });
    } finally {
      await w.stop();
    }
  },
});
