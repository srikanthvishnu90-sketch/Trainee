// The turn worker (ACK FAST, CHAT_QUEUE): claims queued inbound texts (inbound_turn_claim: FOR UPDATE SKIP LOCKED, a lease, one
// in flight per contact, oldest first) and runs each through the same turn code the webhook ran inline before (runInbound),
// then marks the row. Started two ways: pg_cron every minute (scripts/launch/schedule-trainee-turn-worker.sql, body {"cron":true}),
// and by the webhook right after it queues a text (best effort, body {}). Either may run any number at once: the claim is the lock.
//
// What keeps a message answered once and never lost:
//  - the row is the claim: the worker's runInbound sees its provider id as new on every attempt (the queue's unique key already
//    deduped the delivery), and the reply is written to career_outbox under the message's own key, which refuses a second row, and
//    agent-chat's turn key replays a turn it already saved: a retry cannot answer twice.
//  - a turn that fails, times out, or whose worker dies (the lease runs out) is run again, at most MAX_ATTEMPTS times (backoff 20 s,
//    60 s). Until the last attempt a failure says nothing to the person (deferFailure); on the last the person is told once, as
//    without the queue, and the row is FAILED, kept with its text, and ops-monitor alerts the owner. Nothing is dropped.
//  - an interim "on it" line is not repeated on a retry, and nor is any other straight-out send of the turn (a Yes/No prompt, job cards,
//    documents, a long answer's rest, files, links): each is recorded on the row BEFORE it is sent (inbound_turn_step), so a retry after
//    a death skips it (at most once), and an attempt that timed out or lost its claim is fenced: its later sends are refused.
//  - a failed row whose person was not told (channel not wired, a timeout on the last attempt, a dead worker) gets one neutral line
//    through the outbox from the sweep (tellUntold).
import { equalSecret } from "../_shared/message_service.ts";
import { type CoreDeps, runInbound } from "../_shared/channel_inbound.ts";
import type { InboundMessage } from "../_shared/channel_adapters.ts";
import { MAX_ATTEMPTS, type QueueRow, type WorkerStore } from "../_shared/inbound_turn_queue.ts";

export const TURN_DEADLINE_MS = 130_000; // under the edge wall clock (150 s on the smallest plan) and the 180 s lease
export interface WorkerDeps {
  env: { get(k: string): string | undefined };
  store: WorkerStore;
  depsFor: (channel: string) => CoreDeps | null; // fresh per row; null: that channel is not wired in this deploy
  // The neutral line to the person of a failed row nobody told (queued through the outbox under a key of the message's own, so it is
  // never sent twice); true when it is queued or there is no one to tell. Absent: failed rows are only surfaced to ops.
  notifyFailed?: (msg: InboundMessage) => Promise<boolean>;
  deadlineMs?: number;
  // The edge runtime's waitUntil: a kick ({"async":true}) is answered 202 at once and the turns run after the response.
  background?: (p: Promise<unknown>) => void;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export type RowOutcome = "done" | "failed" | "queued" | "stale";
export async function runRow(row: QueueRow, d: WorkerDeps): Promise<RowOutcome> {
  // FENCE: once this attempt is over (timed out, failed) `fenced` is set, and nothing it still has in flight may send: the straight-out
  // steps are refused by `once` (here and in the database, where the token is no longer the row's claim), and the outbox write and the
  // head start are cut here.
  let fenced = false;
  const finish = async (o: "done" | "failed" | "retry", err?: string, told = false): Promise<RowOutcome> => {
    if (o !== "done") fenced = true;
    const s = await d.store.finish(row.id, row.claim_token, o, err ?? null, told);
    if (s === "stale") { fenced = true; console.error(`turn worker: row ${row.id} was taken over; this attempt changes nothing`); }
    return s as RowOutcome;
  };
  const core = d.depsFor(row.channel);
  if (!core) return await finish("retry", `channel ${row.channel} is not wired in this deploy`);
  const final = row.attempts >= MAX_ATTEMPTS;
  let chatError: string | null = null;
  const store = Object.create(core.store) as CoreDeps["store"];
  // The queue's unique key was the claim of this message; channel_inbound still records the id, and a retry finds it recorded.
  store.claimMessage = async (id, at, provider) => { try { await core.store.claimMessage(id, at, provider); } catch (e) { console.error("turn worker: channel_inbound:", e instanceof Error ? e.message : String(e)); } return true; };
  store.enqueueReply = async (...a) => (fenced ? false : await core.store.enqueueReply(...a));
  const deps: CoreDeps = {
    ...core, store, queue: undefined, deferFailure: !final,
    ...(row.attempts > 1 ? { ackAfterMs: null } : {}),
    once: async (step) => !fenced && await d.store.step(row.id, row.claim_token, step).catch(() => false),
    deliver: async (a) => (fenced ? undefined : await core.deliver(a)),
    chat: async (a) => { try { return await core.chat(a); } catch (e) { chatError = e instanceof Error ? e.message : String(e); throw e; } },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      runInbound(row.payload, deps),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("turn timed out")), d.deadlineMs ?? TURN_DEADLINE_MS); }),
    ]);
    if (r.status === 503 && r.body.retry) return await finish("retry", String(r.body.error ?? "turn failed"));
    if (r.status === 200 && !chatError) return await finish("done");
    // The last attempt: runInbound told the person (CHAT_DOWN_REPLY) on its own; the failed row tells the owner.
    return await finish("failed", chatError ?? `turn ended with status ${r.status}`, true);
  } catch (e) {
    return await finish("retry", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

// Failed rows nobody told (a channel that is not wired, a turn that timed out on its last attempt, a worker that died on it): one neutral,
// model-free line through the outbox, under the message's own key, then the row is marked. Never says what failed.
export async function tellUntold(d: WorkerDeps, limit = 10): Promise<number> {
  if (!d.notifyFailed) return 0;
  let n = 0;
  for (const r of await d.store.untold(limit)) {
    try { if (await d.notifyFailed(r.payload) && await d.store.told(r.id)) n++; }
    catch (e) { console.error(`turn worker: could not tell the person of failed row ${r.id}:`, e instanceof Error ? e.message : String(e)); }
  }
  return n;
}

export async function handleTurnWorker(req: Request, d: WorkerDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = d.env.get("TRAINEE_TURN_SECRET") || "";
  if (secret.length < 32) return json({ error: "not configured: TRAINEE_TURN_SECRET must be set, 32 characters or more" }, 503);
  if (!equalSecret(req.headers.get("x-trainee-turn-secret") || "", secret)) return json({ error: "Unauthorized" }, 401);
  const body = await req.json().catch(() => ({})) as { limit?: unknown; cron?: unknown; async?: unknown };
  const limit = Math.min(10, Math.max(1, Math.floor(Number(body.limit)) || 3));
  const work = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
    let rows: QueueRow[];
    try { rows = await d.store.claim(limit); }
    catch (e) { console.error("turn worker: claim failed:", e instanceof Error ? e.message : String(e)); return { status: 500, body: { error: "claim failed" } }; }
    // One row per contact per claim (the claim's ordering rule), so these never touch the same person's thread together.
    const outcomes = await Promise.all(rows.map((r) => runRow(r, d).catch((e) => { console.error("turn worker:", e instanceof Error ? e.message : String(e)); return "stale" as RowOutcome; })));
    const told = await tellUntold(d).catch(() => 0);
    let purged = 0;
    if (body.cron === true && d.store.purge) purged = await d.store.purge().catch(() => 0);
    const count = (o: RowOutcome) => outcomes.filter((x) => x === o).length;
    return { status: 200, body: { ok: true, claimed: rows.length, done: count("done"), failed: count("failed"), retried: count("queued"), stale: count("stale"), told, purged } };
  };
  if (body.async === true && d.background) { d.background(work()); return json({ ok: true, accepted: true }, 202); }
  const r = await work();
  return json(r.body, r.status);
}
