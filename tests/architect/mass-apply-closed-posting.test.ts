// MASS APPLY (2026-11-01): a posting that closed after the person's approval ends ALONE. The engine reads its page's
// 404/410 at the open, before anything is filled, as POSTING_CLOSED (scripts/apply.ts); the cloud worker records that as
// not sent and as no failure of the site (workers/career-cloud/worker.ts settle), so the cloud throttle
// (career_apply_cloud_throttle: 2% errors pauses the ATS for 6 hours) never pauses Greenhouse/Lever/Ashby for everyone's
// batch because one posting closed. A real error is still an error. The engine and the database half are proven end to end
// in flow-mass-apply-telegram.test.ts step 8.
import assertNode from "node:assert/strict";
import { settle } from "../../workers/career-cloud/worker.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

Deno.test("a closed posting is not sent and not a site failure; an engine error still is", () => {
  eq(settle({ state: "not_submitted", reason: "POSTING_CLOSED" }), { state: "not_submitted", reason: "POSTING_CLOSED", outcome: "not_sent", errorKind: "POSTING_CLOSED" });
  eq(settle({ state: "not_submitted", reason: "DRIVER_ERROR" }).outcome, "error");
  eq(settle({ state: "needs_user", reason: "captcha" }).outcome, "bot_check");
});
