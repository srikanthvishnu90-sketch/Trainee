// WO-013b-1 builder tests: LoopMessage as the channel's Send (retry only when the message certainly did not go out), the
// Supabase channel store (claimed rows marked or put back as they were, a dead run's rows failed and never resent), and
// the delivery function's door (secret, NOT_WIRED without the key, the daily contact cap from settings, every run recorded).
// Run: deno test --no-check tests/edge/channel-delivery.test.ts
import { loopSend, LOOPMESSAGE_SEND_URL } from "../../supabase/functions/_shared/loopmessage.ts";
import { supabaseChannelStore, UNKNOWN_OUTCOME } from "../../supabase/functions/_shared/channel_store.ts";
import { memoryChannel } from "../../supabase/functions/_shared/channel.ts";
import { toBubbles } from "../../supabase/functions/_shared/conversation.ts";
import { DEFAULT_DAILY_CONTACTS, handleDeliver } from "../../supabase/functions/trainee-deliver/handler.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const NOW = Date.UTC(2026, 9, 19, 15);
const noSleep = async () => {};
function fakeFetch(plan: (i: number) => Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); const r = plan(calls.length - 1); if (r instanceof Error) throw r; return r; }) as unknown as typeof fetch;
  return { f, calls };
}
const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });
const status = (s: number) => new Response("{}", { status: s });

Deno.test("WO-013b-1/L1 one POST per bubble, raw key in Authorization, body {contact, text}, paused between bubbles", async () => {
  const net = fakeFetch(() => ok({ message_id: "lm-1" }));
  const pauses: number[] = [];
  const send = loopSend({ apiKey: "k-test", fetch: net.f, sleep: async (ms) => { pauses.push(ms); } });
  const r = await send("+15550001111", ["first", "https://jobs.lever.co/acme/1"]);
  eq(r, { ok: true, id: "lm-1" });
  eq(net.calls.map((c) => c.url), [LOOPMESSAGE_SEND_URL, LOOPMESSAGE_SEND_URL]);
  eq((net.calls[0].init.headers as Record<string, string>).Authorization, "k-test", "the raw key, no Bearer prefix");
  eq(net.calls.map((c) => JSON.parse(String(c.init.body))), [{ contact: "+15550001111", text: "first" }, { contact: "+15550001111", text: "https://jobs.lever.co/acme/1" }]);
  eq(pauses, [250]);
  eq(await send("+15550001111", []), { ok: false, error: "nothing to send: the message has no text", retryable: false }, "an empty message is never marked delivered");
});

Deno.test("WO-013b-1/L2 retry only when it certainly did not go out: never opened, 429, 502, 503 on the first bubble", async () => {
  const one = async (r: Response | Error) => await loopSend({ apiKey: "k", fetch: fakeFetch(() => r).f, sleep: noSleep })("+15550001111", ["hi"]);
  for (const s of [429, 502, 503]) eq((await one(status(s)) as any).retryable, true, `HTTP ${s}`);
  for (const s of [400, 401, 402, 404, 500, 504]) eq((await one(status(s)) as any).retryable, false, `HTTP ${s}`);
  eq((await one(new TypeError("connection refused")) as any).retryable, true, "the connection never opened");
  const timedOut = await one(new DOMException("signal timed out", "TimeoutError")) as any;
  eq(timedOut.retryable, false, "a timeout may have been delivered");
  assert(/may have been delivered/.test(timedOut.error), timedOut.error);
  const second = await loopSend({ apiKey: "k", fetch: fakeFetch((i) => (i === 0 ? ok() : status(503))).f, sleep: noSleep })("+15550001111", ["a", "b", "c"]) as any;
  // CHANNEL DELIVERY ROUND 2 (2026-10-30): what went is reported, so the retry resumes from bubble 2 and never resends the
  // first (career_outbox.sent_parts); it was final, and bubbles 2 and 3 were never sent.
  eq([second.ok, second.retryable, second.sent], [false, true, 1], "a 503 on bubble 2 sent nothing of it: retried from bubble 2, bubble 1 never again");
  assert(/after 1 of 3 bubbles went out/.test(second.error), second.error);
  const timeoutLater = await loopSend({ apiKey: "k", fetch: fakeFetch((i) => (i === 0 ? ok() : new DOMException("signal timed out", "TimeoutError"))).f, sleep: noSleep })("+15550001111", ["a", "b"]) as any;
  eq([timeoutLater.ok, timeoutLater.retryable, timeoutLater.sent], [false, false, 1], "a timeout on bubble 2 may have been delivered: final");
});

// A minimal Supabase client: every query is recorded; results come from `answer` by table and operation.
function fakeAdmin(answer: (q: { table: string; op: string; args: unknown; filters: unknown[][] }) => { data: unknown; error: unknown }) {
  const log: { table: string; op: string; args: unknown; filters: unknown[][] }[] = [];
  const query = (table: string) => {
    const q = { table, op: "select", args: null as unknown, filters: [] as unknown[][] };
    const chain: any = {
      select: (a: unknown) => { if (q.op === "select") q.args = a; else q.filters.push(["select", a]); return chain; },
      update: (a: unknown) => { q.op = "update"; q.args = a; return chain; },
      upsert: (a: unknown, o: unknown) => { q.op = "upsert"; q.args = [a, o]; return chain; },
      eq: (...f: unknown[]) => { q.filters.push(["eq", ...f]); return chain; },
      lt: (...f: unknown[]) => { q.filters.push(["lt", ...f]); return chain; },
      gte: (...f: unknown[]) => { q.filters.push(["gte", ...f]); return chain; },
      limit: (n: number) => { q.filters.push(["limit", n]); return chain; },
      maybeSingle: () => { q.filters.push(["maybeSingle"]); return chain; },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => { log.push(q); return Promise.resolve(answer(q)).then(res, rej); },
    };
    return chain;
  };
  return { admin: { from: query, rpc: (fn: string, args: unknown) => query(`rpc:${fn}`).update(args) }, log };
}
const claimRow = (id: number, prior = "queued", attempts = 0) => ({ id, user_id: "u1", contact: "+15550001111", key: `alert:${id}`, text: `Message ${id}`, deliver_at: new Date(NOW - id * 1000).toISOString(), attempts, prior_status: prior });

Deno.test("WO-013b-1/S1 the Supabase store: claimed rows come back oldest first; a mark writes only a row still being sent", async () => {
  const fake = fakeAdmin((q) => q.table === "rpc:career_outbox_claim" ? { data: [claimRow(1), claimRow(2, "failed", 1)], error: null } : { data: [], error: null });
  const store = supabaseChannelStore(fake.admin);
  const due = await store.due(NOW, 20);
  eq(due.map((r) => r.id), ["2", "1"]);
  eq(fake.log[0].args, { p_now: new Date(NOW).toISOString(), p_limit: 20 });
  await store.mark("2", { status: "failed", at: NOW, error: "LoopMessage HTTP 503", retryAt: NOW + 300000 });
  const m = fake.log[1];
  eq([m.table, m.op, (m.args as any).attempts, (m.args as any).retry_at, m.filters], ["career_outbox", "update", 2, new Date(NOW + 300000).toISOString(), [["eq", "id", "2"], ["eq", "status", "sending"]]]);
  await store.mark("1", { status: "delivered", at: NOW, providerId: "lm-9" });
  eq([(fake.log[2].args as any).status, (fake.log[2].args as any).delivered_at, (fake.log[2].args as any).provider_id], ["delivered", new Date(NOW).toISOString(), "lm-9"]);
  eq(await store.release(), 0, "everything claimed was marked");
});

Deno.test("WO-013b-1/S2 release puts an unfinished row back exactly as it was; sweep fails a dead run's rows with the reason", async () => {
  const fake = fakeAdmin((q) => q.table === "rpc:career_outbox_claim" ? { data: [claimRow(1), claimRow(2, "failed", 1)], error: null }
    : q.op === "update" && (q.args as any).error === UNKNOWN_OUTCOME ? { data: [{ id: 7 }], error: null } : { data: [], error: null });
  const store = supabaseChannelStore(fake.admin);
  await store.due(NOW, 20);
  await store.mark("1", { status: "delivered", at: NOW });
  eq(await store.release(), 1);
  const back = fake.log.at(-1)!;
  eq([back.args, back.filters], [{ status: "failed", claimed_at: null, contact: null }, [["eq", "id", "2"], ["eq", "status", "sending"]]], "a retrying row stays a retry");
  eq(await store.sweep(NOW), 1);
  const sw = fake.log.at(-1)!;
  eq([(sw.args as any).status, (sw.args as any).retry_at, sw.filters[1]], ["failed", null, ["lt", "claimed_at", new Date(NOW - 600000).toISOString()]], "failed for good, never resent");
});

Deno.test("WO-013b-1/S3 a database error is an error, never a quiet empty queue", async () => {
  const store = supabaseChannelStore(fakeAdmin(() => ({ data: null, error: { message: "permission denied for function career_outbox_claim" } })).admin);
  let msg = "";
  try { await store.due(NOW, 20); } catch (e) { msg = (e as Error).message; }
  assert(/claim due messages: permission denied/.test(msg), msg);
});

const SECRET = "d".repeat(40);
const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });
function harness(e: Record<string, string>, rows = [] as any[], over: Record<string, unknown> = {}) {
  const mem = memoryChannel(rows), runs: any[] = [], sends: { contact: string; bubbles: string[] }[] = [], keys: string[] = [];
  let released = 0, swept = 0;
  const store = () => Object.assign(mem, { release: async () => { released++; return 0; }, sweep: async () => { swept++; return 0; } });
  const deps = { env: env(e), now: () => NOW, store, recordRun: async (r: any) => { runs.push(r); },
    send: (k: string) => { keys.push(k); return async (contact: string, bubbles: string[]) => { sends.push({ contact, bubbles }); return { ok: true as const, id: null }; }; }, ...over };
  return { deps, runs, sends, keys, mem, counts: () => ({ released, swept }) };
}
const post = (s?: string) => new Request("https://fn.test/trainee-deliver", { method: "POST", headers: s ? { "x-trainee-deliver-secret": s } : {} });
const row = (id: string, contact: string) => ({ id, userId: `u-${contact}`, contact, key: `alert:${id}`, text: `New match ${id}.\nhttps://jobs.lever.co/acme/${id}`, deliver_at: NOW - 1000, attempts: 0 });

Deno.test("WO-013b-1/F1 the door: POST, a 32+ character secret, NOT_WIRED without the LoopMessage key, a sane daily cap", async () => {
  const full = { TRAINEE_DELIVER_SECRET: SECRET, LOOPMESSAGE_API_KEY: "k-live" };
  eq((await handleDeliver(new Request("https://fn.test/", { method: "GET" }), harness(full).deps as any)).status, 405);
  eq((await handleDeliver(post("short"), harness({ ...full, TRAINEE_DELIVER_SECRET: "short" }).deps as any)).status, 503);
  eq((await handleDeliver(post("wrong"), harness(full).deps as any)).status, 401);
  const unwired = harness({ TRAINEE_DELIVER_SECRET: SECRET }, [row("1", "+15550001111")]);
  const r = await handleDeliver(post(SECRET), unwired.deps as any);
  eq(r.status, 503);
  assert(/NOT_WIRED: LOOPMESSAGE_API_KEY/.test((await r.json()).error));
  eq([unwired.sends.length, unwired.mem.rows()[0].status], [0, "queued"], "nothing sent, nothing marked");
  for (const bad of ["0", "-5", "lots", "2.5"]) eq((await handleDeliver(post(SECRET), harness({ ...full, LOOPMESSAGE_DAILY_CONTACTS: bad }).deps as any)).status, 503, bad);
  eq(DEFAULT_DAILY_CONTACTS, 300);
});

Deno.test("WO-013b-1/F2 a run sends due rows as bubbles with the configured key, honours the cap, puts back the capped, records itself", async () => {
  const h = harness({ TRAINEE_DELIVER_SECRET: SECRET, LOOPMESSAGE_API_KEY: "k-live", LOOPMESSAGE_DAILY_CONTACTS: "1" }, [row("1", "+15550001111"), row("2", "+15550002222")]);
  const res = await handleDeliver(post(SECRET), h.deps as any);
  eq(res.status, 200);
  eq(h.keys, ["k-live"]);
  eq(h.sends, [{ contact: "+15550001111", bubbles: toBubbles(row("1", "").text) }]);
  eq([h.runs[0].delivered, h.runs[0].capped, h.runs[0].error], [1, 1, null]);
  eq(h.counts(), { released: 1, swept: 1 });
});

Deno.test("WO-013b-1/F3 a run that fails midway is recorded with the error and puts nothing back (the sweep fails those rows later)", async () => {
  const h = harness({ TRAINEE_DELIVER_SECRET: SECRET, LOOPMESSAGE_API_KEY: "k-live" }, [row("1", "+15550001111")]);
  const mem = h.mem;
  (mem as any).mark = async () => { throw new Error("record delivery: connection reset"); };
  const res = await handleDeliver(post(SECRET), h.deps as any);
  eq(res.status, 500);
  eq([h.runs.length, h.runs[0].error], [1, "record delivery: connection reset"]);
  eq(h.counts().released, 0, "a row that may be with the provider is never put back to send again");
});
