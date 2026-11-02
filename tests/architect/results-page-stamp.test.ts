// Owner parity audit R06 (2026-11-01): every page results_page.ts renders (the list and the review) carries exactly one checked-at
// line under its title, from the shown postings' own last_seen_at (#385's freshnessStamp + stampHtml interface), in the person's
// zone; with no time known it says "Check time unknown", never an invented time.
//
// Note on the expected time: 2026-11-01 is the day US daylight time ends (2:00 AM CDT -> 1:00 AM CST), so 15:08Z and 15:25Z are
// 9:08 and 9:25 AM Central Standard Time, written "CT".
import assertNode from "node:assert/strict";
import { handleFile } from "../../supabase/functions/trainee-file/handler.ts";
import { made, NOW, POSTINGS, post, U, world, type Posting, type W } from "../helpers/results_world.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const KNOWN = /class="stamp" data-stamp="known">Postings checked Nov 1, 2026, 9:08–9:25 AM CT</g;
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
const stamps = (html: string) => count(html, /class="stamp"/g);
const get = async (w: W, s: string) => await (await handleFile(new Request("https://x.example/f", { headers: { cookie: `tf_s=${s}` } }), w.deps)).text();
// The other page this list draws: "A few things first" (one role's questions), which carries its own stamp.
const things = async (w: W, s: string, ref: string) => await (await post(w, s, { action: "apply", ref, tag: "none" })).text();
const two = (seen: [string | null, string | null]): Posting[] => POSTINGS.slice(0, 2).map((p, i) => ({ ...p, last_seen_at: seen[i] }));
async function open(seen: [string | null, string | null]) {
  const w = world({ postings: two(seen) });
  w.deps.timeZone = async () => "America/Chicago";
  const r = await made(w, U, undefined, { name: "Ada", source: "live" });
  const s = await w.A.tok(U, r.listId, NOW);
  w.clock.t = Date.parse("2026-11-01T16:00:00Z"); // after both checks
  return { w, s };
}

Deno.test("stamp: two postings last seen 15:08Z and 15:25Z, Chicago -> one 'Postings checked Nov 1, 2026, 9:08–9:25 AM CT' under the title, on the list and on the questions page", async () => {
  const { w, s } = await open(["2026-11-01T15:08:00Z", "2026-11-01T15:25:00Z"]);
  const list = await get(w, s);
  eq(count(list, KNOWN), 1, "the stamp, exactly once");
  eq(stamps(list), 1, "no other checked-at line");
  assert(/<h1>[^<]*<\/h1><p class="stamp"/.test(list), "directly under the title");
  const ref = list.split('<li class="card" id="r-')[1].slice(0, 12);
  const unprepared = world({ postings: two(["2026-11-01T15:08:00Z", "2026-11-01T15:25:00Z"]), unprepared: [POSTINGS[0].job_id] });
  unprepared.deps.timeZone = async () => "America/Chicago";
  unprepared.qs.push({ id: "11111111-aaaa-4aaa-8aaa-0000000000aa", key: "job:x", kind: "text", label: "A question", type: "text", options: [], company: null, job_ids: [POSTINGS[0].job_id], misfit: false, answer: null });
  const r2 = await made(unprepared, U, undefined, { name: "Ada", source: "live" });
  const s2 = await unprepared.A.tok(U, r2.listId, NOW);
  unprepared.clock.t = Date.parse("2026-11-01T16:00:00Z");
  const rv = await things(unprepared, s2, (await get(unprepared, s2)).split('<li class="card" id="r-')[1].slice(0, 12));
  eq(stamps(rv), 1, "the questions page has its one stamp too");
  assert(/<\/h1><p class="stamp" data-stamp="known">Postings checked Nov 1, 2026, 9:08 AM CT</.test(rv), "its stamp is its own posting's check");
});

Deno.test("stamp: no check time known -> 'Check time unknown' as a value, never an invented time; a time ahead of our clock is not a check", async () => {
  const { w, s } = await open([null, null]);
  const list = await get(w, s);
  eq(stamps(list), 1);
  assert(/class="stamp" data-stamp="unknown"><span class="v v-unknown" data-v="unknown">Check time unknown<\/span>/.test(list), list.slice(0, 400));
  assert(!/Postings checked/.test(list), "no time invented");
  const future = await open(["2026-11-02T15:08:00Z", null]);
  assert(/data-stamp="unknown"/.test(await get(future.w, future.s)), "a future timestamp is not a check that happened");
});
