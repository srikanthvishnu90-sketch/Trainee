// A sign-in code or link is taken only from mail that arrived in the last 15 minutes. Gmail search has no minutes unit
// (`newer_than:15m` is 15 MONTHS), so the search asks for a day and the message's own internalDate decides.
import { CODE_WINDOW_MS, freshForCode, gmailCodeQuery } from "../../supabase/functions/_shared/gmail_code_window.ts";

function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
const NOW = Date.UTC(2026, 9, 20, 12);

Deno.test("gmail code window: the query never uses minutes, and only mail from the last 15 minutes counts", () => {
  assert(gmailCodeQuery("noreply@example.com") === "from:noreply@example.com newer_than:1d");
  assert(!/newer_than:\d+m\b/.test(gmailCodeQuery("x")), "m is months in Gmail search");
  assert(freshForCode({ internalDate: String(NOW - 60_000) }, NOW), "a minute old: fresh");
  assert(freshForCode({ internalDate: NOW - CODE_WINDOW_MS }, NOW), "exactly 15 minutes: fresh");
  assert(!freshForCode({ internalDate: String(NOW - CODE_WINDOW_MS - 1) }, NOW), "older than 15 minutes: never");
  assert(!freshForCode({ internalDate: String(NOW - 40 * 86400_000) }, NOW), "a month-old code: never");
  assert(!freshForCode({}, NOW) && !freshForCode({ internalDate: "x" }, NOW), "no date: never");
  assert(!freshForCode({ internalDate: String(NOW + 10 * 60_000) }, NOW), "dated in the future: never");
});
