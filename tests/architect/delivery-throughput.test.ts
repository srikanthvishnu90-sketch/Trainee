// DELIVERY THROUGHPUT (scale-90k bottleneck 5): the scheduled delivery run sends in parallel across people, bounded by the
// channels' limits, in rounds, in two lanes (replies and approvals before alerts), and never twice; with the defaults of the
// settings left alone nothing about a one-row-at-a-time run changes.
// Run: deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/delivery-throughput.test.ts
import { deliverDue, memoryChannel } from "../../supabase/functions/_shared/channel.ts";
import { supabaseChannelStore } from "../../supabase/functions/_shared/channel_store.ts";
import { toBubbles } from "../../supabase/functions/_shared/conversation.ts";
import { handleDeliver, DEFAULT_BATCH_SIZE, DEFAULT_CONCURRENCY } from "../../supabase/functions/trainee-deliver/handler.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const NOW = Date.UTC(2026, 10, 2, 15);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// iMessage-shaped adapter whose send takes `ms`, recording how many sends are in flight at once, per contact too.
function slowAdapter(ms: number, o: { dailyContacts?: number | null } = {}) {
  const log = { inflight: 0, max: 0, perContact: new Map<string, number>(), maxPerContact: 0, order: [] as string[], texts: [] as string[] };
  const adapter = { channel: "imessage" as const, limits: { dailyContacts: o.dailyContacts ?? null }, render: toBubbles,
    async send(contact: string, bubbles: string[]) {
      log.inflight++; log.max = Math.max(log.max, log.inflight);
      const n = (log.perContact.get(contact) ?? 0) + 1; log.perContact.set(contact, n); log.maxPerContact = Math.max(log.maxPerContact, n);
      log.order.push(`${contact}|${bubbles[0]}`); log.texts.push(bubbles[0]);
      await sleep(ms);
      log.inflight--; log.perContact.set(contact, (log.perContact.get(contact) ?? 1) - 1);
      return { ok: true as const, id: `m-${log.order.length}` };
    } };
  return { adapter, log };
}
const row = (id: string, n: number, key = `alert:${id}`) => ({ id, userId: `u-${n}`, contact: `+1555000${String(n).padStart(4, "0")}`, key, text: `T${id}`, deliver_at: NOW - 1000 - Number(id.replace(/\D/g, "") || 0), attempts: 0 });

Deno.test("concurrency: rows of different people go out side by side, bounded by the setting; each row once", async () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(`${i + 1}`, i + 1));
  const { adapter, log } = slowAdapter(15);
  const mem = memoryChannel(rows);
  const r = await deliverDue({ store: mem, adapters: { imessage: adapter }, now: NOW, limit: 100, concurrency: 4 });
  eq(r.delivered, 40);
  assert(log.max >= 2 && log.max <= 4, `in flight at once: ${log.max} (wanted 2 to 4)`);
  eq(new Set(log.texts).size, 40, "every row sent exactly once");
  eq(mem.rows().filter((x) => x.status === "delivered").length, 40);
});

Deno.test("default (no concurrency given): one row after another, exactly as before", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(`${i + 1}`, i + 1));
  const { adapter, log } = slowAdapter(3);
  await deliverDue({ store: memoryChannel(rows), adapters: { imessage: adapter }, now: NOW, limit: 100 });
  eq(log.max, 1);
  eq(log.texts, rows.sort((a, b) => a.deliver_at - b.deliver_at).map((x) => x.text), "oldest first");
});

Deno.test("one person's rows on one channel stay in order and one at a time, whatever the concurrency", async () => {
  const mine = Array.from({ length: 6 }, (_, i) => ({ ...row(`${i + 1}`, 1, `reply:x:${i + 1}`), deliver_at: NOW - 6000 + i }));
  const others = Array.from({ length: 10 }, (_, i) => row(`${i + 20}`, i + 2));
  const { adapter, log } = slowAdapter(8);
  await deliverDue({ store: memoryChannel([...mine, ...others]), adapters: { imessage: adapter }, now: NOW, limit: 100, concurrency: 8 });
  eq(log.maxPerContact, 1, "never two sends to one contact at once");
  eq(log.order.filter((x) => x.startsWith(mine[0].contact)).map((x) => x.split("|")[1]), mine.map((x) => x.text), "in order");
  assert(log.max > 1, "the others ran alongside");
});

Deno.test("the provider's daily contact cap is never passed by rows sent together", async () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(`${i + 1}`, i + 1));
  const { adapter } = slowAdapter(10, { dailyContacts: 5 });
  const mem = memoryChannel(rows);
  const r = await deliverDue({ store: mem, adapters: { imessage: adapter }, now: NOW, limit: 100, concurrency: 8 });
  eq([r.delivered, r.capped], [5, 15]);
  eq(mem.rows().filter((x) => x.status === "delivered").length, 5);
});

Deno.test("a send that throws in one lane does not stop the others, and is retried not lost", async () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(`${i + 1}`, i + 1));
  const adapter = { channel: "imessage" as const, limits: { dailyContacts: null }, render: toBubbles,
    async send(c: string) { await sleep(2); if (c.endsWith("0003")) throw new Error("boom"); return { ok: true as const, id: "m" }; } };
  const mem = memoryChannel(rows);
  const r = await deliverDue({ store: mem, adapters: { imessage: adapter }, now: NOW, limit: 100, concurrency: 3 });
  eq([r.delivered, r.retried], [5, 1]);
});

// ---------------------------------------------------------------------------------------------------------- the handler
const SECRET = "d".repeat(40);
const envOf = (m: Record<string, string>) => ({ get: (k: string) => m[k] });
function harness(e: Record<string, string>, rows: any[] = []) {
  const mem = memoryChannel(rows), runs: any[] = [], limits: number[] = [], shards: unknown[] = [];
  const base = mem.due.bind(mem);
  let sends = 0;
  const store = (o?: unknown) => { shards.push(o); return Object.assign(mem, { due: async (n: number, l: number) => { limits.push(l); return await base(n, l); }, release: async () => 0, sweep: async () => 0 }); };
  const deps = { env: envOf({ TRAINEE_DELIVER_SECRET: SECRET, LOOPMESSAGE_API_KEY: "k", ...e }), now: () => NOW, store, recordRun: async (r: any) => { runs.push(r); },
    send: () => async () => { sends++; return { ok: true as const, id: null }; } };
  return { deps, runs, limits, shards, mem, sends: () => sends };
}
const post = (body?: unknown) => new Request("https://fn.test/", { method: "POST", headers: { "x-trainee-deliver-secret": SECRET }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const many = (n: number) => Array.from({ length: n }, (_, i) => row(`${i + 1}`, i + 1));

Deno.test("handler: defaults are a batch of 100 and 4 at once; the settings change them; bad values are a configuration error", async () => {
  eq([DEFAULT_BATCH_SIZE, DEFAULT_CONCURRENCY], [100, 4]);
  const a = harness({}, many(3));
  eq((await handleDeliver(post(), a.deps as any)).status, 200);
  eq(a.limits[0], 100);
  const b = harness({ DELIVER_BATCH_SIZE: "7" }, many(3));
  await handleDeliver(post(), b.deps as any);
  eq(b.limits[0], 7);
  for (const bad of [{ DELIVER_BATCH_SIZE: "0" }, { DELIVER_BATCH_SIZE: "100000" }, { DELIVER_CONCURRENCY: "x" }, { DELIVER_MAX_ROUNDS: "-1" }, { DELIVER_CONCURRENCY: "99" }]) {
    const h = harness(bad, many(2));
    const res = await handleDeliver(post(), h.deps as any);
    eq(res.status, 503, JSON.stringify(bad));
    eq(h.sends(), 0, "nothing sent on a bad setting");
  }
});

Deno.test("handler: a full queue drains in rounds within one run; DELIVER_MAX_ROUNDS bounds it; every row once", async () => {
  const a = harness({}, many(250));
  const res = await (await handleDeliver(post(), a.deps as any)).json();
  eq(res.delivered, 250);
  eq(a.sends(), 250, "no row twice");
  eq(a.runs.length, 1, "one record for the run");
  const b = harness({ DELIVER_MAX_ROUNDS: "1" }, many(250));
  eq((await (await handleDeliver(post(), b.deps as any)).json()).delivered, 100);
});

Deno.test("handler: rows that cannot move (capped) do not loop the run", async () => {
  const h = harness({ LOOPMESSAGE_DAILY_CONTACTS: "1", DELIVER_BATCH_SIZE: "3" }, many(8));
  const res = await (await handleDeliver(post(), h.deps as any)).json();
  eq(res.delivered, 1);
  assert(h.limits.length <= 3, `rounds: ${h.limits.length}`);
});

Deno.test("handler: a shard in the body reaches the store; a bad shard is a 400 and sends nothing", async () => {
  const h = harness({}, many(2));
  eq((await handleDeliver(post({ shard: 2, shards: 4 }), h.deps as any)).status, 200);
  eq(h.shards[0], { shard: { index: 2, count: 4 } });
  const plain = harness({}, many(1));
  await handleDeliver(post({}), plain.deps as any);
  eq(plain.shards[0], undefined, "no body shard: the store is built as before");
  for (const bad of [{ shard: 4, shards: 4 }, { shard: -1, shards: 4 }, { shard: 0, shards: 65 }, { shard: "a", shards: 2 }, { shard: 1 }]) {
    const x = harness({}, many(2));
    eq((await handleDeliver(post(bad), x.deps as any)).status, 400, JSON.stringify(bad));
    eq(x.sends(), 0);
  }
});

// ----------------------------------------------------------------------------------------------- the store's lanes
function fakeAdmin(answer: (name: string, args: any) => { data: unknown; error: unknown }) {
  const calls: { name: string; args: any }[] = [];
  const chain: any = new Proxy({}, { get: (_t, p) => (p === "then" ? (res: any) => Promise.resolve({ data: [], error: null }).then(res) : () => chain) });
  return { admin: { rpc: async (name: string, args: any) => { calls.push({ name, args }); return answer(name, args); }, from: () => chain }, calls };
}
const claimRow = (id: number, key: string) => ({ id, user_id: `u${id}`, contact: `+1555000${id}`, key, text: key, deliver_at: new Date(NOW - id * 1000).toISOString(), attempts: 0, prior_status: "queued" });

Deno.test("store lanes: priority first, then bulk for what is left of the batch, the shard on both; priority rows are handed out first", async () => {
  const f = fakeAdmin((name, a) => ({ data: a.p_lane === "priority" ? [claimRow(5, "reply:a"), claimRow(6, "card:b")] : [claimRow(1, "alert:c"), claimRow(2, "alert:d")], error: null }));
  const rows = await supabaseChannelStore(f.admin, { lanes: true, shard: { index: 1, count: 4 } }).due(NOW, 10);
  eq(f.calls.map((c) => [c.name, c.args.p_lane, c.args.p_limit, c.args.p_shard, c.args.p_shards]), [["career_outbox_claim_lane", "priority", 10, 1, 4], ["career_outbox_claim_lane", "bulk", 8, 1, 4]]);
  eq(rows.slice(0, 2).map((r) => r.key).sort(), ["card:b", "reply:a"], "priority rows lead");
});

Deno.test("store lanes: a full priority batch claims no bulk; a project without the migration falls back to the plain claim, once", async () => {
  const full = fakeAdmin(() => ({ data: [claimRow(1, "reply:a"), claimRow(2, "reply:b")], error: null }));
  await supabaseChannelStore(full.admin, { lanes: true }).due(NOW, 2);
  eq(full.calls.length, 1, "no bulk call when the priority lane filled the batch");
  const old = fakeAdmin((name) => name === "career_outbox_claim_lane" ? { data: null, error: { code: "PGRST202", message: "Could not find the function public.career_outbox_claim_lane in the schema cache" } } : { data: [claimRow(1, "alert:x")], error: null });
  const store = supabaseChannelStore(old.admin, { lanes: true });
  eq((await store.due(NOW, 5)).length, 1);
  await store.due(NOW, 5);
  eq(old.calls.map((c) => c.name), ["career_outbox_claim_lane", "career_outbox_claim", "career_outbox_claim"], "tried once, then the plain claim");
  const plain = fakeAdmin(() => ({ data: [], error: null }));
  await supabaseChannelStore(plain.admin).due(NOW, 5);
  eq(plain.calls.map((c) => c.name), ["career_outbox_claim"], "lanes off: the old claim only");
  const broken = fakeAdmin(() => ({ data: null, error: { message: "permission denied for function career_outbox_claim_lane" } }));
  let msg = ""; try { await supabaseChannelStore(broken.admin, { lanes: true }).due(NOW, 5); } catch (e) { msg = (e as Error).message; }
  assert(/claim due messages: permission denied/.test(msg), "another error is an error, never an empty queue: " + msg);
});
