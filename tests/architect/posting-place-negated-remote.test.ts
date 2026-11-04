// Independent review of #455: a location that says how the work is NOT done ("Not Remote", "Mostly Remote", "Onsite Remote")
// is never a remote posting, and real "<place> Remote" forms still are. Pure functions, no network, no database.
//   deno test -A --no-check tests/architect/posting-place-negated-remote.test.ts
import assertNode from "node:assert/strict";
import { postingPlaces } from "../../supabase/functions/_shared/posting_place.ts";

const remote = (s: string) => postingPlaces(s).some((p) => p.remote);
Deno.test("PN-1 negated or qualified remote is not remote", () => {
  for (const s of ["Not Remote", "Mostly Remote", "Onsite Remote", "Austin, TX - Not Remote", "No Remote", "Semi Remote", "On-site Remote"]) {
    assertNode.equal(remote(s), false, `${s} -> ${JSON.stringify(postingPlaces(s))}`);
  }
});
Deno.test("PN-2 real place-then-remote forms are still remote (round 3 behaviour kept)", () => {
  for (const s of ["US Remote", "Texas Remote", "Canada Remote", "Remote - US", "Remote", "Anywhere"]) {
    assertNode.equal(remote(s), true, `${s} -> ${JSON.stringify(postingPlaces(s))}`);
  }
});
