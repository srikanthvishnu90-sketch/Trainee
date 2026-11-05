// An injected clock for the send pacing of the Postgres flow tests (CI time, 2026-11-05). Telegram's one-message-a-second to a
// chat is held by the shared database bucket (channel_pacer.ts, channel_rate_acquire); a flow that sends a thousand messages
// to a few chats back to back slept ~1 s of wall time for nearly every one (flow-scenarios-telegram-r2 went from 94 s to
// 971 s in CI when the bucket landed). With this clock the pacer computes the same waits and takes them, but a wait moves the
// clock forward instead of the wall: `now` is the wall clock plus every wait taken so far, so it only ever moves forward and
// never falls behind the database's own clock. `waits` keeps each wait, so a test can read back that its sends were paced.
//   const vc = virtualClock(); deliverer(admin, Deno.env, vc)
export function virtualClock() {
  let ahead = 0;
  const waits: number[] = [];
  return {
    clock: () => Date.now() + ahead,
    sleep: async (ms: number) => {
      const d = Math.max(0, Math.ceil(Number(ms) || 0));
      waits.push(d);
      ahead += d;
      await Promise.resolve();
    },
    waits,
    get ahead() { return ahead; },
  };
}
