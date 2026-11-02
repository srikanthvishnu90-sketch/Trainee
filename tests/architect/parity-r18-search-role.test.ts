// Parity audit R18 / failure case F1: a request for "real postings with links" is searched for the role the person named,
// never for the words "real postings links". posting_constraints.ts searchTextOf is what the chat's search (career_search_judge.ts
// askFor) reads a message with.
// Run: deno test -A --no-check tests/architect/parity-r18-search-role.test.ts
import nodeAssert from "node:assert/strict";
import { searchTextOf } from "../../supabase/functions/_shared/posting_constraints.ts";

const NOISE = /\b(real|actual|postings?|listings?|links?|urls?|send)\b/;
for (const [ask, role, place] of [
  ["i want real software engineering internship postings in chicago with links", "software engineering", "chicago"],
  ["send me actual data analyst job listings in austin", "data analyst", "austin"],
  ["send me the links to marketing roles", "marketing", null],
  ["show me real postings for nurse jobs in denver", "nurse", "denver"],
] as const) {
  Deno.test(`R18: "${ask}" searches for "${role}"`, () => {
    const st = searchTextOf(ask);
    nodeAssert.ok(!NOISE.test(st.role), `the role carries request words: "${st.role}"`);
    nodeAssert.equal(st.role, role);
    nodeAssert.equal(st.place, place);
  });
}
Deno.test("R18 control: a role that is the word itself is kept (a link technician, a listing coordinator)", () => {
  nodeAssert.equal(searchTextOf("find link technician jobs").role, "link technician");
  nodeAssert.equal(searchTextOf("find listing coordinator roles in miami").role, "listing coordinator");
  // Review of #396: "live" and "current" are part of a role when they are not describing the postings.
  nodeAssert.equal(searchTextOf("send me live sound engineer job postings").role, "live sound engineer");
  nodeAssert.equal(searchTextOf("find current events reporter roles with links").role, "current events reporter");
  nodeAssert.equal(searchTextOf("send me live postings for nurse jobs").role, "nurse");
});
