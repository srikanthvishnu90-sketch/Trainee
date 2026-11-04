// D-MS-1 / D-MS-2 channel parity (owner, 2026-10-27: "a texted yes, any channel"). The same mass batch on iMessage
// (LoopMessage; no reply id, ever), Telegram and WhatsApp Cloud: each through its real webhook handler, the real inbound
// core, the real delivery run and the provider's real adapter, over an in-memory channel world and a fake network. The
// chat behind them is the card turn itself (cardTurn over the in-memory card database of mass-submit-fixture.ts), wired as
// agent-chat wires it: the card's pages as `parts`, its id as `cardId`, the reply's status. A plain "yes" approves the
// 60 shown, once, on every channel; "wait" and "maybe" approve nothing; a yes in reply to a message that is not the card
// approves nothing (Telegram, WhatsApp). The web app's half is the handler test (mass-submit-handler-pg.test.ts).
import { memoryChannelWorld } from "../../supabase/functions/_shared/channel_memory.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { deliverDue } from "../../supabase/functions/_shared/channel.ts";
import type { Channel } from "../../supabase/functions/_shared/channel_adapters.ts";
import { LOOPMESSAGE_SEND_URL, loopSend } from "../../supabase/functions/_shared/loopmessage.ts";
import { TELEGRAM_API } from "../../supabase/functions/_shared/telegram.ts";
import { WHATSAPP_GRAPH, whatsappSignature } from "../../supabase/functions/_shared/whatsapp.ts";
import { CUT_NOTE } from "../../supabase/functions/_shared/conversation.ts";
import { cardButtons, tapCard, type TapStore } from "../../supabase/functions/_shared/channel_card_tap.ts";
import { runInbound } from "../../supabase/functions/_shared/channel_inbound.ts";
import type { EventStore } from "../../supabase/functions/_shared/agent/timeline.ts";
import { handleInbound } from "../../supabase/functions/trainee-inbound/handler.ts";
import { handleTelegram } from "../../supabase/functions/trainee-telegram/handler.ts";
import { handleWhatsApp } from "../../supabase/functions/trainee-whatsapp/handler.ts";
import { db, T } from "./mass-submit-fixture.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const SECRET = "i".repeat(40), TG_TOKEN = "123456:fake-telegram-token-TTTTTTTT", TG_SECRET = "t".repeat(40);
const WA_TOKEN = "fake-wa-token-WWWWWWWW", WA_APP = "fake-wa-app-secret-AAAAAAAA", WA_VERIFY = "v".repeat(40), PNID = "100200300";
const ADDR: Record<Channel, string> = { imessage: "+15550003333", whatsapp: "15550004444", telegram: "7333" };
const norm = (texts: string[]) => texts.join("\n").replace(/\s+/g, " ").trim();

function harness(n: number) {
  const W = memoryChannelWorld();
  const clock = { t: T };
  const sleep = async (ms: number) => { clock.t += ms; };
  const sent: { channel: Channel; address: string; text: string; id: string }[] = [];
  let seq = 0, upd = 5000, msgSeq = 0;
  const resp = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  const net = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url === LOOPMESSAGE_SEND_URL) { const id = `lm-${++seq}`; sent.push({ channel: "imessage", address: body.contact, text: body.text, id }); return resp({ message_id: id }); }
    if (url.startsWith(`${TELEGRAM_API}/bot${TG_TOKEN}/sendMessage`)) { const id = ++seq; sent.push({ channel: "telegram", address: String(body.chat_id), text: body.text, id: String(id) }); return resp({ ok: true, result: { message_id: id } }); }
    if (url === `${WHATSAPP_GRAPH}/v21.0/${PNID}/messages`) { const id = `wamid.out.${++seq}`; sent.push({ channel: "whatsapp", address: body.to, text: body.text?.body ?? "", id }); return resp({ messages: [{ id }] }); }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const vars: Record<string, string> = {
    TRAINEE_INBOUND_SECRET: SECRET, LOOPMESSAGE_API_KEY: "fake-loop-key", TRAINEE_SIGNUP: "open",
    TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_WEBHOOK_SECRET: TG_SECRET, TELEGRAM_BOT_USERNAME: "TraineeTestBot",
    WHATSAPP_TOKEN: WA_TOKEN, WHATSAPP_PHONE_NUMBER_ID: PNID, WHATSAPP_APP_SECRET: WA_APP, WHATSAPP_VERIFY_TOKEN: WA_VERIFY, WHATSAPP_TEMPLATE_UPDATES: "trainee_updates",
  };
  const env = { get: (k: string) => vars[k] || undefined };
  const adapters = adaptersFromEnv(env, { fetch: net, clock: () => clock.t, sleep });
  const cards = db({ n });
  // The provider ids of the texts that carried the card (as career_outbox.provider_id records them, SERIAL-1462).
  const cardTexts = new Set<string>();
  const chat = async (a: { message: string; replyToMessageId?: string | null }) => {
    cards.setNow(clock.t);
    const replyTo = a.replyToMessageId ? (cardTexts.has(a.replyToMessageId) ? `M-${cards.cards.at(-1)!.id}-${cards.cards.length}` : `not-a-card:${a.replyToMessageId}`) : undefined;
    const r = await cards.say(a.message, { replyTo, at: clock.t });
    if (!r) return { status: 200, reply: `You said: ${a.message}`, threadId: "t-1" };
    return { status: 200, reply: r.reply, threadId: "t-1", ...(r.parts ? { parts: r.parts } : {}), ...(r.status === "shown" && r.card_id ? { cardId: r.card_id } : {}), resultStatus: r.status };
  };
  const runDeliver = async (scope?: { only?: { userId: string; key: string }; user?: string }) => {
    const s = W.delivery(scope);
    const r = await deliverDue({ store: s, adapters, now: clock.t });
    await s.release();
    return r;
  };
  const deps = (ch: "telegram" | "whatsapp") => ({
    env, now: () => clock.t, store: () => W.inbound, chat,
    deliver: (a: any) => runDeliver(ch === "whatsapp" ? { user: a.userId } : { only: { userId: a.userId, key: a.key } }).then(() => {}),
    adapter: adapters[ch] ? () => adapters[ch]! : undefined,
  });
  const text = async (ch: Channel, body: string, replyTo?: string) => {
    clock.t += 2000;
    const id = `in-${++msgSeq}`;
    if (ch === "imessage") {
      return await handleInbound(new Request(`https://fn.test/trainee-inbound?secret=${SECRET}`, { method: "POST", body: JSON.stringify({ alert_type: "message_inbound", message_id: id, recipient: ADDR.imessage, text: body }) }), {
        env, now: () => clock.t, store: () => W.inbound, send: (apiKey: string) => loopSend({ apiKey, fetch: net, sleep }), chat,
        deliverReply: (a: any) => runDeliver({ only: { userId: a.userId, key: a.key } }).then(() => {}),
      } as any);
    }
    if (ch === "telegram") {
      const u = { update_id: ++upd, message: { message_id: ++msgSeq, from: { id: Number(ADDR.telegram), is_bot: false }, chat: { id: Number(ADDR.telegram), type: "private" }, date: Math.floor(clock.t / 1000), text: body, ...(replyTo ? { reply_to_message: { message_id: Number(replyTo) } } : {}) } };
      return await handleTelegram(new Request("https://fn.test/trainee-telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": TG_SECRET }, body: JSON.stringify(u) }), deps("telegram") as any);
    }
    const b = { object: "whatsapp_business_account", entry: [{ id: "WABA1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp", metadata: { phone_number_id: PNID }, contacts: [{ wa_id: ADDR.whatsapp, profile: { name: "Test Person" } }],
      messages: [{ from: ADDR.whatsapp, id: `wamid.in.${id}`, timestamp: String(Math.floor(clock.t / 1000)), type: "text", text: { body }, ...(replyTo ? { context: { id: replyTo } } : {}) }] } }] }] };
    const raw = new TextEncoder().encode(JSON.stringify(b));
    return await handleWhatsApp(new Request("https://fn.test/trainee-whatsapp", { method: "POST", headers: { "x-hub-signature-256": await whatsappSignature(WA_APP, raw) }, body: raw }), deps("whatsapp") as any);
  };
  const mark = () => sent.length;
  const read = (ch: Channel, from = 0) => sent.slice(from).filter((s) => s.channel === ch && s.address === ADDR[ch]);
  const markCard = (ch: Channel, from: number) => { for (const s of read(ch, from)) cardTexts.add(s.id); };
  // The outbox rows written so far (one per message part a reply is delivered in).
  const outboxRows = () => W.outbox.length;
  return { cards, text, mark, read, markCard, sent, outboxRows };
}
const CHANNELS: Channel[] = ["imessage", "telegram", "whatsapp"];

Deno.test("D-MS-1/C1 sixty applications on one card on every channel; one plain texted yes approves all 60, once; every channel reads the same", async () => {
  const seen: Record<string, string> = {};
  for (const ch of CHANNELS) {
    const h = harness(60);
    await h.text(ch, "hi");
    const m0 = h.mark();
    await h.text(ch, "show my applications");
    const card = h.read(ch, m0).map((s) => s.text);
    assert(card.length > 1, `${ch}: the card came in several messages (${card.length})`);
    for (const p of h.cards.prepared) for (const l of p.card_lines) assert(norm(card).includes(norm([l])), `${ch}: every line arrives: ${l}`);
    eq(h.cards.cards[0].items.length, 60, `${ch}: one card of 60`);
    const m1 = h.mark();
    await h.text(ch, "yes");
    const answer = norm(h.read(ch, m1).map((s) => s.text));
    eq(h.cards.answerCalls.map((c) => c.approve.length), [60], `${ch}: one approval call for all 60`);
    eq(h.cards.queue.length, 60, `${ch}: 60 queued`);
    assert(answer.startsWith("60 approved exactly as shown. Nothing has gone to an employer yet."), `${ch}: ${answer.slice(0, 200)}`);
    const m2 = h.mark();
    await h.text(ch, "yes");
    eq([h.cards.queue.length, h.cards.answerCalls.length], [60, 1], `${ch}: a second yes approves nothing more`);
    eq(norm(h.read(ch, m2).map((s) => s.text)), "That card was already answered. Nothing more was sent.", ch);
    seen[ch] = `${norm(card)} || ${answer}`;
  }
  eq(seen.telegram, seen.imessage, "Telegram reads what iMessage reads");
  eq(seen.whatsapp, seen.imessage, "WhatsApp reads what iMessage reads");
});

Deno.test("NO LIMITS/C4 a card of 500 (more than the old 30-part ceiling) arrives whole on every channel, every application, no cut note; one yes approves all 500", async () => {
  for (const ch of CHANNELS) {
    const h = harness(500);
    // Each application with its full read-back (8 answered questions), so the card runs well past 30 messages.
    for (const p of h.cards.prepared) p.card_lines.splice(2, 0, ...Array.from({ length: 8 }, (_, k) => `Question ${k + 1}: a confirmed answer for ${p.company}, read back from the form.`));
    await h.text(ch, "hi");
    const m0 = h.mark();
    const before = h.outboxRows();
    await h.text(ch, "show my applications");
    const sentParts = h.outboxRows() - before;
    assert(sentParts > 30, `${ch}: the card is ${sentParts} outbox rows, past the old ceiling of 30`);
    const got = norm(h.read(ch, m0).map((s) => s.text));
    for (const i of [1, 137, 250, 499, 500]) assert(got.includes(norm([h.cards.prepared[i - 1].card_lines[0]])), `${ch}: application ${i} arrives`);
    assert(got.includes(`Reply "yes" to send all 500`), `${ch}: the last page arrives`);
    assert(!got.includes(norm([CUT_NOTE])), `${ch}: nothing cut`);
    await h.text(ch, "yes");
    eq([h.cards.answerCalls.length, h.cards.answerCalls[0]?.approve.length, h.cards.queue.length], [1, 500, 500], ch);
  }
});

Deno.test("SCALE/C5 Telegram's 'Approve all 500' button (#194): one approval call with all 500, the timeline in one write, the full answer delivered in whole messages", async () => {
  const items = Array.from({ length: 500 }, (_, i) => ({ n: i + 1, prepared_id: `p${i + 1}`, payload_hash: (i % 10).toString().repeat(64) }));
  const card = { id: "11111111-2222-4333-8444-555555555500", items, state: "open" };
  const answered: number[][] = [];
  const store: TapStore = {
    card: async (_u, id) => (id === card.id ? card : null),
    prepared: async () => items.map((i) => ({ id: i.prepared_id, payload_hash: i.payload_hash })),
    answer: async (_u, _c, approve) => { answered.push(approve); return approve.map((n) => ({ n, company: `Scale Employer ${n}`, result: "queued" })); },
  };
  const writes: { many: number; one: number } = { many: 0, one: 0 };
  const events: EventStore = { add: async () => { writes.one++; }, addMany: async () => { writes.many++; }, recall: async () => [] };
  const [[approve]] = await cardButtons(card);
  eq(approve.text, "Approve all 500");
  const tap = await tapCard({ userId: "u", data: approve.data, now: T, store, events });
  eq([tap.status, answered.length, answered[0].length, writes], ["answered", 1, 500, { many: 1, one: 0 }]);
  assert(/^500 approved exactly as shown\./.test(tap.reply), tap.reply.slice(0, 80));
  assert(tap.parts && tap.parts.length > 1 && tap.parts.every((p) => p.length <= 3800) && tap.parts.join("\n") === tap.reply, "paged whole");
  // Through the inbound core: every part is its own outbox row, nothing cut.
  const queued: string[] = [];
  const d: any = {
    env: { get: () => undefined }, now: () => T, render: (t: string) => [t],
    store: { claimMessage: async () => true, person: async (c: string) => (c === "tg:1" ? { userId: "u", threadId: "t1", contact: c } : null), refusedBefore: async () => true,
      createPerson: async () => { throw new Error("no"); }, setThread: async () => {}, setOptOut: async () => {}, enqueueReply: async (_u: string, _k: string, t: string) => { queued.push(t); return true; } },
    reply: async () => ({ ok: true }), chat: async () => { throw new Error("a tap is never a chat turn"); }, deliver: async () => {},
    answerCallback: async () => true, cardTap: async () => tap,
  };
  await runInbound({ provider: "telegram", channel: "telegram", messageId: "cb-500", contact: "tg:1", address: "1", text: "", kind: "callback", callback: { id: "c1", data: approve.data, messageId: "7" } } as any, d);
  eq(queued.length, tap.parts!.length, "one outbox row per part");
  eq(queued.join("\n"), tap.reply, "the whole answer, nothing cut");
});

Deno.test("D-MS-1/C2 wait, maybe and 'yes except 2' on every channel: the first two approve nothing, the third approves the rest", async () => {
  for (const ch of CHANNELS) {
    const h = harness(3);
    await h.text(ch, "hi");
    await h.text(ch, "show my applications");
    for (const [m, start] of [["wait", "Okay, holding: nothing was approved"], ["maybe", "I couldn't tell which ones you mean, so nothing was approved."]]) {
      const k = h.mark();
      await h.text(ch, m);
      assert(norm(h.read(ch, k).map((s) => s.text)).startsWith(start), `${ch} "${m}"`);
      eq(h.cards.queue.length, 0, `${ch} "${m}": nothing queued`);
    }
    const k = h.mark();
    await h.text(ch, "yes except 2");
    eq(h.cards.answerCalls.map((c) => c.approve), [[1, 3]], ch);
    assert(norm(h.read(ch, k).map((s) => s.text)).startsWith("2 approved exactly as shown; 1 of the 3 not sent"), ch);
  }
});

Deno.test("D-MS-1/C3 Telegram and WhatsApp: a yes in reply to the card's own message approves; a yes in reply to some other message approves nothing and says how (iMessage has no reply id: not applicable)", async () => {
  for (const ch of ["telegram", "whatsapp"] as Channel[]) {
    const h = harness(3);
    await h.text(ch, "hi");
    const other = h.read(ch).at(-1)!.id; // the "You said: hi" message
    const m0 = h.mark();
    await h.text(ch, "show my applications");
    h.markCard(ch, m0);
    const cardMsg = h.read(ch, m0)[0].id;
    const k = h.mark();
    await h.text(ch, "yes", other);
    eq(h.cards.queue.length, 0, `${ch}: a reply to another message approves nothing`);
    assert(/^Nothing was approved\. To approve, reply directly to the card message/.test(h.read(ch, k).map((s) => s.text).join("\n")), ch);
    await h.text(ch, "yes", cardMsg);
    eq(h.cards.queue.length, 3, `${ch}: a reply to the card's message approves the batch`);
  }
});
