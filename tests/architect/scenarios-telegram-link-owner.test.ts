// Telegram link ownership (architect, 2026-10-31; owner rule of 2026-10-29: "A signed, expiring, single-use link is not proof of
// who opened it. An unused, forwarded or copied link must not let another person read my private data or act as me.").
// "/start <code>" (t.me/<bot>?start=<code>, made by "connect telegram" or the app's Connect Telegram) linked WHICHEVER Telegram
// chat opened it. Now opening it only asks the account's own channel (the chat or number the person already uses), and the chat
// is linked only on that contact's own typed YES, within 15 minutes, once (20261031040000_telegram_link_confirm.sql).
// Seeded scenarios (SEED below) through the real webhooks (trainee-inbound's handleInbound for iMessage, trainee-whatsapp's
// handleWhatsApp, signed; trainee-telegram's handleTelegram), the real inbound core and the real head-start deliverer, over the
// memory database (channel_memory.ts, the rules of the SQL), fake provider HTTP on a deterministic clock. No network, no model.
// Kinds:
//   stranger       the link forwarded to someone else, who opens it (and then texts, says yes, taps a button, shares a number)
//   owner          the person opens their own link and says YES where they already use Trainee
//   twice          the same chat opens the link twice: one question; the YES links it
//   expired        the link opened after its 10 minutes: nothing asked, nothing linked
//   late_yes       the YES after the question's 15 minutes: nothing linked
//   replay         the link opened again after it linked (by a stranger, and by the linked chat)
//   wrong_channel  a yes from a contact that was not asked: another account's, the account's other channel, the new chat itself
//   forwarded_yes  the asked contact forwards a "yes" (WhatsApp's forwarded flag): nothing linked
//   stop_after     the asked contact says STOP after the question, then yes: nothing linked
//   stop_before    the account is stopped before the link is opened: nothing asked or linked; told plainly
//   deleted        the account is deleted while the question waits: nothing linked, ever
//   race           two strangers (or a stranger and the owner) open the same link: one question, at most one link
//   two_codes      the owner opens one link while a stranger opens another of theirs: the yes links neither
//   no_channel     a link made in the app for an account with no channel to ask: nothing linked; told plainly
// Invariants on every scenario: no chat the account's YES did not confirm ever runs a turn as the account, reads anything tagged
// for it, or reads its number or email; no button tap there approves anything; a chat joins the account only after the asked
// contact's own typed YES; one code links at most one chat; every webhook answers 200.
// Run: deno test -A --no-check tests/architect/scenarios-telegram-link-owner.test.ts
import assertNode from "node:assert/strict";
import { memoryChannelWorld } from "../../supabase/functions/_shared/channel_memory.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { CHANNEL_REPLIES, deliverDue } from "../../supabase/functions/_shared/channel.ts";
import * as IN from "../../supabase/functions/_shared/channel_inbound.ts";
import { loopSend } from "../../supabase/functions/_shared/loopmessage.ts";
import { whatsappAdapter, whatsappSignature } from "../../supabase/functions/_shared/whatsapp.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { handleInbound } from "../../supabase/functions/trainee-inbound/handler.ts";
import { handleWhatsApp } from "../../supabase/functions/trainee-whatsapp/handler.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";

const SEED = 20261031;
const PER_KIND = Number(Deno.env.get("TGLINK_PER_KIND") || 150);
const MIN = 60000, HOUR = 3600000, T0 = Date.UTC(2026, 10, 2, 15, 0, 0);
// What the fixed build says (read from the module, so this file runs against the code before the fix too and fails there).
const X = IN as Record<string, unknown>;
const CONFIRM = (X.TELEGRAM_LINK_CONFIRM_REPLY as string) ?? "<TELEGRAM_LINK_CONFIRM_REPLY>";
const WAITING = (X.TELEGRAM_LINK_WAITING_REPLY as string) ?? "<TELEGRAM_LINK_WAITING_REPLY>";
const CANT_ASK = (X.TELEGRAM_LINK_CANT_ASK_REPLY as string) ?? "<TELEGRAM_LINK_CANT_ASK_REPLY>";
const AMBIGUOUS = (X.LINK_AMBIGUOUS_REPLY as string) ?? "<LINK_AMBIGUOUS_REPLY>";
const ASK = /^Someone wants to link Telegram (@[A-Za-z0-9_]{5,32}|\(no username; Telegram id [0-9]{1,20}\)|\(an account with no username\)) to your Trainee\. To allow it, reply LINK ([0-9]{4}|\{code\}) here within 15 minutes\. A plain yes does not link it; ignore this if it wasn't you\./;
// Secrets made at run time (no key-shaped string in a tracked file).
const mk = (p: string, n: number) => `${p}${"x".repeat(n)}`;
const TG_TOKEN = `${7000 + 3}:${mk("TeSt", 31)}`, TG_SECRET = mk("tgsecret_", 32), WA_APP = mk("app", 32), WA_VERIFY = mk("verify", 32);
const LM_KEY = mk("loop", 20), IN_SECRET = mk("insecret", 32), WA_TOKEN = mk("watoken", 20);

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)], chance: (p: number) => next() < p, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)) };
}

// ------------------------------------------------------------------------------------------------ fake providers
type Prov = "telegram" | "whatsapp" | "loopmessage";
type Sent = { prov: Prov; to: string; text: string };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
function providers() {
  const sent: Sent[] = [], taps: { id: string; text: string }[] = [];
  let seq = 0;
  const fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const b = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.host === "api.telegram.org") {
      const method = u.pathname.split("/").pop();
      if (method === "answerCallbackQuery") { taps.push({ id: String(b.callback_query_id), text: String(b.text ?? "") }); return json({ ok: true, result: true }); }
      if (method !== "sendMessage") return json({ ok: true, result: method === "sendChatAction" ? true : { message_id: ++seq } });
      sent.push({ prov: "telegram", to: String(b.chat_id), text: String(b.text) });
      return json({ ok: true, result: { message_id: ++seq } });
    }
    if (u.host === "graph.facebook.com") {
      if (b.status === "read") return json({ success: true });
      if (b.type === "template") return json({ messages: [{ id: `wamid.t${++seq}` }] });
      sent.push({ prov: "whatsapp", to: String(b.to ?? ""), text: String(b.text?.body ?? "") });
      return json({ messages: [{ id: `wamid.${++seq}` }] });
    }
    if (u.host === "a.loopmessage.com") { sent.push({ prov: "loopmessage", to: String(b.contact), text: String(b.text) }); return json({ message_id: `lm-${++seq}`, success: true }); }
    throw new TypeError(`network refused: ${u.host}`);
  }) as typeof globalThis.fetch;
  return { sent, taps, fetch };
}
const keyOfSent = (s: Sent) => (s.prov === "telegram" ? `tg:${s.to}` : s.prov === "whatsapp" ? `wa:${s.to}` : s.to);

// ------------------------------------------------------------------------------------------------ one world
function world(signup: "open" | "closed") {
  const W = memoryChannelWorld();
  const clock = { t: T0 };
  const P = providers();
  const vars: Record<string, string> = { TRAINEE_INBOUND_SECRET: IN_SECRET, LOOPMESSAGE_API_KEY: LM_KEY, TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_WEBHOOK_SECRET: TG_SECRET,
    TELEGRAM_BOT_USERNAME: "TraineeLinkBot", TELEGRAM_LOGIN_URL: "https://trainee.example.test/telegram-link.html", WHATSAPP_TOKEN: WA_TOKEN, WHATSAPP_PHONE_NUMBER_ID: "1",
    WHATSAPP_APP_SECRET: WA_APP, WHATSAPP_VERIFY_TOKEN: WA_VERIFY, TRAINEE_SIGNUP: signup };
  const env = { get: (k: string) => vars[k] || undefined };
  const sleep = async (ms: number) => { clock.t += ms; };
  const turns: { contact: string; userId: string; message: string }[] = [];
  let cur = "";
  const chat = async (a: any) => { turns.push({ contact: cur, userId: a.userId, message: a.message }); return { status: 200, threadId: a.threadId ?? `t-${a.userId}`, reply: `[${a.userId}] PRIVATE answer to ${a.message}` } as any; };
  const adapters = () => adaptersFromEnv(env, { fetch: P.fetch, clock: () => clock.t, sleep });
  const head = async (a: { userId: string; key?: string; now: number; wholeUser?: boolean }) => {
    const s = W.delivery(a.wholeUser ? { user: a.userId } : { only: { userId: a.userId, key: a.key! } });
    const r = await deliverDue({ store: s, adapters: adapters(), now: a.now, limit: a.wholeUser ? 40 : 1 });
    await s.release();
    return r;
  };
  const statuses: number[] = [];
  const after = async (res: Response) => { const body = await res.json().catch(() => null); if (res.status !== 200) statuses.push(res.status); return body; };
  let mid = 0, upd = 0;
  const lm = async (from: string, text: string) => {
    cur = from; clock.t += 1000;
    return await after(await handleInbound(new Request(`https://fn.test/trainee-inbound?secret=${IN_SECRET}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alert_type: "message_inbound", message_id: `lm-in-${++mid}`, recipient: from, text }) }), {
      env, now: () => clock.t, store: () => W.inbound, send: (k) => loopSend({ apiKey: k, fetch: P.fetch, sleep }), chat, deliverReply: (a) => head({ userId: a.userId, key: a.key, now: a.now }),
    }));
  };
  const wa = async (digits: string, text: string, forwarded = false) => {
    cur = `wa:${digits}`; clock.t += 1000;
    const m = { id: `wamid.in${++mid}`, timestamp: String(Math.floor(clock.t / 1000)), type: "text", from: digits, text: { body: text }, ...(forwarded ? { context: { forwarded: true } } : {}) };
    const raw = new TextEncoder().encode(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "1" },
      contacts: [{ profile: { name: "T" }, wa_id: digits }], messages: [m] } }] }] }));
    const req = new Request("https://fn.test/trainee-whatsapp", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": await whatsappSignature(WA_APP, raw) }, body: raw });
    return await after(await handleWhatsApp(req, { env, now: () => clock.t, store: () => W.inbound, chat, deliver: (x) => head({ userId: x.userId, now: x.now, wholeUser: true }),
      adapter: (e) => whatsappAdapter({ token: e.get("WHATSAPP_TOKEN") || "", phoneNumberId: "1", appSecret: WA_APP, verifyToken: WA_VERIFY, fetch: P.fetch, clock: () => clock.t, sleep }) }));
  };
  const tgUpdate = async (chatId: number, body: Record<string, unknown>) => {
    cur = `tg:${chatId}`; clock.t += 1000;
    const req = new Request("https://fn.test/trainee-telegram", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TG_SECRET }, body: JSON.stringify({ update_id: ++upd, ...body }) });
    return await after(await handleTelegram(req, { env, now: () => clock.t, store: () => W.inbound, chat, deliver: (a) => head({ userId: a.userId, key: a.key, now: a.now }),
      adapter: (e) => telegramAdapter({ token: e.get("TELEGRAM_BOT_TOKEN") || "", webhookSecret: TG_SECRET, fetch: P.fetch, clock: () => clock.t, sleep }) }));
  };
  const handles = new Map<number, string>();
  const fromOf = (chatId: number) => ({ id: chatId, is_bot: false, first_name: "T", ...(handles.has(chatId) ? { username: handles.get(chatId) } : {}) });
  const tg = async (chatId: number, text: string, forwarded = false) =>
    await tgUpdate(chatId, { message: { message_id: ++mid, chat: { id: chatId, type: "private" }, from: fromOf(chatId), date: Math.floor(clock.t / 1000), text,
      ...(forwarded ? { forward_origin: { type: "user", sender_user: { id: 4242, is_bot: false, first_name: "F" }, date: 1 } } : {}) } });
  const tgTap = async (chatId: number, data: string) => {
    const id = `cb${++mid}`;
    await tgUpdate(chatId, { callback_query: { id, from: fromOf(chatId), chat_instance: `ci${chatId}`, message: { message_id: 1, chat: { id: chatId, type: "private" }, date: 1 }, data } });
    return P.taps.filter((t) => t.id === id).map((t) => t.text);
  };
  const tgShare = async (chatId: number, phone: string) =>
    await tgUpdate(chatId, { message: { message_id: ++mid, chat: { id: chatId, type: "private" }, from: fromOf(chatId), date: 1, contact: { phone_number: phone.replace("+", ""), user_id: chatId, first_name: "T" } } });
  // A message from a contact key, on its channel.
  const from = async (key: string, text: string, forwarded = false) =>
    key.startsWith("tg:") ? await tg(Number(key.slice(3)), text, forwarded) : key.startsWith("wa:") ? await wa(key.slice(3), text, forwarded) : await lm(key, text);
  const owner = (key: string) => W.contacts.get(key)?.userId ?? null;
  const mark = () => P.sent.length;
  const read = (key: string, since = 0) => P.sent.slice(since).filter((s) => keyOfSent(s) === key).map((s) => s.text);
  return { W, clock, P, vars, turns, statuses, lm, wa, tg, tgTap, tgShare, from, owner, mark, read, handles };
}
type World = ReturnType<typeof world>;

// ------------------------------------------------------------------------------------------------ the scenarios
const KINDS = ["stranger", "owner", "twice", "expired", "late_yes", "replay", "wrong_channel", "forwarded_yes", "stop_after", "stop_before", "deleted", "race", "two_codes", "no_channel"] as const;
type Kind = typeof KINDS[number];
type Home = "imessage" | "whatsapp" | "telegram";

async function scenario(kind: Kind, id: number, r: ReturnType<typeof rng>): Promise<string[]> {
  const w = world(r.pick(["open", "closed"] as const));
  const whys: string[] = [];
  const phone = `+1555${String(4000000 + id).padStart(7, "0")}`, email = `owner${id}@example.test`;
  // The account's own channel: iMessage, WhatsApp, or (a person moving to a new Telegram account) an older Telegram chat.
  const home: Home = kind === "forwarded_yes" ? "whatsapp" : kind === "no_channel" ? "imessage" : r.pick(["imessage", "whatsapp", "telegram"] as const);
  const oldChat = 970000000 + id * 10;
  const homeKey = home === "imessage" ? phone : home === "whatsapp" ? `wa:${phone.slice(1)}` : `tg:${oldChat}`;
  const A = w.W.newUser();
  if (kind !== "no_channel") w.W.link(homeKey, A, w.clock.t - 2 * HOUR, { lastInboundAt: w.clock.t - HOUR, threadId: `t-${A}`, phone: home === "telegram" ? null : phone });
  const mine = 980000000 + id * 10, S1 = 990000000 + id * 10, S2 = S1 + 1;
  if (r.chance(0.7)) w.handles.set(S1, `stranger_${id}`);
  if (r.chance(0.5)) w.handles.set(S2, `other_${id}`);
  if (r.chance(0.7)) w.handles.set(mine, `owner_${id}`);
  const confirmed = new Set<string>(); // chats the account's own YES linked (the harness records it as it sends that YES)
  // The link: texted for on the account's channel (iMessage, WhatsApp), or the app's Connect Telegram (a Telegram home, or no home).
  const issue = async (): Promise<string> => {
    if (home === "telegram" || kind === "no_channel" || r.chance(0.3)) return await w.W.inbound.issueLinkNonce!(A, w.clock.t);
    const m = w.mark();
    await w.from(homeKey, "connect telegram");
    return /start=([A-Za-z0-9_-]{32})/.exec(w.read(homeKey, m).join("\n"))?.[1] ?? "";
  };
  const code = await issue();
  if (!code) return ["setup: no link was issued"];
  const asks = (since = 0) => w.read(homeKey, since).filter((t) => ASK.test(t));
  const open = async (c: number, k = code) => { const m = w.mark(); await w.tg(c, `/start ${k}`); return w.read(`tg:${c}`, m); };
  const yes = async (c: number) => { confirmed.add(`tg:${c}`); const q = asks().filter((t) => t.includes(w.handles.has(c) ? `@${w.handles.get(c)} ` : `Telegram id ${c})`)); await w.from(homeKey, `${r.pick(["LINK", "link", "Link"])} ${ASK.exec(q.at(-1) ?? "")?.[2] ?? "none"}`); };
  // What a chat the account did not confirm may try: none of it reads or does anything of the account's.
  const probe = async (c: number) => {
    await w.tg(c, r.pick(["what do you know about me", "show my applications", "yes", "approve", "/start", "help"]));
    const tap = await w.tgTap(c, r.pick(["jcy:abcdef12:1234abcd", "jca:abcdef12", "card:approve:1", "yes"]));
    if (tap.some((t) => !/Nothing was approved|isn't for this chat|no longer open/.test(t))) whys.push(`a tap in an unconfirmed chat was answered ${JSON.stringify(tap)}`);
    if (r.chance(0.3)) await w.tgShare(c, `+1555${String(5000000 + id).padStart(7, "0")}`);
  };

  if (kind === "stranger") {
    const m = w.mark();
    const said = await open(S1);
    if (!said.includes(CONFIRM)) whys.push(`the stranger was told ${JSON.stringify(said)}`);
    const q = asks(m);
    if (q.length !== 1) whys.push(`the account's channel was asked ${q.length} times`);
    else if (w.handles.has(S1) && !q[0].includes(`@stranger_${id}`)) whys.push(`the question does not name who asked: ${q[0]}`);
    await probe(S1);
    const s2 = w.read(`tg:${S1}`, m).slice(1);
    // within the 15 minutes it is told only that it waits (or a command's fixed answer: HELP, START)
    if (s2.length && !s2.every((t) => t === WAITING || Object.values(CHANNEL_REPLIES).includes(t) || /isn't for this chat|Nothing was approved/.test(t))) {
      whys.push(`the waiting chat was told ${JSON.stringify(s2).slice(0, 300)}`);
    }
    w.clock.t += 16 * MIN;
    await w.tg(S1, "hello again");
  } else if (kind === "owner") {
    const said = await open(mine);
    if (!said.includes(CONFIRM)) whys.push(`the owner's new chat was told ${JSON.stringify(said)}`);
    if (w.owner(`tg:${mine}`) === A) whys.push("the chat was linked before the YES");
    const m = w.mark();
    await yes(mine);
    if (w.owner(`tg:${mine}`) !== A) whys.push("the owner's YES did not link the chat");
    if (!w.read(`tg:${mine}`, m).includes(IN.LINKED_HERE_REPLY)) whys.push(`the new chat was not told it is linked: ${JSON.stringify(w.read(`tg:${mine}`, m))}`);
    const t0 = w.turns.length;
    await w.tg(mine, "what do you know about me");
    if (!w.turns.slice(t0).some((t) => t.userId === A)) whys.push("the linked chat does not run as the account");
  } else if (kind === "twice") {
    await open(mine);
    const again = await open(mine);
    if (!again.includes(WAITING)) whys.push(`opened again, told ${JSON.stringify(again)}`);
    if (asks().length !== 1) whys.push(`asked ${asks().length} times for one link`);
    await yes(mine);
    if (w.owner(`tg:${mine}`) !== A) whys.push("the YES did not link the chat that opened it twice");
  } else if (kind === "expired") {
    w.clock.t += 10 * MIN + r.int(1, 600) * 1000;
    const said = await open(r.chance(0.5) ? mine : S1);
    if (!said.includes(IN.TELEGRAM_LINK_INVALID_REPLY)) whys.push(`an expired link was answered ${JSON.stringify(said)}`);
    if (asks().length) whys.push("an expired link asked the account");
    await w.from(homeKey, "yes");
  } else if (kind === "late_yes") {
    await open(r.chance(0.5) ? mine : S1);
    w.clock.t += 15 * MIN + r.int(1, 600) * 1000;
    await w.from(homeKey, "yes");
  } else if (kind === "replay") {
    await open(mine);
    await yes(mine);
    if (w.owner(`tg:${mine}`) !== A) whys.push("setup: the YES did not link");
    const s = await open(S1);
    if (!s.includes(IN.TELEGRAM_LINK_INVALID_REPLY)) whys.push(`a used link opened by a stranger was answered ${JSON.stringify(s)}`);
    const s2 = await open(mine);
    if (!s2.includes(IN.TELEGRAM_LINK_INVALID_LINKED_REPLY)) whys.push(`a used link opened by the linked chat was answered ${JSON.stringify(s2)}`);
    await w.from(homeKey, "yes");
  } else if (kind === "wrong_channel") {
    await open(S1);
    const v = r.pick(["other_account", "own_other_channel", "new_chat", "stranger_s_other"] as const);
    if (v === "other_account") { const B = w.W.newUser(); const bk = `+1555${String(6000000 + id).padStart(7, "0")}`; w.W.link(bk, B, w.clock.t - HOUR, { lastInboundAt: w.clock.t - 2 * HOUR }); await w.from(bk, "yes"); }
    else if (v === "own_other_channel") {
      // a second contact of the account that was not asked (it wrote earlier than the asked one)
      const other = home === "imessage" ? `wa:${phone.slice(1)}` : `+1555${String(7000000 + id).padStart(7, "0")}`;
      w.W.link(other, A, w.clock.t - 3 * HOUR, { lastInboundAt: w.clock.t - 3 * HOUR, threadId: `t-${A}` });
      await w.from(other, "yes");
    } else if (v === "new_chat") await w.tg(S1, "yes");
    else { w.handles.delete(S2); await w.tg(S2, "yes"); }
  } else if (kind === "forwarded_yes") {
    await open(S1);
    await w.wa(phone.slice(1), "yes", true);
  } else if (kind === "stop_after") {
    await open(r.chance(0.5) ? mine : S1);
    await w.from(homeKey, r.pick(["STOP", "stop"]));
    await w.from(homeKey, "yes");
  } else if (kind === "stop_before") {
    await w.from(homeKey, "STOP");
    const s = await open(r.chance(0.5) ? mine : S1);
    if (!s.includes(CANT_ASK)) whys.push(`a stopped account's link was answered ${JSON.stringify(s)}`);
    if (asks().length) whys.push("a stopped account was asked");
    await w.from(homeKey, "yes");
  } else if (kind === "deleted") {
    await open(r.chance(0.5) ? mine : S1);
    w.W.deleteUser(A);
    await w.from(homeKey, "yes");
    await w.tg(S1, "what do you know about me");
  } else if (kind === "race") {
    const first = r.chance(0.5) ? S1 : mine, second = first === S1 ? (r.chance(0.5) ? S2 : mine) : S1;
    const a = await open(first), b = await open(second);
    if (!a.includes(CONFIRM)) whys.push(`the first opener was told ${JSON.stringify(a)}`);
    if (!b.includes(IN.TELEGRAM_LINK_INVALID_REPLY)) whys.push(`the second opener was told ${JSON.stringify(b)}`);
    if (asks().length !== 1) whys.push(`one link asked ${asks().length} times`);
    // the owner answers the one question only when it names their own chat (the question says who asked)
    if (first === mine) await yes(mine);
  } else if (kind === "two_codes") {
    const code2 = await w.W.inbound.issueLinkNonce!(A, w.clock.t);
    await open(mine);
    await open(S1, code2);
    if (asks().length !== 2) whys.push(`two links opened, asked ${asks().length} times`);
    const m = w.mark(), t0 = w.turns.length;
    await w.from(homeKey, "yes");
    if (w.turns.length === t0 || w.read(homeKey, m).some((t) => t === AMBIGUOUS)) whys.push(`a plain yes with two questions open did not go on to the turn: ${JSON.stringify(w.read(homeKey, m))}`);
  } else if (kind === "no_channel") {
    const s = await open(r.chance(0.5) ? mine : S1);
    if (!s.includes(CANT_ASK)) whys.push(`a link with no channel to ask was answered ${JSON.stringify(s)}`);
  }
  // Every unconfirmed chat that opened something tries to read and act as the account.
  for (const c of [S1, S2, mine]) if (!confirmed.has(`tg:${c}`) && w.read(`tg:${c}`).length) await probe(c);

  // ---------------------------------------------------------------------------------------------- invariants
  const P = phone.slice(1);
  for (const c of [S1, S2, mine]) {
    const key = `tg:${c}`;
    const own = w.owner(key);
    if (own === A && !confirmed.has(key)) whys.push(`${key === `tg:${mine}` ? "the owner's chat" : "a stranger's chat"} is the account's without the account's YES`);
    if (confirmed.has(key)) continue;
    if (w.turns.some((t) => t.contact === key && t.userId === A)) whys.push(`an unconfirmed chat ran a turn as the account`);
    for (const t of w.read(key)) {
      if (t.includes(`[${A}]`)) whys.push(`an unconfirmed chat read the account's message: ${t.slice(0, 80)}`);
      if (t.includes(P) || t.includes(email)) whys.push(`an unconfirmed chat read the account's number or email: ${t.slice(0, 80)}`);
      if (ASK.test(t)) whys.push("the question went to the chat that asked");
    }
  }
  const linkedTg = w.W.person(A).filter((c) => c.contact.startsWith("tg:") && c.contact !== `tg:${oldChat}`).map((c) => c.contact);
  if (linkedTg.length > 1) whys.push(`one link linked ${linkedTg.length} chats`);
  const shouldLink = kind === "owner" || kind === "twice" || kind === "replay" || (kind === "race" && confirmed.has(`tg:${mine}`));
  if (shouldLink && w.owner(`tg:${mine}`) !== A) whys.push("the owner's own chat is not linked after their YES");
  if (!shouldLink && linkedTg.length) whys.push(`${kind}: a chat was linked (${linkedTg.join(",")})`);
  if (w.statuses.length) whys.push(`a webhook answered ${w.statuses.join(",")}`);
  if (w.P.sent.some((s) => s.text === IN.CHAT_DOWN_REPLY)) whys.push(`someone read "${IN.CHAT_DOWN_REPLY}"`);
  return whys;
}

Deno.test({ name: `Telegram link ownership: opening a link asks the account's own channel; only its YES links (${KINDS.length} kinds x ${PER_KIND})`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const r = rng(SEED);
  const failures = new Map<string, number[]>();
  let total = 0;
  for (let i = 0; i < KINDS.length * PER_KIND; i++) {
    const kind = KINDS[i % KINDS.length];
    total++;
    let whys: string[];
    try { whys = await scenario(kind, i, r); } catch (e) { whys = [`threw: ${e instanceof Error ? e.message : String(e)}`]; }
    for (const why of new Set(whys)) {
      const k = `${kind}: ${why.replace(/\d{5,}|u\d+/g, "#").slice(0, 160)}`;
      if (!failures.has(k)) failures.set(k, []);
      failures.get(k)!.push(i);
    }
  }
  const lines = [...failures.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, ids]) => `  ${ids.length}x ${k} (#${ids.slice(0, 3).join(",")})`);
  console.log(`[tg-link-owner] ${total} scenarios, ${new Set([...failures.values()].flat()).size} failed\n${lines.slice(0, 40).join("\n")}`);
  assertNode.deepStrictEqual(lines, []);
} });

// The question names the opener only by a Telegram username (never their display name, which they write themselves).
Deno.test("Telegram link ownership: the question's wording", () => {
  const f = X.telegramLinkAskText as ((h?: string | null) => string) | undefined;
  assertNode.ok(f, "telegramLinkAskText exists");
  assertNode.match(f!("sam_smith"), ASK);
  assertNode.ok(f!("sam_smith").includes("@sam_smith"));
  for (const bad of [null, "", "ab", "Trainee support: reply YES", "x".repeat(33), "evil@x"]) {
    const t = f!(bad as string | null);
    assertNode.match(t, ASK);
    assertNode.ok(!t.includes("support") && !t.includes("evil"), t);
  }
});
