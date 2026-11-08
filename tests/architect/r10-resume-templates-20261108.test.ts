// RELEASE 10 (owner ask 2026-11-08): fifteen resume templates as exact geometry, a format rater for the person's own file, a
// pixel-perfect checker run over every template and a 63-resume synthetic corpus, a real-world round trip through independent
// open-source extractors, and the wiring into tailor_resume ("use template N", "keep mine", the rater's keep rule).
// Offline and free: every file renders in this process; pdf.js (npm, pinned) reads the geometry; Python extractors run where
// installed (CI installs them; a CI run without them fails rather than skips).
// deno-lint-ignore-file no-explicit-any
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CareerProfile, CareerRender } from "../../supabase/functions/_shared/router_core.career.js";
import { fitTemplate, type LibraryId, renderTemplate, reorderSections, TEMPLATE_IDS, templateBlocks, templateDocx, templateId, templatePdf, TEMPLATES, typesetTemplate, unencodable } from "../../supabase/functions/_shared/career_resume_templates.ts";
import { checkTemplatePdf, type PixelRule } from "../../supabase/functions/_shared/career_resume_pixel.ts";
import { HARD, KEEP_MIN, levelOf, ownPdfSpec, pdfNamePt, POINTS, rateResumeFile, recommendTemplate, roleFamily } from "../../supabase/functions/_shared/career_resume_rater.ts";
import { readPdfGeometry, wordsOf } from "../../supabase/functions/_shared/career_resume_geometry.ts";
import { renderDesigned, sameText } from "../../supabase/functions/_shared/career_resume_design.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { edgeRenderer, memoryPersonaStore, memoryResumeStore } from "../../supabase/functions/_shared/career_tailor.ts";
import { memoryVersionLog } from "../../supabase/functions/_shared/career_resume_outcomes.ts";
import { LIGHT, PLUM } from "../../supabase/functions/_shared/brand.ts";
import { corpus } from "../helpers/resume_corpus.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const R = (CareerRender as any).withRuntime({ zlib, crypto, Buffer });
const FIX = new URL("./fixtures/resume-rater/", import.meta.url);
const fixture = (n: string) => Deno.readFile(new URL(n, FIX));
const CI = !!Deno.env.get("CI");
const CORPUS = corpus();
const rgbOf = (hex: string) => [1, 3, 5].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1000) / 1000).join(" ");
function ops(pdf: Uint8Array): string {
  const s = Buffer.from(pdf).toString("latin1"), out: string[] = [];
  for (const m of s.matchAll(/stream\n([\s\S]*?)\nendstream/g)) out.push(zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"));
  return out.join("\n");
}

// ------------------------------------------------------------------------------------------------ the library
Deno.test("r10/1 fifteen templates, each exact geometry inside the evidence's bounds, covering every audience the owner named", () => {
  eq(TEMPLATE_IDS.length, 15);
  const specs = Object.values(TEMPLATES);
  eq(new Set(specs.map((t) => t.name)).size, 15, "fifteen distinct designs");
  for (const t of specs) {
    for (const k of ["top", "right", "bottom", "left"] as const) assert(t.margins[k] >= 36 && t.margins[k] <= 72, `${t.id} ${k} margin ${t.margins[k]} pt is outside 0.5-1 in`);
    assert(t.body >= 10 && t.body <= 12 && t.heading >= 10 && t.heading <= 12, `${t.id}: body and headings 10-12 pt (R6)`);
    assert(t.namePt >= 14 && t.namePt <= 18 && t.namePt > t.heading, `${t.id}: the name 14-18 pt, above the headings (R6 scoped, architect ruling 2026-11-08)`);
    assert(t.bullet.text > t.bullet.x, `${t.id}: a hanging indent`);
    assert(Object.values(t.gaps).every((g) => Number.isInteger(g) && g >= 1), `${t.id}: gaps are whole units of the grid`);
    assert(t.evidence.length >= 2, `${t.id}: names its evidence`);
  }
  const has = (f: (t: typeof specs[number]) => boolean, what: string) => assert(specs.some(f), `no template for ${what}`);
  has((t) => t.levels.includes("student"), "early career / students");
  for (const r of ["engineering", "data", "product_design", "business_finance", "sales_marketing", "research", "career_change", "federal"] as const) has((t) => t.roles.includes(r), r);
  has((t) => t.levels.includes("executive"), "senior / executive");
  has((t) => t.pages === 1, "one page"); has((t) => t.pages === 2, "two pages");
  has((t) => t.face === "serif", "a serif face"); has((t) => t.face === "sans", "a sans face");
  eq(templateId("use template 5"), null, "only the number or T-id parses");
  eq([templateId("5"), templateId("T05"), templateId("t 12"), templateId("16"), templateId("0")], ["T05", "T05", "T12", null, null]);
});

// ------------------------------------------------------------------------------------------------ every template x the corpus
Deno.test("r10/2 every template over the 63-resume corpus: 148's parse-check passes, the PDF and DOCX carry the same words, and the pixel checker passes 100%", async () => {
  assert(CORPUS.length >= 60, "at least 60 resumes");
  const shapes = new Set(CORPUS.map((c) => c.shape));
  for (const s of ["student", "career_change", "senior_two_page", "short", "long_titles"]) assert(shapes.has(s), `the corpus has ${s}`);
  assert(CORPUS.some((c) => /[^\x00-\x7f]/.test(c.expect.name)), "non-ASCII names");
  const jobs = (c: typeof CORPUS[number]) => c.doc.sections.find((s: any) => s.heading === "Experience")?.lines.filter((l: any) => l.type === "entry").length ?? 0;
  eq([...new Set(CORPUS.map(jobs))].sort(), [0, 1, 2, 3, 4], "0 to 4 jobs");
  let n = 0, passed = 0, twoPage = 0;
  const failures: string[] = [];
  for (const c of CORPUS) for (const id of TEMPLATE_IDS) {
    n++;
    const r = renderTemplate(R, c.doc, { template: id });
    if (!r.ok) { failures.push(`${c.id}/${id}: ${r.reason}`); continue; }
    const pc = R.parseCheck({ resume: r.source, pdf: Buffer.from(r.pdf), docx: Buffer.from(r.docx) }, { expected: { pdf: r.printedPdf, docx: r.printedDocx } });
    const pcFails = pc.reasons.filter((x: any) => x.level === "fail");
    if (pcFails.length) failures.push(`${c.id}/${id} parse-check: ${pcFails[0].detail}`);
    if (!sameText(R, r.pdf, r.docx)) failures.push(`${c.id}/${id}: PDF and DOCX words differ`);
    // No word is added: the printed words are the source's (in the template's section order), word for word.
    const src = wordsOf((R.sourceLines(r.source) as any[]).map((l) => l.text)).join(" "), printed = wordsOf(r.printedPdf).join(" ");
    if (src !== printed) failures.push(`${c.id}/${id}: printed words are not the source's`);
    const k = await checkTemplatePdf(r.set.geometry, r.pdf, { R, docx: r.docx });
    if (k.pass && !pcFails.length) passed++; else failures.push(...k.failures.slice(0, 2).map((f) => `${c.id}/${id} ${f.rule}: ${f.detail} [${f.line}]`));
    if (r.fit.pages === 2) twoPage++;
  }
  console.log(`PIXEL CHECK: ${passed}/${n} template renders pass (${CORPUS.length} resumes x 15 templates; ${twoPage} two-page files)`);
  eq(failures.slice(0, 10), [], "no failure");
  eq(passed, n);
  assert(twoPage >= 60, "the corpus exercises two-page fits");
});

Deno.test("r10/3 plum only in Trainee-branded files; neutral templates are ink only; standard faces, never embedded", async () => {
  const doc = CORPUS[4].doc;
  for (const id of TEMPLATE_IDS) {
    const neutral = renderTemplate(R, doc, { template: id }), branded = renderTemplate(R, doc, { template: id, branded: true });
    assert(neutral.ok && branded.ok);
    const n = ops(neutral.pdf), b = ops(branded.pdf);
    assert(!n.includes(`${rgbOf(PLUM)} rg`) && !n.includes(`${rgbOf(PLUM)} RG`), `${id}: no plum in the neutral file`);
    eq([...new Set([...n.matchAll(/([\d.]+ [\d.]+ [\d.]+) r[gG]/g)].map((m) => m[1]))], [rgbOf(LIGHT.ink)], `${id}: the neutral file is ink only`);
    assert(b.includes(`${rgbOf(PLUM)} rg`), `${id}: the branded file uses plum`);
    const docx = Buffer.from(R.docxPart(Buffer.from(neutral.docx), "word/document.xml")).toString("utf8");
    assert(!docx.includes(PLUM.slice(1).toUpperCase()), `${id}: no plum in the neutral DOCX`);
    const g = await readPdfGeometry(neutral.pdf);
    assert(g.fonts.every((f) => !f.embedded && ["Helvetica", "Helvetica-Bold", "Times-Roman", "Times-Bold"].includes(f.name)), `${id}: ${JSON.stringify(g.fonts)}`);
  }
});

// ------------------------------------------------------------------------------------------------ the checker is brutal
Deno.test("r10/4 the checker fails each defect it names: off-grid by 0.6 pt, a moved bullet, a date off the margin, an uneven gap, a widow, an overflow, a foreign font, a DOCX with other words", async () => {
  const c = CORPUS.find((x) => x.shape === "senior_two_page")!, spec = TEMPLATES.T14;
  const blocks = templateBlocks(reorderSections(c.doc, spec.order), spec);
  const base = fitTemplate(blocks, spec, false).set;
  const fresh = () => structuredClone(base);
  const fires = async (rule: PixelRule, mutate: (s: typeof base) => void, docx?: Uint8Array) => {
    const s = fresh(); mutate(s);
    const k = await checkTemplatePdf(s.geometry, templatePdf(R, s), docx ? { R, docx } : {});
    assert(k.failures.some((f) => f.rule === rule), `${rule} did not fire: ${JSON.stringify(k.failures.slice(0, 3))}`);
  };
  const clean = await checkTemplatePdf(base.geometry, templatePdf(R, base), { R, docx: templateDocx(R, blocks, spec, base).buffer });
  eq(clean.failures, [], "the unmutated file passes");
  const bulletLine = (s: typeof base) => s.lines.find((l) => l.kind === "bullet" && l.first && l.runs.length === 2)!;
  await fires("grid", (s) => { s.lines[5].y -= 0.6; });
  await fires("indent", (s) => { bulletLine(s).runs[0].x += 1; });
  await fires("indent", (s) => { bulletLine(s).runs[1].x += 0.6; });
  await fires("dates", (s) => { const d = s.lines.find((l) => l.runs.some((r) => r.role === "date"))!.runs.find((r) => r.role === "date")!; d.x -= 1; });
  await fires("gaps", (s) => { const k = s.lines.findIndex((l, i) => i > 8 && l.kind === "entry" && l.first); for (let i = k; i < s.lines.length && s.lines[i].page === s.lines[k].page; i++) s.lines[i].y -= s.geometry.unit; });
  await fires("widow", (s) => {
    // A page break inside a bullet: its wrapped line, and everything after it, moved to the top of the next page.
    const k = s.lines.findIndex((l) => l.kind === "bullet" && !l.first && l.page === 0);
    const after = s.lines.slice(k);
    for (const l of after) { l.page += 1; }
    const onNext = after.filter((l) => l.page === 1);
    onNext.forEach((l, j) => { l.y = Math.round((s.geometry.gridTop - (2 + 2 * j) * s.geometry.unit) * 100) / 100; });
    s.lines = s.lines.filter((l) => l.page <= 1); s.rules = s.rules.filter((r) => r.page === 0); s.pages = 2;
  });
  await fires("overflow", (s) => { s.lines[6].runs[0].text += " and then a great many more words that run straight past the right margin of the page"; });
  // A file set in faces other than its template's (Helvetica where Times was declared).
  const foreign = await checkTemplatePdf({ ...base.geometry, faces: ["Times-Roman", "Times-Bold"] }, templatePdf(R, base));
  assert(foreign.failures.some((f) => f.rule === "fonts" && /Helvetica/.test(f.detail)), JSON.stringify(foreign.failures.slice(0, 2)));
  await fires("fonts", (s) => { s.lines[6].runs[0].size = 9.5; });
  const other = renderTemplate(R, CORPUS[0].doc, { template: "T14" });
  assert(other.ok);
  await fires("docx_text", () => {}, other.docx);
});

Deno.test("r10/5 a name the standard faces cannot print is refused, never printed as '?'", () => {
  const doc = structuredClone(CORPUS[0].doc);
  doc.header.name = "Łukasz Wiśniewski";
  const r = renderTemplate(R, doc, { template: "T01" });
  assert(!r.ok && /cannot print "Ł"/.test(r.reason) && /not made/.test(r.reason), JSON.stringify(r));
  eq(unencodable("José Zoë Søren François Ngô Ångström"), [], "Latin-1 names print");
});

// ------------------------------------------------------------------------------------------------ the rater
Deno.test("r10/6 the rater, on Word files and the PDFs LibreOffice saves from them: a clean file is kept; columns, tables, a header-only contact and a messy layout are not, each finding naming the exact element", async () => {
  const rate = async (n: string) => await rateResumeFile(R, await fixture(n));
  for (const n of ["good.docx", "good.pdf"]) {
    const r = await rate(n);
    assert(r.score >= KEEP_MIN && r.hardFailures.length === 0 && r.keep, `${n}: ${r.score} ${JSON.stringify(r.findings.filter((f) => !f.pass))}`);
  }
  for (const n of ["two-column.docx", "two-column.pdf"]) {
    const r = await rate(n);
    assert(!r.keep && r.hardFailures.includes("columns"), `${n}: ${r.hardFailures}`);
  }
  const t = await rate("two-column.docx");
  assert(t.hardFailures.includes("containers") && /table/.test(t.findings.find((f) => f.criterion === "containers")!.detail));
  const tp = await rate("two-column.pdf");
  assert(tp.findings.find((f) => f.criterion === "columns")!.where.some((w) => /^p1: ".+" at x \d/.test(w)), "the second-column lines are named with their x");
  const h = await rate("header-contact.docx");
  assert(!h.keep && h.hardFailures.includes("contact") && /header or footer/.test(h.findings.find((f) => f.criterion === "contact")!.detail));
  for (const n of ["messy.docx", "messy.pdf"]) {
    const m = await rate(n);
    assert(!m.keep && m.score < KEEP_MIN, `${n} ${m.score}`);
    const fails = Object.fromEntries(m.findings.filter((f) => !f.pass).map((f) => [f.criterion, f]));
    for (const c of ["type", "margins", "headings", "edges"]) assert(fails[c], `${n}: ${c} fails`);
    assert(/0\.3 in/.test(fails.margins.detail) && /9 pt/.test(fails.type.detail) && /MY JOURNEY|My Journey/i.test(fails.headings.detail), `${n}: ${fails.margins.detail} | ${fails.type.detail}`);
    assert(fails.edges.where.length > 0 || /\d/.test(fails.edges.detail), "the indents are named");
  }
  eq(Object.values(POINTS).reduce((a, b) => a + b, 0), 100, "the criteria add to 100");
  eq(HARD, ["columns", "containers", "contact", "roundtrip"]);
});

Deno.test("r10/7 our own fifteen templates score as keepable on the rater (PDF and DOCX), and a kept PDF of standard faces can be rebuilt exactly, a 16 pt name included; a 24 pt name cannot", async () => {
  const c = CORPUS[2];
  for (const id of TEMPLATE_IDS) {
    const r = renderTemplate(R, c.doc, { template: id });
    assert(r.ok);
    const p = await rateResumeFile(R, r.pdf), d = await rateResumeFile(R, r.docx);
    assert(p.keep && p.score >= 95, `${id} PDF ${p.score} ${JSON.stringify(p.findings.filter((f) => !f.pass))}`);
    assert(d.keep && d.score >= 95, `${id} DOCX ${d.score} ${JSON.stringify(d.findings.filter((f) => !f.pass))}`);
  }
  const ours = renderTemplate(R, c.doc, { template: "T13" });
  assert(ours.ok);
  const rating = await rateResumeFile(R, ours.pdf);
  const spec = ownPdfSpec(rating, await pdfNamePt(ours.pdf));
  assert(spec.ok, JSON.stringify(spec));
  const again = renderDesigned(R, CORPUS[9].doc, { layout: "own", ownPdfSpec: spec.spec });
  assert(again.ok && again.parseCheck.status !== "FAIL" && again.own_source === "pdf", JSON.stringify(again.ok ? again.parseCheck : again));
  // A Word-made PDF with a 16 pt name (Arial, saved by LibreOffice) is rebuilt with its 16 pt name (R6 scoped), and the rebuild
  // passes the parse-check and the pixel checker.
  const good = await fixture("good.pdf"), gr = await rateResumeFile(R, good);
  const yes = ownPdfSpec(gr, await pdfNamePt(good));
  assert(yes.ok && yes.spec.namePt === 16 && yes.spec.face === "sans", JSON.stringify(yes));
  const rebuilt = renderDesigned(R, CORPUS[9].doc, { layout: "own", ownPdfSpec: yes.spec });
  assert(rebuilt.ok && rebuilt.parseCheck.status !== "FAIL", JSON.stringify(rebuilt.ok ? rebuilt.parseCheck : rebuilt));
  const set = renderTemplate(R, CORPUS[9].doc, { template: "OWN" as LibraryId, spec: yes.spec });
  assert(set.ok);
  const k = await checkTemplatePdf(set.set.geometry, set.pdf, { R, docx: set.docx });
  assert(k.pass, JSON.stringify(k.failures.slice(0, 3)));
  const huge = ownPdfSpec(gr, 24);
  assert(!huge.ok && /24 pt/.test(huge.reason), JSON.stringify(huge));
});

Deno.test("r10/8 the recommendation: the best of the fifteen for role and level, in plain words", () => {
  const pick = (role: string, years: number | null, o: { student?: boolean; title?: string; careerChange?: boolean } = {}) =>
    recommendTemplate({ role: roleFamily(role), level: levelOf({ years, student: o.student, title: o.title ?? role }), careerChange: o.careerChange });
  eq(pick("Data Analyst", 0, { student: true }).template, "T05");
  eq(pick("Senior Software Engineer", 12).template, "T04");
  eq(pick("Software Engineer", 2).template, "T03");
  eq(pick("Program Analyst, Department of Labor (federal, GS-11)", 6).template, "T12");
  eq(pick("Research Assistant", 1).template, "T09");
  eq(pick("Product Designer", 4).template, "T06");
  eq(pick("Account Executive", 4).template, "T08");
  eq(pick("Investment Banking Analyst", 2).template, "T07");
  eq(pick("VP of Operations", 20).template, "T11");
  eq(pick("Data Analyst", 3, { careerChange: true }).template, "T10");
  const w = pick("Data Analyst", 0, { student: true }).why;
  assert(/Analyst \(template 5\)/.test(w) && /one page/.test(w) && /flush right/.test(w), w);
});

// ------------------------------------------------------------------------------------------------ wired into tailor_resume
const RESUME_TEXT = await Deno.readTextFile(new URL("../../packages/career-data/fixtures/test-resume.txt", import.meta.url));
function fixtureProfile() {
  const p = CareerProfile.createProfile({ basics: { name: "Alex Testcase", email: "alex.testcase@example.test", location: "Chicago, IL" } });
  const r = CareerProfile.ingestResume(p, { text: RESUME_TEXT, fileName: "test-resume.txt" });
  assert(r.ok);
  for (const f of p.facts) CareerProfile.confirmFact(p, f.id);
  return p;
}
const POSTING = `Data Analyst, Acme Analytics (TEST posting)\nRequirements:\n- Experience with SQL and PostgreSQL, Python, and Tableau\n- Build dashboards for internal users`;
const NOW = Date.UTC(2026, 10, 8, 15), USER = "00000000-0000-4000-8000-0000000010a1";
function tools(upload: { bytes: Uint8Array; kind: "pdf" | "docx" } | null, ownDocx: Uint8Array | null = null) {
  const versions = memoryVersionLog(), store = memoryResumeStore();
  const t = Object.fromEntries(careerTools({ postings: async () => [], tailor: { posting: async () => null, personas: memoryPersonaStore(), resumes: store, render: edgeRenderer(), versions, upload: async () => upload, ownDocx: async () => ownDocx } }).map((x) => [x.name, x]));
  const ctx = { userId: USER, threadId: "t1", now: NOW, state: { profile: fixtureProfile() } as Record<string, any>, turn: { message: "make me a resume for this one", added: [] as string[] } };
  return { t, ctx, versions, store };
}

Deno.test("r10/9 'use template 5' makes the file in template 5 and records it by template; a number outside 1-15 is refused", async () => {
  const { t, ctx, versions } = tools(null);
  const r = await t.tailor_resume.run({ posting_text: POSTING, layout: "template", template: "5" }, ctx) as any;
  eq([r.layout, r.template, r.ats.status !== "FAIL"], ["template", "T05", true], JSON.stringify(r).slice(0, 300));
  const st = await versions.get(USER), entry = Object.values(st.files)[0] as any;
  eq([entry.layout, entry.template], ["template", "T05"], "the version record names the template");
  let err = "";
  try { await t.tailor_resume.run({ posting_text: POSTING, layout: "template", template: "16" }, ctx); } catch (e) { err = String((e as Error).message); }
  assert(/1 to 15/.test(err), err);
});

Deno.test("r10/10 with no layout asked: a resume the rater keeps keeps its layout; one it does not is made in the default and the best template is offered with why; nothing is invented", async () => {
  const good = await fixture("good.docx");
  const a = tools({ bytes: good, kind: "docx" }, good);
  const kept = await a.t.tailor_resume.run({ posting_text: POSTING }, a.ctx) as any;
  assert(kept.format_check?.keep === true && kept.format_check.score >= KEEP_MIN, JSON.stringify(kept.format_check));
  // Their layout is kept, or (when their own file fails a check once it carries the tailored words) the default is used and said.
  assert(kept.layout === "own" || /could not be kept/.test(kept.format_check.summary), `${kept.layout} ${kept.format_check.summary}`);
  const messy = await fixture("messy.docx");
  const b = tools({ bytes: messy, kind: "docx" }, messy);
  const offered = await b.t.tailor_resume.run({ posting_text: POSTING }, b.ctx) as any;
  eq([offered.layout, offered.format_check.keep], ["plain", false]);
  eq(offered.format_check.recommended.template, 5, "a data posting: the Analyst template");
  assert(/scores \d+\/100/.test(offered.format_check.summary) && /Suggested: Analyst \(template 5\) is made for data/.test(offered.format_check.summary), offered.format_check.summary);
  assert(offered.format_check.findings.some((f: any) => f.criterion === "margins" && /0\.3 in/.test(f.detail)), "the finding names the measurement");
  // The words on the file are the confirmed record's, whatever the layout.
  const words = wordsOf(String(offered.preview));
  assert(!words.includes("journey"), "nothing from the messy file's own headings is carried into the content");
});

// ------------------------------------------------------------------------------------------------ the real-world round trip
Deno.test("r10/11 every template x corpus file read back by independent offline extractors: pdfium, poppler and python-docx bring back every field; pdfminer in position order 99.9%+", async () => {
  const probe = await new Deno.Command("python3", { args: ["-I", "-c", "import pdfminer, pypdfium2, docx"], stdout: "null", stderr: "null" }).output().catch(() => null);
  if (!probe?.success) {
    if (CI) throw new Error("CI must install pdfminer.six, pypdfium2 and python-docx (.github/workflows/ci.yml)");
    console.log("NOT_RUN: pdfminer.six / pypdfium2 / python-docx are not installed here"); return;
  }
  const dir = await Deno.makeTempDir();
  for (const c of CORPUS) for (const id of TEMPLATE_IDS) {
    const r = renderTemplate(R, c.doc, { template: id });
    assert(r.ok);
    const order = (r.source.sections as any[]).flatMap((s: any) => s.lines.map((l: any) => String(l.text)));
    const at = (t: string) => order.findIndex((x) => x.startsWith(t));
    await Deno.writeFile(`${dir}/${c.id}-${id}.pdf`, r.pdf); await Deno.writeFile(`${dir}/${c.id}-${id}.docx`, r.docx);
    await Deno.writeTextFile(`${dir}/${c.id}-${id}.json`, JSON.stringify({ ...c.expect, entries: [...c.expect.entries].sort((a, b) => at(a.text) - at(b.text)) }));
  }
  const out = await new Deno.Command("python3", { args: ["-I", new URL("../../scripts/resume-roundtrip.py", import.meta.url).pathname, dir], stdout: "piped", stderr: "piped" }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const rep = JSON.parse(new TextDecoder().decode(out.stdout));
  const line = (k: string) => { const e = rep.extractors[k]; return typeof e === "string" ? `${k} ${e}` : `${k} ${e.back}/${e.fields} (${(e.accuracy * 100).toFixed(2)}%), in order ${e.in_order}/${e.files}`; };
  console.log(`ROUND TRIP over ${rep.files} files: ${["pdfium", "poppler", "pdfminer", "pdfminer-default", "docx"].map(line).join("; ")}; dates on their entry's line: ${JSON.stringify(Object.fromEntries(Object.entries(rep.date_lines).map(([k, v]: any) => [k, `${v.on_their_line}/${v.entries}`])))}`);
  for (const k of ["pdfium", "docx"]) { eq(rep.extractors[k].accuracy, 1, `${k}: ${JSON.stringify(rep.extractors[k].misses)}`); eq(rep.extractors[k].in_order, rep.files, k); }
  if (typeof rep.extractors.poppler !== "string") eq(rep.extractors.poppler.accuracy, 1, JSON.stringify(rep.extractors.poppler.misses));
  else if (CI) throw new Error("CI must have poppler-utils (pdftotext)");
  assert(rep.extractors.pdfminer.accuracy >= 0.999, JSON.stringify(rep.extractors.pdfminer.misses));
  eq(rep.date_lines.pdfium.bad, [], "every date on its entry's own line (PDFium)");
  await Deno.remove(dir, { recursive: true });
});

// ------------------------------------------------------------------------------------------------ visual regression
Deno.test("r10/12 the gallery is current: every committed snapshot's PDF hash matches today's render (any layout change must regenerate and review it)", async () => {
  const { galleryPdfs } = await import("../../scripts/resume-template-gallery.ts");
  const manifest = JSON.parse(await Deno.readTextFile(new URL("./snapshots/resume-templates/manifest.json", import.meta.url)));
  const now = galleryPdfs();
  eq(now.length, Object.keys(manifest).length, "the same files");
  for (const g of now) {
    eq(crypto.createHash("sha256").update(g.pdf).digest("hex"), manifest[g.key]?.pdf_sha256, `${g.key}: the layout changed; run deno run -A scripts/resume-template-gallery.ts and review the PNGs`);
    for (let p = 1; p <= g.pages; p++) assert(manifest[g.key].png[`${g.key}-p${p}.png`], `${g.key} page ${p} has a snapshot`);
  }
});
