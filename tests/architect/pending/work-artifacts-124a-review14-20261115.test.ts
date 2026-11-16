// WO-124a fourteenth review (2026-11-15), under D-088's structural bar: a PDF is parsed as a reader parses it (each object's
// own dictionary matched << to >>, compressed object streams opened, attachments found by structure, fonts readable only on
// an allow-list); a part is read only if it is a known container, a parsed PNG/JPEG, or text; attributes are read in one
// pass; text drawn in kerned pieces is matched with each gap as an optional space. Earlier test files unchanged. Fixtures
// are invented.
import zlib from "node:zlib";
import { strToU8, zipSync, zlibSync } from "npm:fflate@0.8.2";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const enc = (s: string) => new TextEncoder().encode(s);
const cat = (b: Uint8Array[]) => { const o = new Uint8Array(b.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of b) { o.set(x, i); i += x.length; } return o; };
const cats = async (files: Record<string, Uint8Array>, values: revoke.RevokedValue[] = ["Jordan Pike", 150000]) =>
  [...new Set((await revoke.scan(files, values)).map((h) => h.category))].sort();
const docx = (extra: Record<string, Uint8Array> = {}, body = "See the chart") => zipSync({
  "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types/>'),
  "word/document.xml": strToU8(`<w:document><w:body><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:body></w:document>`), ...extra });
const SECRET = "Offer for Jordan Pike: 150000 base";

// PDF builders: objects written in order, a stream object given as [dict, bytes].
type Obj = string | [string, Uint8Array];
function pdf(objs: Record<number, Obj>): Uint8Array {
  const parts: Uint8Array[] = [enc("%PDF-1.7\n")];
  for (const [n, o] of Object.entries(objs)) {
    if (typeof o === "string") parts.push(enc(`${n} 0 obj ${o} endobj\n`));
    else parts.push(enc(`${n} 0 obj ${o[0].replace(/>>$/, ` /Length ${o[1].length} >>`)}\nstream\n`), o[1], enc("\nendstream\nendobj\n"));
  }
  parts.push(enc("trailer << /Root 1 0 R >>\n%%EOF\n"));
  return cat(parts);
}
const objStm = (objs: Record<number, string>): [string, Uint8Array] => {
  let head = "", body = "";
  for (const [n, o] of Object.entries(objs)) { head += `${n} ${body.length} `; body += o + "\n"; }
  return [`<< /Type /ObjStm /N ${Object.keys(objs).length} /First ${head.length} /Filter /FlateDecode >>`, zlibSync(enc(head + body))];
};
const page = (font: string, content: string): Record<number, Obj> => ({
  1: "<< /Type /Catalog /Pages 2 0 R >>",
  2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 8 0 R >> >> /Contents 4 0 R >>",
  4: ["<< /Filter /FlateDecode >>", zlibSync(enc(content))],
  8: font,
});
const HELV = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
const attach = (efDict: string, extra: Record<number, Obj> = {}): Uint8Array => pdf({
  1: "<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(a.docx) 5 0 R] >> >> >>",
  2: "<< /Type /Pages /Kids [] /Count 0 >>",
  5: "<< /Type /Filespec /F (a.docx) /EF << /F 6 0 R >> >>",
  6: [efDict, zlibSync(docx({}, SECRET))],
  ...extra,
});

Deno.test("124a review 14 B1: an attachment is found by structure, whatever its dictionary holds", async () => {
  eq(await cats({ "a.pdf": attach("<< /Type /EmbeddedFile /Filter /FlateDecode >>") }), ["body"], "a plain attachment (control)");
  eq(await cats({ "a.pdf": attach("<< /Type /EmbeddedFile /Params << /Size 900 /ModDate (D:20261115) >> /Filter /FlateDecode >>") }), ["body"], "a nested /Params dictionary");
  eq(await cats({ "a.pdf": attach(`<< /Type /EmbeddedFile /Filter /FlateDecode /Desc (${"x".repeat(500)}) >>`) }), ["body"], "a dictionary over 400 characters");
  eq(await cats({ "a.pdf": attach("<< /Filter /FlateDecode >>") }), ["body"], "a stream referenced from /EF with no /Type");
  eq(await cats({ "a.pdf": pdf({ 1: "<< /Type /Catalog >>", 5: "<< /Type /Filespec /F (a.docx) /EF << /F 9 0 R >> >>" }) }), ["unreadable container"], "an /EF naming no stream");
  eq(await cats({ "a.pdf": pdf({ 1: "<< /Type /Catalog >>", 7: objStm({ 9: "<< /Type /EmbeddedFile /Subtype /application#2Fpdf >>" }) }) }), ["unreadable container"], "an /EmbeddedFile packed in an object stream");
  eq(await cats({ "a.pdf": pdf({ 1: "<< /Type /Catalog >>", 5: "<< /Type /Filespec /F (a.docx) /RF << /F 9 0 R >> >>" }) }), ["unreadable container"], "related files");
});

Deno.test("124a review 14 B2: fonts in object streams are checked, and only allow-listed fonts are readable", async () => {
  const withObjStm = (font: string, content: string) => { const p = page(font, content); delete p[8]; return pdf({ ...p, 7: objStm({ 8: font }) }); };
  eq(await cats({ "m.pdf": pdf(page(HELV, "BT /F1 12 Tf (Offer for Jordan Pike) Tj ET")) }), ["body"], "a WinAnsi Type1 font is read (control)");
  eq(await cats({ "m.pdf": withObjStm(HELV, "BT /F1 12 Tf (Offer for Jordan Pike) Tj ET") }), ["body"], "the same font packed in an object stream is read");
  const diff = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /Differences [97 /one /five /zero /zero /zero /zero] >> >>";
  eq(await cats({ "m.pdf": withObjStm(diff, "BT /F1 12 Tf (abcdef) Tj ET") }), ["unreadable container"], "/Differences inside an object stream");
  const t0 = "<< /Type /Font /Subtype /Type0 /BaseFont /Arial /Encoding /Identity-H /DescendantFonts [9 0 R] >>";
  eq(await cats({ "m.pdf": withObjStm(t0, "BT /F1 12 Tf <001400180013> Tj ET") }), ["unreadable container"], "a Type0 font inside an object stream");
  const tu = "<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+Arial /FirstChar 1 /LastChar 6 /Widths [556 556 556 556 556 556] /ToUnicode 6 0 R >>";
  eq(await cats({ "m.pdf": pdf({ ...page(tu, "BT /F1 12 Tf <010203040506> Tj ET"), 6: ["<< >>", enc("beginbfchar <01> <0031> <02> <0035> <03> <0030> endbfchar")] }) }), ["unreadable container"], "a subset font whose text is only in /ToUnicode");
  eq(await cats({ "m.pdf": pdf({ ...page("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 9 0 R >>", "BT /F1 12 Tf (abc) Tj ET"), 9: "<< /Type /Encoding /BaseEncoding /WinAnsiEncoding >>" }) }), ["unreadable container"], "an encoding by reference is not on the allow-list");
  eq(await cats({ "m.pdf": pdf(page("<< /Type /Font /Subtype /Type#30 /BaseFont /Arial /Encoding /Identity-H >>", "BT /F1 12 Tf <0014> Tj ET")) }), ["unreadable container"], "a font subtype written with a # escape");
  eq(await cats({ "m.pdf": pdf(page("<< /Subtype /Type1 /BaseFont /Helvetica /Encoding /Custom >>", "BT /F1 12 Tf (abc) Tj ET")) }), ["unreadable container"], "a font reached only from /Resources /Font, with an unknown encoding");
  const p = page(HELV, "BT /F1 12 Tf (abc) Tj ET"); delete p[8];
  eq(await cats({ "m.pdf": pdf(p) }), ["unreadable container"], "a font resource naming no object");
});

// PNG and JPEG builders.
const T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Uint8Array) => { const o = new Uint8Array(12 + data.length), v = new DataView(o.buffer); v.setUint32(0, data.length); o.set(enc(type), 4); o.set(data, 8); v.setUint32(8 + data.length, crc(o.subarray(4, 8 + data.length))); return o; };
const ihdr = (() => { const h = new Uint8Array(13), v = new DataView(h.buffer); v.setUint32(0, 1); v.setUint32(4, 1); h[8] = 8; return h; })();
const png = (...meta: Uint8Array[]) => cat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("pHYs", new Uint8Array(9)), ...meta, chunk("IDAT", zlibSync(new Uint8Array([0, 0]))), chunk("IEND", new Uint8Array())]);
const seg = (mk: number, data: Uint8Array) => cat([new Uint8Array([0xff, mk, (data.length + 2) >> 8, (data.length + 2) & 0xff]), data]);
const jpeg = (...meta: Uint8Array[]) => cat([new Uint8Array([0xff, 0xd8]), seg(0xe0, cat([enc("JFIF\0"), new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0])])), ...meta,
  seg(0xdb, new Uint8Array(65)), seg(0xc0, new Uint8Array([8, 0, 1, 0, 1, 1, 1, 0x11, 0])), seg(0xc4, new Uint8Array(29)), seg(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0])),
  new Uint8Array([0x12, 0xff, 0x00, 0x34]), new Uint8Array([0xff, 0xd9])]);

Deno.test("124a review 14 B3: image text chunks are read; unknown chunks and segments are unreadable", async () => {
  const ztxt = chunk("zTXt", cat([enc("Description\0\0"), zlibSync(enc(SECRET))]));
  const itxt = chunk("iTXt", cat([enc("Description\0\x01\0en\0\0"), zlibSync(enc(SECRET))]));
  eq(await cats({ "chart.png": png(ztxt) }), ["body"], "zTXt in a PNG on its own");
  eq(await cats({ "memo.docx": docx({ "word/media/image1.png": png(ztxt) }) }), ["alt text or media"], "zTXt in a docx image");
  eq(await cats({ "memo.docx": docx({ "word/media/image1.png": png(itxt) }) }), ["alt text or media"], "compressed iTXt");
  eq(await cats({ "memo.docx": docx({ "word/media/image1.png": png(chunk("prVt", zlibSync(enc(SECRET)))) }) }), ["unreadable container"], "an unknown PNG chunk");
  eq(await cats({ "memo.docx": docx({ "word/media/image1.jpeg": jpeg(seg(0xfe, enc(SECRET))) }) }), ["alt text or media"], "a JPEG comment");
  eq(await cats({ "memo.docx": docx({ "word/media/image1.jpeg": jpeg(seg(0xe1, cat([enc("http://ns.adobe.com/xap/1.0/\0"), enc(`<x:xmpmeta><dc:title>${SECRET}</dc:title></x:xmpmeta>`)]))) }) }), ["alt text or media"], "JPEG XMP");
  eq(await cats({ "memo.docx": docx({ "word/media/image1.jpeg": jpeg(seg(0xeb, zlibSync(enc(SECRET)))) }) }), ["unreadable container"], "an unknown JPEG APPn segment");
  eq(await cats({ "memo.docx": docx({ "word/media/image1.gif": cat([enc("GIF89a"), new Uint8Array([1, 0, 1, 0, 0, 0, 0, 0x21, 0xfe, 3]), enc("abc"), new Uint8Array([0, 0x3b])]) }) }), ["unreadable container"], "a GIF");
  for (const [label, bytes] of [
    ["raw zlib", zlibSync(enc(SECRET))],
    ["brotli", new Uint8Array(zlib.brotliCompressSync(enc(SECRET)))],
    ["bzip2", cat([enc("BZh91AY&SY"), new Uint8Array([1, 2, 3, 0x80, 0x10])])],
    ["xz", cat([new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), new Uint8Array([0, 4, 0xe6, 0xd6])])],
    ["zstd", cat([new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]), new Uint8Array([0x20, 5, 0x29, 0])])],
    ["an OLE vbaProject.bin", cat([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), new Uint8Array(24)])],
  ] as const) {
    eq(await cats({ "memo.docx": docx({ "word/vbaProject.bin": bytes }) }), ["unreadable container"], label);
  }
  eq(await cats({ "book.xlsb": zipSync({ "xl/workbook.bin": new Uint8Array([0x83, 0x01, 0x00, 0x80, 0x01, 0x00]) }) }), ["unreadable container"], "an .xlsb binary part");
  eq(await cats({ "memo.docx": docx({ "word/media/image1.png": png(chunk("tEXt", enc("Software\0Paint"))), "word/media/image2.jpeg": jpeg(seg(0xee, enc("Adobe\0d\0\0\0\0\x01"))) }) }), [], "an ordinary docx with a PNG and a JPEG stays deliverable");
  eq(await cats({ "notes.txt": enc("Plain notes\twith tabs\r\nand lines\n") }), [], "plain UTF-8 text stays readable");
});

Deno.test("124a review 14 B4: attribute reading is linear; an 800-paragraph docx scans well under 200 ms", async () => {
  const build = (n: number) => {
    let x = '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>';
    for (let i = 0; i < n; i++) x += `<w:p><w:pPr><w:pStyle w:val="Normal"/><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:color w:val="333333"/><w:sz w:val="22"/></w:rPr><w:t>Paragraph ${i} of the memo text.</w:t></w:r></w:p>`;
    return zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8(x + '<w:sdt><w:sdtPr><w:alias w:val="Jordan Pike"/></w:sdtPr></w:sdt></w:body></w:document>') });
  };
  await revoke.scan({ "warm.docx": build(10) }, ["Jordan Pike"]);
  const file = build(800), t = performance.now();
  const hits = await revoke.scan({ "memo.docx": file }, ["Jordan Pike"]);
  const ms = performance.now() - t;
  eq(hits.map((h) => h.category), ["body"], "a content control's alias is still read");
  if (ms >= 200) throw new Error(`800 paragraphs took ${Math.round(ms)} ms`);
});

Deno.test("124a review 14 B5: text drawn in kerned pieces is matched with each gap as an optional space", async () => {
  for (const [label, content] of [
    ["kerned inside words", "BT /F1 12 Tf [(Offer)-333(for)-333(J)83(ordan)-333(Pik)28(e)] TJ ET"],
    ["no space glyph at all", "BT /F1 12 Tf [(J)(ordan)(Pike)] TJ ET"],
    ["pieces placed one by one", "BT /F1 12 Tf (Jor) Tj 20 0 Td (dan) Tj 30 0 Td (P) Tj 8 0 Td (ike) Tj ET"],
    ["kerned hex strings", "BT /F1 12 Tf [<4a6f72>-20<64616e>-400<50696b65>] TJ ET"],
  ]) {
    eq(await cats({ "m.pdf": pdf(page(HELV, content)) }, ["Jordan Pike"]), ["body"], label);
  }
  eq(await cats({ "m.pdf": pdf(page(HELV, "BT /F1 12 Tf [(Jordan)-333(Pikes)] TJ ET")) }, ["Jane Doe"]), [], "another name is not a hit");
});
