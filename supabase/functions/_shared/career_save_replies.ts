// What a refused save can truthfully say (launch readiness, review of #200).
//
// A turn can change things BEFORE its commit, and a refused commit (a conflict) does not undo them:
//   - a card "yes" answers the card and queues the approved applications (career_apply_card_answer_as), which the
//     person's computer or the cloud will submit;
//   - a follow-up or apply-by-email "yes" sends the email from the person's Gmail inside the turn;
//   - a tool that writes the person's own data (a standing instruction, the apply queue, an answer) writes at once.
// So the reply is built from what this turn actually did, as recorded by trackTurnEffects below (every write the
// turn's service client made, the database's own answer to a card yes, and each send's result). "Nothing new was
// started" is said only when the turn did nothing (tests/architect/flow-account-memory.test.ts pins it for that case).

export interface TurnEffects {
  on: boolean;
  /** Writes other than the turn's own bookkeeping: "table:<name>" or "rpc:<name>". */
  writes: Set<string>;
  /** Applications the database queued for submission in this turn (a card yes). */
  queued: number;
  /** Emails sent from the person's Gmail in this turn; and sends whose outcome is unknown. */
  sent: number;
  sendUnknown: number;
}

export const newTurnEffects = (): TurnEffects => ({ on: false, writes: new Set(), queued: 0, sent: 0, sendUnknown: 0 });

// The turn's own bookkeeping, not something it did for the person: the turn gate, the thread load and commit, the
// cost meter, and the rpcs that only read (PostgREST calls every rpc with POST).
const BOOKKEEPING = new Set([
  "rpc:career_turn_gate_enter", "rpc:career_turn_gate_ready", "rpc:career_turn_gate_leave",
  "rpc:career_host_load", "rpc:career_host_commit", "rpc:career_task_turn_commit_v1", "rpc:career_batch_turn_commit_v1",
  "rpc:career_task_result_v1", "rpc:career_batch_result_v1", "table:agent_turn_costs",
]);
const READ_RPC = /^rpc:(career_[a-z_]*(_read|_get|_state|_ledger|_daily_limit|_for_read|_open_as|_sources|_read_own|_profile_for)|career_apply_ledger)$/;

/** A fetch for the turn's service client that records what the turn writes while effects.on. */
export function trackTurnEffects(effects: TurnEffects): typeof fetch {
  return (async (input: Request | URL | string, init?: RequestInit) => {
    const res = await globalThis.fetch(input as any, init);
    if (!effects.on) return res;
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const m = url.match(/\/rest\/v1\/(rpc\/)?([A-Za-z0-9_]+)/);
      if (!m || method === "GET" || method === "HEAD") return res;
      const name = (m[1] ? "rpc:" : "table:") + m[2];
      if (BOOKKEEPING.has(name) || READ_RPC.test(name) || !res.ok) return res;
      effects.writes.add(name);
      if (name === "rpc:career_apply_card_answer_as") {
        const rows = await res.clone().json().catch(() => null);
        if (Array.isArray(rows)) effects.queued += rows.filter((r: any) => r?.result === "queued").length;
      }
    } catch { /* recording never fails the turn */ }
    return res;
  }) as typeof fetch;
}

/** Wraps a send so its result is recorded: "sent", or an outcome that may have sent. */
export function countSend<A extends unknown[], R extends { status?: string }>(effects: TurnEffects, send: (...a: A) => Promise<R>) {
  return async (...a: A): Promise<R> => {
    let r: R;
    try { r = await send(...a); } catch (e) { effects.sendUnknown++; throw e; }
    if (r?.status === "sent") effects.sent++;
    else if (r?.status === "UNKNOWN") effects.sendUnknown++;
    return r;
  };
}

const LEAD: Record<string, string> = {
  revision_conflict: "I couldn't save my answer to that message because your conversation moved on while I was answering it.",
  turn_key_conflict: "I couldn't save my answer because this message looks like a repeat of an earlier one that had different content.",
  task_event_conflict: "I couldn't save my answer because the job it was about changed while I was answering.",
  watch_profile_conflict: "I couldn't save my answer because your job alerts changed while I was answering.",
  privacy_epoch_changed: "I couldn't save my answer because your saved career data was removed while I was answering.",
};
const AGAIN: Record<string, string> = {
  revision_conflict: "Send it again and I'll answer it.",
  turn_key_conflict: "Send it again as a new message.",
  task_event_conflict: "Send it again and I'll answer it from where things stand now.",
  watch_profile_conflict: "Send it again and I'll answer it from your alerts as they are now.",
  privacy_epoch_changed: "Send it again if you want to carry on.",
};
export const CONFLICT_CODES = Object.keys(LEAD);

/** The reply for a refused save (code is one of CONFLICT_CODES), true to what the turn did. */
export function refusedSaveReply(code: string, e: Pick<TurnEffects, "writes" | "queued" | "sent" | "sendUnknown">): string {
  const out = [LEAD[code] ?? LEAD.revision_conflict];
  const erased = code === "privacy_epoch_changed";
  if (e.queued > 0) {
    const what = e.queued === 1 ? "The application you approved" : `The ${e.queued} applications you approved`;
    out.push(erased
      ? `${what} ${e.queued === 1 ? "was" : "were"} queued to be submitted before that; ask me what's queued to check.`
      : `${what} ${e.queued === 1 ? "is" : "are"} queued and will be submitted.`);
  }
  if (e.sent > 0) out.push(e.sent === 1 ? "The email you approved was sent." : `The ${e.sent} emails you approved were sent.`);
  if (e.sendUnknown > 0) out.push("I couldn't confirm whether the email you approved went out, so check your Gmail Sent folder before sending it again.");
  const external = e.queued > 0 || e.sent > 0 || e.sendUnknown > 0;
  const other = e.writes.size > 0;
  if (!external && !other) out.push("Nothing new was started, and nothing was sent or submitted.");
  else {
    if (!external) out.push("Nothing was sent or submitted.");
    if (other) out.push(erased ? "Anything else this message saved was removed with your data." : "Anything else this message saved, like an instruction or an answer, stays saved.");
  }
  out.push(external ? "You don't need to approve anything again." : AGAIN[code] ?? AGAIN.revision_conflict);
  return out.join(" ");
}

/** The reply for a refused save when the turn did nothing (kept for callers that have no effects record). */
export const CONFLICT_REPLY = refusedSaveReply("revision_conflict", { writes: new Set(), queued: 0, sent: 0, sendUnknown: 0 });
