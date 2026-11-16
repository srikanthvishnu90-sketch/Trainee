// WO-124a fifteenth review (owner ruling): only files Trainee's own writers produce are delivered. A writer (124b XLSX,
// 124c ICS, 124d DOCX/PPTX/PDF) renders a work model into bytes; write() checks the model for revoked values BEFORE
// rendering, renders, scans the bytes, and records sha256(bytes) with the case. deliver.ts refuses any bytes whose hash
// this module did not record for that case, so an upload, a fetched file or any other outside bytes can never be sent,
// whatever the revoke scan says about them. Pure and synchronous: no database, no network.
//
// Seventeenth review (B1): the set of writers is closed by this module's own import list. There is no mint, no factory
// and no hook: no exported function takes a render function, a module URL or an import.meta. This module imports each
// real writer itself and makes one fixed handle per kind at load time (`WRITERS.xlsx`). write() accepts only those
// handles, by identity, so a caller can neither forge a writer (an object shaped like one is not one) nor wrap outside
// bytes in one. Adding a writer means adding an import here, in review; nothing else can.
//
// The slot for writers that are not on this branch yet (each is test-enforced: work-artifacts-124a-review17-20261115
// fails when a writer module exists in the repo without its handle here, or a handle exists without its module):
//  - WO-124c (ag/wo-124bc) adds, in this file only:
//      import { type IcsEvent, writeIcs } from "./ics.ts";
//      and in RENDERS:  ics: (m: { events: IcsEvent[]; now: string }) =>
//        [{ filename: "invite.ics", mime: "text/calendar", bytes: new TextEncoder().encode(writeIcs(m.events, { now: m.now })) }],
//  - WO-124d (ag/wo-124d) adds, in this file only:
//      import { type Deck, type DocModel, writeDocx, writePdf, writePptx } from "./docs.ts";
//      and in RENDERS:  docx: (m: DocModel) => [{ filename: "memo.docx", mime: DOCX, bytes: writeDocx(m) }],
//                       pptx: (m: Deck) => [{ filename: "deck.pptx", mime: PPTX, bytes: writePptx(m) }],
//                       pdf: (m: DocModel) => [{ filename: "memo.pdf", mime: "application/pdf", bytes: writePdf(m) }],
//    A writer module never imports this file (no cycle, and no way for it to reach the handle table).
import { createHash } from "node:crypto";
import { revoked, type WorkCase } from "./case.ts";
import { scan, type RevokeHit } from "./revoke_scan.ts";
import { type Book, writeXlsx } from "./xlsx.ts";

export type WriterKind = "xlsx" | "ics" | "docx" | "pptx" | "pdf";
export interface WrittenFile { filename: string; mime: string; bytes: Uint8Array }
// A writer handle carries only its kind. Its render function lives in this module and is never exposed.
export interface TraineeWriter<M> { readonly kind: WriterKind; readonly __model?: M }
export type WriteResult =
  | { ok: true; files: WrittenFile[] }
  | {
    ok: false;
    why: "source holds a revoked value" | "file holds a revoked value" | "writer failed" | "model is not plain data";
    hits: RevokeHit[];
  };

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// The closed set: each render is one of the real writers this module imports above. A writer's input is a work model
// (the writer's own typed model: a workbook, events, a document or a deck), never bytes passed through.
const RENDERS = {
  xlsx: (m: Book): WrittenFile[] => [{ filename: "workbook.xlsx", mime: XLSX, bytes: writeXlsx(m) }],
  // ics: WO-124c adds its line here (see the header).
  // docx, pptx, pdf: WO-124d adds its lines here (see the header).
} as const;
type Renders = typeof RENDERS;

// Writers are known by identity: the handles made here, once, at module load.
const IMPL = new Map<object, { kind: WriterKind; render: (m: unknown) => WrittenFile[] }>();
function handle<K extends keyof Renders>(kind: K): TraineeWriter<Parameters<Renders[K]>[0]> {
  const h = Object.freeze({ kind }) as TraineeWriter<Parameters<Renders[K]>[0]>;
  IMPL.set(h, { kind, render: RENDERS[kind] as (m: unknown) => WrittenFile[] });
  return h;
}
export const WRITERS: { readonly [K in keyof Renders]: TraineeWriter<Parameters<Renders[K]>[0]> } = Object.freeze(
  Object.fromEntries((Object.keys(RENDERS) as (keyof Renders)[]).map((k) => [k, handle(k)])) as {
    [K in keyof Renders]: TraineeWriter<Parameters<Renders[K]>[0]>;
  },
);

// The hashes Trainee wrote, per case, kept out of reach of the case object (as case.ts keeps the practice flag).
const WRITTEN = new WeakMap<WorkCase, Map<string, WriterKind>>();

export function sha256(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

// Every string and number in the model, one per line, in reading order: what the writer will draw. A revoked value here
// is refused before any bytes exist. Iterative (a deep model cannot overflow the stack); a model that holds itself is not
// plain data and returns null (a refusal, never a RangeError); an object shared by two branches is read once.
function sourceText(m: unknown): string | null {
  const out: string[] = [];
  const open = new Set<object>(), done = new Set<object>();
  const stack: { v: unknown; leave?: object }[] = [{ v: m }];
  while (stack.length) {
    const { v, leave } = stack.pop()!;
    if (leave) { open.delete(leave); done.add(leave); continue; }
    if (typeof v === "string" || typeof v === "number") out.push(String(v));
    else if (v && typeof v === "object") {
      if (open.has(v)) return null;
      if (done.has(v)) continue;
      open.add(v);
      stack.push({ v: undefined, leave: v });
      const xs = Array.isArray(v) ? Array.from(v) : Object.values(v);
      for (let i = xs.length - 1; i >= 0; i--) stack.push({ v: xs[i] });
    }
  }
  return out.join("\n");
}

export async function write<M>(c: WorkCase, w: TraineeWriter<M>, model: M): Promise<WriteResult> {
  const impl = w !== null && typeof w === "object" ? IMPL.get(w) : undefined;
  if (!impl) return { ok: false, why: "writer failed", hits: [] };
  // The model is read once: cloned here (getters run once, into plain values), and the check and the render both use
  // only this clone, so a model cannot answer clean to the check and something else to the render.
  let own: unknown;
  try { own = structuredClone(model); } catch { return { ok: false, why: "model is not plain data", hits: [] }; }
  const text = sourceText(own);
  if (text === null) return { ok: false, why: "model is not plain data", hits: [] };
  const values = revoked(c);
  if (values.length) {
    const hits = await scan({ "source model": new TextEncoder().encode(text) }, values);
    if (hits.length) return { ok: false, why: "source holds a revoked value", hits };
  }
  let files: WrittenFile[];
  try { files = impl.render(own); } catch { return { ok: false, why: "writer failed", hits: [] }; }
  if (!Array.isArray(files) || !files.every((f) => f && f.bytes instanceof Uint8Array && typeof f.filename === "string")) {
    return { ok: false, why: "writer failed", hits: [] };
  }
  files = files.map((f) => ({ filename: f.filename, mime: String(f.mime ?? ""), bytes: new Uint8Array(f.bytes) }));
  if (values.length) {
    const hits = await scan(Object.fromEntries(files.map((f) => [f.filename, f.bytes])), values);
    if (hits.length) return { ok: false, why: "file holds a revoked value", hits };
  }
  const reg = WRITTEN.get(c) ?? new Map<string, WriterKind>();
  for (const f of files) reg.set(sha256(f.bytes), impl.kind);
  WRITTEN.set(c, reg);
  return { ok: true, files };
}

// Whether these exact bytes were written by a Trainee writer for this case.
export function writtenFor(c: WorkCase, bytes: Uint8Array): boolean {
  return WRITTEN.get(c)?.has(sha256(bytes)) === true;
}
