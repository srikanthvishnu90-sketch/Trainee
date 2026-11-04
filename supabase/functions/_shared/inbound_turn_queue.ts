// ACK FAST (CHAT_QUEUE, scale plan bottleneck 2): the durable queue between a chat webhook and the turn. The migration is
// 20261102170000_inbound_turn_queue.sql (the table and the claim); the webhook side is handleChannelWebhook / handleInbound
// (queue dep), the worker is supabase/functions/trainee-turn-worker.
//
// THE SWITCH (release-flag style, agent-chat/release_config.ts): CHAT_QUEUE=on turns it on; unset, "off", or any other value
// is off, so a mistyped rollback still rolls back. It is read at call time, per request: `supabase secrets set CHAT_QUEUE=off`
// puts every webhook back to running the turn inline, with no deploy. The worker does not read it: a row already written (the
// provider has its 200) is always run, flag or no flag.
import type { InboundMessage } from "./channel_adapters.ts";
import type { InboundStore } from "./channel_inbound.ts";

type Env = { get(k: string): string | undefined };
export const CHAT_QUEUE_ENV = "CHAT_QUEUE";
export const MAX_ATTEMPTS = 3;
export const LEASE_SECONDS = 180; // longer than a turn can run (chatThroughAgent aborts at 120 s) so a live turn is never taken over
export const TURN_SECRET_ENV = "TRAINEE_TURN_SECRET";
export const MAX_INFLIGHT = 20; // the global cap on turns running at once (inbound_turn_claim p_max_inflight; TURN_MAX_INFLIGHT overrides)
// On only with the worker reachable: CHAT_QUEUE=on AND TRAINEE_TURN_SECRET of 32+ characters (the worker refuses anything less, so
// queueing without it would acknowledge texts nobody runs). Otherwise the webhook runs the turn inline, the old path, and says why.
export function chatQueueOn(env: Env): boolean {
  if ((env.get(CHAT_QUEUE_ENV) ?? "").trim().toLowerCase() !== "on") return false;
  if ((env.get(TURN_SECRET_ENV) ?? "").length >= 32) return true;
  console.error("CHAT_QUEUE=on but TRAINEE_TURN_SECRET is missing or shorter than 32 characters: running turns inline (queue not used)");
  return false;
}

// "<provider>:<message id>": the dedupe key (a Telegram update id and an iMessage id never collide).
export const providerKey = (m: Pick<InboundMessage, "provider" | "messageId">) => `${m.provider}:${m.messageId}`;

export interface QueueRow { id: number; channel: string; provider_msg_id: string; contact: string | null; payload: InboundMessage; attempts: number; claim_token: string }
export interface WorkerStore {
  claim(limit: number): Promise<QueueRow[]>;
  // told: the turn already told the person it failed (so the sweep does not).
  finish(id: number, token: string, outcome: "done" | "failed" | "retry", error?: string | null, told?: boolean): Promise<string>;
  // The fence and the once-only record of a side effect (inbound_turn_step): false = already done, or this claim is no longer current.
  step(id: number, token: string, step: string): Promise<boolean>;
  untold(limit: number): Promise<QueueRow[]>; // failed rows whose person has not been told
  told(id: number): Promise<boolean>;
  purge?(): Promise<number>;
}
function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}
// deno-lint-ignore no-explicit-any
export function supabaseTurnQueue(admin: any, o: { kick?: () => Promise<unknown> | void } = {}) {
  return {
    async enqueue(msg: InboundMessage): Promise<boolean> {
      const payload = JSON.parse(JSON.stringify(msg));
      return must<boolean>(await admin.rpc("inbound_turn_enqueue", { p_channel: msg.channel, p_msg_id: providerKey(msg), p_contact: msg.contact, p_payload: payload }), "queue the message") === true;
    },
    ...(o.kick ? { kick: o.kick } : {}),
  };
}
// deno-lint-ignore no-explicit-any
export function supabaseWorkerStore(admin: any, o: { leaseSeconds?: number; maxInflight?: number } = {}): WorkerStore {
  return {
    async claim(limit) {
      const rows = must<QueueRow[]>(await admin.rpc("inbound_turn_claim", { p_limit: limit, p_lease_seconds: o.leaseSeconds ?? LEASE_SECONDS, p_max_attempts: MAX_ATTEMPTS, p_max_inflight: o.maxInflight ?? MAX_INFLIGHT }), "claim turns");
      return rows ?? [];
    },
    async finish(id, token, outcome, error, told) {
      return must<string>(await admin.rpc("inbound_turn_finish", { p_id: id, p_token: token, p_outcome: outcome, p_error: error ?? null, p_max_attempts: MAX_ATTEMPTS, p_told: told === true }), "finish a turn");
    },
    async step(id, token, step) { return must<boolean>(await admin.rpc("inbound_turn_step", { p_id: id, p_token: token, p_step: step }), "record a step") === true; },
    async untold(limit) { return must<QueueRow[]>(await admin.rpc("inbound_turn_untold", { p_limit: limit }), "read failed turns") ?? []; },
    async told(id) { return must<boolean>(await admin.rpc("inbound_turn_told", { p_id: id }), "mark a failed turn told") === true; },
    async purge() { return Number(must<number>(await admin.rpc("inbound_turn_purge", {}), "purge finished turns")) || 0; },
  };
}

// The webhook's nudge to the worker: a POST the worker answers 202 at once and runs after (never awaited past ~1.5 s, and a failure is
// nothing: the every-minute run has the row). Absent (no secret set): no nudge, the cron run picks the row up within a minute.
export function workerKick(env: Env, supabaseUrl: string, request: typeof fetch = fetch): (() => Promise<void>) | undefined {
  const secret = env.get("TRAINEE_TURN_SECRET") || "";
  if (secret.length < 32 || !supabaseUrl) return undefined;
  return async () => {
    try {
      const r = await request(`${supabaseUrl}/functions/v1/trainee-turn-worker`, {
        method: "POST", headers: { "content-type": "application/json", "x-trainee-turn-secret": secret },
        body: JSON.stringify({ async: true, limit: 3 }), signal: AbortSignal.timeout(1500),
      });
      await r.body?.cancel();
    } catch { /* the every-minute run has it */ }
  };
}

// The line a person gets when their text failed every attempt and the turn could not say so itself. Model-free and neutral: it says
// nothing about why, and asks them to send it again.
export const FAILED_TURN_REPLY = "I couldn't answer that just now. Please send it again in a minute.";
// Queue that line through the outbox for the person behind this contact, under a key of the message's own (so it is never queued twice).
// true: queued, or there is no account to tell (an unknown chat got no answer to begin with).
export async function failedTurnNotice(store: Pick<InboundStore, "person" | "enqueueReply">, msg: InboundMessage, at: number): Promise<boolean> {
  let person = await store.person(msg.contact);
  for (const alias of msg.aliases ?? []) { if (person) break; person = await store.person(alias); }
  if (!person) return true;
  await store.enqueueReply(person.userId, `reply:failed:${providerKey(msg)}`, FAILED_TURN_REPLY, at, msg.channel);
  return true;
}
