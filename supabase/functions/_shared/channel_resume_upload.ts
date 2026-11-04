// FEATURE 16 (2026-10-26): a resume sent as a file on Telegram (a PDF or a Word .docx), read and ingested as the person's
// upload, with its provenance. Before this, a document got "I can't open files sent here yet" (WO-106).
//
//   1. the file is downloaded through the Bot API (getFile, then the file; telegram.ts fetchFile), at most 10 MB;
//   2. its sha256 is taken over the bytes as received, and its text is read by code (CareerRender's own PDF and DOCX
//      readers, the ones the resume renderer's parse check uses), never by a model;
//   3. the original file is stored as the person's upload (career_resume_uploads: the provider's file_unique_id, the
//      name, the type, the bytes and their sha256) together with the sha256 of the message the chat receives;
//   4. the chat receives "here is my resume:\n<the file's text>", exactly as a pasted resume, so the router reads it
//      into draft entries and shows each one; nothing is confirmed by the upload;
//   5. on the person's later "yes, that's my resume", the evidence step (career_router_evidence.ts, in handler-career.ts)
//      finds this upload by that message's sha256 and records the FILE (its reference and sha256) as the upload each
//      confirmed entry came from (fileUploadFor below), under the same rules: shown word for word, and in the upload.
// A file that cannot be downloaded, is not a PDF or DOCX, or has no readable text is said so, plainly; nothing is stored.
import { CareerRender } from "./router_core.career.js";
import { redactIdentity } from "./identity_redact.ts";
import type { Upload } from "./career_router_evidence.ts";

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE = 4000; // agent-chat's message cap
export const FILE_KIND_REPLY = "I can read a resume sent as a PDF or a Word (.docx) file. That file is neither, so I haven't read it. Send it as a PDF or .docx, or paste the text here.";
export const FILE_TOO_BIG_REPLY = "That file is over 10 MB, so I didn't download it. Send a smaller PDF or .docx, or paste your resume as text here.";
export const FILE_DOWNLOAD_REPLY = "I couldn't download that file from Telegram just now, so I haven't read it. Send it again in a minute.";
export const FILE_NO_TEXT_REPLY = "I couldn't read any text in that file (it may be a scan or an image), so nothing was saved. Send a PDF or .docx with selectable text, or paste your resume here.";
export const FILE_SAVE_REPLY = "I read your file but couldn't save it just now, so nothing was taken from it. Send it again in a minute.";

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256Bytes = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
const sha256Text = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export type FileKind = "pdf" | "docx";
export function fileKind(name: string, mime: string, bytes?: Uint8Array): FileKind | null {
  const n = String(name ?? "").toLowerCase(), m = String(mime ?? "").toLowerCase();
  if (bytes && bytes.length >= 4) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf"; // %PDF
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && (n.endsWith(".docx") || m.includes("wordprocessingml"))) return "docx"; // a zip
    return null;
  }
  if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (m.includes("wordprocessingml") || n.endsWith(".docx")) return "docx";
  return null;
}

// The file's text, line by line, by code. Node built-ins (zlib, Buffer) are loaded on first use, as edgeRenderer loads them.
// deno-lint-ignore no-explicit-any
let reader: Promise<any> | null = null;
export async function fileText(kind: FileKind, bytes: Uint8Array): Promise<string> {
  reader ??= Promise.all([import("node:zlib"), import("node:crypto"), import("node:buffer")])
    // deno-lint-ignore no-explicit-any
    .then(([zlib, crypto, b]) => ({ r: (CareerRender as any).withRuntime({ zlib, crypto, Buffer: b.Buffer }), Buffer: b.Buffer }));
  const { r, Buffer } = await reader;
  const buf = Buffer.from(bytes);
  const lines: string[] = kind === "pdf" ? r.extractPdfLines(buf) : r.extractDocxLines(buf);
  return (Array.isArray(lines) ? lines : []).map((l) => String(l).replace(/\s+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The message the chat receives for a file's text: framed as a pasted resume, trimmed and with identity digits removed as
// agent-chat's input step removes them (chat_input.ts), so its sha256 is the sha256 of the message the thread stores.
export function resumeMessage(text: string): string {
  let body = String(text ?? "").trim();
  const head = "here is my resume:\n";
  if (head.length + body.length > MAX_MESSAGE) {
    body = body.slice(0, MAX_MESSAGE - head.length);
    const cut = body.lastIndexOf("\n");
    if (cut > 0) body = body.slice(0, cut);
  }
  return redactIdentity(`${head}${body}`.trim()).text;
}

export type ResumeFileResult = { ok: true; message: string; uploadId: string; sha256: string } | { ok: false; reply: string; why: string };
export async function ingestResumeFile(o: {
  userId: string; channel: "telegram"; doc: { fileId: string; uniqueId: string; name: string; mime: string; size: number | null };
  fetchFile: (fileId: string, maxBytes: number) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }>;
  record: (row: { userId: string; channel: string; ref: string; filename: string; mime: string; bytes: number; sha256: string; content_b64: string; message_sha256: string }) => Promise<string>;
}): Promise<ResumeFileResult> {
  if (!fileKind(o.doc.name, o.doc.mime)) return { ok: false, reply: FILE_KIND_REPLY, why: "kind" };
  if (o.doc.size !== null && o.doc.size > MAX_RESUME_BYTES) return { ok: false, reply: FILE_TOO_BIG_REPLY, why: "too_large" };
  const got = await o.fetchFile(o.doc.fileId, MAX_RESUME_BYTES).catch((e) => ({ ok: false as const, error: String(e?.message ?? e) }));
  if (!got.ok) return { ok: false, reply: got.error === "too_large" ? FILE_TOO_BIG_REPLY : FILE_DOWNLOAD_REPLY, why: got.error === "too_large" ? "too_large" : "download" };
  const kind = fileKind(o.doc.name, o.doc.mime, got.bytes);
  if (!kind) return { ok: false, reply: FILE_KIND_REPLY, why: "kind" };
  let text = "";
  try { text = await fileText(kind, got.bytes); } catch (e) { console.error("resume file: not read:", (e as Error)?.message ?? e); }
  if (text.replace(/\s+/g, "").length < 80) return { ok: false, reply: FILE_NO_TEXT_REPLY, why: "no_text" };
  const message = resumeMessage(text);
  const sha256 = await sha256Bytes(got.bytes);
  let uploadId: string;
  try {
    uploadId = await o.record({ userId: o.userId, channel: o.channel, ref: `${o.channel}:${o.doc.uniqueId}`, filename: o.doc.name, mime: o.doc.mime || (kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      bytes: got.bytes.length, sha256, content_b64: b64(got.bytes), message_sha256: await sha256Text(message) });
  } catch (e) {
    console.error("resume file: not stored:", (e as Error)?.message ?? e);
    return { ok: false, reply: FILE_SAVE_REPLY, why: "store" };
  }
  return { ok: true, message, uploadId, sha256 };
}

// deno-lint-ignore no-explicit-any
export function supabaseUploadRecorder(admin: any) {
  return async (row: Parameters<Parameters<typeof ingestResumeFile>[0]["record"]>[0]) => {
    const r = await admin.rpc("career_resume_upload_record_as", { p_user: row.userId, p_channel: row.channel, p_ref: row.ref, p_filename: row.filename,
      p_mime: row.mime, p_bytes: row.bytes, p_sha256: row.sha256, p_content_b64: row.content_b64, p_message_sha256: row.message_sha256 });
    if (r.error || typeof r.data !== "string") throw new Error(`record the resume file: ${r.error?.message ?? "no id"}`);
    return r.data as string;
  };
}

// The evidence step's upload, when the person's message that carried the entries was a file's text: the file itself (the
// person's original upload, by its provider reference and the sha256 of its bytes). Otherwise the message, unchanged.
// deno-lint-ignore no-explicit-any
export async function fileUploadFor(admin: any, userId: string, upload: Upload | null): Promise<Upload | null> {
  if (!upload || upload.kind !== "message") return upload;
  try {
    const r = await admin.from("career_resume_uploads").select("id,provider_ref,sha256").eq("user_id", userId).eq("message_sha256", upload.sha256)
      .order("created_at", { ascending: false }).limit(1);
    const row = r.error ? null : r.data?.[0];
    if (!row) return upload;
    return { kind: "file", ref: `${row.provider_ref} (career_resume_uploads:${row.id})`, sha256: row.sha256, text: upload.text };
  } catch {
    return upload;
  }
}
