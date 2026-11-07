// Release 8, the cleaned copy (owner decision on 2026-11-07, "store a cleaned copy"; fidelity rules of the same day). A Word
// upload is never stored as sent: a clean copy is rebuilt from an allowlist, gated, and stored. Every hiding place the latest
// review found is either refused or absent from every part of the stored bytes; real Word files keep their visible lines, in
// order, their formatting elements, links, images, headers and text boxes; a construct that cannot be kept faithfully is
// refused as damaged; the build is linear.
import assertNode from "node:assert/strict";
import * as zlib from "node:zlib";
import * as nodeCrypto from "node:crypto";
import { Buffer } from "node:buffer";
import { cleanCopy, cleanDocx, docxResumeLines, FILE_DAMAGED_REPLY, FILE_HIDDEN_CODE_REPLY, fileText, ingestResumeFile, sha256Bytes } from "../../supabase/functions/_shared/channel_resume_upload.ts";
import { CareerRender } from "../../supabase/functions/_shared/router_core.career.js";
import { DOCX, FILE_FAMILIES, resumeFile, rng, zipOf } from "./scenarios/onboarding-r2-generator.ts";

// deno-lint-ignore no-explicit-any
const R = (CareerRender as any).withRuntime({ zlib, crypto: nodeCrypto, Buffer });
const enc = new TextEncoder(), dec = new TextDecoder();
const CODE = "482913";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main", RNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NSS = `xmlns:w="${W}" xmlns:r="${RNS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ` +
  `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:v="urn:schemas-microsoft-com:vml"`;
const BODY = ["Jordan Lee", "Experience", "Operations Analyst, Acme Corp, 2019 - 2024", "Led weekly reporting across four teams and cut close time by two days.", "Built a customer portal serving 120000 customers.",
  "Managed 25 employees and 1200 shipments a month.", "Education", "BS Economics, State University, 2019", "Skills", "SQL, Excel, Tableau"];
const para = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
type Part = { name: string; data: Uint8Array | string };
// A Word file: the body (BODY plus `inBody`), its relationships, and any other parts.
function docx(o: { inBody?: string; head?: string; rels?: string[]; parts?: Part[]; body?: string; sectPr?: string } = {}): Uint8Array {
  const body = o.body ?? `${(o.head ?? "")}${BODY.slice(0, 4).map(para).join("")}${o.inBody ?? ""}${BODY.slice(4).map(para).join("")}`;
  const parts: Part[] = [
    { name: "[Content_Types].xml", data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: "_rels/.rels", data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/document.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NSS}><w:body>${body}${o.sectPr ?? "<w:sectPr/>"}</w:body></w:document>` },
    ...(o.rels ? [{ name: "word/_rels/document.xml.rels", data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${o.rels.join("")}</Relationships>` }] : []),
    ...(o.parts ?? [])];
  return zipOf(parts.map((p) => ({ name: p.name, data: typeof p.data === "string" ? enc.encode(p.data) : p.data })));
}
const rel = (id: string, type: string, target: string, external = false) => `<Relationship Id="${id}" Type="${REL}${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`;
async function upload(bytes: Uint8Array, name = "resume.docx") {
  const stored: { sha256: string; content_b64: string; bytes: number }[] = [];
  const res = await ingestResumeFile({ userId: "TEST-r8c", channel: "telegram", doc: { fileId: "F", uniqueId: crypto.randomUUID(), name, mime: DOCX, size: bytes.length },
    fetchFile: () => Promise.resolve({ ok: true as const, bytes }), record: (row) => { stored.push(row); return Promise.resolve("id"); } });
  return { res: res as { ok: boolean; why?: string; reply?: string; sha256?: string }, stored };
}
const b64bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const partsOf = (bytes: Uint8Array): Map<string, Uint8Array> => {
  const buf = Buffer.from(bytes), out = new Map<string, Uint8Array>();
  for (const n of R.docxPartNames(buf) as string[]) { const p = R.docxPart(buf, n); assertNode.ok(p, `the stored part ${n} reads back`); out.set(n, new Uint8Array(p)); }
  return out;
};
// Whether the code is anywhere in the stored bytes: as written, as XML character references, as w:sym characters, or in an
// image's bytes.
function carriesCode(bytes: Uint8Array): string | null {
  for (const [n, b] of partsOf(bytes)) {
    const s = new TextDecoder("latin1").decode(b);
    if (s.includes(CODE)) return `${n}: as written`;
    const refs = s.replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)));
    if (refs.includes(CODE)) return `${n}: as character references`;
    const syms = [...s.matchAll(/w:char="([0-9A-Fa-f]{1,4})"/g)].map((m) => { const c = parseInt(m[1], 16); return String.fromCodePoint(c >= 0xf000 ? c - 0xf000 : c); }).join("");
    if (syms.includes(CODE)) return `${n}: as w:sym characters`;
  }
  return null;
}
// Either refused (nothing stored, the code never echoed) or stored once as clean bytes without the code in any part.
async function safe(bytes: Uint8Array, tag: string): Promise<"refused" | "clean"> {
  const u = await upload(bytes);
  if (!u.res.ok) {
    assertNode.equal(u.stored.length, 0, `${tag}: refused, nothing stored`);
    assertNode.ok(!String(u.res.reply).includes(CODE), `${tag}: the reply never repeats the code`);
    return "refused";
  }
  assertNode.equal(u.stored.length, 1, `${tag}: stored once`);
  const got = b64bytes(u.stored[0].content_b64);
  assertNode.notDeepEqual(got, bytes, `${tag}: the original bytes are never stored`);
  assertNode.equal(u.stored[0].sha256, await sha256Bytes(got), `${tag}: the sha256 is the stored bytes' own`);
  assertNode.equal(u.stored[0].bytes, got.length, tag);
  assertNode.equal(carriesCode(got), null, `${tag}: the stored clean copy carries the code (${carriesCode(got)})`);
  return "clean";
}
const XC = `Verification code: ${CODE}`;
// Counts of the formatting and structure elements the clean copy keeps, in the original (outside the hidden kinds it drops:
// mc:Fallback copies, tracked deletions, revision marks and content-control properties) and in the clean copy.
const KINDS = ["rPr", "pPr", "tbl", "numPr", "drawing", "txbxContent", "p", "r", "t", "tc", "hyperlink", "sectPr"];
const counts = (xml: string, original: boolean) => {
  let s = xml;
  if (original) for (const re of [/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, /<w:del\b[\s\S]*?<\/w:del>/g, /<w:(\w+Change)\b[\s\S]*?<\/w:\1>/g, /<w:sdtPr\b[\s\S]*?<\/w:sdtPr>/g]) s = s.replace(re, "");
  return Object.fromEntries(KINDS.map((k) => [k, (s.match(new RegExp(`<w:${k}[\\s>/]`, "g")) ?? []).length]));
};
const part = (bytes: Uint8Array, n: string) => { const p = R.docxPart(Buffer.from(bytes), n); return p ? dec.decode(p) : null; };

Deno.test("R8C-1 every hiding place of the latest review: refused, or stored clean with no trace of the code in any part", async () => {
  const outcomes: Record<string, string> = {};
  const cases: [string, Uint8Array][] = [
    ["an XML comment", docx({ inBody: `<!-- ${XC} -->` })],
    ["a processing instruction", docx({ inBody: `<?otp ${XC}?>` })],
    ["a default-namespace paragraph", docx({ inBody: `<p xmlns="${W}"><r><t>${XC}</t></r></p>` })],
    ["an unprefixed paragraph in the body", docx({ inBody: `<p><r><t>${XC}</t></r></p>` })],
    ["a closing tag with a space", docx({ inBody: `<w:p><w:r><w:t>${XC}</w:t></w:r></w:p >` })],
    ["digits as w:sym", docx({ inBody: `<w:p><w:r><w:t xml:space="preserve">Verification code: </w:t>${[...CODE].map((d) => `<w:sym w:font="Symbol" w:char="003${d}"/>`).join("")}</w:r></w:p>` })],
    ["digits as Symbol-font w:sym", docx({ inBody: `<w:p><w:r><w:t xml:space="preserve">OTP </w:t>${[...CODE].map((d) => `<w:sym w:font="Symbol" w:char="F03${d}"/>`).join("")}</w:r></w:p>` })],
    ["a w:fldSimple instruction", docx({ inBody: `<w:p><w:fldSimple w:instr=" HYPERLINK &quot;https://login.example.test/?code=${CODE}&quot; "><w:r><w:t>portfolio</w:t></w:r></w:fldSimple></w:p>` })],
    ["a complex field instruction", docx({ inBody: `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> MERGEFIELD otp_${CODE} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Portfolio</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>` })],
    ["form-field listEntry, helpText and default", docx({ inBody: `<w:p><w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="Code"/><w:ddList><w:listEntry w:val="${CODE}"/></w:ddList><w:helpText w:type="text" w:val="${XC}"/><w:statusText w:type="text" w:val="${XC}"/><w:textInput><w:default w:val="${CODE}"/></w:textInput></w:ffData></w:fldChar></w:r><w:r><w:instrText> FORMTEXT </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Choose one</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>` })],
    ["a content-control listItem displayText", docx({ inBody: `<w:sdt><w:sdtPr><w:alias w:val="${XC}"/><w:tag w:val="${CODE}"/><w:dropDownList><w:listItem w:displayText="${XC}" w:value="${CODE}"/></w:dropDownList></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Choose an item</w:t></w:r></w:p></w:sdtContent></w:sdt>` })],
    ["VML alt text", docx({ inBody: `<w:p><w:r><w:pict><v:shape id="s1" alt="${XC}" style="width:10pt;height:10pt"/></w:pict></w:r></w:p>` })],
    ["an attribute in an unknown namespace", docx({ inBody: `<w:p xmlns:x="urn:x-test" x:note="${XC}"><w:r x:id="${CODE}"><w:t>Volunteer, Food Bank, 2018 - 2020</w:t></w:r></w:p>` })],
    ["a w:val with letters and digits", docx({ inBody: `<w:p><w:pPr><w:pStyle w:val="OTP${CODE}"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Code${CODE}"/></w:rPr><w:t>Volunteer, Food Bank, 2018 - 2020</w:t></w:r></w:p>` })],
    ["image alt text and name", docx({ inBody: `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1" name="Code ${CODE}" descr="${XC}" title="${XC}"/></wp:inline></w:drawing></w:r></w:p>` })],
    ["a tracked deletion", docx({ inBody: `<w:p><w:del w:id="1" w:author="Code ${CODE}"><w:r><w:delText>${XC}</w:delText></w:r></w:del><w:r><w:t>Volunteer, Food Bank, 2018 - 2020</w:t></w:r></w:p>` })],
    ["numbering lvlText", docx({ rels: [rel("rId1", "numbering", "numbering.xml")], parts: [{ name: "word/numbering.xml", data: `<w:numbering ${NSS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="${CODE}%1"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>` }] })],
    ["numbering lvlText with a label", docx({ rels: [rel("rId1", "numbering", "numbering.xml")], parts: [{ name: "word/numbering.xml", data: `<w:numbering ${NSS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="OTP 4829"/></w:lvl></w:abstractNum></w:numbering>` }] })],
    ["settings docVar", docx({ rels: [rel("rId1", "settings", "settings.xml")], parts: [{ name: "word/settings.xml", data: `<w:settings ${NSS}><w:defaultTabStop w:val="720"/><w:docVars><w:docVar w:name="otp" w:val="${CODE}"/></w:docVars><w:attachedTemplate r:id="rId9"/></w:settings>` }] })],
    ["app properties Company and Manager", docx({ parts: [{ name: "docProps/app.xml", data: `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Company>${XC}</Company><Manager>OTP ${CODE}</Manager></Properties>` }] })],
    ["a customXml item", docx({ parts: [{ name: "customXml/item1.xml", data: `<root><otp>${CODE}</otp><note>${XC}</note></root>` }, { name: "customXml/itemProps1.xml", data: `<ds:datastoreItem xmlns:ds="urn:ds" ds:itemID="{${CODE}}"/>` }] })],
    ["non-string custom properties and the name", docx({ parts: [{ name: "docProps/custom.xml", data: `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="${XC}"><vt:i4>${CODE}</vt:i4></property><property pid="3" name="otp"><vt:r8>${CODE}</vt:r8></property></Properties>` }] })],
    ["altChunk parts of other kinds", docx({ parts: [{ name: "word/afchunk.rtf", data: `{\\rtf1 ${XC}}` }, { name: "word/afchunk.xhtml", data: `<html><body><p>${XC}</p></body></html>` }, { name: "word/afchunk.mhtml", data: `MIME-Version: 1.0\r\n\r\n${XC}` }, { name: "word/afchunk.docm", data: docx({ inBody: para(XC) }) }, { name: "word/afchunk", data: XC }] })],
    ["an altChunk the body shows", docx({ inBody: `<w:altChunk r:id="rId1"/>`, rels: [rel("rId1", "aFChunk", "afchunk.rtf")], parts: [{ name: "word/afchunk.rtf", data: `{\\rtf1 ${XC}}` }] })],
    ["a comment part", docx({ rels: [rel("rId1", "comments", "comments.xml")], parts: [{ name: "word/comments.xml", data: `<w:comments ${NSS}><w:comment w:id="0"><w:p><w:r><w:t>${XC}</w:t></w:r></w:p></w:comment></w:comments>` }] })],
    ["a footnote the body refers to", docx({ inBody: `<w:p><w:r><w:t>Portfolio</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>`, rels: [rel("rId1", "footnotes", "footnotes.xml")], parts: [{ name: "word/footnotes.xml", data: `<w:footnotes ${NSS}><w:footnote w:id="1"><w:p><w:r><w:t>${XC}</w:t></w:r></w:p></w:footnote></w:footnotes>` }] })],
    ["a text box", docx({ inBody: `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent><w:p><w:r><w:t>${XC}</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>${XC}</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>` })],
    ["a VML-only picture with text", docx({ inBody: `<w:p><w:r><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>${XC}</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>` })],
    ["a VML text path", docx({ inBody: `<w:p><w:r><w:pict><v:shape><v:textpath string="${XC}"/></v:shape></w:pict></w:r></w:p>` })],
    ["an unknown element with text", docx({ inBody: `<w:p><w:r><w:unknownThing>${XC}</w:unknownThing><w:t>Volunteer</w:t></w:r></w:p>` })],
    ["a header link's query", docx({ sectPr: `<w:sectPr><w:headerReference w:type="default" r:id="rId1"/></w:sectPr>`, rels: [rel("rId1", "header", "header1.xml")], parts: [
      { name: "word/header1.xml", data: `<w:hdr ${NSS}><w:p><w:hyperlink r:id="rId1"><w:r><w:t>Jordan Lee</w:t></w:r></w:hyperlink></w:p></w:hdr>` },
      { name: "word/_rels/header1.xml.rels", data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("rId1", "hyperlink", `https://login.example.test/verify?code=${CODE}`, true)}</Relationships>` }] })],
  ];
  for (const [tag, bytes] of cases) outcomes[tag] = await safe(bytes, tag);
  // The ones only the clean copy can catch (the old reader never read them) are refused by its gate or by its fidelity rule.
  for (const tag of ["a closing tag with a space", "digits as w:sym", "digits as Symbol-font w:sym", "numbering lvlText", "numbering lvlText with a label", "an altChunk the body shows", "a footnote the body refers to", "a VML-only picture with text", "an unknown element with text"]) {
    assertNode.equal(outcomes[tag], "refused", tag);
  }
  const lossy = await upload(cases.find(([t]) => t === "an altChunk the body shows")![1]);
  assertNode.equal(lossy.res.reply, FILE_DAMAGED_REPLY, "a construct the clean copy cannot keep faithfully is refused as damaged");
  const sym = await upload(cases.find(([t]) => t === "digits as w:sym")![1]);
  assertNode.equal(sym.res.reply, FILE_HIDDEN_CODE_REPLY, "the clean copy's gate refuses a code it keeps");
  console.log(JSON.stringify(outcomes, null, 1));
});

Deno.test("R8C-2 the real Word files: the 4 plain ones are kept as clean copies with the same visible lines, structure, links and headers; the 2 with codes are refused", async () => {
  const dir = new URL("./fixtures/r8-real-docx/", import.meta.url);
  for (const f of ["pydocx-plain.docx", "pandoc-plain.docx", "libreoffice-pydocx.docx", "libreoffice-pandoc.docx"]) {
    const orig = Deno.readFileSync(new URL(f, dir)), u = await upload(orig, f);
    assertNode.ok(u.res.ok && u.stored.length === 1, `${f}: ${JSON.stringify(u.res).slice(0, 200)}`);
    const clean = b64bytes(u.stored[0].content_b64);
    assertNode.deepEqual(clean, await cleanDocx(orig), `${f}: the clean copy is the same bytes each time`);
    assertNode.equal(await fileText("docx", clean), await fileText("docx", orig), `${f}: the visible lines, in order`);
    const o = part(orig, "word/document.xml")!, c = part(clean, "word/document.xml")!;
    assertNode.deepEqual(counts(c, false), counts(o, true), `${f}: rPr/pPr/tbl/numPr/drawing/txbxContent and the rest are all kept`);
    const names = [...partsOf(clean).keys()];
    for (const n of names) assertNode.ok(/^(?:\[Content_Types\]\.xml|_rels\/\.rels|word\/(?:document|styles|numbering|settings)\.xml|word\/theme\/theme1\.xml|word\/(?:header|footer)\d+\.xml|word\/_rels\/[\w.]+\.rels|word\/media\/image\d+\.(?:png|jpeg|gif))$/.test(n), `${f}: an allowlisted part: ${n}`);
    for (const n of ["word/styles.xml", "word/numbering.xml"]) if (part(orig, n)) assertNode.ok(names.includes(n), `${f}: ${n} is kept (sanitized)`);
    // Links: every external hyperlink target of the original is a target of the clean copy.
    const linksOf = (b: Uint8Array) => new Set([...(part(b, "word/_rels/document.xml.rels") ?? "").matchAll(/Target="([^"]+)"\s+TargetMode="External"|TargetMode="External"[^>]*Target="([^"]+)"/g)].map((m) => m[1] ?? m[2]));
    const ol = linksOf(orig);
    assertNode.ok(ol.size > 0, f);
    for (const l of ol) assertNode.ok(linksOf(clean).has(l), `${f}: the link ${l} is kept`);
    // Headers and footers: each one the original's body refers to is kept with its lines.
    const refs = (b: Uint8Array, x: string) => [...x.matchAll(/<w:(header|footer)Reference\b[^>]*r:id="(\w+)"/g)].map((m) => {
      const rels = part(b, "word/_rels/document.xml.rels")!, t = new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${m[2]}"`).exec(rels)!;
      return docxResumeLines(part(b, `word/${t[1] ?? t[2]}`)!).join("\n");
    }).sort();
    assertNode.deepEqual(refs(clean, c), refs(orig, o), `${f}: the header and footer lines`);
    assertNode.equal(carriesCode(clean), null, f);
  }
  for (const f of ["pydocx-header-code.docx", "pydocx-comment-code.docx"]) {
    const u = await upload(Deno.readFileSync(new URL(f, dir)), f);
    assertNode.ok(!u.res.ok && u.stored.length === 0 && !String(u.res.reply).includes(CODE), f);
  }
});

Deno.test("R8C-3 generated resumes of every Word layout: the clean copy re-reads to the same lines, keeps its structure, its text boxes without the fallback copy", async () => {
  const families = FILE_FAMILIES.filter((f) => /^docx-/.test(f));
  assertNode.ok(families.includes("docx-textbox"));
  let n = 0;
  for (const family of families) {
    for (let seed = 1; seed <= 15; seed++) {
      const f = resumeFile(rng(seed * 101 + family.length), family);
      const c = await cleanDocx(f.bytes);
      assertNode.equal(await fileText("docx", c), await fileText("docx", f.bytes), `${family} ${seed}: the visible lines`);
      assertNode.deepEqual(counts(part(c, "word/document.xml")!, false), counts(part(f.bytes, "word/document.xml")!, true), `${family} ${seed}: the structure`);
      const u = await upload(f.bytes);
      assertNode.ok(u.res.ok && u.stored.length === 1, `${family} ${seed}: ${JSON.stringify(u.res).slice(0, 160)}`);
      n++;
    }
  }
  assertNode.ok(n >= 75);
});

// A resume laid out as real templates are: name and contact details in a header, a headshot, a sidebar text box (with Word's
// VML fallback copy), page setup, and Figma and UTM links.
function sidebarResume() {
  // A PNG with a text chunk carrying the code: the clean copy keeps the pixels and drops the chunk.
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => { const t = enc.encode(type), len = data.length, out = new Uint8Array(12 + len); new DataView(out.buffer).setUint32(0, len); out.set(t, 4); out.set(data, 8); new DataView(out.buffer).setUint32(8 + len, crc(out.subarray(4, 8 + len))); return out; };
  const ihdr = new Uint8Array(13); new DataView(ihdr.buffer).setUint32(0, 1); new DataView(ihdr.buffer).setUint32(4, 1); ihdr[8] = 8; ihdr[9] = 0;
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk("IHDR", ihdr), ...chunk("tEXt", enc.encode(`Comment\u0000${XC}`)), ...chunk("IDAT", new Uint8Array(zlib.deflateSync(new Uint8Array([0, 128])))), ...chunk("IEND", new Uint8Array(0))]);
  const pic = `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Headshot" descr="Jordan Lee headshot"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Headshot"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId7"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const box = `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>457200</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:align>top</wp:align></wp:positionV><wp:extent cx="1828800" cy="9144000"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="2" name="Sidebar"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="9144000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="1F4E79"/></a:solidFill></wps:spPr><wps:txbx><w:txbxContent><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr><w:t>Skills</w:t></w:r></w:p><w:p><w:r><w:t>Python, SQL, Looker</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr rot="0" vert="horz" wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="t"><a:noAutofit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Skills</w:t></w:r></w:p><w:p><w:r><w:t>Python, SQL, Looker</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;
  const header = `<w:hdr ${NSS}><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>Jordan Lee</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">jordan.lee@example.com · (415) 555-0134 · </w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:t>jordanlee.dev</w:t></w:r></w:hyperlink></w:p></w:hdr>`;
  const figma = "https://www.figma.com/proto/aB3dE5fG7hI9/Portfolio?node-id=12-345&amp;scaling=min-zoom&amp;page-id=0%3A1&amp;starting-point-node-id=12%3A345&amp;type=design&amp;mode=design&amp;t=Zx81kQ2HnB-0";
  const utm = "https://jordanlee.dev/?utm_source=linkedin&amp;utm_medium=social&amp;utm_campaign=jobsearch2024";
  const bytes = docx({
    body: `${pic}${box}${BODY.slice(1).map(para).join("")}<w:p><w:hyperlink r:id="rId8"><w:r><w:t>Case study (Figma)</w:t></w:r></w:hyperlink></w:p><w:p><w:hyperlink r:id="rId9"><w:r><w:t>Portfolio</w:t></w:r></w:hyperlink></w:p>`,
    sectPr: `<w:sectPr><w:headerReference w:type="default" r:id="rId6"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`,
    rels: [rel("rId6", "header", "header1.xml"), rel("rId7", "image", "media/image1.png"), rel("rId8", "hyperlink", figma, true), rel("rId9", "hyperlink", utm, true)],
    parts: [{ name: "word/header1.xml", data: header }, { name: "word/_rels/header1.xml.rels", data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("rId1", "hyperlink", "https://jordanlee.dev/", true)}</Relationships>` },
      { name: "word/media/image1.png", data: png }],
  });
  return { bytes, png, figma, utm };
}

Deno.test("R8C-4 a resume with its name and contact details in a header keeps the header; its picture and a sidebar text box are kept; metadata in the picture is not", async () => {
  const { bytes, png, figma, utm } = sidebarResume();
  assertNode.equal(await safe(bytes, "header, picture, text box and links"), "clean");
  const clean = await cleanDocx(bytes), doc = part(clean, "word/document.xml")!;
  assertNode.equal(await fileText("docx", clean), await fileText("docx", bytes), "the visible lines (the text box's once)");
  assertNode.deepEqual(counts(doc, false), counts(part(bytes, "word/document.xml")!, true), "the structure, the fallback copy left out");
  assertNode.ok(!doc.includes("mc:Fallback") && doc.includes("<w:txbxContent>") && doc.includes("<wps:txbx>"), "the text box is kept, its VML copy is not");
  assertNode.ok(/<wp:posOffset>457200<\/wp:posOffset>/.test(doc) && /<a:srgbClr val="1F4E79"\/>/.test(doc), "its position and fill are kept");
  const hdr = [...partsOf(clean).keys()].find((n) => /^word\/header\d+\.xml$/.test(n))!;
  assertNode.deepEqual(docxResumeLines(part(clean, hdr)!), ["Jordan Lee", "jordan.lee@example.com · (415) 555-0134 · jordanlee.dev"], "the header's name and contact details");
  assertNode.ok(/<w:sz w:val="32"\/>/.test(part(clean, hdr)!), "the header's formatting");
  const hdrRels = part(clean, `word/_rels/${hdr.slice(5)}.rels`)!;
  assertNode.ok(hdrRels.includes('Target="https://jordanlee.dev/"'), "the header's link");
  const docRels = part(clean, "word/_rels/document.xml.rels")!;
  assertNode.ok(docRels.includes(`Target="${figma}"`) && docRels.includes(`Target="${utm}"`), "the Figma and UTM links are kept");
  const img = [...partsOf(clean).entries()].find(([n]) => /^word\/media\/image\d+\.png$/.test(n))!;
  assertNode.ok(img && !dec.decode(img[1]).includes("tEXt") && img[1].length < png.length, "the picture is kept without its text chunk");
  const embed = /<a:blip r:embed="(\w+)"\/>/.exec(doc)![1];
  assertNode.ok(new RegExp(`Id="${embed}" Type="[^"]+/image" Target="${img[0].slice(5)}"`).test(docRels), "the picture is the one the body shows");
  assertNode.ok(!doc.includes("Jordan Lee headshot"), "alt text is not kept");
});

Deno.test("R8C-5 a 5 MB pathological body (80,000 unclosed mc:Fallback, w:p and a:p) is built or refused in under 2 s", async () => {
  const unit = `<mc:Fallback><w:p><a:p>`, junk = unit.repeat(Math.ceil(5_000_000 / unit.length / 3));
  const bytes = docx({ inBody: `<w:p><w:r><w:t>${"x".repeat(10)}</w:t></w:r></w:p>${junk}` });
  const t0 = performance.now();
  let refused = false;
  try { await cleanCopy(bytes); } catch { refused = true; }
  const ms = performance.now() - t0;
  assertNode.ok(ms < 2000, `the clean build took ${Math.round(ms)} ms`);
  assertNode.ok(refused, "a body that never closes is damaged");
  for (const u of [`<mc:Fallback>`, `<w:p>`, `<a:p>`]) {
    const b = docx({ inBody: u.repeat(80_000) }), t1 = performance.now();
    try { await cleanCopy(b); } catch { /* damaged */ }
    assertNode.ok(performance.now() - t1 < 2000, `${u} x 80,000 took ${Math.round(performance.now() - t1)} ms`);
  }
  // The whole upload of the same file (visible reader, old reader, clean build) also stays linear.
  const t2 = performance.now(), u = await upload(bytes);
  assertNode.ok(!u.res.ok && u.stored.length === 0);
  assertNode.ok(performance.now() - t2 < 10000, `the whole upload took ${Math.round(performance.now() - t2)} ms`);
});

Deno.test("R8C-6 links: a Figma and a UTM link are kept, by the old reader's rels check too; a code in a link's parameter is refused", async () => {
  const figma = "https://www.figma.com/file/aB3dE5fG7hI9/Portfolio?type=design&amp;node-id=1-2&amp;mode=design&amp;t=Zx81kQ2HnB-0";
  const utm = "https://jordanlee.dev/?utm_source=linkedin&amp;utm_medium=social&amp;utm_campaign=jobsearch2024";
  const withLink = (url: string) => docx({ inBody: `<w:p><w:hyperlink r:id="rId1"><w:r><w:t>Portfolio</w:t></w:r></w:hyperlink></w:p>`, rels: [rel("rId1", "hyperlink", url, true)] });
  for (const url of [figma, utm]) {
    const u = await upload(withLink(url));
    assertNode.ok(u.res.ok && u.stored.length === 1, `${url}: ${JSON.stringify(u.res).slice(0, 160)}`);
    assertNode.ok(part(b64bytes(u.stored[0].content_b64), "word/_rels/document.xml.rels")!.includes(`Target="${url}"`), url);
  }
  for (const url of [`https://login.example.test/verify?code=${CODE}`, `https://login.example.test/?otp=${CODE}`, `https://login.example.test/verify/${CODE}`]) {
    const u = await upload(withLink(url));
    assertNode.ok(!u.res.ok && u.stored.length === 0, url);
  }
});

Deno.test("R8C-7 soffice opens the clean copies, and their PDF text keeps every line of the original's", async () => {
  const which = new Deno.Command("which", { args: ["soffice"], stdout: "null", stderr: "null" }).outputSync();
  const pdftotext = new Deno.Command("which", { args: ["pdftotext"], stdout: "null", stderr: "null" }).outputSync();
  if (!which.success || !pdftotext.success) { console.log("soffice or pdftotext is not installed: skipped"); return; }
  const tmp = await Deno.makeTempDir({ prefix: "r8c-soffice-" });
  try {
    const dir = new URL("./fixtures/r8-real-docx/", import.meta.url), files: string[] = [];
    for (const f of ["pydocx-plain.docx", "pandoc-plain.docx", "libreoffice-pydocx.docx", "libreoffice-pandoc.docx"]) {
      const orig = Deno.readFileSync(new URL(f, dir));
      Deno.writeFileSync(`${tmp}/orig-${f}`, orig); Deno.writeFileSync(`${tmp}/clean-${f}`, await cleanDocx(orig));
      files.push(`orig-${f}`, `clean-${f}`);
    }
    const side = sidebarResume().bytes;
    Deno.writeFileSync(`${tmp}/orig-sidebar.docx`, side); Deno.writeFileSync(`${tmp}/clean-sidebar.docx`, await cleanDocx(side));
    files.push("orig-sidebar.docx", "clean-sidebar.docx");
    // The generated resumes have no package relationships (_rels/.rels), so soffice cannot open the originals; their clean
    // copies (which have them) must open, and show every visible line the reader reads. (The generator's text box has no
    // anchor or inline, so no renderer places it: that family is checked by the reader in R8C-3.)
    const gen: [string, string[]][] = [];
    for (const family of FILE_FAMILIES.filter((f) => /^docx-/.test(f) && f !== "docx-textbox")) {
      const g = resumeFile(rng(11), family), c = await cleanDocx(g.bytes);
      Deno.writeFileSync(`${tmp}/gen-${family}.docx`, c);
      files.push(`gen-${family}.docx`);
      gen.push([`gen-${family}.docx`, (await fileText("docx", c)).split("\n").flatMap((l) => l.split(/\s*\|\s*/)).map((l) => l.replace(/^- /, "").replace(/\s+/g, " ").trim()).filter(Boolean)]);
    }
    const out = new Deno.Command("soffice", { args: [`-env:UserInstallation=file://${tmp}/profile`, "--headless", "--convert-to", "pdf", "--outdir", tmp, ...files.map((f) => `${tmp}/${f}`)], stdout: "null", stderr: "null" }).outputSync();
    assertNode.ok(out.success, "soffice converted the files");
    const textOf = (f: string) => {
      const pdf = `${tmp}/${f.replace(/\.docx$/, ".pdf")}`;
      assertNode.ok(Deno.statSync(pdf).size > 0, `${f} opened and converted`);
      const r = new Deno.Command("pdftotext", { args: ["-layout", pdf, "-"], stdout: "piped" }).outputSync();
      return dec.decode(r.stdout).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    };
    for (const f of files.filter((x) => x.startsWith("orig-"))) {
      const o = textOf(f), c = textOf(f.replace(/^orig-/, "clean-"));
      assertNode.deepEqual(c, o, `${f}: the clean copy's PDF text is the original's, line for line`);
    }
    for (const [f, want] of gen) {
      const got = textOf(f).join(" ").replace(/[•·▪]/g, " ").replace(/\s+/g, " ");
      for (const l of want.map((x) => x.replace(/[•·▪]/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean)) assertNode.ok(got.includes(l), `${f}: the PDF shows "${l}"`);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
