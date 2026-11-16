// WO-124a thirteenth review (2026-11-16), under D-088's structural bar: Office's 0xa220 padding field is known; every known
// extra field's payload, the gzip FEXTRA field, PDF metadata and attachments are read; a font that redraws codes as other
// digits or letters, and a predictor stream, make a PDF unreadable; a stored zip inside a zip is not a second end record.
// Earlier test files unchanged. Fixtures are invented.
import zlib from "node:zlib";
import { strToU8, zipSync } from "npm:fflate@0.8.2";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const enc = (s: string) => new TextEncoder().encode(s);
const cats = async (n: string, f: Uint8Array) => [...new Set((await revoke.scan({ [n]: f }, [150000])).map((h) => h.category))];
const cat = (b: Uint8Array[]) => { const o = new Uint8Array(b.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of b) { o.set(x, i); i += x.length; } return o; };
const T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const le = (n: number, w: number) => { const o = new Uint8Array(w); for (let i = 0; i < w; i++) o[i] = (n >>> (8 * i)) & 0xff; return o; };
function zip1(name: string, data: Uint8Array, extra = new Uint8Array()): Uint8Array {
  const c = crc(data), nm = enc(name);
  const h = cat([le(0x04034b50, 4), le(20, 2), le(0, 2), le(0, 2), le(0, 4), le(c, 4), le(data.length, 4), le(data.length, 4), le(nm.length, 2), le(extra.length, 2), nm, extra]);
  const cd = cat([le(0x02014b50, 4), le(20, 2), le(20, 2), le(0, 2), le(0, 2), le(0, 4), le(c, 4), le(data.length, 4), le(data.length, 4), le(nm.length, 2), le(extra.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(0, 4), nm, extra]);
  return cat([h, data, cd, le(0x06054b50, 4), le(0, 2), le(0, 2), le(1, 2), le(1, 2), le(cd.length, 4), le(h.length + data.length, 4), le(0, 2)]);
}
const pdf = (obj: string, body: Uint8Array) => cat([enc(`%PDF-1.4\n1 0 obj\n<<${obj}/Length ${body.length}>>\nstream\n`), body, enc("\nendstream\nendobj\n%%EOF")]);

Deno.test("124a review 13: Office's 0xa220 padding is read, not refused; known extra payloads are read", async () => {
  const pad = cat([le(0xa220, 2), le(4, 2), le(0xa028, 2), le(0, 2)]);
  eq(await cats("w.docx", zip1("word/document.xml", enc("<w:t>hello</w:t>"), pad)), [], "an Office-style entry is clean");
  const ut = cat([le(0x5455, 2), le(13, 2), enc("salary 150000")]);
  eq(await cats("w.zip", zip1("a.txt", enc("clean"), ut)), ["body"], "a value in an extra payload is found");
});

Deno.test("124a review 13: the gzip FEXTRA field is read", async () => {
  const g = new Uint8Array(zlib.gzipSync(enc("clean")));
  const x = enc("salary 150000");
  const withExtra = cat([g.subarray(0, 3), new Uint8Array([g[3] | 4]), g.subarray(4, 10), le(x.length, 2), x, g.subarray(10)]);
  eq(await cats("a.gz", withExtra), ["body"], "FEXTRA");
});

Deno.test("124a review 13: PDF metadata and attachments are read; redrawn codes and predictor streams are unreadable", async () => {
  eq(await cats("m.pdf", pdf("/Type/Metadata/Subtype/XML/Filter/FlateDecode", new Uint8Array(zlib.deflateSync(enc("<dc:title>salary 150000</dc:title>"))))), ["body"], "XMP metadata");
  eq(await cats("m.pdf", pdf("/Type/EmbeddedFile/Filter/FlateDecode", new Uint8Array(zlib.deflateSync(enc("salary 150000"))))), ["body"], "embedded text file");
  const docx = zipSync({ "word/document.xml": strToU8("<w:t>salary 150000</w:t>") });
  eq(await cats("m.pdf", pdf("/Type/EmbeddedFile/Filter/FlateDecode", new Uint8Array(zlib.deflateSync(docx)))), ["body"], "embedded docx");
  eq(await cats("m.pdf", cat([enc("%PDF-1.4\n1 0 obj\n<</Type/Font/Subtype/Type1/Encoding<</Differences[97/one/five/zero]>>>>\nendobj\n"), pdf("/Filter/FlateDecode", new Uint8Array(zlib.deflateSync(enc("BT (abcccc) Tj ET"))))])), ["unreadable container"], "Differences redraw");
  eq(await cats("m.pdf", pdf("/Filter/FlateDecode/DecodeParms<</Predictor 12/Columns 4>>", new Uint8Array(zlib.deflateSync(enc("BT (hi) Tj ET"))))), ["unreadable container"], "a predictor stream");
  eq(await cats("m.pdf", pdf("/Filter/FlateDecode", new Uint8Array(zlib.deflateSync(enc("BT 72 720 Td (hello) Tj ET"))))), [], "an ordinary content stream with layout numbers stays clean");
});

Deno.test("124a review 13: a stored zip inside a zip is not a second end record", async () => {
  const inner = zipSync({ "word/document.xml": strToU8("<w:t>hello</w:t>") }, { level: 0 });
  eq(await cats("outer.zip", zipSync({ "inner.docx": inner }, { level: 0 })), [], "stored nested zip is clean");
});
