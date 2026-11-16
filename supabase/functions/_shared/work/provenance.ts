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
// A writer's input is a work model (cells and text), never bytes: nothing outside can be passed through it.
export interface WriterImpl { kind: WriterKind; render(model: Model): WrittenFile[] }
export interface TraineeWriter { readonly kind: WriterKind }
export type WriteResult =
  | { ok: true; files: WrittenFile[] }
  | { ok: false; why: "source holds a revoked value" | "file holds a revoked value" | "writer failed"; hits: RevokeHit[] };

const KINDS: readonly WriterKind[] = ["xlsx", "ics", "docx", "pptx", "pdf"];
// Writers are known by identity: a handle made here, kept in a WeakMap, so an object shaped like a writer is not one.
const WRITERS = new WeakMap<TraineeWriter, WriterImpl>();
// The hashes Trainee wrote, per case, kept out of reach of the case object (as case.ts keeps the practice flag).
const WRITTEN = new WeakMap<WorkCase, Map<string, WriterKind>>();

export function sha256(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

export function traineeWriter(impl: WriterImpl): TraineeWriter {
  if (!KINDS.includes(impl?.kind) || typeof impl.render !== "function") throw new TypeError("not a Trainee writer");
  const handle = Object.freeze({ kind: impl.kind });
  WRITERS.set(handle, { kind: impl.kind, render: impl.render });
  return handle;
}

// Every string and number in the model, one per line: what the writer will draw. A revoked value here is refused before
// any bytes exist.
function sourceText(m: Model): string {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string" || typeof v === "number") out.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  walk(m);
  return out.join("\n");
}

export async function write(c: WorkCase, w: TraineeWriter, model: Model): Promise<WriteResult> {
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
