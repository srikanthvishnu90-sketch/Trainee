// DETERMINISTIC RESUME BYTES (architect ruling 2026-11-10, #673): 148 writes every stream with its own pure-JS deflate
// (deflateFixed, fixed settings) on Node and on Deno, so the same document is the same file on both. Before, Deno's
// node:zlib and Node's zlib agreed on 14 of the resume loop's 27 plain-layout PDFs. The bar is 27/27. Offline and free.
// deno-lint-ignore-file no-explicit-any
import * as zlib from "node:zlib";
import { Buffer } from "node:buffer";
import { bytesParity } from "../../scripts/resume-bytes-parity.ts";
import { CareerRender } from "../../supabase/functions/_shared/router_core.career.js";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
const R = CareerRender as any; // the bundle's default instance: no host zlib, the vendored codec only

Deno.test("bytes parity/1 the deterministic deflate round-trips through Node's own inflater, for text, repeats, binary and empty input", () => {
  const rnd = new Uint8Array(70000); let x = 7; for (let i = 0; i < rnd.length; i++) { x = (x * 1103515245 + 12345) >>> 0; rnd[i] = x >>> 24; }
  const cases = [new Uint8Array(0), Buffer.from("a"), Buffer.from("BT /F1 10.5 Tf 1 0 0 1 54 700 Tm (Python, SQL) Tj ET\n".repeat(400), "latin1"), Buffer.alloc(100000, 0x41), rnd];
  for (const c of cases) {
    const z = Buffer.from(R.primitives.deflate(c));
    assert(Buffer.from(zlib.inflateSync(z)).equals(Buffer.from(c)), `round trip ${c.length} bytes`);
    assert(Buffer.from(R.primitives.deflate(c)).equals(z), "same input, same bytes");
  }
  const text = cases[2];
  assert(R.primitives.deflate(text).length < text.length / 4, "it compresses repeated PDF operators");
});

Deno.test("bytes parity/2 the resume loop's 27 plain-layout PDFs are byte-identical rendered in Deno and in Node", async () => {
  const r = await bytesParity();
  console.log(`BYTES PARITY: ${r.same}/${r.total} byte-identical (Deno vs Node)`);
  assert(r.total === 27 && r.same === r.total, `differ: ${r.differ.join("; ")}`);
});
