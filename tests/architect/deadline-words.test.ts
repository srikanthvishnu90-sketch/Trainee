// Deadlines said exactly (reqs Q588, Q589, Q590): weekday, date, and for a moment the time and its zone, in the person's own zone;
// never the UTC calendar day of a moment. A date-only deadline is open until that day has ended everywhere, so a posting is never
// refused (or shown as passed) while its last day is still running. Through the real job card (captionOf) and the real Apply screen
// (postingVerdict, which the jobs page and the Telegram Confirm both run), and the jobs page's "Apply by" line (handleFile; architect
// decision 2026-11-01: the local date, never the UTC day). Memory stores, a fixed clock: no network, no database.
import assertNode from "node:assert/strict";
import { deadlineOf, deadlinePassed, deadlineWords } from "../../supabase/functions/_shared/date_words.ts";
import { captionOf, jobViewOf, postingVerdict, refOf, type JobView } from "../../supabase/functions/_shared/telegram_jobs.ts";
import { handleFile, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { signedIn } from "./file-session-fakes.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const NOW = Date.parse("2026-11-01T15:00:00Z"); // Sunday, Nov 1, 2026 (US clocks went back at 2 AM local that morning)
const ET = "America/New_York", CT = "America/Chicago", PT = "America/Los_Angeles", LON = "Europe/London", TOKYO = "Asia/Tokyo";

Deno.test("deadlineWords: weekday + date + time + zone, in the person's zone; a calendar day is that day in every zone", () => {
  const rows: [string, string | null, string | null][] = [
    // A moment: the person's own clock and zone name.
    ["2026-11-06T23:59:00-05:00", ET, "Friday, Nov 6, 11:59 PM EST"],
    ["2026-11-06T23:59:00-05:00", CT, "Friday, Nov 6, 10:59 PM CST"],
    ["2026-11-06T23:59:00-05:00", PT, "Friday, Nov 6, 8:59 PM PST"],
    ["2026-11-06T23:59:00-05:00", TOKYO, "Saturday, Nov 7, 1:59 PM GMT+9"],
    ["2026-11-06T23:59:00-05:00", LON, "Saturday, Nov 7, 4:59 AM GMT"],
    // The DST edges: the zone name follows the date, not today.
    ["2026-10-31T17:00:00Z", CT, "Saturday, Oct 31, 12:00 PM CDT"],
    ["2026-11-02T17:00:00Z", CT, "Monday, Nov 2, 11:00 AM CST"],
    ["2027-03-14T12:00:00Z", ET, "Sunday, Mar 14, 2027, 8:00 AM EDT"],
    // No zone known (or one the runtime does not know): Chicago's, and the words say so.
    ["2026-11-06T23:59:00-05:00", null, "Friday, Nov 6, 10:59 PM CST (Chicago time)"],
    ["2026-11-06T23:59:00-05:00", "Mars/Olympus", "Friday, Nov 6, 10:59 PM CST (Chicago time)"],
    // A calendar day: the same day in every zone, no time, no zone (nothing to convert).
    ["2026-11-06", TOKYO, "Friday, Nov 6"],
    ["2026-11-06", PT, "Friday, Nov 6"],
    ["2026-11-06T00:00:00Z", PT, "Friday, Nov 6"],
    ["2026-11-06T00:00:00.000+00:00", null, "Friday, Nov 6"],
    ["2027-01-08", CT, "Friday, Jan 8, 2027"],
    // Not a date: nothing (never a guess).
    ["", CT, null], ["next Friday", CT, null], ["2026-02-31", CT, null], ["2026-11-06T23:59:00", CT, null],
  ];
  for (const [raw, tz, want] of rows) eq(deadlineWords(raw, NOW, tz), want, `${raw} in ${tz}`);
  for (const [raw] of rows) { const w = deadlineWords(raw, NOW, CT) ?? ""; ok(!/\b(soon|today|tomorrow|tonight|yesterday)\b/i.test(w), `no relative word: ${w}`); }
});

Deno.test("deadlinePassed: a moment passes at that moment; a calendar day only once it has ended everywhere", () => {
  const m = "2026-11-06T23:59:00-05:00";
  eq(deadlinePassed(m, Date.parse("2026-11-07T04:58:59Z")), false);
  eq(deadlinePassed(m, Date.parse("2026-11-07T04:59:00Z")), false, "exactly at the deadline it is still open");
  eq(deadlinePassed(m, Date.parse("2026-11-07T04:59:00.001Z")), true);
  // "2026-11-06": still open on the evening of Nov 6 in Chicago (already Nov 7 in UTC) and in Honolulu late that night.
  eq(deadlinePassed("2026-11-06", Date.parse("2026-11-07T02:00:00Z")), false, "8 PM Chicago on the deadline day");
  eq(deadlinePassed("2026-11-06", Date.parse("2026-11-07T09:30:00Z")), false, "11:30 PM Honolulu on the deadline day");
  eq(deadlinePassed("2026-11-06", Date.parse("2026-11-07T12:00:00.001Z")), true, "the day has ended everywhere");
  eq(deadlinePassed("2026-11-06T00:00:00Z", Date.parse("2026-11-06T18:00:00Z")), false, "midnight UTC is a date-only source's calendar day");
  eq(deadlinePassed("not a date", NOW), false);
  eq(deadlineOf("2026-11-06")?.dateOnly, true);
});

const job = (deadline: string | null): JobView => ({ job_id: "greenhouse:acme:1", company: "Acme", title: "Data Analyst", location: "Austin, TX", url: "https://boards.greenhouse.io/acme/jobs/1",
  pay: "$90k", level: null, remote: null, posted_at: "2026-10-30T12:00:00Z", first_seen_at: null, deadline, source: "Greenhouse", reasons: [], gaps: [], company_domain: null });

Deno.test("the Telegram job card: 'Apply by' names the weekday, and a moment keeps its own day (never the UTC day)", () => {
  // 11:59 PM Eastern on Friday Nov 6 is 04:59 UTC on Nov 7: the card said "Apply by: Nov 7", a day late.
  const cap = captionOf(job("2026-11-06T23:59:00-05:00"), NOW);
  ok(/^Apply by: Friday, Nov 6, 10:59 PM CST \(Chicago time\)$/m.test(cap), cap);
  ok(!/Nov 7/.test(cap), cap);
  const day = captionOf(job("2026-11-06"), NOW);
  ok(/^Apply by: Friday, Nov 6$/m.test(day), day);
  ok(!/Apply by/.test(captionOf(job("rolling"), NOW)), "a deadline that is not a date is not shown as one");
});

Deno.test("the Apply screen: a date-only deadline is open all of its last day; once passed, the reason names the day exactly", () => {
  const row = { job_id: "greenhouse:acme:1", description: "<p>Build dashboards for the growth team.</p>" };
  const lastEvening = Date.parse("2026-11-07T02:00:00Z"); // 8 PM Friday Nov 6 in Chicago
  const v1 = postingVerdict(job("2026-11-06"), { ...row, deadline: "2026-11-06" }, [], false, lastEvening);
  ok(!/deadline/i.test(v1 ?? ""), `not refused on its last day: ${v1}`);
  const v2 = postingVerdict(job("2026-11-06"), { ...row, deadline: "2026-11-06" }, [], false, Date.parse("2026-11-08T15:00:00Z"));
  eq(v2, "its deadline to apply (Friday, Nov 6) has passed");
  const v3 = postingVerdict(job(null), { ...row, deadline: "2026-11-06T23:59:00-05:00" }, [], false, Date.parse("2026-11-07T05:00:00Z"));
  eq(v3, "its deadline to apply (Friday, Nov 6, 10:59 PM CST (Chicago time)) has passed");
});

async function pageLine(deadline: string, tz: string | null): Promise<string> {
  const A = signedIn();
  const U = "11111111-1111-4111-8111-111111111111", LIST = "0123456789";
  const hit = { job_id: "greenhouse:acme:1", company: "Acme", title: "Data Analyst", location: "Austin, TX", url: "https://boards.greenhouse.io/acme/jobs/1", pay: "$90k", deadline };
  const row = { job_id: hit.job_id, provider: "greenhouse", description: "<p>Build dashboards.</p>", posted_at: "2026-10-30T12:00:00Z", deadline };
  const kv = new Map<string, any>();
  const store = {
    async remember(u: string, r: string, j: any, s: string) { kv.set(`${u}|job|${r}`, { job: j, shownAs: s }); }, async recall(u: string, r: string) { return kv.get(`${u}|job|${r}`) ?? null; },
    async rememberList(u: string, id: string, refs: string[]) { kv.set(`${u}|list|${id}`, refs); }, async recallList(u: string, id: string) { return kv.get(`${u}|list|${id}`) ?? null; },
    async postings() { return [row]; }, async save() { return "saved"; }, async prepared() { return null; }, async applied() { return false; },
    async want() { return { result: "queued" }; }, async appRow() { return null; }, async wanted() { return false; },
  } as unknown as FileStore;
  const v = jobViewOf(hit, row as any), ref = await refOf(U, v.job_id);
  await store.remember(U, ref, v, "text"); await store.rememberList(U, LIST, [ref]);
  const env = { get: (k: string) => ({ TRAINEE_FILE_LINK_SECRET: "file-link-secret-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" } as Record<string, string>)[k] };
  const t = await A.tok(U, LIST, NOW);
  const res = await handleFile(new Request("https://trainee.example/file", { headers: { cookie: `tf_s=${t}` } }), { store, now: () => NOW, env, ...A.deps, timeZone: async () => tz });
  eq(res.status, 200);
  return (await res.text()).replace(/<script[\s\S]*?<\/script>/g, "").match(/Apply by [^<·]*/)?.[0]?.trim() ?? "";
}

Deno.test("the jobs page: a deadline at 03:00Z on Nov 5 is Nov 4 in Chicago (architect decision: local date, never the UTC day)", async () => {
  eq(await pageLine("2026-11-05T03:00:00Z", "America/Chicago"), "Apply by Wednesday, Nov 4, 9:00 PM CST");
  eq(await pageLine("2026-11-05T03:00:00Z", null), "Apply by Wednesday, Nov 4, 9:00 PM CST (Chicago time)");
  eq(await pageLine("2026-11-05T03:00:00Z", "Asia/Tokyo"), "Apply by Thursday, Nov 5, 12:00 PM GMT+9");
  eq(await pageLine("2026-11-06", "America/Los_Angeles"), "Apply by Friday, Nov 6", "a calendar day is that day everywhere");
});
