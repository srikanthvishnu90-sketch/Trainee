// A date-only posting date (Workable's published_on, a bare "YYYY-MM-DD", stored as midnight UTC) is a calendar day, not a
// moment. Its age is counted in calendar days against the person's own today (their zone, else Chicago's): "today",
// "yesterday", "2 d ago", never an hours or minutes age measured from midnight UTC ("Posted 15 h ago"). And a day that is
// still tomorrow where the person is (the source's zone is ahead of theirs) is never shown: it reads "Posted today".
import assertNode from "node:assert/strict";
import { postedLine } from "../../supabase/functions/_shared/file_page.ts";

const NY = "America/New_York", TOKYO = "Asia/Tokyo";
const at = (iso: string) => Date.parse(iso);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const HOURS = /\b(?:h|min) ago\b/;

Deno.test("a date-only posting gets a calendar-day age, never an hours age", () => {
  const now = at("2026-10-31T15:00:00Z"); // 11:00 on Oct 31 in New York
  for (const d of ["2026-10-31", "2026-10-31T00:00:00Z", "2026-10-31T00:00:00.000Z", "2026-10-31T00:00:00+00:00"]) eq(postedLine({ posted_at: d }, now, NY), "Posted today (Oct 31)", d);
  eq(postedLine({ posted_at: "2026-10-30" }, now, NY), "Posted yesterday (Oct 30)");
  eq(postedLine({ posted_at: "2026-10-29" }, now, NY), "Posted 2 d ago (Oct 29)");
  eq(postedLine({ posted_at: "2026-09-20" }, now, NY), "Posted 41 d ago (Sep 20) · over 30 days old, it may be filled");
  eq(postedLine({ posted_at: "2026-10-01" }, now, NY), "Posted 30 d ago (Oct 1)", "30 calendar days is not yet over 30");
  for (let h = 0; h < 48; h++) {
    const n = at("2026-10-31T00:00:00Z") + h * 3_600_000;
    for (const tz of [NY, TOKYO, "UTC", null]) {
      const line = postedLine({ posted_at: "2026-10-31" }, n, tz) ?? "";
      assertNode.ok(!HOURS.test(line), `${new Date(n).toISOString()} ${tz}: ${line}`);
    }
  }
});

Deno.test("the age is counted against the person's own today", () => {
  // 23:00 on Oct 31 in New York (already Nov 1 in UTC): Oct 31 is still today there, not yesterday.
  const lateNY = at("2026-11-01T03:00:00Z");
  eq(postedLine({ posted_at: "2026-10-31" }, lateNY, NY), "Posted today (Oct 31)");
  eq(postedLine({ posted_at: "2026-10-30" }, lateNY, NY), "Posted yesterday (Oct 30)");
  // 08:30 on Nov 1 in Tokyo (still Oct 31 in UTC): Oct 31 is yesterday there.
  const tokyo = at("2026-10-31T23:30:00Z");
  eq(postedLine({ posted_at: "2026-10-31" }, tokyo, TOKYO), "Posted yesterday (Oct 31)");
  eq(postedLine({ posted_at: "2026-11-01" }, tokyo, TOKYO), "Posted today (Nov 1)");
});

Deno.test("a date that is still tomorrow where the person is reads 'today', never that date", () => {
  const lateNY = at("2026-11-01T03:00:00Z"); // Oct 31, 23:00 in New York
  const line = postedLine({ posted_at: "2026-11-01" }, lateNY, NY) ?? "";
  eq(line, "Posted today");
  assertNode.ok(!/Nov 1/.test(line), line);
  // no zone known: Chicago's today (Oct 31, 23:30 there)
  eq(postedLine({ posted_at: "2026-11-01" }, at("2026-11-01T04:30:00Z"), null), "Posted today");
  eq(postedLine({ posted_at: "2026-10-31" }, at("2026-11-01T04:30:00Z"), null), "Posted today (Oct 31)");
});

Deno.test("review of #369: 'today' only when some zone on Earth has reached that date; otherwise the date as given", () => {
  // Tokyo 08:30 on Nov 1: the furthest-ahead zone (UTC+14) is at 13:30 on Nov 1, so Nov 2 is nowhere yet.
  const tokyo = at("2026-10-31T23:30:00Z");
  eq(postedLine({ posted_at: "2026-11-02" }, tokyo, TOKYO), "Posted on Nov 2");
  // New York 05:00 on Oct 31 (09:00 UTC; UTC+14 is at 23:00 on Oct 31): Nov 1 is nowhere yet.
  const earlyNY = at("2026-10-31T09:00:00Z");
  eq(postedLine({ posted_at: "2026-11-01" }, earlyNY, NY), "Posted on Nov 1");
  // New York 23:00 on Oct 31 (UTC+14 is at 17:00 on Nov 1): Nov 1 has begun somewhere, so it is "today" here.
  eq(postedLine({ posted_at: "2026-11-01" }, at("2026-11-01T03:00:00Z"), NY), "Posted today");
  // two days ahead of the person: the date as given, never "today"
  eq(postedLine({ posted_at: "2026-11-02" }, at("2026-10-31T15:00:00Z"), NY), "Posted on Nov 2");
  eq(postedLine({ posted_at: "2027-03-01" }, at("2026-10-31T15:00:00Z"), NY), "Posted on Mar 1", "far future: its date, never today");
  // ...but a zone 26 h ahead of the person's (Baker Island, UTC-12, at 23:00) has reached two days on: today.
  eq(postedLine({ posted_at: "2026-11-01" }, at("2026-10-31T11:00:00Z"), "Etc/GMT+12"), "Posted today");
});

Deno.test("review of #369: a date-only flag from ingest wins over the midnight-UTC heuristic", () => {
  const now = at("2026-10-31T15:00:00Z");
  // a real event at exactly midnight UTC, marked not date-only by its source: a moment's age
  eq(postedLine({ posted_at: "2026-10-31T00:00:00Z", posted_date_only: false }, now, NY), "Posted 15 h ago (Oct 30)");
  // a date-only source whose stored stamp is not midnight UTC: still its calendar day
  eq(postedLine({ posted_at: "2026-10-30T05:00:00Z", posted_date_only: true }, now, NY), "Posted yesterday (Oct 30)");
  // no flag: the heuristic (exactly 00:00:00Z or a bare date is date-only)
  eq(postedLine({ posted_at: "2026-10-31T00:00:00Z" }, now, NY), "Posted today (Oct 31)");
});

Deno.test("a timed posting keeps its moment's age (unchanged)", () => {
  const now = at("2026-10-31T12:00:00Z");
  eq(postedLine({ posted_at: "2026-10-31T09:30:00Z" }, now, NY), "Posted 2 h ago (Oct 31)");
  eq(postedLine({ posted_at: "2026-10-28T09:00:00Z" }, now, NY), "Posted 3 d ago (Oct 28)");
});
