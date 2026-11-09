// RELEASE 10 (architect ruling 2026-11-08): 148's R6 size rule is scoped. Body text and headings stay 10-12 pt; the name (the
// first line of page one in a PDF; in a DOCX, the style of the first paragraph when no other paragraph uses it) may be 10-18 pt.
// Anything else outside its range still fails.
// deno-lint-ignore-file no-explicit-any
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { CareerRender } from "../../supabase/functions/_shared/router_core.career.js";
import { renderTemplate, TEMPLATES } from "../../supabase/functions/_shared/career_resume_templates.ts";
import { corpus } from "../helpers/resume_corpus.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const R = (CareerRender as any).withRuntime({ zlib, crypto, Buffer });
const doc = corpus()[2].doc;
const fails = (pc: any) => pc.reasons.filter((r: any) => r.level === "fail").map((r: any) => `${r.check}: ${r.detail}`);
function pdfWith(namePt: number, body = 11) {
  const spec = { ...TEMPLATES.T14, namePt, body };
  const r = renderTemplate(R, doc, { template: "T14", spec });
  assert(r.ok, JSON.stringify(r));
  return R.parseCheck({ resume: r.source, pdf: Buffer.from(r.pdf) }, { expected: { pdf: r.printedPdf } });
}

Deno.test("r6-scope/1 PDF: a 14, 16 or 18 pt name passes; a 20 pt name fails; a 13 pt body still fails", () => {
  for (const n of [12, 14, 16, 18]) { const pc = pdfWith(n); assert(!fails(pc).length, `${n} pt name: ${fails(pc)}`); assert(pc.checks.pdf.nameSizesPt.includes(n)); }
  assert(fails(pdfWith(20)).some((f: string) => /name size\(s\) outside 10–18pt: 20/.test(f)), "a 20 pt name fails");
  assert(fails(pdfWith(16, 13)).some((f: string) => /font size\(s\) outside 10–12pt: 13/.test(f)), "a 13 pt body fails");
});

function docx(styles: string, paras: string) {
  const ns = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
  return R.primitives.zipBuffer([
    { name: "[Content_Types].xml", data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/document.xml", data: `<?xml version="1.0"?><w:document ${ns}><w:body>${paras}</w:body></w:document>` },
    { name: "word/styles.xml", data: `<?xml version="1.0"?><w:styles ${ns}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>${styles}</w:styles>` },
  ]);
}
const p = (style: string | null, text: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;
const title = (sz: number) => `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:sz w:val="${sz}"/></w:rPr></w:style>`;

Deno.test("r6-scope/2 DOCX: the name's own style may be 16 pt; the same style used again, or 20 pt, fails", () => {
  const check = (buf: Uint8Array) => fails(R.parseCheck({ docx: Buffer.from(buf) }, {})).filter((f: string) => f.startsWith("fonts"));
  const body = p(null, "alex@example.test") + p(null, "Experience");
  assert(!check(docx(title(32), p("Title", "Alex Testcase") + body)).length, "a 16 pt name style used once passes");
  assert(check(docx(title(32), p("Title", "Alex Testcase") + body + p("Title", "Experience again"))).some((f: string) => /10–12pt: 16/.test(f)), "a 16 pt style used for more than the name is body text");
  assert(check(docx(title(40), p("Title", "Alex Testcase") + body)).some((f: string) => /name size\(s\) outside 10–18pt: 20/.test(f)), "a 20 pt name fails");
});
