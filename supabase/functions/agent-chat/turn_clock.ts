// C01 (beta 2026-11-04): a live turn asking for three job links was killed by the Edge runtime with HTTP 546 "CPU Time
// exceeded" (2,142 ms CPU; the limit is about 2 s), and nothing said which part of the turn spent it. This is the turn's
// stage clock: each synchronous stage (the code that spends the isolate's CPU; no I/O happens inside one) is timed by
// name, and the turn logs ONE line at its end with the time per stage. Once a turn's synchronous total passes
// PROGRESS_FROM_MS, every stage is also logged as it STARTS, so a turn the runtime kills mid-stage still names the stage it
// died in (the last "start" line with no summary after it).
//
// What is logged: stage names (fixed strings in code), milliseconds, call counts, and the turn's intent / handler. Never
// the message, a reply, a posting, a name or an id of the person.

export const EDGE_CPU_LIMIT_MS = 2000; // Supabase Edge's per-request CPU limit (the 546 C01 hit)
export const PROGRESS_FROM_MS = 1000;   // past half the limit, each stage is logged as it starts

export type StageTimes = Record<string, { ms: number; n: number }>;
export interface TurnClock {
  // A synchronous stage: its wall time is CPU time (nothing inside it awaits).
  sync<T>(stage: string, fn: () => T): T;
  // An asynchronous stage: its wall time (includes I/O wait), kept apart from the CPU total.
  wait<T>(stage: string, fn: () => Promise<T>): Promise<T>;
  readonly syncMs: number;
  stages(): StageTimes;
  waits(): StageTimes;
  // The turn's one line. `meta` holds only code-made labels (intent, handler, status).
  flush(meta?: Record<string, string | number | boolean | null | undefined>): void;
}

const round = (n: number) => Math.round(n * 10) / 10;

export function turnClock(o: { log?: (line: string) => void; now?: () => number; progressFromMs?: number } = {}): TurnClock {
  const log = o.log ?? ((l: string) => console.log(l));
  // performance.now() where the runtime has it (Deno, Edge); Date.now() in a realm without it (the bundle tests' VM realm),
  // so the clock can never be what breaks a turn.
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  const now = o.now ?? (typeof perf?.now === "function" ? () => perf.now!() : () => Date.now());
  const from = o.progressFromMs ?? PROGRESS_FROM_MS;
  const t0 = now();
  const syncT: StageTimes = {}, waitT: StageTimes = {};
  let total = 0, depth = 0, flushed = false;
  const add = (b: StageTimes, k: string, ms: number) => { const e = b[k] ??= { ms: 0, n: 0 }; e.ms += ms; e.n++; };
  return {
    sync<T>(stage: string, fn: () => T): T {
      // A stage inside a stage counts once, in the outer one (the outer total is what the isolate spent).
      if (depth > 0) return fn();
      if (total >= from) { try { log(JSON.stringify({ evt: "agent_chat_stage_start", stage, sync_ms: round(total) })); } catch { /* never breaks a turn */ } }
      const s = now();
      depth++;
      try { return fn(); }
      finally { depth--; const ms = now() - s; total += ms; add(syncT, stage, ms); }
    },
    async wait<T>(stage: string, fn: () => Promise<T>): Promise<T> {
      const s = now();
      try { return await fn(); }
      finally { add(waitT, stage, now() - s); }
    },
    get syncMs() { return total; },
    stages: () => JSON.parse(JSON.stringify(syncT)),
    waits: () => JSON.parse(JSON.stringify(waitT)),
    flush(meta = {}) {
      if (flushed) return;
      flushed = true;
      const r = (b: StageTimes) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.n > 1 ? { ms: round(v.ms), n: v.n } : round(v.ms)]));
      try {
        log(JSON.stringify({ evt: "agent_chat_cpu", sync_ms: round(total), budget_ms: EDGE_CPU_LIMIT_MS, wall_ms: round(now() - t0), stages: r(syncT), waits: r(waitT), ...meta }));
      } catch { /* never breaks a turn */ }
    },
  };
}

// A clock that times nothing: the default where a caller passes none.
export const NO_CLOCK: TurnClock = {
  sync: (_s, fn) => fn(),
  wait: (_s, fn) => fn(),
  get syncMs() { return 0; },
  stages: () => ({}),
  waits: () => ({}),
  flush: () => {},
};
