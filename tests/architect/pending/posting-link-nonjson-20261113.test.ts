// PENDING (not run by the gate). Review of PR #775, round 2 (2026-11-13), item 1: the link check should not call a posting
// live on a board API's 200 whose body is not JSON (a bot wall, an HTML error page): that is not the posting. Today
// link_check.ts keeps trunk's answer ("live") for a non-JSON 200, because tests/architect/wo-106-agent-slice.test.ts:180 pins it:
//   assert(await linkChecker(fake(200))({ job_id: "greenhouse:stripe:2" }) === "live", "200");   // the stub's body is "x"
// Amending that line needs the owner. When it is amended, remove the non-JSON branch in link_check.ts (the API branch) and
// move this file out of pending.
import assertNode from "node:assert/strict";
import { linkChecker } from "../../../supabase/functions/_shared/link_check.ts";

const page = (text: string, type: string) => (async () => new Response(text, { status: 200, headers: { "content-type": type } })) as unknown as typeof fetch;

Deno.test("a board API's 200 that is not JSON is unknown, never live", async () => {
  for (const [name, job, f] of [
    ["Greenhouse bot wall", { job_id: "greenhouse:acme:123" }, page("<html>captcha</html>", "text/html")],
    ["Lever HTML error page", { job_id: "lever:acme:0ccbe620-aaaa-bbbb-cccc-000000000000" }, page("<html>Service unavailable</html>", "text/html")],
    ["SmartRecruiters plain text", { job_id: "smartrecruiters:acme:744000012345678" }, page("x", "text/plain")],
  ] as const) assertNode.equal(await linkChecker(f)(job), "unknown", name);
});
