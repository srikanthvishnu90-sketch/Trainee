// WO-124a fifteenth review (owner ruling): only files Trainee's own writers produce are delivered. A writer (124b XLSX,
// 124c ICS, 124d DOCX/PPTX/PDF) renders a work model into bytes; write() checks the model for revoked values BEFORE
// rendering, renders, scans the bytes, and records sha256(bytes) with the case. deliver.ts refuses any bytes whose hash
// this module did not record for that case, so an upload, a fetched file or any other outside bytes can never be sent,
// whatever the revoke scan says about them. Pure and synchronous: no database, no network.
import { createHash } from "node:crypto";
import { revoked, type WorkCase } from "./case.ts";
import type { Model } from "./model.ts";
import { scan, type RevokeHit } from "./revoke_scan.ts";

export type WriterKind = "xlsx" | "ics" | "docx" | "pptx" | "pdf";
export interface WrittenFile { filename: string; mime: string; bytes: Uint8Array }
// A writer's input is a work model (cells and text, or the writer's own typed model: a workbook, events, a document or a
// deck), never bytes passed through: the writer draws the file itself.
export type Render<M = Model> = (model: M) => WrittenFile[];
interface WriterImpl { kind: WriterKind; render: Render<unknown> }
export interface TraineeWriter<M = Model> { readonly kind: WriterKind; readonly __model?: M }
export type WriteResult =
  | { ok: true; files: WrittenFile[] }
  | { ok: false; why: "source holds a revoked value" | "file holds a revoked value" | "writer failed"; hits: RevokeHit[] };

// Sixteenth review (B2): the set of writers is closed. A writer handle is minted only by the writer modules themselves,
// each for its own kinds: xlsx.ts (WO-124b) for xlsx, ics.ts (WO-124c) for ics, docs.ts (WO-124d) for docx, pptx and pdf.
// The module passes its own import.meta; any other caller is refused. There is no general function that turns a render
// function into a writer. The source gate (tests/architect/pending/work-artifacts-124a-review16-20261115.test.ts) fails
// if any non-test source other than those three modules calls mintWriter, or if one of them passes anything but its own
// import.meta.
const MODULES: Readonly<Record<string, readonly WriterKind[]>> = Object.freeze({
  [new URL("./xlsx.ts", import.meta.url).href]: Object.freeze(["xlsx"] as const),
  [new URL("./ics.ts", import.meta.url).href]: Object.freeze(["ics"] as const),
  [new URL("./docs.ts", import.meta.url).href]: Object.freeze(["docx", "pptx", "pdf"] as const),
});
// Writers are known by identity: a handle made here, kept in a WeakMap, so an object shaped like a writer is not one.
const WRITERS = new WeakMap<object, WriterImpl>();
// The hashes Trainee wrote, per case, kept out of reach of the case object (as case.ts keeps the practice flag).
const WRITTEN = new WeakMap<WorkCase, Map<string, WriterKind>>();

export function sha256(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

// Called once per kind at the top of a writer module: `export const DOCX_WRITER = mintWriter(import.meta, "docx", render)`.
export function mintWriter<M>(meta: { url: string }, kind: WriterKind, render: Render<M>): TraineeWriter<M> {
  let url = "";
  try { url = String(meta?.url ?? ""); } catch { url = ""; }
  const kinds = Object.hasOwn(MODULES, url) ? MODULES[url] : undefined;
  if (!kinds || !kinds.includes(kind) || typeof render !== "function") {
    throw new TypeError("not a Trainee writer: writers are made only by xlsx.ts, ics.ts and docs.ts, each for its own kinds");
  }
  const handle = Object.freeze({ kind }) as TraineeWriter<M>;
  WRITERS.set(handle, { kind, render: render as Render<unknown> });
  return handle;
}

// Every string and number in the model, one per line: what the writer will draw. A revoked value here is refused before
// any bytes exist.
function sourceText(m: unknown): string {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string" || typeof v === "number") out.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  walk(m);
  return out.join("\n");
}

export async function write<M>(c: WorkCase, w: TraineeWriter<M>, model: M): Promise<WriteResult> {
  const impl = WRITERS.get(w);
  if (!impl) return { ok: false, why: "writer failed", hits: [] };
  const values = revoked(c);
  if (values.length) {
    const hits = await scan({ "source model": new TextEncoder().encode(sourceText(model)) }, values);
    if (hits.length) return { ok: false, why: "source holds a revoked value", hits };
  }
  let files: WrittenFile[];
  try { files = impl.render(structuredClone(model)); } catch { return { ok: false, why: "writer failed", hits: [] }; }
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
