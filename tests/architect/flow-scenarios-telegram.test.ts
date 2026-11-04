// The Telegram chat flow end to end on Postgres (2026-10-30): 80 conversations sampled from the Telegram scenarios
// (tests/architect/scenarios/telegram-generator.ts; every scenario runs over memory stores in scenarios-telegram.test.ts)
// through the REAL trainee-telegram webhook, composed exactly as its index.ts composes it (handleTelegram with the inbound
// store over supabase-js, agent-chat through chatThroughAgent, the head-start deliverer, the service client for the files
// and the buttons), the real agent-chat handler (handler-career.ts handleChat), trainee-deliver's real handler for the
// every-minute run, on a real Postgres 16 with every migration (tests/flow/pg.ts) behind the PostgREST double
// (tests/flow/postgrest.ts). Telegram is a fake Bot API (scenarios/telegram-bot-api.ts) and the model a scripted wire; every other
// host is refused and recorded (asserted empty). Then the database is read back:
//   order      20 chats (10 pairs), updates retried and out of order: every update one turn (agent_messages), one reply row
//              (career_outbox reply:tg:<update_id>), delivered to that chat; a retried update adds nothing.
//   updates    10 people: sticker, voice, an edit, a group message, a channel post, a photo, a block: no turn for any of them;
//              voice and photo told what to send instead; nothing to a group; the block recorded as the person's STOP.
//   webhook    10 updates with a wrong or missing secret: 403, nothing claimed (channel_inbound), no contact, no account.
//   identity   5 allow-listed phones shared with Telegram's own button: an account, and a first turn (never an empty one,
//              never "I couldn't answer that"); 5 forwarded contacts (another user id, one carrying an allowed phone): nothing.
//   stop       10 people with proactive messages queued: /stop holds every one (skipped_opt_out), /start resumes.
//   taps       10 job cards over the real tables and RPCs (career_watch_kv, career_postings, career_apply_prepared,
//              career_apply_card_confirm_as): Confirm queues exactly the shown payload once (twice, a retried update);
//              a changed payload, a closed posting, a posting past its deadline, LinkedIn, another person's chat: nothing.
//   overflow   5 long answers (#301) with the hosted page set up but no signed links: the rest comes as one second
//              message, never as a Mini App URL sent as a plain link.
//   budget     5 turns that need the model with the day's budget used up: no request reaches the model, a short honest reply.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/flow-scenarios-telegram.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { generate, rng, pick } from "./scenarios/telegram-generator.ts";
import { fakeBot, plainOf } from "./scenarios/telegram-bot-api.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { chatThroughAgent, deliverer } from "../../supabase/functions/_shared/channel_runtime.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { CHAT_DOWN_REPLY, PHONE_NOT_YOURS_REPLY, VOICE_NOT_READ_REPLY, PHOTO_NOT_READ_REPLY } from "../../supabase/functions/_shared/channel_inbound.ts";
import { CHANNEL_REPLIES } from "../../supabase/functions/_shared/channel.ts";
import { hashTag, refOf } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

const CI = Deno.env.get("CI") === "true";
const TOKEN = "123456:TEST-flow-telegram-token-not-real", SECRET = "TEST_flow_webhook_secret_0123456789_abcdefgh";
const PERSON = (n: number) => `7b0f8f8e-6a43-4a49-9d2c-0000001e${String(n).padStart(4, "0")}`;
const CHAT = (n: number) => 7730000 + n;
const PHONE = (n: number) => `+1555019${String(n).padStart(4, "0")}`;
const SOURCE = "https://www.bls.gov/ooh/healthcare/registered-nurses.htm";
const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const LONG = Array.from({ length: 14 }, (_, i) => `Step ${["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen"][i]} is to keep a plain record of what you tried and what you learned from it, so the next try is better than the last one.`).join(" ");

Deno.test({
  name: "Telegram on Postgres: 80 conversations through the real webhook, agent-chat and delivery; the database read back",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING",
      "CAREER_ACCOUNT_MEMORY", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS", "MODEL_BUDGET_PAUSED", "TRAINEE_FILE_BASE_URL",
      "TRAINEE_FILE_LINK_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_USERNAME", "TELEGRAM_LOGIN_URL", "TRAINEE_SIGNUP", "TRAINEE_ALLOWED_CONTACTS", "CAREER_REPLY_WRITER",
      "CAREER_TEXTING_NATIVE", "TRAINEE_DELIVER_SECRET", "LOOPMESSAGE_API_KEY", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "TRAINEE_LOGO_URL", "TRAINEE_LOGO_GUESS"];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    for (const k of keys) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    const realFetch = globalThis.fetch;
    const failures: string[] = [];
    const fail = (who: string, why: string) => failures.push(`${who}: ${why}`);
    try {
      await supabaseParity(pg);
      h = await careerHandler(pg, {});
      const { handleChat } = await import("../../supabase/functions/agent-chat/handler-career.ts");
      const bot = fakeBot({ token: TOKEN, now: Date.now });
      const openai = { chat: 0, responses: 0 };
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      // ---------------------------------------------------------------------------------------- the scripted Anthropic wire
      const completion = (body: any, message: any) => Response.json({ id: "chatcmpl-test", model: body.model, choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 300, completion_tokens: 200 } });
      const fakeModel = async (req: Request) => {
        const body = await req.json().catch(() => ({}));
        if (/\/responses$/.test(new URL(req.url).pathname)) {
          openai.responses++;
          const url = "https://www.bls.gov/ooh/healthcare/registered-nurses.htm";
          return Response.json({ output: [{ type: "web_search_call", action: { type: "search", sources: [{ url }] } },
            { type: "message", content: [{ type: "output_text", text: JSON.stringify({ facts: [{ kind: "path", text: "Registered nurses usually take a nursing program and pass a licensing exam.", quote: "pass the NCLEX-RN", url }] }), annotations: [] }] }],
            usage: { input_tokens: 900, output_tokens: 120 } });
        }
        openai.chat++;
        const msgs: any[] = body.messages ?? [];
        const system = String(msgs.find((m) => m.role === "system")?.content ?? "");
        const tools: string[] = (body.tools ?? []).map((x: any) => x.function?.name);
        if (/You name the occupation/.test(system)) return completion(body, { role: "assistant", content: JSON.stringify({ field: "nursing" }) });
        if (!msgs.some((m) => m.role === "tool") && tools.includes("research_career_question")) {
          const user = String(msgs.filter((m) => m.role === "user").pop()?.content ?? "");
          return completion(body, { role: "assistant", content: null, tool_calls: [{ id: `call-${openai.chat}`, type: "function", function: { name: "research_career_question", arguments: JSON.stringify({ question: user.slice(0, 200) }) } }] });
        }
        return completion(body, { role: "assistant", content: LONG });
      };
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin === new URL(SUPABASE_URL).origin && u.pathname === "/functions/v1/agent-chat") return await handleChat(req);
        if (u.origin === new URL(SUPABASE_URL).origin) return await viaDouble(req);
        if (u.host === "api.telegram.org") return await bot.fetch(req);
        if (u.pathname === "/v1/moderations" || (await req.clone().text()).includes("TRAINEE_CRISIS_SCREEN")) return Response.json({ id: "screen", model: "screen", results: [{ flagged: false, categories: {} }], choices: [{ index: 0, message: { role: "assistant", content: "NO" }, finish_reason: "stop" }], content: [{ type: "text", text: "NO" }], stop_reason: "end_turn", usage: { prompt_tokens: 1, completion_tokens: 1, input_tokens: 1, output_tokens: 1 } }); // #354: the crisis screen's moderation and classifier calls, not counted (architect OK 2026-11-02)
        if (u.host === "api.anthropic.com") return anthropicWire(req, (chat) => fakeModel(new Request("https://fake.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify(chat) })));
        outbound.push(`${req.method} ${u.host}`);
        throw new TypeError(`network refused: ${u.host}`);
      }) as typeof fetch;
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      const sql = async (s: string) => (await pg.sql(s)).trim();
      const json = async (s: string) => JSON.parse((await sql(`select coalesce(json_agg(x), '[]') from (${s}) x`)) || "[]");

      // ------------------------------------------------------------------------------------------ the deployment's secrets
      const allowed = [...Array.from({ length: 30 }, (_, i) => `telegram:${CHAT(i)}`), ...Array.from({ length: 5 }, (_, i) => PHONE(40 + i))];
      for (const [k, v] of Object.entries({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeFlowBot", TRAINEE_SIGNUP: "closed",
        TRAINEE_ALLOWED_CONTACTS: allowed.join(","), TRAINEE_DELIVER_SECRET: "TEST-deliver-secret-0123456789-abcdefgh" })) Deno.env.set(k, v);
      // ------------------------------------------------------------------------------------------ the webhook, as index.ts composes it
      let upd = 5000, mid = 100;
      const post = async (body: Record<string, unknown>, o: { id?: number; secret?: string | null } = {}) => {
        await sql("delete from public.agent_rate_limits");
        const id = o.id ?? ++upd;
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (o.secret !== null) headers["x-telegram-bot-api-secret-token"] = o.secret ?? SECRET;
        const deliverNow = deliverer(admin, Deno.env);
        const res = await handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, { method: "POST", headers, body: JSON.stringify({ update_id: id, ...body }) }),
          { env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), chat: chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "telegram" }), admin,
            deliver: (a) => deliverNow({ userId: a.userId, key: a.key, now: a.now }) });
        return { id, status: res.status, body: await res.text() };
      };
      const from = (chat: number) => ({ chat: { id: chat, type: "private" }, from: { id: chat, is_bot: false, first_name: "TEST" }, date: 1 });
      const text = (chat: number, words: string, id?: number) => post({ message: { message_id: ++mid, ...from(chat), text: words } }, { id });
      const tap = (chat: number, data: string, id?: number) => post({ callback_query: { id: `cbq-${++mid}`, from: { id: chat, is_bot: false }, message: { message_id: 1, chat: { id: chat, type: "private" }, date: 1 }, data } }, { id });
      const runDeliver = async () => {
        const res = await handleDeliver(new Request("http://x/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": Deno.env.get("TRAINEE_DELIVER_SECRET")! } }), {
          env: Deno.env, now: Date.now, store: () => supabaseChannelStore(admin), send: () => async () => ({ ok: false, error: "no iMessage here", retryable: false }), adapters: (env) => adaptersFromEnv(env),
          recordRun: async (r) => { const { error } = await admin.from("channel_delivery_runs").insert({ run_at: r.at, delivered: r.delivered, failed: r.failed, retried: r.retried, skipped_opt_out: r.skipped_opt_out, capped: r.capped, swept: r.swept, ms: r.ms, error: r.error, held: r.held ?? 0, nudged: r.nudged ?? 0, not_wired: r.not_wired ?? 0 }); if (error) throw new Error(error.message); },
        });
        return await res.json();
      };
      const userOfChat = async (chat: number) => await sql(`select coalesce((select user_id::text from public.channel_contacts where contact = 'tg:${chat}'), '')`);
      const seed = async (n: number, extra = "") => {
        await sql(`insert into auth.users (id, email) values ('${PERSON(n)}', 'tgflow${n}@example.test'); insert into public.profiles (id) values ('${PERSON(n)}');
          insert into public.career_watch_kv (user_id, key, value) values ('${PERSON(n)}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
          insert into public.channel_contacts (contact, user_id, last_inbound_at, created_at) values ('tg:${CHAT(n)}', '${PERSON(n)}', now() - interval '1 hour', now() - interval '2 days'); ${extra}`);
      };
      const turnsOf = async (user: string) => Number(await sql(`select count(*) from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${user}' and m.role = 'user'`));
      const counts: Record<string, number> = {};
      const bump = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };
      const S = generate({ seed: 20261030 });

      // ------------------------------------------------------------------------------------------ order: 10 pairs of chats
      await t.step("order: 20 chats, retried and out-of-order updates, each once, each reply to its own chat", async () => {
        const sample = S.filter((s) => s.kind === "order" && s.chats.length === 2).slice(0, 10) as Extract<(typeof S)[number], { kind: "order" }>[];
        const WORDS = ["hi", "what can you do?", "how does this work?", "show my applications", "help me find a job", "what should I do next?"];
        for (const [p, s] of sample.entries()) {
          const chats = [CHAT(2 * p), CHAT(2 * p + 1)];
          const ups = s.updates.slice(0, 5).map((u, k) => ({ id: 60000 + p * 20 + k, chat: chats[s.chats.indexOf(u.chat)], text: WORDS[(p + k) % WORDS.length] }));
          const order = s.deliveries.filter((k) => k < ups.length);
          for (const k of [0, ...order]) {
            const r = await text(ups[k].chat, ups[k].text, ups[k].id);
            if (r.status !== 200) fail(`order ${p}`, `status ${r.status} ${r.body.slice(0, 120)}`);
            bump("updates");
          }
          for (const chat of chats) {
            const mine = ups.filter((u) => u.chat === chat);
            if (!mine.length) continue;
            const user = await userOfChat(chat);
            if (!user) { fail(`order ${p}`, `no account for chat ${chat}`); continue; }
            const turns = await turnsOf(user);
            if (turns !== mine.length) fail(`order ${p} chat ${chat}`, `${turns} turns for ${mine.length} updates`);
            const rows = await json(`select key, status, contact from public.career_outbox where user_id = '${user}' and key like 'reply:tg:%'`);
            for (const u of mine) {
              const its = rows.filter((r: any) => r.key === `reply:tg:${u.id}` || r.key.startsWith(`reply:tg:${u.id}:`));
              if (!its.length) fail(`order ${p}`, `no reply row for update ${u.id}`);
              for (const r of its) if (r.status !== "delivered" || r.contact !== `tg:${chat}`) fail(`order ${p}`, `reply row ${JSON.stringify(r)}`);
            }
            const said = bot.to(chat).map(plainOf);
            if (said.length < mine.length) fail(`order ${p} chat ${chat}`, `${said.length} messages for ${mine.length} updates`);
            if (said.some((x) => x === CHAT_DOWN_REPLY)) fail(`order ${p}`, "I couldn't answer that");
          }
          if (await sql(`select count(*) from public.channel_inbound where provider_message_id in (${ups.map((u) => `'${u.id}'`).join(",")})`) !== String(ups.length)) fail(`order ${p}`, "not every update claimed exactly once");
        }
      });

      // ------------------------------------------------------------------------------------------ updates: 10 people
      await t.step("updates: stickers, voice, edits, groups, channel posts, photos, a block: no turn, the plain answer, nothing to a group", async () => {
        for (let n = 20; n < 30; n++) {
          await seed(n);
          const chat = CHAT(n), group = -1001000000000 - n, m = () => ({ message_id: ++mid, ...from(chat) });
          const before = { turns: await turnsOf(PERSON(n)), said: bot.to(chat).length };
          await post({ message: { ...m(), sticker: { file_id: "s", file_unique_id: `us${n}`, type: "regular", width: 1, height: 1, is_animated: false, is_video: false } } });
          await post({ edited_message: { ...m(), text: "edited", edit_date: 2 } });
          await post({ message: { message_id: ++mid, chat: { id: group, type: "supergroup", title: "TEST group" }, from: { id: chat, is_bot: false }, date: 1, text: "show my applications" } });
          await post({ channel_post: { message_id: ++mid, chat: { id: group, type: "channel" }, date: 1, text: "a post" } });
          await post({ message: { ...m(), voice: { file_id: "v", file_unique_id: `uv${n}`, duration: 2 } } });
          await post({ message: { ...m(), photo: [{ file_id: "p", file_unique_id: `up${n}`, width: 1, height: 1 }] } });
          if (n % 2) await post({ my_chat_member: { chat: { id: chat, type: "private" }, from: { id: chat, is_bot: false }, date: 1, old_chat_member: { status: "member" }, new_chat_member: { status: "kicked" } } });
          bump("updates", n % 2 ? 7 : 6);
          if (await turnsOf(PERSON(n)) !== before.turns) fail(`updates ${n}`, "a model turn ran for an update that is not a message to answer");
          const said = bot.to(chat).slice(before.said).map(plainOf);
          if (JSON.stringify(said) !== JSON.stringify([VOICE_NOT_READ_REPLY, PHOTO_NOT_READ_REPLY])) fail(`updates ${n}`, `said ${JSON.stringify(said).slice(0, 200)}`);
          if (bot.msgs.some((x) => Number(x.chat) < 0)) fail(`updates ${n}`, "something went to a group");
          if (n % 2 && await sql(`select opted_out::text from public.channel_contacts where contact = 'tg:${chat}'`) !== "true") fail(`updates ${n}`, "the block was not recorded");
        }
      });

      // ------------------------------------------------------------------------------------------ webhook: 10 refused
      await t.step("webhook: a wrong or missing secret is refused, nothing processed", async () => {
        for (let n = 30; n < 40; n++) {
          const calls = bot.calls.length;
          const r = await post({ message: { message_id: ++mid, ...from(CHAT(n)), text: "hi" } }, { secret: n % 2 ? null : `${SECRET.slice(0, -1)}X` });
          bump("updates");
          if (r.status !== 403) fail(`webhook ${n}`, `status ${r.status}`);
          if (r.body.includes(SECRET) || r.body.includes(TOKEN)) fail(`webhook ${n}`, "the response carries a secret");
          if (bot.calls.length !== calls) fail(`webhook ${n}`, "a Bot API call");
          if (await sql(`select count(*) from public.channel_inbound where provider_message_id = '${r.id}'`) !== "0") fail(`webhook ${n}`, "claimed");
          if (await sql(`select count(*) from public.channel_contacts where contact = 'tg:${CHAT(n)}'`) !== "0") fail(`webhook ${n}`, "a contact recorded");
        }
      });

      // ------------------------------------------------------------------------------------------ identity: 10
      await t.step("identity: an allowed phone shared with the button makes the account and a first turn; a forwarded contact links nothing", async () => {
        for (let n = 40; n < 50; n++) {
          const chat = CHAT(n), own = n < 45;
          const before = bot.to(chat).length;
          const r = await post({ message: { message_id: ++mid, ...from(chat), contact: { phone_number: own ? PHONE(n) : PHONE(40 + (n % 5)), first_name: "TEST", user_id: own ? chat : 999000 + n } } });
          bump("updates");
          const said = bot.to(chat).slice(before).map(plainOf);
          const user = await userOfChat(chat);
          if (r.status !== 200) fail(`identity ${n}`, `status ${r.status}`);
          if (own) {
            if (!user) fail(`identity ${n}`, "an allow-listed phone shared from Telegram made no account");
            if (said.includes(CHAT_DOWN_REPLY)) fail(`identity ${n}`, `sharing their own phone got "I couldn't answer that": ${JSON.stringify(said).slice(0, 160)}`);
            if (!said.length) fail(`identity ${n}`, "silence");
            if (user && await turnsOf(user) < 1) fail(`identity ${n}`, "no first turn");
            if (user && await sql(`select count(*) from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${user}' and m.role = 'user' and btrim(m.content) = ''`) !== "0") fail(`identity ${n}`, "an empty turn");
          } else {
            if (user) fail(`identity ${n}`, "a forwarded contact made or linked an account");
            if (JSON.stringify(said) !== JSON.stringify([PHONE_NOT_YOURS_REPLY])) fail(`identity ${n}`, `said ${JSON.stringify(said).slice(0, 160)}`);
            if (await sql(`select count(*) from auth.users where email = 'tg-${chat}@users.trainee.invalid'`) !== "0") fail(`identity ${n}`, "an account");
          }
        }
      });

      // ------------------------------------------------------------------------------------------ stop: 10
      await t.step("stop: /stop holds every proactive message, /start resumes", async () => {
        for (let n = 50; n < 60; n++) await seed(n);
        for (let n = 50; n < 60; n++) for (const k of ["alert", "digest", "brief"]) await sql(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values ('${PERSON(n)}', '${k}:fs${n}', '${k}', 'TEST ${k} for ${n}', now() - interval '1 minute')`);
        for (let n = 50; n < 60; n++) { const r = await text(CHAT(n), n % 2 ? "/stop" : "STOP"); bump("updates"); if (!bot.to(CHAT(n)).map(plainOf).includes(CHANNEL_REPLIES.stop)) fail(`stop ${n}`, `no STOP reply (${r.body.slice(0, 100)})`); }
        // every run until nothing is due (a run takes a bounded batch)
        let run1: any = null;
        for (let k = 0; k < 6 && Number(await sql(`select count(*) from public.career_outbox where status = 'queued' and key like '%:fs%'`)) > 0; k++) run1 = await runDeliver();
        for (let n = 50; n < 60; n++) {
          const rows = await json(`select key, status, error from public.career_outbox where user_id = '${PERSON(n)}' and key like '%:fs${n}'`);
          for (const r of rows) if (r.status !== "skipped_opt_out") fail(`stop ${n}`, `${r.key} ${r.status} after STOP (${r.error ?? ""}; run ${JSON.stringify(run1).slice(0, 200)})`);
          if (bot.to(CHAT(n)).some((m) => /^TEST (alert|digest|brief) for/.test(plainOf(m)))) fail(`stop ${n}`, "a proactive message went out after STOP");
        }
        for (let n = 50; n < 60; n++) { await text(CHAT(n), n % 2 ? "/start" : "START"); bump("updates"); await sql(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values ('${PERSON(n)}', 'brief:fs${n}-after', 'brief', 'TEST brief after START for ${n}', now() - interval '1 minute')`); }
        let run2: any = null;
        for (let k = 0; k < 6 && Number(await sql(`select count(*) from public.career_outbox where status = 'queued' and key like '%:fs%'`)) > 0; k++) run2 = await runDeliver();
        for (let n = 50; n < 60; n++) {
          const st = await sql(`select status || ' ' || coalesce(error, '') from public.career_outbox where key = 'brief:fs${n}-after'`);
          if (!st.startsWith("delivered")) fail(`stop ${n}`, `after START a new alert was ${st} (run ${JSON.stringify(run2).slice(0, 200)})`);
          for (const m of bot.to(CHAT(n))) if (/TEST (alert|digest|brief) for/.test(m.text) && !m.text.includes(String(n))) fail(`stop ${n}`, "another person's message");
        }
      });

      // ------------------------------------------------------------------------------------------ taps: 10
      await t.step("taps: Confirm queues exactly the shown payload once; changed, closed, past deadline, LinkedIn, another person: nothing", async () => {
        const r = rng(20261030 + 61);
        for (let n = 60; n < 70; n++) {
          const kind = ["clean", "clean", "twice", "retry", "changed", "changed", "closed", "deadline", "linkedin", "other"][n - 60];
          const u = PERSON(n), chat = CHAT(n);
          const company = pick(r, ["Acme", "Globex", "Initech", "Hooli"]);
          const url = kind === "linkedin" ? `https://www.linkedin.com/jobs/view/${880000 + n}` : `https://jobs.lever.co/${company.toLowerCase()}/${880000 + n}`;
          const jobId = `lever:${company.toLowerCase()}:${880000 + n}`;
          await seed(n, `${confirmedResumeSql(u)} insert into storage.objects (bucket_id, name) values ('career-resumes', '${u}/' || repeat('a', 64) || '.pdf');
            insert into public.career_postings (job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at, closed_at)
              values (${q(jobId)}, 'lever', ${q(company.toLowerCase())}, ${q(company)}, 'Data Analyst (TEST)', 'Austin, TX', ${q(url)}, 'Requirements\nSQL and dashboards.', now() - interval '2 hours', now() - interval '2 hours', now(), ${kind === "closed" ? "now() - interval '5 minutes'" : "null"});`);
          const prep = async (v: number) => JSON.parse(await sql(`with p as (select jsonb_build_object('version',1,'user_id','${u}','job_id',${q(jobId)},'company',${q(company)},'url',${q(url)},'fields',jsonb_build_array(jsonb_build_object('name','first_name','label','First name','value','Alex ${v}')),'privacy_epoch',0,'account_version',0,'expires_at',now()+interval '1 day','resume_sha256',repeat('a',64)) as pl)
            insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines) select '${u}', ${q(jobId)}, ${q(company)}, ${q(url)}, pl, public.career_apply_payload_hash(pl), array[${q(company)}] from p returning json_build_object('id', id, 'hash', payload_hash)`));
          const first = await prep(1);
          const ref = await refOf(u, jobId);
          const job = { job_id: jobId, company, title: "Data Analyst (TEST)", location: "Austin, TX", url, pay: null, level: null, remote: null, posted_at: null, first_seen_at: null,
            deadline: kind === "deadline" ? new Date(Date.now() - 86400000).toISOString() : null, source: "Lever", reasons: [], gaps: [], company_domain: null };
          await sql(`insert into public.career_watch_kv (user_id, key, value) values ('${u}', 'tg:job:${ref}', ${q(JSON.stringify({ job, shownAs: "text" }))}::jsonb)`);
          const before = bot.to(chat).length;
          await tap(chat, `jca:${ref}`); bump("updates");
          const shown = bot.to(chat).slice(before).flatMap((m) => m.buttons).find((b) => /^jcy:/.test(b.callback_data ?? ""))?.callback_data as string | undefined;
          const allowed = kind !== "closed" && kind !== "deadline" && kind !== "linkedin";
          if (allowed && shown !== `jcy:${ref}:${hashTag(first.hash)}`) fail(`taps ${n} ${kind}`, `Apply did not show the payload with its hash-bound Confirm: ${shown} ${JSON.stringify(bot.to(chat).slice(before).map(plainOf)).slice(0, 200)}`);
          if (!allowed && shown) fail(`taps ${n} ${kind}`, "a Confirm button on a posting that can never be approved");
          const data = shown ?? `jcy:${ref}:${hashTag(first.hash)}`;
          if (kind === "changed") { await sql(`update public.career_apply_prepared set state = 'expired' where id = '${first.id}'`); await prep(2); }
          if (kind === "other") { await seed(80); await tap(CHAT(80), data); bump("updates"); }
          else { const t1 = await tap(chat, data); bump("updates"); if (kind === "twice") { await tap(chat, data); bump("updates"); } if (kind === "retry") { await tap(chat, data, t1.id); bump("updates"); } }
          const jobs = await json(`select user_id, payload_hash, approval_hash, state from public.career_apply_jobs where job_id = ${q(jobId)}`);
          const want = kind === "clean" || kind === "twice" || kind === "retry" ? 1 : 0;
          if (jobs.length !== want) fail(`taps ${n} ${kind}`, `${jobs.length} applications queued, want ${want}: ${JSON.stringify(bot.to(chat).slice(-2).map(plainOf)).slice(0, 240)}`);
          for (const j of jobs) if (j.user_id !== u || j.payload_hash !== first.hash || j.approval_hash !== first.hash) fail(`taps ${n} ${kind}`, `queued not exactly the shown payload: ${JSON.stringify(j)}`);
          if (kind === "other") for (const m of bot.to(CHAT(80))) if (m.text.includes(company) && m.text.includes("Data Analyst")) fail(`taps ${n}`, "another person's chat was shown the posting");
          bump(`taps_${kind}`);
        }
        const answered = new Set(bot.answers.map((a) => a.id));
        if (answered.size !== bot.answers.length) fail("taps", "a tap answered twice");
      });

      // ------------------------------------------------------------------------------------------ overflow and budget (the model)
      // The budget is opened for the overflow turns (setup, as the owner's statement would) and used up for the budget turns.
      await sql(`update public.model_budget_settings set value = to_char((now() - interval '1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') where key = 'window_start';
        update public.model_budget_settings set value = to_char((now() + interval '1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') where key = 'window_end';
        insert into public.model_budget_days (day, limit_micros) values (public.model_budget_day(now()), 20000000), (public.model_budget_day(now() + interval '1 day'), 20000000) on conflict (day) do update set limit_micros = excluded.limit_micros;`);
      for (const [k, v] of Object.entries({ CAREER_BRAIN: "staged", CAREER_KNOWLEDGE: "on", ANTHROPIC_API_KEY: "sk-test-not-real", CAREER_MODEL: "claude-haiku-5-5", CAREER_REPLY_WRITER: "on",
        TRAINEE_FILE_BASE_URL: "https://files.trainee.test/f" })) Deno.env.set(k, v);
      await t.step("overflow (#301): a long answer with the hosted page set up but no signed links: the rest as one second message, never a Mini App URL as a plain link", async () => {
        for (let n = 70; n < 75; n++) {
          await seed(n);
          const before = bot.to(CHAT(n)).length;
          const r = await text(CHAT(n), [`I'm feeling stuck in my job search lately, any thoughts on how to keep going?`,
            `I read ${SOURCE} and I'm feeling stuck in my job search, any thoughts?`, `what do you think about switching careers into nursing? I read ${SOURCE}`,
            `how should I think about my career over the next five years? I read ${SOURCE}`, `give me some advice on staying motivated while job hunting, like ${SOURCE} says`][n - 70]);
          bump("updates");
          const said = bot.to(CHAT(n)).slice(before).map(plainOf);
          if (r.status !== 200) fail(`overflow ${n}`, `status ${r.status}`);
          for (const s of said) if (/[?&]list=/.test(s)) fail(`overflow ${n}`, `a Mini App URL sent as a plain link (it opens signed out): ${s.slice(0, 120)}`);
          const words = said.filter((s) => !/^https?:\/\/\S+$/.test(s.trim()));
          if (words.length > 2) fail(`overflow ${n}`, `${words.length} messages for one answer`);
          if (said.some((x) => x === CHAT_DOWN_REPLY)) fail(`overflow ${n}`, "I couldn't answer that");
          if (words.length === 2) bump("overflow_second_message");
          if (said.some((x) => /^https?:\/\/\S+$/.test(x.trim()))) bump("overflow_link");
          bump(`overflow_${words.length}_messages`);
        }
      });
      await t.step("budget: turns that need the model with the day's budget used up: no request reaches the model, a short honest reply", async () => {
        await sql(`update public.model_budget_days set limit_micros = spent_micros + reserved_micros`);
        for (let n = 75; n < 80; n++) {
          await seed(n);
          const before = { said: bot.to(CHAT(n)).length, chat: openai.chat, responses: openai.responses };
          const r = await text(CHAT(n), "how do I get hired as a nurse?");
          bump("updates");
          const said = bot.to(CHAT(n)).slice(before.said).map(plainOf);
          if (r.status !== 200) fail(`budget ${n}`, `status ${r.status}`);
          if (openai.chat + openai.responses !== before.chat + before.responses) fail(`budget ${n}`, `${openai.chat + openai.responses - before.chat - before.responses} the model requests over the day's budget`);
          if (!said.length) fail(`budget ${n}`, "silence");
          if (said.join("\n").length > 1500) fail(`budget ${n}`, `a long reply with no budget: ${said.join(" ").slice(0, 120)}`);
          if (said.some((x) => /I can't help|I couldn't answer that/.test(x))) fail(`budget ${n}`, `${said.join(" ").slice(0, 160)}`);
          if (said.some((x) => /AI budget|didn't use the AI/.test(x))) bump("budget_said");
        }
        const open = await sql(`select coalesce(sum(reserved_micros), 0) from public.model_budget_days`);
        if (open !== "0") fail("budget", `${open} micro-USD left reserved`);
      });

      // ------------------------------------------------------------------------------------------ every message
      await t.step("every message: to a private chat, within Telegram's limits, valid; nothing left the machine", () => {
        for (const v of bot.violations) fail("Bot API", v);
        if (outbound.length) fail("network", outbound.join(", "));
      });
      console.log(`[flow-telegram] ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}; ${bot.msgs.length} messages, ${bot.answers.length} taps answered; the model chat ${openai.chat}, searches ${openai.responses}; ${failures.length} failures`);
      assertNode.deepEqual(failures, [], failures.join("\n"));
    } finally {
      globalThis.fetch = realFetch;
      h?.restore();
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      await pg.stop();
    }
  },
});
