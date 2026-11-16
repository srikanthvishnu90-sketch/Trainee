// WO-124a fifteenth review (2026-11-15), re-scoped by the owner's ruling: WO-124a delivers only files Trainee's own writers
// produce. A provenance record (sha256 of each written file, kept per case) gates deliver(): outside bytes are refused
// whatever the revoke scan says, and a Trainee-written file is refused when the scan finds a revoked value or cannot read
// it. The scan itself never throws and finishes within its budget on any input (B2 decoded-byte budget and whole-scan
// guard, B3/B4 linear PDF and markup scanning). Writers are stubs here (the real ones are WO-124b-d). Earlier test files
// unchanged. Fixtures are invented.
import { strToU8, zipSync, zlibSync } from "npm:fflate@0.8.2";
import * as kase from "../../../supabase/functions/_shared/work/case.ts";
import * as revoke from "../../../supabase/functions/_shared/work/revoke_scan.ts";
import * as deliverMod from "../../../supabase/functions/_shared/work/deliver.ts";

// The provenance module is new this round; it is loaded per test so each test fails on its own where it is missing.
const prov = () => import("../../../supabase/functions/_shared/work/" + "provenance.ts");
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function assert(c: unknown, m: string) { if (!c) throw new Error(m); }
const enc = (s: string) => new TextEncoder().encode(s);
const cat = (b: Uint8Array[]) => { const o = new Uint8Array(b.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of b) { o.set(x, i); i += x.length; } return o; };
const NAME = "Jordan Pike";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// ---- fixtures: outside files (the reviewer's round-15 probe shapes) ----
const T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Uint8Array) => { const o = new Uint8Array(12 + data.length), v = new DataView(o.buffer); v.setUint32(0, data.length); o.set(enc(type), 4); o.set(data, 8); v.setUint32(8 + data.length, crc(o.subarray(4, 8 + data.length))); return o; };
const ihdr = (() => { const h = new Uint8Array(13), v = new DataView(h.buffer); v.setUint32(0, 1); v.setUint32(4, 1); h[8] = 8; return h; })();
const png = (...meta: Uint8Array[]) => cat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), ...meta, chunk("IDAT", zlibSync(new Uint8Array([0, 0]))), chunk("IEND", new Uint8Array())]);
const seg = (mk: number, data: Uint8Array) => cat([new Uint8Array([0xff, mk, (data.length + 2) >> 8, (data.length + 2) & 0xff]), data]);
const jpeg = (...meta: Uint8Array[]) => cat([new Uint8Array([0xff, 0xd8]), seg(0xe0, cat([enc("JFIF\0"), new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0])])), ...meta,
  seg(0xdb, new Uint8Array(65)), seg(0xc0, new Uint8Array([8, 0, 1, 0, 1, 1, 1, 0x11, 0])), seg(0xc4, new Uint8Array(29)), seg(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0])),
  new Uint8Array([0x12, 0xff, 0x00, 0x34]), new Uint8Array([0xff, 0xd9])]);
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
const HELV = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
const page = (content: string, body?: Uint8Array): Record<number, Obj> => ({
  1: "<< /Type /Catalog /Pages 2 0 R >>",
  2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 8 0 R >> >> /Contents 4 0 R >>",
  4: ["<< /Filter /FlateDecode >>", body ?? zlibSync(enc(content))],
  8: HELV,
});
const docx = (extra: Record<string, Uint8Array> = {}, body = "See the chart") => zipSync({
  "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types/>'),
  "word/document.xml": strToU8(`<w:document><w:body><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:body></w:document>`), ...extra });

// ---- a case with a revoked name, and stub writers ----
function revokedCase(values: string[] = [NAME]) {
  const c = kase.newCase({ owner: "u1", practice: false, title: "memo", now: 1 });
  kase.addRound(c, { round: 1, text: "use the name", constraints: [{ id: "k1", kind: "hard", text: "name the lead", values }] });
  kase.addRound(c, { round: 2, text: "take it back", constraints: [{ id: "k2", kind: "hard", text: "do not name them", revokes: "k1" }] });
  return c;
}
// Review 17 (B1) closed the set of writers structurally: provenance.ts imports each real writer and exposes fixed handles
// (WRITERS.xlsx); there is no mint and no factory. The stub docx/pdf writers these tests used (they named docs.ts's URL)
// are replaced by the real xlsx writer, the only writer on this branch. API rename only: every assertion is as strong.
type B = { sheets: { name: string; cells: Record<string, { v: string | number }> }[]; charts: never[]; names?: Record<string, string>; expected: Record<string, never> };
// The memo as a workbook: each text line a cell, plus the number cell. `names` are defined names the writer draws.
const memo = (text: string[], names?: Record<string, string>): B => ({
  sheets: [{ name: "Memo", cells: { A1: { v: 12 }, ...Object.fromEntries(text.map((t, i) => [`A${i + 2}`, { v: t }])) } }],
  charts: [], expected: {}, ...(names ? { names } : {}),
});
const xlsxWriter = async () => (await prov()).WRITERS.xlsx;
function io() {
  const calls: string[] = [];
  return {
    calls,
    io: {
      sendFile: (_f: deliverMod.WorkFile) => { calls.push("sendFile"); return Promise.resolve({ ok: true }); },
      filePage: (_f: deliverMod.WorkFile) => { calls.push("filePage"); return Promise.resolve("https://trainee.example/f/1"); },
      sendText: (_t: string) => { calls.push("sendText"); return Promise.resolve({ ok: true }); },
    },
  };
}
// deliver() with the case; on an older deliver() the extra argument is ignored, and the file goes out.
const send = (f: deliverMod.WorkFile, x: ReturnType<typeof io>, c: kase.WorkCase) =>
  (deliverMod.deliver as unknown as (...a: unknown[]) => Promise<deliverMod.DeliverResult>)("whatsapp", f, x.io, c);
const timed = async (files: Record<string, Uint8Array>, values: revoke.RevokedValue[] = [NAME]) => {
  const t = performance.now();
  const cats = [...new Set((await revoke.scan(files, values)).map((h) => h.category))].sort();
  return { cats, ms: performance.now() - t };
};

// ---- the provenance gate ----
Deno.test("124a review 15 gate: outside files are refused by deliver() whatever the scan says, before any send", async () => {
  const c = revokedCase();
  const outside: [string, string, Uint8Array][] = [
    ["clean PNG", "image/png", png(chunk("tEXt", enc("k\0hello")))],
    ["PNG with the name in a tIME chunk (scan reads it clean)", "image/png", png(chunk("tIME", cat([new Uint8Array(7), enc(NAME)])))],
    ["JPEG with the name in APP14 (scan reads it clean)", "image/jpeg", jpeg(seg(0xee, enc("Adobe\0d\0\0\0\0\x01" + NAME)))],
    ["clean PDF", "application/pdf", pdf(page("BT /F1 12 Tf (Hello) Tj ET"))],
    ["PDF with the name split literal+hex (scan reads it clean)", "application/pdf", pdf(page("BT /F1 12 Tf [(Jor)<64616e>( Pike)] TJ ET"))],
    ["clean docx", DOCX, docx()],
  ];
  for (const [label, mime, bytes] of outside) {
    const x = io();
    const r = await send({ filename: "f", mime, bytes }, x, c);
    eq(x.calls, [], `${label}: nothing is sent`);
    assert(!r.ok, `${label}: refused`);
  }
});

Deno.test("124a review 15 gate: a file Trainee wrote for one case is not deliverable in another, nor after one byte changes", async () => {
  const p = await prov();
  const a = revokedCase(), b = revokedCase();
  const w = await xlsxWriter();
  const r = await p.write(a, w, memo(["Quarterly memo"]));
  assert(r.ok, "the clean memo is written");
  const f = (r as { files: deliverMod.WorkFile[] }).files[0];
  const x1 = io();
  assert(!(await send(f, x1, b)).ok && !x1.calls.length, "another case: refused, nothing sent");
  const changed = new Uint8Array(f.bytes); changed[changed.length - 1] ^= 1;
  const x2 = io();
  assert(!(await send({ ...f, bytes: changed }, x2, a)).ok && !x2.calls.length, "one byte changed: refused, nothing sent");
  const forged = Object.freeze({ kind: "xlsx" as const });
  eq((await p.write(a, forged, memo(["x"]))).ok, false, "an object shaped like a writer is not one");
});

Deno.test("124a review 15 gate: a Trainee-written file is delivered when clean", async () => {
  const p = await prov();
  const c = revokedCase();
  for (const w of [await xlsxWriter()]) {
    const r = await p.write(c, w, memo(["Quarterly memo for the team"]));
    assert(r.ok, `${w.kind}: written`);
    const f = (r as { files: deliverMod.WorkFile[] }).files[0];
    assert(p.writtenFor(c, f.bytes), `${w.kind}: its hash is recorded with the case`);
    const x = io();
    const d = await send(f, x, c);
    assert(d.ok && d.how === "native", `${w.kind}: delivered natively`);
    eq(x.calls, ["sendFile"], `${w.kind}: sent once`);
  }
});

Deno.test("124a review 15 gate: a revoked value in the source model is refused before rendering", async () => {
  const p = await prov();
  const c = revokedCase();
  // The real writer cannot count its runs, so the model is one the writer refuses to render (a sheet name Excel refuses):
  // had it run first, the result would be "writer failed". The source refusal proves the check came before any render.
  const w = await xlsxWriter();
  const unrenderable = { ...memo([`Lead: ${NAME}`]), sheets: [{ name: "Bad/Name", cells: { A1: { v: `Lead: ${NAME}` } } }] };
  const ctl = await p.write(kase.newCase({ owner: "u1", practice: false, title: "memo", now: 1 }), w, unrenderable);
  eq([ctl.ok, (ctl as { why: string }).why], [false, "writer failed"], "control: with nothing revoked, the render runs and fails");
  const r = await p.write(c, w, unrenderable);
  eq([r.ok, (r as { why: string }).why === "writer failed"], [false, false], "refused, and the writer never ran");
  eq((r as { why: string }).why, "source holds a revoked value", "the reason");
});

Deno.test("124a review 15 gate: a Trainee-written file holding a revoked value is refused (at write, and at deliver after a later revoke)", async () => {
  const p = await prov();
  // The writer adds the value itself (not in the model): the scan of the rendered bytes refuses it, and nothing is recorded.
  const c = revokedCase();
  // A defined name is a key the writer draws, not a value the source check reads ("Jordan_Pike" is the name's
  // separator form, which the scan matches).
  const r = await p.write(c, await xlsxWriter(), memo(["Quarterly memo"], { Jordan_Pike: "Memo!$A$1" }));
  eq([r.ok, (r as { why: string }).why], [false, "file holds a revoked value"], "refused at write");
  // Written while the value was allowed, revoked afterwards: deliver() scans again and refuses.
  const c2 = kase.newCase({ owner: "u1", practice: false, title: "memo", now: 1 });
  kase.addRound(c2, { round: 1, text: "use the name", constraints: [{ id: "k1", kind: "hard", text: "name the lead", values: [NAME] }] });
  const r2 = await p.write(c2, await xlsxWriter(), memo([`Lead: ${NAME}`]));
  assert(r2.ok, "written while allowed");
  kase.addRound(c2, { round: 2, text: "take it back", constraints: [{ id: "k2", kind: "hard", text: "do not name them", revokes: "k1" }] });
  const x = io();
  const d = await send((r2 as { files: deliverMod.WorkFile[] }).files[0], x, c2);
  eq([d.ok, x.calls], [false, []], "refused at deliver, nothing sent");
  assert(!d.note.includes(NAME), "the refusal never repeats the value");
});

// ---- B2: a decoded-byte budget; the scan never throws ----
Deno.test("124a review 15 B2: overlapping Exif entries hit the budget and read unreadable, within 2 s, never a throw", async () => {
  const exif = (N: number, L: number) => {
    const hdr = 8 + 2 + 12 * N + 4, b = new Uint8Array(hdr + L), v = new DataView(b.buffer);
    b.set([0x4d, 0x4d]); v.setUint16(2, 42); v.setUint32(4, 8); v.setUint16(8, N);
    for (let k = 0; k < N; k++) { const e = 10 + 12 * k; v.setUint16(e, 0x9286); v.setUint16(e + 2, 7); v.setUint32(e + 4, L); v.setUint32(e + 8, hdr); }
    b.fill(0x41, hdr);
    return b;
  };
  for (const [label, file] of [
    ["PNG eXIf, 400 tags x 1 MB", { "a.docx": docx({ "word/media/i.png": png(chunk("eXIf", exif(400, 1 << 20))) }) }],
    ["JPEG Exif, 2000 tags x 40 KB", { "a.docx": docx({ "word/media/i.jpeg": jpeg(seg(0xe1, cat([enc("Exif\0\0"), exif(2000, 40000)]))) }) }],
  ] as const) {
    let r;
    try { r = await timed(file); } catch (e) { throw new Error(`${label}: threw ${String(e).slice(0, 80)}`); }
    eq(r.cats, ["unreadable container"], `${label}: unreadable`);
    assert(r.ms < 2000, `${label}: ${Math.round(r.ms)} ms`);
  }
});

Deno.test("124a review 15 B2: any error inside the scan is every file unreadable, never a throw", async () => {
  let hits;
  try { hits = await revoke.scan({ "a.docx": null as unknown as Uint8Array, "b.txt": enc("ok") }, [NAME]); }
  catch (e) { throw new Error(`threw ${String(e).slice(0, 80)}`); }
  eq([...new Set(hits.map((h) => h.category))], ["unreadable container"], "fail closed");
});

// ---- B3/B4: linear time ----
Deno.test("124a review 15 B3: PDF value dictionaries are lexed to their own close, not to the end of the file (< 2 s)", async () => {
  const many = "<< " + "/Font << >> ".repeat(20000) + ">>";
  const fonts = "<< /Font << " + Array.from({ length: 10000 }, (_, i) => `/F${i} << /Subtype /Type1 /BaseFont /Helvetica >>`).join(" ") + " >> >>";
  for (const [label, d] of [["20k inline /Font", many], ["10k inline fonts", fonts]]) {
    const r = await timed({ "m.pdf": pdf({ 1: d }) });
    assert(r.ms < 2000, `${label}: ${Math.round(r.ms)} ms`);
  }
});

Deno.test("124a review 15 B4: unclosed '(' and '<' are scanned in linear time (< 2 s)", async () => {
  const cases: [string, Record<string, Uint8Array>][] = [
    ["PDF content stream of 100k '('", { "m.pdf": pdf(page("(".repeat(100000))) }],
    ["PDF raw stream of 100k '('", { "m.pdf": pdf({ 1: "<< /Type /Catalog >>", 4: ["<< >>", enc("(".repeat(100000))] }) }],
    ["text part of 100k '<a', no '>'", { "a.txt": enc("<a".repeat(100000)) }],
    ["docx with 100k 'x<', no '>'", { "a.docx": docx({ "word/notes.txt": enc("x<".repeat(100000)) }) }],
  ];
  for (const [label, f] of cases) {
    const r = await timed(f);
    assert(r.ms < 2000, `${label}: ${Math.round(r.ms)} ms`);
  }
  // The control still finds the value.
  eq((await timed({ "m.pdf": pdf(page(`BT /F1 12 Tf (${NAME}) Tj ET`)) })).cats, ["body"], "a plain Tj is still read");
});
