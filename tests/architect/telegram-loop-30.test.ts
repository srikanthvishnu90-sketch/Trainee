// TELEGRAM LOOP (release item 14, 2026-11-10): 30 scripted conversations through the REAL trainee-telegram webhook, composed as
// its index.ts composes it (handleTelegram, the inbound store over supabase-js, agent-chat through chatThroughAgent, the
// head-start deliverer, the service client), the REAL agent-chat handler (handler-career.ts handleChat) with the release flags
// as served, and trainee-deliver's real handler for the every-minute run, on a real Postgres 16 with every migration
// (tests/flow/pg.ts). Telegram is a fake Bot API (scenarios/telegram-bot-api.ts, plus getFile and the file download); the model
// is a scripted stand-in at the Anthropic URL; every other host is refused and recorded (asserted empty).
//
// The conversations: onboarding, sign-in by the person themselves (Telegram's verified phone, never a password or code in
// chat; a code or password typed in chat is removed before it is stored), a File card (the list link with Telegram's own
// sign-in button), attachments both ways (a resume PDF in, a document out), a long reply split into bubbles, a yes to an
// exact batch (two applications, one card), STOP and pause, duplicate update ids, out-of-order delivery, a bot-blocked
// error, a 429 and a dropped connection.
//
// The bar, read back from the database and the fake Bot API, printed as one TELEGRAM_LOOP line:
//   exactly_once   every reply row (career_outbox reply:tg:<update>) delivered once: its provider_ids are messages the bot
//                  received in that chat, and no Telegram message id is claimed by two rows; a retried update adds nothing.
//   secrets        0: no bot token, webhook secret, service key, link secret, API key, or a code or password the person typed,
//                  in any message, button, stored turn or outbox row.
//   bubbles        0 violations: every text 1-4,096 characters, every caption at most 1,024, valid UTF-8 and HTML.
//   dropped        0: every update that is a turn has its reply delivered, or (the chat blocked Trainee) recorded as that
//                  person's STOP and never retried; nothing left queued or reserved.
// Run (as an unprivileged user: initdb refuses root):
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/telegram-loop-30.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { virtualClock } from "../flow/virtual-clock.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { confirmedResumeSql } from "../flow/resume-seed.ts";
import { fakeBot, plainOf } from "./scenarios/telegram-bot-api.ts";
import { resumeFile } from "./scenarios/onboarding-r2-generator.ts";
import { rng } from "./scenarios/onboarding-r2-generator.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { chatThroughAgent, deliverer } from "../../supabase/functions/_shared/channel_runtime.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { CHAT_DOWN_REPLY, PHONE_NOT_YOURS_REPLY, PHOTO_NOT_READ_REPLY, SHARE_PHONE_ASK, VOICE_NOT_READ_REPLY } from "../../supabase/functions/_shared/channel_inbound.ts";
import { CHANNEL_REPLIES } from "../../supabase/functions/_shared/channel.ts";
import { CODE_IN_CHAT_REPLY } from "../../supabase/functions/_shared/career_code_in_chat.ts";
import { FILE_APP_BUTTON } from "../../supabase/functions/_shared/telegram.ts";
import { RELEASE_FLAGS, RELEASE_NEVER_ON, RELEASE_PENDING } from "../../supabase/functions/agent-chat/release_config.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";
// architect amendment E.21 (2026-11-10): a search's posting-page checks are held to helpers/posting_checks.ts (no board listing, at most N for the N shown, never over 10); every other off-machine request is still a fault.
import { postingChecks } from "./helpers/posting_checks.ts";

const CI = Deno.env.get("CI") === "true";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
const TOKEN = "123456:TEST-loop-token-not-real", SECRET = "TEST_loop_webhook_secret_0123456789_abcd";
const DELIVER = "TEST-loop-deliver-secret-0123456789-abcdefgh", LINK_SECRET = "TEST-loop-file-link-secret-0123456789-abcdef", API_KEY = "sk-test-loop-not-real";
const FILE_BASE = "https://files.trainee.test/f";
const PERSON = (n: number) => `7b0f8f8e-6a43-4a49-9d2c-0000003e${String(n).padStart(4, "0")}`;
const CHAT = (n: number) => 7840000 + n;
const PHONE = (n: number) => `+1555028${String(n).padStart(4, "0")}`;
const TYPED_SECRETS = ["482913", "Tr0ub4dor!x", "K7X9P2"]; // what people type in chat that must never be stored or repeated
const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const LONG = Array.from({ length: 60 }, (_, i) => `Week ${i + 1}: pick five postings that fit what you have confirmed, tailor one line of your summary to each, and write down what you learned from the last round so the next one is better.`).join(" ");

Deno.test({
  name: "Telegram loop (item 14): 30 conversations through the real webhook, agent-chat and delivery on Postgres; exactly once, no secrets, bubbles in limits, nothing dropped",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_NETWORKING_DRAFT", "ANTHROPIC_API_KEY", "CAREER_MODEL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_USERNAME", "TELEGRAM_LOGIN_URL",
      "TRAINEE_SIGNUP", "TRAINEE_ALLOWED_CONTACTS", "TRAINEE_DELIVER_SECRET", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "LOOPMESSAGE_API_KEY", "WHATSAPP_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID", "TRAINEE_FILE_BASE_URL", "TRAINEE_FILE_LINK_SECRET", "MODEL_PROVIDER", "CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS", "MODEL_BUDGET_PAUSED",
      ...Object.keys(RELEASE_FLAGS), ...RELEASE_NEVER_ON, ...Object.keys(RELEASE_PENDING)];
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
      const pace = virtualClock();
      // Per-chat Bot API behaviour: a chat that blocked Trainee (403), a 429 once, or a dropped connection once.
      const blocked = new Set<string>(), limitOnce = new Set<string>(), dropOnce = new Set<string>();
      const bot = fakeBot({ token: TOKEN, now: pace.clock, fail: ({ method, body }) => {
        const chat = String(body.chat_id ?? "");
        if (blocked.has(chat) && method !== "answerCallbackQuery") return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 });
        if (limitOnce.delete(chat) && method === "sendMessage") return Response.json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } }, { status: 429 });
        return null;
      } });
      const files = new Map<string, { bytes: Uint8Array; size: number }>();
      const model = { calls: 0, brain: 0, tools: new Set<string>() };
      const completion = (body: any, message: any) => Response.json({ id: "chatcmpl-loop", model: body.model, choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 300, completion_tokens: 120 } });
      const fakeModel = (body: any) => {
        model.calls++;
        const msgs: any[] = body.messages ?? [];
        const tools: string[] = (body.tools ?? []).map((x: any) => x.function?.name ?? x.name);
        const user = String(msgs.filter((m) => m.role === "user").pop()?.content ?? "");
        if (tools.length) {
          model.brain++;
          tools.forEach((x) => model.tools.add(x));
          const toolDone = msgs.some((m) => m.role === "tool");
          if (/tailor/i.test(user) && tools.includes("tailor_resume") && !toolDone) {
            return completion(body, { role: "assistant", content: null, tool_calls: [{ id: `call-${model.calls}`, type: "function", function: { name: "tailor_resume", arguments: JSON.stringify({ job_id: "greenhouse:acmetest:6000" }) } }] });
          }
          if (/tailor/i.test(user)) return completion(body, { role: "assistant", content: "Your resume for Acme TEST is attached." });
          if (/detailed|whole plan|everything/i.test(user)) return completion(body, { role: "assistant", content: LONG });
          return completion(body, { role: "assistant", content: "Hi, I'm Trainee, your job search assistant. Tell me what you're looking for, or paste your resume and I'll confirm each entry with you." });
        }
        return completion(body, { role: "assistant", content: "Subject: A quick question\n\nHi there,\n\nWould you be open to a short call?" });
      };
      const viaDouble = globalThis.fetch, outbound: string[] = [], checks = postingChecks();
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const req = input instanceof Request && !init ? input : new Request(input as any, init);
        const u = new URL(req.url);
        if (u.origin === new URL(SUPABASE_URL).origin && u.pathname === "/functions/v1/agent-chat") return await handleChat(req);
        if (u.origin === new URL(SUPABASE_URL).origin) return await viaDouble(req);
        if (u.host === "api.telegram.org" && u.pathname === `/bot${TOKEN}/getFile`) {
          const id = String((await req.json()).file_id), f = files.get(id);
          if (!f) return Response.json({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, { status: 400 });
          return Response.json({ ok: true, result: { file_id: id, file_unique_id: `u${id}`, file_size: f.size, file_path: `documents/${id}.bin` } });
        }
        if (u.host === "api.telegram.org" && u.pathname.startsWith(`/file/bot${TOKEN}/documents/`)) {
          const f = files.get(decodeURIComponent(u.pathname.split("/").pop()!.replace(/\.bin$/, "")));
          return f ? new Response(f.bytes as BodyInit) : new Response("not found", { status: 404 });
        }
        if (u.host === "api.telegram.org") {
          const chat = await req.clone().text().then((s) => { try { return String(JSON.parse(s).chat_id ?? ""); } catch { return ""; } });
          if (chat && dropOnce.delete(chat)) throw new TypeError("error sending request: connection reset");
          return await bot.fetch(req);
        }
        if (u.host === "api.anthropic.com") return anthropicWire(req, (chat) => fakeModel(chat));
        if (checks.take(req.method, req.url)) throw new TypeError(`network refused: ${u.host}`);
        outbound.push(`${req.method} ${u.host}${u.pathname}`);
        throw new TypeError(`network refused: ${u.host}`);
      }) as typeof fetch;
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      const sql = async (s: string) => (await pg.sql(s)).trim();
      const json = async (s: string) => JSON.parse((await sql(`select coalesce(json_agg(x), '[]') from (${s}) x`)) || "[]");

      const allowed = [...Array.from({ length: 40 }, (_, i) => `telegram:${CHAT(i)}`), PHONE(4)];
      for (const [k, v] of Object.entries({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeLoopBot", TRAINEE_SIGNUP: "closed",
        TRAINEE_ALLOWED_CONTACTS: allowed.join(","), TRAINEE_DELIVER_SECRET: DELIVER, ANTHROPIC_API_KEY: API_KEY, CAREER_MODEL: "claude-haiku-5-5",
        TRAINEE_FILE_BASE_URL: FILE_BASE, TRAINEE_FILE_LINK_SECRET: LINK_SECRET })) Deno.env.set(k, v);

      // ------------------------------------------------------------------------------------------ the webhook, as index.ts composes it
      type Expect = "turn" | "fixed" | "nothing" | "refused";
      const log: { conv: string; id: number; chat: number; expect: Expect; said: string[]; status: number }[] = [];
      let upd = 90000, mid = 100, conv = "";
      const post = async (chat: number, body: Record<string, unknown>, expect: Expect, o: { id?: number; secret?: string | null } = {}) => {
        await sql("delete from public.agent_rate_limits");
        const id = o.id ?? ++upd;
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (o.secret !== null) headers["x-telegram-bot-api-secret-token"] = o.secret ?? SECRET;
        const before = bot.msgs.length;
        const deliverNow = deliverer(admin, Deno.env, pace);
        const res = await checks.turn(`update ${id}`, () => handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, { method: "POST", headers, body: JSON.stringify({ update_id: id, ...body }) }),
          { env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), chat: chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "telegram" }), admin,
            deliver: (a) => deliverNow({ userId: a.userId, key: a.key, now: a.now }) }), () => bot.msgs.slice(before).filter((m) => m.chat === String(chat)).map(plainOf).join("\n"));
        const text = await res.text();
        if ([TOKEN, SECRET, DELIVER, LINK_SECRET, API_KEY, SERVICE_KEY].some((s) => text.includes(s))) fail(conv, `a secret in the webhook response for update ${id}`);
        const said = bot.msgs.slice(before).filter((m) => m.chat === String(chat)).map(plainOf);
        log.push({ conv, id, chat, expect, said, status: res.status });
        return { id, status: res.status, said, msgs: bot.msgs.slice(before).filter((m) => m.chat === String(chat)) };
      };
      const from = (chat: number) => ({ chat: { id: chat, type: "private" }, from: { id: chat, is_bot: false, first_name: "TEST" }, date: 1 });
      const say = (chat: number, words: string, o: { id?: number; expect?: Expect } = {}) => post(chat, { message: { message_id: ++mid, ...from(chat), text: words } }, o.expect ?? "turn", o);
      const tap = (chat: number, data: string, o: { id?: number } = {}) => post(chat, { callback_query: { id: `cbq-${++mid}`, from: { id: chat, is_bot: false }, message: { message_id: 1, chat: { id: chat, type: "private" }, date: 1 }, data } }, "nothing", o);
      const runDeliver = async () => {
        const res = await handleDeliver(new Request("http://x/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": DELIVER } }), {
          env: Deno.env, now: Date.now, store: () => supabaseChannelStore(admin), send: () => async () => ({ ok: false, error: "no iMessage here", retryable: false }),
          adapters: (env) => adaptersFromEnv(env, { clock: pace.clock, sleep: pace.sleep }),
          recordRun: async (r) => { const { error } = await admin.from("channel_delivery_runs").insert({ run_at: r.at, delivered: r.delivered, failed: r.failed, retried: r.retried, skipped_opt_out: r.skipped_opt_out, capped: r.capped, swept: r.swept, ms: r.ms, error: r.error, held: r.held ?? 0, nudged: r.nudged ?? 0, not_wired: r.not_wired ?? 0 }); if (error) throw new Error(error.message); },
        });
        return await res.json();
      };
      const userOf = async (chat: number) => await sql(`select coalesce((select user_id::text from public.channel_contacts where contact = 'tg:${chat}'), '')`);
      const seed = async (n: number, extra = "") => {
        await sql(`insert into auth.users (id, email) values ('${PERSON(n)}', 'tgloop${n}@example.test'); insert into public.profiles (id) values ('${PERSON(n)}');
          insert into public.career_watch_kv (user_id, key, value) values ('${PERSON(n)}', 'career:account', '{"epoch":0,"version":0,"paused":false}');
          insert into public.channel_contacts (contact, user_id, last_inbound_at, created_at) values ('tg:${CHAT(n)}', '${PERSON(n)}', now() - interval '1 hour', now() - interval '2 days'); ${extra}`);
      };
      const turnsOf = async (user: string) => Number(await sql(`select count(*) from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${user}' and m.role = 'user'`));
      const expectSaid = (who: string, r: { said: string[] }, re: RegExp, what: string) => { if (!r.said.some((s) => re.test(s))) fail(who, `${what}: ${JSON.stringify(r.said).slice(0, 300)}`); };
      const convs: string[] = [];
      const conversation = async (name: string, fn: () => Promise<void>) => {
        conv = name; convs.push(name);
        const before = failures.length;
        try { await fn(); } catch (e) { fail(name, `threw: ${String((e as Error)?.stack ?? e).slice(0, 400)}`); }
        console.log(`TELEGRAM_LOOP_CONV ${name} ${failures.length === before ? "PASS" : "FAIL"}`);
      };

      // Postings for the searches: twelve live ones in Chicago (more than MASS_FROM, so the list goes as one File link).
      const COMPANIES = ["Acme", "Globex", "Initech", "Hooli", "Umbrella", "Stark", "Wayne", "Wonka", "Tyrell", "Cyberdyne", "Soylent", "Vandelay"];
      await sql(`insert into public.career_postings (job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at) values ${COMPANIES.map((c, i) =>
        `(${q(`greenhouse:${c.toLowerCase()}test:${6000 + i}`)}, 'greenhouse', ${q(`${c.toLowerCase()}test`)}, ${q(`${c} TEST`)}, 'Software Engineering Intern (TEST)', 'Chicago, IL', ${q(`https://boards.greenhouse.io/${c.toLowerCase()}test/jobs/${6000 + i}`)}, 'Requirements: Python, React, PostgreSQL. Summer 2026 internship.', now() - interval '2 hours', now() - interval '2 hours', now())`).join(",\n")}`);

      await t.step("30 conversations", async () => {
        // ---------------------------------------------------------------- 1-3 onboarding from the first message
        for (const [n, first] of [[0, "hi"], [1, "/start"], [2, "hello, I need a job"]] as const) {
          await conversation(`onboarding-${n + 1}`, async () => {
            const a = await say(CHAT(n), first);
            const user = await userOf(CHAT(n));
            if (!user) return fail(conv, "no account made for an allowed chat");
            expectSaid(conv, a, /Trainee|resume/i, "a first answer that names Trainee or asks for the resume");
            if (a.said.some((s) => /I checked (hello|hi|hey)\b/i.test(s))) fail(conv, "a greeting was searched as a role");
            await say(CHAT(n), `here is my resume:\n${RESUME}`);
            await say(CHAT(n), "yes, that's my resume");
            if (await sql(`select public.career_resume_on_file('${user}')`) !== "t") fail(conv, "the confirmed resume is not on file");
            if (await turnsOf(user) !== 3) fail(conv, `${await turnsOf(user)} turns for 3 messages`);
          });
        }
        // ---------------------------------------------------------------- 4-8 sign-in by the person themselves
        await conversation("signin-phone-share", async () => {
          const chat = CHAT(30); // not on the allow list by chat id; their phone is
          Deno.env.set("TRAINEE_ALLOWED_CONTACTS", allowed.filter((x) => x !== `telegram:${chat}`).join(","));
          Deno.env.set("TELEGRAM_LOGIN_URL", "https://trainee.test/telegram-link");
          const a = await say(chat, "/start", { expect: "fixed" });
          expectSaid(conv, a, new RegExp(SHARE_PHONE_ASK.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "sign-up closed asks for Telegram's verified phone");
          if (a.said.some((s) => /(send|tell|type|give) me (your|the) (password|code)/i.test(s))) fail(conv, "asked for a password or code");
          const kb = a.msgs.map((m) => m.replyMarkup);
          if (!kb.some((k) => (k?.keyboard ?? []).flat().some((b: any) => b.request_contact))) fail(conv, `no share-my-phone button: ${JSON.stringify(kb).slice(0, 300)}`);
          if (!kb.some((k) => (k?.inline_keyboard ?? []).flat().some((b: any) => b.login_url?.url === "https://trainee.test/telegram-link"))) fail(conv, `no Telegram login button: ${JSON.stringify(kb).slice(0, 300)}`);
          const b = await post(chat, { message: { message_id: ++mid, ...from(chat), contact: { phone_number: PHONE(4), first_name: "TEST", user_id: chat } } }, "turn");
          if (!await userOf(chat)) fail(conv, "the person's own verified phone made no account");
          if (!b.said.length || b.said.includes(CHAT_DOWN_REPLY)) fail(conv, `after the share: ${JSON.stringify(b.said).slice(0, 200)}`);
          Deno.env.set("TRAINEE_ALLOWED_CONTACTS", allowed.join(","));
          Deno.env.delete("TELEGRAM_LOGIN_URL");
        });
        await conversation("signin-forwarded-contact", async () => {
          const chat = CHAT(31);
          Deno.env.set("TRAINEE_ALLOWED_CONTACTS", allowed.filter((x) => x !== `telegram:${chat}`).join(","));
          const r = await post(chat, { message: { message_id: ++mid, ...from(chat), contact: { phone_number: PHONE(4), first_name: "TEST", user_id: 999031 } } }, "fixed");
          if (JSON.stringify(r.said) !== JSON.stringify([PHONE_NOT_YOURS_REPLY])) fail(conv, `said ${JSON.stringify(r.said).slice(0, 200)}`);
          if (await userOf(chat)) fail(conv, "someone else's contact linked this chat");
          Deno.env.set("TRAINEE_ALLOWED_CONTACTS", allowed.join(","));
        });
        for (const [n, words, token] of [[3, "Greenhouse sent me code 482913", "482913"], [4, "my workday password is Tr0ub4dor!x", "Tr0ub4dor!x"], [5, "here's my verification code for the portal: K7X9P2", "K7X9P2"]] as const) {
          await conversation(`signin-secret-typed-${n - 2}`, async () => {
            await seed(n);
            const r = await say(CHAT(n), words);
            if (!r.said.join("\n").includes(CODE_IN_CHAT_REPLY.slice(0, 50))) fail(conv, `not the fixed safety reply: ${JSON.stringify(r.said).slice(0, 200)}`);
            if (r.said.some((s) => s.includes(token))) fail(conv, "the code or password was repeated");
            const stored = await sql(`select count(*) from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${PERSON(n)}' and m.content like ${q(`%${token}%`)}`);
            if (stored !== "0") fail(conv, "the code or password was stored in the turn");
          });
        }
        // ---------------------------------------------------------------- 9 a File card
        await conversation("file-card", async () => {
          await seed(6, confirmedResumeSql(PERSON(6)));
          const r = await say(CHAT(6), "find me software engineering internships in Chicago");
          const card = r.msgs.find((m) => m.buttons.some((b: any) => b.web_app?.url));
          if (!card) return fail(conv, `no File card with Telegram's sign-in button: ${JSON.stringify(r.msgs.map((m) => [plainOf(m).slice(0, 80), m.buttons])).slice(0, 400)}`);
          const app = card.buttons.find((b: any) => b.web_app?.url).web_app.url as string;
          if (!app.startsWith(`${FILE_BASE}?list=`)) fail(conv, `the button opens ${app}`);
          if (/[?&]t=/.test(app)) fail(conv, "the Mini App URL carries a sign-in token");
        });
        // ---------------------------------------------------------------- 10-12 attachments both ways
        await conversation("attachment-resume-pdf-in", async () => {
          await seed(7);
          const rf = resumeFile(rng(20261110) as any, "pdf-lines");
          files.set("RES7", { bytes: rf.bytes, size: rf.bytes.length });
          const r = await post(CHAT(7), { message: { message_id: ++mid, ...from(CHAT(7)), document: { file_id: "RES7", file_unique_id: "uRES7", file_name: rf.name, mime_type: rf.mime, file_size: rf.bytes.length } } }, "turn");
          if (!r.said.length) fail(conv, "silence after a resume file");
          if (await sql(`select count(*) from public.career_resume_uploads where user_id = '${PERSON(7)}'`) === "0") fail(conv, "the file was not recorded as the person's upload");
          await say(CHAT(7), "yes");
          if (await sql(`select public.career_resume_on_file('${PERSON(7)}')`) !== "t") fail(conv, `the sent resume, confirmed, is not on file: ${JSON.stringify(log.at(-1)?.said).slice(0, 200)}`);
        });
        await conversation("attachment-photo-voice-in", async () => {
          await seed(8);
          const p = await post(CHAT(8), { message: { message_id: ++mid, ...from(CHAT(8)), photo: [{ file_id: "p8", file_unique_id: "up8", width: 1, height: 1 }] } }, "fixed");
          const v = await post(CHAT(8), { message: { message_id: ++mid, ...from(CHAT(8)), voice: { file_id: "v8", file_unique_id: "uv8", duration: 2 } } }, "fixed");
          if (JSON.stringify([...p.said, ...v.said]) !== JSON.stringify([PHOTO_NOT_READ_REPLY, VOICE_NOT_READ_REPLY])) fail(conv, `said ${JSON.stringify([...p.said, ...v.said]).slice(0, 200)}`);
          if (await turnsOf(PERSON(8)) !== 0) fail(conv, "a turn ran for a photo or a voice note");
        });
        await conversation("attachment-document-out", async () => {
          // A tailored resume PDF from the confirmed record goes back as a Telegram document.
          await say(CHAT(9), "hi");
          await say(CHAT(9), `here is my resume:\n${RESUME}`);
          await say(CHAT(9), "yes, that's my resume");
          const before = bot.calls.filter((c) => c.method === "sendDocument").length;
          const r = await say(CHAT(9), "make my resume a pdf for software engineering internships");
          const docs = bot.calls.filter((c) => c.method === "sendDocument").slice(before);
          if (!docs.length) fail(conv, `no document sent: ${JSON.stringify(r.said).slice(0, 400)}`);
          for (const d of docs) if (String(d.body.chat_id) !== String(CHAT(9))) fail(conv, "a document to another chat");
        });
        // ---------------------------------------------------------------- 13 a long reply split into bubbles
        await conversation("long-reply-bubbles", async () => {
          await seed(10, confirmedResumeSql(PERSON(10)));
          const r = await say(CHAT(10), "give me a detailed plan for my whole job search, everything");
          const words = r.said.filter((s) => !/^https?:\/\/\S+$/.test(s.trim()));
          if (words.length < 2) fail(conv, `one bubble for a ${LONG.length}-character answer: ${words.map((w) => w.length)}`);
          for (const w of words) if (w.length > 4096) fail(conv, `a bubble of ${w.length} characters`);
          const stored = await sql(`select coalesce(max(length(m.content)), 0) from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${PERSON(10)}' and m.role = 'assistant'`);
          console.log(`TELEGRAM_LOOP_LONG bubbles=${words.length} sizes=${words.map((w) => w.length).join(",")} stored=${stored}`);
        });
        // ---------------------------------------------------------------- 14-16 a yes to an exact batch
        const prepare = async (n: number, i: number, first: string) => {
          const c = COMPANIES[i], job = `greenhouse:${c.toLowerCase()}test:${6000 + i}`, url = `https://boards.greenhouse.io/${c.toLowerCase()}test/jobs/${6000 + i}`, sha = (i + 16).toString(16).padStart(2, "0").repeat(32);
          const pl = `jsonb_build_object('version',1,'user_id','${PERSON(n)}','job_id',${q(job)},'company',${q(`${c} TEST`)},'url',${q(url)},'fields',jsonb_build_array(jsonb_build_object('name','first_name','label','First name','value',${q(first)})),'privacy_epoch',0,'account_version',0,'expires_at',now()+interval '1 day','resume_sha256','${sha}')`;
          await sql(`insert into storage.objects (bucket_id, name) values ('career-resumes', '${PERSON(n)}/${sha}.pdf') on conflict (bucket_id, name) do nothing`);
          return JSON.parse((await sql(`insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines) select '${PERSON(n)}', ${q(job)}, ${q(`${c} TEST`)}, ${q(url)}, pl, public.career_apply_payload_hash(pl), array[${q(`${c} TEST — Software Engineering Intern (TEST)`)}, ${q(`First name: ${first}`)}] from (select ${pl} as pl) x returning json_build_object('id', id, 'hash', payload_hash)`)).split("\n")[0]) as { id: string; hash: string };
        };
        const jobsOf = async (n: number) => await json(`select job_id, payload_hash, approval_hash, state from public.career_apply_jobs where user_id = '${PERSON(n)}' order by job_id`);
        await conversation("batch-yes-exact", async () => {
          await seed(11, confirmedResumeSql(PERSON(11)));
          const a = await prepare(11, 0, "Alex"), b = await prepare(11, 1, "Alex");
          const shown = await say(CHAT(11), "show my applications");
          if (!["Acme TEST", "Globex TEST"].every((c) => shown.said.join("\n").includes(c))) fail(conv, `the card does not show both: ${JSON.stringify(shown.said).slice(0, 300)}`);
          await say(CHAT(11), "yes");
          const j = await jobsOf(11);
          const want = [a.hash, b.hash].sort();
          if (JSON.stringify(j.map((x: any) => x.approval_hash).sort()) !== JSON.stringify(want)) fail(conv, `approved ${JSON.stringify(j)} for the batch shown ${JSON.stringify(want)}`);
          for (const x of j) if (x.payload_hash !== x.approval_hash || x.state !== "queued") fail(conv, `not exactly the shown payload, queued: ${JSON.stringify(x)}`);
          await say(CHAT(11), "yes");
          if ((await jobsOf(11)).length !== 2) fail(conv, "a second yes added an application");
        });
        await conversation("batch-changed-before-yes", async () => {
          await seed(12, confirmedResumeSql(PERSON(12)));
          const a = await prepare(12, 2, "Sam"); await prepare(12, 3, "Sam");
          await say(CHAT(12), "show my applications");
          await sql(`update public.career_apply_prepared set payload = jsonb_set(payload, '{fields,0,value}', '"Samuel"'), payload_hash = public.career_apply_payload_hash(jsonb_set(payload, '{fields,0,value}', '"Samuel"')) where id = '${a.id}'`);
          const r = await say(CHAT(12), "yes");
          const j = await jobsOf(12);
          if (j.some((x: any) => x.job_id.includes("initech"))) fail(conv, `the changed application was approved: ${JSON.stringify(j)}`);
          if (j.length && !r.said.join("\n").match(/changed|again|no longer/i)) fail(conv, `approved part of a batch that changed without saying so: ${JSON.stringify(r.said).slice(0, 200)}`);
        });
        await conversation("batch-yes-then-old-tap", async () => {
          await seed(13, confirmedResumeSql(PERSON(13)));
          await prepare(13, 4, "Kim"); await prepare(13, 5, "Kim");
          const shown = await say(CHAT(13), "show my applications");
          const code = shown.msgs.flatMap((m) => m.buttons).find((b: any) => /^tca:/.test(b.callback_data ?? ""))?.callback_data;
          if (!code) return fail(conv, `no Approve button on the card: ${JSON.stringify(shown.msgs.map((m) => m.buttons)).slice(0, 200)}`);
          await tap(CHAT(13), code);
          const once = (await jobsOf(13)).length;
          await tap(CHAT(13), code);
          await say(CHAT(13), "yes");
          if (once !== 2 || (await jobsOf(13)).length !== 2) fail(conv, `${once} then ${(await jobsOf(13)).length} applications for one card of two`);
        });
        // ---------------------------------------------------------------- 17-19 STOP and pause
        await conversation("stop-start", async () => {
          await seed(14);
          await sql(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values ('${PERSON(14)}', 'alert:loop14', 'alert', 'TEST alert for 14', now() - interval '1 minute')`);
          const s = await say(CHAT(14), "STOP", { expect: "fixed" });
          if (!s.said.includes(CHANNEL_REPLIES.stop)) fail(conv, `no STOP reply: ${JSON.stringify(s.said).slice(0, 200)}`);
          await runDeliver();
          if (await sql(`select status from public.career_outbox where key = 'alert:loop14'`) !== "skipped_opt_out") fail(conv, "a proactive message was not held after STOP");
          if (bot.to(CHAT(14)).some((m) => plainOf(m).includes("TEST alert for 14"))) fail(conv, "a proactive message went out after STOP");
          const back = await say(CHAT(14), "START", { expect: "fixed" });
          if (!back.said.includes(CHANNEL_REPLIES.start)) fail(conv, `no START reply: ${JSON.stringify(back.said).slice(0, 200)}`);
        });
        await conversation("stop-then-ask", async () => {
          await seed(15);
          await say(CHAT(15), "/stop", { expect: "fixed" });
          const r = await say(CHAT(15), "what can you do?");
          if (!r.said.length) fail(conv, "a question after STOP got no answer (STOP holds what Trainee sends on its own, not answers)");
        });
        await conversation("pause-everything", async () => {
          await seed(16);
          const r = await say(CHAT(16), "pause everything");
          const paused = await sql(`select coalesce(value->>'paused', '') from public.career_watch_kv where user_id = '${PERSON(16)}' and key = 'career:account'`);
          if (paused !== "true") fail(conv, `not paused (read back ${paused}): ${JSON.stringify(r.said).slice(0, 200)}`);
          await sql(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values ('${PERSON(16)}', 'digest:loop16', 'digest', 'TEST digest for 16', now() - interval '1 minute')`);
          await runDeliver();
          if (bot.to(CHAT(16)).some((m) => plainOf(m).includes("TEST digest for 16"))) fail(conv, "a digest went out while paused");
        });
        // ---------------------------------------------------------------- 20-21 duplicate update ids
        await conversation("duplicate-message-update", async () => {
          await seed(17);
          const first = await say(CHAT(17), "what can you do?");
          const again1 = await say(CHAT(17), "what can you do?", { id: first.id, expect: "nothing" });
          const again2 = await say(CHAT(17), "what can you do?", { id: first.id, expect: "nothing" });
          if (again1.said.length || again2.said.length) fail(conv, "a retried update was answered again");
          if (await turnsOf(PERSON(17)) !== 1) fail(conv, `${await turnsOf(PERSON(17))} turns for one update sent three times`);
        });
        await conversation("duplicate-tap-update", async () => {
          await seed(18, confirmedResumeSql(PERSON(18)));
          await prepare(18, 6, "Lee");
          const shown = await say(CHAT(18), "show my applications");
          const code = shown.msgs.flatMap((m) => m.buttons).find((b: any) => /^tca:/.test(b.callback_data ?? ""))?.callback_data;
          if (!code) return fail(conv, "no Approve button");
          const t1 = await tap(CHAT(18), code);
          await tap(CHAT(18), code, { id: t1.id });
          if ((await jobsOf(18)).length !== 1) fail(conv, `${(await jobsOf(18)).length} applications for one tap retried`);
        });
        // ---------------------------------------------------------------- 22-23 out-of-order delivery
        await conversation("out-of-order-one-chat", async () => {
          await seed(19);
          const ids = [++upd, ++upd, ++upd];
          const words = ["hi", "what can you do?", "how does this work?"];
          for (const k of [2, 0, 1]) await say(CHAT(19), words[k], { id: ids[k] });
          if (await turnsOf(PERSON(19)) !== 3) fail(conv, `${await turnsOf(PERSON(19))} turns for 3 updates out of order`);
        });
        await conversation("out-of-order-two-chats", async () => {
          await seed(20); await seed(21);
          const ids = [++upd, ++upd, ++upd, ++upd];
          const plan: [number, number][] = [[3, 21], [0, 20], [2, 21], [1, 20]];
          for (const [k, n] of plan) await say(CHAT(n), ["hi", "what can you do?", "hello", "how does this work?"][k], { id: ids[k] });
          await say(CHAT(20), "again", { id: ids[0], expect: "nothing" });
          for (const n of [20, 21]) if (await turnsOf(PERSON(n)) !== 2) fail(conv, `chat ${n}: ${await turnsOf(PERSON(n))} turns for 2 updates`);
        });
        // ---------------------------------------------------------------- 24-27 the Bot API refusing or failing
        await conversation("bot-blocked-403", async () => {
          await seed(22);
          blocked.add(String(CHAT(22)));
          await say(CHAT(22), "what can you do?");
          if (await sql(`select opted_out::text from public.channel_contacts where contact = 'tg:${CHAT(22)}'`) !== "true") fail(conv, "the 403 was not recorded as the person's STOP");
          await sql(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values ('${PERSON(22)}', 'alert:loop22', 'alert', 'TEST alert for 22', now() - interval '1 minute')`);
          const calls = bot.calls.filter((c) => String(c.body.chat_id) === String(CHAT(22))).length;
          await runDeliver(); await runDeliver();
          const after = bot.calls.filter((c) => String(c.body.chat_id) === String(CHAT(22))).length;
          if (after > calls) fail(conv, `${after - calls} more calls to a chat that blocked Trainee`);
          blocked.delete(String(CHAT(22)));
        });
        await conversation("kicked-member-update", async () => {
          await seed(23);
          await post(CHAT(23), { my_chat_member: { chat: { id: CHAT(23), type: "private" }, from: { id: CHAT(23), is_bot: false }, date: 1, old_chat_member: { status: "member" }, new_chat_member: { status: "kicked" } } }, "nothing");
          if (await sql(`select opted_out::text from public.channel_contacts where contact = 'tg:${CHAT(23)}'`) !== "true") fail(conv, "the block was not recorded");
        });
        await conversation("rate-limited-429", async () => {
          await seed(24);
          limitOnce.add(String(CHAT(24)));
          await say(CHAT(24), "what can you do?", { expect: "turn" });
          await pace.sleep(5000); await new Promise((r) => setTimeout(r, 3500)); // the 429's retry_after, on the bot's clock and the database's
          for (let k = 0; k < 3; k++) await runDeliver();
        });
        await conversation("connection-dropped", async () => {
          await seed(25);
          dropOnce.add(String(CHAT(25)));
          await say(CHAT(25), "how does this work?", { expect: "turn" });
          for (let k = 0; k < 3; k++) await runDeliver();
        });
        // ---------------------------------------------------------------- 28-30 what is not a message to answer
        await conversation("edited-message", async () => {
          await seed(26);
          await say(CHAT(26), "hi");
          await post(CHAT(26), { edited_message: { message_id: mid, ...from(CHAT(26)), text: "hi there", edit_date: 2 } }, "nothing");
          if (await turnsOf(PERSON(26)) !== 1) fail(conv, "an edit ran a turn");
        });
        await conversation("group-message", async () => {
          await seed(27);
          await post(CHAT(27), { message: { message_id: ++mid, chat: { id: -1001000000027, type: "supergroup", title: "TEST" }, from: { id: CHAT(27), is_bot: false }, date: 1, text: "show my applications" } }, "nothing");
          if (bot.msgs.some((m) => Number(m.chat) < 0)) fail(conv, "a message to a group");
        });
        await conversation("wrong-secret", async () => {
          const r = await post(CHAT(28), { message: { message_id: ++mid, ...from(CHAT(28)), text: "hi" } }, "refused", { secret: `${SECRET.slice(0, -1)}X` });
          if (r.status !== 403 || r.said.length) fail(conv, `status ${r.status}, ${r.said.length} messages`);
          if (await userOf(CHAT(28))) fail(conv, "an account from a forged update");
        });
      });

      // ------------------------------------------------------------------------------------------ the bar, read back
      await t.step("the bar: exactly once, no secrets, bubbles in limits, nothing dropped", async () => {
        for (let k = 0; k < 3; k++) await runDeliver(); // the every-minute run, until nothing is due
        const rows = await json(`select o.key, o.status, o.contact, o.provider_ids, o.error, o.user_id from public.career_outbox o where o.key like 'reply:tg:%'`);
        const byId = new Map(bot.msgs.map((m) => [`${m.chat}|${m.id}`, m]));
        const claimed = new Map<string, string>();
        let exactly = 0, dropped = 0, blockedHeld = 0;
        const blockedChats = new Set([String(CHAT(22))]);
        for (const r of rows) {
          const chat = String(r.contact ?? "").replace(/^tg:/, "");
          if (r.status === "delivered") {
            const ids: string[] = r.provider_ids ?? [];
            let good = ids.length > 0;
            for (const id of ids) {
              if (!byId.has(`${chat}|${id}`)) { good = false; fail("bar", `row ${r.key} claims message ${id} the bot never sent to ${chat}`); }
              if (claimed.has(`${chat}|${id}`)) { good = false; fail("bar", `message ${id} claimed by ${claimed.get(`${chat}|${id}`)} and ${r.key}`); }
              claimed.set(`${chat}|${id}`, r.key);
            }
            if (good) exactly++;
          } else if (blockedChats.has(chat) && /^(failed|skipped_opt_out)$/.test(r.status)) blockedHeld++;
          else { dropped++; fail("bar", `reply row ${r.key} ${r.status} ${r.error ?? ""}`); }
        }
        // Every update that is a turn has its reply row, delivered (or held for a chat that blocked Trainee).
        for (const e of log.filter((x) => x.expect === "turn")) {
          const its = rows.filter((r: any) => r.key === `reply:tg:${e.id}` || r.key.startsWith(`reply:tg:${e.id}:`));
          if (!its.length && !e.said.length) { dropped++; fail(e.conv, `update ${e.id}: no reply row and nothing said`); }
          if (e.said.includes(CHAT_DOWN_REPLY)) fail(e.conv, `update ${e.id}: "I couldn't answer that"`);
          if (e.status !== 200) fail(e.conv, `update ${e.id}: status ${e.status}`);
        }
        for (const e of log.filter((x) => x.expect === "fixed")) if (!e.said.length) { dropped++; fail(e.conv, `update ${e.id}: no fixed answer`); }
        // A message the bot sent twice in one update (the same text to the same chat) is a double send.
        let doubles = 0;
        for (const e of log) { const seen = new Set<string>(); for (const s of e.said) { if (seen.has(s) && s.length > 20) { doubles++; fail(e.conv, `update ${e.id} sent twice: ${s.slice(0, 80)}`); } seen.add(s); } }
        // Secrets: nowhere in chat, buttons, stored turns or the outbox.
        const SECRETS = [TOKEN, SECRET, DELIVER, LINK_SECRET, API_KEY, SERVICE_KEY, ...TYPED_SECRETS];
        let secrets = 0;
        for (const m of bot.msgs) { const blob = `${m.text}\n${JSON.stringify(m.buttons)}`; for (const s of SECRETS) if (blob.includes(s)) { secrets++; fail("secrets", `"${s.slice(0, 6)}…" in a message to ${m.chat}`); } }
        for (const c of bot.calls) { const blob = JSON.stringify(c.body); for (const s of SECRETS) if (blob.includes(s)) { secrets++; fail("secrets", `"${s.slice(0, 6)}…" in a ${c.method}`); } }
        const stored = await sql(`select coalesce(string_agg(content, ' '), '') from public.agent_messages`) + await sql(`select coalesce(string_agg(text, ' '), '') from public.career_outbox`);
        for (const s of SECRETS) if (stored.includes(s)) { secrets++; fail("secrets", `"${s.slice(0, 6)}…" stored`); }
        // Bubbles: the fake Bot API refuses (and records) anything Telegram would.
        for (const v of bot.violations) fail("bubbles", v);
        const longest = Math.max(0, ...bot.msgs.map((m) => m.text.length));
        // Nothing left queued or reserved for a reply.
        const stuck = await sql(`select count(*) from public.career_outbox where key like 'reply:tg:%' and (status in ('queued', 'held') or (status = 'failed' and retry_at is not null))`);
        if (stuck !== "0") fail("bar", `${stuck} reply rows left queued`);
        if (outbound.length) fail("network", outbound.join(", "));
        for (const f of checks.faults) fail("network", f);
        const turns = log.filter((x) => x.expect === "turn").length;
        console.log(`TELEGRAM_LOOP conversations=${convs.length} updates=${log.length} turns=${turns} reply_rows=${rows.length} exactly_once=${exactly}/${rows.length - blockedHeld} blocked_held=${blockedHeld} double_sends=${doubles} secrets=${secrets} bubble_violations=${bot.violations.length} longest_bubble=${longest} dropped=${dropped} messages=${bot.msgs.length} model_calls=${model.calls} failures=${failures.length}`);
      });
      if (convs.length !== 30) fail("loop", `${convs.length} conversations, want 30`);
      assertNode.deepEqual(failures, [], failures.join("\n"));
    } finally {
      globalThis.fetch = realFetch;
      h?.restore();
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      await pg.stop();
    }
  },
});
