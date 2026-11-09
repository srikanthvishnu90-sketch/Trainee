// R10 WO-D (owner order 2026-11-09; spec docs/architect/specs/APP-LAYER-15-FIXES.md A.2 search turn 2, A.5 #6, C.24, E.6
// #50-#51; fix 7), as updated by the owner's ruling of 2026-11-09: the per-person daily AI cap is removed (WO-J), so fix 7
// covers every REAL limit: the global AI budget ($70, model_budget.ts), its pause switch, and the provider's rate limit.
// Production, at a limit, sent the graduation-window template with "as of 2026-10-13", then "The limit resets at midnight UTC."
// Replayed through the REAL handler (tests/flow: real supabase-js over the PostgREST double, Postgres 16, every migration),
// staged brain released, a scripted model on the Anthropic wire ($0).
//
//   L1/L2  the production search turns S1 and S2 with the AI switched off: still searched (a search is code's), no template.
//   L3     a turn for the brain while the AI is paused: what stopped, the task kept, nothing applied for; no template text.
//   L4     the global budget used up: the next step is the owner's approval; never a made-up reset time.
//   L5     the provider turns the call away (HTTP 429): the next step at a time in the person's zone ("Chicago time").
//   L6     "continue" while it still holds: the same task stays kept (not "continue"); nothing resumes.
//   L7     "continue" once the provider answers again: the kept task is answered, said as picked up.
//   L8     a person whose zone is unknown: the time is UTC, and the reply says the zone is unknown.
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
import { heldReply, nextStepOf, resumedTask, retryAtOf, stopOfError } from "../../supabase/functions/_shared/limit_stop.ts";
import { ModelUnavailableError, providerError } from "../../supabase/functions/_shared/model_calls.ts";

const CI = Deno.env.get("CI") === "true";
const S1 = "Let's leave the resume for now. Find me 5 data analyst internships in Chicago that are actually open. Show the company, role, location, and application link. Don't apply yet.";
const S2 = "Okay, include business analyst and analytics internships in the Chicago area, plus remote US internships. Even 2 or 3 verified open roles is useful. Show the real links and any student or graduation requirements.";
const ADVICE = "how should I follow up after an interview?";
const ANSWER = "Send a short thank-you within a day.";
const ME = "7b0f8f8e-6a43-4a49-9d2c-000000d10001", NOZONE = "7b0f8f8e-6a43-4a49-9d2c-000000d10002";
const lit = (s: string) => `$q$${s}$q$`;
const TEMPLATE = /The window, checked against the record|I cannot answer that from the record|as of 2026-10-13|Tell me what you'd like to do next|midnight UTC/;
const CHI = { tz: "America/Chicago", city: "Chicago" };

Deno.test("WO-D units: which refusals are limits; the next step in the person's zone; resume only once it can have cleared", async () => {
  // The provider's retry-after header, in seconds or as a date, is read onto the refusal.
  const ra = await providerError(new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), { status: 429, headers: { "retry-after": "90" } }));
  assertNode.equal(ra.retryAfterMs, 90_000);
  assertNode.equal(retryAtOf(ra, 1000), 91_000);
  assertNode.equal((await providerError(new Response("{}", { status: 429 }))).retryAfterMs, null, "no header: no time");
  const at = Date.parse("2026-11-08T23:17:00Z"); // 5:17 PM in Chicago, as in the audit
  assertNode.equal(stopOfError(new ModelUnavailableError(0, "global_daily_limit", "")), "global");
  assertNode.equal(stopOfError(new ModelUnavailableError(0, "budget_paused", "")), "paused");
  assertNode.equal(stopOfError(new ModelUnavailableError(0, "budget_ended", "")), "budget_after");
  assertNode.equal(stopOfError(new ModelUnavailableError(429, "rate_limit_error", "")), "rate_limit");
  assertNode.equal(stopOfError(new ModelUnavailableError(529, "overloaded_error", "")), "rate_limit");
  assertNode.equal(stopOfError(new ModelUnavailableError(500, "api_error", "")), null, "an outage is not a limit");
  assertNode.equal(stopOfError(new Error("x")), null);
  // Architect review (2026-11-09) 7-b: a time only when the provider gave one (its retry-after); never an invented wait.
  assertNode.equal(nextStepOf("rate_limit", CHI, at + 120_000), `The AI service is turning requests away for now. Say "continue" after 5:19 PM Chicago time and I'll pick it up.`);
  assertNode.equal(nextStepOf("rate_limit", null, at + 120_000), `The AI service is turning requests away for now. Say "continue" after 11:19 PM UTC (I don't know your time zone) and I'll pick it up.`);
  assertNode.equal(nextStepOf("rate_limit", CHI, null), `The AI service is turning requests away for now and didn't say when it will take them again. Say "continue" later and I'll pick it up.`);
  assertNode.match(nextStepOf("global", CHI), /used up, and more needs the owner's approval/);
  assertNode.ok(!/\d:\d\d|minutes?/.test(nextStepOf("unchecked", CHI)), "no invented time when the budget could not be read");
  assertNode.equal(heldReply(ADVICE, "paused", CHI), `I couldn't finish this without the AI: "how should I follow up after an interview?". I kept it. Trainee's AI is switched off for a short while. Say "continue" later and I'll pick it up. Nothing was applied for, and searching postings still works now.`);
  const held = { heldAtLimit: { message: ADVICE, at, stop: "rate_limit" } };
  assertNode.equal(resumedTask(held, "continue", at + 30_000), null, "too soon");
  assertNode.deepEqual(resumedTask(held, "ok, go ahead", at + 120_000), held.heldAtLimit);
  assertNode.equal(resumedTask(held, "find me jobs", at + 120_000), null, "only a continuation resumes it");
  // 7-a (D-046): there is no per-person daily stop: its refusal type is not a limit any more.
  assertNode.equal(stopOfError(new ModelUnavailableError(429, "daily_limit", "")), "rate_limit", "a 429 from anywhere is a rate limit, never a person's daily cap");
});

Deno.test({
  name: "WO-D replay: at real limits (global pause, global budget, provider 429) through the real handler on real Postgres",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_JUDGE", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS",
      "MODEL_BUDGET_PAUSED", "MODEL_BUDGET_TARGET_USD", "MODEL_BUDGET_HARD_USD", "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET", "TELEGRAM_BOT_TOKEN", "CAREER_REPLY_WRITER", "CAREER_APPLY_LINK", "CAREER_SEND_RAIL",
      "CAREER_APPLY_ALL_YES", "CAREER_PREPARE_AHEAD_URL"];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    for (const k of keys) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch, realError = console.error, realNow = Date.now;
    const wire = { chat: 0, refuse: false, lastSystem: "", retryAfter: "120" as string | null };
    try {
      await supabaseParity(pg);
      const prefs = JSON.stringify({ on: false, keywords: ["data analyst"], locations: [], remote_ok: true, report_hour: 8, quiet_start: 22, quiet_end: 7, max_instant_per_day: 3 });
      await pg.sql(`insert into auth.users (id, email) values ('${ME}', 'd1@example.test'), ('${NOZONE}', 'd2@example.test');
        insert into public.profiles (id) values ('${ME}'), ('${NOZONE}');
        insert into public.career_watch_kv (user_id, key, value) values ('${ME}', 'career:account', '{"epoch":0,"version":0,"paused":false}'), ('${NOZONE}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
        insert into public.career_alert_prefs (user_id, tz, prefs, last_checked_at) values ('${ME}', 'America/Chicago', ${lit(prefs)}::jsonb, now());
        insert into public.career_postings (job_id, provider, board, company, title, location, url, description, first_seen_at, last_seen_at) values
          ('greenhouse:acme:101', 'greenhouse', 'acme', 'Acme Freight', 'Data Analyst Intern', 'Chicago, IL', 'https://boards.greenhouse.io/acme/jobs/101', 'Hybrid. Open to students graduating between December 2026 and June 2028.', now() - interval '2 days', now()),
          ('greenhouse:prairie:103', 'greenhouse', 'prairie', 'Prairie Bank', 'Business Analyst Intern', 'Evanston, IL', 'https://boards.greenhouse.io/prairie/jobs/103', 'On-site.', now() - interval '2 days', now());`);
      h = await careerHandler(pg, { me: ME, nozone: NOZONE });
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.host === "api.anthropic.com") {
          wire.chat++;
          if (wire.refuse) return Response.json({ type: "error", error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit" } }, { status: 429, headers: wire.retryAfter ? { "retry-after": wire.retryAfter } : {} });
          return anthropicWire(req, (b: any) => { wire.lastSystem = String((b.messages ?? []).find((m: any) => m.role === "system")?.content ?? ""); return Response.json({ id: "d", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 8 } }); });
        }
        if (u.host === "boards-api.greenhouse.io") return Response.json({ id: 1 });
        if (u.origin !== new URL(SUPABASE_URL).origin) { outbound.push(`${req.method} ${u.host}`); throw new TypeError(`network refused: ${u.host}`); }
        return await viaDouble(req);
      }) as typeof fetch;
      console.error = () => {};
      Deno.env.set("CAREER_BRAIN", "staged");
      Deno.env.set("ANTHROPIC_API_KEY", "sk-test-not-real");
      const n = async (sql: string) => Number(await pg.sql(sql));
      const effects = async () => ({ jobs: await n(`select count(*) from public.career_apply_jobs`), wanted: await n(`select count(*) from public.career_apply_wanted`), send: await n(`select count(*) from public.career_send_queue`) });
      const zero = await effects();
      const me = h.chat("me");
      const say = async (c: ReturnType<NonNullable<typeof h>["chat"]>, m: string) => { await pg.sql(`delete from public.agent_rate_limits`); const r = await c.say(m); assertNode.equal(r.status, 200, r.reply); return r; };

      Deno.env.set("MODEL_BUDGET_PAUSED", "true");
      await t.step("L1/L2: with the AI switched off, S1 and S2 are still searched (code, no model), never a template", async () => {
        const before = wire.chat;
        const r1 = await say(me, S1), r2 = await say(me, S2);
        console.log(`--- L1 S1, AI off (${r1.intent})\n${r1.reply}\n--- L2 S2, AI off (${r2.intent})\n${r2.reply}`);
        assertNode.equal(wire.chat, before, "no model call");
        assertNode.match(r1.reply, /^1\. Data Analyst Intern at Acme Freight/m);
        assertNode.match(r2.reply, /^2\. Business Analyst Intern at Prairie Bank — Evanston, IL/m);
        for (const r of [r1, r2]) assertNode.ok(!TEMPLATE.test(r.reply), r.reply);
      });

      await t.step("L3: a brain turn while the AI is paused: what stopped, kept, nothing applied for, no template", async () => {
        const r = await say(me, ADVICE);
        console.log(`--- L3 paused (${r.intent})\n${r.reply}`);
        assertNode.equal(r.intent, "career_limit_held");
        assertNode.equal(r.body.meta?.limit_stop, "paused");
        assertNode.match(r.reply, /^I couldn't finish this without the AI: "how should I follow up after an interview\?"\. I kept it\. Trainee's AI is switched off for a short while\./);
        assertNode.match(r.reply, /Nothing was applied for/);
        assertNode.ok(!TEMPLATE.test(r.reply) && !r.reply.includes(ANSWER), r.reply);
      });
      Deno.env.delete("MODEL_BUDGET_PAUSED");

      await t.step("L4: the global budget used up: the next step is the owner's approval, no invented reset time", async () => {
        Deno.env.set("MODEL_BUDGET_TARGET_USD", "0.000001"); Deno.env.set("MODEL_BUDGET_HARD_USD", "0.000001");
        const r = await say(me, ADVICE);
        console.log(`--- L4 global budget (${r.intent})\n${r.reply}`);
        assertNode.equal(r.body.meta?.limit_stop, "global", JSON.stringify(r.body.meta));
        assertNode.match(r.reply, /Trainee's AI budget is used up, and more needs the owner's approval/);
        assertNode.ok(!TEMPLATE.test(r.reply) && !/resets at/.test(r.reply), r.reply);
        // Architect ruling 3: a message the router answers with a specific intent keeps that answer at a limit (interview attire).
        const attire = await say(me, "what should I wear to a video interview?");
        console.log(`--- L4b interview attire at the budget limit (${attire.intent})\n${attire.reply}`);
        Deno.env.delete("MODEL_BUDGET_TARGET_USD"); Deno.env.delete("MODEL_BUDGET_HARD_USD");
        assertNode.equal(attire.body.meta?.limit_answer, "router", JSON.stringify(attire.body.meta));
        assertNode.notEqual(attire.intent, "career_limit_held");
        assertNode.ok(!/^I couldn't finish this without the AI/.test(attire.reply), "the router's interview-prep answer stands");
        assertNode.match(attire.reply, /\b(?:wear|dress)\b/i, "an answer about what to wear");
        assertNode.match(attire.reply, /Trainee has used up its AI budget/, "and the budget note says the AI was not used");
        assertNode.ok(!TEMPLATE.test(attire.reply), attire.reply);
      });

      let at429 = 0;
      await t.step("L5: the provider turns the call away (429): the next step at a time in Chicago time", async () => {
        wire.refuse = true; at429 = realNow();
        const r = await say(me, ADVICE);
        console.log(`--- L5 provider 429 (${r.intent})\n${r.reply}`);
        assertNode.equal(r.body.meta?.limit_stop, "rate_limit");
        assertNode.match(r.reply, /The AI service is turning requests away for now\. Say "continue" after \d{1,2}(:\d\d)? [AP]M Chicago time and I'll pick it up\./, "the provider's retry-after, in Chicago time");
        assertNode.ok(!TEMPLATE.test(r.reply), r.reply);
      });

      await t.step("L6: 'continue' while it still holds keeps the same task", async () => {
        const r = await say(me, "continue");
        console.log(`--- L6 (${r.intent})\n${r.reply}`);
        assertNode.match(r.reply, /^I couldn't finish this without the AI: "how should I follow up after an interview\?"/);
        assertNode.ok(!/^Picking up/.test(r.reply));
      });

      await t.step("L8: a person whose zone is unknown: UTC, and said", async () => {
        const r = await say(h!.chat("nozone"), ADVICE);
        console.log(`--- L8 (${r.intent})\n${r.reply}`);
        assertNode.match(r.reply, /Say "continue" after \d{1,2}(:\d\d)? [AP]M UTC \(I don't know your time zone\)/);
        // 7-b: a 429 without retry-after gives no time at all.
        wire.retryAfter = null;
        const n = await say(h!.chat("nozone"), ADVICE);
        console.log(`--- L8b 429 without retry-after (${n.intent})\n${n.reply}`);
        assertNode.equal(n.intent, "career_limit_held");
        assertNode.match(n.reply, /didn't say when it will take them again\. Say "continue" later/);
        assertNode.ok(!/after \d{1,2}(:\d\d)? [AP]M/.test(n.reply), "no invented time");
        wire.retryAfter = "120";
      });

      await t.step("L7: 'continue' once the provider answers again: the kept task is answered", async () => {
        wire.refuse = false;
        Date.now = () => at429 + 3 * 60_000;
        const before = wire.chat;
        const r = await say(me, "continue");
        console.log(`--- L7 (${r.intent})\n${r.reply}`);
        assertNode.ok(wire.chat > before, "the model answers");
        assertNode.match(r.reply, /^Picking up what the limit stopped: "how should I follow up after an interview\?"\n/);
        assertNode.ok(r.reply.includes(ANSWER), r.reply);
        // Architect ruling 2: the brain reads "continue" with the kept ask as a labelled system note.
        assertNode.match(wire.lastSystem, /The person's unfinished ask from \d{4}-\d\d-\d\d \d\d:\d\d UTC \(kept when a limit stopped it; they have now said "continue", so answer this ask\): "how should I follow up after an interview\?"/, wire.lastSystem.slice(-400));
        Date.now = realNow;
      });

      assertNode.deepStrictEqual(await effects(), zero, "nothing applied for, queued or sent");
      assertNode.deepStrictEqual(outbound, [], "no request left but the fakes");
    } finally {
      Date.now = realNow;
      console.error = realError;
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      h?.restore();
      await pg.stop();
    }
  },
});
