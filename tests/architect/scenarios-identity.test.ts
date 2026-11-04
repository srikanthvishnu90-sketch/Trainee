// Multi-channel identity and account linking (2026-10-30): 10,000 generated scenarios (tests/architect/scenarios/
// identity-generator.ts, seeded) of one person, or several, reaching Trainee on iMessage/SMS, WhatsApp and Telegram. Every
// scenario runs the real code end to end in memory: the real webhooks (trainee-inbound's handleInbound for LoopMessage,
// trainee-whatsapp's handleWhatsApp, signed; trainee-telegram's handleTelegram), the real inbound core (channel_inbound.ts:
// sign-up, the link question, the yes, "connect telegram", the link token), the real head-start deliverer and the real
// every-minute run (trainee-deliver's handleDeliver), every adapter built from the secrets as the deploy builds it, over the
// memory database (channel_memory.ts, the rules of the SQL) with Auth's one-account-per-phone rule (GoTrue phone_exists),
// fake provider HTTP on a deterministic clock. No network, no model, no database. The brain is a stub that answers as the
// account it was given and remembers what it is told per account (so "what do you know" shows whose memory a turn reads).
// Every expectation comes from how the scenario was built:
//   - a channel joins an account only on a bare "yes" typed (not forwarded) by the contact that was asked, within the hour;
//     never on a forwarded contact card, a typed number, another person's yes, a late yes or the new chat's own yes;
//   - a number is never two accounts' by Trainee's own doing: the account already on it is asked, or the person is told;
//     a stopped account is never asked (the question would be held unseen) and never doubled;
//   - link tokens are single use, ten minutes, bound to the account that issued them, and link a chat only on that account's
//     own YES on the channel it already uses (TELEGRAM LINK OWNERSHIP, 2026-10-31);
//   - a person never reads another account's message, and no turn runs as anyone but the contact's owner;
//   - a recycled number gets a fresh account; a deleted account comes back fresh; a refusal is said, never silence;
//   - STOP is the person's (WO-038): a STOP on any channel holds what Trainee starts everywhere, an answer to a message
//     sent after it still goes where it was asked, START anywhere turns all back on; the home channel is the one set, else
//     the last written on;
//   - after a link every channel runs as one account in one thread.
// Run: deno test -A --no-check tests/architect/scenarios-identity.test.ts (ID_ONLY=<id,...> runs only those scenarios).
import assertNode from "node:assert/strict";
import { type Answer, type Ch, generate, HOUR, MIN, type Scenario, type Signup, T0 } from "./scenarios/identity-generator.ts";
import { memoryChannelWorld } from "../../supabase/functions/_shared/channel_memory.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { type Channel, channelOf } from "../../supabase/functions/_shared/channel_adapters.ts";
import { CHANNEL_REPLIES, deliverDue } from "../../supabase/functions/_shared/channel.ts";
import * as IN from "../../supabase/functions/_shared/channel_inbound.ts";
import { loopSend } from "../../supabase/functions/_shared/loopmessage.ts";
import { whatsappAdapter, whatsappSignature } from "../../supabase/functions/_shared/whatsapp.ts";
import { telegramAdapter } from "../../supabase/functions/_shared/telegram.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";
import { handleInbound } from "../../supabase/functions/trainee-inbound/handler.ts";
import { handleWhatsApp } from "../../supabase/functions/trainee-whatsapp/handler.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SCENARIOS = generate({ seed: 20261030 });
const ONLY = (() => { try { return new Set((Deno.env.get("ID_ONLY") ?? "").split(",").filter(Boolean).map(Number)); } catch { return new Set<number>(); } })();
const of = <K extends Scenario["kind"]>(k: K) => SCENARIOS.filter((s): s is Extract<Scenario, { kind: K }> => s.kind === k && (!ONLY.size || ONLY.has(s.id)));
// Secrets made at run time (no key-shaped string in a tracked file).
const mk = (p: string, n: number) => `${p}${"x".repeat(n)}`;
const TG_TOKEN = `${7000 + 2}:${mk("TeSt", 31)}`, TG_SECRET = mk("tgsecret_", 32), WA_APP = mk("app", 32), WA_VERIFY = mk("verify", 32);
const LM_KEY = mk("loop", 20), IN_SECRET = mk("insecret", 32), DELIVER_SECRET = mk("deliver", 32), WA_TOKEN = mk("watoken", 20);
// What the product says (read from the module, so a reply a version lacks shows as its name, not a crash).
const say = {
  stopped: (c: Channel) => (IN as any).linkStoppedReply?.(c) ?? `<linkStoppedReply ${c}>`,
  taken: (IN as any).PHONE_TAKEN_REPLY ?? "<PHONE_TAKEN_REPLY>",
};

// ------------------------------------------------------------------------------------------------ the report
type Failure = { s: Scenario; why: string; got: string };
class Report {
  total = 0; byCat: Record<string, number> = {}; failures = new Map<string, Failure[]>();
  constructor(public name: string) {}
  grade(s: Scenario, whys: string[], got = "") {
    this.total++;
    const k = s.category.split("/").slice(0, 2).join("/");
    this.byCat[k] = (this.byCat[k] ?? 0) + 1;
    for (const why of [...new Set(whys)].slice(0, 3)) {
      const key = `${s.category.split("/").slice(0, 3).join("/")}: ${why.replace(/\d{4,}|u\d+|t-u\d+/g, "#").slice(0, 110)}`;
      if (!this.failures.has(key)) this.failures.set(key, []);
      this.failures.get(key)!.push({ s, why, got });
    }
  }
  assertClean() {
    const failed = new Set([...this.failures.values()].flat().map((f) => f.s.id)).size;
    const lines = [`[identity] ${this.name}: ${this.total} scenarios (${Object.entries(this.byCat).map(([k, v]) => `${k} ${v}`).join(", ")}), ${failed} failed`];
    for (const [k, xs] of [...this.failures.entries()].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(`  FAIL ${k}: ${xs.length}`);
      for (const x of xs.slice(0, 2)) lines.push(`    #${x.s.id} ${x.s.category}: ${x.why.slice(0, 300)} | got ${x.got.slice(0, 400)}`);
    }
    console.log(lines.join("\n"));
    eq(failed, 0, `${this.name}: ${failed} scenarios failed: ${[...this.failures.keys()].slice(0, 6).join(" || ")}`);
  }
}

// ------------------------------------------------------------------------------------------------ fake providers
type Prov = "telegram" | "whatsapp" | "loopmessage";
type Sent = { prov: Prov; to: string; text: string; t: number };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
function providers(clock: { t: number }) {
  const sent: Sent[] = [], keyboards: { to: string; markup: any }[] = [];
  let seq = 0;
  const P = {
    sent, keyboards, onSend: null as null | ((s: Sent) => Promise<void>),
    fetch: (async (input: Request | URL | string, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const b = init?.body ? JSON.parse(String(init.body)) : {};
      let s: Sent | null = null;
      if (u.host === "api.telegram.org") {
        const method = u.pathname.split("/").pop();
        if (method !== "sendMessage") return json({ ok: true, result: method === "sendChatAction" ? true : { message_id: ++seq } });
        s = { prov: "telegram", to: String(b.chat_id), text: String(b.text), t: clock.t };
        if (b.reply_markup) keyboards.push({ to: s.to, markup: b.reply_markup });
      } else if (u.host === "graph.facebook.com") {
        if (b.status === "read") return json({ success: true });
        if (b.type === "template") return json({ messages: [{ id: `wamid.t${++seq}` }] });
        s = { prov: "whatsapp", to: String(b.to ?? b.recipient ?? ""), text: String(b.text?.body ?? ""), t: clock.t };
      } else if (u.host === "a.loopmessage.com") {
        s = { prov: "loopmessage", to: String(b.contact), text: String(b.text), t: clock.t };
      } else throw new TypeError(`network refused: ${u.host}`);
      sent.push(s);
      if (P.onSend) { const h = P.onSend; await h(s); }
      return s.prov === "telegram" ? json({ ok: true, result: { message_id: ++seq } }) : s.prov === "whatsapp" ? json({ messages: [{ id: `wamid.${++seq}` }] }) : json({ message_id: `lm-${++seq}`, success: true });
    }) as typeof fetch,
  };
  return P;
}
const keyOfSent = (s: Sent) => (s.prov === "telegram" ? `tg:${s.to}` : s.prov === "whatsapp" ? `wa:${s.to}` : s.to);

// ------------------------------------------------------------------------------------------------ one world
type Turn = { contact: string; userId: string; threadId: string | null; message: string };
function world(o: { signup: Signup | "closed"; allow?: string[]; env?: Record<string, string | undefined> }) {
  const W = memoryChannelWorld();
  const clock = { t: T0 };
  const P = providers(clock);
  const vars: Record<string, string | undefined> = {
    TRAINEE_DELIVER_SECRET: DELIVER_SECRET, TRAINEE_INBOUND_SECRET: IN_SECRET, LOOPMESSAGE_API_KEY: LM_KEY, TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_WEBHOOK_SECRET: TG_SECRET,
    TELEGRAM_BOT_USERNAME: "TraineeTestBot", WHATSAPP_TOKEN: WA_TOKEN, WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_APP_SECRET: WA_APP, WHATSAPP_VERIFY_TOKEN: WA_VERIFY,
    TRAINEE_SIGNUP: o.signup === "open" ? "open" : "closed", TRAINEE_ALLOWED_CONTACTS: (o.allow ?? []).join(","), ...o.env,
  };
  const env = { get: (k: string) => vars[k] || undefined };
  const sleep = async (ms: number) => { clock.t += ms; };
  // Auth: one account per phone (GoTrue phone_exists, 422), as trainee-inbound/store.ts meets it.
  const authPhone = new Map<string, string>(), created: { contact: string; userId: string }[] = [];
  const store: IN.InboundStore = {
    ...W.inbound,
    async createPerson(contact, at, phone) {
      const tel = contact.startsWith("+") ? contact : phone ?? null;
      if (tel && authPhone.has(tel)) throw Object.assign(new Error("create an account for a new contact: Phone number already registered by another user"), { code: "phone_taken" });
      const p = await W.inbound.createPerson(contact, at, phone);
      if (tel) authPhone.set(tel, p.userId);
      created.push({ contact, userId: p.userId });
      return p;
    },
  };
  // The brain: answers as the account it was given; remembers per account what it is told ("remember ...").
  const turns: Turn[] = [], facts = new Map<string, string[]>();
  let cur = "";
  const hooks: { beforeTurn: null | ((t: Turn) => Promise<void>) } = { beforeTurn: null };
  const chat = async (a: any) => {
    const t: Turn = { contact: cur, userId: a.userId, threadId: a.threadId ?? null, message: a.message };
    turns.push(t);
    if (hooks.beforeTurn) { const h = hooks.beforeTurn; hooks.beforeTurn = null; await h(t); }
    const m = /^remember (.+)$/.exec(a.message);
    let reply: string;
    if (m) { facts.set(a.userId, [...(facts.get(a.userId) ?? []), m[1]]); reply = `[${a.userId}] noted`; }
    else if (/^what do you know/.test(a.message)) reply = `[${a.userId}] I know: ${(facts.get(a.userId) ?? []).join("; ") || "nothing"}`;
    else reply = `[${a.userId}] ${a.message} answered`;
    return { status: 200, threadId: a.threadId ?? `t-${a.userId}`, reply } as any;
  };
  const adapters = () => adaptersFromEnv(env, { fetch: P.fetch, clock: () => clock.t, sleep });
  const head = async (a: { userId: string; key?: string; now: number; wholeUser?: boolean }) => {
    const s = W.delivery(a.wholeUser ? { user: a.userId } : { only: { userId: a.userId, key: a.key! } });
    const r = await deliverDue({ store: s, adapters: adapters(), now: a.now, limit: a.wholeUser ? 40 : 1 });
    await s.release();
    return r;
  };
  const statuses: number[] = [];
  const run = async () => {
    const res = await handleDeliver(new Request("https://fn.test/trainee-deliver", { method: "POST", headers: { "x-trainee-deliver-secret": DELIVER_SECRET } }), {
      env, now: () => clock.t, store: () => W.delivery(), send: (k) => loopSend({ apiKey: k, fetch: P.fetch, sleep }),
      adapters: (e) => adaptersFromEnv(e, { fetch: P.fetch, clock: () => clock.t, sleep }), recordRun: async () => {},
    });
    const body = await res.json();
    if (res.status !== 200) statuses.push(res.status);
    return body;
  };
  // Every contact's owners over the scenario (a person may lose a contact: a Telegram unlink, a recycled number).
  const ever = new Map<string, Set<string>>();
  const snap = () => { for (const c of W.contacts.values()) if (c.userId) { if (!ever.has(c.contact)) ever.set(c.contact, new Set()); ever.get(c.contact)!.add(c.userId); } };
  const after = async (res: Response) => { const body = await res.json().catch(() => null); if (res.status !== 200) statuses.push(res.status); snap(); return body; };
  const waAdapter = (e: { get(k: string): string | undefined }) => whatsappAdapter({ token: e.get("WHATSAPP_TOKEN") || "", phoneNumberId: "1", appSecret: WA_APP, verifyToken: WA_VERIFY, fetch: P.fetch, clock: () => clock.t, sleep });
  const tgAdapter = (e: { get(k: string): string | undefined }) => telegramAdapter({ token: e.get("TELEGRAM_BOT_TOKEN") || "", webhookSecret: TG_SECRET, fetch: P.fetch, clock: () => clock.t, sleep });
  let mid = 0, upd = 0;
  const lm = async (from: string, text: string) => {
    cur = from;
    return await after(await handleInbound(new Request(`https://fn.test/trainee-inbound?secret=${IN_SECRET}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ alert_type: "message_inbound", message_id: `lm-in-${++mid}`, recipient: from, text }) }), {
      env, now: () => clock.t, store: () => store, send: (k) => loopSend({ apiKey: k, fetch: P.fetch, sleep }), chat, deliverReply: (a) => head({ userId: a.userId, key: a.key, now: a.now }),
    }));
  };
  const wa = async (a: { from?: string | null; bsuid?: string | null; text?: string; forwarded?: boolean; type?: string; extra?: Record<string, unknown> }) => {
    cur = a.from ? `wa:${a.from}` : `wa:${a.bsuid}`;
    const type = a.type ?? "text";
    const m: Record<string, unknown> = { id: `wamid.in${++mid}`, timestamp: String(Math.floor(clock.t / 1000)), type, ...(a.from ? { from: a.from } : {}), ...(a.bsuid ? { from_user_id: a.bsuid } : {}),
      ...(type === "text" ? { text: { body: a.text ?? "hi" } } : {}), ...(a.forwarded ? { context: { forwarded: true } } : {}), ...a.extra };
    const raw = new TextEncoder().encode(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "1" },
      contacts: [{ profile: { name: "T" }, ...(a.from ? { wa_id: a.from } : {}), ...(a.bsuid ? { user_id: a.bsuid } : {}) }], messages: [m] } }] }] }));
    const req = new Request("https://fn.test/trainee-whatsapp", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": await whatsappSignature(WA_APP, raw) }, body: raw });
    return await after(await handleWhatsApp(req, { env, now: () => clock.t, store: () => store, chat, deliver: (x) => head({ userId: x.userId, now: x.now, wholeUser: true }), adapter: waAdapter }));
  };
  const tgPost = async (chatId: number, message: Record<string, unknown>) => {
    cur = `tg:${chatId}`;
    const req = new Request("https://fn.test/trainee-telegram", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TG_SECRET },
      body: JSON.stringify({ update_id: ++upd, message: { message_id: ++mid, chat: { id: chatId, type: "private" }, from: { id: chatId, is_bot: false, first_name: "T" }, date: Math.floor(clock.t / 1000), ...message } }) });
    return await after(await handleTelegram(req, { env, now: () => clock.t, store: () => store, chat, deliver: (a) => head({ userId: a.userId, key: a.key, now: a.now }), adapter: tgAdapter }));
  };
  const tg = async (chatId: number, text: string, o: { forwarded?: boolean } = {}) =>
    await tgPost(chatId, { text, ...(o.forwarded ? { forward_origin: { type: "user", sender_user: { id: 4242, is_bot: false, first_name: "F" }, date: 1 }, forward_date: 1 } : {}) });
  const tgShare = async (chatId: number, phone: string, cardOf = chatId) => await tgPost(chatId, { contact: { phone_number: phone.replace("+", ""), user_id: cardOf, first_name: "T" } });
  // A message from a contact key, on its channel.
  const from = async (key: string, text: string, o: { forwarded?: boolean } = {}) => {
    if (key.startsWith("tg:")) return await tg(Number(key.slice(3)), text, o);
    if (key.startsWith("wa:")) { const id = key.slice(3); return /^[0-9]+$/.test(id) ? await wa({ from: id, text, forwarded: o.forwarded }) : await wa({ bsuid: id, text, forwarded: o.forwarded }); }
    return await lm(key, text);
  };
  // A person already known (seeded): contacts and, when the account signed up with a number, Auth's phone.
  const seed = (contacts: { c: string; at?: number; phone?: string | null; alias?: string | null; home?: boolean }[], tel?: string | null) => {
    const u = W.newUser();
    for (const x of contacts) {
      const phone = x.phone !== undefined ? x.phone : x.c.startsWith("+") ? x.c : /^wa:[0-9]{8,15}$/.test(x.c) ? `+${x.c.slice(3)}` : null;
      W.link(x.c, u, (x.at ?? clock.t - HOUR) - HOUR, { lastInboundAt: x.at ?? clock.t - HOUR, home: !!x.home, alias: x.alias ?? null, phone, threadId: `t-${u}` });
    }
    if (tel) authPhone.set(tel, u);
    snap();
    return u;
  };
  const owner = (key: string) => W.contacts.get(key)?.userId ?? null;
  const mark = () => P.sent.length;
  const read = (key: string, since = 0) => P.sent.slice(since).filter((s) => keyOfSent(s) === key).map((s) => s.text);
  const deleteUser = (u: string) => { W.deleteUser(u); for (const [p, v] of authPhone) if (v === u) authPhone.delete(p); };
  // What every scenario must hold: nobody reads a message tagged for another account; every turn runs as its contact's owner;
  // every webhook and run answered 200.
  const common = (): string[] => {
    const whys: string[] = [];
    for (const s of P.sent) {
      const m = /^\[(u\d+)\]/.exec(s.text);
      if (m && !ever.get(keyOfSent(s))?.has(m[1])) whys.push(`${keyOfSent(s)} read ${m[1]}'s message: ${s.text.slice(0, 60)}`);
    }
    for (const t of turns) {
      const own = ever.get(t.contact);
      if (!own?.has(t.userId)) whys.push(`a turn from ${t.contact} ran as ${t.userId} (owners ${[...own ?? []].join(",") || "none"})`);
    }
    if (statuses.length) whys.push(`a webhook or run answered ${statuses.join(",")}`);
    if (P.sent.some((s) => s.text === IN.CHAT_DOWN_REPLY)) whys.push(`someone read "${IN.CHAT_DOWN_REPLY}"`);
    return whys;
  };
  return { W, clock, P, vars, store, authPhone, created, turns, facts, hooks, run, head, lm, wa, tg, tgShare, tgPost, from, seed, owner, mark, read, deleteUser, common, snap, ever };
}
type World = ReturnType<typeof world>;
const phoneOf = (n: number, base = 2000000) => `+1555${String(base + n).padStart(7, "0")}`;
const keyFor = (c: Ch, phone: string, chatId: number) => (c === "imessage" ? phone : c === "whatsapp" ? `wa:${phone.slice(1)}` : `tg:${chatId}`);
const YESISH = (t: string) => /^yes[.!]*$/i.test(t.trim());
const asksIn = (w: World, since: number) => w.P.sent.slice(since).filter((s) => /^Someone texted Trainee on (iMessage|WhatsApp|Telegram) from your number\. Reply yes to link it\.$/.test(s.text));

// ================================================================================================ link/chain
Deno.test({ name: `identity: one number on two or three channels, linked only on the asked contact's typed yes within the hour (link/chain): ${of("chain").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("link/chain");
  for (const s of of("chain")) {
    const P = phoneOf(s.id), chatId = 900000 + s.id, key = (c: Ch) => keyFor(c, P, chatId);
    const first = s.order[0];
    const allow = s.signup === "open" ? [] : s.signup === "allow_phone" ? [P, `telegram:${chatId}`] : [first === "imessage" ? P : first === "whatsapp" ? `whatsapp:${P.slice(1)}` : `telegram:${chatId}`];
    const w = world({ signup: s.signup, allow });
    const whys: string[] = [];
    const allowed = (c: Ch, _viaShare: boolean) => s.signup !== "closed" || c === first;
    // The oracle: accounts, the channels each holds, and those that carry the number.
    type Acc = { userId: string; chans: Set<Ch>; phoneOn: Set<Ch> };
    const accounts: Acc[] = [];
    const want = new Map<Ch, string | null>();
    for (let i = 0; i < s.order.length; i++) {
      const c = s.order[i], viaShare = c === "telegram" && !(i === 0 && s.tgFirstVia === "start");
      const candidate = viaShare || c !== "telegram" ? accounts.find((a) => [...a.phoneOn].some((x) => x !== c)) : undefined;
      const m0 = w.mark();
      if (c === "imessage") await w.lm(P, "hi from imessage");
      else if (c === "whatsapp") await w.wa({ from: P.slice(1), text: "hi from whatsapp" });
      else if (viaShare) await w.tgShare(chatId, P);
      else await w.tg(chatId, "/start");
      if (!candidate) {
        if (allowed(c, viaShare)) {
          const u = w.owner(key(c));
          if (!u || accounts.some((a) => a.userId === u)) { whys.push(`${c} (no account on the number to ask) should sign up afresh, owner ${u}`); want.set(c, u); continue; }
          accounts.push({ userId: u, chans: new Set([c]), phoneOn: new Set(c !== "telegram" || viaShare ? [c] : []) });
          want.set(c, u);
          if (!w.turns.some((t) => t.userId === u)) whys.push(`${c}: the first message ran no turn`);
        } else {
          want.set(c, null);
          if (w.owner(key(c))) whys.push(`${c}: signed up although sign-up is closed to it`);
          if (!w.read(key(c), m0).includes(IN.SIGNUP_CLOSED_REPLY)) whys.push(`${c}: not told sign-up is closed: ${JSON.stringify(w.read(key(c), m0))}`);
        }
        continue;
      }
      // The number's account is asked on one of its contacts that carries the number; the new chat is told where.
      const asks = asksIn(w, m0);
      const askedKey = asks.length === 1 ? keyOfSent(asks[0]) : null;
      if (asks.length !== 1) { whys.push(`${c}: ${asks.length} questions asked (want 1): ${JSON.stringify(w.P.sent.slice(m0).map((x) => [keyOfSent(x), x.text.slice(0, 50)]))}`); want.set(c, null); break; }
      const askedCh = channelOf(askedKey!) as Ch;
      if (!candidate.phoneOn.has(askedCh) || w.owner(askedKey!) !== candidate.userId || askedCh === c) whys.push(`${c}: asked ${askedKey}, not a contact of the number's account that carries it`);
      if (asks[0].text !== IN.linkAskText(c)) whys.push(`${c}: the question's words: ${asks[0].text}`);
      if (!w.read(key(c), m0).includes(IN.linkPendingReply(askedCh))) whys.push(`${c}: the new chat was not told where to answer: ${JSON.stringify(w.read(key(c), m0))}`);
      if (w.owner(key(c))) whys.push(`${c}: linked before any yes`);
      // The answer.
      let a: Answer = s.answers[i - 1];
      const others = [...candidate.chans].filter((x) => x !== askedCh).map(key);
      if (a === "wrong_channel" && !others.length) a = "none";
      if (a === "forwarded" && askedCh === "imessage") a = "none";
      w.clock.t += s.delayMin[i - 1] * MIN;
      const m1 = w.mark(), turnsBefore = w.turns.length;
      let linked = false;
      if (a === "yes") { await w.from(askedKey!, s.yesWord); linked = true; }
      else if (a === "late") await w.from(askedKey!, s.yesWord);
      else if (a === "wrong_channel") await w.from(others[0], s.yesWord);
      else if (a === "forwarded") await w.from(askedKey!, "yes", { forwarded: true });
      else if (a === "from_new") await w.from(key(c), "yes");
      else if (a === "stranger") {
        const sk = askedCh === "imessage" ? phoneOf(s.id, 5000000) : askedCh === "whatsapp" ? `wa:${phoneOf(s.id, 5000000).slice(1)}` : `tg:${700000 + s.id}`;
        const su = w.seed([{ c: sk }]);
        await w.from(sk, "yes");
        if (w.turns.at(-1)?.userId !== su) whys.push(`stranger's yes did not run as the stranger`);
      } else if (a === "not_yes") await w.from(askedKey!, s.notYes);
      else if (a === "other_then_yes") { await w.from(askedKey!, "find me data analyst jobs"); w.clock.t += 1000; await w.from(askedKey!, "yes"); linked = true; }
      await w.run();
      const got = w.owner(key(c));
      if (linked) {
        if (got !== candidate.userId) whys.push(`${a}: a typed yes from the asked contact within the hour did not link ${c} (owner ${got})`);
        else {
          candidate.chans.add(c); if (c !== "telegram" || viaShare) candidate.phoneOn.add(c);
          if (!w.read(askedKey!, m1).includes(IN.linkedReply(c))) whys.push(`${a}: the asked contact was not told: ${JSON.stringify(w.read(askedKey!, m1))}`);
          if (!w.read(key(c), m1).includes(IN.LINKED_HERE_REPLY)) whys.push(`${a}: the new chat was not told it is linked: ${JSON.stringify(w.read(key(c), m1))}`);
        }
      } else {
        if (got) whys.push(`${a}: ${c} linked to ${got} without a typed yes from the asked contact within the hour`);
        // A word that is not a yes, a late yes, a yes elsewhere: an ordinary message for the person who sent it.
        if (["late", "wrong_channel", "not_yes", "forwarded"].includes(a) && w.turns.length === turnsBefore) whys.push(`${a}: the message ran no turn`);
        if (a === "from_new" && w.turns.length !== turnsBefore) whys.push(`from_new: the unlinked chat's yes ran a turn`);
      }
      want.set(c, linked ? candidate.userId : null);
      // The new chat writes again.
      if (a !== "late") {
        const m2 = w.mark(), t2 = w.turns.length;
        await w.from(key(c), `hello again from ${c}`);
        if (linked) {
          const t = w.turns.at(-1);
          if (w.turns.length !== t2 + 1 || t?.userId !== candidate.userId) whys.push(`linked ${c}: its message did not run as the account`);
          else if (t.threadId !== `t-${candidate.userId}`) whys.push(`linked ${c}: its turn ran in thread ${t.threadId}, not the account's one thread`);
        } else {
          if (w.turns.length !== t2) whys.push(`${a}: the waiting ${c} chat's message ran a turn as ${w.turns.at(-1)?.userId}`);
          if (w.owner(key(c))) whys.push(`${a}: the waiting ${c} chat's message made it an account (${w.owner(key(c))})`);
          if (c === "telegram" && !w.read(key(c), m2).includes(IN.linkPendingReply(askedCh))) whys.push(`${a}: the waiting Telegram chat was not told where the yes goes: ${JSON.stringify(w.read(key(c), m2))}`);
        }
      }
    }
    for (const [c, u] of want) if (w.owner(key(c)) !== u) whys.push(`at the end ${c} is ${w.owner(key(c))}'s, want ${u}`);
    const owners = new Set(s.order.map((c) => w.owner(key(c))).filter(Boolean));
    if (owners.size > accounts.length) whys.push(`${owners.size} accounts hold the person's contacts, ${accounts.length} expected`);
    whys.push(...w.common());
    rep.grade(s, whys, JSON.stringify(s.order.map((c) => [c, w.owner(key(c))])));
  }
  rep.assertClean();
} });

// ================================================================================================ link/stopped
Deno.test({ name: `identity: the number's account said STOP: never doubled, never asked unseen, said plainly; START, then asked (link/stopped): ${of("stopped").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("link/stopped");
  for (const s of of("stopped")) {
    const P = phoneOf(s.id, 3000000), chatId = 910000 + s.id, key = (c: Ch) => keyFor(c, P, chatId);
    const w = world({ signup: s.signup, allow: s.signup === "allow_phone" ? [P] : [] });
    const whys: string[] = [];
    const A = w.seed([{ c: key(s.first) }], P);
    await w.from(key(s.first), "STOP");
    const arrive = async () => s.second === "telegram" ? await w.tgShare(chatId, P) : s.second === "imessage" ? await w.lm(P, "hi") : await w.wa({ from: P.slice(1), text: "hi" });
    const m0 = w.mark(), accounts0 = w.created.length;
    w.clock.t += MIN;
    await arrive();
    await w.run();
    if (w.created.length !== accounts0 || w.owner(key(s.second))) whys.push(`a stopped number signed up again or linked (${w.owner(key(s.second))})`);
    if (asksIn(w, m0).length) whys.push("a question was sent to a stopped account");
    if (w.W.outbox.some((r) => r.userId === A && r.kind === "link")) whys.push("a question was queued where STOP holds it unseen");
    if (!w.read(key(s.second), m0).includes(say.stopped(s.first))) whys.push(`the new chat was not told plainly: ${JSON.stringify(w.read(key(s.second), m0))}`);
    if (s.thenStart) {
      w.clock.t += MIN;
      await w.from(s.startOn === "first" ? key(s.first) : key(s.second), "START");
      w.clock.t += MIN;
      const m1 = w.mark();
      await arrive();
      await w.run();
      const asks = asksIn(w, m1);
      if (s.startOn === "first") {
        if (asks.length !== 1 || keyOfSent(asks[0]) !== key(s.first)) whys.push(`after START on ${s.first}, the next message asked ${asks.length} times`);
        else {
          w.clock.t += MIN;
          await w.from(key(s.first), "yes");
          await w.run();
          if (w.owner(key(s.second)) !== A) whys.push("after START and a yes, not linked");
        }
      } else {
        if (asks.length || w.owner(key(s.second))) whys.push("START from the unlinked chat restarted someone else's account");
        if (!w.read(key(s.second), m1).includes(say.stopped(s.first))) whys.push(`still stopped: not told again: ${JSON.stringify(w.read(key(s.second), m1))}`);
      }
    }
    if (w.created.length !== accounts0) whys.push(`${w.created.length - accounts0} accounts made for a number that has one`);
    whys.push(...w.common());
    rep.grade(s, whys, JSON.stringify(w.P.sent.slice(-4).map((x) => [keyOfSent(x), x.text.slice(0, 80)])));
  }
  rep.assertClean();
} });

// ================================================================================================ link/two
Deno.test({ name: `identity: one number on two accounts: a third channel joins at most one, on that one's yes; they never merge (link/two): ${of("two").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("link/two");
  for (const s of of("two")) {
    const P = phoneOf(s.id, 4000000), chatId = 920000 + s.id;
    const w = world({ signup: "open" });
    const whys: string[] = [];
    // A carries the number on iMessage (or on Telegram, by its own share); B on a WhatsApp business-scoped id that later gave it.
    const aKey = s.third === "telegram" ? P : `tg:${chatId}`, bKey = `wa:US.b${s.id}`;
    const A = w.seed([{ c: aKey, phone: P, at: T0 - (s.id % 2 ? 2 : 3) * HOUR }], P);
    const B = w.seed([{ c: bKey, phone: P, at: T0 - (s.id % 2 ? 3 : 2) * HOUR }]);
    if (s.stopA) await w.from(aKey, "STOP");
    if (s.stopB) await w.from(bKey, "STOP");
    const thirdKey = s.third === "telegram" ? `tg:${chatId}` : P;
    const m0 = w.mark(), made = w.created.length;
    if (s.third === "telegram") await w.tgShare(chatId, P); else await w.lm(P, "hi");
    await w.run();
    const asks = asksIn(w, m0);
    if (s.stopA && s.stopB) {
      if (asks.length) whys.push("both accounts stopped, and one was asked");
      if (!w.read(thirdKey, m0).some((t) => /it's stopped there/.test(t)) && !w.read(thirdKey, m0).includes(say.stopped(channelOf(aKey))) && !w.read(thirdKey, m0).includes(say.stopped("whatsapp"))) whys.push(`not told: ${JSON.stringify(w.read(thirdKey, m0))}`);
    } else {
      if (asks.length !== 1) whys.push(`${asks.length} questions`);
      const askedKey = asks[0] ? keyOfSent(asks[0]) : null;
      const askedOwner = askedKey ? w.owner(askedKey) : null;
      if (askedOwner === A && s.stopA || askedOwner === B && s.stopB) whys.push("a stopped account was asked while another was not stopped");
      const yesFrom = s.answerBy === "a" ? [aKey] : s.answerBy === "b" ? [bKey] : s.answerBy === "both" ? [aKey, bKey] : [];
      for (const k of yesFrom) { w.clock.t += MIN; await w.from(k, "yes"); }
      await w.run();
      const got = w.owner(thirdKey);
      const wantOwner = askedKey && yesFrom.includes(askedKey) ? askedOwner : null;
      if (got !== wantOwner) whys.push(`the third channel is ${got}'s, want ${wantOwner} (asked ${askedKey}, yes from ${yesFrom.join(",") || "nobody"})`);
    }
    if (w.owner(aKey) !== A || w.owner(bKey) !== B) whys.push("A's or B's own contact changed hands");
    if (w.W.person(A).some((c) => c.contact === bKey) || w.W.person(B).some((c) => c.contact === aKey)) whys.push("the two accounts merged");
    if (w.created.length !== made) whys.push("a third account was made for the number");
    whys.push(...w.common());
    rep.grade(s, whys, JSON.stringify(w.P.sent.slice(m0).map((x) => [keyOfSent(x), x.text.slice(0, 60)])));
  }
  rep.assertClean();
} });

// ================================================================================================ link/taken
Deno.test({ name: `identity: the number is already an account's sign-in phone with no channel to ask: no second account, said once (link/taken): ${of("taken").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("link/taken");
  for (const s of of("taken")) {
    const P = phoneOf(s.id, 6000000), chatId = 930000 + s.id, k = keyFor(s.channel, P, chatId);
    const w = world({ signup: s.signup, allow: s.signup === "allow_phone" ? [P] : [] });
    const whys: string[] = [];
    const web = w.W.newUser(); w.authPhone.set(P, web); // signed up on the web with the number, no texting channel yet
    const m0 = w.mark();
    for (let i = 0; i < s.times; i++) { w.clock.t += MIN; if (s.channel === "telegram") await w.tgShare(chatId, P); else await w.from(k, `hello ${i}`); }
    await w.run();
    if (w.created.length || w.owner(k)) whys.push(`an account was made for a number that is already ${web}'s`);
    const told = w.read(k, m0).filter((t) => t === say.taken).length;
    const wantTold = s.channel === "telegram" ? s.times : 1; // a tap on the share button is answered every time; a text once
    if (told !== wantTold) whys.push(`told ${told} times, want ${wantTold}: ${JSON.stringify(w.read(k, m0))}`);
    if (w.turns.length) whys.push("a turn ran");
    whys.push(...w.common());
    rep.grade(s, whys, JSON.stringify(w.read(k, m0)).slice(0, 300));
  }
  rep.assertClean();
} });

// ================================================================================================ link/card
Deno.test({ name: `identity: a forwarded contact card or a typed number never links, never signs up, never asks (link/card): ${of("card").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("link/card");
  for (const s of of("card")) {
    const Q = phoneOf(s.id, 7000000), chatId = 940000 + s.id, waAddr = phoneOf(s.id, 7100000).slice(1);
    const w = world({ signup: s.signup, allow: s.how === "tg_card_allowed" || s.signup === "allow_phone" ? [Q] : [] });
    const whys: string[] = [];
    const A = s.how === "tg_card_owned" || s.how === "wa_contacts" || s.how === "typed_number" ? w.seed([{ c: Q }], Q) : null;
    const B = s.fromKnown ? w.seed([{ c: s.how === "wa_contacts" ? `wa:${waAddr}` : `tg:${chatId}` }]) : null;
    const k = s.how === "wa_contacts" ? `wa:${waAddr}` : `tg:${chatId}`;
    const m0 = w.mark(), made = w.created.length;
    if (s.how.startsWith("tg_card")) await w.tgShare(chatId, Q, 5550000 + s.id);
    else if (s.how === "wa_contacts") await w.wa({ from: waAddr, type: "contacts", extra: { contacts: [{ name: { formatted_name: "Friend" }, phones: [{ phone: Q, wa_id: Q.slice(1) }] }] } });
    else await w.tg(chatId, `my number is ${Q}, link me`);
    await w.run();
    if (asksIn(w, m0).length) whys.push("someone else's number asked its account");
    if (A && w.W.person(A).length !== 1) whys.push("the card's account gained a contact");
    if (w.owner(k) !== B && !(s.how === "typed_number" && !B && s.signup === "open")) whys.push(`the sender's chat is ${w.owner(k)}'s`);
    if (s.how === "typed_number" && !B && s.signup === "open" && (w.owner(k) === A || !w.owner(k))) whys.push("a typed number with sign-up open: not a fresh account of its own");
    if (s.how.startsWith("tg_card")) {
      if (w.created.length !== made) whys.push("a contact card signed up");
      if (!w.read(k, m0).includes(IN.PHONE_NOT_YOURS_REPLY)) whys.push(`not told the card is someone else's: ${JSON.stringify(w.read(k, m0))}`);
      if (w.turns.length) whys.push("a card ran a turn");
    }
    if (s.how === "wa_contacts" && w.turns.length) whys.push("a contacts message ran a turn");
    whys.push(...w.common());
    rep.grade(s, whys, JSON.stringify(w.read(k, m0)).slice(0, 300));
  }
  rep.assertClean();
} });

// ================================================================================================ link/nonce
Deno.test({ name: `identity: "connect telegram" links are single use, ten minutes, bound to the issuing account (link/nonce): ${of("nonce").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("link/nonce");
  const issueVia = async (w: World, s: Extract<Scenario, { kind: "nonce" }>, u: string, home: string): Promise<string | null> => {
    // The edges are measured from the moment the link was made (a text's own delivery paces the clock on).
    if (s.issueOn === "web" || s.redeem === "edge_ok" || s.redeem === "edge_late") return await w.W.inbound.issueLinkNonce!(u, w.clock.t);
    const m = w.mark();
    await w.from(home, "connect telegram");
    const link = w.read(home, m).join("\n").match(/start=([A-Za-z0-9_-]{32})/);
    return link ? link[1] : null;
  };
  for (const s of of("nonce")) {
    const P = phoneOf(s.id, 8000000), chat = 950000 + s.id, chat2 = 960000 + s.id;
    const w = world({ signup: "closed" });
    const whys: string[] = [];
    const home = s.issueOn === "whatsapp" ? `wa:${P.slice(1)}` : P;
    const A = w.seed([{ c: home, at: w.clock.t - MIN }], P);
    const start = async (c: number, n: string) => { const m = w.mark(); await w.tg(c, `/start ${n}`); return w.read(`tg:${c}`, m); };
    const N = await issueVia(w, s, A, home);
    if (!N) { rep.grade(s, ["no link was issued"]); continue; }
    let expectOwner: string | null = A, expectReply = IN.TELEGRAM_LINKED_REPLY, target = chat;
    let B: string | null = null;
    if (s.redeem === "elsewhere") { B = w.seed([{ c: `tg:${chat}` }]); expectOwner = B; expectReply = IN.TELEGRAM_LINKED_ELSEWHERE_REPLY; }
    if (s.redeem === "same_chat") w.W.link(`tg:${chat}`, A, w.clock.t, { threadId: `t-${A}` });
    if (s.redeem === "replace_old") w.W.link(`tg:${chat2}`, A, w.clock.t, { threadId: `t-${A}` });
    w.snap();
    w.clock.t += s.ageMs;
    let token = N;
    if (s.redeem === "forged") { token = N.split("").reverse().join(""); expectOwner = null; expectReply = IN.TELEGRAM_LINK_INVALID_REPLY; }
    if (["late", "edge_late"].includes(s.redeem)) { expectOwner = null; expectReply = IN.TELEGRAM_LINK_INVALID_REPLY; }
    if (s.redeem === "deleted") { w.deleteUser(A); expectOwner = null; expectReply = IN.TELEGRAM_LINK_INVALID_REPLY; }
    if (s.redeem === "fourth") {
      const more: string[] = [];
      for (let i = 0; i < 3; i++) { w.clock.t += 1000; more.push((await w.W.inbound.issueLinkNonce!(A, w.clock.t))); }
      const r1 = await start(chat2, N);
      if (!r1.includes(IN.TELEGRAM_LINK_INVALID_REPLY) || w.owner(`tg:${chat2}`)) whys.push(`the first of four live links still worked: ${JSON.stringify(r1)}`);
      token = more[2];
    }
    if (s.redeem === "other_account") {
      B = w.seed([{ c: phoneOf(s.id, 8100000) }]);
      token = await w.W.inbound.issueLinkNonce!(B, w.clock.t);
      expectOwner = B;
    }
    // TELEGRAM LINK OWNERSHIP (2026-10-31): a link opened by a chat that is no one's links nothing yet: the issuing account's own
    // channel is asked, and its YES binds the chat (a chat already the account's stays linked, as before).
    const confirmVia = expectReply === IN.TELEGRAM_LINKED_REPLY && s.redeem !== "same_chat" ? (s.redeem === "other_account" ? phoneOf(s.id, 8100000) : home) : null;
    const r = await start(target, token);
    if (confirmVia) {
      if (!r.includes((IN as any).TELEGRAM_LINK_CONFIRM_REPLY)) whys.push(`${s.redeem}: told ${JSON.stringify(r)}, want the confirm reply`);
      if (w.owner(`tg:${target}`)) whys.push(`${s.redeem}: the chat was linked before the YES`);
      const m = w.mark();
      await w.from(confirmVia, `LINK ${/reply LINK ([0-9]{4}) /.exec(w.read(confirmVia).filter((t) => /^Someone wants to link Telegram /.test(t)).at(-1) ?? "")?.[1] ?? "none"}`);
      if (!w.read(`tg:${target}`, m).includes(IN.LINKED_HERE_REPLY)) whys.push(`${s.redeem}: after the YES the chat was told ${JSON.stringify(w.read(`tg:${target}`, m))}`);
    } else if (!r.includes(expectReply)) whys.push(`${s.redeem}: told ${JSON.stringify(r)}, want ${expectReply}`);
    if (w.owner(`tg:${target}`) !== expectOwner) whys.push(`${s.redeem}: the chat is ${w.owner(`tg:${target}`)}'s, want ${expectOwner}`);
    if (s.redeem === "twice") {
      const r2 = await start(chat2, token);
      if (!r2.includes(IN.TELEGRAM_LINK_INVALID_REPLY) || w.owner(`tg:${chat2}`)) whys.push(`a used link worked again: ${JSON.stringify(r2)}`);
    }
    if (s.redeem === "replace_old" && w.owner(`tg:${chat2}`)) whys.push("the account's earlier Telegram chat was kept beside the new one");
    if (expectOwner === A && w.owner(`tg:${target}`) === A) {
      const t0 = w.turns.length;
      await w.tg(target, "remember I want remote roles");
      await w.from(home, "what do you know about me");
      const t = w.turns.slice(t0);
      if (t.length !== 2 || t.some((x) => x.userId !== A) || t[1].threadId !== `t-${A}` || t[0].threadId !== `t-${A}`) whys.push(`the linked chat and the account's channel are not one account and thread: ${JSON.stringify(t)}`);
      if (!w.read(home).some((x) => x.includes("I know: I want remote roles"))) whys.push("what was said on Telegram is not known on the other channel");
    }
    if (expectOwner !== A && w.W.person(A).some((c) => c.contact.startsWith("tg:"))) whys.push(`${s.redeem}: account A gained a Telegram chat`);
    whys.push(...w.common());
    rep.grade(s, whys, JSON.stringify(r).slice(0, 200));
  }
  rep.assertClean();
} });

// ================================================================================================ iso/recycled
Deno.test({ name: `identity: a WhatsApp number given to someone else: the new owner never runs as the old one, and gets a fresh account where sign-up allows (iso/recycled): ${of("recycled").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("iso/recycled");
  for (const s of of("recycled")) {
    const P = phoneOf(s.id, 9000000), addr = P.slice(1), other = s.otherChannel === "imessage_other_number" ? phoneOf(s.id, 9100000) : s.otherChannel === "telegram" ? `tg:${970000 + s.id}` : null;
    const w = world({ signup: s.signup, allow: s.signup === "allow_phone" ? [P] : [] });
    const whys: string[] = [];
    const A = w.seed([{ c: `wa:${addr}`, alias: `US.old${s.id}`, at: w.clock.t - HOUR }, ...(other ? [{ c: other, at: w.clock.t - 2 * HOUR }] : [])], P);
    await w.wa({ from: addr, bsuid: `US.old${s.id}`, text: "remember my target is Acme" });
    for (let i = 0; i < s.queued; i++) w.W.queue(A, { key: `status:r${s.id}-${i}`, kind: "status", text: `[${A}] update ${i}`, at: w.clock.t + i });
    w.clock.t += 30 * MIN;
    const m0 = w.mark(), t0 = w.turns.length;
    await w.wa({ from: addr, bsuid: `US.new${s.id}`, text: "what do you know about me" });
    await w.run();
    const mine = w.turns.slice(t0);
    if (mine.some((t) => t.userId === A)) whys.push("the new owner ran as the old one");
    if (w.read(`wa:${addr}`, m0).some((x) => x.includes(`[${A}]`) || x.includes("Acme"))) whys.push("the new owner read the old owner's messages");
    const nu = w.owner(`wa:${addr}`);
    if (s.signup === "closed") {
      if (nu) whys.push("an account with sign-up closed");
      if (!w.read(`wa:${addr}`, m0).includes(IN.SIGNUP_CLOSED_REPLY)) whys.push(`the stranger was not told: ${JSON.stringify(w.read(`wa:${addr}`, m0))}`);
    } else {
      if (!nu || nu === A) whys.push(`no fresh account for the new owner (owner ${nu}): ${JSON.stringify(w.read(`wa:${addr}`, m0))}`);
      else if (!w.read(`wa:${addr}`, m0).some((x) => x === `[${nu}] I know: nothing`)) whys.push(`the fresh account's first turn: ${JSON.stringify(w.read(`wa:${addr}`, m0))}`);
    }
    if (other && w.owner(other) !== A) whys.push("the old owner lost their other channel");
    if (other && s.queued && w.read(other).filter((x) => x.startsWith(`[${A}] update`)).length !== s.queued) whys.push(`the old owner's updates did not go to their other channel: ${JSON.stringify(w.read(other))}`);
    whys.push(...w.common());
    rep.grade(s, whys, JSON.stringify(w.read(`wa:${addr}`, m0)).slice(0, 300));
  }
  rep.assertClean();
} });

// ================================================================================================ iso/family
Deno.test({ name: `identity: a shared family number is one contact and one account; Trainee never splits or merges it on its own (iso/family): ${of("family").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("iso/family");
  for (const s of of("family")) {
    const P = phoneOf(s.id, 9200000);
    const w = world({ signup: "open" });
    const whys: string[] = [];
    for (let i = 0; i < s.turns; i++) { w.clock.t += MIN; await w.lm(P, `member ${i % s.members} asks something`); }
    await w.run();
    const users = new Set(w.turns.map((t) => t.userId));
    if (users.size !== 1 || w.created.length !== 1) whys.push(`${users.size} accounts for one shared number`);
    if (new Set(w.turns.slice(1).map((t) => t.threadId)).size > 1) whys.push("more than one thread");
    whys.push(...w.common());
    rep.grade(s, whys);
  }
  rep.assertClean();
} });

// ================================================================================================ iso/deleted
Deno.test({ name: `identity: an account deleted and the person back on any channel: fresh, nothing of the old one, told when sign-up is closed (iso/deleted): ${of("deleted").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("iso/deleted");
  for (const s of of("deleted")) {
    const P = phoneOf(s.id, 9300000), chatId = 980000 + s.id, key = (c: Ch) => keyFor(c, P, chatId);
    const w = world({ signup: s.signup, allow: s.signup === "allow_phone" ? [P] : [] });
    const whys: string[] = [];
    const A = w.seed(s.channels.map((c) => ({ c: key(c), phone: c === "telegram" ? P : undefined })), P);
    await w.from(key(s.channels[0]), "remember I am a nurse");
    let nonce: string | null = null;
    const askOn = (["whatsapp", "imessage", "telegram"] as Ch[]).find((c) => !s.channels.includes(c)) ?? null;
    if (s.pending === "nonce") nonce = await w.W.inbound.issueLinkNonce!(A, w.clock.t);
    if (s.pending === "ask" && askOn) { if (askOn === "telegram") await w.tgShare(chatId, P); else await w.from(key(askOn), "hi"); }
    for (let i = 0; i < s.queued; i++) w.W.queue(A, { key: `status:d${s.id}-${i}`, kind: "status", text: `[${A}] update ${i}`, at: w.clock.t + MIN + i });
    w.deleteUser(A);
    w.clock.t += 2 * MIN;
    await w.run();
    if (nonce) { await w.tg(chatId + 1, `/start ${nonce}`); if (w.owner(`tg:${chatId + 1}`)) whys.push("a deleted account's link still worked"); }
    // The number that asked to be linked comes back itself; otherwise the person comes back on any channel.
    const back = s.pending === "ask" && askOn ? askOn : s.backOn, bk = key(back);
    const m0 = w.mark(), t0 = w.turns.length;
    if (back === "telegram") await w.tgShare(chatId, P); else await w.from(bk, "hi, I'm back");
    await w.from(bk, "what do you know about me");
    await w.run();
    const allowed = s.signup === "open" || s.signup === "allow_phone";
    const nu = w.owner(bk);
    if (nu === A) whys.push("the deleted account came back");
    if (w.turns.slice(t0).some((t) => t.userId === A)) whys.push("a turn ran as the deleted account");
    if (w.read(bk, m0).some((x) => x.includes("nurse") || x.includes(`[${A}]`))) whys.push("the returner read the deleted account's data");
    if (allowed) {
      if (!nu) whys.push(`back with sign-up allowed: no fresh account: ${JSON.stringify(w.read(bk, m0))}`);
      else if (!w.read(bk, m0).includes(`[${nu}] I know: nothing`)) whys.push(`the fresh account knows something, or did not answer: ${JSON.stringify(w.read(bk, m0))}`);
    } else {
      if (nu) whys.push("an account with sign-up closed");
      const line = back === "telegram" ? IN.PHONE_NO_ACCOUNT_REPLY : IN.SIGNUP_CLOSED_REPLY;
      if (!w.read(bk, m0).includes(line)) whys.push(`silence instead of the sign-up line: ${JSON.stringify(w.read(bk, m0))}`);
    }
    if (w.P.sent.some((x) => x.t > T0 + 2 * MIN && x.text.startsWith(`[${A}] update`))) whys.push("a deleted account's update went out");
    whys.push(...w.common());
    rep.grade(s, whys, JSON.stringify(w.read(bk, m0)).slice(0, 300));
  }
  rep.assertClean();
} });

// ================================================================================================ iso/crowd
Deno.test({ name: `identity: several people on several channels, writing in turn: every turn as its contact's owner, every message to its owner (iso/crowd): ${of("crowd").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("iso/crowd");
  for (const s of of("crowd")) {
    const w = world({ signup: "open" });
    const whys: string[] = [];
    const people = s.people.map((p, i) => {
      const P = phoneOf(s.id * 10 + i, 1000000), keys = p.channels.map((c) => keyFor(c, P, 1000000 + s.id * 10 + i));
      const u = w.seed(keys.map((k) => ({ c: k, phone: k.startsWith("tg:") ? null : undefined })), P);
      return { u, keys };
    });
    for (let i = 0; i < s.turns; i++) {
      const p = people[(i * 7 + s.id) % people.length], k = p.keys[(i * 3 + s.id) % p.keys.length];
      w.clock.t += MIN;
      if (i < s.stops) await w.from(k, "STOP");
      else await w.from(k, `remember fact ${i} of ${p.u}`);
      w.W.queue(p.u, { key: `status:c${s.id}-${i}`, kind: "status", text: `[${p.u}] update ${i}`, at: w.clock.t });
      await w.run();
    }
    for (const p of people) {
      const t = w.turns.filter((x) => x.userId === p.u);
      if (t.some((x) => !p.keys.includes(x.contact))) whys.push(`${p.u} ran a turn from someone else's contact`);
      for (const f of w.facts.get(p.u) ?? []) if (!f.endsWith(`of ${p.u}`)) whys.push(`${p.u} remembers someone else's fact: ${f}`);
    }
    whys.push(...w.common());
    rep.grade(s, whys);
  }
  rep.assertClean();
} });

// ================================================================================================ con/stop
Deno.test({ name: `identity: STOP is the person's: held on every channel, the answer to a later message still goes, START anywhere resumes (con/stop): ${of("stop").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("con/stop");
  for (const s of of("stop")) {
    const P = phoneOf(s.id, 1100000), chatId = 1100000 + s.id, key = (c: Ch) => keyFor(c, P, chatId);
    const w = world({ signup: "closed" });
    const whys: string[] = [];
    const u = w.seed(s.channels.map((c, i) => ({ c: key(c), at: w.clock.t - (i + 1) * MIN, phone: c === "telegram" ? null : undefined })), P);
    const m0 = w.mark();
    await w.from(key(s.stopOn), "STOP");
    if (!w.read(key(s.stopOn), m0).includes(CHANNEL_REPLIES.stop)) whys.push("the STOP was not answered where it was said");
    for (let i = 0; i < s.proactive; i++) w.W.queue(u, { key: `status:s${s.id}-${i}`, kind: "status", text: `[${u}] update ${i}`, at: w.clock.t + i });
    w.clock.t += MIN;
    await w.run();
    if (w.P.sent.slice(m0).some((x) => x.text.startsWith(`[${u}] update`))) whys.push("an update went out after STOP");
    const m1 = w.mark();
    await w.from(key(s.textOn), "is my application in?");
    if (!w.read(key(s.textOn), m1).includes(`[${u}] is my application in? answered`)) whys.push(`the answer to a message after STOP did not go where it was asked: ${JSON.stringify(w.read(key(s.textOn), m1))}`);
    if (w.P.sent.slice(m1).some((x) => keyOfSent(x) !== key(s.textOn))) whys.push("something went to another channel while stopped");
    if (s.startOn) {
      await w.from(key(s.startOn), "START");
      w.clock.t += MIN;
      w.W.queue(u, { key: `status:s${s.id}-after`, kind: "status", text: `[${u}] update after`, at: w.clock.t });
      await w.run();
      if (!w.P.sent.some((x) => x.text === `[${u}] update after`)) whys.push(`START on ${s.startOn} did not turn ${s.stopOn} back on`);
    }
    whys.push(...w.common());
    rep.grade(s, whys);
  }
  rep.assertClean();
} });

// ================================================================================================ con/home
Deno.test({ name: `identity: the home channel is the one set, else the last written on; a link never moves it on its own (con/home): ${of("home").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("con/home");
  for (const s of of("home")) {
    const P = phoneOf(s.id, 1200000), chatId = 1200000 + s.id, key = (c: Ch) => keyFor(c, P, chatId);
    const w = world({ signup: "closed" });
    const whys: string[] = [];
    const u = w.seed(s.channels.map((c) => ({ c: key(c), at: w.clock.t - 3 * HOUR, phone: c === "telegram" ? P : undefined })), P);
    if (s.home) w.W.setHome(u, s.home);
    w.clock.t += MIN;
    await w.from(key(s.lastOn), "checking in");
    if (s.linkNew) {
      w.clock.t += MIN;
      const m = w.mark();
      if (s.linkNew === "telegram") await w.tgShare(chatId, P); else await w.from(key(s.linkNew), "hi");
      const asks = asksIn(w, m);
      if (asks.length === 1) { w.clock.t += MIN; await w.from(keyOfSent(asks[0]), "yes"); } else whys.push(`${asks.length} questions`);
      if (w.owner(key(s.linkNew)) !== u) whys.push("not linked");
    }
    const lastWrote = s.linkNew && asksIn(w, 0).length ? keyOfSent(asksIn(w, 0)[0]) : key(s.lastOn);
    w.clock.t += MIN;
    const m1 = w.mark();
    for (let i = 0; i < s.proactive; i++) w.W.queue(u, { key: `status:h${s.id}-${i}`, kind: "status", text: `[${u}] update ${i}`, at: w.clock.t + i });
    await w.run();
    const where = new Set(w.P.sent.slice(m1).filter((x) => x.text.startsWith(`[${u}] update`)).map(keyOfSent));
    const want = s.home ? key(s.home) : lastWrote;
    if (where.size !== 1 || !where.has(want)) whys.push(`updates went to ${[...where].join(",")}, want ${want} (home ${s.home}, last wrote ${lastWrote})`);
    whys.push(...w.common());
    rep.grade(s, whys);
  }
  rep.assertClean();
} });

// ================================================================================================ con/memory
Deno.test({ name: `identity: after a link every channel is one account in one thread; a fact said on one is known on the others, never by another account (con/memory): ${of("memory").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("con/memory");
  for (const s of of("memory")) {
    const P = phoneOf(s.id, 1300000), chatId = 1300000 + s.id, key = (c: Ch) => keyFor(c, P, chatId);
    const w = world({ signup: "open" });
    const whys: string[] = [];
    // The person arrives on each channel in order and says yes each time (every channel after the first is a share or a text).
    for (let i = 0; i < s.order.length; i++) {
      const c = s.order[i], m = w.mark();
      if (c === "telegram") await w.tgShare(chatId, P); else await w.from(key(c), `hi from ${c}`);
      if (i > 0) { const a = asksIn(w, m); if (a.length !== 1) { whys.push(`${c}: ${a.length} questions`); break; } w.clock.t += MIN; await w.from(keyOfSent(a[0]), "yes"); }
    }
    const u = w.owner(key(s.order[0]));
    if (s.order.some((c) => w.owner(key(c)) !== u)) whys.push(`not one account: ${JSON.stringify(s.order.map((c) => w.owner(key(c))))}`);
    const t0 = w.turns.length, m1 = w.mark();
    await w.from(key(s.order[s.factOn]), "remember I want to work in Denver");
    await w.from(key(s.order[s.askOn]), "what do you know about me");
    if (!w.read(key(s.order[s.askOn]), m1).includes(`[${u}] I know: I want to work in Denver`)) whys.push(`said on ${s.order[s.factOn]}, not known on ${s.order[s.askOn]}: ${JSON.stringify(w.read(key(s.order[s.askOn]), m1))}`);
    if (new Set(w.turns.slice(t0).map((t) => t.threadId)).size !== 1) whys.push(`more than one thread: ${JSON.stringify(w.turns.slice(t0).map((t) => t.threadId))}`);
    if (s.otherAsks) {
      const o = w.seed([{ c: phoneOf(s.id, 1400000) }]);
      const m2 = w.mark();
      await w.lm(phoneOf(s.id, 1400000), "what do you know about me");
      if (!w.read(phoneOf(s.id, 1400000), m2).includes(`[${o}] I know: nothing`)) whys.push("another account knows the fact");
    }
    whys.push(...w.common());
    rep.grade(s, whys);
  }
  rep.assertClean();
} });

// ================================================================================================ cc/*
Deno.test({ name: `identity: WhatsApp and Telegram asking at once: each yes links one, the latest asked, named in the reply (cc/two-links): ${of("two_links").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("cc/two-links");
  for (const s of of("two_links")) {
    const P = phoneOf(s.id, 1500000), chatId = 1500000 + s.id;
    const w = world({ signup: "closed" });
    const whys: string[] = [];
    const u = w.seed([{ c: P }], P);
    const arrivals: ["whatsapp" | "telegram", string][] = s.arrival === "wa_first" ? [["whatsapp", `wa:${P.slice(1)}`], ["telegram", `tg:${chatId}`]] : [["telegram", `tg:${chatId}`], ["whatsapp", `wa:${P.slice(1)}`]];
    for (const [c] of arrivals) { if (c === "telegram") await w.tgShare(chatId, P); else await w.wa({ from: P.slice(1), text: "hi" }); w.clock.t += s.gapMin * MIN; }
    const asked = asksIn(w, 0);
    if (asked.length !== 2 || asked.some((a) => keyOfSent(a) !== P)) whys.push(`${asked.length} questions, want 2 on iMessage`);
    const linkedOrder: string[] = [];
    for (let i = 0; i < s.yesCount; i++) {
      w.clock.t += MIN;
      const m = w.mark();
      await w.lm(P, "yes");
      const said = w.read(P, m).join(" ");
      const named = /Done: (WhatsApp|Telegram) is linked/.exec(said)?.[1];
      if (i < 2) {
        const want = arrivals[1 - i];
        if (!named || named.toLowerCase() !== want[0]) whys.push(`yes ${i + 1}: linked ${named ?? "nothing"}, want ${want[0]} (the latest asked first): ${said}`);
        else linkedOrder.push(want[1]);
      } else if (named) whys.push(`a third yes linked ${named}`);
    }
    await w.run();
    for (const [, k] of arrivals) {
      const want = linkedOrder.includes(k) ? u : null;
      if (w.owner(k) !== want) whys.push(`${k} is ${w.owner(k)}'s, want ${want}`);
    }
    whys.push(...w.common());
    rep.grade(s, whys);
  }
  rep.assertClean();
} });

Deno.test({ name: `identity: the new channel asks while a turn is running; the yes after it links (cc/turn): ${of("turn").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("cc/turn");
  for (const s of of("turn")) {
    const P = phoneOf(s.id, 1600000);
    const w = world({ signup: "closed" });
    const whys: string[] = [];
    const u = w.seed([{ c: P }], P);
    if (s.when === "during_existing") {
      // WhatsApp writes (and is asked) while the iMessage turn runs.
      w.hooks.beforeTurn = async () => { await w.wa({ from: P.slice(1), text: "hi from whatsapp" }); };
      await w.lm(P, "find me jobs");
      if (asksIn(w, 0).length !== 1) whys.push(`${asksIn(w, 0).length} questions`);
      w.clock.t += MIN;
      await w.lm(P, "yes");
    } else {
      await w.wa({ from: P.slice(1), text: "hi from whatsapp" });
      // The yes's turn never runs (it is the link), and a retried WhatsApp message during an iMessage turn changes nothing.
      w.hooks.beforeTurn = async () => { await w.wa({ from: P.slice(1), text: "hi again" }); };
      await w.lm(P, "what is new");
      w.clock.t += MIN;
      await w.lm(P, "yes");
    }
    await w.run();
    if (w.owner(`wa:${P.slice(1)}`) !== u) whys.push(`not linked after the yes (owner ${w.owner(`wa:${P.slice(1)}`)})`);
    const t0 = w.turns.length;
    await w.wa({ from: P.slice(1), text: "now on whatsapp" });
    if (w.turns.length !== t0 + 1 || w.turns.at(-1)!.userId !== u || w.turns.at(-1)!.threadId !== `t-${u}`) whys.push("the linked WhatsApp did not run as the account in its thread");
    whys.push(...w.common());
    rep.grade(s, whys);
  }
  rep.assertClean();
} });

Deno.test({ name: `identity: Telegram unlinked while an answer in parts goes out: nothing claimed after it goes to the chat (cc/unlink): ${of("unlink").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("cc/unlink");
  for (const s of of("unlink")) {
    const P = phoneOf(s.id, 1700000), chatId = 1700000 + s.id;
    const w = world({ signup: "closed" });
    const whys: string[] = [];
    const otherKey = s.other === "imessage" ? P : s.other === "whatsapp" ? `wa:${P.slice(1)}` : null;
    const u = w.seed([{ c: `tg:${chatId}`, at: w.clock.t - MIN }, ...(otherKey ? [{ c: otherKey, at: w.clock.t - 2 * MIN }] : [])], P);
    if (otherKey?.startsWith("wa:")) await w.wa({ from: P.slice(1), text: "window open" });
    for (let i = 1; i <= s.parts; i++) await w.store.enqueueReply(u, `reply:tg:u${s.id}:${i}`, `[${u}] part ${i} of ${s.parts}`, w.clock.t, "telegram", { of: `reply:tg:u${s.id}`, n: i });
    let n = 0, unlinkedAt = -1;
    w.P.onSend = async (x) => {
      if (x.prov !== "telegram" || !x.text.includes("part ")) return;
      if (++n === s.unlinkAfter) {
        w.P.onSend = null;
        unlinkedAt = w.P.sent.length;
        if (s.via === "web") await w.W.inbound.unlinkTelegram!(u, w.clock.t);
        else await w.tg(chatId, "unlink telegram");
      }
    };
    for (let i = 0; i < 6; i++) { await w.run(); w.clock.t += MIN; }
    if (w.owner(`tg:${chatId}`)) whys.push("still linked");
    const toChat = w.P.sent.slice(unlinkedAt).filter((x) => x.prov === "telegram" && x.text.startsWith(`[${u}] part`));
    if (toChat.length) whys.push(`${toChat.length} parts went to the chat after it was unlinked`);
    const arrived = w.P.sent.filter((x) => x.text.startsWith(`[${u}] part`)).map((x) => Number(/part (\d+)/.exec(x.text)![1]));
    if (otherKey) {
      const elsewhere = w.read(otherKey).filter((x) => x.startsWith(`[${u}] part`)).map((x) => Number(/part (\d+)/.exec(x)![1]));
      const want = Array.from({ length: s.parts - s.unlinkAfter }, (_, i) => s.unlinkAfter + i + 1);
      if (JSON.stringify(elsewhere) !== JSON.stringify(want)) whys.push(`the rest went to ${otherKey} as ${JSON.stringify(elsewhere)}, want ${JSON.stringify(want)}`);
    } else {
      const left = w.W.outbox.filter((r) => r.userId === u && r.key.startsWith("reply:tg:") && r.status !== "delivered");
      if (left.some((r) => r.status !== "failed" || !r.error)) whys.push(`with no channel left the rest is not failed with a reason: ${JSON.stringify(left.map((r) => [r.key, r.status, r.error]))}`);
    }
    if (new Set(arrived).size !== arrived.length) whys.push("a part arrived twice");
    whys.push(...w.common());
    rep.grade(s, whys, JSON.stringify(w.P.sent.map((x) => [keyOfSent(x), x.text.slice(0, 30)])).slice(0, 300));
  }
  rep.assertClean();
} });

Deno.test({ name: `identity: two chats redeeming the same link: one wins (cc/nonce-race): ${of("nonce_race").length} scenarios`, sanitizeOps: false, sanitizeResources: false, async fn() {
  const rep = new Report("cc/nonce-race");
  for (const s of of("nonce_race")) {
    const P = phoneOf(s.id, 1800000);
    const w = world({ signup: "closed" });
    const u = w.seed([{ c: P }], P);
    const N = await w.W.inbound.issueLinkNonce!(u, w.clock.t);
    const m = w.mark();
    await Promise.all(Array.from({ length: s.chats }, (_, i) => w.tg(1800000 + s.id * 10 + i, `/start ${N}`)));
    // TELEGRAM LINK OWNERSHIP (2026-10-31): one link asks one question; nothing is linked before the account's YES, then one chat.
    const early = Array.from({ length: s.chats }, (_, i) => w.owner(`tg:${1800000 + s.id * 10 + i}`)).filter(Boolean);
    const asked = w.read(P, m).filter((t) => /^Someone wants to link Telegram /.test(t)).length;
    await w.from(P, `LINK ${/reply LINK ([0-9]{4}) /.exec(w.read(P, m).find((t) => /^Someone wants to link Telegram /.test(t)) ?? "")?.[1] ?? "none"}`);
    const owners = Array.from({ length: s.chats }, (_, i) => w.owner(`tg:${1800000 + s.id * 10 + i}`)).filter(Boolean);
    const whys = owners.length === 1 && owners[0] === u ? [] : [`${owners.length} chats linked by one link`];
    if (early.length) whys.push(`${early.length} chats linked before the YES`);
    if (asked !== 1) whys.push(`one link asked ${asked} times`);
    whys.push(...w.common());
    rep.grade(s, whys);
  }
  rep.assertClean();
} });
