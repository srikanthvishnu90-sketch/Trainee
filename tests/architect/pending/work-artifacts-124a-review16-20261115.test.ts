// WO-124a sixteenth review (2026-11-15). Owner scope ruling: delivery covers only bytes a Trainee writer (124b XLSX,
// 124c ICS, 124d DOCX/PPTX/PDF) produced for that same case.
//  B1: deliver() checked one read of the file and sent another (the caller's buffer changed after the check, or a getter
//      answered differently on a later read). It now reads the file once and sends only its own copy.
//  B2: any code could turn a render function into a "Trainee writer" and launder outside bytes. Writers are now minted
//      only by the writer modules (xlsx.ts, ics.ts, docs.ts), each for its own kinds, and a source gate holds that.
// Writer modules are not on this branch (they are WO-124b-d): the stub writers below stand in for docs.ts by naming its
// URL, which only a test may do (the source gate fails any non-test file that does). Fixtures are invented.
import * as kase from "../../../supabase/functions/_shared/work/case.ts";
import * as deliverMod from "../../../supabase/functions/_shared/work/deliver.ts";

const prov = () => import("../../../supabase/functions/_shared/work/" + "provenance.ts");
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function assert(c: unknown, m: string) { if (!c) throw new Error(m); }
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const NAME = "Jordan Pike";
const WORK = new URL("../../../supabase/functions/_shared/work/", import.meta.url);
const DOCS_META = { url: new URL("docs.ts", WORK).href };
type P = Awaited<ReturnType<typeof prov>>;
// A stub pdf writer standing in for docs.ts (on the round-15 code, the open traineeWriter, so B1 fails on its own bug).
// deno-lint-ignore no-explicit-any
const stub = (p: P, render: () => { filename: string; mime: string; bytes: Uint8Array }[]): any => {
  // deno-lint-ignore no-explicit-any
  const q = p as any;
  return typeof q.mintWriter === "function" ? q.mintWriter(DOCS_META, "pdf", render) : q.traineeWriter({ kind: "pdf", render });
};
function revokedCase() {
  const c = kase.newCase({ owner: "u1", practice: false, title: "memo", now: 1 });
  kase.addRound(c, { round: 1, text: "r1", constraints: [{ id: "k1", kind: "hard", text: "name", values: [NAME] }] });
  kase.addRound(c, { round: 2, text: "r2", constraints: [{ id: "k2", kind: "hard", text: "no", revokes: "k1" }] });
  return c;
}
const CLEAN = "Quarterly memo, all clean. ".repeat(4);
async function written(p: P, c: kase.WorkCase) {
  const r = await p.write(c, stub(p, () => [{ filename: "memo.txt", mime: "application/pdf", bytes: enc(CLEAN) }]), { cells: [], text: ["Quarterly memo"] });
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
  const g = { filename: "memo.pdf", mime: "application/pdf", get bytes() { return ++reads <= 4 ? good : outside; } };
  const x = rails();
  const d = await send(g, x.io, c);
  eq(reads, 1, "bytes read exactly once");
  assert(d.ok, "delivered from the one read");
  eq(x.sent.map((s) => s.bytes), [CLEAN], "only the Trainee bytes were sent");
  // Getters on the name and type are read once too, and a getter that throws is a refusal, not a crash.
  let names = 0;
  const h = { get filename() { names++; return "memo.pdf"; }, mime: "application/pdf", bytes: good };
  const x2 = rails();
  assert((await send(h, x2.io, c)).ok && names === 1, "filename read once");
  const bad = { filename: "memo.pdf", mime: "application/pdf", get bytes(): Uint8Array { throw new Error("boom"); } };
  const x3 = rails();
  const r3 = await send(bad, x3.io, c);
  eq([r3.ok, x3.sent.length], [false, 0], "a throwing getter: refused, nothing sent");
  // A Proxy that passes instanceof Uint8Array is not a typed array and is refused before any send.
  const x4 = rails();
  const r4 = await send({ filename: "memo.pdf", mime: "application/pdf", bytes: new Proxy(good, {}) }, x4.io, c);
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

// The source gate: only the writer modules mint writers, and each passes its own import.meta.
const WRITER_MODULES = ["supabase/functions/_shared/work/xlsx.ts", "supabase/functions/_shared/work/ics.ts", "supabase/functions/_shared/work/docs.ts"];
const ROOT = new URL("../../../", import.meta.url);
const SOURCE_DIRS = ["supabase", "extension", "scripts", "api", "site", "src", "packages", "workers", "tools", "evals", "eval", "connect"];
const SKIP = new Set(["node_modules", ".git", "dist", "build", "graphify-out", "coverage"]);
async function* sources(rel: string): AsyncGenerator<string> {
  let it;
  try { it = Deno.readDir(new URL(rel + "/", ROOT)); } catch { return; }
  try {
    for await (const e of it) {
      const path = `${rel}/${e.name}`;
      if (e.isDirectory && !SKIP.has(e.name)) yield* sources(path);
      else if (e.isFile && /\.(?:[cm]?[jt]sx?)$/.test(e.name) && !/\.test\.[cm]?[jt]sx?$/.test(e.name)) yield path;
    }
  } catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
}

Deno.test("124a review 16 B2 gate: no non-test source except xlsx.ts, ics.ts and docs.ts mints a writer, and provenance.ts exports no other factory", async () => {
  const p = await prov();
  // provenance.ts exposes exactly these functions: the guarded mint, write, the lookup and the hash.
  const fns = Object.entries(p).filter(([, v]) => typeof v === "function").map(([k]) => k).sort();
  eq(fns, ["mintWriter", "sha256", "write", "writtenFor"], "provenance.ts functions");
  const provSrc = await Deno.readTextFile(new URL("supabase/functions/_shared/work/provenance.ts", ROOT));
  for (const m of WRITER_MODULES) assert(provSrc.includes(`new URL("./${m.split("/").pop()}", import.meta.url)`), `provenance.ts names ${m}`);
  const offenders: string[] = [], forged: string[] = [];
  let seen = 0;
  for (const dir of SOURCE_DIRS) {
    for await (const path of sources(dir)) {
      if (path.includes("/tests/") || path.startsWith("tests/")) continue;
      seen++;
      const src = await Deno.readTextFile(new URL(path, ROOT));
      if (!src.includes("mintWriter")) continue;
      if (path === "supabase/functions/_shared/work/provenance.ts") continue;
      if (!WRITER_MODULES.includes(path)) { offenders.push(path); continue; }
      // Inside a writer module every use is a direct call with its own import.meta, never an alias or a forged URL.
      const uses = src.match(/mintWriter/g)?.length ?? 0;
      const imports = src.match(/import\s*\{[^}]*\bmintWriter\b[^}]*\}\s*from\s*["']\.\/provenance\.ts["']/g)?.length ?? 0;
      const calls = src.match(/\bmintWriter\(\s*import\.meta\s*,/g)?.length ?? 0;
      if (uses !== imports + calls) forged.push(path);
    }
  }
  assert(seen > 100, `the gate walked the source tree (${seen} files)`);
  eq(offenders, [], "files outside the writer modules that mint a writer");
  eq(forged, [], "writer modules that mint with anything but their own import.meta");
});
