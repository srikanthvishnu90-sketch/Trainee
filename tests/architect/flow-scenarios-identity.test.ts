// Multi-channel identity and account linking end to end on Postgres (2026-10-30): 80 journeys through the real inbound
// webhooks (trainee-inbound's handleInbound for LoopMessage, trainee-whatsapp's handleWhatsApp, signed; trainee-telegram's
// handleTelegram) over the real inbound store (trainee-inbound/store.ts, supabase-js) and the real delivery run
// (trainee-deliver's handleDeliver over supabaseChannelStore), on Postgres 16 with every migration (tests/flow/pg.ts) behind
// the PostgREST double, with Auth's one-account-per-phone rule (GoTrue answers phone_exists for a number already an
// account's) and fake providers at the HTTP boundary (api.telegram.org, graph.facebook.com, a.loopmessage.com) on a fixed
// clock. Nothing leaves the machine; no model runs (the chat is a stub that answers as the account it was given, in that
// account's own thread, and remembers per account what it is told). The battery over memory stores is
// scenarios-identity.test.ts; these are the same rules on the real tables and functions, read back from the database:
//   chain     the same number on iMessage, WhatsApp and Telegram's own-number share, in every order: one account, only
//             after a yes from the channel already linked (Telegram's share asked: the link question's check refused a
//             Telegram chat; a Telegram sign-up by share kept no number, so the same number signed up a second time);
//   never     a late yes, another person's yes, a forwarded yes, the new chat's own yes, "yeah": nothing linked;
//   cards     a forwarded contact card, WhatsApp's contacts message, a typed number: nothing asked, made or linked;
//   stopped   the number's account said STOP: no second account, no question held unseen, said plainly; START, then a yes;
//   taken     the number is already an account's sign-in phone with no channel: no second account, said once;
//   two       one number on two accounts: the third channel joins only the one that said yes; the two never merge;
//   again     a second Telegram chat (or WhatsApp number) for an account that has one: the yes moves it (it raised a unique
//             violation, and every yes read "I couldn't answer that");
//   tokens    "connect telegram": single use, ten minutes, the issuing account's, a fourth burns the first; a chat is linked only
//             on the YES of the account's own channel (TELEGRAM LINK OWNERSHIP, 2026-10-31);
//   recycled  a WhatsApp number given to someone else: a fresh account for the new owner; a moved number keeps its person;
//   deleted   an account deleted and the person back: fresh; a number that waited for a yes, and a Telegram chat unlinked
//             from the web, are told about sign-up, never left in silence;
//   stop      STOP is the person's; the home channel; a link never moves it;
//   races     two asks at once, a link during a running turn, Telegram unlinked while an answer in parts goes out, two chats
//             redeeming one link;
//   memory    after a link every channel runs as one account in one thread; another account knows nothing of it.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/flow-scenarios-identity.test.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.1";
import assertNode from "node:assert/strict";
import { CI, haveDb, railDb, rows } from "../flow/send-rail-fixture.ts";
import { postgrestDouble } from "../flow/postgrest.ts";
import { supabaseParity } from "../flow/handler.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";
import { handleInbound } from "../../supabase/functions/trainee-inbound/handler.ts";
import { handleWhatsApp } from "../../supabase/functions/trainee-whatsapp/handler.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { CHANNEL_REPLIES, deliverDue } from "../../supabase/functions/_shared/channel.ts";
import { loopSend } from "../../supabase/functions/_shared/loopmessage.ts";
import { whatsappAdapter, whatsappSignature } from "../../supabase/functions/_shared/whatsapp.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import * as IN from "../../supabase/functions/_shared/channel_inbound.ts";
import { supabaseInboundStore } from "../../supabase/functions/trainee-inbound/store.ts";

const T0 = Date.parse("2026-10-30T15:00:00Z"), MIN = 60000, HOUR = 3600000;
const mk = (p: string, n: number) => `${p}${"z".repeat(n)}`;
const DELIVER = mk("deliver", 33), IN_SECRET = mk("inbound", 33), WA_APP = mk("app", 33), TG_SECRET = mk("tgsecret_", 32), TG_TOKEN = `${7000 + 3}:${mk("TeSt", 31)}`;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const iso = (t: number) => new Date(t).toISOString();
const uid = (n: number) => `00000000-0000-4000-8000-0000000d${String(n).padStart(4, "0")}`;
const P = (n: number) => `+1555${String(3100000 + n)}`; // one number per journey
const Q = (n: number) => `+1555${String(3200000 + n)}`; // a second number in a journey
const say = { stopped: (c: string) => (IN as any).linkStoppedReply?.(c) ?? `<linkStoppedReply ${c}>`, taken: (IN as any).PHONE_TAKEN_REPLY ?? "<PHONE_TAKEN_REPLY>" };
const ASK = /^Someone texted Trainee on (iMessage|WhatsApp|Telegram) from your number\. Reply yes to link it\.$/;

Deno.test({ name: "identity on Postgres: 80 multi-channel journeys through the real webhooks, linking functions and delivery; the database read back", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const started = Date.now();
  const db = await railDb();
  const fails: string[] = [];
  const check = (journey: string, cond: unknown, why: string) => { if (!cond) fails.push(`${journey}: ${why}`); };
  let journeys = 0;
  try {
    await supabaseParity(db.pg as any);
    const double = postgrestDouble(db.pg as any, { url: "http://supabase.test", serviceKey: "service-test-key", users: {} });
    // GoTrue: one account per phone (phone_exists, 422), as Supabase Auth refuses a second.
    const authPhones = new Map<string, string>();
    const gotrue = (async (input: Request | URL | string, init?: RequestInit) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      const u = new URL(req.url);
      if (u.pathname === "/auth/v1/admin/users" && req.method === "POST") {
        const body = await req.clone().json().catch(() => ({}));
        const tel = typeof body.phone === "string" && body.phone ? `+${body.phone.replace(/^\+/, "")}` : null;
        if (tel && authPhones.has(tel)) return new Response(JSON.stringify({ code: 422, error_code: "phone_exists", msg: "Phone number already registered by another user" }), { status: 422, headers: { "content-type": "application/json" } });
        const res = await double.fetch(req);
        if (tel && res.ok) authPhones.set(tel, (await res.clone().json()).id);
        return res;
      }
      return await double.fetch(req);
    }) as typeof fetch;
    const admin = createClient("http://supabase.test", "service-test-key", { global: { fetch: gotrue }, auth: { persistSession: false, autoRefreshToken: false } });
    const store = supabaseInboundStore(admin);

    // ------------------------------------------------------------------------------------------- the providers
    const clock = { t: T0 };
    type Sent = { key: string; text: string; t: number };
    const sent: Sent[] = [];
    let seq = 0, onSend: null | ((s: Sent) => Promise<void>) = null;
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const providers = (async (input: Request | URL | string, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const b = JSON.parse(String(init?.body ?? "{}"));
      let s: Sent | null = null;
      if (u.host === "api.telegram.org") {
        if (!u.pathname.endsWith("/sendMessage")) return j({ ok: true, result: true });
        s = { key: `tg:${b.chat_id}`, text: String(b.text), t: clock.t };
      } else if (u.host === "graph.facebook.com") {
        if (b.status === "read") return j({ success: true });
        if (b.type === "template") return j({ messages: [{ id: `wamid.t${++seq}` }] });
        s = { key: `wa:${b.to ?? b.recipient}`, text: String(b.text?.body ?? ""), t: clock.t };
      } else if (u.host === "a.loopmessage.com") s = { key: String(b.contact), text: String(b.text), t: clock.t };
      else throw new TypeError(`network refused: ${u.host}`);
      sent.push(s);
      if (onSend) { const h = onSend; await h(s); }
      return u.host === "api.telegram.org" ? j({ ok: true, result: { message_id: ++seq } }) : u.host === "graph.facebook.com" ? j({ messages: [{ id: `wamid.${++seq}` }] }) : j({ message_id: `lm-${++seq}`, success: true });
    }) as typeof fetch;
    const env: Record<string, string | undefined> = { TRAINEE_DELIVER_SECRET: DELIVER, TRAINEE_INBOUND_SECRET: IN_SECRET, LOOPMESSAGE_API_KEY: "loop-test", TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_WEBHOOK_SECRET: TG_SECRET,
      TELEGRAM_BOT_USERNAME: "TraineeIdentityBot", WHATSAPP_TOKEN: "wa-test", WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_APP_SECRET: WA_APP, TRAINEE_SIGNUP: "closed", TRAINEE_ALLOWED_CONTACTS: "" };
    const E = { get: (k: string) => env[k] || undefined };
    const sleep = async (ms: number) => { clock.t += ms; };
    const adapters = () => adaptersFromEnv(E, { fetch: providers, clock: () => clock.t, sleep });
    const statuses: string[] = [];
    // The brain: answers as the account it was given, in its one thread (made on the first turn), and remembers per account.
    const turns: { contact: string; userId: string; threadId: string | null; message: string }[] = [];
    const facts = new Map<string, string[]>();
    let cur = "";
    let beforeTurn: null | (() => Promise<void>) = null;
    const chat = async (a: any) => {
      turns.push({ contact: cur, userId: a.userId, threadId: a.threadId ?? null, message: a.message });
      if (beforeTurn) { const h = beforeTurn; beforeTurn = null; await h(); }
      let thread = a.threadId as string | null;
      if (!thread) thread = String((await db.sql.query(`insert into public.agent_threads(user_id, title) values (${q(a.userId)}, 'Texts') returning id`))[0][0]);
      const m = /^remember (.+)$/.exec(a.message);
      let reply: string;
      if (m) { facts.set(a.userId, [...(facts.get(a.userId) ?? []), m[1]]); reply = `[${a.userId}] noted`; }
      else if (/^what do you know/.test(a.message)) reply = `[${a.userId}] I know: ${(facts.get(a.userId) ?? []).join("; ") || "nothing"}`;
      else reply = `[${a.userId}] ${a.message} answered`;
      return { status: 200, threadId: thread, reply };
    };
    const headKey = async (a: { userId: string; key: string; now: number }) => { const s = supabaseChannelStore(admin, { only: { userId: a.userId, key: a.key } }); const r = await deliverDue({ store: s, adapters: adapters(), now: a.now, limit: 1 }); await s.release(); return r; };
    const headUser = async (a: { userId: string; now: number }) => { const s = supabaseChannelStore(admin, { user: a.userId }); const r = await deliverDue({ store: s, adapters: adapters(), now: a.now, limit: 40 }); await s.release(); return r; };
    const ever = new Map<string, Set<string>>();
    const snap = async () => { for (const r of await rows<{ contact: string; user_id: string }>(db, `select contact, user_id from public.channel_contacts where user_id is not null`)) { if (!ever.has(r.contact)) ever.set(r.contact, new Set()); ever.get(r.contact)!.add(r.user_id); } };
    const after = async (what: string, res: Response) => { const body = await res.json().catch(() => null); if (res.status !== 200) statuses.push(`${what} ${res.status} ${JSON.stringify(body)}`); await snap(); return body; };
    const deliver = async () => {
      const res = await handleDeliver(new Request("http://local/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": DELIVER } }), {
        env: E, now: () => clock.t, store: () => supabaseChannelStore(admin), send: (k) => loopSend({ apiKey: k, fetch: providers, sleep: async () => {} }),
        adapters: (e) => adaptersFromEnv(e, { fetch: providers, clock: () => clock.t, sleep }), recordRun: async () => {},
      });
      return await after("deliver", res);
    };
    let mid = 0, upd = 0;
    const lm = async (from: string, text: string) => {
      cur = from;
      return await after(`lm ${from}`, await handleInbound(new Request(`https://fn.test/trainee-inbound?secret=${IN_SECRET}`, { method: "POST", body: JSON.stringify({ alert_type: "message_inbound", message_id: `lm-in-${++mid}`, recipient: from, text }) }), {
        env: E, now: () => clock.t, store: () => store, send: (k) => loopSend({ apiKey: k, fetch: providers, sleep: async () => {} }), chat, deliverReply: (a) => headKey(a),
      }));
    };
    const wa = async (a: { from?: string | null; bsuid?: string | null; text?: string; forwarded?: boolean; type?: string; extra?: Record<string, unknown> }) => {
      cur = a.from ? `wa:${a.from}` : `wa:${a.bsuid}`;
      const type = a.type ?? "text";
      const m: Record<string, unknown> = { id: `wamid.in${++mid}`, timestamp: String(Math.floor(clock.t / 1000)), type, ...(a.from ? { from: a.from } : {}), ...(a.bsuid ? { from_user_id: a.bsuid } : {}),
        ...(type === "text" ? { text: { body: a.text ?? "hi" } } : {}), ...(a.forwarded ? { context: { forwarded: true } } : {}), ...a.extra };
      const raw = new TextEncoder().encode(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "1" },
        contacts: [{ profile: { name: "T" }, ...(a.from ? { wa_id: a.from } : {}), ...(a.bsuid ? { user_id: a.bsuid } : {}) }], messages: [m] } }] }] }));
      return await after(`wa ${cur}`, await handleWhatsApp(new Request("https://fn.test/trainee-whatsapp", { method: "POST", headers: { "x-hub-signature-256": await whatsappSignature(WA_APP, raw) }, body: raw }), {
        env: E, now: () => clock.t, store: () => store, chat, deliver: (x) => headUser(x),
        adapter: (e) => whatsappAdapter({ token: e.get("WHATSAPP_TOKEN") || "", phoneNumberId: "1", appSecret: WA_APP, fetch: providers, clock: () => clock.t, sleep }),
      }));
    };
    const tgPost = async (chatId: number, message: Record<string, unknown>) => {
      cur = `tg:${chatId}`;
      const req = new Request("https://fn.test/trainee-telegram", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TG_SECRET },
        body: JSON.stringify({ update_id: ++upd, message: { message_id: ++mid, chat: { id: chatId, type: "private" }, from: { id: chatId, is_bot: false, first_name: "T" }, date: Math.floor(clock.t / 1000), ...message } }) });
      return await after(`tg ${chatId}`, await handleTelegram(req, { env: E, now: () => clock.t, store: () => store, chat, deliver: (a) => headKey(a),
        adapter: (e) => telegramAdapter({ token: e.get("TELEGRAM_BOT_TOKEN") || "", webhookSecret: TG_SECRET, fetch: providers, clock: () => clock.t, sleep }) }));
    };
    const tg = async (chatId: number, text: string, o: { forwarded?: boolean } = {}) => await tgPost(chatId, { text, ...(o.forwarded ? { forward_origin: { type: "user", sender_user: { id: 4242, is_bot: false, first_name: "F" }, date: 1 }, forward_date: 1 } : {}) });
    const share = async (chatId: number, phone: string, cardOf = chatId) => await tgPost(chatId, { contact: { phone_number: phone.slice(1), user_id: cardOf, first_name: "T" } });
    const from = async (key: string, text: string, o: { forwarded?: boolean } = {}) => key.startsWith("tg:") ? await tg(Number(key.slice(3)), text, o)
      : key.startsWith("wa:") ? (/^wa:[0-9]+$/.test(key) ? await wa({ from: key.slice(3), text, forwarded: o.forwarded }) : await wa({ bsuid: key.slice(3), text, forwarded: o.forwarded })) : await lm(key, text);
    const owner = async (key: string) => (await rows<{ user_id: string | null }>(db, `select user_id from public.channel_contacts where contact = ${q(key)}`))[0]?.user_id ?? null;
    const accounts = async () => Number((await rows<{ n: string }>(db, `select count(*) as n from auth.users`))[0].n);
    const read = (key: string, since = 0) => sent.slice(since).filter((s) => s.key === key).map((s) => s.text);
    const asksSince = (since: number) => sent.slice(since).filter((s) => ASK.test(s.text));
    const seed = async (n: number, contacts: { c: string; phone?: string | null; alias?: string | null; at?: number; home?: boolean }[], tel?: string | null) => {
      const u = uid(n);
      await db.sql.query(`insert into auth.users(id, email) values (${q(u)}, ${q(`idj${n}@example.test`)}); insert into public.profiles(id) values (${q(u)});
        insert into public.career_watch_kv(user_id, key, value) values (${q(u)}, 'career:account', '{"epoch":0,"version":0,"paused":false}');
        ${contacts.map((x) => { const ph = x.phone !== undefined ? x.phone : /^wa:[0-9]+$/.test(x.c) ? `+${x.c.slice(3)}` : null;
          return `insert into public.channel_contacts(contact, user_id, last_inbound_at, created_at, alias, home${ph ? ", phone" : ""}) values (${q(x.c)}, ${q(u)}, ${q(iso(x.at ?? clock.t - HOUR))}, ${q(iso(clock.t - 2 * HOUR))}, ${x.alias ? q(x.alias) : "null"}, ${x.home ? "true" : "false"}${ph ? `, ${q(ph)}` : ""});`; }).join("\n")}`);
      if (tel) authPhones.set(tel, u);
      await snap();
      return u;
    };
    const journey = async (name: string, fn: (J: (cond: unknown, why: string) => void) => Promise<void>) => {
      journeys++;
      const st = statuses.length;
      try { await fn((cond, why) => check(name, cond, why)); } catch (e) { fails.push(`${name}: threw ${e instanceof Error ? e.message : String(e)}`); }
      if (statuses.length > st) fails.push(`${name}: ${statuses.slice(st).join("; ")}`);
      clock.t += 5 * MIN;
    };
    const open = (allow: string[] = []) => { env.TRAINEE_SIGNUP = "open"; env.TRAINEE_ALLOWED_CONTACTS = allow.join(","); };
    const closed = (allow: string[] = []) => { env.TRAINEE_SIGNUP = "closed"; env.TRAINEE_ALLOWED_CONTACTS = allow.join(","); };
    const keyOf = (c: string, n: number) => c === "imessage" ? P(n) : c === "whatsapp" ? `wa:${P(n).slice(1)}` : `tg:${4100000 + n}`;
    const arrive = async (c: string, n: number) => c === "imessage" ? await lm(P(n), `hi from imessage`) : c === "whatsapp" ? await wa({ from: P(n).slice(1), text: "hi from whatsapp" }) : await share(4100000 + n, P(n));

    // ===================================================================================== chain (10)
    await t.step("chain: one number on iMessage, WhatsApp and Telegram's share, in every order: one account, each after a yes", async () => {
      const orders = [["imessage", "whatsapp", "telegram"], ["imessage", "telegram", "whatsapp"], ["whatsapp", "imessage", "telegram"], ["whatsapp", "telegram", "imessage"], ["telegram", "imessage", "whatsapp"],
        ["telegram", "whatsapp", "imessage"], ["imessage", "telegram"], ["telegram", "imessage"], ["whatsapp", "telegram"], ["telegram", "whatsapp"]];
      for (let i = 0; i < orders.length; i++) {
        const n = 100 + i, order = orders[i];
        await journey(`chain ${order.join(">")}`, async (J) => {
          closed([P(n), `telegram:${4100000 + n}`]);
          await arrive(order[0], n);
          const u = await owner(keyOf(order[0], n));
          J(u, `${order[0]}: no account`);
          for (const c of order.slice(1)) {
            clock.t += MIN;
            const m = sent.length, made = await accounts();
            await arrive(c, n);
            const asks = asksSince(m);
            J(asks.length === 1, `${c}: ${asks.length} questions; the new chat read ${JSON.stringify(read(keyOf(c, n), m))}`);
            J(await accounts() === made, `${c}: a second account for the number`);
            J(!(await owner(keyOf(c, n))), `${c}: linked before the yes`);
            if (asks.length !== 1) return;
            J(await owner(asks[0].key) === u, `${c}: asked ${asks[0].key}, not the account's`);
            clock.t += MIN;
            const m2 = sent.length;
            await from(asks[0].key, "yes");
            await deliver();
            J(await owner(keyOf(c, n)) === u, `${c}: not linked after the yes`);
            J(read(keyOf(c, n), m2).includes(IN.LINKED_HERE_REPLY), `${c}: not told it is linked`);
          }
          // Every channel runs as the account, in its one thread.
          const t0 = turns.length;
          for (const c of order) { clock.t += MIN; await from(keyOf(c, n), `remember fact from ${c}`); }
          const mine = turns.slice(t0);
          J(mine.length === order.length && mine.every((x) => x.userId === u), `not every channel ran as the account: ${JSON.stringify(mine.map((x) => x.userId))}`);
          J(new Set(mine.map((x) => x.threadId)).size === 1, `more than one thread: ${JSON.stringify(mine.map((x) => x.threadId))}`);
          const r = await rows<{ n: string }>(db, `select count(*) as n from public.channel_link_requests where user_id = ${q(u!)} and answered_at is not null`);
          J(Number(r[0].n) === order.length - 1, `answered questions: ${r[0].n}`);
        });
      }
    });

    // ===================================================================================== never (8)
    await t.step("never: a late yes, someone else's yes, a forwarded yes, the new chat's own yes, other words: nothing linked", async () => {
      const cases: [string, string, (n: number, asked: string) => Promise<void>][] = [
        ["late yes (61 min)", "whatsapp", async (_n, asked) => { clock.t += 61 * MIN; await from(asked, "yes"); }],
        ["late yes, Telegram share", "telegram", async (_n, asked) => { clock.t += 75 * MIN; await from(asked, "yes"); }],
        ["someone else's yes", "whatsapp", async (n) => { await seed(n + 50, [{ c: Q(n) }]); await lm(Q(n), "yes"); }],
        ["forwarded yes on Telegram", "whatsapp", async () => {}],
        ["forwarded yes on WhatsApp", "telegram", async () => {}],
        ["the new chat's own yes (WhatsApp)", "whatsapp", async (n) => { await wa({ from: P(n).slice(1), text: "yes" }); }],
        ["the new chat's own yes (Telegram)", "telegram", async (n) => { await tg(4100000 + n, "yes"); }],
        ["yeah", "whatsapp", async (_n, asked) => { await from(asked, "yeah"); }],
      ];
      for (let i = 0; i < cases.length; i++) {
        const n = 200 + i, [name, second, act] = cases[i];
        await journey(`never: ${name}`, async (J) => {
          closed();
          // The account: iMessage, or (for the forwarded cases) the channel that can forward.
          const firstKey = name === "forwarded yes on Telegram" ? `tg:${4300000 + n}` : name === "forwarded yes on WhatsApp" ? `wa:${P(n).slice(1)}` : P(n);
          const u = await seed(n, [{ c: firstKey, phone: P(n) }], P(n));
          const m = sent.length;
          if (second === "whatsapp" && firstKey.startsWith("wa:")) await share(4100000 + n, P(n)); else await arrive(second, n);
          const asks = asksSince(m);
          J(asks.length === 1 && asks[0].key === firstKey, `asked ${JSON.stringify(asks.map((a) => a.key))}`);
          const newKey = second === "whatsapp" && !firstKey.startsWith("wa:") ? keyOf("whatsapp", n) : keyOf("telegram", n);
          clock.t += MIN;
          if (name.startsWith("forwarded")) await from(firstKey, "yes", { forwarded: true }); else await act(n, firstKey);
          await deliver();
          J(!(await owner(newKey)), `${newKey} linked to ${await owner(newKey)}`);
          J((await rows(db, `select contact from public.channel_contacts where user_id = ${q(u)}`)).length === 1, "the account gained a contact");
          J(!turns.some((x) => x.contact === newKey), "the waiting chat ran a turn");
        });
      }
    });

    // ===================================================================================== cards (5)
    await t.step("cards: a forwarded contact card, WhatsApp's contacts message, a typed number: nothing asked, made or linked", async () => {
      const cases = ["tg card of an account's number", "tg card of an allow-listed number", "tg card from a linked chat", "WhatsApp contacts message", "typed number"];
      for (let i = 0; i < cases.length; i++) {
        const n = 300 + i;
        await journey(`cards: ${cases[i]}`, async (J) => {
          closed(i === 1 ? [P(n)] : []);
          const A = i !== 1 ? await seed(n, [{ c: P(n) }], P(n)) : null;
          const B = i === 2 ? await seed(n + 50, [{ c: `tg:${4100000 + n}` }]) : null;
          const m = sent.length, made = await accounts();
          if (i <= 2) await share(4100000 + n, P(n), 5550000 + n);
          else if (i === 3) await wa({ from: Q(n).slice(1), type: "contacts", extra: { contacts: [{ name: { formatted_name: "Friend" }, phones: [{ phone: P(n), wa_id: P(n).slice(1) }] }] } });
          else await tg(4100000 + n, `my number is ${P(n)}, link me`);
          await deliver();
          J(asksSince(m).length === 0, "a question was asked");
          J(await accounts() === made, "an account was made");
          J(await owner(`tg:${4100000 + n}`) === B, "the chat changed hands");
          if (A) J((await rows(db, `select contact from public.channel_contacts where user_id = ${q(A)}`)).length === 1, "the number's account gained a contact");
          if (i <= 2) J(read(`tg:${4100000 + n}`, m).includes(IN.PHONE_NOT_YOURS_REPLY), `not told: ${JSON.stringify(read(`tg:${4100000 + n}`, m))}`);
        });
      }
    });

    // ===================================================================================== stopped (6)
    await t.step("stopped: the number's account said STOP: no second account, no question held unseen, said plainly; START, then a yes", async () => {
      const cases: [string, string, boolean, string][] = [["imessage", "whatsapp", false, "imessage"], ["whatsapp", "imessage", false, "whatsapp"], ["imessage", "telegram", false, "imessage"], ["whatsapp", "telegram", true, "whatsapp"],
        ["imessage", "whatsapp", true, "imessage"], ["imessage", "whatsapp", false, "telegram"]];
      for (let i = 0; i < cases.length; i++) {
        const n = 400 + i, [first, second, thenStart, stopOn] = cases[i];
        await journey(`stopped: ${first} stopped (STOP on ${stopOn}), then ${second}${thenStart ? ", START, yes" : ""}`, async (J) => {
          open([P(n)]);
          const contacts = [{ c: keyOf(first, n) }, ...(stopOn === "telegram" ? [{ c: `tg:${4300000 + n}` }] : [])];
          const u = await seed(n, contacts, P(n));
          await from(stopOn === "telegram" ? `tg:${4300000 + n}` : keyOf(first, n), "STOP");
          clock.t += MIN;
          const m = sent.length, made = await accounts();
          await arrive(second, n);
          await deliver();
          J(await accounts() === made, "a second account for a stopped number");
          J(!(await owner(keyOf(second, n))), "linked");
          J((await rows(db, `select key from public.career_outbox where user_id = ${q(u)} and kind = 'link'`)).length === 0, "a question was queued for a stopped account");
          J(read(keyOf(second, n), m).includes(say.stopped(first === "imessage" ? "imessage" : "whatsapp")), `not told plainly: ${JSON.stringify(read(keyOf(second, n), m))}`);
          if (thenStart) {
            await from(keyOf(first, n), "START");
            clock.t += MIN;
            const m2 = sent.length;
            await arrive(second, n);
            const asks = asksSince(m2);
            J(asks.length === 1 && asks[0].key === keyOf(first, n), `after START: ${asks.length} questions`);
            clock.t += MIN;
            await from(keyOf(first, n), "yes");
            J(await owner(keyOf(second, n)) === u, "after START and a yes: not linked");
          }
        });
      }
    });

    // ===================================================================================== taken (4)
    await t.step("taken: the number is already an account's sign-in phone with no channel to ask: no second account, said once", async () => {
      const cases = ["imessage", "whatsapp", "telegram", "imessage-twice"];
      for (let i = 0; i < cases.length; i++) {
        const n = 500 + i, c = cases[i].split("-")[0];
        await journey(`taken: ${cases[i]}`, async (J) => {
          open();
          await seed(n, [], P(n)); // a web account with the number, no texting channel
          const m = sent.length, made = await accounts();
          await arrive(c, n);
          if (cases[i].endsWith("twice")) { clock.t += MIN; await arrive(c, n); }
          J(await accounts() === made, "a second account");
          J(!(await owner(keyOf(c, n))), "the chat became someone's");
          J(read(keyOf(c, n), m).filter((x) => x === say.taken).length === 1, `told ${JSON.stringify(read(keyOf(c, n), m))}`);
          J(!read(keyOf(c, n), m).includes(IN.CHAT_DOWN_REPLY), "read \"I couldn't answer that\"");
        });
      }
    });

    // ===================================================================================== two (4)
    await t.step("two: one number on two accounts: the third channel joins only the one that said yes; they never merge", async () => {
      const cases: ["a" | "b" | "none" | "both", boolean][] = [["a", false], ["b", false], ["both", false], ["none", true]];
      for (let i = 0; i < cases.length; i++) {
        const n = 600 + i, [by, stopA] = cases[i];
        await journey(`two: yes from ${by}${stopA ? ", A stopped" : ""}`, async (J) => {
          open();
          const A = await seed(n, [{ c: P(n), at: clock.t - (i % 2 ? 2 : 3) * HOUR }], P(n));
          const B = await seed(n + 50, [{ c: `wa:US.b${n}`, phone: P(n), at: clock.t - (i % 2 ? 3 : 2) * HOUR }]);
          if (stopA) await lm(P(n), "STOP");
          const m = sent.length, made = await accounts();
          await share(4100000 + n, P(n));
          const asks = asksSince(m);
          J(asks.length === 1, `${asks.length} questions`);
          const asked = asks[0]?.key;
          if (stopA) J(asked === `wa:US.b${n}`, `a stopped account was asked (${asked})`);
          const yes = by === "a" ? [P(n)] : by === "b" ? [`wa:US.b${n}`] : by === "both" ? [P(n), `wa:US.b${n}`] : [];
          for (const k of yes) { clock.t += MIN; await from(k, "yes"); }
          const want = asked && yes.includes(asked) ? await owner(asked) : null;
          J(await owner(`tg:${4100000 + n}`) === want, `Telegram is ${await owner(`tg:${4100000 + n}`)}'s, want ${want}`);
          J(await owner(P(n)) === A && await owner(`wa:US.b${n}`) === B, "A's or B's own contact moved");
          J(await accounts() === made, "a third account");
        });
      }
    });

    // ===================================================================================== again (4)
    await t.step("again: a second Telegram chat or WhatsApp number for an account that has one: the yes moves it", async () => {
      for (let i = 0; i < 4; i++) {
        const n = 700 + i, tgCase = i < 2;
        await journey(`again: a second ${tgCase ? "Telegram chat" : "WhatsApp number"}`, async (J) => {
          closed();
          const oldKey = tgCase ? `tg:${4300000 + n}` : `wa:${Q(n).slice(1)}`;
          const u = await seed(n, [{ c: P(n) }, { c: oldKey, phone: tgCase ? null : Q(n) }], P(n));
          const m = sent.length;
          if (tgCase) await share(4100000 + n, P(n)); else await wa({ from: P(n).slice(1), text: "my new number" });
          const asks = asksSince(m);
          J(asks.length === 1 && asks[0].key === P(n), `asked ${JSON.stringify(asks.map((a) => a.key))}: ${JSON.stringify(sent.slice(m).map((x) => [x.key, x.text.slice(0, 40)]))}`);
          clock.t += MIN;
          const m2 = sent.length;
          await lm(P(n), "yes");
          await deliver();
          const newKey = tgCase ? `tg:${4100000 + n}` : `wa:${P(n).slice(1)}`;
          J(await owner(newKey) === u, `the new chat is ${await owner(newKey)}'s`);
          J(!(await owner(oldKey)), "the earlier chat on that channel is still the account's");
          J(!read(P(n), m2).includes(IN.CHAT_DOWN_REPLY), "the yes read \"I couldn't answer that\"");
          J(read(P(n), m2).includes(IN.linkedReply(tgCase ? "telegram" : "whatsapp")), `the yes was not answered: ${JSON.stringify(read(P(n), m2))}`);
        });
      }
    });

    // ===================================================================================== tokens (10)
    await t.step("tokens: connect telegram: single use, ten minutes, the issuing account's", async () => {
      const cases = ["fresh", "twice", "late", "edge 9:59", "elsewhere", "forged", "fourth", "deleted", "replace old chat", "another account's"];
      for (let i = 0; i < cases.length; i++) {
        const n = 800 + i, c = cases[i], chat = 4100000 + n, chat2 = 4200000 + n;
        await journey(`tokens: ${c}`, async (J) => {
          closed();
          const u = await seed(n, [{ c: P(n), at: clock.t - MIN }, ...(c === "replace old chat" ? [{ c: `tg:${chat2}` }] : [])], P(n));
          const issue = async (who: string) => { const r = await rows<{ n: string }>(db, `select public.channel_link_nonce_issue(${q(who)}, ${q(iso(clock.t))}) as n`); return r[0].n; };
          let N: string;
          if (c === "fresh") {
            const m = sent.length;
            await lm(P(n), "connect telegram");
            N = /start=([A-Za-z0-9_-]{32})/.exec(read(P(n), m).join("\n"))?.[1] ?? "";
            J(N, `no link: ${JSON.stringify(read(P(n), m))}`);
          } else N = await issue(u);
          let want: string | null = u, reply = IN.TELEGRAM_LINKED_REPLY;
          if (c === "late") { clock.t += 10 * MIN; want = null; reply = IN.TELEGRAM_LINK_INVALID_REPLY; }
          if (c === "edge 9:59") clock.t += 10 * MIN - 1000;
          if (c === "elsewhere") { const B = await seed(n + 50, [{ c: `tg:${chat}` }]); want = B; reply = IN.TELEGRAM_LINKED_ELSEWHERE_REPLY; }
          if (c === "forged") { N = N.split("").reverse().join(""); want = null; reply = IN.TELEGRAM_LINK_INVALID_REPLY; }
          if (c === "fourth") { const first = N; for (let k = 0; k < 3; k++) { clock.t += 1000; N = await issue(u); } const m = sent.length; await tg(chat2, `/start ${first}`); J(read(`tg:${chat2}`, m).includes(IN.TELEGRAM_LINK_INVALID_REPLY) && !(await owner(`tg:${chat2}`)), "the first of four live links worked"); }
          if (c === "deleted") { await db.sql.query(`delete from auth.users where id = ${q(u)}`); want = null; reply = IN.TELEGRAM_LINK_INVALID_REPLY; }
          if (c === "another account's") { const B = await seed(n + 50, [{ c: Q(n) }]); N = await issue(B); want = B; }
          const m = sent.length;
          await tg(chat, `/start ${N}`);
          // TELEGRAM LINK OWNERSHIP (2026-10-31): a chat that is no one's is linked only on the YES of the account's own channel
          // (the contact the question was asked on, read back from the database).
          if (reply === IN.TELEGRAM_LINKED_REPLY) {
            J(read(`tg:${chat}`, m).includes(IN.TELEGRAM_LINK_CONFIRM_REPLY), `${c}: told ${JSON.stringify(read(`tg:${chat}`, m))}`);
            J(!(await owner(`tg:${chat}`)), `${c}: linked before the YES`);
            const on = (await rows<{ asked_on: string }>(db, `select asked_on from public.channel_link_requests where contact = ${q(`tg:${chat}`)} and by_code and answered_at is null`))[0]?.asked_on ?? "";
            J(read(on, m).some((x) => /^Someone wants to link Telegram /.test(x)), `${c}: the account's channel ${on} was not asked`);
            const y = sent.length;
            const linkReply = `LINK ${/reply LINK ([0-9]{4}) /.exec(read(on, m).filter((x) => /^Someone wants to link Telegram /.test(x)).at(-1) ?? "")?.[1] ?? "none"}`;
            if (on.startsWith("tg:")) await tg(Number(on.slice(3)), linkReply); else await lm(on, linkReply);
            J(read(`tg:${chat}`, y).includes(IN.LINKED_HERE_REPLY), `${c}: after the YES told ${JSON.stringify(read(`tg:${chat}`, y))}`);
          } else J(read(`tg:${chat}`, m).includes(reply), `${c}: told ${JSON.stringify(read(`tg:${chat}`, m))}`);
          J(await owner(`tg:${chat}`) === want, `${c}: the chat is ${await owner(`tg:${chat}`)}'s, want ${want}`);
          if (c === "twice") { const m2 = sent.length; await tg(chat2, `/start ${N}`); J(read(`tg:${chat2}`, m2).includes(IN.TELEGRAM_LINK_INVALID_REPLY) && !(await owner(`tg:${chat2}`)), "a used link worked again"); }
          if (c === "replace old chat") J(!(await owner(`tg:${chat2}`)), "the account kept two Telegram chats");
          if (want === u) {
            const t0 = turns.length;
            await tg(chat, "remember I like Denver");
            await lm(P(n), "what do you know about me");
            // The Telegram turn opened the account's first thread; the iMessage turn runs in it.
            const tgThread = (await rows<{ thread_id: string | null }>(db, `select thread_id from public.channel_contacts where contact = ${q(`tg:${chat}`)}`))[0]?.thread_id ?? null;
            J(turns.slice(t0).every((x) => x.userId === u) && tgThread && turns.at(-1)!.threadId === tgThread, `Telegram and iMessage are not one account in one thread: ${JSON.stringify(turns.slice(t0))} (Telegram's thread ${tgThread})`);
            J(read(P(n)).some((x) => x.includes("I know: I like Denver")), "said on Telegram, not known on iMessage");
          }
        });
      }
    });

    // ===================================================================================== recycled (6)
    await t.step("recycled: a WhatsApp number given to someone else gets a fresh account; a moved number keeps its person", async () => {
      const cases: [string, "open" | "closed", boolean][] = [["new owner, sign-up open", "open", true], ["new owner, sign-up open, no other channel", "open", false], ["new owner, number allow-listed", "closed", true], ["new owner, sign-up closed", "closed", false], ["moved", "closed", true], ["moved, no other channel", "closed", false]];
      for (let i = 0; i < cases.length; i++) {
        const n = 900 + i, [name, signup, other] = cases[i], addr = P(n).slice(1);
        await journey(`recycled: ${name}`, async (J) => {
          if (signup === "open") open(); else closed(name.includes("allow") ? [P(n)] : []);
          const A = await seed(n, [{ c: `wa:${addr}`, alias: `US.old${n}`, at: clock.t - HOUR }, ...(other ? [{ c: Q(n), at: clock.t - 2 * HOUR }] : [])], P(n));
          await wa({ from: addr, bsuid: `US.old${n}`, text: "remember my target is Acme" });
          await db.sql.query(`insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (${q(A)}, ${q(`status:rc${n}`)}, 'status', ${q(`[${A}] an update`)}, ${q(iso(clock.t + MIN))})`);
          clock.t += 30 * MIN;
          const m = sent.length, t0 = turns.length;
          if (name.startsWith("moved")) {
            await wa({ from: addr, bsuid: `US.old${n}`, type: "system", extra: { system: { body: "changed", wa_id: Q(n).slice(1).replace(/^1555/, "1556"), type: "user_changed_number" } } });
            const to = `wa:${Q(n).slice(1).replace(/^1555/, "1556")}`;
            clock.t += MIN;
            await wa({ from: to.slice(3), bsuid: `US.old${n}`, text: "what do you know about me" });
            await deliver();
            J(await owner(to) === A, "the moved number is not the person's");
            J(read(to, m).includes(`[${A}] I know: my target is Acme`), `the person lost their memory: ${JSON.stringify(read(to, m))}`);
            return;
          }
          await wa({ from: addr, bsuid: `US.new${n}`, text: "what do you know about me" });
          await deliver();
          J(!turns.slice(t0).some((x) => x.userId === A), "the new owner ran as the old one");
          J(!read(`wa:${addr}`, m).some((x) => x.includes("Acme") || x.includes(`[${A}]`)), "the new owner read the old owner's messages");
          const nu = await owner(`wa:${addr}`);
          if (signup === "open" || name.includes("allow")) {
            J(nu && nu !== A, `no fresh account for the new owner: ${JSON.stringify(read(`wa:${addr}`, m))}`);
            J(nu && read(`wa:${addr}`, m).includes(`[${nu}] I know: nothing`), `the fresh account's first turn: ${JSON.stringify(read(`wa:${addr}`, m))}`);
          } else J(!nu && read(`wa:${addr}`, m).includes(IN.SIGNUP_CLOSED_REPLY), `the stranger: ${JSON.stringify(read(`wa:${addr}`, m))}`);
          if (other) J(read(Q(n)).includes(`[${A}] an update`), "the old owner's update did not go to their other channel");
        });
      }
    });

    // ===================================================================================== deleted (6)
    await t.step("deleted: an account deleted and the person back: fresh; told about sign-up, never silence", async () => {
      const cases = ["back on iMessage, sign-up open", "back on WhatsApp, number allow-listed", "back on Telegram by share, sign-up open", "the number that waited for a yes, sign-up closed", "a Telegram chat unlinked from the web, sign-up closed", "back on iMessage, sign-up closed"];
      for (let i = 0; i < cases.length; i++) {
        const n = 1000 + i, c = cases[i];
        await journey(`deleted: ${c}`, async (J) => {
          if (c.includes("open")) open(); else closed(c.includes("allow") ? [P(n)] : []);
          if (c.startsWith("a Telegram chat unlinked")) {
            const u = await seed(n, [{ c: Q(n) }, { c: `tg:${4100000 + n}` }]);
            await rows(db, `select public.channel_telegram_unlink_as(${q(u)}, ${q(iso(clock.t))})`);
            const m = sent.length;
            await tg(4100000 + n, "hello?");
            await tg(4100000 + n, "anyone?");
            J(read(`tg:${4100000 + n}`, m).filter((x) => x === IN.SIGNUP_CLOSED_REPLY).length === 1, `the unlinked chat: ${JSON.stringify(read(`tg:${4100000 + n}`, m))}`);
            return;
          }
          const u = await seed(n, [{ c: P(n) }], P(n));
          await lm(P(n), "remember I am a nurse");
          if (c.startsWith("the number that waited")) await wa({ from: P(n).slice(1), text: "hi" });
          await db.sql.query(`insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (${q(u)}, ${q(`status:del${n}`)}, 'status', ${q(`[${u}] an update`)}, ${q(iso(clock.t + MIN))})`);
          await db.sql.query(`delete from auth.users where id = ${q(u)}`);
          authPhones.delete(P(n));
          clock.t += 2 * MIN;
          await deliver();
          const back = c.includes("WhatsApp") || c.startsWith("the number that waited") ? `wa:${P(n).slice(1)}` : c.includes("Telegram") ? `tg:${4100000 + n}` : P(n);
          const m = sent.length;
          if (back.startsWith("tg:")) await share(4100000 + n, P(n)); else await from(back, "hi, I'm back");
          await from(back, "what do you know about me");
          await deliver();
          const nu = await owner(back);
          J(nu !== u, "the deleted account came back");
          J(!read(back, m).some((x) => x.includes("nurse") || x.includes(`[${u}]`)), "the returner read the deleted account's data");
          J(!sent.some((x) => x.text === `[${u}] an update`), "a deleted account's update went out");
          if (c.includes("closed")) J(!nu && read(back, m).includes(IN.SIGNUP_CLOSED_REPLY), `not told about sign-up: ${JSON.stringify(read(back, m))}`);
          else J(nu && read(back, m).includes(`[${nu}] I know: nothing`), `not a fresh account: ${JSON.stringify(read(back, m))}`);
        });
      }
    });

    // ===================================================================================== stop and home (6)
    await t.step("stop: STOP is the person's; the home channel; a link never moves it", async () => {
      for (let i = 0; i < 3; i++) {
        const n = 1100 + i, chans = [P(n), `wa:${P(n).slice(1)}`, `tg:${4100000 + n}`];
        const [stopOn, textOn, startOn] = [chans[i], chans[(i + 1) % 3], chans[(i + 2) % 3]];
        await journey(`stop: STOP on ${stopOn.slice(0, 3)}, text on ${textOn.slice(0, 3)}, START on ${startOn.slice(0, 3)}`, async (J) => {
          closed();
          const u = await seed(n, chans.map((c, k) => ({ c, at: clock.t - (k + 1) * MIN, phone: c.startsWith("tg:") ? null : undefined })), P(n));
          await wa({ from: P(n).slice(1), text: "window open" });
          const m = sent.length;
          await from(stopOn, "STOP");
          J(read(stopOn, m).includes(CHANNEL_REPLIES.stop), "the STOP not answered where it was said");
          await db.sql.query(`insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (${q(u)}, ${q(`status:st${n}`)}, 'status', ${q(`[${u}] update 1`)}, ${q(iso(clock.t))})`);
          clock.t += MIN; await deliver();
          J(!sent.slice(m).some((x) => x.text === `[${u}] update 1`), "an update went out after STOP");
          const m2 = sent.length;
          await from(textOn, "is my application in?");
          J(read(textOn, m2).includes(`[${u}] is my application in? answered`), "the answer after STOP did not go where it was asked");
          await from(startOn, "START");
          await db.sql.query(`insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (${q(u)}, ${q(`status:st${n}b`)}, 'status', ${q(`[${u}] update 2`)}, ${q(iso(clock.t))})`);
          clock.t += MIN; await deliver();
          J(sent.some((x) => x.text === `[${u}] update 2`), "START elsewhere did not resume");
        });
      }
      for (let i = 0; i < 3; i++) {
        const n = 1150 + i;
        await journey(`home: ${["set to Telegram", "last written on", "a link does not move it"][i]}`, async (J) => {
          closed();
          const u = await seed(n, [{ c: P(n), at: clock.t - 3 * HOUR }, { c: `tg:${4100000 + n}`, at: clock.t - 4 * HOUR }], P(n));
          if (i === 0) await db.sql.query(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', ${q(u)}, true), set_config('request.jwt.claims', ${q(JSON.stringify({ sub: u, role: "authenticated" }))}, true); select public.channel_set_home('telegram'); commit;`);
          await lm(P(n), "checking in");
          if (i === 2) {
            clock.t += MIN;
            const m = sent.length;
            await wa({ from: P(n).slice(1), text: "hi" });
            const asks = asksSince(m);
            J(asks.length === 1, `${asks.length} questions`);
            clock.t += MIN;
            await lm(P(n), "yes");
            J(await owner(`wa:${P(n).slice(1)}`) === u, "not linked");
          }
          clock.t += MIN;
          const m = sent.length;
          await db.sql.query(`insert into public.career_outbox(user_id, key, kind, text, deliver_at) values (${q(u)}, ${q(`status:hm${n}`)}, 'status', ${q(`[${u}] home update`)}, ${q(iso(clock.t))})`);
          await deliver();
          const where = sent.slice(m).filter((x) => x.text === `[${u}] home update`).map((x) => x.key);
          const want = i === 0 ? `tg:${4100000 + n}` : P(n);
          J(where.length === 1 && where[0] === want, `the update went to ${JSON.stringify(where)}, want ${want}`);
        });
      }
    });

    // ===================================================================================== races (6)
    await t.step("races: two asks at once, a link during a running turn, Telegram unlinked mid-delivery, two chats on one link", async () => {
      await journey("races: WhatsApp and Telegram asking at once, two yeses", async (J) => {
        const n = 1200; closed();
        const u = await seed(n, [{ c: P(n) }], P(n));
        const m = sent.length;
        await Promise.all([wa({ from: P(n).slice(1), text: "hi" }), share(4100000 + n, P(n))]);
        J(asksSince(m).length === 2, `${asksSince(m).length} questions`);
        clock.t += MIN; await lm(P(n), "yes");
        clock.t += MIN; await lm(P(n), "yes");
        J(await owner(`wa:${P(n).slice(1)}`) === u && await owner(`tg:${4100000 + n}`) === u, "two yeses did not link both");
      });
      await journey("races: WhatsApp asks while the iMessage turn runs; the yes after it links", async (J) => {
        const n = 1201; closed();
        const u = await seed(n, [{ c: P(n) }], P(n));
        beforeTurn = async () => { await wa({ from: P(n).slice(1), text: "hi from whatsapp" }); };
        await lm(P(n), "find me jobs");
        clock.t += MIN;
        await lm(P(n), "yes");
        J(await owner(`wa:${P(n).slice(1)}`) === u, "not linked");
      });
      for (let i = 0; i < 2; i++) {
        const n = 1202 + i;
        await journey(`races: Telegram unlinked ${i ? "from the web" : "by text"} while an answer in parts goes out`, async (J) => {
          closed();
          const u = await seed(n, [{ c: `tg:${4100000 + n}`, at: clock.t - MIN }, { c: P(n), at: clock.t - 2 * MIN }], P(n));
          for (let k = 1; k <= 4; k++) ok(await store.enqueueReply(u, `reply:tg:rc${n}:${k}`, `[${u}] part ${k} of 4`, clock.t, "telegram", { of: `reply:tg:rc${n}`, n: k }), "queued");
          let unlinkedAt = -1;
          onSend = async (x) => {
            if (!x.text.includes("part 2 of 4")) return;
            onSend = null; unlinkedAt = sent.length;
            if (i) await rows(db, `select public.channel_telegram_unlink_as(${q(u)}, ${q(iso(clock.t))})`); else await tg(4100000 + n, "unlink telegram");
          };
          for (let k = 0; k < 4; k++) { await deliver(); clock.t += MIN; }
          J(unlinkedAt > 0, "never unlinked");
          J(!sent.slice(unlinkedAt).some((x) => x.key === `tg:${4100000 + n}` && x.text.includes("part ")), "a part went to the chat after it was unlinked");
          J(JSON.stringify(read(P(n)).filter((x) => x.includes("part ")).map((x) => Number(/part (\d)/.exec(x)![1]))) === "[3,4]", `the rest on iMessage: ${JSON.stringify(read(P(n)))}`);
        });
      }
      await journey("races: two chats redeeming one link at once", async (J) => {
        const n = 1204; closed();
        const u = await seed(n, [{ c: P(n) }], P(n));
        const N = (await rows<{ n: string }>(db, `select public.channel_link_nonce_issue(${q(u)}, ${q(iso(clock.t))}) as n`))[0].n;
        await Promise.all([tg(4100000 + n, `/start ${N}`), tg(4200000 + n, `/start ${N}`), tg(4300000 + n, `/start ${N}`)]);
        // TELEGRAM LINK OWNERSHIP (2026-10-31): one question for one link, nothing linked before the account's YES, then one chat.
        const early = [await owner(`tg:${4100000 + n}`), await owner(`tg:${4200000 + n}`), await owner(`tg:${4300000 + n}`)].filter(Boolean);
        J(!early.length, `${early.length} chats linked before the YES`);
        J((await rows(db, `select id from public.channel_link_requests where user_id = ${q(u)} and by_code`)).length === 1, "one link asked more than once");
        await lm(P(n), `LINK ${/reply LINK ([0-9]{4}) /.exec(read(P(n)).filter((x) => /^Someone wants to link Telegram /.test(x)).at(-1) ?? "")?.[1] ?? "none"}`);
        const owners = [await owner(`tg:${4100000 + n}`), await owner(`tg:${4200000 + n}`), await owner(`tg:${4300000 + n}`)].filter(Boolean);
        J(owners.length === 1 && owners[0] === u, `${owners.length} chats linked by one link`);
      });
      await journey("races: a retried webhook while the link waits changes nothing", async (J) => {
        const n = 1205; closed();
        const u = await seed(n, [{ c: P(n) }], P(n));
        const m = sent.length;
        await wa({ from: P(n).slice(1), text: "hi" }); await wa({ from: P(n).slice(1), text: "hi again" }); await share(4100000 + n, P(n)); await share(4100000 + n, P(n));
        J(asksSince(m).length === 2, `${asksSince(m).length} questions (one per chat)`);
        J((await rows(db, `select id from public.channel_link_requests where user_id = ${q(u)}`)).length === 2, "requests");
      });
    });

    // ===================================================================================== memory (5)
    await t.step("memory: after a link every channel runs as one account in one thread; another account knows nothing of it", async () => {
      const orders = [["telegram", "imessage"], ["imessage", "telegram", "whatsapp"], ["whatsapp", "telegram"], ["telegram", "whatsapp", "imessage"], ["imessage", "whatsapp"]];
      for (let i = 0; i < orders.length; i++) {
        const n = 1300 + i, order = orders[i];
        await journey(`memory: ${order.join(">")}`, async (J) => {
          closed([P(n)]);
          for (let k = 0; k < order.length; k++) {
            const m = sent.length;
            await arrive(order[k], n);
            if (k) { const a = asksSince(m); J(a.length === 1, `${order[k]}: ${a.length} questions`); if (a[0]) { clock.t += MIN; await from(a[0].key, "yes"); } }
          }
          const u = await owner(keyOf(order[0], n));
          J(u && (await Promise.all(order.map((c) => owner(keyOf(c, n))))).every((x) => x === u), "not one account");
          const m = sent.length;
          await from(keyOf(order[0], n), "remember I want to work in Denver");
          await from(keyOf(order.at(-1)!, n), "what do you know about me");
          J(read(keyOf(order.at(-1)!, n), m).includes(`[${u}] I know: I want to work in Denver`), `not known on ${order.at(-1)}: ${JSON.stringify(read(keyOf(order.at(-1)!, n), m))}`);
          const o = await seed(n + 50, [{ c: Q(n) }]);
          const m2 = sent.length;
          await lm(Q(n), "what do you know about me");
          J(read(Q(n), m2).includes(`[${o}] I know: nothing`), "another account knows it");
        });
      }
    });

    await t.step("everything read back: nobody reads another account's message; every turn as its contact's owner; nothing stuck", async () => {
      for (const s of sent) { const m = /^\[([0-9a-f-]{36})\]/.exec(s.text); if (m && !ever.get(s.key)?.has(m[1])) fails.push(`read back: ${s.key} read ${m[1]}'s message: ${s.text.slice(0, 60)}`); }
      for (const x of turns) if (!ever.get(x.contact)?.has(x.userId)) fails.push(`read back: a turn from ${x.contact} ran as ${x.userId}`);
      if (sent.some((s) => s.text === IN.CHAT_DOWN_REPLY)) fails.push(`read back: someone read "${IN.CHAT_DOWN_REPLY}" (${sent.filter((s) => s.text === IN.CHAT_DOWN_REPLY).map((s) => s.key).join(", ")})`);
      const stuck = await rows(db, `select key from public.career_outbox where status = 'sending'`);
      if (stuck.length) fails.push(`read back: rows stuck sending: ${JSON.stringify(stuck)}`);
      console.log(`[identity flow] ${journeys} journeys, ${turns.length} turns, ${sent.length} messages, ${fails.length} failures, ${Date.now() - started} ms`);
      if (fails.length) console.log(fails.map((f) => `  FAIL ${f}`).join("\n"));
      assertNode.ok(journeys >= 80, `${journeys} journeys`);
      assertNode.deepStrictEqual(fails, [], `${fails.length} failures`);
    });
  } finally {
    await db.stop();
  }
} });
const ok = (v: unknown, m: string) => assertNode.ok(v, m);
