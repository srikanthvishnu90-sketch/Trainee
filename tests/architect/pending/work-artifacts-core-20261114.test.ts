// WO-124 acceptance tests: the work-artifact core (spec docs/architect/specs/WORK-ARTIFACTS.md, rules D1 and D4 to D8).
// Written before the code. Fixtures are invented and fictional; none is copied from benchmark pack 01.
// There is no provider, no database and no network; the clock is an input.
import * as kase from "../../../supabase/functions/_shared/work/case.ts";
import * as model from "../../../supabase/functions/_shared/work/model.ts";
import * as versions from "../../../supabase/functions/_shared/work/versions.ts";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";
import * as deliver from "../../../supabase/functions/_shared/work/deliver.ts";
import * as proof from "../../../supabase/functions/_shared/work/proof.ts";

const NOW = Date.UTC(2026, 10, 14, 18);
function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}`); }
  throw new Error(`${m}: did not throw`);
}

// D6: a practice case never reads the profile and never writes to it.
Deno.test("D6: a practice case cannot read or write the person's profile", () => {
  const c = kase.newCase({ owner: "SYN-OWNER", practice: true, title: "Invented Co cohort sample", now: NOW });
  const g = kase.profileGuard(c);
  throwsNamed(() => g.read(), "PracticeIsolation", "read from profile in practice case");
  throwsNamed(() => g.write({ kind: "skill", text: "SQL" }), "PracticeIsolation", "write to profile from practice case");
  const real = kase.newCase({ owner: "SYN-OWNER", practice: false, title: "My own offer", now: NOW });
  const rg = kase.profileGuard(real);
  rg.read(); // allowed
});

// D4: the ledger keeps every constraint's round, kind and status; a supersede and a revoke are recorded, not erased.
Deno.test("D4: the constraint ledger records supersede and revoke across rounds", () => {
  const c = kase.newCase({ owner: "SYN-OWNER", practice: true, title: "Invented portfolio", now: NOW });
  kase.addRound(c, { round: 1, text: "one page; you may show the 40% figure with a qualifier", constraints: [
    { id: "len", kind: "output", text: "one page" },
    { id: "v40", kind: "permission", text: "may show 40% with a qualifier", values: ["40%"] },
  ] });
  kase.addRound(c, { round: 2, text: "remove the 40% figure everywhere; two pages is fine", constraints: [
    { id: "len2", kind: "output", text: "two pages", supersedes: "len" },
    { id: "rv40", kind: "permission", text: "revoke 40%", revokes: "v40" },
  ] });
  const l = kase.ledger(c);
  eq(l.find((r) => r.id === "len")?.status, "superseded", "len superseded");
  eq(l.find((r) => r.id === "v40")?.status, "revoked", "v40 revoked");
  eq(kase.active(c).map((r) => r.id).sort(), ["len2", "rv40"], "active rows");
  eq(kase.revoked(c), ["40%"], "revoked values");
  eq(l.length, 4, "nothing erased");
});

// D1: a number in prose comes from a cell; a ref with no cell throws; a typed number with no cell is listed.
Deno.test("D1: prose numbers come from cells; a typed number with no cell is caught", () => {
  const m = { cells: [
    { id: "stipend", value: 17280 }, { id: "bonus", value: 2000 },
    { id: "total", formula: "stipend+bonus" },
  ], text: [] };
  const v = model.evaluate(m);
  eq(v.total, 19280, "evaluated total");
  eq(model.render("Total cash is ${{ref:total}}.", v, { total: "#,##0" }), "Total cash is $19,280.", "rendered ref");
  throwsNamed(() => model.render("Net is ${{ref:net}}.", v), "UnknownRef", "ref with no cell");
  eq(model.loose("Total cash is $19,200, from a $2,000 bonus.", v), ["$19,200"], "typed number with no matching cell");
});

// D5: a version diff lists each changed cell with its round; an invariant at full precision catches offsetting edits.
Deno.test("D5: diffs name changed cells; invariants catch offsetting edits at full precision", () => {
  const c = kase.newCase({ owner: "SYN-OWNER", practice: true, title: "Invented cohorts", now: NOW });
  kase.addRound(c, { round: 1, text: "build it", constraints: [] });
  const base = { cells: [{ id: "a_act", value: 720 }, { id: "b_act", value: 630 }, { id: "tot", formula: "a_act+b_act" }], text: [] };
  const v1 = versions.saveVersion(c, { kind: "xlsx", model: base, files: {} });
  kase.addRound(c, { round: 2, text: "edit", constraints: [{ id: "keep", kind: "hard", text: "per-cohort baseline unchanged" }] });
  const edited = { cells: [{ id: "a_act", value: 721 }, { id: "b_act", value: 629 }, { id: "tot", formula: "a_act+b_act" }], text: [] };
  const inv = [versions.invariant("per-cohort activated unchanged", (prev, next) => ["a_act", "b_act"].every((k) => Math.abs(prev[k] - next[k]) <= 1e-9), 1e-9)];
  const v2 = versions.saveVersion(c, { kind: "xlsx", model: edited, files: {}, invariants: inv });
  eq(v2.diff.map((d) => d.path).sort(), ["a_act", "b_act"], "diff lists both changed cells, not the unchanged total");
  eq(v2.diff[0].round, 2, "diff carries the round");
  eq(v2.invariants[0].ok, false, "the offsetting edit is caught although the total is unchanged");
  assert(v1.version === 1 && v2.version === 2, "versions numbered");
});

// D4: a revoked value is found in any OOXML part and in derived forms, and the audit never repeats the value.
Deno.test("D4: a revoked value is found in metadata and derived forms; the audit names only categories", async () => {
  const files = {
    "word/document.xml": new TextEncoder().encode("<w:t>Latency fell sharply</w:t>"),
    "docProps/core.xml": new TextEncoder().encode("<dc:description>cut latency 40 percent</dc:description>"),
    "word/media/alt.txt": new TextEncoder().encode("chart: from 250ms to 150ms"),
  };
  const hits = await revoke.scan(files, ["40%", { before: "250ms", after: "150ms" }]);
  eq(hits.map((h) => h.part).sort(), ["docProps/core.xml", "word/media/alt.txt"], "found in metadata and alt text");
  const audit = revoke.audit(hits);
  assert(!/40|250|150/.test(audit), "the audit text never repeats a revoked value");
});

// D7: a refused file type falls back inside the channel; no third-party upload exists in the delivery module.
Deno.test("D7: a refused type falls back to Trainee's own page or a text builder, never an outside upload", async () => {
  eq(deliver.chooseDelivery("whatsapp", "application/zip"), "file_page", "zip on WhatsApp: Trainee's own page");
  eq(deliver.chooseDelivery("whatsapp", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "native", "xlsx on WhatsApp");
  eq(deliver.chooseDelivery("imessage", "text/html"), "file_page", "html on iMessage");
  const src = await Deno.readTextFile(new URL("../../../supabase/functions/_shared/work/deliver.ts", import.meta.url));
  assert(!/drive|dropbox|googleapis|onedrive|box\.com|share_link|publish/i.test(src), "no outside storage or sharing in delivery");
});

// D8 and D2: the reply's claims are bounded by the check log.
Deno.test("D8: a reply may not claim a check that was not run", () => {
  const r = proof.report([
    { name: "formulas recomputed independently", ran: true, ok: true },
    { name: "tests run in sandbox", ran: false, why: "no sandbox in this release" },
  ], ["native Excel not tested"]);
  assert(/not run/i.test(r) && /native Excel not tested/.test(r), "report lists the check not run and the limits");
  eq(proof.boundClaims("Formulas check out and all tests pass.", r).refused, ["all tests pass"], "the untested claim is refused");
  eq(proof.boundClaims("Formulas were recomputed independently and match.", r).refused, [], "the run check may be claimed");
});
