// The clock rules the product's SQL keeps, stated once in TypeScript (2026-10-31, clock sweep). Postgres keeps microseconds
// and stamps a transaction's rows with its start (now()); a worker's clock (Date.now()) keeps milliseconds and can be off the
// database's by seconds. Each rule below is the one a migration implements; tests/architect/clock-sweep-property.test.ts
// checks them under random offsets and skew, and tests/architect/clock-sweep-pg.test.ts checks that Postgres evaluates the
// same SQL expressions to the same answers. Pure: no clock, no I/O.

const US_PER_MS = 1000n;

// A timestamptz as Postgres prints it (or as JS's toISOString does) to exact microseconds since the epoch. Date.parse would
// drop the last three digits, which is the bug class itself.
export function pgMicros(t: string): bigint {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(t.trim());
  if (!m) throw new Error(`not a timestamp: ${t}`);
  const zone = m[4] === "Z" ? "Z" : m[4].length === 3 ? `${m[4]}:00` : m[4].includes(":") ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`;
  const whole = Date.parse(`${m[1]}T${m[2]}${zone}`);
  if (!Number.isFinite(whole)) throw new Error(`not a timestamp: ${t}`);
  return BigInt(whole) * US_PER_MS + BigInt((m[3] ?? "").padEnd(6, "0") || "0");
}
export const msToMicros = (ms: number): bigint => BigInt(ms) * US_PER_MS;
export function microsToIso(us: bigint): string {
  const ms = us / US_PER_MS, rest = us % US_PER_MS;
  const fixed = rest < 0n ? [ms - 1n, rest + US_PER_MS] : [ms, rest];
  return new Date(Number(fixed[0])).toISOString().replace("Z", `${String(fixed[1]).padStart(3, "0")}Z`);
}

// 20261030040000 (the outreach send claim): a row the database stamped at `dbUs` is due for a worker whose clock reads
// `workerMs` when it is at or before the END of that millisecond: due := date_trunc('milliseconds', p.now) + 999 µs.
export const dueForWorker = (dbUs: bigint, workerMs: number): boolean => dbUs <= msToMicros(workerMs) + 999n;

// 20261030140000 (the apply not-before): compared at the worker's millisecond: date_trunc('milliseconds', not_before) <= p_now.
export const notBeforeReached = (notBeforeUs: bigint, workerMs: number): boolean => (notBeforeUs / US_PER_MS) * US_PER_MS <= msToMicros(workerMs);

// 20261031010000 (this sweep): a card is shown at least(p_now, now()): never after the start of the transaction that shows it.
export const cardShownAt = (pNowUs: bigint, txStartUs: bigint): bigint => pNowUs < txStartUs ? pNowUs : txStartUs;
// career_apply_cloud_text_card_of: an application is the card's when it was created between the showing and the answer.
export const boundToCard = (createdUs: bigint, shownUs: bigint, answeredUs: bigint): boolean => shownUs <= createdUs && createdUs <= answeredUs;

// The newest of several rows: by the database's time, ties by the database's sequence (never by a random uuid or a clock).
export interface Stamped { atUs: bigint; seq: number }
export const newestFirst = (a: Stamped, b: Stamped): number => a.atUs === b.atUs ? b.seq - a.seq : a.atUs < b.atUs ? 1 : -1;
