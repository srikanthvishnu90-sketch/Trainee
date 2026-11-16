// WO-124a seventeenth review (2026-11-15). Owner scope ruling: delivery covers only bytes a Trainee writer (xlsx.ts,
// ics.ts, docs.ts) produced for that case.
//  B1: mintWriter(meta, kind, render) trusted a caller-supplied meta.url, so any code could forge docs.ts's URL and
//      launder outside bytes; the only barrier was a source-text grep, bypassed by computed access, an import alias or a
//      writer module re-exporting a general factory. Now provenance.ts imports the real writers itself and exposes fixed
//      handles (WRITERS.xlsx); no exported function takes a render callback. These runtime tests replace the grep gate.
//  n1: a cyclic model made sourceText throw RangeError; it is now a refusal.
//  n2: the model was read twice (check, then clone for the render); it is now cloned once, and both use the clone.
// Fixtures are invented.
import * as kase from "../../../supabase/functions/_shared/work/case.ts";
import * as deliverMod from "../../../supabase/functions/_shared/work/deliver.ts";
import { writeXlsx } from "../../../supabase/functions/_shared/work/xlsx.ts";

const WORK = new URL("../../../supabase/functions/_shared/work/", import.meta.url);
const prov = () => import(new URL("provenance.ts", WORK).href);
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function assert(c: unknown, m: string) { if (!c) throw new Error(m); }
const enc = (s: string) => new TextEncoder().encode(s);
const NAME = "Jordan Pike";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UPLOADED = enc("%PDF-1.4 a file the person uploaded, or one fetched from the web");
const DOCS_META = { url: new URL("docs.ts", WORK).href };
// The writer modules and the kinds each one's handle must carry (the closed set; the slot test below enforces it).
const WRITER_MODULES: Record<string, string[]> = { "xlsx.ts": ["xlsx"], "ics.ts": ["ics"], "docs.ts": ["docx", "pptx", "pdf"] };
const book = (v: unknown = "Quarterly memo") => ({ sheets: [{ name: "Memo", cells: { A1: { v } } }], charts: [], expected: {} });
const exists = async (f: string) => { try { await Deno.stat(new URL(f, WORK)); return true; } catch { return false; } };

function revokedCase() {
  const c = kase.newCase({ owner: "u1", practice: false, title: "memo", now: 1 });
  kase.addRound(c, { round: 1, text: "r1", constraints: [{ id: "k1", kind: "hard", text: "name", values: [NAME] }] });
  kase.addRound(c, { round: 2, text: "r2", constraints: [{ id: "k2", kind: "hard", text: "no", revokes: "k1" }] });
  return c;
}
// Tries a candidate writer with outside bytes, then tries to deliver the outside bytes: nothing may be written or sent.
async function noLaundering(label: string, candidate: unknown, renders: { n: number }) {
  const p = await prov();
  const c = kase.newCase({ owner: "u1", practice: false, title: "memo", now: 1 });
  let r: { ok: boolean } = { ok: false };
  try { r = await p.write(c, candidate as never, { bytes: UPLOADED } as never); } catch { r = { ok: false }; }
  eq(r.ok, false, `${label}: nothing is written`);
  let sent = 0;
  const io = { sendFile: () => (sent++, Promise.resolve({ ok: true })), filePage: () => (sent++, Promise.resolve("u")), sendText: () => (sent++, Promise.resolve({ ok: true })) };
  const d = await (deliverMod.deliver as unknown as (...a: unknown[]) => Promise<deliverMod.DeliverResult>)("whatsapp",
    { filename: "upload.pdf", mime: "application/pdf", bytes: UPLOADED }, io, c);
  eq([d.ok, sent], [false, 0], `${label}: the outside bytes are refused, nothing sent`);
  eq(p.writtenFor(c, UPLOADED), false, `${label}: the outside bytes are not recorded`);
  eq(renders.n, 0, `${label}: the outside render callback never ran`);
}
const makeRender = (renders: { n: number }) => (m: { bytes?: Uint8Array }) => (renders.n++, [{ filename: "upload.pdf", mime: "application/pdf", bytes: m?.bytes ?? UPLOADED }]);

Deno.test("124a review 17 B1 (rv17 P1, M1, M3): forged meta, computed access and an alias reach no mint", async () => {
  const p = await prov();
  const ns = p as Record<string, unknown>;
  const renders = { n: 0 };
  const render = makeRender(renders);
  const { mintWriter: aliased } = ns as { mintWriter?: unknown };       // M3: an alias
  const computed = ns["mint" + "Writer"];                               // M1: computed access
  const attempts: [string, () => unknown][] = [
    ["P1 forged docs.ts meta", () => (ns.mintWriter as (...a: unknown[]) => unknown)(DOCS_META, "pdf", render)],
    ["M1 computed access", () => (computed as (...a: unknown[]) => unknown)({ url: new URL("docs.ts", WORK).href }, "pdf", render)],
    ["M3 alias with its own meta", () => (aliased as (...a: unknown[]) => unknown)({ url: new URL("docs.ts", WORK).href }, "pdf", render)],
    ["the round-15 traineeWriter", () => (ns.traineeWriter as (...a: unknown[]) => unknown)({ kind: "pdf", render })],
    ["an object shaped like a handle", () => Object.freeze({ kind: "pdf" })],
    ["a copy of the real handle", () => ({ ...(ns.WRITERS as Record<string, object>)?.xlsx })],
    ["the render callback itself", () => render],
  ];
  for (const [label, make] of attempts) {
    let w: unknown = null;
    try { w = make(); } catch { w = null; }
    await noLaundering(label, w, renders);
  }
  assert(!("mintWriter" in ns) && !("traineeWriter" in ns), "no mint or factory is exported");
});

Deno.test("124a review 17 B1 (rv17 M2): no function reachable from provenance.ts or a writer module makes a writer from a render callback", async () => {
  const p = await prov();
  const renders = { n: 0 };
  const render = makeRender(renders);
  const mods: [string, Record<string, unknown>][] = [["provenance.ts", p]];
  for (const f of Object.keys(WRITER_MODULES)) if (await exists(f)) mods.push([f, await import(new URL(f, WORK).href)]);
  // Every value reachable from the exports (objects walked, bounded), and every function called with a render callback,
  // a forged meta and every kind in every argument position; whatever comes back is tried as a writer too.
  const seen = new Set<unknown>(), found: [string, unknown][] = [];
  const walk = (label: string, v: unknown, depth: number) => {
    if (v === null || (typeof v !== "object" && typeof v !== "function") || seen.has(v) || depth > 4) return;
    seen.add(v); found.push([label, v]);
    if (typeof v === "object") for (const k of Reflect.ownKeys(v)) { try { walk(`${label}.${String(k)}`, (v as Record<PropertyKey, unknown>)[k], depth + 1); } catch { /* a throwing getter */ } }
  };
  for (const [m, ns] of mods) for (const k of Object.keys(ns)) walk(`${m}:${k}`, ns[k], 0);
  const handles = new Set(Object.values(p.WRITERS as Record<string, object>));
  const argSets: unknown[][] = [];
  const kinds = ["xlsx", "ics", "docx", "pptx", "pdf"];
  for (const kind of kinds) {
    argSets.push([render], [DOCS_META, kind, render], [{ kind, render }], [kind, render], [render, kind], [import.meta, kind, render]);
  }
  let called = 0;
  for (const [label, v] of [...found]) {
    if (typeof v !== "function" || label === "provenance.ts:write") continue;
    for (const args of argSets) {
      let out: unknown;
      try { out = (v as (...a: unknown[]) => unknown)(...args); called++; } catch { continue; }
      try { out = await out; } catch { continue; }
      if (out && typeof out === "object" && !handles.has(out as object)) await noLaundering(`${label}(${args.length} args)`, out, renders);
      if (handles.has(out as object)) throw new Error(`${label} returned a writer handle`);
    }
  }
  assert(called > 0, "functions were actually called");
  // And no other reachable object is accepted as a writer.
  for (const [label, v] of found) if (!handles.has(v as object)) await noLaundering(label, v, renders);
});

Deno.test("124a review 17 B1: provenance.ts exports no function that accepts a render callback", async () => {
  const p = await prov();
  const fns = Object.entries(p).filter(([, v]) => typeof v === "function").map(([k]) => k).sort();
  eq(fns, ["sha256", "write", "writtenFor"], "the only functions provenance.ts exports");
  const renders = { n: 0 };
  const render = makeRender(renders);
  const c = revokedCase();
  for (const f of fns) {
    for (let i = 0; i < 4; i++) {
      const args: unknown[] = [c, p.WRITERS.xlsx, book(), UPLOADED];
      args[i] = render;
      try { await (p as Record<string, (...a: unknown[]) => unknown>)[f](...args); } catch { /* a refusal */ }
    }
  }
  eq(renders.n, 0, "no exported function ever runs a render callback it is handed");
  // The handle table is fixed: frozen, frozen handles, and a handle added from outside is not a writer.
  assert(Object.isFrozen(p.WRITERS) && Object.values(p.WRITERS).every((h) => Object.isFrozen(h)), "WRITERS and its handles are frozen");
  let added = false;
  try { Object.defineProperty(p.WRITERS, "pdf", { value: Object.freeze({ kind: "pdf" }) }); added = true; } catch { added = false; }
  eq(added, false, "a handle cannot be added to WRITERS");
  await noLaundering("a frozen look-alike handle", Object.freeze({ kind: "xlsx" }), renders);
});

Deno.test("124a review 17 slot: WRITERS holds exactly one handle per kind of each writer module in the repo, wired to that module", async () => {
  const p = await prov();
  const want: string[] = [];
  for (const [f, ks] of Object.entries(WRITER_MODULES)) if (await exists(f)) want.push(...ks);
  // A writer module that exists without its handle here (or a handle without its module) fails: the branch that adds
  // ics.ts (WO-124c) or docs.ts (WO-124d) adds its import and RENDERS line in provenance.ts, as its header says.
  eq(Object.keys(p.WRITERS).sort(), want.sort(), "WRITERS kinds = the writer modules present");
  for (const [k, h] of Object.entries(p.WRITERS as Record<string, { kind: string }>)) eq(h.kind, k, `WRITERS.${k}.kind`);
  // The xlsx handle draws with xlsx.ts's own writeXlsx: the bytes are exactly that function's output.
  const r = await p.write(kase.newCase({ owner: "u1", practice: false, title: "m", now: 1 }), p.WRITERS.xlsx, book());
  assert(r.ok, "the workbook is written");
  const f = (r as { files: deliverMod.WorkFile[] }).files[0];
  eq([f.filename, f.mime], ["workbook.xlsx", XLSX], "name and type");
  eq([...f.bytes], [...writeXlsx(book() as never)], "the bytes are writeXlsx's output");
});

Deno.test("124a review 17 n1: a cyclic or very deep model is a refusal, never a RangeError", async () => {
  const p = await prov();
  const c = revokedCase();
  const cyc = book() as Record<string, unknown>;
  cyc.self = cyc;
  let r: { ok: boolean; why?: string };
  try { r = await p.write(c, p.WRITERS.xlsx, cyc as never); } catch (e) { throw new Error(`cyclic: threw ${(e as Error).name}`); }
  eq([r.ok, r.why], [false, "model is not plain data"], "cyclic: refused");
  let deep: Record<string, unknown> = { v: "x" };
  for (let i = 0; i < 20000; i++) deep = { d: deep };
  try { r = await p.write(c, p.WRITERS.xlsx, { ...book(), deep } as never); } catch (e) { throw new Error(`deep: threw ${(e as Error).name}`); }
  assert(r.ok === true || r.why !== undefined, "deep: a result, not a throw");
  // A model that cannot be cloned (a function in it) is a refusal too.
  r = await p.write(c, p.WRITERS.xlsx, { ...book(), f: () => 1 } as never);
  eq([r.ok, r.why], [false, "model is not plain data"], "uncloneable: refused");
});

Deno.test("124a review 17 n2: the model is read once; the check and the render see the same values", async () => {
  const p = await prov();
  const c = revokedCase();
  let reads = 0;
  const cell = { get v() { return ++reads === 1 ? "Quarterly memo, clean" : `Lead: ${NAME}`; } };
  const r = await p.write(c, p.WRITERS.xlsx, { sheets: [{ name: "Memo", cells: { A1: cell } }], charts: [], expected: {} } as never);
  eq(reads, 1, "the getter was read exactly once");
  assert(r.ok, "written from the one read");
  const f = (r as { files: deliverMod.WorkFile[] }).files[0];
  eq([...f.bytes], [...writeXlsx(book("Quarterly memo, clean") as never)], "the file is the value the check saw");
  // And the other order: revoked on the first read is refused at the source, before any render.
  let reads2 = 0;
  const cell2 = { get v() { return ++reads2 === 1 ? `Lead: ${NAME}` : "clean"; } };
  const r2 = await p.write(c, p.WRITERS.xlsx, { sheets: [{ name: "Memo", cells: { A1: cell2 } }], charts: [], expected: {} } as never);
  eq([r2.ok, (r2 as { why: string }).why, reads2], [false, "source holds a revoked value", 1], "refused at the source from the one read");
});
