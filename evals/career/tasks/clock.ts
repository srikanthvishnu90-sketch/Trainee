// The task eval's clock. The product reads the time (Date.now / new Date) to resolve "Friday", "next week", "in 5 days",
// and the judge reads it to say which day each of those must come out as; both used the machine's clock, so the eval's
// verdict moved with the day it ran (T07 and T44 passed on Monday 2026-11-02 UTC and failed from 2026-11-03: "next week"
// is the coming Monday, which is today + 7 days only on a Monday). The harness pins one instant instead: Date reads
// EVAL_NOW plus the real time elapsed since the pin (so durations and ordering still work), whatever day the machine
// says it is. EVAL_NOW is a Wednesday at 15:00 UTC (10:00 Eastern, 09:00 Central): the same calendar day in UTC, Eastern
// and Central, far from every quiet-hours and midnight edge, so no zone choice can move a day.
// EVAL_NOW=<ISO instant> in the environment overrides it (to show the eval does not depend on it); nothing else reads it.

export const EVAL_NOW = "2026-11-04T15:00:00Z";

export function evalNow(): string {
  const v = Deno.env.get("EVAL_NOW") || EVAL_NOW;
  if (Number.isNaN(Date.parse(v))) throw new Error(`EVAL_NOW is not an instant: ${v}`);
  return new Date(v).toISOString();
}

/** Pins Date to `iso` (ticking from there). Returns the restore function. */
export function pinClock(iso: string): () => void {
  const RealDate = Date, base = RealDate.parse(iso), t0 = RealDate.now();
  const now = () => base + (RealDate.now() - t0);
  // deno-lint-ignore no-explicit-any
  class PinnedDate extends (RealDate as any) {
    // deno-lint-ignore no-explicit-any
    constructor(...a: any[]) { if (a.length === 0) super(now()); else super(...a); }
    static now() { return now(); }
  }
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Date = PinnedDate;
  return () => { (globalThis as unknown as { Date: DateConstructor }).Date = RealDate; };
}

/** The database's own clock follows the pin: every column default that reads the time (now(), CURRENT_TIMESTAMP, timezone(.., now()))
 *  reads the pinned instant plus the real time elapsed since, so a row the product stamps (a draft's created_at) is aged against
 *  the same clock the product reads in JS. Without this, a pin days away from the machine's day makes a draft "more than 3
 *  days old" and the eval fails on the day it is run, which is the bug this module exists to remove. The throwaway database only. */
export const PIN_DB_SQL = (iso: string) => `do $pin$
declare r record; real_now timestamptz := clock_timestamp(); pinned text;
begin
  pinned := format('(%L::timestamptz + (clock_timestamp() - %L::timestamptz))', '${iso}', real_now);
  for r in select d.adrelid::regclass as t, a.attname as col, pg_get_expr(d.adbin, d.adrelid) as e
    from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    join pg_class c on c.oid = d.adrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and a.attgenerated = '' and pg_get_expr(d.adbin, d.adrelid) ~* '\\m(now\\(\\)|current_timestamp|transaction_timestamp\\(\\)|statement_timestamp\\(\\))'
  loop
    execute format('alter table %s alter column %I set default %s', r.t, r.col,
      regexp_replace(regexp_replace(r.e, 'now\\(\\)', pinned, 'gi'), '\\mcurrent_timestamp\\M', pinned, 'gi'));
  end loop;
end $pin$;`;
