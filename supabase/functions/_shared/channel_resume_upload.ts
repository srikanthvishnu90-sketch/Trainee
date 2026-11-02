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
import { CareerProfile, CareerRender } from "./router_core.career.js";
import { redactIdentity } from "./identity_redact.ts";
import type { Upload } from "./career_router_evidence.ts";

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE = 4000; // agent-chat's message cap
export const FILE_KIND_REPLY = "I can read a resume sent as a PDF or a Word (.docx) file. That file is neither, so I haven't read it. Send it as a PDF or .docx, or paste the text here.";
export const FILE_TOO_BIG_REPLY = "That file is over 10 MB, so I didn't download it. Send a smaller PDF or .docx, or paste your resume as text here.";
export const FILE_DOWNLOAD_REPLY = "I couldn't download that file from Telegram just now, so I haven't read it. Send it again in a minute.";
export const FILE_NO_TEXT_REPLY = "I couldn't read any text in that file (it may be a scan or an image), so nothing was saved. Send a PDF or .docx with selectable text, or paste your resume here.";
// ONBOARDING ROUND 3 (2026-11-01): a damaged file (a PDF cut off mid-download, a .docx whose zip is broken) was told "it
// may be a scan or an image", and the person rescanned a file that was never a scan. A file the reader could not open, or
// one cut off before its end, is now said to be damaged; a whole file with no text is still said to be a scan.
export const FILE_DAMAGED_REPLY = "I couldn't open that file: it looks damaged or incomplete, or it has no text in it, so nothing was saved. Save it again as a PDF or Word (.docx) file and send that, or paste your resume here.";
export const FILE_EMPTY_REPLY = "That file is empty (0 bytes), so there was nothing to read and nothing was saved. Send the resume file again, or paste its text here.";
export const FILE_LOCKED_REPLY = "That PDF is locked with a password (or protected against copying), so I couldn't read its text and nothing was saved. Save an unlocked copy and send that, or paste your resume here. Never send me the password.";
export const fileSecretReply = (kinds: string[]) => `Your file has ${kinds.join(" and ")} in it, so I didn't keep the file or read anything from it. Remove ${kinds.length > 1 ? "them" : "it"} from the file and send it again, or paste your resume here without ${kinds.length > 1 ? "them" : "it"}.`;
// ONBOARDING ROUND 2: a file whose text is not a resume (a cover letter, a transcript, a page with no sections) was
// stored as the person's resume upload, and then the chat said "nothing from it was saved". It is checked first by the
// chat's own proof for a framed resume (142 resumePasteDraftsOf: two entries, work or education among them) and not kept.
export function fileNotResumeReply(text: string): string {
  const t = String(text ?? "").toLowerCase();
  const looks = /^\s*(?:dear|to whom|hello|hi)\b/m.test(t) && /\b(?:sincerely|regards|best|thank you)\b/.test(t) ? " It reads like a cover letter, not a resume."
    : /\btranscript\b|\b(?:cumulative|term|semester) gpa\b|\bcredits?\b/.test(t) ? " It reads like a transcript, not a resume."
    : " I found no section I read entries from (Experience, Education, Skills, Projects).";
  return `I couldn't read that file as a resume, so I didn't keep it and nothing from it is on your record.${looks} Send your resume as a PDF or Word file, or paste its text with its section headings, and I'll show you every entry I read for your yes.`;
}
export function readsAsResume(message: string): boolean {
  let drafts: { kind?: string }[] = [];
  // deno-lint-ignore no-explicit-any
  try { drafts = (CareerProfile as any).parseResumeText(message) ?? []; } catch { return false; }
  const kinds = new Set(drafts.map((d) => d && d.kind).filter(Boolean));
  return drafts.length >= 2 && (kinds.has("experience") || kinds.has("education"));
}
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
// ONBOARDING ROUND 2: a file that names no type of its own (no extension, sent as application/octet-stream or with no
// type) may still be a PDF; it is downloaded and its first bytes decide. A file that names another type (.doc, .png,
// image/jpeg) is not downloaded.
export function untyped(name: string, mime: string): boolean {
  const n = String(name ?? "").toLowerCase(), m = String(mime ?? "").toLowerCase().trim();
  return (!m || m === "application/octet-stream" || m === "binary/octet-stream") && !/\.[a-z0-9]{1,5}$/.test(n);
}
// A PDF locked with a password (or encrypted for its owner) carries /Encrypt in its trailer; its text cannot be read.
const encryptedPdf = (bytes: Uint8Array) => {
  const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 4096)));
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 2048)));
  return /\/Encrypt\s+\d+\s+\d+\s+R|\/Encrypt\s*<</.test(tail) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(head);
};

// A file cut off (a download that stopped, a copy that failed): a PDF with no end-of-file marker, a Word file with no end of
// its zip directory or no document part.
const cutOff = (kind: FileKind, bytes: Uint8Array) => {
  const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 1024)));
  if (kind === "pdf") return !/%%EOF\s*$/.test(tail);
  return !tail.includes("PK\u0005\u0006") || !new TextDecoder("latin1").decode(bytes).includes("word/document.xml");
};
// The file's text, line by line, by code. Node built-ins (zlib, Buffer) are loaded on first use, as edgeRenderer loads them.
// deno-lint-ignore no-explicit-any
let reader: Promise<any> | null = null;
export async function fileText(kind: FileKind, bytes: Uint8Array): Promise<string> {
  reader ??= Promise.all([import("node:zlib"), import("node:crypto"), import("node:buffer")])
    // deno-lint-ignore no-explicit-any
    .then(([zlib, crypto, b]) => ({ r: (CareerRender as any).withRuntime({ zlib, crypto, Buffer: b.Buffer }), Buffer: b.Buffer }));
  const { r, Buffer } = await reader;
  const buf = Buffer.from(bytes);
  const lines: string[] = kind === "pdf" ? pdfLayoutLines(r.extractPdfRuns(buf)) : docxResumeLines(r.docxPart(buf, "word/document.xml")?.toString("utf8") ?? "");
  return (Array.isArray(lines) ? lines : []).map((l) => String(l).replace(/\s+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ONBOARDING ROUND 2 (2026-10-30, tests/architect/scenarios-onboarding-r2.test.ts): a resume file's lines as the person
// laid them out. Before this each PDF text run was its own line and each Word paragraph was read with its tabs, line
// breaks and list bullets dropped, so:
//   - "Data Analyst Intern, Northwind" with its dates set to the right ("June 2024 - Aug 2024") was two entries, the dates
//     one of them; a Word line "Analyst<tab>2024" read "Analyst2024"; two bullets split by a line break read as one;
//   - a two-column PDF (a sidebar of skills beside the experience) was read across both columns, line by line, so a skill
//     landed under Experience as an entry and a job under Skills;
//   - a Word table row ("Company | Title | Dates") was three entries; a Word list item (a real bullet) was an entry of its
//     own; a text box was read twice (Word writes it again as a fallback picture).
// Now runs on one baseline are one line (a wide gap is " | "), a PDF page split by a clear gutter is read column by
// column, and a Word paragraph keeps its tabs (as " | "), breaks, list bullets ("- ") and table rows (cells joined " | ").
type Run = { text: string; x: number; y: number; size: number; page: number };
const BULLET_GLYPH = /^[•·▪◦●■►➢✓–•o*-]$/;
// A run's width, estimated from Helvetica's glyph widths (a PDF's own widths are in its fonts, which this reader does not
// parse); most resume fonts are as wide or narrower, so a gap is never smaller than estimated.
const NARROW = new Set([..." ,.;:!|'ijlI()[]/-"]), WIDE = new Set([..."mwMW@%"]);
const widthOf = (r: Run) => [...String(r.text)].reduce((a, c) => a + (NARROW.has(c) ? 0.28 : WIDE.has(c) ? 0.83 : /[A-Z]/.test(c) ? 0.67 : 0.556), 0) * (r.size || 10);
function rowsOf(runs: Run[]): Run[][] {
  const rows: Run[][] = [];
  for (const r of [...runs].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.length ? rows[rows.length - 1] : null;
    if (row && Math.abs(row[0].y - r.y) <= Math.max(2, (r.size || 10) * 0.25)) row.push(r); else rows.push([r]);
  }
  return rows.map((row) => row.sort((a, b) => a.x - b.x));
}
function rowText(row: Run[]): string {
  let out = "";
  for (const [k, r] of row.entries()) {
    const t = String(r.text);
    if (k === 0) { out = BULLET_GLYPH.test(t.trim()) && row.length > 1 ? "-" : t; continue; }
    const prev = row[k - 1], gap = r.x - (prev.x + widthOf(prev)), size = r.size || 10;
    out += gap > size * 4 && out !== "-" ? " | " : /\s$/.test(out) || /^[\s,.;:)]/.test(t) ? "" : " ";
    out += t;
  }
  return out.replace(/\s{2,}/g, " ").trim();
}
// A gutter: an x that no run on the left reaches across, with runs to its right that are a column of their own (some lines
// there have nothing on their left, or a section heading heads them), not dates set to the right of each line.
function gutterOf(runs: Run[]): number | null {
  if (runs.length < 6) return null;
  const minX = Math.min(...runs.map((r) => r.x));
  const starts = [...new Set(runs.map((r) => Math.round(r.x)))].filter((x) => x > minX + 80).sort((a, b) => a - b);
  for (const g of starts) {
    const left = runs.filter((r) => r.x < g - 1), right = runs.filter((r) => r.x >= g - 1);
    if (left.length < 2 || right.length < 3) continue;
    if (left.some((r) => r.x + widthOf(r) > g + 2)) continue;
    const ys = (xs: Run[]) => new Set(xs.map((r) => Math.round(r.y / 2)));
    const ly = ys(left), ry = ys(right);
    const rightAlone = [...ry].filter((y) => !ly.has(y) && !ly.has(y - 1) && !ly.has(y + 1)).length;
    const heading = right.some((r) => /^[A-Za-z&/ ]{4,40}:?$/.test(r.text.trim()) && r.text.trim().split(/\s+/).length <= 4 && (r.text === r.text.toUpperCase() || /:$/.test(r.text.trim())));
    if (rightAlone >= 2 || heading) return g;
  }
  return null;
}
export function pdfLayoutLines(runs: Run[]): string[] {
  const out: string[] = [];
  const pages = [...new Set((runs ?? []).map((r) => r.page))].sort((a, b) => a - b);
  for (const p of pages) {
    const on = runs.filter((r) => r.page === p && String(r.text).trim());
    const g = gutterOf(on);
    const columns = g === null ? [on] : [on.filter((r) => r.x < g - 1), on.filter((r) => r.x >= g - 1)];
    for (const col of columns) for (const row of rowsOf(col)) { const t = rowText(row); if (t) out.push(t); }
  }
  return out;
}
const unescXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
export function docxResumeLines(xml: string): string[] {
  // A text box is written twice (the drawing, and a picture fallback for old readers): the fallback is not read.
  const doc = String(xml ?? "").replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, "");
  const out: string[] = [];
  const stack: { text: string; list: boolean }[] = [];
  const rows: { cells: string[][]; cell: string[] | null }[] = [];
  const tok = /<w:p\b[^>]*?(\/)?>|<\/w:p>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\b[^>]*\/>|<w:numPr\b|<w:pStyle w:val="(List[^"]*)"|<w:tr\b[^>]*>|<\/w:tr>|<w:tc\b[^>]*>|<\/w:tc>/g;
  let m: RegExpExecArray | null;
  const tidy = (l: string) => l.replace(/[ \t]+/g, " ").replace(/^\s*\|\s*|\s*\|\s*$/g, "").replace(/(?:\s*\|\s*){2,}/g, " | ").trim();
  const put = (l: string) => { const r = rows.length ? rows[rows.length - 1] : null; if (r && r.cell) r.cell.push(l); else out.push(l); };
  const emit = (p: { text: string; list: boolean }) => {
    const lines = p.text.split("\n").map(tidy).filter(Boolean);
    lines.forEach((l, k) => put((p.list || (k > 0 && /^-\s/.test(lines[0]))) && !/^[-•*]\s/.test(l) ? `- ${l}` : l));
  };
  while ((m = tok.exec(doc))) {
    const s = m[0], top = stack.length ? stack[stack.length - 1] : null;
    if (/^<w:p[\s>/]/.test(s)) { if (!m[1]) stack.push({ text: "", list: false }); continue; }
    if (s === "</w:p>") { const p = stack.pop(); if (p) emit(p); continue; }
    if (s.startsWith("<w:tr")) { rows.push({ cells: [], cell: null }); continue; }
    if (s.startsWith("<w:tc")) { const r = rows[rows.length - 1]; if (r) r.cell = []; continue; }
    if (s === "</w:tc>") { const r = rows[rows.length - 1]; if (r && r.cell) { r.cells.push(r.cell); r.cell = null; } continue; }
    if (s === "</w:tr>") {
      const r = rows.pop();
      const cells = (r?.cells ?? []).filter((c) => c.length);
      // A table row of short cells is one line ("Company | Title | Dates"); a table used to lay out the page (a cell of
      // several lines: a column) is read cell by cell, each cell's lines in order.
      const lines = cells.some((c) => c.length > 2) ? cells.flat() : cells.length ? [cells.map((c) => c.join(" ")).join(" | ")] : [];
      for (const l of lines) put(l);
      continue;
    }
    if (!top) continue;
    if (m[2] !== undefined) top.text += unescXml(m[2]);
    else if (s === "<w:tab/>") top.text += " | ";
    else if (s.startsWith("<w:br") || s.startsWith("<w:cr")) top.text += "\n";
    else if (s.startsWith("<w:numPr") || m[3]) top.list = true;
  }
  return out.filter(Boolean);
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
  if (!fileKind(o.doc.name, o.doc.mime) && !untyped(o.doc.name, o.doc.mime)) return { ok: false, reply: FILE_KIND_REPLY, why: "kind" };
  if (o.doc.size === 0) return { ok: false, reply: FILE_EMPTY_REPLY, why: "empty" };
  if (o.doc.size !== null && o.doc.size > MAX_RESUME_BYTES) return { ok: false, reply: FILE_TOO_BIG_REPLY, why: "too_large" };
  const got = await o.fetchFile(o.doc.fileId, MAX_RESUME_BYTES).catch((e) => ({ ok: false as const, error: String(e?.message ?? e) }));
  if (!got.ok) return { ok: false, reply: got.error === "too_large" ? FILE_TOO_BIG_REPLY : FILE_DOWNLOAD_REPLY, why: got.error === "too_large" ? "too_large" : "download" };
  if (!got.bytes.length) return { ok: false, reply: FILE_EMPTY_REPLY, why: "empty" };
  const kind = fileKind(o.doc.name, o.doc.mime, got.bytes);
  if (!kind) return { ok: false, reply: FILE_KIND_REPLY, why: "kind" };
  let text = "", threw = false;
  try { text = await fileText(kind, got.bytes); } catch (e) { threw = true; console.error("resume file: not read:", (e as Error)?.message ?? e); }
  if (text.replace(/\s+/g, "").length < 80) {
    if (kind === "pdf" && encryptedPdf(got.bytes)) return { ok: false, reply: FILE_LOCKED_REPLY, why: "locked" };
    if (threw || cutOff(kind, got.bytes)) return { ok: false, reply: FILE_DAMAGED_REPLY, why: "damaged" };
    return { ok: false, reply: FILE_NO_TEXT_REPLY, why: "no_text" };
  }
  // ONBOARDING ROUND 2: an identity number, a card number or a password in the file. The text the chat reads had it
  // removed, but the file itself was stored as the person's upload (and is the file an application attaches), with the
  // number in it. Now the file is not kept and nothing is read from it; the person is told what to remove.
  const found = redactIdentity(text).removed;
  if (found.length) {
    const name: Record<string, string> = { ssn: "a Social Security number", card: "a card number", account: "an account number", password: "a password", code: "a one-time code", key: "a key or token" };
    return { ok: false, reply: fileSecretReply([...new Set(found.map((k) => name[k] ?? "a private number"))]), why: "secret" };
  }
  const message = resumeMessage(text);
  if (!readsAsResume(message)) return { ok: false, reply: fileNotResumeReply(text), why: "not_resume" };
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
    // ONBOARDING ROUND 2 (flow-scenarios-onboarding-r2.test.ts): a person whose FIRST message is their resume file (what
    // the greeting asks for) has an account but no profiles row yet (agent-chat makes it on their first chat turn), and the
    // upload's foreign key refused the file: "couldn't save it just now ... send it again in a minute", every time. The
    // row is made here first, as agent-chat makes it.
    const p = await admin.from("profiles").upsert({ id: row.userId }, { onConflict: "id" });
    if (p.error) throw new Error(`record the resume file: the profile: ${p.error.message}`);
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
    // ONBOARDING ROUND 3 (2026-11-01, flow-scenarios-onboarding-r3.test.ts): two files whose text reads the same (a PDF and
    // the .docx it was saved from, sent seconds apart) give the same message. The newest upload was taken, so a yes to the
    // entries the FIRST file showed (the second one's turn refused, or still on its way) recorded the second file, one
    // the person was never shown, as their resume. The file is the newest upload received no later than the message
    // that showed its entries (an upload is stored before its message; a resend is stored again as new: 20261031070000).
    let q = admin.from("career_resume_uploads").select("id,provider_ref,sha256").eq("user_id", userId).eq("message_sha256", upload.sha256);
    if (upload.at) q = q.lte("created_at", upload.at);
    const r = await q.order("created_at", { ascending: false }).limit(1);
    const row = r.error ? null : r.data?.[0];
    if (!row) return upload;
    return { kind: "file", ref: `${row.provider_ref} (career_resume_uploads:${row.id})`, sha256: row.sha256, text: upload.text };
  } catch {
    return upload;
  }
}
