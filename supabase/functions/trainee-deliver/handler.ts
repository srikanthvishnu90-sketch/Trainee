// The scheduled delivery run (WO-013b-1), as a function of its inputs so it is testable without a database or a provider.
// pg_cron calls it every minute (scripts/launch/schedule-trainee-deliver.sql, run by the owner) with the shared secret.
// It sends what career_outbox has due under the channel's rules (channel.ts deliverDue): STOP holds, at most once, retried
// with backoff, each provider's daily cap. WO-038: each row goes out through its channel's adapter (iMessage through
// LoopMessage, WhatsApp, Telegram); a channel without its secrets is NOT_WIRED and its rows stay queued. With no channel
// wired at all it answers NOT_WIRED and sends nothing.
import { equalSecret } from "../_shared/message_service.ts";
import { deliverDue, type Send } from "../_shared/channel.ts";
import { toBubbles } from "../_shared/conversation.ts";
import { imessageNativeRender, textingNativeOn } from "../_shared/channel_voice.ts";
import type { Channel, DeliveryAdapter } from "../_shared/channel_adapters.ts";
import type { DeliveryStore } from "../_shared/channel_store.ts";

// DELIVERY THROUGHPUT (scale-90k bottleneck 5): rows a round claims, rows of different people sent at once, and rounds a run
// repeats while the queue is full, are all settings (DELIVER_BATCH_SIZE, DELIVER_CONCURRENCY, DELIVER_MAX_ROUNDS). A run that
// nears its time budget stops (channel.ts deliverDue). Several runs can go side by side: a body {"shard": k, "shards": n} takes
// only the people of shard k (see scripts/launch/schedule-trainee-deliver.sql). The channels' own limits still hold: each
// adapter paces itself, and Telegram's 30 a second is the shared database bucket (channel_pacer.ts).
export const DEFAULT_BATCH_SIZE = 100, MAX_BATCH_SIZE = 300;
export const DEFAULT_CONCURRENCY = 4, MAX_CONCURRENCY = 32;
export const DEFAULT_MAX_ROUNDS = 20, MAX_ROUNDS = 200;
export const ROWS_PER_RUN = DEFAULT_BATCH_SIZE;
export const RUN_BUDGET_MS = 100_000; // under the Edge wall clock (150 s on the smallest plan), with room to record the run
export const DEFAULT_DAILY_CONTACTS = 300; // LoopMessage's smaller plan; set LOOPMESSAGE_DAILY_CONTACTS for the larger one
export type DeliveryRun = { delivered: number; failed: number; retried: number; skipped_opt_out: number; capped: number; deferred?: number; held?: number; nudged?: number; not_wired?: number; swept: number; rerouted?: number; ms: number; error: string | null; at: string };
export interface DeliverDeps {
  env: { get(k: string): string | undefined };
  store: (o?: { shard?: { index: number; count: number } }) => DeliveryStore;
  send: (apiKey: string) => Send;
  // WO-038: the other channels' adapters from the secrets (WhatsApp, Telegram). Absent: iMessage only, as before.
  adapters?: (env: DeliverDeps["env"]) => Partial<Record<Channel, DeliveryAdapter>>;
  recordRun: (r: DeliveryRun) => Promise<void>;
  now: () => number;
}
// An optional whole-number setting: unset is the default; anything else outside min..max is a configuration error (503), never a guess.
const setting = (env: DeliverDeps["env"], name: string, d: number, min: number, max: number): number | string => {
  const raw = env.get(name);
  if (raw === undefined || raw === "") return d;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : `not configured: ${name} must be a whole number from ${min} to ${max}`;
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleDeliver(req: Request, d: DeliverDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = d.env.get("TRAINEE_DELIVER_SECRET") || "";
  if (secret.length < 32) return json({ error: "not configured: TRAINEE_DELIVER_SECRET must be set, 32 characters or more" }, 503);
  if (!equalSecret(req.headers.get("x-trainee-deliver-secret") || "", secret)) return json({ error: "Unauthorized" }, 401);
  const apiKey = d.env.get("LOOPMESSAGE_API_KEY") || "";
  let others: Partial<Record<Channel, DeliveryAdapter>>;
  try { others = d.adapters ? d.adapters(d.env) : {}; } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 503); }
  delete others.imessage; // iMessage is always LoopMessage with the key above
  if (!apiKey && !Object.keys(others).length) return json({ error: "NOT_WIRED: LOOPMESSAGE_API_KEY is not set, nor TELEGRAM_BOT_TOKEN, nor WHATSAPP_TOKEN with WHATSAPP_PHONE_NUMBER_ID; nothing was sent" }, 503);
  const capRaw = d.env.get("LOOPMESSAGE_DAILY_CONTACTS");
  const cap = capRaw === undefined || capRaw === "" ? DEFAULT_DAILY_CONTACTS : Number(capRaw);
  if (!Number.isInteger(cap) || cap < 1) return json({ error: "not configured: LOOPMESSAGE_DAILY_CONTACTS must be a whole number of contacts a day" }, 503);
  const adapters: Partial<Record<Channel, DeliveryAdapter>> = { ...others };
  // CHANNEL DELIVERY SCENARIOS (2026-10-29): with CAREER_TEXTING_NATIVE=on iMessage gets plain text too (it was always the
  // raw markdown here, "**bold**" and "# headings" included, whatever the setting).
  if (apiKey) adapters.imessage = { channel: "imessage", limits: { dailyContacts: cap }, render: textingNativeOn(d.env) ? imessageNativeRender : toBubbles, send: d.send(apiKey) };
  const batch = setting(d.env, "DELIVER_BATCH_SIZE", DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE), concurrency = setting(d.env, "DELIVER_CONCURRENCY", DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
    maxRounds = setting(d.env, "DELIVER_MAX_ROUNDS", DEFAULT_MAX_ROUNDS, 1, MAX_ROUNDS);
  for (const v of [batch, concurrency, maxRounds]) if (typeof v === "string") return json({ error: v }, 503);
  // The shard: from the body of the scheduler's call, if it names one.
  const body = await req.json().catch(() => null) as { shard?: unknown; shards?: unknown } | null;
  let shard: { index: number; count: number } | undefined;
  if (body && (body.shard !== undefined || body.shards !== undefined)) {
    const index = Number(body.shard), count = Number(body.shards);
    if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || count > 64 || index < 0 || index >= count) return json({ error: "shard must be a whole number below shards, and shards from 1 to 64" }, 400);
    shard = { index, count };
  }
  const started = d.now(), at = new Date(started).toISOString();
  const store = d.store(shard ? { shard } : undefined);
  let swept = 0;
  try {
    swept = await store.sweep(started);
    // CHANNEL DELIVERY ROUND 2 (2026-10-30): a row bound to a channel the person unlinked (Telegram "unlink", a WhatsApp
    // number that changed owner or moved) waited "queued" forever; now it goes to their home channel, or fails with the reason.
    const rerouted = store.reroute ? await store.reroute(started) : 0;
    // Rounds: while a round claimed a full batch and moved at least one row on, claim the next, until the run's time is spent.
    // Each round puts back what it claimed and did not send (capped rows, rows of a channel not wired) before the next, and a
    // round that moved nothing ends the run (those rows would only be claimed again).
    const r = { delivered: 0, failed: 0, retried: 0, skipped_opt_out: 0, capped: 0, deferred: 0, held: 0, nudged: 0, not_wired: 0 };
    for (let round = 1; round <= (maxRounds as number); round++) {
      const t0 = d.now(), left = RUN_BUDGET_MS - (t0 - started);
      if (round > 1 && left < 10_000) break;
      const x = await deliverDue({ store, adapters, now: t0, limit: batch as number, clock: d.now, budgetMs: left, concurrency: concurrency as number });
      // Only a run that finished puts back what it claimed and did not send. After a failure mid-run a claimed row may already
      // be with the provider, so it stays "sending" and the next sweep fails it instead of resending it.
      await store.release();
      for (const k of Object.keys(r) as (keyof typeof r)[]) r[k] += x[k];
      const claimed = x.delivered + x.failed + x.retried + x.skipped_opt_out + x.capped + x.deferred + x.held + x.not_wired;
      const moved = x.delivered + x.failed + x.retried + x.skipped_opt_out + x.held;
      if (claimed < (batch as number) || moved === 0 || x.deferred > 0) break;
    }
    const run = { ...r, swept, ...(rerouted ? { rerouted } : {}), ms: d.now() - started, error: null, at };
    await d.recordRun(run);
    return json(run);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("trainee-deliver failed:", error);
    try { await d.recordRun({ delivered: 0, failed: 0, retried: 0, skipped_opt_out: 0, capped: 0, swept, ms: d.now() - started, error, at }); } catch { /* the failure is already logged */ }
    return json({ error: "delivery run failed", detail: error }, 500);
  }
}
