// RELEASE 9 workstream B (resume design): two layouts ("trainee" and "own"), each a PDF and a DOCX with the same words in the
// same order, fitted to one or two pages at 10 pt or more, checked by 148's two parsers per format (and LibreOffice where it is
// installed); the gap analysis (missing, weak, emphasise) from confirmed facts only; the router's employer copy in the Trainee
// layout. Offline: everything renders in this process.
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CareerProfile, CareerRender, CareerTailor } from "../../supabase/functions/_shared/router_core.career.js";
import { FIT_STEPS, fit, MIN_BODY_PT, ownDocx, renderDesigned, sameText, splitDates, TRAINEE_PALETTE, traineeBlocks, widthPt } from "../../supabase/functions/_shared/career_resume_design.ts";
import { gapAnalysis, previewText } from "../../supabase/functions/_shared/career_resume_gaps.ts";
import { confirmedOnly, edgeRenderer, memoryResumeStore, submissionResume, tailorForPosting } from "../../supabase/functions/_shared/career_tailor.ts";
import { employerFiles } from "../../supabase/functions/_shared/career_tailor_rewrite.ts";
import { LIGHT, PLUM } from "../../supabase/functions/_shared/brand.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }

const R = (CareerRender as any).withRuntime({ zlib, crypto, Buffer });
const NOW = Date.UTC(2026, 10, 7, 15);
const USER = "00000000-0000-4000-8000-0000000009b1";
const RESUME_TEXT = await Deno.readTextFile(new URL("../../packages/career-data/fixtures/test-resume.txt", import.meta.url));
function fixtureProfile() {
  const p = CareerProfile.createProfile({ basics: { name: "Alex Testcase", email: "alex.testcase@example.test", location: "Chicago, IL" } });
  const r = CareerProfile.ingestResume(p, { text: RESUME_TEXT, fileName: "test-resume.txt" });
  assert(r.ok && r.drafts.length > 5, "the fixture resume ingests");
  for (const f of p.facts) CareerProfile.confirmFact(p, f.id);
  return p;
}
const DATA_POSTING = `Data Analyst, Acme Analytics (TEST posting)
Requirements:
- Experience with SQL and PostgreSQL, Python, and Tableau
- Build dashboards for internal users
Nice to have: React, Kubernetes`;
const fixtureDoc = () => { const p = confirmedOnly(fixtureProfile()); return submissionResume(CareerTailor.tailorResume(p, CareerTailor.parseJD(DATA_POSTING), {}).resume); };
const words = (lines: string[]) => lines.join(" ").replace(/•/g, " ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");
const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
// The content stream ops of every page, inflated.
function ops(pdf: Uint8Array): string {
  const s = Buffer.from(pdf).toString("latin1"), out: string[] = [];
  for (const m of s.matchAll(/stream\n([\s\S]*?)\nendstream/g)) out.push(zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"));
  return out.join("\n");
}
const rgbOf = (hex: string) => [1, 3, 5].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1000) / 1000).join(" ");
// A synthetic record of n entries with 3 bullets each, for page fit (rendered directly: the fit is the renderer's).
function longDoc(n: number) {
  const lines: any[] = [];
  for (let i = 1; i <= n; i++) {
    lines.push({ text: `Analyst ${i}, Example Firm ${i} (TEST), 20${10 + (i % 10)}–20${11 + (i % 10)}`, type: "entry", factIds: [`F-${i}`] });
    for (let k = 1; k <= 3; k++) lines.push({ text: `Built reporting pipeline number ${k} for team ${i} in Python and SQL, used weekly by analysts across three offices`, type: "bullet", factIds: [`F-${i}`] });
  }
  return { header: { name: "Alex Testcase", email: "alex.testcase@example.test", location: "Chicago, IL" }, sections: [{ heading: "Experience", lines }], lines: lines.map((l) => ({ ...l, section: "Experience" })) };
}

// ------------------------------------------------------------------------------------------------ (a) Trainee layout
Deno.test("design/1 Trainee layout: PDF and DOCX pass both parsers, carry the same words in order, one page, standard fonts at 10-12 pt", () => {
  const doc = fixtureDoc();
  const d = renderDesigned(R, doc, { layout: "trainee" });
  assert(d.ok, JSON.stringify(d));
  eq(d.parseCheck.fails, [], "no parse-check failure");
  eq(d.parseCheck.status, "PASS");
  assert(d.sameText, "the PDF and the DOCX read back to the same words in the same order");
  eq(words(R.extractPdfLines(Buffer.from(d.pdf))), words((R.sourceLines(doc) as any[]).map((l) => l.text)), "the PDF carries exactly the source's words");
  eq(words(R.extractDocxLines(Buffer.from(d.docx))), words(R.extractDocxRuns(Buffer.from(d.docx))), "DOCX: the two parsers agree");
  eq(words(R.extractPdfLines(Buffer.from(d.pdf))), words(R.extractPdfStrings(Buffer.from(d.pdf))), "PDF: the two parsers agree");
  eq([d.fit.pages, d.fit.body, d.fit.scale, d.fit.over], [1, 10.5, 1, false], "a short record fits one page at the loosest step");
  const check = R.parseCheck({ resume: doc, pdf: Buffer.from(d.pdf) }, { expected: { pdf: fit(traineeBlocks(doc), TRAINEE_PALETTE).set.printed } });
  eq(check.checks.pdf.fonts.sort(), ["Helvetica", "Helvetica-Bold", "Times-Bold"], "standard faces only (R6)");
  assert(check.checks.pdf.fontSizesPt.every((s: number) => s >= MIN_BODY_PT && s <= 12), `sizes ${check.checks.pdf.fontSizesPt}`);
  assert(check.checks.pdf.singleColumn && check.checks.pdf.rightAlignedDates >= 2, "one column; the dates sit flush right on their entries' lines");
  // The DOCX names the brand faces, with standard fallbacks for a reader that has neither.
  const styles = Buffer.from(R.docxPart(Buffer.from(d.docx), "word/styles.xml")).toString("utf8"), fonts = Buffer.from(R.docxPart(Buffer.from(d.docx), "word/fontTable.xml")).toString("utf8");
  assert(/w:ascii="Inter"/.test(styles) && /w:ascii="Brygada 1918"/.test(styles), "Inter for text, Brygada 1918 for the name");
  assert(/<w:font w:name="Inter"><w:altName w:val="Arial"\/>/.test(fonts) && /<w:font w:name="Brygada 1918"><w:altName w:val="Georgia"\/>/.test(fonts), "named fallbacks");
  assert([...styles.matchAll(/<w:sz w:val="(\d+)"/g)].every((m) => +m[1] >= 20 && +m[1] <= 24), "DOCX sizes 10-12 pt");
});

Deno.test("design/2 plum only for the name, the headings and the rules; no new hue; dates flush right; one vertical rhythm", () => {
  const doc = fixtureDoc();
  const d = renderDesigned(R, doc, { layout: "trainee" });
  assert(d.ok);
  const o = ops(d.pdf), plum = rgbOf(PLUM);
  const colours = new Set([...o.matchAll(/([\d.]+ [\d.]+ [\d.]+) (?:rg|RG)/g)].map((m) => m[1]));
  eq([...colours].sort(), [rgbOf(LIGHT.ink), rgbOf(LIGHT.mute), plum].sort(), "ink, muted ink and plum: the brand's own colours");
  const plumText = [...o.matchAll(/BT \/(F\d) [\d.]+ Tf ([\d.]+ [\d.]+ [\d.]+) rg 1 0 0 1 [\d.]+ [\d.]+ Tm \(([^)]*)\) Tj ET/g)].filter((m) => m[2] === plum).map((m) => m[3]);
  const headings = doc.sections.map((s: any) => String(s.heading).toUpperCase());
  eq(plumText, [doc.header.name, ...headings], "plum text is the name and each heading, nothing else");
  eq((o.match(/ RG /g) || []).length, headings.length + 1, "one rule under the header and one under each heading");
  // Every date run ends exactly at the right margin.
  const runs = [...o.matchAll(/BT \/F1 ([\d.]+) Tf [\d. ]+ rg 1 0 0 1 ([\d.]+) ([\d.]+) Tm \(([^)]*)\) Tj ET/g)].map((m) => ({ size: +m[1], x: +m[2], y: +m[3], text: m[4] }));
  const dates = runs.filter((r) => r.x > 100);
  assert(dates.length >= 2, "dates found");
  for (const r of dates) assert(Math.abs(r.x + widthPt(r.text, "F1", r.size) - 558) < 0.05, `"${r.text}" ends at the right margin`);
  // Baselines: every gap between two lines is a whole number of half-lines (the rhythm), after the name.
  const ys = [...new Set([...o.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/g)].map((m) => +m[1]))].sort((a, b) => b - a).slice(1);
  const unit = Math.round(d.fit.body * 1.3 * 2) / 2 / 2;
  for (let i = 1; i < ys.length; i++) {
    const k = (ys[i - 1] - ys[i]) / (unit * d.fit.scale);
    assert(Math.abs(k - Math.round(k)) < 0.02, `gap ${ys[i - 1] - ys[i]} pt is ${k.toFixed(2)} half-lines`);
  }
});

Deno.test("design/3 snapshot: the fixture renders the same bytes every time, and these printed lines", () => {
  const doc = fixtureDoc();
  const a = renderDesigned(R, doc, { layout: "trainee" }), b = renderDesigned(R, doc, { layout: "trainee" });
  assert(a.ok && b.ok);
  eq([sha(a.pdf), sha(a.docx)], [sha(b.pdf), sha(b.docx)], "deterministic");
  // The layout itself, pinned independent of the deflate codec: the PDF's drawing operators and the DOCX's document and
  // styles parts. A change to spacing, position, size, colour or wording changes these and must be reviewed as a design change.
  const part = (n: string) => Buffer.from(R.docxPart(Buffer.from(a.docx), n)).toString("utf8");
  const h = (x: string) => crypto.createHash("sha256").update(x).digest("hex");
  eq([h(ops(a.pdf)), h(part("word/document.xml")), h(part("word/styles.xml"))], [
    // Architect design amendment 2026-11-10 (#673, D-007 confirmed skills): the Skills line's order moved; nothing else.
    // Architect amendment (owner decision 2026-11-13, D-078: confirm before compare): Statistics, Probability, Data Structures
    // and Algorithms were read from the coursework line, never stated as skills, so they wait for the person's yes; the Skills
    // line is shorter and nothing else moved (styles.xml is unchanged).
    "accab43e3461efa6577cef432452377d706e5b4816e0736131f14cfeb00e67e5",
    "d896f1c957f23b169e8e1c8bc3e8e932395ed71a5ee7abda987781a2af17e336",
    "f38c7e3b4664373bf51bc36dc19e2b3f9b4895497f133c0f096a5f760358a35d",
  ], "the layout snapshot");
  eq(a.lines, [
    "Alex Testcase", "alex.testcase@example.test | Chicago, IL", "SKILLS", "Python, React, Kubernetes, PostgreSQL", // Architect amendment (D-078): was "Python, React, Kubernetes, PostgreSQL, Statistics, Probability, Data Structures, Algorithms"
    "PROJECTS", "DeployBoard (TEST project)", "• Built DeployBoard in Go to deploy containerised apps on Kubernetes, deployed on AWS EKS for 12 student teams",
    "EXPERIENCE", "Software Engineering Intern, TEST Systems Inc, June 2025 - August 2025",
    "• Built a reporting dashboard in React and Python used by 200 internal users",
    "• Cut weekly reporting time by 40% by automating data pulls from PostgreSQL",
    "EDUCATION", "TEST University - B.S. Computer Science, GPA 3.7, graduating May 2028",
    "• Coursework: Data Structures, Algorithms, Databases, Probability and Statistics, Corporate Finance",
    "LEADERSHIP", "President, TEST University Investing Club, September 2025 - May 2026",
    "• Led TEST University Investing Club of 45 members; organised a stock-pitch competition with 20 participants",
  ], "the printed lines (DOCX paragraphs)");
});

Deno.test("design/4 page fit: one page when it fits, else two, tightening in fixed steps; never under 10 pt; more than two is said, not cut", () => {
  eq(FIT_STEPS.every(([pt]) => pt >= MIN_BODY_PT), true);
  for (const [n, pages] of [[3, 1], [9, 1], [16, 2]] as const) {
    const d = renderDesigned(R, longDoc(n), { layout: "trainee" });
    assert(d.ok && d.fit.pages === pages && !d.fit.over && d.fit.body >= MIN_BODY_PT, `${n} entries: ${JSON.stringify(d.ok && d.fit)}`);
    assert(d.sameText && d.parseCheck.status !== "FAIL", `${n} entries: ${JSON.stringify(d.ok && d.parseCheck)}`);
  }
  const tight = renderDesigned(R, longDoc(9), { layout: "trainee" });
  assert(tight.ok && (tight.fit.scale < 1 || tight.fit.body < 10.5 || tight.fit.target === 2), "a longer record is tightened or set on two pages");
  const big = renderDesigned(R, longDoc(30), { layout: "trainee" });
  assert(big.ok && big.fit.over && big.fit.pages > 2 && big.fit.body === MIN_BODY_PT, JSON.stringify(big.ok && big.fit));
  assert(big.parseCheck.warnings.some((w) => /^page_fit/.test(w)), "said");
  eq(words(R.extractPdfLines(Buffer.from(big.pdf))), words((R.sourceLines(longDoc(30)) as any[]).map((l) => l.text)), "nothing was cut");
  // An entry heading never ends a page alone: its first bullet is on the same page.
  for (const n of [9, 16, 30]) {
    const set = fit(traineeBlocks(longDoc(n)), TRAINEE_PALETTE).set;
    for (const pg of set.pages) { const last = pg.runs[pg.runs.length - 1]; assert(!/^Analyst \d+/.test(last.text), `page ends on an entry: ${last.text}`); }
  }
});

Deno.test("design/5 the parse-check stays strict: a layout's lines must be the source's words; a second column or a dropped line fails", () => {
  const doc = fixtureDoc();
  const d = renderDesigned(R, doc, { layout: "trainee" });
  assert(d.ok);
  const printed = fit(traineeBlocks(doc), TRAINEE_PALETTE).set.printed;
  const added = R.parseCheck({ resume: doc, pdf: Buffer.from(d.pdf) }, { expected: { pdf: [...printed, "Tableau expert"] } });
  assert(added.reasons.some((r: any) => r.check === "layout_text" && r.level === "fail"), "a word the source does not have fails");
  // The DOCX with a paragraph dropped: the check fails and the two files no longer read the same.
  const xml = Buffer.from(R.docxPart(Buffer.from(d.docx), "word/document.xml")).toString("utf8");
  const cut = R.rebuildDocx(Buffer.from(d.docx), { "word/document.xml": xml.replace(/<w:p><w:pPr><w:pStyle w:val="TraineeBullet"\/>[\s\S]*?<\/w:p>/, "") });
  eq(sameText(R, d.pdf, new Uint8Array(cut)), false);
  assert(R.parseCheck({ resume: doc, docx: cut }, { expected: { docx: d.lines } }).reasons.some((r: any) => r.check === "missing_content"), "the dropped line is missing");
  // A run past x 100 that is not a date on an entry's line is a second column.
  const two = Buffer.from(ops(d.pdf).replace(/1 0 0 1 54 ([\d.]+) Tm \(Python, React/, "1 0 0 1 320 $1 Tm (Python, React"));
  const s = Buffer.from(d.pdf).toString("latin1"), body = zlib.deflateSync(two);
  const swapped = Buffer.from(s.replace(/<< \/Length \d+ \/Filter \/FlateDecode >>\nstream\n[\s\S]*?\nendstream/, `<< /Length ${body.length} /Filter /FlateDecode >>\nstream\n${body.toString("latin1")}\nendstream`), "latin1");
  assert(!R.parseCheck({ resume: doc, pdf: swapped }).checks.pdf.singleColumn, "not one column");
  eq(splitDates("Analyst, Acme, Jun 2022 – Present"), { text: "Analyst, Acme,", right: "Jun 2022 – Present" });
  eq(splitDates("Analyst, Acme 2022 Report"), { text: "Analyst, Acme 2022 Report" }, "a year inside the title is not a date range");
});

// ------------------------------------------------------------------------------------------------ (b) Keep my layout
const OWN_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Garamond" w:hAnsi="Garamond"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="MySection"><w:name w:val="heading 2"/><w:rPr><w:b/><w:color w:val="1F3864"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style></w:styles>`;
const P = (style: string | null, text: string, rpr = "") => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/>${style === "ListParagraph" ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>` : ""}</w:pPr>` : ""}<w:r>${rpr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
function ownFixture(): Uint8Array {
  const body = [
    P("Title", "Alex Testcase"), P(null, "alex.testcase@example.test | Chicago, IL"), P("MySection", "Work History"),
    P(null, "Software Engineering Intern, TEST Systems Inc, June 2025 - August 2025", "<w:rPr><w:b/></w:rPr>"),
    // A bullet split over two runs, as Word writes one after an edit: both runs' words are matched.
    `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="40"/></w:pPr><w:r><w:rPr><w:i/><w:sz w:val="21"/></w:rPr><w:t xml:space="preserve">Built a reporting dashboard in React </w:t></w:r><w:r><w:rPr><w:sz w:val="21"/></w:rPr><w:t>and Python used by 200 internal users</w:t></w:r></w:p>`,
    P("ListParagraph", "Cut weekly reporting time by 40% by automating data pulls from PostgreSQL", `<w:rPr><w:sz w:val="21"/></w:rPr>`),
    P("MySection", "Skills"), P(null, "Python, JavaScript, React, PostgreSQL"),
  ].join("");
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`;
  return new Uint8Array(R.primitives.zipBuffer([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/_rels/document.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "word/document.xml", data: doc }, { name: "word/styles.xml", data: OWN_STYLES },
  ]));
}
const SWAPS = [
  { before: "Built a reporting dashboard in React and Python used by 200 internal users", after: "Built a React and Python reporting dashboard used by 200 internal users" },
  { before: "Led a team that is not in this file", after: "anything" },
];

Deno.test("design/6 keep my layout: the tailored bullet goes into their own paragraph; their styles, fonts and every other line stay byte for byte", () => {
  const original = ownFixture();
  const o = ownDocx(R, original, SWAPS);
  assert(o.ok);
  eq([o.replaced, o.missing], [1, ["Led a team that is not in this file"]], "one placed; the one not in the file is said, never put elsewhere");
  const part = (b: Uint8Array, n: string) => Buffer.from(R.docxPart(Buffer.from(b), n)).toString("utf8");
  eq(part(o.buffer, "word/styles.xml"), part(original, "word/styles.xml"), "their styles and fonts, untouched");
  const before = part(original, "word/document.xml").match(/<w:p>[\s\S]*?<\/w:p>/g)!, after = part(o.buffer, "word/document.xml").match(/<w:p>[\s\S]*?<\/w:p>/g)!;
  eq(after.length, before.length, "no paragraph added or removed");
  const changed = after.map((p, i) => (p === before[i] ? null : i)).filter((i) => i !== null);
  eq(changed, [4], "only the reworded bullet's paragraph changed");
  assert(after[4].includes(`<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="40"/>`), "its own list style, numbering and spacing");
  assert(after[4].includes(`<w:rPr><w:i/><w:sz w:val="21"/></w:rPr><w:t xml:space="preserve">Built a React and Python reporting dashboard used by 200 internal users</w:t>`), "its first run's formatting, the new words");
  const d = renderDesigned(R, {}, { layout: "own", ownDocx: original, swaps: SWAPS });
  assert(d.ok, JSON.stringify(d));
  assert(d.sameText, "the PDF carries the DOCX's words in the DOCX's order");
  eq(d.parseCheck.fails, [], "both parsers per format agree with their paragraphs");
  eq(d.lines.slice(0, 3), ["Alex Testcase", "alex.testcase@example.test | Chicago, IL", "Work History"], "their own heading words, as they wrote them");
  const o2 = ops(d.pdf);
  assert(!o2.includes(rgbOf(PLUM)), "their layout's PDF carries no Trainee plum");
  const none = renderDesigned(R, {}, { layout: "own", ownDocx: null });
  assert(!none.ok && /Word file/.test(none.reason), "no Word file on record: refused with the reason");
});

// ------------------------------------------------------------------------------------------------ LibreOffice, where installed
Deno.test({ name: "design/7 LibreOffice opens both DOCX layouts and prints the same words on one or two pages", sanitizeResources: false, sanitizeOps: false, async fn() {
  const which = await new Deno.Command("which", { args: ["soffice"] }).output();
  if (!which.success) { console.log("NOT_RUN: soffice is not installed here"); return; }
  const dir = await Deno.makeTempDir();
  try {
    const trainee = renderDesigned(R, fixtureDoc(), { layout: "trainee" }), own = renderDesigned(R, {}, { layout: "own", ownDocx: ownFixture(), swaps: SWAPS });
    assert(trainee.ok && own.ok);
    for (const [name, d] of [["trainee", trainee], ["own", own]] as const) {
      await Deno.writeFile(`${dir}/${name}.docx`, d.docx);
      const r = await new Deno.Command("soffice", { args: ["--headless", `-env:UserInstallation=file://${dir}/profile`, "--convert-to", "pdf", "--outdir", dir, `${dir}/${name}.docx`], stdout: "null", stderr: "null" }).output();
      assert(r.success, `soffice converted ${name}`);
      const pdf = await Deno.readFile(`${dir}/${name}.pdf`);
      const pages = (Buffer.from(pdf).toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
      assert(pages >= 1 && pages <= 2, `${name}: ${pages} pages in LibreOffice`);
      // Read with poppler (LibreOffice embeds its fonts; 148's in-repo scan is for the files Trainee writes).
      const pt = await new Deno.Command("pdftotext", { args: [`${dir}/${name}.pdf`, "-"], stdout: "piped", stderr: "null" }).output().catch(() => null);
      if (!pt?.success) { console.log("NOT_RUN: pdftotext is not installed here; the page count was checked"); continue; }
      eq(words([new TextDecoder().decode(pt.stdout)]), words(R.extractDocxLines(Buffer.from(d.docx))), `${name}: LibreOffice's PDF carries the DOCX's words in order`);
    }
  } finally { await Deno.remove(dir, { recursive: true }); }
} });

// ------------------------------------------------------------------------------------------------ gap analysis
Deno.test("design/8 gap analysis: missing, weak, emphasise, from the posting's own words and confirmed facts only", () => {
  const profile = confirmedOnly(fixtureProfile());
  const jd = CareerTailor.parseJD(DATA_POSTING);
  const t = CareerTailor.tailorResume(profile, jd, {});
  const doc = submissionResume(t.resume);
  const g = gapAnalysis({ jd, profile, doc, gaps: t.gaps });
  const asked = new Set([...jd.mustHaveSkills, ...jd.niceToHaveSkills].map((s: string) => s.toLowerCase()));
  console.log(`  gap summary:\n${g.summary}`);
  assert(g.missing.some((m) => m.name === "Tableau" && m.required), "Tableau: asked for, nothing confirmed shows it");
  assert(g.emphasise.some((e) => e.name === "Python" && /Python/.test(e.line)), "Python is shown in a printed bullet");
  assert(g.weak.every((w) => !g.emphasise.some((e) => e.name === w.name)) && g.missing.every((m) => !g.emphasise.some((e) => e.name === m.name)), "each ask in one group");
  for (const n of [...g.weak, ...g.emphasise].map((x) => x.name)) assert(asked.has(n.toLowerCase()), `"${n}" is the posting's own word`);
  const printed = new Set((doc.lines as any[]).map((l) => String(l.text).slice(0, 89)));
  for (const e of g.emphasise) assert([...printed].some((p) => p.startsWith(e.line.replace(/…$/, ""))), `the quoted line is printed: ${e.line}`);
  for (const m of g.missing) assert(!` ${words((doc.lines as any[]).map((l) => l.text))} `.includes(` ${words([m.name])} `), `${m.name} is not on the resume`);
  assert(/Not on your record: .*Tableau/.test(g.summary) && !/Snowflake/.test(g.summary), "the summary says only what the posting asked");
  eq(previewText(["Alex Testcase", "•", "a", "b"], 2), "Alex Testcase\na\n(1 more lines)");
});

// ------------------------------------------------------------------------------------------------ through the tailor and the employer copy
Deno.test("design/9 tailor_resume with a layout: the Trainee file is stored and linked, the gap summary and preview come first; 'own' without a Word file refuses", async () => {
  const profile = fixtureProfile(), store = memoryResumeStore();
  const out = await tailorForPosting({ userId: USER, profile, posting: { text: DATA_POSTING }, deps: { render: edgeRenderer(), resumes: store }, now: NOW, layout: "trainee" });
  assert(out.ok, JSON.stringify(out));
  eq([out.layout, out.fit?.pages, out.ats.status], ["trainee", 1, "PASS"]);
  assert(out.detail.docx && out.detail.docx.length > 1000, "the DOCX rides beside the stored PDF");
  assert(/Not on your record: .*Tableau/.test(out.gaps.summary) && out.preview.startsWith("Alex Testcase\nalex.testcase@example.test"), out.preview);
  const pdf = store.files.get(`career-resumes/${USER}/${out.sha256}.pdf`)!;
  assert(sameText(R, pdf, out.detail.docx!), "the stored PDF and its DOCX read the same");
  const plain = await tailorForPosting({ userId: USER, profile, posting: { text: DATA_POSTING }, deps: { render: edgeRenderer(), resumes: store }, now: NOW });
  assert(plain.ok && plain.layout === "plain" && plain.sha256 !== out.sha256 && /Not on your record/.test(plain.gaps.summary), "no layout asked: WO-028's file, with the same gap summary");
  const own = await tailorForPosting({ userId: USER, profile, posting: { text: DATA_POSTING }, deps: { render: edgeRenderer(), resumes: store }, now: NOW, layout: "own", ownDocx: null });
  assert(!own.ok && own.refused === "render" && /Word file/.test(own.reason), JSON.stringify(own));
  const mine = await tailorForPosting({ userId: USER, profile, posting: { text: DATA_POSTING }, deps: { render: edgeRenderer(), resumes: store }, now: NOW, layout: "own", ownDocx: ownFixture(), swaps: SWAPS });
  assert(mine.ok && mine.layout === "own" && mine.own_layout?.replaced === 1, JSON.stringify(mine.ok ? mine.own_layout : mine));
});

Deno.test("design/10 the router's employer copy goes out in the Trainee layout: the same names, the DOCX lines in the PDF's order", () => {
  const p = fixtureProfile();
  const t = CareerTailor.tailorResume(p, CareerTailor.parseJD(DATA_POSTING), { company: "Acme" });
  const res: any = { artifact: { kind: "tailored_resume", company: "Acme", pdf: { base64: "cm91dGVy", filename: "Resume_Resume.pdf" } }, tailorDoc: t.resume };
  assert(employerFiles(res, t.resume, p));
  eq([res.artifact.layout, res.artifact.pdf.filename, res.artifact.docx.filename, res.artifact.fit.pages], ["trainee", "Alex_Testcase_Resume.pdf", "Alex_Testcase_Resume.docx", 1]);
  const pdf = Buffer.from(res.artifact.pdf.base64, "base64"), docx = Buffer.from(res.artifact.docx.base64, "base64");
  eq(res.artifact.pdf.sha256, sha(pdf), "the recorded hash is the bytes'");
  const pdfText = (R.extractPdfLines(pdf) as string[]).join(" ").replace(/\s+/g, " ");
  let at = 0;
  for (const l of (R.extractDocxLines(docx) as string[]).map((x) => x.replace(/\s+/g, " ").trim().replace(/^•\s*/, "")).filter(Boolean)) {
    const i = pdfText.indexOf(l, at);
    assert(i >= 0, `the PDF carries "${l}" in the DOCX's order`);
    at = i + l.length;
  }
  assert(!/Eligibility verdict/.test(pdfText), "no internal note is printed");
  assert(ops(new Uint8Array(pdf)).includes(rgbOf(PLUM)), "the Trainee design");
});

// ------------------------------------------------------------------------------------------------ e2e eval findings (PR #591)
Deno.test("design/11 'tailor my resume ... and send it back' is the file returned here, never a campaign send", async () => {
  const { CareerRouter } = await import("../../supabase/functions/_shared/router_core.career.js");
  for (const m of ["tailor my resume for the Data Analyst role at Stripe and send it back", "tailor my resume for the Mosaic and Nimbus roles and send both back", "tailor my resume for the Kite role and send them back"]) {
    const ctx: any = { profile: fixtureProfile(), now: NOW, thread: {} };
    const r = CareerRouter.handleChat(m, ctx);
    // Never the outreach wave gate; with no posting list in this test the tailor asks for one (or searches for two).
    assert(r && !/^outreach/.test(r.intent) && /tailor|discovery/.test(r.intent), `${m} -> ${r?.intent}`);
  }
  const outreach = CareerRouter.handleChat("send it to the recruiter at Stripe", { profile: fixtureProfile(), now: NOW, thread: {} } as any);
  assert(!/tailor/.test(String(outreach?.intent)), "a send to someone else is not a delivery to the person");
});

Deno.test("design/12 the resume header: shown word for word with the entries, confirmed by the same yes, printed on the file", async () => {
  const { CareerRouter } = await import("../../supabase/functions/_shared/router_core.career.js");
  const ctx: any = { now: NOW, thread: {} };
  const shown = CareerRouter.handleChat(`here is my resume:\n${RESUME_TEXT}`, ctx);
  assert(/At the top: Alex Testcase \(TEST\) \| Chicago, IL \(TEST\) \| alex\.testcase@example\.test \| \+1 555-0100 \(TEST\) \| GitHub: https:\/\/github\.com\/example-testcase \(TEST\)/.test(shown.reply), shown.reply);
  eq(ctx.profile.resume_header, undefined, "nothing is recorded before the yes");
  CareerRouter.handleChat("yes, that's my resume", ctx);
  eq([ctx.profile.resume_header?.name, ctx.profile.resume_header?.contactLine, ctx.profile.basics?.name ?? null], ["Alex Testcase (TEST)", "Chicago, IL (TEST) | alex.testcase@example.test | +1 555-0100 (TEST)", null], "its own record; the typed name is untouched");
  const t = CareerTailor.tailorResume(ctx.profile, CareerTailor.parseJD(DATA_POSTING), {});
  const doc = submissionResume(t.resume);
  eq([doc.header.name, doc.header.from], ["Alex Testcase (TEST)", "resume"]);
  const d = renderDesigned(R, doc, { layout: "trainee" });
  assert(d.ok && d.parseCheck.status === "PASS", JSON.stringify(d.ok && d.parseCheck));
  const text = (R.extractPdfLines(Buffer.from(d.pdf)) as string[]).join("\n");
  assert(text.includes("Alex Testcase (TEST)") && text.includes("Chicago, IL (TEST) | alex.testcase@example.test | +1 555-0100 (TEST)") && text.includes("GitHub: https://github.com/example-testcase (TEST)"), text);
  // A name typed for the resume wins over the file's header.
  const typed = fixtureProfile();
  typed.resume_header = ctx.profile.resume_header;
  eq(CareerTailor.tailorResume(typed, CareerTailor.parseJD(DATA_POSTING), {}).resume.header.name, "Alex Testcase");
  // No yes, no header: a resume shown and then answered with "no" records nothing.
  const no: any = { now: NOW, thread: {} };
  CareerRouter.handleChat(`here is my resume:\n${RESUME_TEXT}`, no);
  CareerRouter.handleChat("no", no);
  eq(no.profile.resume_header, undefined);
});
