// career-proactive (WO-007b): the scheduled job-alerts run. Logic and tests: ./handler.ts, tests/edge/career-proactive.test.ts.
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import { supabaseAlertStore } from "../_shared/career_alert_store.ts";
import { supabasePostingsDb } from "../_shared/career_ingest.ts";
import { supabaseMailStore } from "../_shared/career_mail_store.ts";
import { CAREER_READ_SCOPE, careerToken, careerTokenFor, readMailSince, type TokenDeps } from "../_shared/career_mail_gmail.ts";
import { mailModelWiring } from "../_shared/career_mail_model.ts";
import { supabaseEventStore } from "../_shared/agent/timeline.ts";
import { supabaseDigestStore, supabaseInterviewStore } from "../_shared/career_brief_store.ts";
import { supabaseConfirmStore } from "../_shared/career_apply_confirm.ts";
import { handleProactive } from "./handler.ts";
import { supabaseClosingRows } from "../_shared/career_closing.ts";
import { runOutreachReplies, runOutreachSends, supabaseOutreachStore } from "../_shared/career_outreach.ts";
import { peopleSink, supabasePeopleDeps } from "../_shared/career_people.ts";
import { gmailSender, gmailThreadReader } from "../_shared/career_outreach_gmail.ts";
import { runOutreachFollowupsGated } from "../_shared/career_outreach_track.ts";
import { runRepliesLane } from "../_shared/career_outreach_replies.ts";
import { callModel, modelConfig } from "../_shared/model_gateway.ts";
import { vaultRefreshWrite } from "../_shared/oauth_vault_refresh.ts";

// The career Google grant (vault oauth_google_career_<uid>), read the same way by mail tracking and outreach.
const grant = (admin: any): TokenDeps => ({
  env: Deno.env, fetch, now: Date.now,
  connection: async (u) => {
    const { data, error } = await admin.from("user_oauth_connections").select("vault_name,scopes").eq("user_id", u).eq("provider", "google_career").maybeSingle();
    if (error) throw new Error(`read the career grant: ${error.message}`);
    return data ?? null;
  },
  readVault: async (name) => {
    const { data, error } = await admin.rpc("oauth_vault_read", { p_name: name });
    if (error) throw new Error("read the career grant's vault entry");
    return data ? String(data) : null;
  },
  writeVault: (name, secret) => vaultRefreshWrite(admin, name, secret, "save the refreshed career grant"),
});

serve((req) => {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response(JSON.stringify({ error: "not configured: Supabase URL or service key missing" }), { status: 503, headers: { "content-type": "application/json" } });
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const postings = supabasePostingsDb(admin);
  return handleProactive(req, {
    env: Deno.env, now: Date.now, store: () => supabaseAlertStore(admin), events: () => supabaseEventStore(admin),
    recentPostings: (since) => postings.newSince(since), postingsById: (ids) => postings.getMany(ids),
    closing: supabaseClosingRows(admin),
    finishedApplications: async (since) => {
      // An application emailed from the chat was already said there when it went (WO-032); it gets no second receipt.
      const { data, error } = await admin.from("career_apply_jobs").select("id,user_id,company,url,state,reason,confirmation_id,email_confirmed_at,evidence,source")
        .in("state", ["confirmed", "submitted_unconfirmed", "needs_user", "failed", "not_submitted", "unknown_outcome"]).gte("updated_at", since)
        .or("source.is.null,source.neq.email").limit(2000);
      if (error) throw new Error(`read finished applications: ${error.message}`);
      // With each, the person's zone and quiet hours (null and the defaults when none are on file): a receipt waits them out.
      const users = [...new Set((data ?? []).map((r: any) => r.user_id))];
      if (!users.length) return [];
      const prefs = await admin.from("career_alert_prefs").select("user_id,tz,prefs").in("user_id", users);
      if (prefs.error) throw new Error(`read quiet hours: ${prefs.error.message}`);
      const of = new Map((prefs.data ?? []).map((p: any) => [p.user_id, p]));
      return (data ?? []).map((r: any) => {
        const p: any = of.get(r.user_id);
        return { ...r, tz: p?.tz ?? null, quiet_start: p?.prefs?.quiet_start, quiet_end: p?.prefs?.quiet_end };
      });
    },
    readyApplications: async () => {
      const { data, error } = await admin.from("career_apply_prepared").select("id,user_id,company,card_lines,created_at")
        .eq("state", "ready").order("created_at", { ascending: true }).limit(2000);
      if (error) throw new Error(`read prepared applications: ${error.message}`);
      const users = [...new Set((data ?? []).map((r: any) => r.user_id))];
      if (!users.length) return [];
      const prefs = await admin.from("career_alert_prefs").select("user_id,tz,prefs").in("user_id", users);
      if (prefs.error) throw new Error(`read quiet hours: ${prefs.error.message}`);
      const of = new Map((prefs.data ?? []).map((p: any) => [p.user_id, p]));
      return (data ?? []).map((r: any) => {
        const p: any = of.get(r.user_id);
        return { ...r, tz: p?.tz ?? null, quiet_start: p?.prefs?.quiet_start, quiet_end: p?.prefs?.quiet_end };
      });
    },
    pushCard: async (userId, ids, text) => {
      const { data, error } = await admin.rpc("career_apply_card_push_as", { p_user: userId, p_ids: ids, p_text: text });
      if (error) throw new Error(`push a card: ${error.message}`);
      return data ?? null;
    },
    // FEATURE 3 (prepareAhead) is not wired here: preparing runs the engine's dry run in a browser, which an edge function
    // cannot start. The host that has the engine runs the same rail (career_proactive_run.ts runPrepareAhead) with
    // `deno run -A workers/career-browser/prepare-ahead.ts daily` under CAREER_PREPARE_AHEAD=on.
    // Mail tracking (WO-024) reads people's mail, so it runs only once the owner turns it on at deploy.
    mail: Deno.env.get("CAREER_MAIL_TRACKING") === "on" ? {
      store: () => supabaseMailStore(admin),
      confirm: () => supabaseConfirmStore(admin),
      read: (userId, since, now) => readMailSince({ fetch, token: careerToken(grant(admin)) }, userId, since, now),
      // WO-040: the model's second look at ambiguous mail (OpenAI, CAREER_MODEL), only once the owner turns it on.
      model: Deno.env.get("CAREER_MAIL_MODEL") === "on" ? () => mailModelWiring(Deno.env, admin) : undefined,
    } : undefined,
    // Outreach (WO-033) sends from people's own Gmail, so it runs only once the owner turns it on (CAREER_OUTREACH_SEND=on):
    // one approved send per person per run, then the replies on threads already sent ("stop", bounces, answers).
    // FAMILY NETWORKING: follow-up reminders on networking mail the person sent (career_outreach_track.ts), once each, to
    // their outbox; they need no Gmail, so they run with CAREER_OUTREACH_FOLLOWUPS=on even while sending is off.
    outreach: Deno.env.get("CAREER_OUTREACH_SEND") === "on" || Deno.env.get("CAREER_OUTREACH_FOLLOWUPS") === "on" ? async (now) => {
      const store = supabaseOutreachStore(admin);
      const quiet = async (ids: string[]) => {
        const { data, error } = await admin.rpc("career_quiet_users", { p_users: ids });
        if (error) throw new Error(`read who is paused: ${error.message}`);
        return new Set<string>((data ?? []).map((r: any) => String(r.user_id ?? r)));
      };
      const followups = await runOutreachFollowupsGated(Deno.env, { store, outbox: supabaseAlertStore(admin), now, quiet }).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      if (Deno.env.get("CAREER_OUTREACH_SEND") !== "on") return { followups };
      const events = supabaseEventStore(admin), deps = grant(admin);
      const token = (u: string, scope: string) => careerTokenFor(deps, scope)(u);
      const tz = async (u: string) => { const { data } = await admin.from("career_alert_prefs").select("tz").eq("user_id", u).maybeSingle(); return data?.tz ?? undefined; };
      // WO-091c: the sends and the replies each run on their own; a failure in one is reported and the other still runs.
      const msg = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });
      const sends = await runOutreachSends({ store, sender: gmailSender({ fetch, token }), now, tz, events }).catch(msg);
      const replies = await runOutreachReplies({ store, read: gmailThreadReader({ fetch, token }), now, events }).catch(msg);
      return { ...sends, replies, ...(followups ? { followups } : {}) };
    } : undefined,
    // MASS NETWORKING M5: replies on sent outreach (Gmail; Outlook once M4's ports are passed), follow-ups after the
    // person's own interval, and calls from their calendar, every send and event only from an approved exact payload. On
    // only when the owner turns it on (CAREER_OUTREACH_REPLIES=on); the model reads replies and drafts only with
    // CAREER_OUTREACH_REPLIES_MODEL=on (OpenAI through the gateway; no other spend).
    replies: Deno.env.get("CAREER_OUTREACH_REPLIES") === "on" ? async (now) => {
      const deps = grant(admin);
      const model = Deno.env.get("CAREER_OUTREACH_REPLIES_MODEL") === "on"
        ? (payload: any) => callModel({ ...modelConfig(Deno.env, "chat"), model: Deno.env.get("CAREER_MODEL") || "gpt-5-mini" }, payload, { role: "chat" }) : null;
      return await runRepliesLane({ admin, fetch, token: (u, scope) => careerTokenFor(deps, scope)(u), outbox: supabaseAlertStore(admin), model, now });
    } : undefined,
    // Introduction reminders (D-033) queue the reminder a person asked for to the outbox at its date; the run record's
    // count needs 20261027020000_career_intro_reminder_push.sql, so this runs only once the owner turns it on at
    // deploy, after that migration. The chat reads the same switch for its words (supabasePeopleDeps' introPush, wired in
    // agent-chat), and both read the same texting-channel check: a person with no texting channel is never queued.
    introReminders: Deno.env.get("CAREER_INTRO_REMINDERS") === "on" ? (() => {
      const deps = supabasePeopleDeps(admin, { fetch, token: async () => null, introPush: true });
      const people = deps.store;
      return { due: (nowIso: string) => people.dueIntros(nowIso), canText: deps.canText,
        markReminded: async (userId: string, n: number) => { await people.updateIntro(userId, n, { reminded_at: new Date().toISOString() }); } };
    })() : undefined,
    // People finding (follow-up on #222): unfinished Gmail reads ("who do I know at Ramp", job alerts) carried on in leased
    // batches, read with the career grant's gmail.readonly. Needs 20261027170100_career_people_gmail_sweep.sql, so it runs
    // only once the owner turns it on at deploy (CAREER_PEOPLE_SWEEP=on); the chat's words read the same switch.
    peopleSweeps: Deno.env.get("CAREER_PEOPLE_SWEEP") === "on" ? (() => {
      const deps = supabasePeopleDeps(admin, { fetch, token: careerTokenFor(grant(admin), CAREER_READ_SCOPE), introPush: false, sweepPush: true });
      return { sweeps: deps.sweeps!, sink: peopleSink(deps.store), gmail: deps.gmail! };
    })() : undefined,
    // Briefs, interview drafts and the weekly digest (WO-034) need 20261021050000_career_brief_digest.sql, so they run only
    // once the owner turns them on at deploy, after that migration.
    briefs: Deno.env.get("CAREER_BRIEF_DIGEST") === "on" ? {
      interviews: () => supabaseInterviewStore(admin), drafts: () => supabaseMailStore(admin), digest: () => supabaseDigestStore(admin),
    } : undefined,
    // WO-032: which application an employer's email confirms, when two fit, asked once.
    asks: () => supabaseConfirmStore(admin),
    // WO-091c: paused, opted out or erased (career_quiet_users, 20261022120000_career_control_state.sql): nothing is
    // started for them. A read that fails throws, and that rail starts nothing this run.
    quiet: async (ids) => {
      const out = new Set<string>();
      for (let i = 0; i < ids.length; i += 500) {
        const { data, error } = await admin.rpc("career_quiet_users", { p_users: ids.slice(i, i + 500) });
        if (error) throw new Error(`read who is paused: ${error.message}`);
        // PROACTIVE SCENARIOS (2026-10-29): a one-column RETURNS TABLE can come back as bare ids (Postgres makes it a
        // function of that one type) or as {user_id}; read as {user_id} only, bare ids made nobody paused, and a paused or
        // stopped person got every alert and receipt queued. Either shape is read.
        for (const r of data ?? []) out.add(String(r?.user_id ?? r));
      }
      return out;
    },
    // The watch records behind alerts set by text (career_watch_alerts.ts): the run sends only what these say now. A read
    // that fails throws, and no watch alert goes out this run.
    watches: async (ids) => {
      const out = new Map<string, unknown>();
      for (let i = 0; i < ids.length; i += 500) {
        const part = ids.slice(i, i + 500);
        const { data, error } = await admin.from("career_watch_kv").select("user_id,value").in("user_id", part).in("key", part.map((u) => `career:watch-profile:${u}`));
        if (error) throw new Error(`read watch records: ${error.message}`);
        for (const r of data ?? []) out.set(String(r.user_id), r.value);
      }
      return out;
    },
    // WO-032: the questions a preparation left open, pushed once (career_apply_questions_push_as decides the rest).
    questions: {
      open: async () => {
        const { data, error } = await admin.from("career_apply_questions").select("id,user_id,key,kind,label,type,options,company,job_ids,misfit,answer,ai_policy,created_at,pushed_at")
          .eq("state", "open").order("created_at", { ascending: true }).limit(2000);
        if (error) throw new Error(`read open questions: ${error.message}`);
        const users = [...new Set((data ?? []).map((r: any) => r.user_id))];
        if (!users.length) return [];
        const prefs = await admin.from("career_alert_prefs").select("user_id,tz,prefs").in("user_id", users);
        if (prefs.error) throw new Error(`read quiet hours: ${prefs.error.message}`);
        const of = new Map((prefs.data ?? []).map((p: any) => [p.user_id, p]));
        return (data ?? []).map((r: any) => {
          const p: any = of.get(r.user_id);
          return { ...r, options: Array.isArray(r.options) ? r.options.map(String) : [], job_ids: r.job_ids ?? [], tz: p?.tz ?? null, quiet_start: p?.prefs?.quiet_start, quiet_end: p?.prefs?.quiet_end };
        });
      },
      push: async (userId, ids, text) => {
        const { data, error } = await admin.rpc("career_apply_questions_push_as", { p_user: userId, p_ids: ids, p_text: text });
        if (error) throw new Error(`push questions: ${error.message}`);
        return !!data;
      },
    },
    recordRun: async (r) => {
      const row: Record<string, unknown> = { run_at: r.at, users: r.users, alerts: r.alerts, held: r.held, reports: r.reports, duplicates: r.duplicates, postings: r.postings, receipts: r.receipts ?? 0, cards: r.cards ?? 0, statuses: r.statuses ?? 0, followups: r.followups ?? 0,
        questions: r.questions ?? 0, confirmations: r.confirmations ?? 0, asks: r.asks ?? 0, ms: r.ms, error: r.error };
      // WO-091c: every rail's failure, by rail (the column is 20261022120000_career_control_state.sql's).
      if (r.errors) row.errors = r.errors;
      if (Deno.env.get("CAREER_BRIEF_DIGEST") === "on") Object.assign(row, { briefs: r.briefs ?? 0, brief_ms_max: r.brief_ms_max ?? null, digests: r.digests ?? 0 });
      if (Deno.env.get("CAREER_INTRO_REMINDERS") === "on") row.intro_reminders = r.intro_reminders ?? 0;
      if (Deno.env.get("CAREER_PEOPLE_SWEEP") === "on") row.people_sweeps = r.people_sweeps ?? 0;
      const { error } = await admin.from("career_proactive_runs").insert(row);
      if (error) throw new Error(`record run: ${error.message}`);
    },
  });
});
