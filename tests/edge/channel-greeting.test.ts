// GREETING (owner, 2026-11-05): when a person opens Trainee or starts a conversation, Trainee texts exactly
// "Hey I'm Trainee, your personal career assistant, how can I help you?", once per new conversation, through the outbox (an
// answer row: pacing, the at-most-once key and STOP apply). A new conversation is an account its first message made; that
// message gets the greeting and then the answer to it, in the same turn, greeting first (a bare /start and the shared phone
// too: their turn is what tests/architect/flow-scenarios-telegram-r2.test.ts and flow-scenarios-telegram.test.ts require);
// a person who already had an account is not greeted (flow-scenarios-telegram*.test.ts seed such people and read exactly
// their answers); the answer is the same on Telegram, WhatsApp and iMessage. Run through the real webhooks (tests/edge/channel_world.ts).
// Run: deno test -A --no-check tests/edge/channel-greeting.test.ts
import { CHANNEL_REPLIES } from "../../supabase/functions/_shared/channel.ts";
import { GREETING, GREETING_KEY, SIGNUP_CLOSED_REPLY, TELEGRAM_LINK_INVALID_REPLY } from "../../supabase/functions/_shared/channel_inbound.ts";
import { ADDR, CHANNELS, channelWorld, plain, words } from "./channel_world.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }

Deno.test("greeting: the owner's exact words", () => {
  eq(GREETING, "Hey I'm Trainee, your personal career assistant, how can I help you?");
});

const REQUESTS = ["find me product design internships in NYC", "help me negotiate an offer"];
Deno.test("greeting (a): a first message that asks for something gets the greeting, then its answer, in that order, the same on every channel", async () => {
  for (const ask of REQUESTS) {
    const seen: Record<string, string> = {};
    for (const ch of CHANNELS) {
      const h = channelWorld();
      const r = await h.text(ch, ADDR[ch], ask);
      const msgs = h.read(ADDR[ch]);
      eq(plain(msgs[0]?.text), GREETING, `${ch}: the greeting comes first, exactly`);
      assert(msgs.length >= 2, `${ch}: the request is answered in the same turn: ${JSON.stringify(msgs)}`);
      eq(h.agentCalls.length, 1, `${ch}: the request ran one turn`);
      eq(h.agentCalls[0].message, ask, `${ch}: the brain got the person's own words, never the greeting`);
      const body = (r.results?.[0] ?? r) as Record<string, unknown>;
      eq([body.replied, body.greeted], [true, true], `${ch}: ${JSON.stringify(r)}`);
      const row = h.W.outbox.find((o) => o.key === GREETING_KEY)!;
      eq([row.kind, row.status, row.channel, row.text], ["reply", "delivered", ch, GREETING], `${ch}: the greeting is an answer row of the outbox, on the channel it answers`);
      seen[ch] = words(msgs);
    }
    eq(seen.whatsapp, seen.telegram, "WhatsApp reads what Telegram reads");
    eq(seen.imessage, seen.telegram, "iMessage reads what Telegram reads");
    eq(seen.telegram, `${GREETING} Answer to: ${ask}`);
  }
});

Deno.test("greeting (b): Telegram's bare /start and its shared phone open get the greeting, then their first turn (as before the greeting)", async () => {
  const h = channelWorld();
  const r = await h.text("telegram", ADDR.telegram, "/start");
  eq([r.results[0].replied, r.results[0].greeted], [true, true], JSON.stringify(r));
  eq(h.read(ADDR.telegram).map((m) => plain(m.text)), [GREETING, "Answer to: /start"]);
  eq(h.agentCalls.map((c) => c.message), ["/start"], "the open is still the person's first turn");
  // The shared phone (PHONE LOGIN) with sign-up open makes the account: also an open with no words.
  const p = channelWorld();
  const res = await p.tgPost(p.tgMessage("7002", { contact: { phone_number: "+15550009999", user_id: 7002 } }));
  eq((await res.json()).results[0].greeted, true);
  eq(p.read("7002").map((m) => plain(m.text)), [GREETING, "Answer to: /start"]);
  eq(p.agentCalls.map((c) => c.message), ["/start"]);
});

Deno.test("greeting (b) on WhatsApp and iMessage: there is no open without words there; a texted hello gets the greeting first, then the brain's answer (open decision: see the PR)", async () => {
  for (const ch of ["whatsapp", "imessage"] as const) {
    const h = channelWorld();
    await h.text(ch, ADDR[ch], "hi");
    const msgs = h.read(ADDR[ch]).map((m) => plain(m.text));
    eq(msgs[0], GREETING, `${ch}: greeting first`);
    eq(msgs.slice(1).join(" "), "Answer to: hi", `${ch}: then the turn's answer`);
  }
});

Deno.test("greeting (c): the answer after the greeting is the same on every channel, and so is what the brain is asked", async () => {
  const asks: Record<string, unknown>[] = [];
  for (const ch of CHANNELS) {
    const h = channelWorld();
    await h.text(ch, ADDR[ch], REQUESTS[0]);
    const { channel, turn_key: _k, as_user_id: _u, ...rest } = h.agentCalls[0] as Record<string, unknown>;
    eq(channel, ch, `${ch}: the webhook names its channel to agent-chat`);
    asks.push(rest);
  }
  eq(asks[1], asks[0], "WhatsApp asks agent-chat what Telegram asks");
  eq(asks[2], asks[0], "iMessage asks agent-chat what Telegram asks");
});

Deno.test("greeting: once per conversation: /start spam, a retried webhook, the next message and a second open never greet again", async () => {
  const h = channelWorld();
  await h.text("telegram", ADDR.telegram, "/start");
  await h.text("telegram", ADDR.telegram, "/start");
  await h.text("telegram", ADDR.telegram, "/start");
  await h.text("telegram", ADDR.telegram, "find me jobs");
  const greetings = h.read(ADDR.telegram).filter((m) => plain(m.text) === GREETING);
  eq(greetings.length, 1, "one greeting for one conversation");
  eq(h.W.outbox.filter((o) => o.key === GREETING_KEY).length, 1);
  for (const ch of ["whatsapp", "imessage"] as const) {
    const w = channelWorld();
    const id = ch === "whatsapp" ? "wamid.in.retry" : "lm-in-retry";
    await w.text(ch, ADDR[ch], "find me jobs", id);
    await w.text(ch, ADDR[ch], "find me jobs", id); // the provider retried the same webhook
    await w.text(ch, ADDR[ch], "and in Chicago?");
    await w.text(ch, ADDR[ch], "hi");
    eq(w.read(ADDR[ch]).filter((m) => plain(m.text) === GREETING).length, 1, `${ch}: one greeting`);
    eq(w.agentCalls.length, 3, `${ch}: the retry ran no second turn`);
  }
});

Deno.test("greeting: a person who already has an account is never greeted, on any channel, with or without a thread", async () => {
  for (const ch of CHANNELS) {
    for (const thread of [true, false]) {
      const h = channelWorld();
      // A conversation that started before the greeting existed (no greeting row), with a thread or not yet one.
      const u = (await h.W.inbound.createPerson(h.contactOf(ch, ADDR[ch]), h.clock.t, null)).userId;
      if (thread) await h.W.inbound.setThread(h.contactOf(ch, ADDR[ch]), "t-old", u);
      await h.text(ch, ADDR[ch], "find me jobs");
      eq(h.read(ADDR[ch]).map((m) => plain(m.text)), ["Answer to: find me jobs"], `${ch} (thread ${thread}): no greeting mid-conversation`);
      eq(h.W.outbox.filter((o) => o.key === GREETING_KEY).length, 0);
    }
  }
});

Deno.test("greeting: what must come first still does: STOP, HELP and sign-up refusal keep their fixed words; a Telegram link code keeps its flow", async () => {
  for (const ch of CHANNELS) {
    const h = channelWorld();
    await h.text(ch, ADDR[ch], "STOP");
    eq(h.read(ADDR[ch]).map((m) => plain(m.text)), [CHANNEL_REPLIES.stop], `${ch}: STOP first is the fixed opt-out reply only`);
    const c = channelWorld({ env: { TRAINEE_SIGNUP: "closed" } });
    await c.text(ch, ADDR[ch], "find me jobs");
    eq(c.read(ADDR[ch]).map((m) => plain(m.text)), [SIGNUP_CLOSED_REPLY], `${ch}: a refused sign-up is not greeted`);
    eq(c.W.outbox.length, 0);
    const hp = channelWorld();
    await hp.text(ch, ADDR[ch], "HELP");
    eq(hp.read(ADDR[ch]).map((m) => plain(m.text)), [CHANNEL_REPLIES.help], `${ch}: HELP first keeps the fixed HELP words`);
  }
  // A link code (Telegram link security): /start <code> answers the link flow and nothing else.
  const t = channelWorld();
  await t.text("telegram", "7003", "/start abcdefghijklmnopqrstuvwxyz012345");
  eq(t.read("7003").map((m) => plain(m.text)), [TELEGRAM_LINK_INVALID_REPLY], "a link code is answered by the link flow, not greeted");
  // After STOP, a person's own first request is answered (the greeting and the answer are replies to their message).
  const s = channelWorld();
  await s.text("whatsapp", ADDR.whatsapp, "STOP");
  await s.text("whatsapp", ADDR.whatsapp, "find me jobs");
  eq(s.read(ADDR.whatsapp).map((m) => plain(m.text)), [CHANNEL_REPLIES.stop, GREETING, "Answer to: find me jobs"]);
});

Deno.test("greeting: a known person's /start after STOP is answered exactly as before the greeting (the back-on words with its turn's answer; not a new conversation)", async () => {
  const h = channelWorld();
  const contact = h.contactOf("telegram", ADDR.telegram);
  await h.W.inbound.createPerson(contact, h.clock.t, null);
  await h.W.inbound.setOptOut(contact, true, h.clock.t);
  await h.text("telegram", ADDR.telegram, "/start");
  eq(h.read(ADDR.telegram).map((m) => plain(m.text)), [`${CHANNEL_REPLIES.start}\n\nAnswer to: /start`]);
  assert(!h.W.contacts.get(contact)!.optedOut, "/start lifted the STOP");
  await h.text("telegram", ADDR.telegram, "/start");
  eq(h.agentCalls.map((c) => c.message), ["/start", "/start"], "each /start is a turn, as before the greeting");
  eq(h.W.outbox.filter((o) => o.key === GREETING_KEY).length, 0, "never greeted");
});

Deno.test("greeting: a store without greetOnce (written before it) runs exactly as before", async () => {
  const h = channelWorld({ greeting: false });
  await h.text("telegram", ADDR.telegram, "/start");
  eq(h.agentCalls.map((c) => c.message), ["/start"]);
  assert(!h.read(ADDR.telegram).some((m) => plain(m.text) === GREETING));
});
