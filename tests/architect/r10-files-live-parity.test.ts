// R10 WO-E: switching the live roles page to F-05 loses no control. Both renderers draw the SAME feed; every control today's page
// has (each POST form and its exact hidden fields, the GET filter and its options, each Select pick and the form it feeds, each link
// the page itself serves) must exist on F-05 - and F-05 adds no action the handler does not have. "Apply to all" stays hash-bound.
import assert from "node:assert/strict";
import { DOMParser } from "jsr:@b-fuze/deno-dom@0.1.48";
import { renderResults } from "../../supabase/functions/_shared/results_page.ts";
import { liveShortlistPage } from "../../supabase/functions/_shared/file_family_live.ts";
import { CTX } from "./r10-files-fixtures.ts";
import { feed, HASH } from "./r10-files-fixtures-live.ts";

// deno-lint-ignore no-explicit-any
const doc = (html: string): any => new DOMParser().parseFromString(html, "text/html");
// deno-lint-ignore no-explicit-any
const each = (d: any, sel: string): any[] => [...d.querySelectorAll(sel)];
function controls(html: string) {
  const d = doc(html);
  const posts = new Set(each(d, 'form[method="post"]').map((f) => each(f, 'input[type="hidden"]').map((i) => `${i.getAttribute("name")}=${i.getAttribute("value")}`).sort().join("&")));
  const gets = new Set(each(d, 'form[method="get"]').map((f) => [...each(f, 'input[type="hidden"]').map((i) => `${i.getAttribute("name")}=${i.getAttribute("value")}`),
    ...each(f, "select").map((s) => `${s.getAttribute("name")}:${each(s, "option").map((o) => o.getAttribute("value")).join("|")}`)].sort().join("&")));
  const picks = new Set(each(d, 'input[name="pick"]').map((i) => {
    const form = d.getElementById(i.getAttribute("form"));
    return `${i.getAttribute("value")}->${form ? each(form, 'input[name="action"]')[0]?.getAttribute("value") : "NO FORM"}`;
  }));
  const links = new Set(each(d, "a[href]").map((a) => a.getAttribute("href")).filter((h: string) => h !== "#main"));
  return { posts, gets, picks, links };
}
const missing = (want: Set<string>, have: Set<string>) => [...want].filter((x) => !have.has(x));

for (const [name, f] of [["open", feed()], ["paused", feed({ paused: true })], ["filtered", feed({ filters: { pay: "meets", where: "Austin, TX", state: "ready" }, all: { hash: HASH, size: 2, filtered: true } })]] as const) {
  Deno.test(`r10-live-parity (${name}): every control on today's roles page exists on F-05`, () => {
    const today = controls(renderResults(f)), ff = controls(liveShortlistPage(f, CTX));
    assert.ok(today.posts.size >= 3, "the fixture exercises today's forms");
    assert.deepEqual(missing(today.posts, ff.posts), [], "POST forms (action + exact hidden fields)");
    assert.deepEqual(missing(today.gets, ff.gets), [], "GET filter (hidden state + every select option)");
    assert.deepEqual(missing(today.picks, ff.picks), [], "Select picks feed the applysel form");
    assert.deepEqual(missing(today.links, ff.links), [], "links");
    // F-05 adds no action the handler lacks, and every pick it draws is one today's page also offers.
    const acts = new Set([...ff.posts].map((p) => /action=([a-z]+)/.exec(p)?.[1]));
    for (const a of acts) assert.ok(["apply", "applysel", "applyall", "dismiss", "restore", "pause", "resume"].includes(a!), String(a));
    assert.deepEqual(missing(ff.picks, today.picks), [], "no pick beyond today's");
  });
}

Deno.test("r10-live-parity: Apply to all stays hash-bound and reads as an approval, never a preview", () => {
  const html = liveShortlistPage(feed(), CTX);
  assert.match(html, /<input type="hidden" name="action" value="applyall"><input type="hidden" name="set" value="9f86d081[0-9a-f]+"><button type="submit" class="ff-btn ff-pri"[^>]*data-effect="approve">Apply to all 2 ready<\/button>/);
  assert.match(html, /each exactly as its What will be sent shows[\s\S]*If anything changes first, nothing is approved/);
  assert.doesNotMatch(liveShortlistPage(feed({ paused: true }), CTX), /value="applyall"/, "paused: no approval");
  assert.doesNotMatch(liveShortlistPage(feed({ all: null }), CTX), /value="applyall"/, "no set: no approval");
});

Deno.test("r10-live-parity: a prepared role's Submit is a filled submit bound to its tag; Prepare stays a prepare", () => {
  const html = liveShortlistPage(feed(), CTX);
  assert.match(html, /name="ref" value="ref3"><input type="hidden" name="tag" value="0123456789abcdef"><button type="submit" class="ff-btn ff-pri"[^>]*data-effect="submit">Submit application/);
  assert.match(html, /name="ref" value="ref1"><input type="hidden" name="tag" value="none"><button type="submit" class="ff-btn ff-pri"[^>]*data-effect="prepare">Prepare application/);
  assert.match(html, /Apply to selected roles/); // the bar approves when a prepared role can be ticked
  assert.match(html, /<a href="\?things=ref4">Answer them now<\/a>/);
  assert.match(html, /Show dismissed \(1\)[\s\S]*value="restore"><input type="hidden" name="ref" value="ref8">/);
});
