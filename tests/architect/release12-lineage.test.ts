// Release 12 (deploy-production run 45874743067): a release PR's merge commit on release/production carries the measured
// trunk commit as its SECOND parent. sameReplyCode walks first parents and a merge's second parent, each only while the
// reply code is identical to the candidate's.
import { sameReplyCode } from "../../scripts/launch/deploy-standard.ts";

const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}\n got:  ${JSON.stringify(a)}\n want: ${JSON.stringify(b)}`); };
// A small graph: sha -> [first parent, second parent], and each commit's reply-code identity.
function src(g: Record<string, [string | null, string | null]>, code: Record<string, string>, withSecond = true) {
  return {
    parent: async (s: string) => g[s]?.[0] ?? null,
    ...(withSecond ? { secondParent: async (s: string) => g[s]?.[1] ?? null } : {}),
    changed: async (a: string, b: string) => code[a] !== code[b],
  } as any;
}

Deno.test("release 12: the release merge stands on its second parent's sitting when the reply code is identical", async () => {
  // M = merge(R11 (other reply code, never deployed), T (measured)); T's first parent T0 has identical reply code too.
  const g = { M: ["R11", "T"], R11: ["R9", null], T: ["T0", null], T0: ["X", null], R9: [null, null], X: [null, null] } as Record<string, [string | null, string | null]>;
  const code = { M: "new", T: "new", T0: "new", R11: "old11", R9: "old9", X: "older" };
  eq(await sameReplyCode(src(g, code), "M"), ["M", "T", "T0"]);
});

Deno.test("release 12: a second parent with different reply code never counts, and nothing beyond a change is walked", async () => {
  const g = { M: ["A", "B"], A: ["C", null], B: ["D", null], C: [null, null], D: [null, null] } as Record<string, [string | null, string | null]>;
  eq(await sameReplyCode(src(g, { M: "x", A: "x", B: "y", C: "z", D: "x" }), "M"), ["M", "A"], "B differs, so D (same as M) is not reached through it");
});

Deno.test("release 12: a source without secondParent keeps the first-parent chain, at most 10 back", async () => {
  const g: Record<string, [string | null, string | null]> = {}; const code: Record<string, string> = {};
  for (let i = 0; i < 15; i++) { g[`c${i}`] = [`c${i + 1}`, `s${i}`]; code[`c${i}`] = "same"; code[`s${i}`] = "same"; }
  eq((await sameReplyCode(src(g, code, false), "c0")).length, 11);
  const both = await sameReplyCode(src(g, code), "c0");
  eq(both.filter((x) => x.startsWith("c")).length, 11, "first-parent depth still capped at 10");
});
