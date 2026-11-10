// RESUME DESIGN LOOP (r-resume-design, 2026-11-10; release item 3 in docs/architect/VERIFICATION-15.md). The resume loop
// (r10-resume-loop-20261109) proves every file opens and invents nothing; this measures how every file LOOKS.
// scripts/resume-design-loop.ts prints every case of scripts/resume-loop.ts to PNG (poppler), prints each Word copy with
// LibreOffice, and checks all 162 files against APP-LAYER-15-FIXES A.4 and E.1 and RESUME-TEMPLATES E5: one page, the name
// on top and largest, the target-relevant line in the top half, body type >= 10 pt, no overflow or text over text, one
// date style aligned, newest entry first, the text a parser reads in the page's order (pdfminer, PDFium, the DOCX paragraphs; poppler's default mode reported), and a Word copy that prints like
// the PDF. The bar: 162/162 on every check. Offline and free. CI installs poppler, pdfminer.six, Pillow and LibreOffice.
// deno-lint-ignore-file no-explicit-any
import { CHECKS, checkOne, runDesign } from "../../scripts/resume-design-loop.ts";
import { entryStart, newestFirst } from "../../supabase/functions/_shared/career_resume_design.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const CI = Deno.env.get("CI") === "true";

async function toolsReady(): Promise<string | null> {
  const py = await new Deno.Command("python3", { args: ["-I", "-c", "import pdfminer, PIL, pypdfium2; import shutil, sys; sys.exit(0 if shutil.which('pdftotext') and shutil.which('pdftoppm') else 3)"], stdout: "null", stderr: "null" }).output().catch(() => null);
  const lo = await new Deno.Command(Deno.env.get("SOFFICE") ?? "soffice", { args: ["--version"], stdout: "null", stderr: "null" }).output().catch(() => null);
  return py?.success && lo?.success ? null : "poppler (pdftotext, pdftoppm), pdfminer.six, pypdfium2, Pillow and LibreOffice (soffice) are needed";
}

// A page as the measure script reports it, built by hand: name, contact, a heading, two dated entries with a bullet each.
function page(over: Partial<Record<string, any>> = {}): any {
  const L = (text: string, top: number, size = 11, x0 = 54, x1 = 300, bold = 0, bold0 = false) => ({ page: 1, text, x0, x1, top, bottom: top + size, size, min: size, bold, bold0 });
  const lines = over.lines ?? [
    L("Pat Example", 50, 16, 54, 160, 1, true), L("pat@example.test | Austin, TX", 72),
    L("EXPERIENCE", 100, 11, 54, 130, 1, true),
    L("Analyst, TEST Co, March 2021 - Present", 120, 11, 54, 330, 1, true), L("• Built SQL reports for 3 teams", 134),
    L("Clerk, TEST Shop, June 2018 - February 2021", 150, 11, 54, 340, 1, true), L("• Kept the ledger", 164),
  ];
  const text = lines.map((l: any) => l.text).join("\n");
  return { pages: [{ w: 612, h: 792 }], lines, overlaps: 0, ink: [{ empty: false, edge: false, left: 54, top: 50, right: 200, bottom: 600 }], text_poppler: text, text_pdfminer: text, text_pdfium: text, ...over };
}
const ctx = { promised: 1, name: "Pat Example", email: "pat@example.test", proven: ["SQL"], listed: [] as string[] };

Deno.test("resume design/1 the checks pass a clean page and catch each defect they name", () => {
  const ok = checkOne(page(), page(), ctx);
  assert(CHECKS.every((k) => ok.checks[k]), JSON.stringify(ok));
  const fail = (m: any, twin: any, k: string, c = ctx) => { const r = checkOne(m, twin, c); assert(!(r.checks as any)[k], `${k} should fail: ${JSON.stringify(r.notes)}`); };
  fail(page({ pages: [{ w: 612, h: 792 }, { w: 612, h: 792 }] }), page(), "onePage");
  const base = page().lines;
  fail(page({ lines: [{ ...base[0], size: 11, min: 11 }, ...base.slice(1)] }), page(), "identity");
  fail(page({ lines: base.map((l: any) => l.text.startsWith("•") ? { ...l, min: 7, size: 7 } : l) }), page(), "readable");
  fail(page({ overlaps: 1 }), page(), "noOverflow");
  fail(page({ ink: [{ empty: false, edge: true, left: 0, top: 50, right: 0, bottom: 600 }] }), page(), "noOverflow");
  fail(page({ lines: base.map((l: any) => l.text.startsWith("Clerk") ? { ...l, text: "Clerk, TEST Shop, Jun 2018 - Feb 2021" } : l) }), page(), "dates");
  const swapped = [...base.slice(0, 3), base[5], base[6], base[3], base[4]].map((l: any, i: number) => ({ ...l, top: [50, 72, 100, 120, 134, 150, 164][i] }));
  const sw = page({ lines: swapped });
  fail(sw, sw, "chronology");
  fail(page({ text_pdfminer: "Pat Example\nEXPERIENCE\npat@example.test | Austin, TX" }), page(), "atsOrder");
  fail(page({ text_pdfium: "Pat Example\nEXPERIENCE\npat@example.test | Austin, TX" }), page(), "atsOrder");
  fail(page(), page({ pages: [{ w: 612, h: 792 }, { w: 612, h: 792 }] }), "docxLikePdf");
  fail(page(), page({ lines: base.map((l: any) => l.text === "EXPERIENCE" ? { ...l, top: 160 } : l) }), "docxLikePdf");
  const low = page({ lines: base.map((l: any) => l.text.includes("SQL") ? { ...l, top: 500 } : l) });
  fail(low, low, "target");
});

Deno.test("resume design/2 entries go newest first within a dated section; lines are moved whole, never changed", () => {
  assert(entryStart("Analyst, TEST Co, March 2021 - Present") === 2021 * 12 + 3, "month and year");
  assert(entryStart("TEST College - B.A. Mathematics, 2016") === 2016 * 12, "a year alone");
  assert(entryStart("Ridership Dashboard (TEST project)") === null, "no date");
  const e = (text: string, id: string) => ({ text, type: "entry", factIds: [id] }), b = (text: string, id: string) => ({ text, type: "bullet", factIds: [id] });
  const resume = { header: { name: "Pat" }, sections: [
    { heading: "Experience", lines: [e("Senior, TEST A, January 2014 - February 2019", "a"), b("Built A", "a"), e("Staff, TEST B, March 2019 - Present", "b"), b("Led B", "b")] },
    { heading: "Projects", lines: [e("Undated, TEST P", "p"), e("Dated, TEST Q, 2020", "q")] },
  ] };
  const out = newestFirst(resume);
  assert(out.sections[0].lines.map((l: any) => l.text).join("|") === "Staff, TEST B, March 2019 - Present|Led B|Senior, TEST A, January 2014 - February 2019|Built A", JSON.stringify(out.sections[0].lines));
  assert(out.sections[1] === resume.sections[1], "a section with an undated entry is left as it is");
  const before = resume.sections.flatMap((s) => s.lines.map((l) => l.text)).sort(), after = out.sections.flatMap((s: any) => s.lines.map((l: any) => l.text)).sort();
  assert(JSON.stringify(before) === JSON.stringify(after), "the same lines, only moved");
  assert(newestFirst(out) === out, "already in order: unchanged");
});

Deno.test("resume design/3 every TEST profile x role x layout, PDF and DOCX, printed and measured: 162/162 on every check", async () => {
  const why = await toolsReady();
  if (why) { if (CI) throw new Error(why); console.log(`NOT_RUN locally: ${why}`); return; }
  const out = await Deno.makeTempDir({ prefix: "resume-design-" });
  try {
    const r = await runDesign({ out });
    console.log(r.line);
    assert(r.files.length === 162, `162 files, not ${r.files.length}`);
    const bad = r.files.filter((f) => CHECKS.some((k) => !f.checks[k])).map((f) => `${f.id} ${f.kind}: ${f.notes.join("; ")}`);
    assert(!bad.length, `${bad.length} files below the bar:\n${bad.slice(0, 12).join("\n")}`);
  } finally { await Deno.remove(out, { recursive: true }); }
});
