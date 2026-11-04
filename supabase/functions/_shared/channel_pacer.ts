// The Telegram limits across EVERY invocation (scale-90k bottleneck 6): about 30 messages a second for the bot and one a
// second to a chat. The in-process pacer (channel_adapters.ts pacer) only knows its own request; this one takes a token from
// the database bucket (channel_rate_acquire, 20261102180000_delivery_throughput.sql) that all invocations share. The global
// and the chat's token are taken in one atomic call: both, or neither.
//
// Defaults sit under Telegram's numbers so any one-second window stays inside 30: 25 a second with a burst of 5 (25 + 5 = 30).
// TELEGRAM_GLOBAL_RATE / TELEGRAM_GLOBAL_BURST change them (whole numbers); TELEGRAM_GLOBAL_PACER=off turns the shared bucket off
// (the in-process pacer alone, as before).
//
// If the database cannot answer (the function is not applied yet, a network error) the send goes ahead on the in-process pacer
// and the failure is logged: Telegram's own 429 (honoured in telegram.ts) is the backstop. A wait longer than maxWaitMs is
// not slept in the request: the caller is told to retry after that long (the outbox keeps the message).
export type SharedPace = (chat: string, o?: { urgent?: boolean }) => Promise<{ ok: true } | { ok: false; retryAfterMs: number }>;
type Rpc = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };
type Env = { get(k: string): string | undefined };

export const TELEGRAM_GLOBAL_RATE = 25;
export const TELEGRAM_GLOBAL_BURST = 5;
export const TELEGRAM_BUCKET = "telegram:global";

export function dbTelegramPacer(admin: Rpc, o: {
  rate?: number; burst?: number; perChatRate?: number; maxWaitMs?: number; urgentMaxWaitMs?: number; sleep?: (ms: number) => Promise<void>; random?: () => number; log?: (m: string) => void;
} = {}): SharedPace {
  const rate = o.rate ?? TELEGRAM_GLOBAL_RATE, burst = o.burst ?? TELEGRAM_GLOBAL_BURST, chatRate = o.perChatRate ?? 1;
  const maxWait = o.maxWaitMs ?? 8000, urgentWait = o.urgentMaxWaitMs ?? 40000, random = o.random ?? Math.random, log = o.log ?? ((m) => console.error(m));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (chat, how) => {
    let waited = 0;
    const limit = how?.urgent ? Math.max(maxWait, urgentWait) : maxWait; // an answer to the person's own message (STOP, a crisis reply) waits for its token rather than being queued a minute later
    for (;;) {
      let ms: number;
      try {
        const r = await admin.rpc("channel_rate_acquire", { p_keys: [TELEGRAM_BUCKET, `telegram:chat:${chat}`], p_rates: [rate, chatRate], p_bursts: [burst, 1], p_cost: 1 });
        if (r.error || typeof r.data !== "number" || !Number.isFinite(r.data)) throw new Error(r.error?.message ?? "unexpected answer");
        ms = r.data;
      } catch (e) {
        log(`telegram pacer: the shared bucket could not be read, pacing in this process only: ${e instanceof Error ? e.message : String(e)}`);
        return { ok: true };
      }
      if (ms <= 0) return { ok: true };
      if (waited + ms > limit) return { ok: false, retryAfterMs: ms };
      const nap = ms + Math.floor(random() * Math.max(1, ms / 4)); // spread the callers that were told the same wait
      await sleep(nap); waited += nap;
    }
  };
}

export function telegramPacerFromEnv(env: Env, admin: Rpc | undefined, o: { sleep?: (ms: number) => Promise<void> } = {}): SharedPace | undefined {
  if (!admin || (env.get("TELEGRAM_GLOBAL_PACER") || "").toLowerCase() === "off") return undefined;
  const whole = (k: string, d: number) => { const n = Number(env.get(k)); return Number.isInteger(n) && n > 0 ? n : d; };
  return dbTelegramPacer(admin, { rate: whole("TELEGRAM_GLOBAL_RATE", TELEGRAM_GLOBAL_RATE), burst: whole("TELEGRAM_GLOBAL_BURST", TELEGRAM_GLOBAL_BURST), sleep: o.sleep });
}
