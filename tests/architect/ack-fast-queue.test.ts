// ACK FAST (CHAT_QUEUE, scale plan bottleneck 2): with CHAT_QUEUE=on the chat webhooks verify, dedupe by the provider's message id,
// write one queue row and answer 200 without waiting for the model; trainee-turn-worker runs the turn from the queue. With the
// flag off (the default) nothing changes. This file holds the edge-function side over an in-memory database and a fake network;
// the claim, lease, ordering, retry and at-most-once rules are tested on real Postgres in ack-fast-queue-pg.test.ts, and the whole
// Telegram journey with the flag on in telegram-acceptance-queue.test.ts.
// Run: deno test -A --no-check tests/architect/ack-fast-queue.test.ts
import { memoryChannelWorld } from "../../supabase/functions/_shared/channel_memory.ts";
import { adaptersFromEnv } from "../../supabase/functions/_shared/channel_registry.ts";
import { deliverDue } from "../../supabase/functions/_shared/channel.ts";
import { TELEGRAM_API } from "../../supabase/functions/_shared/telegram.ts";
import { LOOPMESSAGE_SEND_URL, loopSend } from "../../supabase/functions/_shared/loopmessage.ts";
import { CHAT_DOWN_REPLY } from "../../supabase/functions/_shared/channel_inbound.ts";
import type { InboundMessage } from "../../supabase/functions/_shared/channel_adapters.ts";
import { chatQueueOn, MAX_ATTEMPTS, providerKey, type QueueRow, supabaseTurnQueue, workerKick, type WorkerStore } from "../../supabase/functions/_shared/inbound_turn_queue.ts";
import { evaluate, type Snapshot } from "../../supabase/functions/_shared/ops_monitor.ts";
import { handleTelegram, telegramCoreDeps } from "../../supabase/functions/trainee-telegram/handler.ts";
import { handleInbound, imessageCoreDeps } from "../../supabase/functions/trainee-inbound/handler.ts";
import { handleTurnWorker, runRow } from "../../supabase/functions/trainee-turn-worker/handler.ts";
import { RELEASE_FLAGS, RELEASE_NEVER_ON } from "../../supabase/functions/agent-chat/release_config.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const NOW = Date.UTC(2026, 10, 2, 15);
const TG_TOKEN = "123456:fake-telegram-token-TTTTTTTT", TG_SECRET = "t".repeat(40), SECRET = "i".repeat(40), TURN_SECRET = "w".repeat(40);

// An in-memory stand-in for the database side: the queue the webhook writes (unique provider id) and the worker's claim/finish.
// Ordering, leases and races are not modeled here: ack-fast-queue-pg.test.ts runs the real functions.
function memQueue(o: { failEnqueue?: boolean } = {}) {
  const rows: (QueueRow & { status: string; error?: string | null })[] = [];
  let id = 0;
  const store: WorkerStore = {
    claim: async (limit) => {
      const out: QueueRow[] = [];
      for (const r of rows) if (r.status === "queued" && out.length < limit) { r.status = "claimed"; r.attempts++; out.push({ ...r }); }
      return out;
    },
    finish: async (rid, token, outcome, error) => {
      const r = rows.find((x) => x.id === rid && x.claim_token === token && x.status === "claimed");
      if (!r) return "stale";
      r.error = error ?? null;
      r.status = outcome === "done" ? "done" : outcome === "failed" ? "failed" : r.attempts < MAX_ATTEMPTS ? "queued" : "failed";
      return r.status;
    },
  };
  const enqueueCalls: string[] = [];
  const queue = {
    enqueue: async (m: InboundMessage) => {
      enqueueCalls.push(providerKey(m));
      if (o.failEnqueue) throw new Error("database down");
      if (rows.some((r) => r.provider_msg_id === providerKey(m))) return false;
      rows.push({ id: ++id, channel: m.channel, provider_msg_id: providerKey(m), contact: m.contact, payload: JSON.parse(JSON.stringify(m)), attempts: 0, claim_token: crypto.randomUUID(), status: "queued" });
      return true;
    },
    kick: () => { kicks++; },
  };
  let kicks = 0;
  return { rows, store, queue, enqueueCalls, get kicks() { return kicks; } };
}

function harness(o: { env?: Record<string, string>; chat?: (a: any) => Promise<any> } = {}) {
  const W = memoryChannelWorld();
  const sentTelegram: { chat: string; text: string }[] = [], sentLoop: string[] = [], actions: string[] = [];
  let n = 0, upd = 5000, msgSeq = 0;
  const resp = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const net = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    if (url === LOOPMESSAGE_SEND_URL) { sentLoop.push(body.text); return resp({ message_id: `lm-${++n}` }); }
    if (url.startsWith(`${TELEGRAM_API}/bot${TG_TOKEN}/sendMessage`)) { sentTelegram.push({ chat: String(body.chat_id), text: body.text }); return resp({ ok: true, result: { message_id: ++n } }); }
    actions.push(url.split("/").pop()!);
    return resp({ ok: true, result: true });
  }) as unknown as typeof fetch;
  const vars: Record<string, string> = { CAREER_TEXTING_NATIVE: "off", TRAINEE_INBOUND_SECRET: SECRET, LOOPMESSAGE_API_KEY: "fake-loop-key", TRAINEE_SIGNUP: "open",
    TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_WEBHOOK_SECRET: TG_SECRET, TRAINEE_TURN_SECRET: TURN_SECRET, ...o.env };
  const env = { get: (k: string) => vars[k] || undefined };
  const adapters = adaptersFromEnv(env, { fetch: net, clock: () => NOW, sleep: async () => {} });
  const chats: any[] = [];
  const chat = o.chat ?? (async (a: any) => ({ status: 200, reply: `You said: ${a.message}`, threadId: `t-${a.userId}` }));
  const counted = async (a: any) => { chats.push(a); return await chat(a); };
  const runDeliver = async (only: { userId: string; key: string }) => { const s = W.delivery({ only }); await deliverDue({ store: s, adapters, now: NOW }); await s.release(); };
  const tgDeps = (queue?: any) => ({ env, now: () => NOW, store: () => W.inbound, chat: counted, deliver: (a: any) => runDeliver({ userId: a.userId, key: a.key }).then(() => {}), adapter: () => adapters.telegram!, queue });
  const tgUpdate = (chatId: string, text: string, updateId?: number) => ({ update_id: updateId ?? ++upd, message: { message_id: ++msgSeq, from: { id: Number(chatId), is_bot: false }, chat: { id: Number(chatId), type: "private" }, date: Math.floor(NOW / 1000), text } });
  const tgPost = (u: unknown, queue?: any, secret = TG_SECRET) => handleTelegram(new Request("https://fn.test/trainee-telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(u) }), tgDeps(queue));
  const lmDeps = (queue?: any) => ({ env, now: () => NOW, store: () => W.inbound, send: (apiKey: string) => loopSend({ apiKey, fetch: net, sleep: async () => {} }), chat: counted,
    deliverReply: (a: any) => runDeliver({ userId: a.userId, key: a.key }).then(() => {}), queue });
  const lmPost = (from: string, text: string, id: string, queue?: any) => handleInbound(new Request(`https://fn.test/trainee-inbound?secret=${SECRET}`, { method: "POST", body: JSON.stringify({ alert_type: "message_inbound", message_id: id, recipient: from, text }) }), lmDeps(queue));
  const outboxFor = (needle: string) => W.outbox.filter((r: any) => String(r.key).includes(needle));
  return { W, env, vars, chats, sentTelegram, sentLoop, actions, tgDeps, tgPost, tgUpdate, lmDeps, lmPost, outboxFor, chat: counted };
}
const rowTo = (q: ReturnType<typeof memQueue>, i = 0) => ({ ...q.rows[i], claim_token: q.rows[i].claim_token });

Deno.test("the switch: only CHAT_QUEUE=on turns the queue on; unset, off, or any typo is off (a mistyped rollback still rolls back)", () => {
  const env = (v?: string) => ({ get: (k: string) => (k === "CHAT_QUEUE" ? v : undefined) });
  eq([chatQueueOn(env()), chatQueueOn(env("")), chatQueueOn(env("off")), chatQueueOn(env("0")), chatQueueOn(env("true")), chatQueueOn(env("onn"))], [false, false, false, false, false, false]);
  eq([chatQueueOn(env("on")), chatQueueOn(env(" ON "))], [true, true]);
  // Not a release flag the deploy serves on, and not hidden in the never-on list: it is read from the environment, default off.
  assert(!("CHAT_QUEUE" in RELEASE_FLAGS), "CHAT_QUEUE must not be served on by the committed release config");
  assert(!(RELEASE_NEVER_ON as readonly string[]).includes("CHAT_QUEUE"));
});

Deno.test("flag OFF (default): the telegram webhook runs the turn inline exactly as before and never touches the queue", async () => {
  const h = harness();
  const q = memQueue();
  const res = await h.tgPost(h.tgUpdate("7001", "hi"), q.queue);
  eq(res.status, 200);
  eq(h.chats.length, 1, "the turn ran inside the webhook");
  eq(q.enqueueCalls, [], "nothing was queued");
  eq(q.kicks, 0);
  eq(h.sentTelegram.map((m) => m.text), ["You said: hi"], "the reply went out before the webhook answered");
  // iMessage the same
  const r2 = await h.lmPost("+15550001111", "hello", "lm-off-1", q.queue);
  eq(r2.status, 200);
  eq(q.enqueueCalls, []);
  eq(h.sentLoop.length, 1);
  // CHAT_QUEUE=off and a typo are off too
  for (const v of ["off", "yes"]) {
    const g = harness({ env: { CHAT_QUEUE: v } });
    await g.tgPost(g.tgUpdate("7002", "hi"), q.queue);
    eq(g.chats.length, 1);
  }
  eq(q.enqueueCalls, []);
});

Deno.test("flag ON: telegram acks in well under 3 s while the model hangs, writes one row, and the turn has not run", async () => {
  const never = new Promise(() => {});
  const h = harness({ env: { CHAT_QUEUE: "on" }, chat: () => never as Promise<any> });
  const q = memQueue();
  const t0 = performance.now();
  const res = await h.tgPost(h.tgUpdate("7001", "hi", 9001), q.queue);
  const ms = performance.now() - t0;
  eq(res.status, 200);
  assert(ms < 1500, `ack took ${ms.toFixed(0)} ms`);
  const body = await res.json();
  eq(body.results, [{ ok: true, queued: true }]);
  eq(h.chats.length, 0, "no turn ran in the webhook");
  eq(h.sentTelegram, [], "nothing was answered yet");
  eq(q.rows.length, 1);
  eq(q.rows[0].provider_msg_id, "telegram:9001");
  eq(q.rows[0].contact, "tg:7001");
  eq(q.rows[0].payload.text, "hi");
  eq(q.kicks, 1, "the worker was nudged once");
  assert(h.actions.includes("sendChatAction"), "typing shows at once, before the worker starts");
  eq(h.W.outbox.length, 0, "no reply row yet: the worker writes it");
});

Deno.test("flag ON: a retried delivery (same update id) queues once, a bad secret queues nothing, a failed write is a 503 so Telegram retries", async () => {
  const h = harness({ env: { CHAT_QUEUE: "on" } });
  const q = memQueue();
  const u = h.tgUpdate("7001", "hi", 9100);
  eq((await h.tgPost(u, q.queue)).status, 200);
  const again = await h.tgPost(u, q.queue);
  eq(again.status, 200);
  eq((await again.json()).results, [{ ok: true, ignored: "duplicate webhook" }]);
  eq(q.rows.length, 1, "one row for one provider message id");
  eq(q.kicks, 1, "a duplicate does not nudge again");
  const bad = await h.tgPost(h.tgUpdate("7001", "x", 9101), q.queue, "wrong-secret");
  assert(bad.status >= 400 && bad.status < 500, `bad secret refused: ${bad.status}`);
  eq(q.rows.length, 1);
  const down = memQueue({ failEnqueue: true });
  const r = await h.tgPost(h.tgUpdate("7001", "later", 9102), down.queue);
  eq(r.status, 503);
  eq(h.chats.length, 0, "a failed write does not fall back to running a turn");
});

Deno.test("flag ON: iMessage (trainee-inbound) acks without a turn; a duplicate id is not queued twice", async () => {
  const h = harness({ env: { CHAT_QUEUE: "on" } });
  const q = memQueue();
  const a = await h.lmPost("+15550001111", "hello", "lm-on-1", q.queue);
  eq(a.status, 200);
  eq(await a.json(), { ok: true, queued: true });
  const b = await h.lmPost("+15550001111", "hello", "lm-on-1", q.queue);
  eq(await b.json(), { ok: true, ignored: "duplicate webhook" });
  eq(q.rows.length, 1);
  eq(q.rows[0].provider_msg_id, "loopmessage:lm-on-1");
  eq(h.chats.length, 0);
  eq(h.sentLoop, []);
});

Deno.test("worker: a queued telegram text is answered once, the row is done, and running the same row again adds no second reply", async () => {
  const h = harness({ env: { CHAT_QUEUE: "on" } });
  const q = memQueue();
  await h.tgPost(h.tgUpdate("7001", "hi", 9200), q.queue);
  const deps = { env: h.env, store: q.store, depsFor: (c: string) => (c === "telegram" ? telegramCoreDeps(h.tgDeps()) : null) };
  const res = await handleTurnWorker(new Request("https://fn.test/w", { method: "POST", headers: { "x-trainee-turn-secret": TURN_SECRET }, body: "{}" }), deps);
  eq(res.status, 200);
  eq((await res.json()).done, 1);
  eq(q.rows[0].status, "done");
  eq(h.sentTelegram.map((m) => m.text), ["You said: hi"]);
  eq(h.outboxFor("tg:9200").length, 1);
  // The same message run again (a crashed worker's retry, or a double claim): the outbox refuses a second row; nothing is re-sent.
  const sentBefore = h.sentTelegram.length;
  const again = { ...rowTo(q), attempts: 2 };
  q.rows[0].status = "claimed";
  eq(await runRow(again, deps), "done");
  eq(h.outboxFor("tg:9200").length, 1, "one reply row for one message");
  eq(h.sentTelegram.length, sentBefore, "the person is not answered twice");
});

Deno.test("worker: auth is the shared secret; no secret configured is a 503", async () => {
  const h = harness();
  const q = memQueue();
  const deps = { env: h.env, store: q.store, depsFor: () => null };
  eq((await handleTurnWorker(new Request("https://fn.test/w", { method: "POST", body: "{}" }), deps)).status, 401);
  eq((await handleTurnWorker(new Request("https://fn.test/w", { method: "GET" }), deps)).status, 405);
  const bare = { ...deps, env: { get: () => undefined } };
  eq((await handleTurnWorker(new Request("https://fn.test/w", { method: "POST", headers: { "x-trainee-turn-secret": TURN_SECRET }, body: "{}" }), bare)).status, 503);
});

Deno.test("worker: a failing turn says nothing and is retried until the last attempt; then the person is told once and the row is failed (surfaced, not dropped)", async () => {
  let fail = true;
  const h = harness({ env: { CHAT_QUEUE: "on" }, chat: async (a: any) => { if (fail) throw new Error("agent-chat HTTP 503"); return { status: 200, reply: `You said: ${a.message}`, threadId: null }; } });
  const q = memQueue();
  await h.tgPost(h.tgUpdate("7001", "hi", 9300), q.queue);
  const deps = { env: h.env, store: q.store, depsFor: (c: string) => (c === "telegram" ? telegramCoreDeps(h.tgDeps()) : null) };
  const work = () => handleTurnWorker(new Request("https://fn.test/w", { method: "POST", headers: { "x-trainee-turn-secret": TURN_SECRET }, body: "{}" }), deps).then((r) => r.json());
  for (const attempt of [1, 2]) {
    const r = await work();
    eq([r.claimed, r.retried, r.failed], [1, 1, 0], `attempt ${attempt} is retried`);
    eq(q.rows[0].status, "queued");
    eq(h.sentTelegram, [], "nothing said to the person on a retried attempt");
    eq(h.outboxFor("tg:9300").length, 0, "and no reply row that would block the real answer");
  }
  // Attempt 3 would succeed if the model were back: the answer is then sent once, as if the first try had worked.
  fail = false;
  const ok = await work();
  eq([ok.done, ok.failed], [1, 0]);
  eq(h.sentTelegram.map((m) => m.text), ["You said: hi"]);
  // Now the other ending: all three attempts fail.
  fail = true;
  const h2 = harness({ env: { CHAT_QUEUE: "on" }, chat: async () => { throw new Error("agent-chat HTTP 503"); } });
  const q2 = memQueue();
  await h2.tgPost(h2.tgUpdate("7002", "hi", 9301), q2.queue);
  const deps2 = { env: h2.env, store: q2.store, depsFor: (c: string) => (c === "telegram" ? telegramCoreDeps(h2.tgDeps()) : null) };
  const work2 = () => handleTurnWorker(new Request("https://fn.test/w", { method: "POST", headers: { "x-trainee-turn-secret": TURN_SECRET }, body: "{}" }), deps2).then((r) => r.json());
  await work2(); await work2();
  const last = await work2();
  eq([last.claimed, last.failed], [1, 1]);
  eq(q2.rows[0].status, "failed", "kept, not dropped");
  eq(h2.sentTelegram.map((m) => m.text), [CHAT_DOWN_REPLY], "the person is told once, on the last attempt only");
  assert(/agent-chat HTTP 503/.test(q2.rows[0].error ?? ""), `the reason is on the row: ${q2.rows[0].error}`);
});

Deno.test("worker: a turn that outlives its deadline is retried, and a worker whose claim was taken over changes nothing (stale)", async () => {
  const h = harness({ env: { CHAT_QUEUE: "on" }, chat: () => new Promise(() => {}) });
  const q = memQueue();
  await h.tgPost(h.tgUpdate("7001", "hi", 9400), q.queue);
  const [row] = await q.store.claim(1);
  const deps = { env: h.env, store: q.store, depsFor: () => telegramCoreDeps(h.tgDeps()), deadlineMs: 50 };
  eq(await runRow(row, deps), "queued", "timed out -> back in the queue");
  eq(h.sentTelegram, []);
  const [again] = await q.store.claim(1);
  eq(await runRow({ ...again, claim_token: "00000000-0000-0000-0000-000000000000" }, { ...deps, depsFor: () => telegramCoreDeps(h.tgDeps()), deadlineMs: 10 }), "stale");
});

Deno.test("worker: an iMessage row runs through the iMessage core and is answered once", async () => {
  const h = harness({ env: { CHAT_QUEUE: "on" } });
  const q = memQueue();
  await h.lmPost("+15550001111", "hello", "lm-w-1", q.queue);
  const deps = { env: h.env, store: q.store, depsFor: (c: string) => (c === "imessage" ? imessageCoreDeps(h.lmDeps(), "fake-loop-key", SECRET) : null) };
  const [row] = await q.store.claim(1);
  eq(await runRow(row, deps), "done");
  eq(h.sentLoop.length, 1);
  eq(h.chats.length, 1);
});

Deno.test("kick: the nudge carries the secret, asks for an async run, never throws, and is absent without a secret", async () => {
  const seen: { url: string; secret: string | null; body: string }[] = [];
  const f = (async (url: string, init: RequestInit) => { seen.push({ url, secret: new Headers(init.headers).get("x-trainee-turn-secret"), body: String(init.body) }); return new Response("{}", { status: 202 }); }) as unknown as typeof fetch;
  const env = { get: (k: string) => (k === "TRAINEE_TURN_SECRET" ? TURN_SECRET : undefined) };
  await workerKick(env, "https://p.supabase.co", f)!();
  eq(seen, [{ url: "https://p.supabase.co/functions/v1/trainee-turn-worker", secret: TURN_SECRET, body: JSON.stringify({ async: true, limit: 3 }) }]);
  await workerKick(env, "https://p.supabase.co", (() => { throw new Error("network"); }) as unknown as typeof fetch)!();
  eq(workerKick({ get: () => undefined }, "https://p.supabase.co"), undefined);
  // supabaseTurnQueue maps a message onto the database function's arguments
  const calls: any[] = [];
  const admin = { rpc: async (name: string, args: any) => { calls.push([name, args]); return { data: true, error: null }; } };
  const m: InboundMessage = { provider: "telegram", channel: "telegram", messageId: "55", kind: "text", contact: "tg:7", address: "7", text: "yo" };
  eq(await supabaseTurnQueue(admin).enqueue(m), true);
  eq(calls[0][0], "inbound_turn_enqueue");
  eq([calls[0][1].p_channel, calls[0][1].p_msg_id, calls[0][1].p_contact, calls[0][1].p_payload.text], ["telegram", "telegram:55", "tg:7", "yo"]);
});

Deno.test("ops path: a failed queue row alerts the owner (a new failure is a new alert), a stuck queue alerts, a healthy or unmeasured one does not", () => {
  const base = { now: NOW, ingest: null, delivery: null, worker: null, refusals: null, spend: null, http5xx: null } as Snapshot;
  const kinds = (turnQueue: Snapshot["turnQueue"]) => evaluate({ ...base, turnQueue }).map((a) => a.kind);
  eq(kinds(undefined), []);
  eq(kinds(null), []);
  eq(kinds({ queued: 2, claimed: 1, oldestQueuedAt: new Date(NOW - 20_000).toISOString(), failedRecent: 0, newestFailedId: null }), []);
  const failed = evaluate({ ...base, turnQueue: { queued: 0, claimed: 0, oldestQueuedAt: null, failedRecent: 2, newestFailedId: 41 } });
  eq(failed.map((a) => a.kind), ["turn_queue_failed"]);
  assert(/2 inbound text/.test(failed[0].text) && failed[0].key.endsWith(":41"));
  eq(kinds({ queued: 9, claimed: 0, oldestQueuedAt: new Date(NOW - 6 * 60000).toISOString(), failedRecent: 0, newestFailedId: null }), ["turn_queue_stuck"]);
});
