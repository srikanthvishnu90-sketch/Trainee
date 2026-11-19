// S3 r12b review (2026-11-19, PR #871 at 2789d3090 rejected): what the r12b parse and reply guards got wrong, pinned as classes.
//   1. a place written with its state, country or district after it ("in Austin TX", "in Chicago downtown") and the words after a
//      place ("to Dallas", "i guess") are never role words;
// No model, no network.
//   deno test -A --no-check tests/architect/s3-r12b-review-20261119.test.ts
import assertNode from "node:assert/strict";
import { searchTextOf } from "../../supabase/functions/_shared/posting_constraints.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);

Deno.test("r12b-review-1 a place's state, country or district, and what follows a place, are never role words", () => {
  const cases: [string, string][] = [
    ["data analyst roles in Austin TX", "austin"],
    ["data analyst roles in Chicago IL", "chicago"],
    ["data analyst roles in Austin Texas", "austin"],
    ["data analyst roles in Seattle WA", "seattle"],
    ["data analyst roles in Columbus Ohio", "columbus"],
    ["data analyst roles in Denver Colorado", "denver"],
    ["data analyst roles in Boston MA", "boston"],
    ["data analyst roles in Miami Florida", "miami"],
    ["data analyst roles in London UK", "london"],
    ["data analyst roles in Toronto Canada", "toronto"],
    ["data analyst roles in Atlanta Georgia", "atlanta"],
    ["data analyst internships in Atlanta Georgia summer 2027", "atlanta"],
    ["data analyst roles in Chicago downtown", "chicago"],
    ["data analyst roles in Chicago area", "chicago"],
    ["data analyst roles in Chicago metro hiring", "chicago"],
    ["data analyst roles in Austin to Dallas", "austin"],
    ["data analyst roles in Austin i guess", "austin"],
    ["data analyst roles in New York City", "new york"],
    // the comma form, as before (D-054)
    ["data analyst roles in Austin, TX", "austin"],
    ["data analyst roles in Boise, Idaho", "boise"],
  ];
  for (const [m, city] of cases) {
    const st = searchTextOf(m);
    eq(st.role, "data analyst", m);
    // The place starts with the city asked for (the state may stay with it), never another word.
    ok(st.place === city || String(st.place).startsWith(`${city} `), `${m}: place ${st.place}`);
  }
  // H002's class keeps its place and role.
  const h = searchTextOf("I'm a data analyst in Chicago looking for analyst roles");
  eq(h.place, "chicago");
  ok(!/\b(?:looking|chicago)\b/.test(h.role), h.role);
  // A word after the city that starts like a state code is not one ("co-op" is not Colorado): nothing of it is left in the role.
  eq(searchTextOf("data analyst roles in Chicago co-op").role, "data analyst");
  eq(searchTextOf("data analyst roles in Austin or Dallas").role, "data analyst");
  // A role written after the city stays the role.
  ok(/\bdata science\b/.test(searchTextOf("internships in Chicago data science").role));
});
