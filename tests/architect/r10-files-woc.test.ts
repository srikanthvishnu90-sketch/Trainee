// R10 WO-E: F-05 is the renderer the live shortlist File can use (shortlistOfFeed over the handler's ResultsFeed), and it accepts
// WO-C's fields as given: the prefixed student-window line (said once), the open-check line, and JobView.checked as the source time.
import assert from "node:assert/strict";
const assertEquals = assert.equal, assertStringIncludes = (h: string, n: string, m?: string) => assert.ok(h.includes(n), m ?? `missing: ${n}`);
import { rolesShortlistPage, shortlistOfFeed, type ShortRole } from "../../supabase/functions/_shared/file_family_roles.ts";
import { CTX, role, shortlist, TOKEN } from "./r10-files-fixtures.ts";

const page = (rows: ShortRole[]) => rolesShortlistPage({ ...shortlist(), rows }, CTX);

Deno.test("r10-woc: a WO-C student-window line is said once, unquoted; raw posting words are quoted", () => {
  const html = page([role(1, { window: 'Student window: "Graduating Dec 2027 to June 2028"' }), role(2, { window: "Student window: not stated in the posting" }), role(3, { window: "Enrolled undergraduate" })]);
  assertEquals((html.match(/Student window:/gi) ?? []).length, 3, "one label per role, never doubled");
  assertStringIncludes(html, "&quot;Graduating Dec 2027 to June 2028&quot;");
  assertStringIncludes(html, "not stated in the posting");
  assert(!html.includes("&quot;not stated in the posting&quot;"), "WO-C's own words are not quoted as the posting's");
  assertStringIncludes(html, "&quot;Enrolled undergraduate&quot;");
});

Deno.test("r10-woc: the open-check line renders as given", () => {
  const html = page([role(1, { openLine: "Open: application page checked Nov 8, 5:16 PM CST" }), role(2, { openLine: "Not re-checked when listed" })]);
  assertStringIncludes(html, 'class="ff-p ff-mute ff-open">Open: application page checked Nov 8, 5:16 PM CST</p>');
  assertStringIncludes(html, ">Not re-checked when listed</p>");
});

Deno.test("r10-woc: JobView.checked live is the time on sourced facts; unknown or unchecked never is", () => {
  const live = role(1, { checkedAt: null }); (live.job as Record<string, unknown>).checked = { state: "live", at: Date.parse("2026-11-08T23:16:00Z") };
  const unk = role(2, { checkedAt: null }); (unk.job as Record<string, unknown>).checked = { state: "unknown", at: Date.parse("2026-11-08T23:16:00Z") };
  const html = page([live, unk]);
  const cards = html.split('<article class="ff-card ff-role"').slice(1);
  assertStringIncludes(cards[0], "5:16 PM", "the live check time in the person's zone");
  assert(!cards[1].includes("5:16 PM"), "an unknown check gives no time");
  assertStringIncludes(cards[1], 'data-src="unconfirmed"');
});

Deno.test("r10-woc: shortlistOfFeed takes the live handler's feed: same rows and token, last_seen_at as check time", () => {
  const r = role(1, { checkedAt: undefined }); (r.job as Record<string, unknown>).last_seen_at = "2026-11-09T15:12:00Z";
  const f = shortlistOfFeed({ token: TOKEN, title: "Ops roles", floor: null, rows: [r], total: 1, filters: { pay: "any", where: "" }, places: [] }, { sourcesChecked: "9 boards" });
  assertEquals(f.rows.length, 1); assertEquals(f.token, TOKEN); assertEquals(f.rows[0].checkedAt, "2026-11-09T15:12:00Z");
  const html = rolesShortlistPage(f, CTX);
  assertStringIncludes(html, "9:12 AM");
  assertStringIncludes(html, `name="t" value="${TOKEN}"`);
});
