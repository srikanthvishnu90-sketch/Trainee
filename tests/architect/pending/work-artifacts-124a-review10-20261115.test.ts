// WO-124a tenth review (2026-11-15), under D-088's structural bar: one separator before three digits read both ways, a percent's
// fraction form kept on each reading, encrypted zip entries, multi-member gzip, and "stream" only after a dictionary.
// Earlier test files unchanged. Fixtures are invented.
import { gzipSync, strToU8, zipSync, zlibSync } from "npm:fflate@0.8.2";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const enc = (s: string) => new TextEncoder().encode(s);
const hits = async (files: Record<string, Uint8Array>, v: string | number) => await revoke.scan(files, [v]);
const cat = (b: Uint8Array[]) => { const o = new Uint8Array(b.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of b) { o.set(x, i); i += x.length; } return o; };

Deno.test("124a review 10: one separator before three digits is searched both ways", async () => {
  for (const [v, t] of [["1.500", "Net 1500"], ["€1.500", "Fee €1500"], ["17.280", "Net 17280"], ["2.500%", "x 2500%"], ["1,500", "Rate 1.5"], ["1,500", "Net 1500"]]) {
    eq((await hits({ "a.xml": enc(t) }, v)).length, 1, `${v} in ${t}`);
  }
});

Deno.test("124a review 10: a decimal-comma percent is found as its stored fraction", async () => {
  eq((await hits({ "xl/worksheets/sheet1.xml": enc("<c><v>0.015</v></c>") }, "1,5%")).length, 1, "1,5% as 0.015");
  eq((await hits({ "xl/worksheets/sheet1.xml": enc("<c><v>0.125</v></c>") }, "12,5%")).length, 1, "12,5% as 0.125");
});

Deno.test("124a review 10: an encrypted zip entry and a second gzip member are never read as clean", async () => {
  const z = zipSync({ "a.txt": [strToU8("Net 17280"), { level: 0 }] });
  // Set the encryption flag in the local and the central header, and garble the stored data as a cipher would.
  const e = z.slice();
  for (let i = 0; i + 3 < e.length; i++) {
    if (e[i] === 0x50 && e[i + 1] === 0x4b && e[i + 2] === 0x03 && e[i + 3] === 0x04) e[i + 6] |= 1;
    if (e[i] === 0x50 && e[i + 1] === 0x4b && e[i + 2] === 0x01 && e[i + 3] === 0x02) e[i + 8] |= 1;
  }
  const at = new TextDecoder("latin1").decode(e).indexOf("Net 17280");
  for (let i = at; i < at + 9; i++) e[i] ^= 0x5a;
  eq((await hits({ "w.zip": e }, 17280)).map((h) => h.category), ["unreadable container"], "encrypted entry");
  eq((await hits({ "a.gz": cat([gzipSync(strToU8("clean ")), gzipSync(strToU8("Net 17280"))]) }, 17280)).length, 1, "second member");
  eq((await hits({ "a.gz": cat([gzipSync(strToU8("clean ")), enc("junk")]) }, 17280)).map((h) => h.category), ["unreadable container"], "bytes after the trailer");
  eq((await hits({ "a.gz": gzipSync(strToU8("clean text")) }, 17280)).length, 0, "one clean member is clean");
});

Deno.test("124a review 10: the word 'stream' in a PDF string is not a stream start; a timestamp at a sentence end is masked", async () => {
  const body = zlibSync(strToU8("BT (Hello) Tj ET"));
  const pdf = cat([enc(`%PDF-1.4\n1 0 obj\n<</Title (Revenue stream review)>>\nendobj\n2 0 obj\n<</Length ${body.length}/Filter/FlateDecode>>\nstream\n`), body, enc("\nendstream\nendobj\n%%EOF")]);
  eq((await hits({ "m.pdf": pdf }, "Acme Corp")).length, 0, "a clean PDF with 'stream' in its title");
  eq((await hits({ "a.xml": enc("Created 2026-11-14T10:00:00.") }, 14)).length, 0, "a timestamp before a full stop");
});
