// N12 / N13 (behavior map, spec 16 speed): on Telegram the person sees Trainee working at once, and a slow turn says so.
//   - sendChatAction "typing" goes out as soon as a message arrives (before the turn starts), and again every 4 s while it
//     runs; nothing after the answer.
//   - a turn still running after the latency budget (6 s) gets ONE short interim line that says what Trainee is doing
//     (ackFor: never a result), then the real answer; never two interims, even when a file is read first and the chat
//     after it; a fast turn gets none.
// Through the real webhook (handleTelegram), the real Telegram adapter over a fake Bot API, the real inbound core and
// outbox (the in-memory channel world), on a fake clock the test drives. Assertions are on what Telegram was asked to do
// and on the outbox rows.
// Fail-first on trunk 5d6857219: no sendChatAction is ever made, no interim is sent, and the budget constants do not exist.
import * as Voice from "../../supabase/functions/_shared/channel_voice.ts";
import { ackFor } from "../../supabase/functions/_shared/channel_voice.ts";
import { memoryChannelWorld } from "../../supabase/functions/_shared/channel_memory.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { deliverDue } from "../../supabase/functions/_shared/channel.ts";
import { TELEGRAM_API } from "../../supabase/functions/_shared/telegram.ts";
import { handleTelegram, webhookDeps } from "../../supabase/functions/trainee-telegram/handler.ts";
import { CHAT_DOWN_REPLY, handleChannelWebhook } from "../../supabase/functions/_shared/channel_inbound.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const TOKEN = "123456:fake-telegram-token-TTTTTTTT", SECRET = "t".repeat(40), CHAT = "7001";

// A clock the test moves: timers fire in order as it advances, and each one's sends settle before the next.
function fakeTimers() {
  let t = 0, seq = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  return {
    now: () => t,
    pending: () => q.size,
    set: (fn: () => void, ms: number) => { const id = ++seq; q.set(id, { at: t + ms, fn }); return id; },
    clear: (h: unknown) => { q.delete(h as number); },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let best: number | null = null;
        for (const [id, e] of q) if (e.at <= end && (best === null || e.at < q.get(best)!.at)) best = id;
        if (best === null) break;
        const e = q.get(best)!;
        q.delete(best);
        t = e.at;
        e.fn();
        await settle();
      }
      t = end;
      await settle();
    },
  };
}

type Ev = { what: "typing" | "send" | "chat:start" | "chat:end" | "file:start" | "file:end"; at: number; text?: string };
function world(o: { turnMs?: number; reply?: string; typingStatus?: number; chatThrows?: boolean; deliverMs?: number; ackSendMs?: number } = {}) {
  const W = memoryChannelWorld();
  const timers = fakeTimers();
  const events: Ev[] = [];
  let n = 0, upd = 5000;
  const net = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url === `${TELEGRAM_API}/bot${TOKEN}/sendChatAction`) {
      events.push({ what: "typing", at: timers.now(), text: body.action });
      const status = o.typingStatus ?? 200;
      return new Response(JSON.stringify(status === 200 ? { ok: true, result: true } : { ok: false, error_code: status, description: "Too Many Requests", parameters: { retry_after: 2 } }), { status });
    }
    if (url === `${TELEGRAM_API}/bot${TOKEN}/sendMessage`) {
      // Telegram slow to take the interim: it is recorded when Telegram has it, not when it was asked.
      if (o.ackSendMs && /^on it/.test(body.text)) await new Promise((r) => setTimeout(r, o.ackSendMs));
      events.push({ what: "send", at: timers.now(), text: body.text });
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++n } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  const vars: Record<string, string> = { TRAINEE_SIGNUP: "open", TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_USERNAME: "TraineeTestBot" };
  const env = { get: (k: string) => vars[k] || undefined };
  let sendClock = 0;
  const adapters = adaptersFromEnv(env, { fetch: net, clock: () => sendClock, sleep: async (ms) => { sendClock += ms; } });
  const reply = o.reply ?? "Here are two data analyst roles in Chicago.";
  const chat = async (a: { message: string; userId: string }) => {
    events.push({ what: "chat:start", at: timers.now(), text: a.message });
    if (o.turnMs) await timers.advance(o.turnMs);
    events.push({ what: "chat:end", at: timers.now() });
    if (o.chatThrows) throw new Error("agent-chat HTTP 500");
    return { status: 200, reply, threadId: `t-${a.userId}` };
  };
  const deliver = async (a: { userId: string; key: string }) => {
    if (o.deliverMs) await timers.advance(o.deliverMs); // Telegram slow to take the answer
    const s = W.delivery({ only: { userId: a.userId, key: a.key } });
    const r = await deliverDue({ store: s, adapters, now: 1_000_000 });
    await s.release();
    return r;
  };
  const deps = { env, now: () => 1_000_000, store: () => W.inbound, chat, deliver, adapter: () => adapters.telegram!, timers: { set: timers.set, clear: timers.clear } };
  const update = (text: string, extra: Record<string, unknown> = {}) => ({ update_id: ++upd, message: { message_id: upd, from: { id: Number(CHAT), is_bot: false }, chat: { id: Number(CHAT), type: "private" }, date: 1, text, ...extra } });
  const req = (u: unknown) => new Request("https://fn.test/trainee-telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify(u) });
  const post = async (text: string) => { const u = update(text); const r = await handleTelegram(req(u), deps as any); return { body: await r.json(), updateId: u.update_id }; };
  const rowsOf = () => W.outbox.filter((r) => r.userId === W.contacts.get(`tg:${CHAT}`)?.userId);
  return { W, timers, events, post, deps, adapters, update, req, rowsOf, reply };
}
const typings = (ev: Ev[]) => ev.filter((e) => e.what === "typing");
const sends = (ev: Ev[]) => ev.filter((e) => e.what === "send").map((e) => e.text);
const idx = (ev: Ev[], what: Ev["what"]) => ev.findIndex((e) => e.what === what);

Deno.test("N13: the latency budget is code: typing every 4 s, one interim after 6 s, and Telegram's webhook runs on it", () => {
  eq((Voice as any).TYPING_EVERY_MS, 4000, "TYPING_EVERY_MS");
  eq((Voice as any).FAST_ACK_MS, 6000, "FAST_ACK_MS");
  const h = world();
  const core: any = webhookDeps(h.adapters.telegram!, h.deps as any);
  eq(core.ackAfterMs, 6000, "the Telegram webhook arms the interim at the budget");
  eq(core.typingEveryMs, 4000, "the Telegram webhook refreshes typing at the budget");
  assert(typeof core.typing === "function", "the Telegram webhook shows typing");
  // Every interim says what Trainee is doing, never a bare "one sec".
  for (const m of ["hello", "hmm ok", "what do you think", "find me jobs in Austin", "apply to Acme", "read my resume", "draft an email", "mock interview me"]) {
    const a = ackFor(m);
    assert(/^on it — [a-z ]+ (?:now|ready)$|^on it — checking your applications$/.test(a) && !/one sec/.test(a), `the interim for "${m}" says what Trainee is doing: ${a}`);
  }
});

Deno.test("N12: typing goes out before the turn starts and every 4 s while it runs; a slow turn gets ONE honest interim, then the answer", async () => {
  const msg = "find me data analyst jobs in Chicago";
  const h = world({ turnMs: 9000 });
  const r = await h.post(msg);
  assert(r.body.ok === true, JSON.stringify(r.body));
  const ev = h.events;
  eq(ev[0]?.what, "typing", `the first thing Telegram is asked is typing, before the turn starts: ${JSON.stringify(ev.slice(0, 3))}`);
  assert(idx(ev, "typing") < idx(ev, "chat:start"), "typing precedes the turn");
  eq(ev[0]?.text, "typing", "sendChatAction action is typing");
  // 0 s, 4 s, 8 s while the 9 s turn runs.
  eq(typings(ev).map((e) => e.at), [0, 4000, 8000], "typing at once and every 4 s while the turn runs");
  const interim = ackFor(msg);
  eq(sends(ev), [interim, h.reply], "exactly one interim, then the answer");
  const ackAt = ev.find((e) => e.what === "send" && e.text === interim)!;
  eq(ackAt.at, 6000, "the interim goes at the 6 s budget");
  assert(ev.indexOf(ackAt) > idx(ev, "chat:start") && ev.indexOf(ackAt) < idx(ev, "chat:end"), "the interim is sent while the turn runs");
  assert(!/\b(found|sent|submitted|applied|done|here (?:are|is)|\d)\b/i.test(interim), `the interim claims no result: ${interim}`);
  assert(/looking for roles/.test(interim), `the interim says what Trainee is doing: ${interim}`);
  // Outbox: the answer is the one row, delivered; the interim never sat in the outbox (it could not arrive after the answer).
  const rows = h.rowsOf();
  eq(rows.map((x) => [x.key, x.status, x.text]), [[`reply:tg:${r.updateId}`, "delivered", h.reply]], "one outbox row: the answer, delivered");
  // Nothing more once the turn is over.
  eq(h.timers.pending(), 0, "no timer left armed after the turn");
  const before = ev.length;
  await h.timers.advance(30000);
  eq(ev.length, before, "no typing and no interim after the answer");
});

Deno.test("N12: a retried update (the same update_id) shows no typing and sends nothing", async () => {
  const h = world({ turnMs: 1000 });
  const u = h.update("hello");
  await handleTelegram(h.req(u), h.deps as any);
  const before = h.events.length;
  await handleTelegram(h.req(u), h.deps as any);
  eq(h.events.slice(before), [], "nothing at all for a retried update");
});

Deno.test("N12: a fast turn gets typing once and no interim", async () => {
  const h = world({ turnMs: 1500 });
  const r = await h.post("what's my next step");
  assert(r.body.ok === true, JSON.stringify(r.body));
  eq(typings(h.events).length, 1, "typing once, before the turn");
  eq(sends(h.events), [h.reply], "no interim: only the answer");
  eq(h.rowsOf().map((x) => x.status), ["delivered"], "the answer delivered");
  eq(h.timers.pending(), 0, "nothing left armed");
});

Deno.test("N12: the interim is disarmed when the turn ends: a fast turn whose answer is slow to deliver gets no interim", async () => {
  const h = world({ turnMs: 1000, deliverMs: 9000 });
  await h.post("what's my next step");
  eq(sends(h.events), [h.reply], "no interim once the turn is over, however long delivery takes");
  eq(h.timers.pending(), 0, "nothing left armed");
});

Deno.test("N12: a very slow turn (30 s) still gets one interim, never two; typing keeps refreshing until it ends", async () => {
  const h = world({ turnMs: 30000 });
  await h.post("draft an email to the recruiter at Acme");
  eq(sends(h.events), [ackFor("draft an email to the recruiter at Acme"), h.reply], "one interim, then the answer");
  eq(typings(h.events).map((e) => e.at), [0, 4000, 8000, 12000, 16000, 20000, 24000, 28000], "typing every 4 s for 30 s");
});

Deno.test("N12: a resume file read slowly, then a slow chat: ONE interim (reading it), armed at the file, never a second for the chat", async () => {
  const h = world({ turnMs: 8000 });
  const core: any = { ...webhookDeps(h.adapters.telegram!, h.deps as any), resumeFile: async () => {
    h.events.push({ what: "file:start", at: h.timers.now() });
    await h.timers.advance(5000);
    h.events.push({ what: "file:end", at: h.timers.now() });
    return { ok: true, message: "here is my resume:\nEXPERIENCE\nAnalyst, Acme" };
  } };
  const u = h.update("", { document: { file_id: "F1", file_unique_id: "U1", file_name: "resume.pdf", mime_type: "application/pdf", file_size: 2000 } });
  delete (u.message as any).text;
  const res = await handleChannelWebhook(h.req(u), h.adapters.telegram!, core);
  assert((await res.json()).ok === true, "handled");
  eq(sends(h.events), ["on it — reading that now", h.reply], "one interim (reading the file), then the answer");
  eq(h.events.find((e) => e.what === "send")!.at, 6000, "the interim at 6 s from the file's start, during the chat");
  eq(typings(h.events)[0]?.at, 0, "typing at once for the file");
  eq(h.timers.pending(), 0, "nothing left armed");
});

Deno.test("N12: a failed typing call never touches the turn; a turn that fails after the interim says it could not answer", async () => {
  const h = world({ turnMs: 1000, typingStatus: 500 });
  await h.post("hello");
  eq(sends(h.events), [h.reply], "the answer still goes when typing fails");
  const busy = world({ turnMs: 1000, typingStatus: 429 });
  await busy.post("hello");
  eq(typings(busy.events).length, 1, "a typing call Telegram refused with a 429 is not waited on or retried");
  eq(sends(busy.events), [busy.reply], "the answer goes");
  const k = world({ turnMs: 7000, chatThrows: true });
  await k.post("find me jobs in Austin");
  eq(sends(k.events), [ackFor("find me jobs in Austin"), CHAT_DOWN_REPLY], "the interim, then the plain failure line; no result is claimed");
});

Deno.test("N12: an interim still on its way when the turn ends reaches the person BEFORE the answer, never after it", async () => {
  const h = world({ turnMs: 6500, ackSendMs: 80 });
  const msg = "find me data analyst jobs in Chicago";
  await h.post(msg);
  eq(sends(h.events), [ackFor(msg), h.reply], "the interim Telegram was still taking lands first; nothing interim after the answer");
  eq(h.timers.pending(), 0, "nothing left armed");
});

Deno.test("N12: a timer that fires after stop() (the clock could not cancel it) sends no interim and shows no typing", async () => {
  const fired: (() => void)[] = [];
  const timers = { setTimer: (fn: () => void) => { fired.push(fn); return fired.length; }, clearTimer: () => {} }; // a clear that cancels nothing
  let acks = 0, typings = 0;
  const a = Voice.ackOnce({ afterMs: 6000, ack: async () => { acks++; }, ...timers });
  a.start();
  eq(await a.stop(), false, "no interim went");
  for (const f of fired.splice(0)) f();
  eq(acks, 0, "a late timer after stop() sends no interim");
  const t = Voice.typingLoop({ typing: async () => { typings++; }, everyMs: 4000, ...timers });
  eq(typings, 1, "typing at once");
  await t.stop();
  for (const f of fired.splice(0)) f();
  eq(typings, 1, "a late tick after stop() shows no typing");
  eq(fired.length, 0, "and arms nothing again");
});
