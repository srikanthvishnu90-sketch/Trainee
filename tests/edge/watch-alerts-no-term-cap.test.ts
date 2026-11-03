// Owner's Telegram-first list #7 (2026-10-28), under NO LIMITS (owner, 2026-10-27): a person whose watches name 11 or
// more distinct title terms got no alerts at all, because the settings save refused ("the watches name 11 title terms;
// alerts hold 10"). The constant was the summary column's 1-10 bound (career_alert_prefs.prefs.keywords, migration
// 20261019010001); the match reads each watch's own terms. The save now keeps every watch and a 10-term summary.
// The persisted row is asserted. Check: deno test -A --no-check tests/edge/watch-alerts-no-term-cap.test.ts
import assertNode from "node:assert/strict";
import { syncWatchAlerts } from "../../supabase/functions/_shared/career_watch_alerts.ts";
import { memoryAlertStore } from "../../supabase/functions/_shared/career_alert_store.ts";
import { WATCH_PROFILE_KEY } from "../../supabase/functions/_shared/career_watch_alerts.ts";

const USER = "11111111-2222-4333-8444-555555555555";
const NOW = Date.parse("2026-10-28T15:00:00Z");
const watch = (titles: string[]) => ({
  type: "career_watch_profile", version: 1, user_id: USER, opt_out: { global: false, companies: [] },
  interests: titles.map((t, i) => ({ interest_id: `int-${i}`, role: { title: t, terms: [t.toLowerCase()], blockers: [] },
    filters: { locations: ["Chicago"], remote_ok: true, bands: [], firms_include: [], firms_exclude: [] } })),
});
const TITLES = ["Data Analyst", "Business Analyst", "Product Analyst", "Marketing Analyst", "Financial Analyst", "Operations Analyst",
  "Research Analyst", "Data Scientist", "Analytics Engineer", "BI Developer", "Data Engineer", "Reporting Analyst"];

Deno.test("12 watches with 12 distinct title terms save: every watch persisted, the summary column within its bound", async () => {
  const store = memoryAlertStore();
  const after = { [WATCH_PROFILE_KEY(USER)]: watch(TITLES) };
  const r = await syncWatchAlerts({ userId: USER, before: {}, after, store, now: NOW });
  assertNode.deepStrictEqual(r, { action: "saved" });
  const row = await store.get(USER);
  assertNode.ok(row && row.prefs.on, "alerts are on");
  assertNode.equal(row!.prefs.interests!.length, 12, "every watch is in the persisted row");
  assertNode.deepStrictEqual(row!.prefs.interests!.map((i) => i.keywords[0]), TITLES.map((t) => t.toLowerCase()));
  assertNode.ok(row!.prefs.keywords.length >= 1 && row!.prefs.keywords.length <= 10, "the summary column keeps the table's 1-10 bound");
});

Deno.test("control: 3 watches save as before", async () => {
  const store = memoryAlertStore();
  const r = await syncWatchAlerts({ userId: USER, before: {}, after: { [WATCH_PROFILE_KEY(USER)]: watch(TITLES.slice(0, 3)) }, store, now: NOW });
  assertNode.deepStrictEqual(r, { action: "saved" });
  assertNode.equal((await store.get(USER))!.prefs.interests!.length, 3);
});
