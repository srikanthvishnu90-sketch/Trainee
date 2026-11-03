// The task-completion eval must not depend on the day it runs (it failed T07 and T44 from 2026-11-03 UTC: "next week" is the
// coming Monday, not today + 7, and the judge assumed +7, which only agrees on a Monday). Two guards, both free and clock-free:
//   1. the judge's expected day for every reminder the tasks ask for equals the day the reminder module really sets, for
//      every weekday and hour of day over two years (month ends, both DST changes, the year boundary);
//   2. the eval's pinned clock (evals/career/tasks/clock.ts) is a fixed day that ticks, and restores the real Date.
//   deno test -A --no-check tests/architect/task-eval-clock.test.ts
import assertNode from "node:assert/strict";
import { expectedDue } from "../../evals/career/tasks/judge.ts";
import { evalNow, PIN_DB_SQL, pinClock } from "../../evals/career/tasks/clock.ts";
import { whenOf } from "../../supabase/functions/_shared/career_reminders.ts";

const SET = JSON.parse(await Deno.readTextFile(new URL("../../evals/career/tasks/tasks.json", import.meta.url)));
const WHENS: string[] = [...new Set<string>(SET.tasks.flatMap((t: any) => (t.expect.reminders ?? []).map((r: any) => r.when)))];
const ymd = (at: number, zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));

Deno.test("the judge's expected reminder day equals the day the reminder module sets, across two years (every weekday, hour of day, month end, both DST changes, the year boundary)", () => {
  assertNode.ok(WHENS.includes("next week") && WHENS.length >= 5, `the tasks ask for reminders by ${WHENS.join(", ")}`);
  const start = Date.UTC(2026, 10, 1), bad: string[] = [];
  for (let h = 0; h < 24 * 730; h += 5) {
    const now = start + h * 3_600_000;
    for (const when of WHENS) {
      const w = whenOf(when, now, null); // the fixture person has no saved zone: the module assumes Eastern
      if ("error" in w) { bad.push(`${new Date(now).toISOString()} ${when}: ${w.error}`); continue; }
      // A weekday said on that weekday after its time has passed is the next one: the planner (career_planner.ts) rewrites it to that date.
      const weekday = /^[a-z]+day$/i.test(when) && w.at <= now + 30_000;
      const set = weekday ? ymd(w.at + 7 * 86_400_000 + (/* DST: keep the local clock */ 0), w.zone) : ymd(w.at, w.zone), want = expectedDue(when, now);
      if (set !== want) bad.push(`${new Date(now).toISOString()} "${when}": set ${set}, judge expects ${want}`);
    }
    if (bad.length > 5) break;
  }
  assertNode.deepStrictEqual(bad, []);
});

Deno.test("next week is the coming Monday, not today + 7 (the day T07 and T44 first failed)", () => {
  const at = (iso: string) => Date.parse(iso);
  assertNode.equal(expectedDue("next week", at("2026-11-02T20:00:00Z"), ), "2026-11-09"); // a Monday
  assertNode.equal(expectedDue("next week", at("2026-11-03T01:00:00Z")), "2026-11-09"); // Monday evening Eastern, Tuesday UTC
  assertNode.equal(expectedDue("next week", at("2026-11-03T15:00:00Z")), "2026-11-09"); // Tuesday
  assertNode.equal(expectedDue("next week", at("2026-11-08T15:00:00Z")), "2026-11-09"); // Sunday
});

Deno.test("the eval clock is one fixed instant that ticks, and puts the real Date back", async () => {
  const RealDate = Date, before = RealDate.now();
  const restore = pinClock("2026-11-04T15:00:00Z");
  try {
    const a = Date.now();
    assertNode.ok(Math.abs(a - Date.parse("2026-11-04T15:00:00Z")) < 5_000, "Date.now is the pinned instant");
    assertNode.equal(new Date().toISOString().slice(0, 10), "2026-11-04");
    assertNode.equal(new Date("2030-01-02T03:04:05Z").toISOString(), "2030-01-02T03:04:05.000Z", "dates given explicitly are untouched");
    await new Promise((r) => setTimeout(r, 30));
    assertNode.ok(Date.now() > a, "it ticks");
  } finally { restore(); }
  assertNode.ok(Date === RealDate && Math.abs(Date.now() - before) < 60_000, "the real Date is back");
  assertNode.equal(evalNow(), Deno.env.get("EVAL_NOW") ? new Date(Deno.env.get("EVAL_NOW")!).toISOString() : "2026-11-04T15:00:00.000Z");
  assertNode.ok(PIN_DB_SQL("2026-11-04T15:00:00.000Z").includes("2026-11-04T15:00:00.000Z"));
});
