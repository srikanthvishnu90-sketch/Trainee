// R10 coverage check (owner order 2026-11-09, WO-I): every criterion id in docs/architect/specs/APP-LAYER-15-FIXES.md appears
// exactly once in docs/architect/specs/R10-COVERAGE.md, and every row names a test, a live check, or a status that says why not
// (BLOCKED or GAP with a note). The ids are derived from the spec itself, so a criterion added to the spec without a matrix row
// fails here:
//   E-1..E-n   the numbered criteria of E.1-E.9 (87 today)      FIX-1..FIX-n  the fixes in E.10 (15)
//   E11-1..n   the items E.11 lists (11)                         B.1..B.5      the worked examples (B.1-B.5)
//   D.1-D.3    the global design rules                          D.4-1..n      the numbered content rules of D.4 (12)
//   F.1..F.n   the post-reset findings                           R-1..R-6      the owner's readiness review (R-2 per step)
// Usage: deno run -A scripts/r10-coverage-check.ts   Exit 0 when complete, 1 with the missing, extra or empty rows listed.
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const spec = await Deno.readTextFile(`${ROOT}/docs/architect/specs/APP-LAYER-15-FIXES.md`);
const matrix = await Deno.readTextFile(`${ROOT}/docs/architect/specs/R10-COVERAGE.md`);

const between = (a: string, b: string) => { const i = spec.indexOf(a), j = spec.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error(`spec section not found: ${a}`); return spec.slice(i, j); };
const numbered = (s: string) => [...s.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
const want: string[] = [];
for (const n of numbered(between("## E. Every explicit acceptance criterion", "### E.10"))) want.push(`E-${n}`);
for (const n of numbered(between("### E.10", "### E.11"))) want.push(`FIX-${n}`);
// E.11 is one sentence listing its items, comma separated, after the heading line.
const e11 = between("### E.11", "\n\n## ").split("\n").slice(1).join(" ").trim();
const e11Items = e11.replace(/\.$/, "").split(/,\s*(?:and\s+)?|\s+and\s+/).filter((x) => x.trim());
e11Items.forEach((_, i) => want.push(`E11-${i + 1}`));
for (const m of spec.matchAll(/^### (B\.[1-5]) /gm)) want.push(m[1]);
for (const m of spec.matchAll(/^### (D\.[1-3]) /gm)) want.push(m[1]);
for (const n of numbered(between("### D.4", "## E. Every"))) want.push(`D.4-${n}`);
for (const m of spec.matchAll(/^### (F\.\d+) /gm)) want.push(m[1]);
// The owner's readiness review (2026-11-08, relayed by the architect 2026-11-09): rows R-1..R-6, R-2 split per lifecycle step.
want.push("R-1", "R-2.1", "R-2.2", "R-2.3", "R-2.4", "R-2.5", "R-2.6", "R-3", "R-4", "R-5", "R-6");

const rows = matrix.split("\n").filter((l) => /^\| [A-Z]/.test(l) && !/^\| id \|/.test(l)).map((l) => l.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim()));
const ids = rows.map((r) => r[0]);
const problems: string[] = [];
for (const id of want) if (!ids.includes(id)) problems.push(`missing: ${id}`);
for (const id of ids) if (!want.includes(id)) problems.push(`not in the spec: ${id}`);
for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) problems.push(`twice: ${id}`);
for (const [id, , order, tests, live, status, note] of rows) {
  if (!["covered", "live-only", "BLOCKED", "GAP", "review", "integrated"].includes(status)) problems.push(`${id}: unknown status "${status}"`);
  if (status === "covered" && !tests) problems.push(`${id}: covered but names no test`);
  if (status === "live-only" && !live) problems.push(`${id}: live-only but names no live check`);
  if (["BLOCKED", "GAP", "review", "integrated"].includes(status) && !note) problems.push(`${id}: ${status} without a reason`);
  if (!/^(WO-[A-K](\/WO-[A-K])?|owner)$/.test(order)) problems.push(`${id}: owning order "${order}" is not WO-A..WO-K or owner`);
}
const gaps = rows.filter((r) => r[5] === "GAP").map((r) => r[0]);
console.log(`R10 coverage: ${want.length} spec ids, ${rows.length} matrix rows; ${gaps.length} GAP (${gaps.join(", ") || "none"})`);
if (problems.length) { for (const p of problems) console.log(`FAIL ${p}`); Deno.exit(1); }
console.log("PASS every spec id has exactly one row, and every row names a test, a live check or its reason");
