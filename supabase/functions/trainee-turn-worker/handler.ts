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
//  - an interim "on it" line is not repeated on a retry.
import { equalSecret } from "../_shared/message_service.ts";
import { type CoreDeps, runInbound } from "../_shared/channel_inbound.ts";
import { MAX_ATTEMPTS, type QueueRow, type WorkerStore } from "../_shared/inbound_turn_queue.ts";

export const TURN_DEADLINE_MS = 130_000; // under the edge wall clock (150 s on the smallest plan) and the 180 s lease
export interface WorkerDeps {
  env: { get(k: string): string | undefined };
  store: WorkerStore;
  depsFor: (channel: string) => CoreDeps | null; // fresh per row; null: that channel is not wired in this deploy
  deadlineMs?: number;
  // The edge runtime's waitUntil: a kick ({"async":true}) is answered 202 at once and the turns run after the response.
  background?: (p: Promise<unknown>) => void;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export type RowOutcome = "done" | "failed" | "queued" | "stale";
export async function runRow(row: QueueRow, d: WorkerDeps): Promise<RowOutcome> {
  const finish = async (o: "done" | "failed" | "retry", err?: string): Promise<RowOutcome> => {
    const s = await d.store.finish(row.id, row.claim_token, o, err ?? null);
    if (s === "stale") console.error(`turn worker: row ${row.id} was taken over; this attempt changes nothing`);
    return s as RowOutcome;
  };
  const core = d.depsFor(row.channel);
  if (!core) return await finish("retry", `channel ${row.channel} is not wired in this deploy`);
  const final = row.attempts >= MAX_ATTEMPTS;
  let chatError: string | null = null;
  const store = Object.create(core.store) as CoreDeps["store"];
  // The queue's unique key was the claim of this message; channel_inbound still records the id, and a retry finds it recorded.
  store.claimMessage = async (id, at, provider) => { try { await core.store.claimMessage(id, at, provider); } catch (e) { console.error("turn worker: channel_inbound:", e instanceof Error ? e.message : String(e)); } return true; };
  const deps: CoreDeps = {
    ...core, store, queue: undefined, deferFailure: !final,
    ...(row.attempts > 1 ? { ackAfterMs: null } : {}),
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
    // The last attempt: the person was told (CHAT_DOWN_REPLY), and the owner is told through the failed row.
    return await finish("failed", chatError ?? `turn ended with status ${r.status}`);
  } catch (e) {
    return await finish("retry", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
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
    let purged = 0;
    if (body.cron === true && d.store.purge) purged = await d.store.purge().catch(() => 0);
    const count = (o: RowOutcome) => outcomes.filter((x) => x === o).length;
    return { status: 200, body: { ok: true, claimed: rows.length, done: count("done"), failed: count("failed"), retried: count("queued"), stale: count("stale"), purged } };
  };
  if (body.async === true && d.background) { d.background(work()); return json({ ok: true, accepted: true }, 202); }
  const r = await work();
  return json(r.body, r.status);
}
