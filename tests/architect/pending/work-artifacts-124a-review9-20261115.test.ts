// WO-124a ninth review (2026-11-15), under D-088's structural bar: a comma that is not a US thousands group, PDF
// stream starts readers accept, a PDF or zip that does not start at byte 0, and text in zip and gzip headers.
// Earlier tests are unchanged. Fixtures are invented.
import { gzipSync, strToU8, zipSync, zlibSync } from "npm:fflate@0.8.2";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";
import * as proof from "../../../supabase/functions/_shared/work/proof.ts";

function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
const enc = (s: string) => new TextEncoder().encode(s);
const hits = async (files: Record<string, Uint8Array>, v: string | number) => (await revoke.scan(files, [v]));
const cat = (b: Uint8Array[]) => { const o = new Uint8Array(b.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of b) { o.set(x, i); i += x.length; } return o; };

Deno.test("124a review 9 B1: a decimal comma is not a thousands group; both readings are searched", async () => {
  eq((await hits({ "a.xml": enc("Churn rose 15% this year") }, "1,5%")).length, 1, "1,5% is read as 15 too (fail closed)");
  eq((await hits({ "a.xml": enc("Churn was 1.5% this year") }, "1,5%")).length, 1, "and as 1.5");
  eq((await hits({ "a.xml": enc("Net 1500 this year") }, "EUR 1.500")).length, 1, "a European group is 1500 too");
  eq((await hits({ "a.xml": enc("Net 150000 a year") }, "150,000")).length, 1, "a US group still parses");
});

Deno.test("124a review 9 B2: PDF stream starts with a lone CR or trailing spaces are read", async () => {
  for (const eol of ["\r", " \n", " \r\n", "\t\n"]) {
    const body = zlibSync(strToU8("BT (Net 17280) Tj ET"));
    const pdf = cat([enc(`%PDF-1.4\n1 0 obj\n<</Length ${body.length}/Filter/FlateDecode>>\nstream${eol}`), body, enc("\nendstream\nendobj\n%%EOF")]);
    eq((await hits({ "m.pdf": pdf }, 17280)).length, 1, JSON.stringify(eol));
  }
});

Deno.test("124a review 9 B2: a Flate stream that is not inflated is never read as clean", async () => {
  const body = zlibSync(strToU8("BT (Net 17280) Tj ET"));
  const pdf = cat([enc(`%PDF-1.4\n1 0 obj\n<</Length ${body.length}/Filter/FlateDecode>>\nstream`), body, enc("\nendstream\nendobj\n%%EOF")]);
  eq((await hits({ "m.pdf": pdf }, 17280)).map((h) => h.category), ["unreadable container"], "no end of line after stream");
  const junk = cat([enc("%PDF-1.4\n1 0 obj\n<</Length 9>>\nstream\n"), new Uint8Array([1, 2, 3, 0x78, 0x9c, 4, 5, 6, 7]), enc("\nendstream\nendobj\n%%EOF")]);
  eq((await hits({ "m.pdf": junk }, 17280)).map((h) => h.category), ["unreadable container"], "binary bytes that do not inflate");
});

Deno.test("124a review 9 B2: a PDF or a zip that does not start at byte 0 is still opened", async () => {
  const body = zlibSync(strToU8("BT (Net 17280) Tj ET"));
  const pdf = cat([enc(`junk header\n%PDF-1.4\n1 0 obj\n<</Length ${body.length}/Filter/FlateDecode>>\nstream\n`), body, enc("\nendstream\nendobj\n%%EOF")]);
  eq((await hits({ "m.pdf": pdf }, 17280)).length, 1, "%PDF after a prefix");
  const zip = cat([enc("MZ stub "), zipSync({ "word/document.xml": strToU8("<w:t>Net 17280</w:t>") })]);
  eq((await hits({ "w.docx": zip }, 17280)).length >= 1, true, "a zip with a prefix");
});

Deno.test("124a review 9 B2: zip comments and the gzip stored name are scanned", async () => {
  const z = zipSync({ "a.txt": strToU8("clean") });
  // Write an archive comment into the end-of-central-directory record.
  const comment = enc("Net 17280");
  const withComment = cat([z.subarray(0, z.length - 2), new Uint8Array([comment.length, 0]), comment]);
  eq((await hits({ "w.zip": withComment }, 17280)).length, 1, "archive comment");
  const g = gzipSync(strToU8("clean"), { filename: "Net 17280.txt" });
  eq((await hits({ "a.gz": g }, 17280)).length, 1, "gzip stored file name");
});

Deno.test("124a review 9 N1/N2: a sibling check not run blocks a success claim; 'failed 0 times' is a success claim", () => {
  const rep = proof.report([{ name: "tests run in sandbox", ran: true, ok: true }, { name: "tests run in sandbox (second suite)", ran: false } as never,
    { name: "formulas recomputed independently", ran: true, ok: false }], []);
  eq(proof.boundClaims("Tests pass.", rep).ok, false, "a test check did not run");
  const rep2 = proof.report([{ name: "tests run in sandbox", ran: true, ok: false }], []);
  eq(proof.boundClaims("Tests were not run here and failed 0 times.", rep2).ok, false, "failed 0 times");
});

Deno.test("124a review 9 (124d B2): an ISO time tail that is not a real time is not a date", async () => {
  const { loose } = await import("../../../supabase/functions/_shared/work/model.ts");
  for (const t of ["on 2026-11-14T99:99 we", "on 2026-11-14T10:00:00.19280 we", "on 2026-11-14T10:00+1928 we", "on 2026-11-14T24:00Z we"]) eq(loose(t, {}).length > 0, true, t);
  for (const t of ["on 2026-11-14T10:00:00.123Z we", "on 2026-11-14T10:00-05:00 we", "on 2026-11-14 we"]) eq(loose(t, {}).length, 0, t);
  eq((await hits({ "a.xml": enc("stamp 2026-11-14T10:00+1728") }, 1728)).length, 1, "a revoked value in a fake offset is not masked");
});
