// WO-124a twelfth review (2026-11-15), under D-088's structural bar: a zip is opened only when every byte is accounted for
// (bytes before it, gaps, hidden entries, count or size mismatches, local names, unknown extra fields, a second end record
// are all unreadable). Earlier test files unchanged. Fixtures are invented.
import { strToU8, zipSync } from "npm:fflate@0.8.2";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const enc = (s: string) => new TextEncoder().encode(s);
const cats = async (f: Uint8Array) => [...new Set((await revoke.scan({ "w.zip": f }, [150000])).map((h) => h.category))];
const cat = (b: Uint8Array[]) => { const o = new Uint8Array(b.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of b) { o.set(x, i); i += x.length; } return o; };
const T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const le = (n: number, w: number) => { const o = new Uint8Array(w); for (let i = 0; i < w; i++) o[i] = (n >>> (8 * i)) & 0xff; return o; };
type E = { name: string; text: string; localName?: string; localSize?: number; extra?: Uint8Array; listed?: boolean };
// A stored zip written by hand, with ways to make it lie.
function zip(es: E[], o: { prefix?: Uint8Array; gap?: Uint8Array; count?: number; comment?: Uint8Array } = {}): Uint8Array {
  const parts: Uint8Array[] = [o.prefix ?? new Uint8Array()], cds: Uint8Array[] = []; let off = (o.prefix ?? new Uint8Array()).length;
  for (const e of es) {
    const d = enc(e.text), c = crc(d), nm = enc(e.name), ln = enc(e.localName ?? e.name), x = e.extra ?? new Uint8Array();
    const h = cat([le(0x04034b50, 4), le(20, 2), le(0, 2), le(0, 2), le(0, 4), le(c, 4), le(e.localSize ?? d.length, 4), le(e.localSize ?? d.length, 4), le(ln.length, 2), le(x.length, 2), ln, x]);
    if (e.listed !== false) cds.push(cat([le(0x02014b50, 4), le(20, 2), le(20, 2), le(0, 2), le(0, 2), le(0, 4), le(c, 4), le(d.length, 4), le(d.length, 4), le(nm.length, 2), le(x.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(off, 4), nm, x]));
    parts.push(h, d); off += h.length + d.length;
  }
  if (o.gap) { parts.push(o.gap); off += o.gap.length; }
  const cd = cat(cds), cm = o.comment ?? new Uint8Array(), n = o.count ?? cds.length;
  return cat([...parts, cd, le(0x06054b50, 4), le(0, 2), le(0, 2), le(n, 2), le(n, 2), le(cd.length, 4), le(off, 4), le(cm.length, 2), cm]);
}
const eocd = cat([le(0x06054b50, 4), new Uint8Array(18)]);

Deno.test("124a review 12: an honest hand-written zip is read; every lie in its structure is unreadable", async () => {
  eq(await cats(zip([{ name: "a.txt", text: "clean" }, { name: "b.txt", text: "salary 150000" }])), ["body"], "honest");
  eq(await cats(zip([{ name: "a.txt", text: "clean" }])), [], "honest and clean");
  const U = ["unreadable container"];
  eq(await cats(cat([enc("salary 150000 per year\n"), eocd])), U, "text with an empty end record");
  eq(await cats(zip([{ name: "a.txt", text: "clean" }], { prefix: enc("salary 150000 ") })), U, "bytes before the first entry");
  eq(await cats(zip([{ name: "a.txt", text: "clean" }], { gap: enc("salary 150000") })), U, "a gap before the directory");
  eq(await cats(zip([{ name: "a.txt", text: "clean" }, { name: "b.txt", text: "salary 150000", listed: false }])), U, "a local entry the directory does not list");
  eq(await cats(zip([{ name: "a.txt", text: "clean" }, { name: "b.txt", text: "salary 150000" }], { count: 1 })), U, "an end-record count below the records");
  eq(await cats(zip([{ name: "a.txt", text: "clean", localName: "150000.txt" }])), U, "a local name that is not the central name");
  eq(await cats(zip([{ name: "a.txt", text: "hello", localSize: 19 }])), U, "a local size that is not the central size");
  const upath = cat([le(0x7075, 2), le(5 + 17, 2), new Uint8Array([1]), le(0, 4), enc("salary-150000.txt")]);
  eq(await cats(zip([{ name: "a.txt", text: "clean", extra: upath }])), U, "a Unicode Path extra field");
  eq(await cats(zip([{ name: "a.txt", text: "salary 150000" }], { comment: eocd })), U, "a second end record in the comment");
});

Deno.test("124a review 12: an fflate zip (as docs.ts writes) still reads clean", async () => {
  eq(await cats(zipSync({ "word/document.xml": strToU8("<w:t>hello</w:t>"), "docProps/core.xml": strToU8("<dc:title>Plan</dc:title>") })), [], "clean");
});
