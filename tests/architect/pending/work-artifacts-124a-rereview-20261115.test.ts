// WO-124a second review (2026-11-15) and the 124d review's findings against model.loose: one test per finding.
// Earlier tests are unchanged. Fixtures are invented.
import { zlibSync } from "npm:fflate@0.8.2";
import * as kase from "../../../supabase/functions/_shared/work/case.ts";
import * as model from "../../../supabase/functions/_shared/work/model.ts";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";
import * as proof from "../../../supabase/functions/_shared/work/proof.ts";

const NOW = Date.UTC(2026, 10, 15, 12);
function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("124a re-review D8: an assurance with no named category needs every check run and ok", () => {
  const notRun = proof.report([{ name: "tests run in sandbox", ran: false, why: "no sandbox" }, { name: "formulas recomputed independently", ran: true, ok: true }], []);
  const failed = proof.report([{ name: "tests run in sandbox", ran: true, ok: false }], []);
  const noCode = proof.report([{ name: "formulas recomputed independently", ran: true, ok: true }], []);
  // Generic assurances: refused whenever any check failed or did not run.
  const generic = ["No failures.", "Nothing failed.", "Zero failures.", "Everything's green.", "All green.", "It's correct.",
    "Proven correct.", "I've checked everything.", "I've confirmed it.", "All set, no bugs.", "bug-free", "Ready to ship."];
  for (const p of generic) for (const [name, r] of [["not run", notRun], ["failed", failed]] as const) {
    eq(proof.boundClaims(p, r).ok, false, `"${p}" against a report with a ${name} check`);
  }
  // Claims that code ran or passed: refused unless a code check ran and passed, so also when there is no code check.
  const code = ["I ran it.", "CI is green.", "It works.", "It runs.", "It compiles.", "The script ran successfully.", "Tests: 12/12 OK.",
    "Unit tests ok.", "Specs pass.", "The suite passes.", "pytest passed."];
  for (const p of code) for (const [name, r] of [["not run", notRun], ["failed", failed], ["no code", noCode]] as const) {
    eq(proof.boundClaims(p, r).ok, false, `"${p}" against a report with a ${name} check`);
  }
  const all = proof.report([{ name: "tests run in sandbox", ran: true, ok: true }, { name: "formulas recomputed independently", ran: true, ok: true }], []);
  eq(proof.boundClaims("It works and all tests pass.", all).ok, true, "backed when every check ran and passed");
});

Deno.test("124a re-review D4: a revoked percent does not match every lone 0 or 1, and scaled forms are found", async () => {
  const clean = { "xl/styles.xml": enc('<numFmt numFmtId="0"/><font fontId="0"/>'), "a.txt": enc("we had 0 issues; score 1 of 3") };
  eq((await revoke.scan(clean, ["40%"])).length, 0, "40% revoked: no hit on 0 or 1");
  eq((await revoke.scan({ "a.txt": enc("rate 0.1 here") }, ["5%"])).length, 0, "5% revoked: 0.1 is not 0.05");
  eq((await revoke.scan({ "a.txt": enc("a 3 day trip") }, [2.5])).length, 0, "2.5 revoked: a lone 3 is not a hit");
  eq((await revoke.scan({ "a.txt": enc("stored as 0.4") }, ["40%"])).length, 1, "the exact fraction is still found");
  for (const t of ["raised 1,500,000", "raised 1500000"]) eq((await revoke.scan({ "a.txt": enc(t) }, ["$1.5m"])).length, 1, `${t} for $1.5m`);
  for (const t of ["about 17.3k", "$17.3k", "17.28 thousand"]) eq((await revoke.scan({ "a.txt": enc(t) }, [17280])).length, 1, `${t} for 17280`);
});

Deno.test("124a re-review D4: a value printed in a compressed PDF stream is found", async () => {
  const stream = zlibSync(enc("BT /F1 11 Tf 1 0 0 1 54 700 Tm (Stipend 17,280 a year) Tj ET"));
  const head = enc(`%PDF-1.4\n5 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`);
  const tail = enc("\nendstream\nendobj\n%%EOF\n");
  const pdf = new Uint8Array([...head, ...stream, ...tail]);
  eq((await revoke.scan({ "memo.pdf": pdf }, [17280])).length, 1, "the PDF text layer is scanned");
});

Deno.test("124a re-review D6: anything but a real false is a practice case", () => {
  for (const v of ["true", 1, undefined, null, "false", 0]) {
    const c = kase.newCase({ owner: "SYN-OWNER", practice: v as unknown as boolean, title: "Invented", now: NOW });
    assert(c.practice === true && c.id.startsWith("practice:"), `practice ${JSON.stringify(v)} fails closed`);
    let threw = false; try { kase.profileGuard(c, { read: () => ({}), write: () => {} }).read(); } catch (e) { threw = (e as Error).name === "PracticeIsolation"; }
    assert(threw, `the guard stays shut for ${JSON.stringify(v)}`);
  }
  assert(!kase.newCase({ owner: "SYN-OWNER", practice: false, title: "Mine", now: NOW }).practice, "false is an own case");
});

Deno.test("124a re-review D1: loose lists glued, scaled, signed, non-ASCII and word figures; real dates only are exempt", () => {
  const listed = (t: string) => model.loose(t, {}).length > 0;
  for (const t of ["USD19,200", "Rs19200", "x30", ".5%", "a bonus of 2000", "the bonus rises to 2000 dollars", "by 2000 users",
    "cost-2000", "About 45 may leave the cohort.", "a ratio of 1:25", "9999-99-99", "٢٠٠٠", "१९२००", "a dozen", "half", "twice",
    "H1B", "Q3", "in 2026 users", "Feb 30, 2026"]) assert(listed(t), `listed: ${t}`);
  for (const t of ["Due in 2026.", "on 2026-11-14", "Nov 14, 2026", "at 10:30", "from 2024 to 2026", "May 2026", "mid-2026", "since 2019, we"]) eq(model.loose(t, {}), [], `a date is not a figure: ${t}`);
  eq(model.loose("Raised 5 million and $2 million", { a: 5e6, b: 2e6 }), [], "scale words after a space");
  eq(model.loose("Lift was 40 percent", { a: 0.4 }), [], "percent after a space");
  eq(model.loose("Net -500", { a: -500 }), [], "the sign is read");
  eq(model.loose("Net -500", { a: 500 }), ["-500"], "and must match");
});
