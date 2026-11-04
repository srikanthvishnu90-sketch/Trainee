// The Telegram chat flow, round 2, on Postgres (architect, 2026-10-30; round 1: flow-scenarios-telegram.test.ts, #311): 100
// whole conversations of new people, built from the round-2 generator's words (tests/architect/scenarios/telegram-r2-generator.ts;
// 10,000 scenarios run over memory stores in scenarios-telegram-r2.test.ts), through the REAL trainee-telegram webhook composed
// exactly as its index.ts composes it (handleTelegram with the inbound store over supabase-js, the service client for files and
// buttons, agent-chat through chatThroughAgent, the head-start deliverer), into the real agent-chat handler (handler-career.ts
// handleChat, staged brain over a scripted Anthropic wire) and trainee-deliver's real handler for the every-minute run, on a real
// Postgres 16 with every migration (tests/flow/pg.ts) behind the PostgREST double. Telegram is a fake Bot API
// (scenarios/telegram-bot-api.ts) that also serves getFile and the files (real PDF bytes, read by the product's reader). Every
// other host is refused and recorded (asserted empty).
// Each person: /start (an allow-listed chat, or sign-up closed and Telegram's own "Share my phone number" with an allow-listed
// number), their resume as a PDF file, their yes, then a mix of what people send: typos, emoji-only replies, voice notes,
// stickers, GIFs, an edited message, a reply to one of Trainee's messages, a job post forwarded from a channel (with its
// "Apply here" link), a flyer with its caption, a pasted link, a cover letter or a photo sent as a file, a message of over
// 4,000 characters, Spanish / Hindi / Arabic, a research question, an outreach request, a search, a job card (Details, Save,
// Apply, Confirm), STOP, START, the next day's alert, "delete my account". After every update the database and the Bot API are
// read back:
//   - an update the product answers ran exactly one turn (agent_messages) and got at least one message, never "I couldn't
//     answer that"; one it leaves alone ran nothing and sent nothing; an update sent again added nothing
//   - a forwarded post reached the brain as someone else's words, and no fact of the sender's ("I'm based in New York")
//     became the person's; a forwarded "STOP" stopped nothing; a caption was read; a long message was cut at 4,000 and said so
//   - Confirm queued exactly the payload shown, once; nothing else queued anything
//   - after STOP the next day's alert is held; after START it goes
//   - the budget: with the day's budget used up no request reaches the model
//   - every message to a private chat, within Telegram's limits, valid; no token or secret in a response; nothing left the machine
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/flow-scenarios-telegram-r2.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { psqlSession } from "../flow/psql-session.ts";
import { careerHandler, SERVICE_KEY, SUPABASE_URL, supabaseParity } from "../flow/handler.ts";
import { APPLY_LINKS, EMOJI_ONLY, FORWARDED_POSTS, LANG_TEXTS, ORIGINS, rng, TYPO_TEXTS } from "./scenarios/telegram-r2-generator.ts";
import { resumeFile } from "./scenarios/onboarding-r2-generator.ts";
import { fakeBot, plainOf } from "./scenarios/telegram-bot-api.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { chatThroughAgent, deliverer } from "../../supabase/functions/_shared/channel_runtime.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { CHAT_DOWN_REPLY, MEDIA_CAPTION_NOTE, PHOTO_NOT_READ_REPLY, SHARE_PHONE_ASK, VOICE_NOT_READ_REPLY } from "../../supabase/functions/_shared/channel_inbound.ts";
import { CHANNEL_REPLIES } from "../../supabase/functions/_shared/channel.ts";
import { FILE_KIND_REPLY } from "../../supabase/functions/_shared/channel_resume_upload.ts";
import { hashTag, refOf } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { anthropicWire } from "./helpers/anthropic_wire.ts";

const CI = Deno.env.get("CI") === "true";
const TOKEN = ["223344", "TEST-flow-tg2-token-not-real"].join(":"), SECRET = ["TEST", "flow", "tg2", "webhook", "secret", "0123456789abcdefgh"].join("_");
const CHAT = (n: number) => 7750000 + n;
const PHONE = (n: number) => `+1555027${String(n).padStart(4, "0")}`;
const N = Number(Deno.env.get("TG2_FLOW_N") || 100); // TG2_FLOW_N=12: a quick run while debugging
const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const LONG_MSG = (k: number) => { let s = "here is everything about my search so far: "; while (s.length < 4050 + k) s += `I applied to ${k} roles in Austin and heard back from two 😀 `; return s.slice(0, 4050 + k).replace(/[\uD800-\uDBFF]$/, "x"); };

Deno.test({
  name: "Telegram round 2 on Postgres: 100 whole conversations through the real webhook, agent-chat and delivery; the database read back",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 binaries in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
    if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (initdb)"); return; }
    const pg: Pg = await startPg();
    const keys = ["CAREER_BRAIN", "CAREER_KNOWLEDGE", "CAREER_BRAIN_ROUTER_INTENTS", "CAREER_PREPARE_AHEAD_URL", "CAREER_PREPARE_AHEAD_TOKEN", "CAREER_EMAIL_SEND", "CAREER_MAIL_TRACKING",
      "CAREER_ACCOUNT_MEMORY", "ANTHROPIC_API_KEY", "MODEL_PROVIDER", "CAREER_MODEL", "CAREER_MODEL_DAILY_USD", "CAREER_MODEL_DAILY_CALLS", "MODEL_BUDGET_PAUSED", "TRAINEE_FILE_BASE_URL",
      "TRAINEE_FILE_LINK_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_USERNAME", "TELEGRAM_LOGIN_URL", "TRAINEE_SIGNUP", "TRAINEE_ALLOWED_CONTACTS", "CAREER_REPLY_WRITER",
      "CAREER_TEXTING_NATIVE", "TRAINEE_DELIVER_SECRET", "LOOPMESSAGE_API_KEY", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "TRAINEE_LOGO_URL", "TRAINEE_LOGO_GUESS", "HUNTER_API_KEY"];
    const saved = Object.fromEntries(keys.map((k) => [k, Deno.env.get(k)]));
    for (const k of keys) Deno.env.delete(k);
    let h: Awaited<ReturnType<typeof careerHandler>> | null = null;
    let closeSession: (() => Promise<void>) | null = null;
    const realFetch = globalThis.fetch;
    const realLog = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    const failures: string[] = [];
    const fail = (who: string, why: string) => failures.push(`${who}: ${why}`);
    try {
      await supabaseParity(pg);
      const session = psqlSession({ host: pg.host, port: pg.port, bin: pgBinDir()! });
      closeSession = session.close;
      const fast: Pg = { ...pg, sql: async (text: string) => (await session.q(text)).join("\n").trim() };
      h = await careerHandler(fast, {});
      const { handleChat } = await import("../../supabase/functions/agent-chat/handler-career.ts");
      const bot = fakeBot({ token: TOKEN, now: Date.now });
      const files = new Map<string, { bytes: Uint8Array; size: number }>();
      const openai = { chat: 0, responses: 0 };
      const viaDouble = globalThis.fetch, outbound: string[] = [];
      // ---------------------------------------------------------------------------------------- the scripted Anthropic wire
      const completion = (body: any, message: any) => Response.json({ id: "chatcmpl-test", model: body.model, choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 300, completion_tokens: 60 } });
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
        if (!msgs.some((m) => m.role === "tool") && tools.includes("research_career_question") && /nurse|become/i.test(String(msgs.filter((m) => m.role === "user").pop()?.content ?? ""))) {
          const user = String(msgs.filter((m) => m.role === "user").pop()?.content ?? "");
          return completion(body, { role: "assistant", content: null, tool_calls: [{ id: `call-${openai.chat}`, type: "function", function: { name: "research_career_question", arguments: JSON.stringify({ question: user.slice(0, 200) }) } }] });
        }
        return completion(body, { role: "assistant", content: `Here is what I can tell you (TEST answer ${openai.chat}).` });
      };
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
        if (u.host === "api.telegram.org") return await bot.fetch(req);
        if (u.host === "api.anthropic.com") return anthropicWire(req, (chat) => fakeModel(new Request("https://fake.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify(chat) })));
        // A pasted posting link is looked up on its board's public API (apply here): the fake board has no such posting.
        if (/^(api\.lever\.co|boards-api\.greenhouse\.io|api\.ashbyhq\.com|jobs\.ashbyhq\.com)$/.test(u.host)) { bump("board_lookups"); return Response.json({ ok: false, error: "Document not found" }, { status: 404 }); }
        outbound.push(`${req.method} ${u.host}`);
        throw new TypeError(`network refused: ${u.host}`);
      }) as typeof fetch;
      const logged: string[] = [];
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = (...a: unknown[]) => { logged.push(a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ")); };
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.117.1");
      const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
      const sql = async (s: string) => (await fast.sql(s)).trim();
      const json = async (s: string) => JSON.parse((await sql(`select coalesce(json_agg(x), '[]') from (${s}) x`)) || "[]");

      // ------------------------------------------------------------------------------------------ the deployment's secrets
      // Even people sign up by an allow-listed chat; odd people by Telegram's own phone share (sign-up closed, the login page set).
      const allowed = [...Array.from({ length: N }, (_, n) => (n % 2 ? PHONE(n) : `telegram:${CHAT(n)}`))];
      for (const [k, v] of Object.entries({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeFlowR2Bot", TRAINEE_SIGNUP: "closed",
        TELEGRAM_LOGIN_URL: "https://trainee.test/telegram-link.html", TRAINEE_ALLOWED_CONTACTS: allowed.join(","), TRAINEE_DELIVER_SECRET: ["TEST", "deliver", "secret", "0123456789", "abcdefghij"].join("-"),
        CAREER_BRAIN: "staged", CAREER_KNOWLEDGE: "on", ANTHROPIC_API_KEY: ["sk", "test", "not", "real"].join("-"), CAREER_MODEL: "claude-haiku-5-5" })) Deno.env.set(k, v);
      // The day's model budget, opened (as the owner's statement would) for the conversations; used up for the last ten people.
      await sql(`update public.model_budget_settings set value = to_char((now() - interval '1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') where key = 'window_start';
        update public.model_budget_settings set value = to_char((now() + interval '1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') where key = 'window_end';
        insert into public.model_budget_days (day, limit_micros) values (public.model_budget_day(now()), 50000000), (public.model_budget_day(now() + interval '1 day'), 50000000) on conflict (day) do update set limit_micros = excluded.limit_micros;`);
      // A few postings in the knowledge base the search reads, and on file.
      await sql(`insert into public.career_kb_postings (posting_key, source, board, company, title, location, url, posted_at, text_excerpt, content_hash) values
        ${["acme", "globex", "initech"].map((b, i) => `('lever:${b}:9${i}', 'lever', '${b}', '${b[0].toUpperCase()}${b.slice(1)} (TEST)', 'Data Analyst', 'Austin, TX', 'https://jobs.lever.co/${b}/9${i}', now() - interval '${i + 1} hours', 'Requirements: SQL and Excel.', 'tg2-${i}')`).join(",")};`);

      // ------------------------------------------------------------------------------------------ the webhook, as index.ts composes it
      let upd = 70000, mid = 500;
      const raws = new Map<number, string>();
      const post = async (body: Record<string, unknown> | null, again?: number) => {
        await sql("delete from public.agent_rate_limits");
        const id = again ?? ++upd;
        const raw = again ? raws.get(again)! : JSON.stringify({ update_id: id, ...body });
        raws.set(id, raw);
        const deliverNow = deliverer(admin, Deno.env);
        const res = await handleTelegram(new Request(`${SUPABASE_URL}/functions/v1/trainee-telegram`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: raw }),
          { env: Deno.env, now: Date.now, store: () => supabaseInboundStore(admin), chat: chatThroughAgent(SUPABASE_URL, SERVICE_KEY, { channel: "telegram" }), admin,
            deliver: (a) => deliverNow({ userId: a.userId, key: a.key, now: a.now }) });
        return { id, status: res.status, body: await res.text() };
      };
      const runDeliver = async () => {
        const res = await handleDeliver(new Request("http://x/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": Deno.env.get("TRAINEE_DELIVER_SECRET")! } }), {
          env: Deno.env, now: Date.now, store: () => supabaseChannelStore(admin), send: () => async () => ({ ok: false, error: "no iMessage here", retryable: false }), adapters: (env) => adaptersFromEnv(env),
          recordRun: async () => {},
        });
        return await res.json();
      };
      const from = (chat: number) => ({ chat: { id: chat, type: "private" }, from: { id: chat, is_bot: false, first_name: "TEST" }, date: 1 });
      const userOfChat = async (chat: number) => await sql(`select coalesce((select user_id::text from public.channel_contacts where contact = 'tg:${chat}'), '')`);
      const turnsOf = async (user: string) => user ? Number(await sql(`select count(*) from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${user}' and m.role = 'user'`)) : 0;
      const lastUserMessage = async (user: string) => await sql(`select coalesce((select m.content from public.agent_messages m join public.agent_threads th on th.id = m.thread_id where th.user_id = '${user}' and m.role = 'user' order by m.created_at desc, m.id desc limit 1), '')`);
      const counts: Record<string, number> = {};
      const bump = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };

      type Kind = "turn" | "fixed" | "nothing" | "any";
      // One update and its reading: what kind of outcome it must have (a turn, a fixed answer, nothing).
      const step = async (who: string, chat: number, label: string, body: Record<string, unknown> | null, want: Kind, o: { again?: number; fixed?: string; saw?: (said: string[], user: string) => Promise<void> | void } = {}) => {
        const u0 = await userOfChat(chat), before = { turns: await turnsOf(u0), said: bot.to(chat).length };
        const r = await post(body, o.again);
        bump("updates");
        const user = await userOfChat(chat), said = bot.to(chat).slice(before.said).map(plainOf);
        const turns = (await turnsOf(user)) - (u0 === user ? before.turns : 0);
        const tag = `${who} ${label}`;
        if (r.status !== 200) fail(tag, `HTTP ${r.status} ${r.body.slice(0, 120)}`);
        if (r.body.includes(TOKEN) || r.body.includes(SECRET)) fail(tag, "the response carries a secret");
        if (said.some((x) => x === CHAT_DOWN_REPLY)) fail(tag, `"I couldn't answer that" (${r.body.slice(0, 160)})`);
        if (want === "turn") { if (turns !== 1) fail(tag, `${turns} turns, want 1: said ${JSON.stringify(said).slice(0, 200)}`); if (!said.length) fail(tag, "silence"); }
        if (want === "fixed") { if (turns) fail(tag, `${turns} turns for a fixed answer`); if (o.fixed && !said.includes(o.fixed)) fail(tag, `said ${JSON.stringify(said).slice(0, 220)}, want ${JSON.stringify(o.fixed.slice(0, 60))}`); if (!said.length) fail(tag, "silence"); }
        if (want === "nothing") { if (turns) fail(tag, `${turns} turns for an update left alone`); if (said.length) fail(tag, `said ${JSON.stringify(said).slice(0, 160)} for an update left alone`); }
        if (o.saw) await o.saw(said, user);
        return { id: r.id, said, user };
      };
      const msg = (chat: number, x: Record<string, unknown>) => ({ message: { message_id: ++mid, ...from(chat), ...x } });

      await t.step(`${N} people: /start, the phone share, a resume file, the yes, then what people send; every update answered once or left alone`, async () => {
        for (let n = 0; n < N; n++) {
          const r = rng(20261031 + n * 7);
          const chat = CHAT(n), who = `person ${n}`;
          // ---- sign-up
          if (n % 2 === 0) await step(who, chat, "/start", msg(chat, { text: "/start" }), "turn");
          else {
            await step(who, chat, "/start (sign-up closed)", msg(chat, { text: "/start" }), "fixed", { fixed: SHARE_PHONE_ASK });
            await step(who, chat, "share phone", msg(chat, { contact: { phone_number: PHONE(n), first_name: "TEST", user_id: chat } }), "turn");
          }
          const user = await userOfChat(chat);
          if (!user) { fail(who, "no account after sign-up"); continue; }
          // ---- the resume as a PDF, then the yes
          const rf = resumeFile(r as any, "pdf-lines");
          const fid = `R${n}`;
          files.set(fid, { bytes: rf.bytes, size: rf.bytes.length });
          await step(who, chat, "resume file", msg(chat, { document: { file_id: fid, file_unique_id: `u${fid}`, file_name: "resume.pdf", mime_type: "application/pdf", file_size: rf.bytes.length } }), "turn",
            { saw: async (_s, u) => { if (!/^here is my resume:/.test(await lastUserMessage(u))) fail(who, "the resume file was not read as the person's resume"); } });
          await step(who, chat, "yes", msg(chat, { text: "yes" }), "turn");
          if (await sql(`select public.career_resume_on_file('${user}')::text`) === "true") bump("resume_confirmed");
          // ---- the middle of the conversation: 6 to 9 of what people send, drawn for this person
          const kinds = ["typo", "emoji", "voice", "sticker", "gif", "edit", "reply", "forward", "forward-recruiter", "forward-stop", "caption", "link", "applyhere", "cover", "photo-file",
            "long", "lang", "research", "outreach", "search", "again"];
          const mids: number[] = [], ids: number[] = [];
          const count = 6 + (n % 4);
          for (let k = 0; k < count; k++) {
            const kind = kinds[(n * 5 + k * 7 + r.int(0, 3)) % kinds.length];
            bump(`kind_${kind}`);
            const m = (x: Record<string, unknown>) => { const b = msg(chat, x); mids.push(b.message.message_id as number); return b; };
            let res: { id: number } | null = null;
            switch (kind) {
              case "typo": res = await step(who, chat, kind, m({ text: r.pick(TYPO_TEXTS) }), "turn"); break;
              case "emoji": res = await step(who, chat, kind, m({ text: r.pick(EMOJI_ONLY) }), "turn"); break;
              case "voice": res = await step(who, chat, kind, m({ voice: { file_id: "v", file_unique_id: `uv${n}${k}`, duration: 3 } }), "fixed", { fixed: VOICE_NOT_READ_REPLY }); break;
              case "sticker": res = await step(who, chat, kind, m({ sticker: { file_id: "s", file_unique_id: `us${n}${k}`, type: "regular", width: 1, height: 1, is_animated: false, is_video: false } }), "nothing"); break;
              case "gif": res = await step(who, chat, kind, m({ animation: { file_id: "g", file_unique_id: `ug${n}${k}`, width: 1, height: 1, duration: 1 }, document: { file_id: "g", file_unique_id: `ug${n}${k}`, file_name: "giphy.mp4", mime_type: "video/mp4" } }), "nothing"); break;
              case "edit": res = await step(who, chat, kind, { edited_message: { message_id: mids.at(-1) ?? 1, ...from(chat), text: "edited", edit_date: 2 } }, "nothing"); break;
              case "again": res = ids.length ? await step(who, chat, kind, null, "nothing", { again: ids.at(-1) }) : null; break;
              case "reply": {
                const to = bot.to(chat).at(-1)?.id ?? 1;
                res = await step(who, chat, kind, m({ text: r.pick(["tell me more about this", "what does this mean?", "👍", "ok do that"]), reply_to_message: { message_id: to, ...from(chat), text: "earlier" } }), "turn");
                break;
              }
              case "forward": case "forward-recruiter": case "forward-stop": {
                const text = kind === "forward" ? FORWARDED_POSTS[0] : kind === "forward-recruiter" ? FORWARDED_POSTS[2] : FORWARDED_POSTS[5];
                const at = text.indexOf("Apply here");
                const ents = at >= 0 ? [{ type: "text_link", offset: at, length: 10, url: APPLY_LINKS[0] }] : undefined;
                res = await step(who, chat, kind, m({ text, ...(ents ? { entities: ents } : {}), forward_origin: kind === "forward-recruiter" ? ORIGINS[2] : ORIGINS[0], forward_date: 1 }), "turn", {
                  saw: async (_s, u) => {
                    const read = await lastUserMessage(u);
                    if (!/^Forwarded from /.test(read)) fail(who, `a forwarded post reached the brain as the person's own words: ${JSON.stringify(read.slice(0, 80))}`);
                    if (ents && !read.includes(APPLY_LINKS[0])) fail(who, "the forwarded post's Apply here link was lost");
                    if (kind === "forward-stop" && await sql(`select opted_out::text from public.channel_contacts where contact = 'tg:${chat}'`) === "true") fail(who, "a forwarded STOP stopped the person");
                    if (kind === "forward-recruiter") {
                      const facts = await sql(`select count(*) from public.career_watch_kv where user_id = '${u}' and value::text ilike '%new york%'`);
                      const flow = await sql(`select count(*) from public.agent_flow_state where user_id = '${u}' and state::text ilike '%"geography"%' and state::text ilike '%new york%'`);
                      if (facts !== "0" || flow !== "0") fail(who, "the recruiter's \"I'm based in New York\" was recorded as the person's own fact");
                    }
                  },
                });
                break;
              }
              case "caption": res = await step(who, chat, kind, m({ photo: [{ file_id: "p", file_unique_id: `up${n}${k}`, width: 1, height: 1 }], caption: FORWARDED_POSTS[r.int(0, 1)] }), "turn", {
                saw: async (said, u) => { if (!said[0]?.startsWith(MEDIA_CAPTION_NOTE)) fail(who, `a flyer's caption: the answer does not say the picture was not seen: ${JSON.stringify(said[0]?.slice(0, 80))}`); if (!/hiring|HIRING/.test(await lastUserMessage(u))) fail(who, "the caption was not read"); } });
                break;
              case "link": res = await step(who, chat, kind, m({ text: `can you apply to this? ${APPLY_LINKS[r.int(0, 2)]}` }), "turn"); break;
              case "applyhere": res = await step(who, chat, kind, m({ text: "Data Analyst at Acme. Apply here", entities: [{ type: "text_link", offset: 22, length: 10, url: APPLY_LINKS[1] }] }), "turn", {
                saw: async (_s, u) => { if (!(await lastUserMessage(u)).includes(APPLY_LINKS[1])) fail(who, "an \"Apply here\" link reached the brain without its URL"); } });
                break;
              case "cover": {
                const cf = resumeFile(r as any, "not-cover-letter"), id = `C${n}${k}`;
                files.set(id, { bytes: cf.bytes, size: cf.bytes.length });
                res = await step(who, chat, kind, m({ document: { file_id: id, file_unique_id: `u${id}`, file_name: cf.name, mime_type: cf.mime, file_size: cf.bytes.length } }), "fixed", {
                  saw: (said) => { if (!said.some((x) => /couldn't read that file as a resume/.test(x))) fail(who, `a cover letter got ${JSON.stringify(said).slice(0, 160)}`); } });
                break;
              }
              case "photo-file": res = await step(who, chat, kind, m({ document: { file_id: `P${n}${k}`, file_unique_id: `uP${n}${k}`, file_name: "IMG_2041.png", mime_type: "image/png", file_size: 4000 } }), "fixed", { fixed: FILE_KIND_REPLY }); break;
              case "long": res = await step(who, chat, kind, m({ text: LONG_MSG(k) }), "turn", {
                saw: async (said, u) => { const read = await lastUserMessage(u); if (read.length > 4000) fail(who, `${read.length} characters stored`); if (!said.some((x) => /longer than the 4,000 characters/.test(x))) fail(who, "a cut message was not said to be cut"); } });
                break;
              case "lang": { const l = r.pick(["es", "hi", "ar"] as const); const text = r.pick(LANG_TEXTS[l]); res = await step(who, chat, `${kind}:${l}`, m({ text }), "turn", { saw: async (_s, u) => { if (await lastUserMessage(u) !== text) fail(who, `their ${l} words were changed: ${JSON.stringify((await lastUserMessage(u)).slice(0, 60))}`); } }); break; }
              case "research": res = await step(who, chat, kind, m({ text: "how do I become a registered nurse?" }), "turn"); break;
              case "outreach": res = await step(who, chat, kind, m({ text: "draft a short message to a recruiter at Acme about the data analyst role" }), "turn"); break;
              case "search": res = await step(who, chat, kind, m({ text: "find data analyst jobs in Austin" }), "turn"); break;
            }
            if (res && kind !== "again") ids.push(res.id);
          }
          // ---- a job card, its buttons on an old message after the application changed, Confirm once (every 4th person)
          if (n % 4 === 1) {
            const jobId = `lever:acme:77${n}`, url = `https://jobs.lever.co/acme/77${n}`;
            await sql(`${(await import("../flow/resume-seed.ts")).confirmedResumeSql(user)} insert into storage.objects (bucket_id, name) values ('career-resumes', '${user}/' || repeat('a', 64) || '.pdf') on conflict do nothing;
              insert into public.career_postings (job_id, provider, board, company, title, location, url, description, posted_at, first_seen_at, last_seen_at) values (${q(jobId)}, 'lever', 'acme', 'Acme', 'Data Analyst (TEST)', 'Austin, TX', ${q(url)}, 'Requirements\nSQL.', now() - interval '2 hours', now() - interval '2 hours', now());`);
            const prep = async (v: number) => JSON.parse(await sql(`with p as (select jsonb_build_object('version',1,'user_id','${user}','job_id',${q(jobId)},'company','Acme','url',${q(url)},'fields',jsonb_build_array(jsonb_build_object('name','first_name','label','First name','value','Alex ${v}')),'privacy_epoch',coalesce((select (value->>'epoch')::int from public.career_watch_kv where user_id = '${user}' and key = 'career:account'),0),'account_version',coalesce((select (value->>'version')::int from public.career_watch_kv where user_id = '${user}' and key = 'career:account'),0),'expires_at',now()+interval '1 day','resume_sha256',repeat('a',64)) as pl)
              insert into public.career_apply_prepared (user_id, job_id, company, url, payload, payload_hash, card_lines) select '${user}', ${q(jobId)}, 'Acme', ${q(url)}, pl, public.career_apply_payload_hash(pl), array['Acme'] from p returning json_build_object('id', id, 'hash', payload_hash)`));
            const p1 = await prep(1), ref = await refOf(user, jobId);
            const job = { job_id: jobId, company: "Acme", title: "Data Analyst (TEST)", location: "Austin, TX", url, pay: null, level: null, remote: null, posted_at: null, first_seen_at: null, deadline: null, source: "Lever", reasons: [], gaps: [], company_domain: null };
            await sql(`insert into public.career_watch_kv (user_id, key, value) values ('${user}', 'tg:job:${ref}', ${q(JSON.stringify({ job, shownAs: "text" }))}::jsonb) on conflict (user_id, key) do update set value = excluded.value`);
            const tap = (data: string, messageId = 1) => step(who, chat, `tap ${data.slice(0, 3)}`, { callback_query: { id: `cb-${++mid}`, from: { id: chat, is_bot: false }, message: { message_id: messageId, chat: { id: chat, type: "private" }, date: 1 }, data } }, "any");
            const answers0 = bot.answers.length;
            await tap(`jcd:${ref}`); await tap(`jcs:${ref}`); await tap(`jca:${ref}`);
            // the application changes after it was shown: the old Confirm approves nothing; the new one once
            await sql(`update public.career_apply_prepared set state = 'expired' where id = '${p1.id}'`);
            const p2 = await prep(2);
            await tap(`jcy:${ref}:${hashTag(p1.hash)}`, 2);
            await tap(`jca:${ref}`);
            await tap(`jcy:${ref}:${hashTag(p2.hash)}`, 3); await tap(`jcy:${ref}:${hashTag(p2.hash)}`, 3);
            if (bot.answers.length - answers0 !== 7) fail(who, `${bot.answers.length - answers0} of 7 taps answered`);
            const jobs = await json(`select payload_hash, approval_hash from public.career_apply_jobs where user_id = '${user}' and job_id = ${q(jobId)}`);
            if (jobs.length !== 1 || jobs[0].payload_hash !== p2.hash || jobs[0].approval_hash !== p2.hash) fail(who, `Confirm queued ${JSON.stringify(jobs)}, want exactly the second payload once; said ${JSON.stringify(bot.to(chat).slice(-5).map((m) => plainOf(m).slice(-160)))}`);
            else bump("confirmed_once");
          }
          // ---- STOP, the next day's alert held; START, the next one goes
          if (n % 3 === 0) {
            await step(who, chat, "STOP", msg(chat, { text: n % 2 ? "STOP" : "/stop" }), "fixed", { fixed: CHANNEL_REPLIES.stop });
            await sql(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values ('${user}', 'brief:tg2-${n}-a', 'brief', 'TEST brief for ${n}', now() - interval '1 minute')`);
            const run1 = await runDeliver();
            const a = await sql(`select status from public.career_outbox where key = 'brief:tg2-${n}-a'`);
            if (a !== "skipped_opt_out") fail(who, `after STOP the alert was ${a} (run ${JSON.stringify(run1).slice(0, 300)})`);
            await step(who, chat, "START", msg(chat, { text: "START" }), "fixed", { fixed: CHANNEL_REPLIES.start });
            await sql(`insert into public.career_outbox (user_id, key, kind, text, deliver_at) values ('${user}', 'brief:tg2-${n}-b', 'brief', 'TEST brief after START for ${n}', now() - interval '1 minute')`);
            const run2 = await runDeliver();
            const b = await sql(`select status || ' ' || coalesce(error, '') from public.career_outbox where key = 'brief:tg2-${n}-b'`);
            if (!b.startsWith("delivered")) fail(who, `after START the alert was ${b} (run ${JSON.stringify(run2).slice(0, 300)})`);
            else bump("alerts_after_start");
          }
          if (n % 10 === 7) await step(who, chat, "delete my account", msg(chat, { text: "delete my account" }), "turn");
          // the budget used up for the last ten people: one more question, and no request reaches the model
          if (n === Math.max(0, N - 10)) await sql(`update public.model_budget_days set limit_micros = spent_micros + reserved_micros`);
          if (n >= Math.max(0, N - 10)) {
            const before = openai.chat + openai.responses;
            await step(who, chat, "budget", msg(chat, { text: "how do I become a registered nurse?" }), "turn");
            if (openai.chat + openai.responses !== before) fail(who, `${openai.chat + openai.responses - before} the model requests over the day's budget`);
          }
        }
      });

      await t.step("every message: to a private chat, within Telegram's limits, valid; nothing left the machine; nothing left reserved", async () => {
        for (const v of bot.violations) fail("Bot API", v);
        if (bot.msgs.some((x) => Number(x.chat) < 0)) fail("Bot API", "a message to a group");
        if (outbound.length) fail("network", [...new Set(outbound)].join(", "));
        const open = await sql(`select coalesce(sum(reserved_micros), 0) from public.model_budget_days`);
        if (open !== "0") fail("budget", `${open} micro-USD left reserved`);
        const secrets = logged.filter((l) => l.includes(TOKEN) || l.includes(SECRET));
        if (secrets.length) fail("logs", `${secrets.length} log lines carry a secret`);
      });
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = realLog[k];
      console.log(`[flow-telegram-r2] ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}; ${bot.msgs.length} messages, ${bot.answers.length} taps answered; the model chat ${openai.chat}, searches ${openai.responses}; ${failures.length} failures`);
      if (failures.length) {
        // by what broke, and how many people it happened to
        const tally = new Map<string, Set<string>>();
        for (const f of failures) {
          const who = /^person \d+/.exec(f)?.[0] ?? f.split(":")[0];
          const what = f.replace(/^person \d+ ?/, "").replace(/^[^:]*: /, (x) => x.replace(/\d+/g, "#")).replace(/:? ?(said|\(run|want|for ).*$/, "").replace(/\d{2,}/g, "#").slice(0, 110);
          if (!tally.has(what)) tally.set(what, new Set());
          tally.get(what)!.add(who);
        }
        console.log([...tally.entries()].sort((a, b) => b[1].size - a[1].size).map(([k, v]) => `  ${v.size} people: ${k}`).join("\n"));
        console.log(failures.slice(0, 60).join("\n"));
      }
      assertNode.deepEqual(failures, [], failures.slice(0, 40).join("\n"));
    } finally {
      for (const k of Object.keys(realLog) as (keyof typeof realLog)[]) console[k] = realLog[k];
      globalThis.fetch = realFetch;
      h?.restore();
      await closeSession?.();
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
      await pg.stop();
    }
  },
});
