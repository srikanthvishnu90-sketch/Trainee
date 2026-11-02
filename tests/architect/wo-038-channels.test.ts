// WO-038 acceptance tests: WhatsApp and Telegram work the way iMessage does (owner: "whatsapp and telegram should work
// the exact same way as iMessage"). Every core flow runs through the real webhook handlers, the real inbound core, the
// real delivery run and each provider's real adapter, over an in-memory database and a fake network; the text a person
// reads must be the same on all three channels (split into messages differently). Where WhatsApp's 24-hour window makes
// "the same" impossible, the closest honest version is pinned instead: one short template, then the full text, whole,
// when the person replies.
// Contract: docs/architect/work-orders/WO-038-channels.md. Run: deno test -A --no-check tests/architect/
import { memoryChannelWorld } from "../../supabase/functions/_shared/channel_memory.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { deliverDue, CHANNEL_REPLIES } from "../../supabase/functions/_shared/channel.ts";
import { type Channel, packMessages } from "../../supabase/functions/_shared/channel_adapters.ts";
import { LOOPMESSAGE_SEND_URL, loopSend } from "../../supabase/functions/_shared/loopmessage.ts";
import { TELEGRAM_API } from "../../supabase/functions/_shared/telegram.ts";
import { WHATSAPP_GRAPH, whatsappSignature } from "../../supabase/functions/_shared/whatsapp.ts";
import { ALREADY_TELEGRAM_REPLY, LINKED_HERE_REPLY, linkAskText, linkedReply, linkPendingReply, SIGNUP_CLOSED_REPLY, TELEGRAM_LINK_INVALID_REPLY,
  TELEGRAM_LINKED_ELSEWHERE_REPLY, TELEGRAM_NOT_WIRED_REPLY, TELEGRAM_LINK_CONFIRM_REPLY, telegramLinkAskText } from "../../supabase/functions/_shared/channel_inbound.ts";
import { cardFor } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { receiptText } from "../../supabase/functions/_shared/career_apply_receipts.ts";
import { handleInbound } from "../../supabase/functions/trainee-inbound/handler.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { handleWhatsApp } from "../../supabase/functions/trainee-whatsapp/handler.ts";
import { handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";
import templates from "../../docs/launch/whatsapp-templates.json" with { type: "json" };

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const NOW = Date.UTC(2026, 9, 21, 15), MIN = 60000, HOUR = 60 * MIN;
const SECRET = "i".repeat(40), TG_TOKEN = "123456:fake-telegram-token-TTTTTTTT", TG_SECRET = "t".repeat(40);
const WA_TOKEN = "fake-wa-token-WWWWWWWW", WA_APP = "fake-wa-app-secret-AAAAAAAA", WA_VERIFY = "v".repeat(40), PNID = "100200300";
const TEMPLATE_BODY: string = (templates as any).templates[0].components[0].text;
const norm = (texts: string[]) => texts.join("\n").replace(/\s+/g, " ").trim();
const CHANNELS: Channel[] = ["imessage", "whatsapp", "telegram"];
const ADDR: Record<Channel, string> = { imessage: "+15550001111", whatsapp: "15550002222", telegram: "7001" };

type Sent = { channel: Channel; address: string; text: string; kind: "text" | "template"; at: number; body: any };
function harness(o: { env?: Record<string, string>; tgFail?: (body: any) => Response | null; waFail?: (body: any) => Response | null; brainResult?: (m: string) => Record<string, unknown> | null } = {}) {
  const W = memoryChannelWorld();
  const clock = { t: NOW };
  const sleep = async (ms: number) => { clock.t += ms; };
  const sent: Sent[] = [];
  let n = 0, upd = 1000, msgSeq = 0;
  const resp = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const net = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url === LOOPMESSAGE_SEND_URL) { sent.push({ channel: "imessage", address: body.contact, text: body.text, kind: "text", at: clock.t, body }); return resp({ message_id: `lm-${++n}` }); }
    if (url.startsWith(`${TELEGRAM_API}/bot${TG_TOKEN}/sendMessage`)) {
      const f = o.tgFail?.(body); if (f) return f;
      sent.push({ channel: "telegram", address: String(body.chat_id), text: body.text, kind: "text", at: clock.t, body });
      return resp({ ok: true, result: { message_id: ++n } });
    }
    if (url === `${WHATSAPP_GRAPH}/v21.0/${PNID}/messages`) {
      const f = o.waFail?.(body); if (f) return f;
      const address = body.to ?? body.recipient;
      if (body.type === "template") sent.push({ channel: "whatsapp", address, text: TEMPLATE_BODY.replace("{{1}}", body.template.components[0].parameters[0].text), kind: "template", at: clock.t, body });
      else sent.push({ channel: "whatsapp", address, text: body.text.body, kind: "text", at: clock.t, body });
      return resp({ messages: [{ id: `wamid.out.${++n}` }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const vars: Record<string, string> = {
    TRAINEE_INBOUND_SECRET: SECRET, LOOPMESSAGE_API_KEY: "fake-loop-key", TRAINEE_SIGNUP: "open",
    TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_WEBHOOK_SECRET: TG_SECRET, TELEGRAM_BOT_USERNAME: "TraineeTestBot",
    WHATSAPP_TOKEN: WA_TOKEN, WHATSAPP_PHONE_NUMBER_ID: PNID, WHATSAPP_APP_SECRET: WA_APP, WHATSAPP_VERIFY_TOKEN: WA_VERIFY, WHATSAPP_TEMPLATE_UPDATES: "trainee_updates",
    TRAINEE_DELIVER_SECRET: "d".repeat(40), ...o.env,
  };
  const env = { get: (k: string) => vars[k] || undefined };
  const adapters = adaptersFromEnv(env, { fetch: net, clock: () => clock.t, sleep });
  const chats: any[] = [];
  const brain = (m: string) => m === "find me data analyst jobs" ? "Here are two data analyst jobs.\nAnalyst at Acme (New York)\nhttps://jobs.lever.co/acme/1\nData Analyst at Beta (Remote)\nhttps://boards.greenhouse.io/beta/jobs/2"
    : m === "yes" ? "Approved: 1 application to Acme Corp. It runs on your computer next."
    : m === "what do you need from me" ? "Two questions, asked once:\n1. Are you authorized to work in the US?\n2. What is your earliest start date?"
    : `You said: ${m}`;
  const chat = async (a: any) => { chats.push(a); return { status: 200, reply: brain(a.message), threadId: `t-${a.userId}`, ...(a.message === "draft my outreach" ? { parts: DRAFTS } : {}), ...(o.brainResult?.(a.message) ?? {}) }; };
  const runDeliver = async (scope?: { only?: { userId: string; key: string }; user?: string }) => {
    const s = W.delivery(scope);
    const r = await deliverDue({ store: s, adapters, now: clock.t });
    await s.release();
    return r;
  };
  // Each webhook gets its provider's adapter over the fake network (a channel not wired builds its own, which answers NOT_WIRED).
  const deps = (ch: "telegram" | "whatsapp") => ({
    env, now: () => clock.t, store: () => W.inbound, chat,
    deliver: (a: any) => runDeliver(ch === "whatsapp" ? { user: a.userId } : { only: { userId: a.userId, key: a.key } }).then(() => {}),
    adapter: adapters[ch] ? () => adapters[ch]! : undefined,
  });
  const tgUpdate = (chatId: string, text: string, updateId?: number, messageId?: number) => ({ update_id: updateId ?? ++upd, message: { message_id: messageId ?? ++msgSeq, from: { id: Number(chatId), is_bot: false }, chat: { id: Number(chatId), type: "private" }, date: Math.floor(clock.t / 1000), text } });
  const waBody = (from: string, text: string, id: string, extra: Record<string, unknown> = {}) => ({ object: "whatsapp_business_account", entry: [{ id: "WABA1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: PNID }, contacts: [{ wa_id: from, profile: { name: "Test Person" } }],
    messages: [{ from, id, timestamp: String(Math.floor(clock.t / 1000)), type: "text", text: { body: text } }], ...extra } }] }] });
  const tgPost = (u: unknown, secret = TG_SECRET) => handleTelegram(new Request("https://fn.test/trainee-telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(u) }), deps("telegram"));
  const waPost = async (b: unknown, sign = WA_APP) => {
    const raw = new TextEncoder().encode(JSON.stringify(b));
    return await handleWhatsApp(new Request("https://fn.test/trainee-whatsapp", { method: "POST", headers: { "x-hub-signature-256": await whatsappSignature(sign, raw) }, body: raw }), deps("whatsapp"));
  };
  const lmPost = (from: string, text: string, id: string) => handleInbound(new Request(`https://fn.test/trainee-inbound?secret=${SECRET}`, { method: "POST", body: JSON.stringify({ alert_type: "message_inbound", message_id: id, recipient: from, text }) }), {
    env, now: () => clock.t, store: () => W.inbound, send: (apiKey: string) => loopSend({ apiKey, fetch: net, sleep }), chat,
    deliverReply: (a: any) => runDeliver({ only: { userId: a.userId, key: a.key } }).then(() => {}),
  });
  // A person texts on a channel; returns the webhook's JSON.
  const text = async (channel: Channel, from: string, body: string) => {
    clock.t += 2000;
    const id = `in-${++msgSeq}`;
    const res = channel === "imessage" ? await lmPost(from, body, id) : channel === "telegram" ? await tgPost(tgUpdate(from, body)) : await waPost(waBody(from, body, `wamid.in.${id}`));
    return await res.json();
  };
  // What a person read, from a point on: texts (and, apart, templates) to one address.
  const mark = () => sent.length;
  const read = (address: string, from = 0, kind: "text" | "template" = "text") => sent.slice(from).filter((s) => s.address === address && s.kind === kind).map((s) => s.text);
  const userOf = (contact: string) => W.contacts.get(contact)?.userId ?? null;
  return { W, clock, sent, adapters, env, chats, runDeliver, text, read, mark, userOf, tgPost, tgUpdate, waPost, waBody, lmPost, net };
}
const contactOf = (ch: Channel, addr: string) => (ch === "whatsapp" ? `wa:${addr}` : ch === "telegram" ? `tg:${addr}` : addr);
// One flow on each channel; the person-visible text must be the same on all three.
async function parity(flow: (h: ReturnType<typeof harness>, ch: Channel, addr: string) => Promise<string[]>, env?: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const ch of CHANNELS) out[ch] = norm(await flow(harness({ env }), ch, ADDR[ch]));
  eq(out.whatsapp, out.imessage, "WhatsApp reads what iMessage reads");
  eq(out.telegram, out.imessage, "Telegram reads what iMessage reads");
  return out.imessage;
}

const REPORT = [`Your daily job report: 10 matches in the last day.`,
  ...Array.from({ length: 10 }, (_, i) => `- Data Analyst ${i + 1} at Employer ${i + 1} (New York, NY), first seen ${i + 2} hours ago\n  https://jobs.lever.co/employer-${i + 1}/${"a".repeat(30)}${i}`)].join("\n");
const ALERT = "New match: Data Analyst at Acme (New York, NY), first seen 4 min ago.\nhttps://jobs.lever.co/acme/1";
const RECEIPT = receiptText({ company: "Acme Corp", url: "https://jobs.lever.co/acme/1", state: "submitted_unconfirmed" });
const card = (n: number) => cardFor(Array.from({ length: n }, (_, i) => ({ id: `P${i}`, company: `Employer ${i}`,
  card_lines: [`Employer ${i}`, ...Array.from({ length: 6 }, (_, k) => `Question ${k}: a confirmed answer number ${i}.${k} from the person's own facts`), `Sends to https://jobs.lever.co/employer-${i}/apply`] })))! as { text: string };

// A reply in parts (WO-033's outreach batch): 10 drafts, each shown in full, about 9,000 characters in all.
const DRAFTS = Array.from({ length: 10 }, (_, i) => [`Draft ${i + 1} of 10, to Hiring Manager ${i + 1} at Employer ${i + 1}:`,
  ...Array.from({ length: 8 }, (_, k) => `Paragraph ${k + 1} of draft ${i + 1}: a sentence the person approved word for word, about their own work, nothing invented.`),
  `https://jobs.lever.co/employer-${i + 1}/apply`].join("\n"));

// ------------------------------------------------------------------------------------------------------- parity
Deno.test("WO-038/P1 first text: sign-up refused (closed) says the same once on every channel; allowed runs the same turn", async () => {
  const refused = await parity(async (h, ch, addr) => {
    const m = h.mark();
    await h.text(ch, addr, "hi");
    await h.text(ch, addr, "hello?");
    eq(h.chats.length, 0, `${ch}: no model call for a stranger`);
    eq(h.W.person(h.userOf(contactOf(ch, addr)) ?? "none").length, 0, `${ch}: no account`);
    return h.read(addr, m);
  }, { TRAINEE_SIGNUP: "closed" });
  eq(refused, norm([SIGNUP_CLOSED_REPLY]), "told once, not on every text");
  const allowed = await parity(async (h, ch, addr) => { const m = h.mark(); await h.text(ch, addr, "hi"); assert(h.userOf(contactOf(ch, addr)), `${ch}: account`); return h.read(addr, m); });
  eq(allowed, "You said: hi");
  // The allow-list takes Telegram chats and WhatsApp numbers too.
  const h = harness({ env: { TRAINEE_SIGNUP: "closed", TRAINEE_ALLOWED_CONTACTS: "+15550002222,telegram:7001" } });
  await h.text("whatsapp", ADDR.whatsapp, "hi"); await h.text("telegram", ADDR.telegram, "hi");
  eq([h.read(ADDR.whatsapp), h.read(ADDR.telegram)], [["You said: hi"], ["You said: hi"]]);
});

// WO-106 (owner, 2026-10-21 live test: help and /start dead-ended) changed P2: HELP and Telegram's /start from a known person
// are brain turns (the reply ends in their next step); STOP, /stop and the word START keep their fixed words, never the brain.
Deno.test("WO-038/P2 STOP and START: the same fixed words on every channel, never the brain; HELP is a brain turn; Telegram's /stop is STOP and /help, /start reach the brain", async () => {
  const got = await parity(async (h, ch, addr) => {
    await h.text(ch, addr, "hi");
    const m = h.mark();
    for (const t of ["STOP", "START"]) await h.text(ch, addr, t);
    eq(h.chats.length, 1, `${ch}: STOP and START never reach the brain`);
    await h.text(ch, addr, "HELP");
    eq(h.chats.length, 2, `${ch}: HELP is a turn for the brain`);
    return h.read(addr, m).slice(0, 2);
  });
  eq(got, norm([CHANNEL_REPLIES.stop, CHANNEL_REPLIES.start]));
  const h = harness();
  await h.text("telegram", ADDR.telegram, "hi");
  const m = h.mark();
  for (const t of ["/stop", "/stop@TraineeTestBot"]) await h.text("telegram", ADDR.telegram, t);
  eq(norm(h.read(ADDR.telegram, m)), norm([CHANNEL_REPLIES.stop, CHANNEL_REPLIES.stop]));
  assert(h.W.contacts.get("tg:7001")!.optedOut, "/stop opts out");
  const before = h.chats.length;
  await h.text("telegram", ADDR.telegram, "/start");
  assert(!h.W.contacts.get("tg:7001")!.optedOut, "/start lifts the STOP");
  await h.text("telegram", ADDR.telegram, "/help");
  eq(h.chats.length, before + 2, "/start and /help reach the brain");
  assert(h.read(ADDR.telegram, m).some((r: string) => r.startsWith(CHANNEL_REPLIES.start)), "/start's reply opens with the back-on line");
});

Deno.test("WO-038/P3 a chat turn: the same answer on every channel, and the brain is never told the channel", async () => {
  const got = await parity(async (h, ch, addr) => {
    await h.text(ch, addr, "hi");
    const m = h.mark();
    await h.text(ch, addr, "find me data analyst jobs");
    for (const c of h.chats) eq(Object.keys(c).sort(), ["message", "threadId", "turnKey", "userId"], "only the person, the thread, the words and a turn key");
    eq(h.chats[1].threadId, h.chats[0].threadId ?? `t-${h.chats[0].userId}`, "the same thread");
    return h.read(addr, m);
  });
  assert(got.includes("https://jobs.lever.co/acme/1") && got.includes("https://boards.greenhouse.io/beta/jobs/2"), got);
});

Deno.test("WO-038/P4 an approval card arrives whole on every channel, and its yes answers it the same way", async () => {
  for (const n of [1, 3]) {
    const c = card(n);
    const got = await parity(async (h, ch, addr) => {
      await h.text(ch, addr, "hi");
      const u = h.userOf(contactOf(ch, addr))!;
      h.W.queue(u, { key: "card:C1", kind: "card", text: c.text, at: h.clock.t });
      const m = h.mark();
      await h.runDeliver();
      const shown = h.read(addr, m);
      for (const s of shown) assert(s.length <= 1500, `${ch}: a message of ${s.length} characters`);
      await h.text(ch, addr, "yes");
      eq(h.chats.at(-1).message, "yes");
      return h.read(addr, m);
    });
    eq(got, norm([c.text, "Approved: 1 application to Acme Corp. It runs on your computer next."]), `a card of ${n}, every line, then the answer`);
  }
});

Deno.test("WO-038/P5..P7 a daily report keeps every posting, an alert and a receipt arrive the same on every channel", async () => {
  for (const [kind, key, textOf] of [["report", "report:2026-10-21", REPORT], ["alert", "alert:job-1", ALERT], ["receipt", "receipt:A1", RECEIPT]] as const) {
    const got = await parity(async (h, ch, addr) => {
      await h.text(ch, addr, "hi");
      h.W.queue(h.userOf(contactOf(ch, addr))!, { key, kind, text: textOf, at: h.clock.t });
      const m = h.mark();
      eq((await h.runDeliver()).delivered, 1, `${ch}: ${kind} delivered`);
      return h.read(addr, m);
    });
    eq(got, norm([textOf]), kind);
  }
});

Deno.test("WO-038/P8 ask-once questions read the same on every channel", async () => {
  const got = await parity(async (h, ch, addr) => { await h.text(ch, addr, "hi"); const m = h.mark(); await h.text(ch, addr, "what do you need from me"); return h.read(addr, m); });
  eq(got, norm(["Two questions, asked once:\n1. Are you authorized to work in the US?\n2. What is your earliest start date?"]));
});

Deno.test("WO-038/P9 after STOP: nothing Trainee starts goes out, and a message the person sends is still answered, on every channel", async () => {
  const got = await parity(async (h, ch, addr) => {
    await h.text(ch, addr, "hi");
    await h.text(ch, addr, "STOP");
    const m = h.mark();
    h.W.queue(h.userOf(contactOf(ch, addr))!, { key: "alert:job-9", kind: "alert", text: ALERT, at: h.clock.t });
    eq((await h.runDeliver()).skipped_opt_out, 1, `${ch}: the alert is held back for good`);
    await h.text(ch, addr, "find me data analyst jobs");
    return h.read(addr, m);
  });
  assert(!got.includes("New match"), got);
  assert(got.startsWith("Here are two data analyst jobs."), got);
});

Deno.test("WO-038/M1 a reply in parts (a 10-draft batch, about 9,000 characters) arrives whole, in order, with no cut note, on every channel; Telegram still paces one a second", async () => {
  const total = DRAFTS.join("\n\n").length;
  assert(total > 8500 && total < 10000, `${total} characters`);
  const got = await parity(async (h, ch, addr) => {
    await h.text(ch, addr, "hi");
    const m = h.mark();
    const r = await h.text(ch, addr, "draft my outreach");
    eq((r.results?.[0] ?? r).parts, 10, `${ch}: ten parts`);
    const rows = h.W.outbox.filter((o) => o.kind === "reply" && o.partOf);
    eq(rows.map((o) => o.part), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert(rows.every((o) => o.key === `${o.partOf}:${o.part}` && o.status === "delivered"), `${ch}: reply:<id>:<n>, all delivered`);
    const to = h.sent.slice(m).filter((s) => s.address === addr);
    if (ch !== "imessage") for (const s of to) assert(s.text.length <= 1500, `${ch}: ${s.text.length} characters in one message`);
    if (ch === "telegram") for (let i = 1; i < to.length; i++) assert(to[i].at - to[i - 1].at >= 1000, `telegram: ${to[i].at - to[i - 1].at} ms between messages`);
    const read = h.read(addr, m);
    assert(!read.join("\n").includes("That's where I had to stop"), `${ch}: never cut`);
    return read;
  });
  eq(got, norm(DRAFTS), "every draft, whole, in order");
});

Deno.test("WO-038/M2 parts keep their order when one fails: the later parts wait for it; a part over 4,000 characters is split, never cut", async () => {
  let failOnce = true;
  const h = harness({ tgFail: (b) => (failOnce && b.text.startsWith("Draft 3 of 10") ? (failOnce = false, new Response(JSON.stringify({ ok: false, error_code: 502, description: "Bad Gateway" }), { status: 502 })) : null) });
  await h.text("telegram", ADDR.telegram, "hi");
  const m = h.mark();
  await h.text("telegram", ADDR.telegram, "draft my outreach");
  eq(norm(h.read(ADDR.telegram, m)), norm(DRAFTS.slice(0, 2)), "drafts 1 and 2 went; 3 failed, so 4 to 10 wait");
  h.clock.t += 2 * MIN;
  await h.runDeliver();
  eq(norm(h.read(ADDR.telegram, m)), norm(DRAFTS), "then 3 to 10, in order, nothing twice");
  // WhatsApp claims everything due for the person in one batch: a part that fails stops the rest of that run.
  let waOnce = true;
  const w = harness({ waFail: (b) => (waOnce && b.type === "text" && b.text.body.startsWith("Draft 3 of 10") ? (waOnce = false, new Response(JSON.stringify({ error: { code: 131000, message: "Something went wrong" } }), { status: 502 })) : null) });
  await w.text("whatsapp", ADDR.whatsapp, "hi");
  const wm = w.mark();
  await w.text("whatsapp", ADDR.whatsapp, "draft my outreach");
  eq(norm(w.read(ADDR.whatsapp, wm)), norm(DRAFTS.slice(0, 2)), "WhatsApp: 4 to 10 wait for 3");
  w.clock.t += 2 * MIN;
  await w.runDeliver();
  eq(norm(w.read(ADDR.whatsapp, wm)), norm(DRAFTS), "WhatsApp: then in order");
  const { replyParts } = await import("../../supabase/functions/_shared/channel_inbound.ts");
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i}: ${"word ".repeat(20)}`).join("\n");
  const parts = replyParts(["short one", long])!;
  assert(parts.length >= 3 && parts.every((p) => p.length <= 4000), "split under the limit");
  eq(norm(parts.slice(1)), norm([long]), "nothing cut");
  eq(replyParts(["just one"]), null, "one part is an ordinary reply");
});

// ------------------------------------------------------------------------------------------------------- WhatsApp window
Deno.test("WO-038/W1 outside WhatsApp's window: one short template, then everything waiting, whole and in order, when the person replies", async () => {
  const h = harness();
  await h.text("whatsapp", ADDR.whatsapp, "hi");
  const u = h.userOf("wa:15550002222")!;
  h.clock.t += 25 * HOUR;
  h.W.queue(u, { key: "alert:job-1", kind: "alert", text: ALERT, at: h.clock.t });
  h.W.queue(u, { key: "report:2026-10-22", kind: "report", text: REPORT, at: h.clock.t });
  const m = h.mark();
  const r = await h.runDeliver();
  eq([r.delivered, r.held, r.nudged], [0, 2, 1]);
  eq(h.read(ADDR.whatsapp, m), [], "no free text outside the window");
  eq(h.read(ADDR.whatsapp, m, "template"), ["Trainee has 2 new update(s) for you. Reply to see them."]);
  const tpl = h.sent.find((s) => s.kind === "template")!.body.template;
  eq([tpl.name, tpl.language.code], ["trainee_updates", "en_US"], "the approved template by its env name");
  eq((await h.runDeliver()).nudged, 0, "nothing more until they reply");
  const before = h.mark();
  await h.text("whatsapp", ADDR.whatsapp, "ok show me");
  eq(norm(h.read(ADDR.whatsapp, before)), norm([ALERT, REPORT, "You said: ok show me"]), "the waiting messages first, whole, then the answer");
  eq((await h.runDeliver()).delivered, 0, "each went out once");
  // iMessage and Telegram have no window: the same alert goes straight out after 25 hours.
  for (const ch of ["imessage", "telegram"] as Channel[]) {
    const g = harness();
    await g.text(ch, ADDR[ch], "hi");
    g.clock.t += 25 * HOUR;
    g.W.queue(g.userOf(contactOf(ch, ADDR[ch]))!, { key: "alert:job-1", kind: "alert", text: ALERT, at: g.clock.t });
    eq((await g.runDeliver()).delivered, 1, ch);
  }
});

Deno.test("WO-038/W2 without a template name, a message outside the window waits and nothing at all is sent; the reply still flushes it", async () => {
  const h = harness({ env: { WHATSAPP_TEMPLATE_UPDATES: "" } });
  await h.text("whatsapp", ADDR.whatsapp, "hi");
  h.clock.t += 25 * HOUR;
  h.W.queue(h.userOf("wa:15550002222")!, { key: "alert:job-1", kind: "alert", text: ALERT, at: h.clock.t });
  const m = h.mark();
  const r = await h.runDeliver();
  eq([r.held, r.nudged, h.sent.length - m], [1, 0, 0]);
  await h.text("whatsapp", ADDR.whatsapp, "hi again");
  eq(norm(h.read(ADDR.whatsapp, m)), norm([ALERT, "You said: hi again"]));
});

Deno.test("WO-038/W3 one template per silence: more updates while waiting send no second template; a new silence gets a new one", async () => {
  const h = harness();
  await h.text("whatsapp", ADDR.whatsapp, "hi");
  const u = h.userOf("wa:15550002222")!;
  h.clock.t += 25 * HOUR;
  h.W.queue(u, { key: "alert:1", kind: "alert", text: ALERT, at: h.clock.t });
  await h.runDeliver();
  h.clock.t += HOUR;
  h.W.queue(u, { key: "alert:2", kind: "alert", text: ALERT.replace("Acme", "Beta"), at: h.clock.t });
  eq((await h.runDeliver()).nudged, 0);
  await h.text("whatsapp", ADDR.whatsapp, "hi again");
  h.clock.t += 25 * HOUR;
  h.W.queue(u, { key: "alert:3", kind: "alert", text: ALERT.replace("Acme", "Gamma"), at: h.clock.t });
  eq((await h.runDeliver()).nudged, 1);
  eq(h.read(ADDR.whatsapp, 0, "template").length, 2);
});

Deno.test("WO-038/W4 131047 and 131049 never lose a message: refused on the send or failed later by status, it waits and the next message sends it once", async () => {
  // On the send itself.
  for (const code of [131047, 131049]) {
    let refuse = true;
    const h = harness({ waFail: (b) => (refuse && b.type === "text" && b.text.body.startsWith("New match") ? new Response(JSON.stringify({ error: { code, message: "Re-engagement message" } }), { status: 400 }) : null) });
    await h.text("whatsapp", ADDR.whatsapp, "hi");
    h.W.queue(h.userOf("wa:15550002222")!, { key: "alert:job-1", kind: "alert", text: ALERT, at: h.clock.t });
    const r = await h.runDeliver();
    eq([r.held, r.failed, r.retried], [1, 0, 0], `${code}: held, not failed`);
    eq(h.W.outbox.find((o) => o.key === "alert:job-1")!.status, "held");
    refuse = false;
    const m = h.mark();
    await h.text("whatsapp", ADDR.whatsapp, "hi again");
    eq(h.read(ADDR.whatsapp, m).filter((t) => t === ALERT).length, 1, `${code}: delivered once, later`);
  }
  // Accepted, then a "failed" status for the window.
  const h = harness();
  await h.text("whatsapp", ADDR.whatsapp, "hi");
  h.W.queue(h.userOf("wa:15550002222")!, { key: "alert:job-2", kind: "alert", text: ALERT, at: h.clock.t });
  await h.runDeliver();
  const row = h.W.outbox.find((o) => o.key === "alert:job-2")!;
  eq(row.status, "delivered");
  const status = { object: "whatsapp_business_account", entry: [{ id: "WABA1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: PNID },
    statuses: [{ id: row.providerId, status: "failed", recipient_id: ADDR.whatsapp, errors: [{ code: 131047, title: "Re-engagement message" }] }] } }] }] };
  eq((await (await h.waPost(status)).json()).reheld, 1);
  eq(h.W.outbox.find((o) => o.key === "alert:job-2")!.status, "held");
  const m = h.mark();
  await h.text("whatsapp", ADDR.whatsapp, "anything new?");
  eq(h.read(ADDR.whatsapp, m)[0], ALERT, "the held alert goes out again, before the answer");
});

Deno.test("WO-038/W5 an alert is once ever: a held alert is delivered later, not dropped, and its key is never queued twice", async () => {
  const h = harness();
  await h.text("whatsapp", ADDR.whatsapp, "hi");
  const u = h.userOf("wa:15550002222")!;
  h.clock.t += 30 * HOUR;
  assert(h.W.queue(u, { key: "alert:job-7", kind: "alert", text: ALERT, at: h.clock.t }));
  await h.runDeliver();
  eq(h.W.queue(u, { key: "alert:job-7", kind: "alert", text: ALERT, at: h.clock.t }), false, "once ever");
  h.clock.t += 3 * 24 * HOUR;
  await h.runDeliver();
  const m = h.mark();
  await h.text("whatsapp", ADDR.whatsapp, "back");
  eq(h.read(ADDR.whatsapp, m).filter((t) => t === ALERT).length, 1, "days later, still delivered, once");
});

// ------------------------------------------------------------------------------------------------------- dedupe, pacing, adapters
Deno.test("WO-038/D1 dedupe is per provider: Telegram keys on update_id (a message_id repeated in two chats is not a duplicate); ids never collide across providers", async () => {
  const h = harness();
  await h.tgPost(h.tgUpdate("7001", "hi", 501, 5));
  await h.tgPost(h.tgUpdate("7002", "hi", 502, 5));
  eq(h.chats.length, 2, "message_id 5 in two chats: two people, two turns");
  eq((await (await h.tgPost(h.tgUpdate("7001", "hi", 501, 5))).json()).results[0].ignored, "duplicate webhook");
  eq(h.chats.length, 2);
  await h.lmPost("+15550001111", "hi", "501");
  eq(h.chats.length, 3, "LoopMessage id 501 is not Telegram update 501");
  const wa = h.waBody(ADDR.whatsapp, "hi", "wamid.same");
  await h.waPost(wa); await h.waPost(wa);
  eq(h.chats.length, 4, "a WhatsApp message id runs once");
});

Deno.test("WO-038/T1 Telegram pacing: never two messages to one chat under a second apart (injected clock); each message within its limits", async () => {
  const h = harness();
  await h.text("telegram", ADDR.telegram, "hi");
  const u = h.userOf("tg:7001")!;
  const long = Array.from({ length: 30 }, (_, i) => `Line ${i}: ${"word ".repeat(18)}`).join("\n"); // about 3,300 characters
  h.W.queue(u, { key: "report:r1", kind: "report", text: long, at: h.clock.t });
  h.W.queue(u, { key: "alert:a1", kind: "alert", text: ALERT, at: h.clock.t });
  const m = h.mark();
  await h.runDeliver();
  const to = h.sent.slice(m).filter((s) => s.address === "7001");
  assert(to.length >= 3, `${to.length} messages`);
  for (let i = 1; i < to.length; i++) assert(to[i].at - to[i - 1].at >= 1000, `message ${i} came ${to[i].at - to[i - 1].at} ms after the one before`);
  for (const s of to) assert(s.text.length <= 1500 && s.text.length <= 4096, `${s.text.length} characters`);
  eq(norm(to.map((s) => s.text)), norm([long, ALERT]), "nothing lost in the split");
});

Deno.test("WO-038/T2 the request shapes: Telegram plain text (no parse_mode) with previews on; WhatsApp text with preview_url; a business-scoped id goes in recipient", async () => {
  const h = harness();
  await h.text("telegram", ADDR.telegram, "hi");
  const tg = h.sent.find((s) => s.channel === "telegram")!.body;
  eq([tg.chat_id, "parse_mode" in tg, tg.link_preview_options], [7001, false, { is_disabled: false }]);
  await h.text("whatsapp", ADDR.whatsapp, "hi");
  const wa = h.sent.find((s) => s.channel === "whatsapp")!.body;
  eq([wa.messaging_product, wa.to, wa.type, wa.text.preview_url], ["whatsapp", ADDR.whatsapp, "text", true]);
  // A sender with no phone number (WhatsApp usernames): keyed by the business-scoped id, answered through "recipient".
  const b = h.waBody("x", "hi", "wamid.bsuid");
  b.entry[0].changes[0].value.contacts = [{ user_id: "US.13491208655302741918", profile: { name: "T" } }] as any;
  (b.entry[0].changes[0].value.messages[0] as any).from = undefined;
  (b.entry[0].changes[0].value.messages[0] as any).from_user_id = "US.13491208655302741918";
  await h.waPost(b);
  assert(h.userOf("wa:US.13491208655302741918"), "an account keyed by the business-scoped id");
  eq(h.sent.at(-1)!.body.recipient, "US.13491208655302741918");
  eq(packMessages("a".repeat(10), 1500), ["a".repeat(10)]);
});

Deno.test("WO-038/B1 a Telegram block is the person's STOP: a 403 'bot was blocked' or a 'kicked' update records the opt-out and nothing more is tried", async () => {
  let blocked = false;
  const h = harness({ tgFail: () => (blocked ? new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }), { status: 403 }) : null) });
  await h.text("telegram", ADDR.telegram, "hi");
  const u = h.userOf("tg:7001")!;
  blocked = true;
  h.W.queue(u, { key: "alert:1", kind: "alert", text: ALERT, at: h.clock.t });
  const r = await h.runDeliver();
  eq([r.skipped_opt_out, r.failed, r.retried], [1, 0, 0]);
  assert(h.W.contacts.get("tg:7001")!.optedOut, "recorded as STOP");
  h.W.queue(u, { key: "alert:2", kind: "alert", text: ALERT, at: h.clock.t });
  eq((await h.runDeliver()).skipped_opt_out, 1, "the next is not even tried");
  const g = harness();
  await g.text("telegram", "7003", "hi");
  await g.tgPost({ update_id: 9001, my_chat_member: { chat: { id: 7003, type: "private" }, from: { id: 7003 }, new_chat_member: { status: "kicked" } } });
  assert(g.W.contacts.get("tg:7003")!.optedOut, "kicked = opted out");
});

// ------------------------------------------------------------------------------------------------------- doors
Deno.test("WO-038/G1 the webhook doors: Telegram's secret header; WhatsApp's verify challenge and signed POST; NOT_WIRED without a token, nothing claimed", async () => {
  const h = harness();
  eq((await h.tgPost(h.tgUpdate("7001", "hi"), "x".repeat(40))).status, 403);
  eq(h.chats.length, 0);
  const noTg = harness({ env: { TELEGRAM_BOT_TOKEN: "" } });
  const r = await noTg.tgPost(noTg.tgUpdate("7001", "hi"));
  eq(r.status, 503); assert(/NOT_WIRED: TELEGRAM_BOT_TOKEN/.test((await r.json()).error));
  eq(noTg.W.inbound.claimed.size, 0, "not claimed: Telegram's retry runs it once wired");
  const wa = (q: string) => handleWhatsApp(new Request(`https://fn.test/trainee-whatsapp?${q}`), { env: h.env, now: () => NOW, store: () => h.W.inbound, chat: async () => ({ status: 200, reply: "", threadId: null }), deliver: async () => {} });
  const ok = await wa(`hub.mode=subscribe&hub.verify_token=${WA_VERIFY}&hub.challenge=1158201444`);
  eq([ok.status, await ok.text()], [200, "1158201444"]);
  eq((await wa(`hub.mode=subscribe&hub.verify_token=${"w".repeat(40)}&hub.challenge=1`)).status, 403);
  eq((await h.waPost(h.waBody(ADDR.whatsapp, "hi", "wamid.forged"), "fake-not-the-app-secret")).status, 403, "a forged signature");
  const unsigned = await handleWhatsApp(new Request("https://fn.test/", { method: "POST", body: "{}" }), { env: h.env, now: () => NOW, store: () => h.W.inbound, chat: async () => ({ status: 200, reply: "", threadId: null }), deliver: async () => {} });
  eq(unsigned.status, 403);
  eq(h.chats.length, 0);
  const noSecret = harness({ env: { WHATSAPP_APP_SECRET: "" } });
  eq((await noSecret.waPost(noSecret.waBody(ADDR.whatsapp, "hi", "wamid.1"))).status, 503);
  const noWa = harness({ env: { WHATSAPP_TOKEN: "" } });
  const nw = await noWa.waPost(noWa.waBody(ADDR.whatsapp, "hi", "wamid.2"));
  eq(nw.status, 503); assert(/NOT_WIRED/.test((await nw.json()).error));
});

Deno.test("WO-038/G2 delivery runs on what is wired: nothing wired is NOT_WIRED; Telegram alone delivers Telegram rows and leaves iMessage rows queued; caps are per provider", async () => {
  const run = async (h: ReturnType<typeof harness>, env: Record<string, string>) => {
    const e = { get: (k: string) => ({ ...Object.fromEntries(["TRAINEE_DELIVER_SECRET", "TELEGRAM_BOT_TOKEN", "LOOPMESSAGE_API_KEY"].map((k) => [k, h.env.get(k) ?? ""])), ...env } as Record<string, string>)[k] || undefined };
    const s = h.W.delivery();
    return await handleDeliver(new Request("https://fn.test/", { method: "POST", headers: { "x-trainee-deliver-secret": "d".repeat(40) } }), {
      env: e, now: () => h.clock.t, store: () => s, send: (k: string) => loopSend({ apiKey: k, fetch: h.net, sleep: async () => {} }),
      adapters: (en) => adaptersFromEnv(en, { fetch: h.net, clock: () => h.clock.t, sleep: async (ms) => { h.clock.t += ms; } }), recordRun: async () => {},
    });
  };
  const none = harness();
  const r0 = await run(none, { LOOPMESSAGE_API_KEY: "", TELEGRAM_BOT_TOKEN: "" });
  eq(r0.status, 503); assert(/NOT_WIRED/.test((await r0.json()).error));
  const h = harness();
  await h.text("imessage", ADDR.imessage, "hi"); await h.text("telegram", ADDR.telegram, "hi");
  h.W.queue(h.userOf(ADDR.imessage)!, { key: "alert:i", kind: "alert", text: ALERT, at: h.clock.t });
  h.W.queue(h.userOf("tg:7001")!, { key: "alert:t", kind: "alert", text: ALERT, at: h.clock.t });
  const r1 = await (await run(h, { LOOPMESSAGE_API_KEY: "" })).json();
  eq([r1.delivered, r1.not_wired], [1, 1]);
  eq(h.W.outbox.find((o) => o.key === "alert:i")!.status, "queued", "kept for when iMessage is wired");
  // LoopMessage's contact cap (1 a day, already used by the "hi" answer) never holds back another provider.
  h.W.queue(h.userOf("tg:7001")!, { key: "alert:t2", kind: "alert", text: ALERT.replace("Acme", "Beta"), at: h.clock.t });
  const r2 = await (await run(h, { LOOPMESSAGE_DAILY_CONTACTS: "1", WHATSAPP_TOKEN: "" })).json();
  eq([r2.delivered, r2.capped], [2, 0], "the iMessage contact was already texted today, so it is not new; Telegram has no contact cap");
});

// ------------------------------------------------------------------------------------------------------- linking
Deno.test("WO-038/L1 Connect Telegram: a single-use 10-minute link, sent on the channel already linked, binds that chat on /start; no code is ever typed", async () => {
  const h = harness();
  await h.text("imessage", ADDR.imessage, "hi");
  const u = h.userOf(ADDR.imessage)!;
  const m = h.mark();
  await h.text("imessage", ADDR.imessage, "connect telegram");
  const reply = h.read(ADDR.imessage, m).join("\n");
  const link = /^https:\/\/t\.me\/TraineeTestBot\?start=([A-Za-z0-9_-]{32})$/m.exec(reply);
  assert(link, `a bare link on its own line: ${reply}`);
  eq(h.chats.length, 1, "the brain never saw it");
  // TELEGRAM LINK OWNERSHIP (2026-10-31): opening the link proves nothing about who opened it; the channel already linked is
  // asked, and only its YES binds the chat.
  const t = h.mark();
  await h.text("telegram", "7001", `/start ${link[1]}`);
  eq(h.read("7001", t), [TELEGRAM_LINK_CONFIRM_REPLY]);
  eq(h.userOf("tg:7001"), null, "not linked before the YES");
  const asked = h.read(ADDR.imessage, t);
  eq(asked.map((x) => x.replace(/reply LINK [0-9]{4} /, "reply LINK {code} ")), [telegramLinkAskText(null, "tg:7001")]);
  const y = h.mark();
  await h.text("imessage", ADDR.imessage, `LINK ${/reply LINK ([0-9]{4}) /.exec(asked[0] ?? "")?.[1] ?? "none"}`);
  eq(h.read("7001", y), [LINKED_HERE_REPLY]);
  eq(h.userOf("tg:7001"), u, "the chat joined the account the link was made for");
  await h.text("telegram", "7001", "find me data analyst jobs");
  eq([h.chats.at(-1).userId, h.chats.at(-1).threadId], [u, `t-${u}`], "same person, same thread");
  assert(h.read("7001").some((x) => x.startsWith("Here are two")), "the answer comes back on Telegram");
  assert(!h.read(ADDR.imessage).some((x) => x.startsWith("Here are two")), "not on iMessage");
  // Used once: another chat gets nothing from it; and an expired link does nothing.
  await h.text("telegram", "7002", `/start ${link[1]}`);
  eq(h.read("7002"), [TELEGRAM_LINK_INVALID_REPLY]);
  eq(h.userOf("tg:7002"), null);
  const n2 = await h.W.inbound.issueLinkNonce!(u, h.clock.t);
  h.clock.t += 11 * MIN;
  await h.text("telegram", "7004", `/start ${n2}`);
  eq([h.read("7004"), h.userOf("tg:7004")], [[TELEGRAM_LINK_INVALID_REPLY], null]);
  // A chat already linked to someone else is never moved.
  await h.text("imessage", "+15550005555", "hi");
  const n3 = await h.W.inbound.issueLinkNonce!(h.userOf("+15550005555")!, h.clock.t);
  await h.text("telegram", "7001", `/start ${n3}`);
  eq([h.read("7001").at(-1), h.userOf("tg:7001")], [TELEGRAM_LINKED_ELSEWHERE_REPLY, u]);
  // On Telegram itself, and without the bot's username: plain answers, no link.
  const before = h.mark();
  await h.text("telegram", "7001", "connect telegram");
  eq(h.read("7001", before), [ALREADY_TELEGRAM_REPLY]);
  const nb = harness({ env: { TELEGRAM_BOT_USERNAME: "" } });
  await nb.text("imessage", ADDR.imessage, "hi");
  const k = nb.mark();
  await nb.text("imessage", ADDR.imessage, "connect telegram");
  eq(nb.read(ADDR.imessage, k), [TELEGRAM_NOT_WIRED_REPLY]);
});

Deno.test("WO-038/L2 message text alone never binds an account: a made-up link token, a typed number, a /start with no token", async () => {
  const h = harness({ env: { TRAINEE_SIGNUP: "closed", TRAINEE_ALLOWED_CONTACTS: "+15550001111" } });
  await h.text("imessage", ADDR.imessage, "hi");
  await h.text("telegram", "7009", `/start ${"A".repeat(32)}`);
  eq([h.read("7009"), h.userOf("tg:7009")], [[TELEGRAM_LINK_INVALID_REPLY], null]);
  await h.text("telegram", "7010", "I am +15550001111, link me");
  await h.text("telegram", "7010", "/start");
  eq([h.userOf("tg:7010"), h.read("7010")], [null, [SIGNUP_CLOSED_REPLY]], "a stranger is a stranger, told once");
});

Deno.test("WO-038/L3 the same number on WhatsApp is never merged on its own: the linked channel is asked, and only its yes links it", async () => {
  const h = harness();
  await h.text("imessage", "+15550003333", "hi");
  const u = h.userOf("+15550003333")!;
  const m = h.mark();
  const first = await h.text("whatsapp", "15550003333", "hi from whatsapp");
  eq(first.results[0].link, "asked");
  eq(h.userOf("wa:15550003333"), null, "no account and no link yet");
  eq(h.chats.length, 1, "no turn");
  eq(h.read("+15550003333", m), [linkAskText("whatsapp")]);
  eq(h.read("+15550003333", m)[0], "Someone texted Trainee on WhatsApp from your number. Reply yes to link it.", "the owner's wording");
  eq(h.read("15550003333", m), [linkPendingReply("imessage")]);
  eq((await h.text("whatsapp", "15550003333", "hello?")).results[0].ignored, "link asked already");
  await h.text("imessage", "+15550003333", "find me data analyst jobs");
  eq([h.userOf("wa:15550003333"), h.chats.at(-1).message], [null, "find me data analyst jobs"], "only a yes links; anything else is an ordinary message");
  const y = h.mark();
  await h.text("imessage", "+15550003333", "yes");
  eq(h.userOf("wa:15550003333"), u, "linked on the yes");
  eq(h.read("+15550003333", y), [linkedReply("whatsapp")]);
  eq(h.read("15550003333", y), [LINKED_HERE_REPLY]);
  await h.text("whatsapp", "15550003333", "find me data analyst jobs");
  eq([h.chats.at(-1).userId, h.chats.at(-1).threadId], [u, `t-${u}`]);
  // No yes within the hour: nothing is linked, and a late "yes" is an ordinary message.
  const g = harness();
  await g.text("imessage", "+15550004444", "hi");
  await g.text("whatsapp", "15550004444", "hi");
  g.clock.t += 61 * MIN;
  await g.text("imessage", "+15550004444", "yes");
  eq([g.userOf("wa:15550004444"), g.chats.at(-1).message], [null, "yes"]);
  // The other way round: WhatsApp first, then iMessage from the same number asks on WhatsApp.
  const r = harness();
  await r.text("whatsapp", "15550006666", "hi");
  const k = r.mark();
  await r.text("imessage", "+15550006666", "hi");
  eq([r.read("15550006666", k), r.userOf("+15550006666")], [[linkAskText("imessage")], null]);
});

// ------------------------------------------------------------------------------------------------------- home channel
Deno.test("WO-038/H1 replies go out where the message came in; what Trainee starts goes to the home channel (the one set, else the last used); STOP and START are the person's", async () => {
  const h = harness();
  await h.text("imessage", ADDR.imessage, "hi");
  const u = h.userOf(ADDR.imessage)!;
  h.W.link("tg:7001", u, h.clock.t);
  await h.text("telegram", "7001", "hi from telegram");
  h.W.queue(u, { key: "alert:1", kind: "alert", text: ALERT, at: h.clock.t });
  await h.runDeliver();
  // iMessage splits a message into bubbles; what the person reads is the joined text.
  const has = (addr: string, t: string, from = 0) => norm(h.read(addr, from)).includes(norm([t]));
  eq([has("7001", ALERT), has(ADDR.imessage, ALERT)], [true, false], "the last used channel");
  await h.text("imessage", ADDR.imessage, "back on imessage");
  h.W.queue(u, { key: "alert:2", kind: "alert", text: ALERT.replace("Acme", "Beta"), at: h.clock.t });
  await h.runDeliver();
  assert(has(ADDR.imessage, ALERT.replace("Acme", "Beta")));
  h.W.contacts.get("tg:7001")!.home = true; // set by the person in the app (channel_set_home)
  const m = h.mark();
  await h.text("imessage", ADDR.imessage, "where do you answer?");
  eq(h.read(ADDR.imessage, m), ["You said: where do you answer?"], "the answer stays on the channel asked");
  h.W.queue(u, { key: "alert:3", kind: "alert", text: ALERT.replace("Acme", "Gamma"), at: h.clock.t });
  await h.runDeliver();
  assert(has("7001", ALERT.replace("Acme", "Gamma"), m), "the home channel the person set");
  await h.text("telegram", "7001", "STOP");
  h.W.queue(u, { key: "alert:4", kind: "alert", text: "x", at: h.clock.t });
  eq((await h.runDeliver()).skipped_opt_out, 1, "STOP on Telegram holds every channel");
  await h.text("imessage", ADDR.imessage, "START");
  assert(!h.W.contacts.get("tg:7001")!.optedOut, "START on iMessage turns Telegram back on");
});

// SERIAL-1480: a card's yes with no usable reply id is told how in the channel's own terms. Where this integration has a
// verified reply-id path (Telegram, WhatsApp Cloud): reply directly to the card, or tap. On iMessage, where it has none:
// tap the card, and never "reply".
Deno.test("SERIAL-1480 the needs-reply answer, word for word, per channel: Telegram and WhatsApp say reply or tap; iMessage says tap only", async () => {
  const { NEEDS_REPLY_CHANNEL, NEEDS_TAP_IMESSAGE } = await import("../../supabase/functions/_shared/career_apply_cards.ts");
  const h = harness({ brainResult: (m) => m === "yes" ? { reply: "Nothing was approved. To approve, reply directly to the card message (press and hold it, then Reply) and send \"yes\", or tap Approve in the app.", resultStatus: "needs_reply" } : null });
  const cases: [Channel, string, string][] = [["imessage", "+15550001001", NEEDS_TAP_IMESSAGE], ["telegram", "7101", NEEDS_REPLY_CHANNEL], ["whatsapp", "15550001003", NEEDS_REPLY_CHANNEL]];
  for (const [ch, from, want] of cases) {
    await h.text(ch, from, "hi");
    const before = h.sent.length;
    await h.text(ch, from, "yes");
    const mine = h.sent.slice(before).filter((s) => s.channel === ch);
    assert(mine.length >= 1, `${ch}: a reply went out`);
    eq(mine.at(-1)!.text, want, `${ch}: the exact wording`);
    if (ch === "imessage") assert(!/reply/i.test(mine.at(-1)!.text), "iMessage is never told to reply");
    else assert(/reply directly to the card/.test(mine.at(-1)!.text) && /tap Approve/.test(mine.at(-1)!.text), `${ch}: reply or tap`);
  }
});
