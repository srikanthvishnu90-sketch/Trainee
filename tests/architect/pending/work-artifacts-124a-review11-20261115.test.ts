// WO-124a eleventh review (2026-11-15), under D-088's structural bar: a PDF comment before "stream", zip entries with duplicate
// names or a false size, a gzip with a false size or a forged trailer, an entity past the last code point, and fewer false
// blocks for money written with a thousands group. Earlier test files unchanged. Fixtures are invented.
import zlib from "node:zlib";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const enc = (s: string) => new TextEncoder().encode(s);
const hits = async (files: Record<string, Uint8Array>, v: string | number) => await revoke.scan(files, [v]);
const cats = async (files: Record<string, Uint8Array>, v: string | number) => (await hits(files, v)).map((h) => h.category);
const cat = (b: Uint8Array[]) => { const o = new Uint8Array(b.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of b) { o.set(x, i); i += x.length; } return o; };
const T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const le = (n: number, w: number) => { const o = new Uint8Array(w); for (let i = 0; i < w; i++) o[i] = (n >>> (8 * i)) & 0xff; return o; };
// A zip written by hand: [name, data, deflate?, stated uncompressed size override]
function zip(entries: [string, string, boolean, number?][]): Uint8Array {
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = []; let off = 0;
  for (const [name, text, deflate, usizeLie] of entries) {
    const data = enc(text), body = deflate ? new Uint8Array(zlib.deflateRawSync(data)) : data, nm = enc(name);
    const usize = usizeLie ?? data.length, method = deflate ? 8 : 0, c = crc(data);
    const head = cat([le(0x04034b50, 4), le(20, 2), le(0, 2), le(method, 2), le(0, 4), le(c, 4), le(body.length, 4), le(usize, 4), le(nm.length, 2), le(0, 2), nm]);
    centrals.push(cat([le(0x02014b50, 4), le(20, 2), le(20, 2), le(0, 2), le(method, 2), le(0, 4), le(c, 4), le(body.length, 4), le(usize, 4), le(nm.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(off, 4), nm]));
    locals.push(head, body); off += head.length + body.length;
  }
  const cd = cat(centrals);
  return cat([...locals, cd, le(0x06054b50, 4), le(0, 2), le(0, 2), le(entries.length, 2), le(entries.length, 2), le(cd.length, 4), le(off, 4), le(0, 2)]);
}

Deno.test("124a review 11: a comment between '>>' and 'stream' does not hide a stream", async () => {
  const body = new Uint8Array(zlib.deflateSync(enc("BT (Net 17280) Tj ET")));
  const pdf = cat([enc(`%PDF-1.4\n1 0 obj\n<</Length ${body.length}/Filter/FlateDecode>>\n%c\nstream\n`), body, enc("\nendstream\nendobj\n%%EOF")]);
  eq((await hits({ "m.pdf": pdf }, 17280)).length, 1, "found");
});

Deno.test("124a review 11: zip entries are read from the central directory; duplicates and false sizes are unreadable", async () => {
  eq((await hits({ "w.zip": zip([["a.txt", "clean", false], ["b.txt", "Net 17280", true]]) }, 17280)).length, 1, "a hand-written zip is read");
  eq(await cats({ "w.zip": zip([["a.txt", "Net 17280", false], ["a.txt", "clean", false]]) }, 17280), ["unreadable container"], "duplicate names");
  eq(await cats({ "w.zip": zip([["a.txt", "clean text and Net 17280", true, 5]]) }, 17280), ["unreadable container"], "a false uncompressed size");
  eq((await hits({ "w.zip": zip([["a.txt", "clean", true]]) }, 17280)).length, 0, "a clean zip is clean");
});

Deno.test("124a review 11: every gzip member is read to its end; a false size or a forged trailer is unreadable", async () => {
  const g = new Uint8Array(zlib.gzipSync(enc("clean text then Net 17280")));
  const lie = g.slice(); lie.set(le(10, 4), lie.length - 4);
  eq(await cats({ "a.gz": lie }, 17280), ["unreadable container"], "a false size");
  const first = new Uint8Array(zlib.gzipSync(enc("clean ")));
  eq(await cats({ "a.gz": cat([first, enc("Net 17280 "), le(6, 4)]) }, 17280), ["unreadable container"], "text and a forged size after a member");
  eq(await cats({ "a.gz": cat([first, new Uint8Array(zlib.deflateRawSync(enc("Net 17280"))), le(6, 4)]) }, 17280), ["unreadable container"], "deflate data after a member");
  eq((await hits({ "a.gz": cat([first, new Uint8Array(zlib.gzipSync(enc("Net 17280")))]) }, 17280)).length, 1, "a second member is read");
});

Deno.test("124a review 11: money written with a thousands group is not also its bare leading number; a big entity does not throw", async () => {
  for (const [v, t] of [["$150,000", "Team of 150 people"], ["$10,000", "Top 10 risks"], ["$12,000", "Over 12 months"], ["$1,500", "Line spacing 1.5"], ["USD 150,000", "Team of 150 people"]]) {
    eq((await hits({ "a.xml": enc(t) }, v)).length, 0, `${v} vs ${t}`);
  }
  eq((await hits({ "a.xml": enc("Pay $150,000 a year") }, "$150,000")).length, 1, "still found");
  eq((await hits({ "a.xml": enc("x &#x110000; &#99999999999; y") }, 17280)).length, 0, "no throw");
  eq((await hits({ "xl/worksheets/sheet1.xml": enc("<c><v>0.015</v></c>") }, "1,5 percent")).length, 1, "a percent word");
});
