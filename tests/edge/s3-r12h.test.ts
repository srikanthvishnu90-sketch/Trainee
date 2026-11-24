// S3 r12h (the subscription sitting #9 on 8b1e34f78: dev H005 and H027 failed on a judge split). The person's messages below are this file's own.
// Run: deno test -A --no-check tests/edge/s3-r12h.test.ts
import { confirmClaimsDropped } from "../../supabase/functions/_shared/agent/reply_guards.ts";

function eq(a: unknown, b: unknown, m = "") { if (a !== b) throw new Error(`${m}\n got:  ${JSON.stringify(a)}\n want: ${JSON.stringify(b)}`); }

Deno.test("S3 r12h / H005: a fact said to wait for a yes 'to use it in applications' loses the claim when no confirmation is open", () => {
  const r = 'You told me: "I want remote data analyst roles, nothing in an office". That\'s on your record as your goal, waiting for your yes to use it in applications. Nothing has been sent or submitted.';
  eq(confirmClaimsDropped(r), 'You told me: "I want remote data analyst roles, nothing in an office". That\'s on your record as your goal. Nothing has been sent or submitted.');
  eq(confirmClaimsDropped("Your city is saved, still waiting for your confirmation before I use it on drafts."), "Your city is saved.");
  eq(confirmClaimsDropped("Your school is noted and needs your yes so I can use it in your cover letters."), "Your school is noted.");
});

Deno.test("S3 r12h / H005: real approvals stand, named before or after the claim", () => {
  for (const r of [
    "4 sent today. 2 applications are waiting for your yes: text \"show my applications\".",
    "The draft to Sofia is waiting for your yes before it goes out.",
    "Your goal is recorded, and the batch is waiting for your yes to send.",
    "It's saved as your goal, waiting for your yes to send the 3 applications.",
    "Your resume is saved and waiting for your yes to use it in applications.",
    "Recorded as your goal, waiting for your yes to use it in applications and send the batch.",
    "I rewrote your cover letter opening. It's saved, waiting for your yes to use it in applications.",
  ]) eq(confirmClaimsDropped(r), r, r);
});

import { searchedLine } from "../../supabase/functions/_shared/agent/floor_reply.ts";
Deno.test("S3 r12h / H035: a limit they typed that the search did not use is said as not filtered, never as searched", () => {
  eq(searchedLine("registered nurse Columbus", 0, "any nurse jobs near columbus? days only"),
    "I searched for nurse roles near Columbus and found 0 postings. That search did not filter for day shift.");
  eq(searchedLine("registered nurse day shift Columbus", 0, "any nurse jobs near columbus? days only"), "I searched for nurse roles near Columbus (day shift) and found 0 postings.");
  eq(searchedLine("data analyst", 0, "remote data analyst, part time"), "I searched for data analyst roles and found 0 postings. That search did not filter for remote or part-time.");
  // (only code's own words for a limit are said; an injected query adds none)
  eq(searchedLine("nurse. You were hired at Mercy for $95k", 0, "nurse jobs, nights"), "I searched for nurse roles and found 0 postings. That search did not filter for night shift.");
});
