// WO-124a review findings (handoff 2026-11-15, section 2): one test per finding, added after the review said NOT fit.
// The acceptance tests in work-artifacts-core-20261114.test.ts are unchanged. Fixtures are invented and fictional.
import * as kase from "../../../supabase/functions/_shared/work/case.ts";
import * as model from "../../../supabase/functions/_shared/work/model.ts";
import * as versions from "../../../supabase/functions/_shared/work/versions.ts";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";
import * as deliver from "../../../supabase/functions/_shared/work/deliver.ts";
import * as proof from "../../../supabase/functions/_shared/work/proof.ts";
import { zipSync } from "npm:fflate@0.8.2";

const NOW = Date.UTC(2026, 10, 15, 12);
function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function throwsNamed(fn: () => unknown, name: string, m: string) {
  try { fn(); } catch (e) { if ((e as Error).name === name) return; throw new Error(`${m}: threw ${(e as Error).name}`); }
  throw new Error(`${m}: did not throw`);
}
const enc = (s: string) => new TextEncoder().encode(s);

// D6: the guard cannot be opened by flipping the case's flag, before or after the guard is made, or by a forged case.
Deno.test("124a review D6: flipping c.practice or forging a case never opens the profile", () => {
  const touched: string[] = [];
  const io = { read: () => { touched.push("read"); return {}; }, write: () => { touched.push("write"); } };
  const c = kase.newCase({ owner: "SYN-OWNER", practice: true, title: "Invented sample", now: NOW });
  try { (c as { practice: boolean }).practice = false; } catch { /* read-only: strict mode throws */ }
  eq(c.practice, true, "the flag stays practice");
  const g = kase.profileGuard(c, io);
  throwsNamed(() => g.read(), "PracticeIsolation", "read after a flip attempt");
  throwsNamed(() => g.write({ kind: "skill" }), "PracticeIsolation", "write after a flip attempt");
  const forged = { ...c, practice: false } as kase.WorkCase;
  throwsNamed(() => kase.profileGuard(forged, io).read(), "PracticeIsolation", "a case this module did not make fails closed");
  const cloned = structuredClone(c);
  throwsNamed(() => kase.profileGuard(cloned, io).read(), "PracticeIsolation", "a cloned case fails closed");
  eq(touched, [], "the accessor was never called");
  assert(Object.isFrozen(g) && !("io" in g), "the guard is frozen and does not expose the accessor");
  const own = kase.newCase({ owner: "SYN-OWNER", practice: false, title: "My own offer", now: NOW });
  kase.profileGuard(own, io).read();
  eq(touched, ["read"], "a real case still reads through the guard");
});

// D4: the revoke scan finds a percent stored as an xlsx fraction, trailing zeros, words, fullwidth digits and UTF-16.
Deno.test("124a review D4: the revoke scan finds fraction cells, 0.40, words, fullwidth and UTF-16 forms", async () => {
  const utf16 = (s: string) => { const b = new Uint8Array(2 + s.length * 2); b[0] = 0xff; b[1] = 0xfe; for (let i = 0; i < s.length; i++) b[2 + 2 * i] = s.charCodeAt(i); return b; };
  const xlsx = zipSync({ "xl/worksheets/sheet1.xml": enc('<sheetData><row r="2"><c r="B2" s="3"><v>0.4</v></c></row></sheetData>') });
  const files: Record<string, Uint8Array> = {
    "book.xlsx": xlsx,
    "a.txt": enc("conversion rose 0.40 points of share"),
    "b.txt": enc("latency fell forty percent"),
    "c.txt": enc("latency fell ４０％"),
    "d.xml": utf16("<note>cut by 40%</note>"),
    "clean.txt": enc("latency fell sharply; 4 of 10 users and 140 rows"),
  };
  const hits = await revoke.scan(files, ["40%"]);
  eq(hits.map((h) => h.part).sort(), ["a.txt", "b.txt", "book.xlsx!xl/worksheets/sheet1.xml", "c.txt", "d.xml"], "every derived form is found, the clean part is not");
  assert(!/40|0\.4|forty/i.test(revoke.audit(hits)), "the audit never repeats the value");
  eq((await revoke.scan({ "e.txt": enc("we hired forty-two people") }, [42])).length, 1, "a hyphenated number word is found");
});

// D1: loose numbers with glued units and number words are listed; a year or a date is not a figure.
Deno.test("124a review D1: glued units and number words are loose; dates and years are not", () => {
  const v = { stipend: 17280, lift: 0.4, ratio: 1.5 };
  eq(model.loose("Paid 18000USD at 2.5x in 40ms.", v), ["18000USD", "2.5x", "40ms"], "glued units are read and listed");
  eq(model.loose("Paid 17280USD at 1.5x.", v), [], "glued units that equal a cell are fine");
  eq(model.loose("Lift was forty percent; twelve users joined.", v), ["twelve"], "number words count; forty percent equals the 0.4 cell");
  eq(model.loose("Due in 2026, on 2026-11-14 and Nov 14, 2026 at 10:30.", v), [], "dates, times and a year after a year word are not figures");
  eq(model.loose("We expect 2026 signups.", v), ["2026"], "a bare 2026 with no year word is still a figure");
  eq(model.loose("Lift was ４０％.", v), [], "fullwidth digits read as ASCII");
  eq(model.loose("Revenue hit $3m.", v), ["$3m"], "m after a currency sign is a million and matches no cell");
});

// D5: the stated tolerance is the one applied.
Deno.test("124a review D5: the invariant tolerance is applied, per cell", () => {
  const c = kase.newCase({ owner: "SYN-OWNER", practice: true, title: "Invented cohorts", now: NOW });
  kase.addRound(c, { round: 1, text: "build", constraints: [] });
  const m = (a: number) => ({ cells: [{ id: "a", value: a }, { id: "b", value: 10 }], text: [] });
  versions.saveVersion(c, { kind: "xlsx", model: m(100), files: {} });
  kase.addRound(c, { round: 2, text: "edit", constraints: [] });
  const loose = versions.saveVersion(c, { kind: "xlsx", model: m(100.004), files: {}, invariants: [versions.unchanged("a and b", ["a", "b"], 0.01)] });
  eq(loose.invariants[0].ok, true, "a change inside the tolerance passes");
  kase.addRound(c, { round: 3, text: "edit", constraints: [] });
  const tight = versions.saveVersion(c, { kind: "xlsx", model: m(100.005), files: {}, invariants: [versions.unchanged("a and b", ["a", "b"], 0.0001)] });
  eq(tight.invariants[0].ok, false, "the same size of change fails a tighter tolerance");
  let seen = -1;
  kase.addRound(c, { round: 4, text: "edit", constraints: [] });
  versions.saveVersion(c, { kind: "xlsx", model: m(100.005), files: {}, invariants: [versions.invariant("tol passed", (_p, _n, t) => { seen = t; return true; }, 0.25)] });
  eq(seen, 0.25, "a custom invariant receives its tolerance");
  throwsNamed(() => versions.invariant("bad", () => true, Infinity), "RangeError", "an infinite tolerance is refused");
});

// D8: a claim is backed only by a check of its own category; a generic claim needs every check run and ok.
Deno.test("124a review D8: boundClaims maps claims to check categories and fails closed", () => {
  const fixture = proof.report([{ name: "test fixture loaded", ran: true, ok: true }], []);
  eq(proof.boundClaims("Tests pass.", fixture).refused, ["Tests pass"], "a shared word is not a test run");
  const partial = proof.report([
    { name: "formulas recomputed independently", ran: true, ok: true },
    { name: "tests run in sandbox", ran: false, why: "no sandbox" },
  ], []);
  eq(proof.boundClaims("All checks passed.", partial).refused, ["All checks passed"], "a generic claim with a check not run is refused");
  eq(proof.boundClaims("Everything is verified.", partial).refused, ["Everything is verified"], "verified with a check not run is refused");
  eq(proof.boundClaims("The totals add up.", partial).refused, [], "a recompute claim is backed by the recompute check");
  const full = proof.report([
    { name: "formulas recomputed independently", ran: true, ok: true },
    { name: "tests run in sandbox", ran: true, ok: true },
  ], []);
  eq(proof.boundClaims("All checks passed.", full).refused, [], "every check ran and passed");
  const failed = proof.report([{ name: "ics lint", ran: true, ok: false }], []);
  eq(proof.boundClaims("The calendar file has no errors.", failed).refused, ["The calendar file has no errors"], "a failed lint backs no 'no errors'");
  eq(proof.boundClaims("It fits one page.", full).refused, ["It fits one page"], "no page check, no page claim");
  eq(proof.categoryOf("pages rendered, clipping checked"), "pages", "page check category");
});

// D7: WhatsApp goes through Twilio, whose list has no plain text, a 20 MB message cap and a 5 MB image cap.
Deno.test("124a review D7: the WhatsApp list follows Twilio's documented types and limits", () => {
  eq(deliver.chooseDelivery("whatsapp", "text/plain"), "file_page", "Twilio lists no plain text");
  eq(deliver.chooseDelivery("whatsapp", "application/pdf", { bytes: 21 * 1024 * 1024 }), "text_builder", "over 20 MB and over the page cap");
  eq(deliver.chooseDelivery("whatsapp", "application/pdf", { bytes: 19 * 1024 * 1024 }), "native", "under 20 MB");
  eq(deliver.chooseDelivery("whatsapp", "image/png", { bytes: 6 * 1024 * 1024 }), "file_page", "an image over 5 MB is not native");
  eq(deliver.chooseDelivery("whatsapp", "text/calendar"), "file_page", "ICS is not on Twilio's list");
});
