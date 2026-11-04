// Launch readiness R1 (2026-10-26): a conversation's chat turns run one at a time, in the order agent-chat received them
// (20261026230300_career_turn_gate.sql). Two texts sent close together used to run two turns on the same thread
// revision; the second to commit was refused with revision_conflict and the person read "I couldn't answer that just now".
//
// enterTurnGate takes a ticket before the turn reads its thread and waits until the person's earlier turns have
// committed (or their tickets lapsed). The gate never blocks a turn for good:
//   - a ticket lapses after its lease (LEASE_SECONDS), so a crashed turn holds the next one for at most that long;
//   - after WAIT_MS the turn goes ahead anyway (career_host_commit still refuses a stale write, and the channel's
//     chatThroughAgent retries that once with a fresh read);
//   - if the gate itself cannot be read (the migration not applied yet, a failed call), the turn goes ahead as before.
// leave() gives the ticket back; the handler calls it after the commit, on every path.
export const LEASE_SECONDS = 90, WAIT_MS = 60_000, POLL_MS = 120;

export interface TurnGate { ticket: number | null; waitedMs: number; outcome: "first" | "waited" | "timed_out" | "unavailable"; leave(): Promise<void> }

export async function enterTurnGate(admin: any, userId: string, turnKey: string, o: { thread?: string; waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<TurnGate> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now, started = now(), waitMs = o.waitMs ?? WAIT_MS, pollMs = o.pollMs ?? POLL_MS;
  const none = (outcome: TurnGate["outcome"]): TurnGate => ({ ticket: null, waitedMs: now() - started, outcome, leave: async () => {} });
  let ticket: number;
  try {
    const r = await admin.rpc("career_turn_gate_enter", { p_user: userId, p_turn_key: turnKey, p_lease_seconds: LEASE_SECONDS, p_thread: o.thread ?? "" });
    if (r.error || r.data === null || r.data === undefined) { console.error("career turn gate: no ticket:", r.error?.message ?? "empty"); return none("unavailable"); }
    ticket = Number(r.data);
  } catch (e) { console.error("career turn gate: no ticket:", (e as Error)?.message ?? e); return none("unavailable"); }
  const leave = async () => {
    try { const r = await admin.rpc("career_turn_gate_leave", { p_user: userId, p_ticket: ticket }); if (r.error) console.error("career turn gate: leave:", r.error.message); }
    catch (e) { console.error("career turn gate: leave:", (e as Error)?.message ?? e); }
  };
  let polls = 0;
  for (;;) {
    let ready = false;
    try {
      const r = await admin.rpc("career_turn_gate_ready", { p_user: userId, p_ticket: ticket });
      if (r.error) { console.error("career turn gate: ready:", r.error.message); return { ticket, waitedMs: now() - started, outcome: "unavailable", leave }; }
      ready = r.data === true;
    } catch (e) { console.error("career turn gate: ready:", (e as Error)?.message ?? e); return { ticket, waitedMs: now() - started, outcome: "unavailable", leave }; }
    if (ready) return { ticket, waitedMs: now() - started, outcome: polls ? "waited" : "first", leave };
    if (now() - started >= waitMs) { console.error(`career turn gate: went ahead after ${now() - started} ms behind an earlier turn`); return { ticket, waitedMs: now() - started, outcome: "timed_out", leave }; }
    polls++;
    await sleep(pollMs);
  }
}
