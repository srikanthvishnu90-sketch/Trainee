// WO-124a sixteenth review (2026-11-15). Owner scope ruling: delivery covers only bytes a Trainee writer (124b XLSX,
// 124c ICS, 124d DOCX/PPTX/PDF) produced for that same case.
//  B1: deliver() checked one read of the file and sent another (the caller's buffer changed after the check, or a getter
//      answered differently on a later read). It now reads the file once and sends only its own copy.
//  B2: any code could turn a render function into a "Trainee writer" and launder outside bytes. Writers are now minted
//      only by the writer modules (xlsx.ts, ics.ts, docs.ts), each for its own kinds, and a source gate holds that.
// Review 17 (B1) replaced the mint with fixed handles in provenance.ts (WRITERS.xlsx) and replaced the B2 source gate
// with runtime tests (work-artifacts-124a-review17-20261115.test.ts). The stub pdf writer these tests used is now the
// real xlsx writer; CLEAN is the workbook it writes. API rename only: every assertion is as strong. Fixtures are invented.
import * as kase from "../../../supabase/functions/_shared/work/case.ts";
import * as deliverMod from "../../../supabase/functions/_shared/work/deliver.ts";

const prov = () => import("../../../supabase/functions/_shared/work/" + "provenance.ts");
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function assert(c: unknown, m: string) { if (!c) throw new Error(m); }
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
const NAME = "Jordan Pike";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const WORK = new URL("../../../supabase/functions/_shared/work/", import.meta.url);
type P = Awaited<ReturnType<typeof prov>>;
// The real xlsx writer (the only writer on this branch).
// deno-lint-ignore no-explicit-any
const xlsxWriter = (p: P): any => (p as any).WRITERS.xlsx;
function revokedCase() {
  const c = kase.newCase({ owner: "u1", practice: false, title: "memo", now: 1 });
  kase.addRound(c, { round: 1, text: "r1", constraints: [{ id: "k1", kind: "hard", text: "name", values: [NAME] }] });
  kase.addRound(c, { round: 2, text: "r2", constraints: [{ id: "k2", kind: "hard", text: "no", revokes: "k1" }] });
  return c;
}
const MEMO = { sheets: [{ name: "Memo", cells: { A1: { v: "Quarterly memo, all clean." } } }], charts: [], expected: {} };
// What the writer writes for MEMO, as text (latin1 keeps every byte), so "sent exactly these bytes" compares all of them.
const CLEAN = await (async () => { const p = await prov(); const r = await p.write(kase.newCase({ owner: "u0", practice: false, title: "m", now: 1 }), xlsxWriter(p), MEMO); return dec((r as { files: deliverMod.WorkFile[] }).files[0].bytes); })().catch(() => "unwritten");
async function written(p: P, c: kase.WorkCase) {
  const r = await p.write(c, xlsxWriter(p), MEMO);
  assert(r.ok, "the clean memo is written");
  return (r as { files: deliverMod.WorkFile[] }).files[0];
}
function rails(o: { nativeOk?: boolean; onFile?: (f: deliverMod.WorkFile) => void } = {}) {
  const sent: { rail: string; bytes: string }[] = [];
  return {
    sent,
    io: {
      sendFile: (f: deliverMod.WorkFile) => { sent.push({ rail: "sendFile", bytes: dec(f.bytes) }); o.onFile?.(f); return Promise.resolve({ ok: o.nativeOk ?? true }); },
      filePage: (f: deliverMod.WorkFile) => { sent.push({ rail: "filePage", bytes: dec(f.bytes) }); return Promise.resolve("https://trainee.example/f/1"); },
      sendText: (_t: string) => Promise.resolve({ ok: true }),
    },
  };
}
const send = (f: unknown, io: deliverMod.DeliverIo, c: kase.WorkCase) =>
  (deliverMod.deliver as unknown as (...a: unknown[]) => Promise<deliverMod.DeliverResult>)("whatsapp", f, io, c);

// ---- B1: one read of the file, and only that read is sent ----
Deno.test("124a review 16 B1 (P1): bytes the caller changes after calling deliver() are not what is sent", async () => {
  const p = await prov();
  const c = revokedCase();
  const f = await written(p, c);
  const outside = enc(`OUTSIDE BYTES, ${NAME}, never written by Trainee.....`.padEnd(f.bytes.length, "."));
  const x = rails();
  const pending = send(f, x.io, c);           // the gate and scan run on the bytes as they are now
  f.bytes.set(outside.subarray(0, f.bytes.length)); // the caller's buffer changes while deliver() is suspended
  const d = await pending;
  assert(d.ok, "the Trainee file is still delivered");
  eq(x.sent.map((s) => s.rail), ["sendFile"], "sent once");
  eq(x.sent[0].bytes, CLEAN, "what was sent is exactly what Trainee wrote and the gate checked");
  assert(!x.sent.some((s) => s.bytes.includes(NAME) || s.bytes.includes("OUTSIDE")), "no outside or revoked bytes went out");
});

Deno.test("124a review 16 B1 (P1b): a getter on bytes is read once; it cannot answer Trainee bytes to the check and other bytes to the send", async () => {
  const p = await prov();
  const c = revokedCase();
  const good = (await written(p, c)).bytes;
  const outside = enc(`OUTSIDE BYTES, ${NAME}, never written by Trainee.`);
  let reads = 0;
  const g = { filename: "workbook.xlsx", mime: XLSX, get bytes() { return ++reads <= 4 ? good : outside; } };
  const x = rails();
  const d = await send(g, x.io, c);
  eq(reads, 1, "bytes read exactly once");
  assert(d.ok, "delivered from the one read");
  eq(x.sent.map((s) => s.bytes), [CLEAN], "only the Trainee bytes were sent");
  // Getters on the name and type are read once too, and a getter that throws is a refusal, not a crash.
  let names = 0;
  const h = { get filename() { names++; return "workbook.xlsx"; }, mime: XLSX, bytes: good };
  const x2 = rails();
  assert((await send(h, x2.io, c)).ok && names === 1, "filename read once");
  const bad = { filename: "workbook.xlsx", mime: XLSX, get bytes(): Uint8Array { throw new Error("boom"); } };
  const x3 = rails();
  const r3 = await send(bad, x3.io, c);
  eq([r3.ok, x3.sent.length], [false, 0], "a throwing getter: refused, nothing sent");
  // A Proxy that passes instanceof Uint8Array is not a typed array and is refused before any send.
  const x4 = rails();
  const r4 = await send({ filename: "workbook.xlsx", mime: XLSX, bytes: new Proxy(good, {}) }, x4.io, c);
  eq([r4.ok, x4.sent.length], [false, 0], "a Proxy over the bytes: refused, nothing sent");
});

Deno.test("124a review 16 B1: one rail changing the bytes it was handed cannot change what the next rail sends", async () => {
  const p = await prov();
  const c = revokedCase();
  const f = await written(p, c);
  // The native send changes its buffer and fails; the fallback page must still get the Trainee bytes.
  const x = rails({ nativeOk: false, onFile: (h) => h.bytes.set(enc("OUTSIDE").subarray(0, h.bytes.length)) });
  const d = await send(f, x.io, c);
  eq(x.sent.map((s) => s.rail), ["sendFile", "filePage"], "native refused, then the page");
  assert(d.ok && d.how === "file_page", "delivered on the page");
  eq(x.sent[1].bytes, CLEAN, "the page got exactly the Trainee bytes");
  eq(dec(f.bytes), CLEAN, "and the caller's own buffer was never handed to a rail");
});

// ---- B2: the set of writers is closed ----
Deno.test("124a review 16 B2 (P2): code outside the writer modules cannot mint a writer that launders outside bytes", async () => {
  const p = await prov();
  // deno-lint-ignore no-explicit-any
  const q = p as any;
  const c = kase.newCase({ owner: "u1", practice: false, title: "memo", now: 1 });
  const uploaded = enc("%PDF-1.4 a file the person uploaded, or one fetched from the web");
  const render = () => [{ filename: "upload.pdf", mime: "application/pdf", bytes: uploaded }];
  const attempts: [string, () => unknown][] = [
    ["the round-15 traineeWriter", () => q.traineeWriter({ kind: "pdf", render })],
    ["mintWriter with this test's own import.meta", () => q.mintWriter(import.meta, "pdf", render)],
    ["mintWriter naming provenance.ts", () => q.mintWriter({ url: new URL("provenance.ts", WORK).href }, "pdf", render)],
    ["mintWriter naming deliver.ts", () => q.mintWriter({ url: new URL("deliver.ts", WORK).href }, "pdf", render)],
    ["mintWriter naming a look-alike docs.ts elsewhere", () => q.mintWriter({ url: new URL("../docs.ts", WORK).href }, "pdf", render)],
    ["ics.ts minting a pdf writer (not its kind)", () => q.mintWriter({ url: new URL("ics.ts", WORK).href }, "pdf", render)],
    ["xlsx.ts minting a docx writer (not its kind)", () => q.mintWriter({ url: new URL("xlsx.ts", WORK).href }, "docx", render)],
    ["docs.ts with no render function", () => q.mintWriter(DOCS_META, "pdf", "not a function")],
  ];
  for (const [label, mint] of attempts) {
    let w: unknown = null;
    try { w = mint(); } catch { w = null; }
    const r = await p.write(c, w as never, { cells: [], text: [] });
    eq(r.ok, false, `${label}: nothing is written`);
    let sent = 0;
    const d = await send({ filename: "upload.pdf", mime: "application/pdf", bytes: uploaded },
      { sendFile: () => (sent++, Promise.resolve({ ok: true })), filePage: () => (sent++, Promise.resolve("u")), sendText: () => (sent++, Promise.resolve({ ok: true })) }, c);
    eq([d.ok, sent], [false, 0], `${label}: the uploaded bytes are refused, nothing sent`);
  }
  assert(typeof q.traineeWriter !== "function", "no general writer factory is exported");
});

// The B2 source gate (a grep for mintWriter) was replaced in review 17 by runtime tests: every rv17 probe path (forged
// meta, computed access, an alias, a factory reached through any export) is tried and refused, and provenance.ts is
// shown to export no function that takes a render callback (work-artifacts-124a-review17-20261115.test.ts).
