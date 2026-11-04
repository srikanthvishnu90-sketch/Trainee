// Launch readiness X3 / M9 (2026-10-26): the discovery pool (about 0.9 MB of career_kb_postings) is read only on turns
// that use it.
//
// It used to be read at the top of every turn, before any code-first turn ran, so "hi", a card's "yes" and "show my
// applications" each paid for 600 postings. Now:
//   1. a turn a code-first stage answers (the card, the mock, the apply queue, receipts, status, ...) never reads it;
//   2. a turn that reaches the router reads it only when the router uses postings for that message. That is decided by
//      running the router once on a disposable deep copy of the turn (deepTurnCopy) whose pool is an
//      empty list that records every read of it. If the router never looks at the pool, the pool cannot change its
//      answer, so it is not read. If it looks at all (or the probe fails), the pool is read and the turn runs on it.
// No list of intents is kept here: the router's own behavior on the message decides.
import { deepTurnCopy } from "./career_staged.ts";

type Host = { runTurn(text: string, ctx: any): unknown };

// An empty list that counts every property read (length, map, an index, iteration).
export function trackedEmptyPool(): { pool: unknown[]; reads: () => number } {
  let n = 0;
  const pool = new Proxy([] as unknown[], { get(t, k, r) { n++; return Reflect.get(t, k, r); } });
  return { pool, reads: () => n };
}

export function poolNeeded(o: { host: Host; message: string; ctx: Record<string, unknown> }): { needed: boolean; reason: "router_reads_pool" | "router_ignores_pool" | "probe_failed" } {
  try {
    const copy = deepTurnCopy(o.ctx) as Record<string, unknown>;
    copy.containmentRecords = [];
    const t = trackedEmptyPool();
    copy.postings = t.pool;
    o.host.runTurn(o.message, copy);
    return t.reads() > 0 ? { needed: true, reason: "router_reads_pool" } : { needed: false, reason: "router_ignores_pool" };
  } catch {
    return { needed: true, reason: "probe_failed" };
  }
}
