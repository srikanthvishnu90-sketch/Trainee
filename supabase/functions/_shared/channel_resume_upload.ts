// FEATURE 16 (2026-10-26): a resume sent as a file on Telegram (a PDF or a Word .docx), read and ingested as the person's
// upload, with its provenance. Before this, a document got "I can't open files sent here yet" (WO-106).
//
//   1. the file is downloaded through the Bot API (getFile, then the file; telegram.ts fetchFile), at most 10 MB;
//   2. its sha256 is taken over the bytes as received, and its text is read by code (CareerRender's own PDF and DOCX
//      readers, the ones the resume renderer's parse check uses), never by a model;
//   3. the file is stored as the person's upload (career_resume_uploads: the provider's file_unique_id, the name, the type,
//      the bytes and their sha256) together with the sha256 of the message the chat receives; a PDF as received, a Word file
//      as its clean copy (cleanDocx, release 8);
//   4. the chat receives "here is my resume:\n<the file's text>", exactly as a pasted resume, so the router reads it
//      into draft entries and shows each one; nothing is confirmed by the upload;
//   5. on the person's later "yes, that's my resume", the evidence step (career_router_evidence.ts, in handler-career.ts)
//      finds this upload by that message's sha256 and records the FILE (its reference and sha256) as the upload each
//      confirmed entry came from (fileUploadFor below), under the same rules: shown word for word, and in the upload.
// A file that cannot be downloaded, is not a PDF or DOCX, or has no readable text is said so, plainly; nothing is stored.
import { CareerProfile, CareerRender } from "./router_core.career.js";
import { normalizeChatText, redactIdentity } from "./identity_redact.ts";
import { fileCodeLines, fileText as codeCheckText, GATE_CTX } from "./career_code_in_chat.ts";
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
// A suspected one-time code in a file: its line number in the text read from the file and its kind only, never the line, so the
// person can find it, remove or reword it, and send the file again.
export function fileCodeReply(lines: number[], otherKinds: string[] = []): string {
  const ls = lines.slice(0, 5), where = ls.length === 1 ? `line ${ls[0]}` : `lines ${ls.slice(0, -1).join(", ")} and ${ls[ls.length - 1]}`;
  const more = lines.length > 5 ? ` (and ${lines.length - 5} more)` : "";
  const also = otherKinds.length ? ` It also has ${otherKinds.join(" and ")} in it.` : "";
  return `Your file has what looks like a one-time code (a sign-in or verification code) on ${where}${more} of the text I read from it, so I didn't keep the file or read anything from it, and I won't repeat ${ls.length > 1 ? "those lines" : "that line"}.${also} ` +
    `Remove the code and send the file again. If ${ls.length > 1 ? "a line" : "it"} isn't a code (an exam, ticket or part number), reword it, for example by writing what the number is for, and send the file again.`;
}
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

// Word parts the reader does not show as resume text, which the stored file carries. Text is taken only where Word keeps text: the
// text runs of headers, footers, notes, comments, glossary and text boxes (w:t, a:t, VML), the body's tracked deletions and field
// instructions, alt text and tooltips, the title, subject, description and keywords of the document properties and custom string
// properties, the query part of link targets, HTML or text "altChunk" parts, and an embedded Word file one level down. Structural
// parts (styles, settings, fonts, numbering, theme, app properties) carry no resume text, but every listed part must still be
// readable: a part the reader cannot read (bad checksum, past the size cap) throws, and the upload fails closed.
const ENTITY: Record<string, string> = { lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&", nbsp: " " };
const decodeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp|nbsp);/gi, (_m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITY[e.toLowerCase()] ?? _m);
const lines = (s: string) => decodeXml(s).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
// Text runs, one paragraph per line; a break or tab keeps its place. Any namespace prefix ("w:", "a:", or one a writer chose).
const P = String.raw`(?:[\w.-]+:)?`;
function runText(xml: string, tags = "t|delText|instrText"): string[] {
  const out: string[] = [];
  for (const para of xml.split(new RegExp(String.raw`</${P}p>`))) {
    let t = "";
    for (const m of para.matchAll(new RegExp(String.raw`<${P}(?:${tags})(?:\s[^>]*)?>([^<]*)</${P}(?:${tags})>|<${P}(?:br|cr)\b[^>]*/?>|<${P}tab\b[^>]*/?>`, "g"))) {
      t += m[1] !== undefined ? m[1] : /tab/.test(m[0]) ? " " : "\n";
    }
    out.push(...lines(t));
  }
  return out;
}
// All character data of a part, a paragraph, break or closing block per line: text a writer put under any tag name.
const allText = (xml: string) => lines(xml.replace(new RegExp(String.raw`</${P}(?:p|tc|tr|txbxContent|div|li)>|<${P}(?:br|cr)\b[^>]*/?>`, "g"), "\n").replace(/<[^>]*>/g, " "));
// A part's text in its declared encoding: a byte-order mark, UTF-16 without one, or the XML declaration's encoding; UTF-8 otherwise.
// Fail closed: a part that does not then read as XML (starts with "<", no NUL character) throws, so the upload is refused.
function decodePart(part: Uint8Array, xml = true): string {
  const b = part, dec = (label: string, at = 0) => { try { return new TextDecoder(label, { fatal: false }).decode(b.subarray(at)); } catch { throw new Error(`unknown encoding ${label}`); } };
  let s: string;
  if (b[0] === 0xff && b[1] === 0xfe && b[2] === 0 && b[3] === 0) throw new Error("UTF-32 part");
  if (b[0] === 0 && b[1] === 0 && b[2] === 0xfe && b[3] === 0xff) throw new Error("UTF-32 part");
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) s = dec("utf-8", 3);
  else if (b[0] === 0xff && b[1] === 0xfe) s = dec("utf-16le", 2);
  else if (b[0] === 0xfe && b[1] === 0xff) s = dec("utf-16be", 2);
  else if (b[1] === 0x00 && b[0] !== 0x00) s = dec("utf-16le");
  else if (b[0] === 0x00 && b[1] !== 0x00) s = dec("utf-16be");
  else {
    const head = new TextDecoder("latin1").decode(b.subarray(0, 200)), enc = /^\s*<\?xml\b[^?>]*?\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1]; // the declaration only
    s = enc && !/^utf-?8$/i.test(enc) ? dec(enc) : dec("utf-8");
  }
  if (s.includes("\u0000") || (xml && !/^\s*</.test(s))) throw new Error("part does not read as XML");
  if (!xml) return s; // a plain-text or MHTML part (altChunk) is text, not XML
  // CDATA is text: escaped and kept, so the tag-stripping readers see it ("<w:t><![CDATA[OTP 482913]]></w:t>"). Found by
  // indexOf, in linear time (a lazy regex over an unclosed "<![CDATA[" repeated took quadratic time).
  if (!s.includes("<![CDATA[")) return s;
  let out = "", at = 0;
  for (;;) {
    const i = s.indexOf("<![CDATA[", at), j = i < 0 ? -1 : s.indexOf("]]>", i + 9);
    if (j < 0) break;
    out += s.slice(at, i) + s.slice(i + 9, j).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    at = j + 3;
  }
  return out + s.slice(at);
}
// What a global lazy regex `open[\s\S]*?close` matches (with `keyed`, a close whose first group equals the open's, as a
// backreference), found in linear time: each open, from the end of the last match, takes the first close after it.
function lazySpans(s: string, open: RegExp, close: RegExp, keyed = false): [number, number][] {
  const closes = new Map<string, [number, number][]>();
  for (const m of s.matchAll(close)) { const k = keyed ? m[1] : "", l = closes.get(k) ?? []; l.push([m.index!, m.index! + m[0].length]); closes.set(k, l); }
  const ptr = new Map<string, number>(), out: [number, number][] = [];
  let cursor = 0;
  for (const m of s.matchAll(open)) {
    const at = m.index!, k = keyed ? m[1] : "";
    if (at < cursor) continue;
    const list = closes.get(k) ?? [], from = at + m[0].length;
    let p = ptr.get(k) ?? 0;
    while (p < list.length && list[p][0] < from) p++;
    ptr.set(k, p);
    if (p >= list.length) continue;
    out.push([at, list[p][1]]);
    cursor = list[p][1];
  }
  return out;
}
const cutSpans = (s: string, spans: [number, number][], put = "") => {
  let out = "", at = 0;
  for (const [a, b] of spans) { out += s.slice(at, a) + put; at = b; }
  return out + s.slice(at);
};
// A link target as the gate reads it: the address without its query as one line, then one "key: value" line per query
// parameter and the fragment, decoded. A query read whole ("?type=design&node-id=1-2&t=Zx81kQ2HnB-0", a Figma or UTM link)
// looked like a code to the gate; a parameter on its own line keeps its key as its label ("code: 482913" still refuses).
export function urlGateLines(url: string, withBase = true): string[] {
  const dec = (x: string) => { try { return decodeURIComponent(x.replace(/\+/g, " ")); } catch { return x; } };
  const u = String(url ?? ""), q = u.search(/[?#]/), base = q < 0 ? u : u.slice(0, q), rest = q < 0 ? "" : u.slice(q);
  const hash = rest.indexOf("#"), query = (hash < 0 ? rest : rest.slice(0, hash)).replace(/^\?/, ""), frag = hash < 0 ? "" : rest.slice(hash + 1);
  const out = withBase && base.trim() ? [dec(base)] : [];
  for (const kv of query.split("&")) {
    if (!kv) continue;
    const e = kv.indexOf("=");
    out.push(e < 0 ? `parameter: ${dec(kv)}` : `${dec(kv.slice(0, e))}: ${dec(kv.slice(e + 1))}`);
  }
  if (frag) out.push(`fragment: ${dec(frag)}`);
  return out.map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 1);
}
// Attribute values by their XML meaning: either quote, any prefix, spaces around "=".
const attr = (names: string) => new RegExp(String.raw`\s${P}(?:${names})\s*=\s*(?:"([^"]*)"|'([^']*)')`, "g");
const attrVals = (xml: string, names: string) => [...xml.matchAll(attr(names))].map((m) => m[1] ?? m[2] ?? "");
const attrText = (xml: string) => [...attrVals(xml, "descr|title|tooltip"),
  ...[...xml.matchAll(new RegExp(String.raw`<${P}textpath\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "g"))].flatMap((m) => attrVals(m[0], "string"))].flatMap((v) => lines(v));
// Leaf elements of a properties part, one line each, under any prefix. Core: every text property except the numeric and date
// metadata Word writes (revision, version, dates, language). Custom: the string values.
const leaves = (xml: string, keep: (name: string) => boolean) => [...xml.matchAll(new RegExp(String.raw`<${P}([\w.-]+)(?:\s[^>]*)?>([^<]*)</${P}\1>`, "g"))]
  .filter((m) => keep(m[1])).flatMap((m) => lines(m[2]));
const CORE_META = /^(?:revision|version|created|modified|lastPrinted|language)$/i;
// An MHTML part: each MIME body decoded by its transfer encoding (an encoding it cannot read throws: the file is refused),
// HTML bodies read as text, MIME headers and boundaries left out.
function mimeText(s: string): string[] {
  const html = (t: string) => lines(t.replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, "\n").replace(/<[^>]*>/g, " "));
  if (/^\s*</.test(s)) return html(s);
  const bound = /boundary\s*=\s*(?:"([^"]+)"|([^\s;]+))/i.exec(s);
  const parts = bound ? s.split("--" + (bound[1] ?? bound[2])).slice(1) : [s];
  const out: string[] = [];
  for (const part of parts) {
    const at = part.search(/\r?\n\r?\n/);
    if (at < 0) { if (part.trim() && part.trim() !== "--") out.push(...lines(part)); continue; }
    const head = part.slice(0, at), body = part.slice(at).replace(/^\r?\n\r?\n/, "");
    const enc = (/content-transfer-encoding\s*:\s*([\w-]+)/i.exec(head)?.[1] ?? "7bit").toLowerCase();
    let text: string;
    // A body is read in its declared charset (UTF-8 when none); a charset the decoder does not know throws.
    const cs = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(head)?.[1] ?? "utf-8", txt = (b: Uint8Array) => {
      // A byte-order mark that contradicts the declared charset cannot be read safely: the file is refused.
      const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? "utf-8" : b[0] === 0xff && b[1] === 0xfe ? "utf-16le" : b[0] === 0xfe && b[1] === 0xff ? "utf-16be" : null;
      const label = new TextDecoder(cs).encoding;
      if (bom && !(bom === label || (bom.startsWith("utf-16") && /^utf-16$/i.test(cs)))) throw new Error(`byte-order mark ${bom} contradicts charset ${cs}`);
      return new TextDecoder(bom ?? cs, { fatal: false }).decode(b); // a (consistent) mark decides the byte order
    };
    if (enc === "base64") { const raw = atob(body.replace(/\s+/g, "")); text = txt(Uint8Array.from(raw, (c) => c.charCodeAt(0))); }
    else if (enc === "quoted-printable") { const b = body.replace(/=\r?\n/g, ""); const bytes: number[] = []; for (let i = 0; i < b.length; i++) { const h = b[i] === "=" && /^[0-9a-f]{2}$/i.test(b.slice(i + 1, i + 3)); bytes.push(h ? parseInt(b.slice(i + 1, i + 3), 16) : b.charCodeAt(i)); if (h) i += 2; } text = txt(new Uint8Array(bytes)); }
    // A raw body was read with the part (UTF-8): any other declared charset cannot be read safely here, so the file is refused.
    else if (/^(?:7bit|8bit|binary)$/.test(enc)) { if (!/^(?:utf-?8|us-ascii|ascii)$/i.test(cs)) throw new Error(`raw MIME body in ${cs}`); text = body; }
    else throw new Error(`unknown transfer encoding ${enc}`);
    if (text.includes("\u0000")) throw new Error("MIME body does not read as text"); // a wrong charset fails closed
    out.push(...(/content-type\s*:\s*text\/plain/i.test(head) ? lines(text) : html(text)));
  }
  return out;
}
const STRUCTURAL = /^(?:word\/(?:styles|stylesWithEffects|settings|webSettings|fontTable|numbering|people|commentsIds|commentsExtensible|commentsExtended)\.xml|word\/theme\/[^/]+\.xml|docProps\/app\.xml|\[Content_Types\]\.xml|customXml\/[^/]+\.xml|word\/(?:glossary\/)?(?:styles|settings|webSettings|fontTable|numbering)\.xml)$/i;
// One budget per upload for every part the Word checks expand (the hidden reader, the clean copy and an embedded Word file):
// the zip reader's own size cap starts again at each part read, so a small upload of hundreds of highly compressed parts, each
// under the per-part cap, expanded to hundreds of MB. Past the budget the read throws and the upload is refused as damaged.
// A zip that names one entry twice is refused before any part is read: the reader expands every central-directory entry with
// the asked name and returns the last, so repeated large entries behind a small final one escaped the budget (Greptile on #584).
// The check walks the same central directory the reader does (end record, then each entry), never the entries' data, so an
// embedded file's own headers are not read as names (review of 11a70b71). Exact and case-insensitive.
function zipNamesUnique(b: Uint8Array): void {
  const dec = new TextDecoder("utf-8", { fatal: false }), seen = new Set<string>();
  const u16 = (i: number) => b[i] | (b[i + 1] << 8), u32 = (i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 65536; i--) if (u32(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return; // not a zip the reader can read; the reader fails on its own
  const count = u16(eocd + 10);
  let p = u32(eocd + 16);
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (u32(p) !== 0x02014b50) break;
    const nameLen = u16(p + 28), extraLen = u16(p + 30), commentLen = u16(p + 32);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen)), k = name.toLowerCase();
    if (seen.has(k)) throw new Damaged(`a part named twice: ${name}`);
    seen.add(k);
    p += 46 + nameLen + extraLen + commentLen;
  }
}
export const UPLOAD_EXPANDED_MAX = 25 * 1024 * 1024, UPLOAD_PARTS_MAX = 2000;
export class UploadBudget {
  bytes = 0;
  parts = 0;
  constructor(readonly maxBytes = UPLOAD_EXPANDED_MAX, readonly maxParts = UPLOAD_PARTS_MAX) {}
  // deno-lint-ignore no-explicit-any
  names(r: any, buf: any): string[] {
    zipNamesUnique(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    const names: string[] = r.docxPartNames(buf) ?? [];
    if (names.length > this.maxParts) throw new Damaged(`too many parts: ${names.length}`);
    return names;
  }
  // deno-lint-ignore no-explicit-any
  part(r: any, buf: any, name: string): any {
    if (++this.parts > this.maxParts) throw new Damaged("too many parts read");
    if (this.bytes >= this.maxBytes) throw new Damaged("expanded size over the upload budget");
    const p = r.docxPart(buf, name);
    this.bytes += p?.length ?? 0;
    if (this.bytes > this.maxBytes) throw new Damaged("expanded size over the upload budget");
    return p;
  }
}
// deno-lint-ignore no-explicit-any
async function hiddenOf(r: any, buf: any, depth: number, budget: UploadBudget): Promise<string[]> {
  const names = budget.names(r, buf);
  if (!names.includes("word/document.xml")) throw new Error("no document part");
  const out: string[] = [];
  for (const n of names) {
    const text = /\.(?:xml|rels|vml|html?|txt|mht|docx)$/i.test(n), part = text ? budget.part(r, buf, n) : null;
    if (text && !part) throw new Error(`part not readable: ${n}`);
    if (!part || STRUCTURAL.test(n)) continue;
    if (/\.docx$/i.test(n)) {
      if (depth > 0) throw new Error(`nested file too deep: ${n}`);
      budget.part(r, part, "word/document.xml"); // the embedded file's document, which its visible reader expands once more
      out.push(...(r.extractDocxLines?.(part) ?? []).map(String), ...(await hiddenOf(r, part, depth + 1, budget)));
      continue;
    }
    const s = decodePart(new Uint8Array(part), !/\.(?:txt|mht)$/i.test(n));
    if (n === "word/document.xml") {
      // (Spans in linear time: an unclosed <mc:Fallback>, <a:p> or <w:p> repeated 80,000 times took 27 s with lazy regexes.)
      const fallbacks = lazySpans(s, new RegExp(String.raw`<${P}Fallback\b`, "g"), new RegExp(String.raw`</${P}Fallback>`, "g")).flatMap(([a, b]) => allText(s.slice(a, b)));
      // DrawingML and other non-w text, its runs joined per paragraph ("O" "T" "P" ": " "4" ... reads "OTP: 4...").
      const nonWt = [...s.matchAll(/<((?!w:)[\w.-]+):t(?:\s[^>]*)?>([^<]*)<\/\1:t>/g)].map((m) => m[2]).join("");
      const nonW = lazySpans(s, /<((?!w:)[\w.-]+):p\b/g, /<\/([\w.-]+):p>/g, true).flatMap(([a, b]) => runText(s.slice(a, b))).concat(nonWt.trim() ? lines(nonWt) : []);
      // Text runs outside any paragraph (the visible reader reads paragraphs only).
      const loose = runText(cutSpans(s, lazySpans(s, new RegExp(String.raw`<${P}p\b`, "g"), new RegExp(String.raw`</${P}p>`, "g")), "\n"));
      out.push(...runText(s, "delText|instrText"), ...attrText(s), ...fallbacks, ...nonW, ...loose); continue;
    }
    // A link target: an external address whole (without its query) and each query parameter as "key: value"; a part's own
    // target (styles.xml, media/image1.png) by its parameters only.
    if (/\.rels$/i.test(n)) {
      for (const m of s.matchAll(new RegExp(String.raw`<${P}Relationship\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "g"))) {
        const target = decodeXml(attrVals(m[0], "Target")[0] ?? ""), external = /^external$/i.test(attrVals(m[0], "TargetMode")[0] ?? "");
        out.push(...urlGateLines(target, external));
      }
      continue;
    }
    // Document properties under any prefix, one property per line (numeric and date metadata left out).
    if (/^docProps\/core\.xml$/i.test(n)) { out.push(...leaves(s, (k) => !CORE_META.test(k)), ...attrText(s)); continue; }
    if (/^docProps\/custom\.xml$/i.test(n)) { out.push(...leaves(s, (k) => /^(?:lpw?str|bstr)$/i.test(k)), ...attrText(s)); continue; }
    if (/\.txt$/i.test(n)) { out.push(...s.split(/\r?\n|\r/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean)); continue; } // literal text
    if (/\.mht$/i.test(n)) { out.push(...mimeText(s)); continue; }
    if (/\.html?$/i.test(n)) { out.push(...lines(s.replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, "\n").replace(/<[^>]*>/g, " "))); continue; }
    if (/\.vml$/i.test(n)) { out.push(...lines(s.replace(/<\/(?:div|p)>|<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " ")), ...attrText(s)); continue; }
    out.push(...runText(s), ...allText(s), ...attrText(s));
  }
  return out;
}
export async function docxHiddenText(bytes: Uint8Array, budget = new UploadBudget()): Promise<string> {
  reader ??= Promise.all([import("node:zlib"), import("node:crypto"), import("node:buffer")])
    // deno-lint-ignore no-explicit-any
    .then(([zlib, crypto, b]) => ({ r: (CareerRender as any).withRuntime({ zlib, crypto, Buffer: b.Buffer }), Buffer: b.Buffer }));
  const { r, Buffer } = await reader;
  return (await hiddenOf(r, Buffer.from(bytes), 0, budget)).join("\n");
}
export const FILE_HIDDEN_CODE_REPLY = "Your file has what looks like a one-time code or another private number in a header, footer, note, comment or tracked change, so I didn't keep the file or read anything from it, and I won't repeat it. Remove it (and accept or reject tracked changes) and send the file again, or paste your resume here.";

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
const unescXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(x[0-9a-f]+|\d+);/gi, (_m, n: string) => { const c = /^x/i.test(n) ? parseInt(n.slice(1), 16) : Number(n); return c <= 0x10ffff ? String.fromCodePoint(c) : _m; }).replace(/&amp;/g, "&");
export function docxResumeLines(xml: string): string[] {
  // A text box is written twice (the drawing, and a picture fallback for old readers): the fallback is not read.
  const src = String(xml ?? ""), doc = cutSpans(src, lazySpans(src, /<mc:Fallback\b/g, /<\/mc:Fallback>/g)); // linear time
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
  // normalised exactly as chat_input.ts normalises a message, so this message's sha256 matches the stored text (Greptile on #567)
  let body = normalizeChatText(String(text ?? "")).trim();
  const head = "here is my resume:\n";
  if (head.length + body.length > MAX_MESSAGE) {
    body = body.slice(0, MAX_MESSAGE - head.length);
    const cut = body.lastIndexOf("\n");
    if (cut > 0) body = body.slice(0, cut);
  }
  return redactIdentity(`${head}${body}`.trim()).text;
}

// ONBOARDING ROUND 4 (2026-11-05, tests/architect/scenarios-onboarding-r4.test.ts): a file's text longer than the chat reads
// at once (a dense two-page resume) was cut at 4,000 characters without a word: the person was shown the entries before
// the cut, confirmed them as "your resume", and never learned the rest of their jobs and skills were not read. A pasted
// message cut the same way is told (channel_inbound.ts longCutNote); a file now is too, with where the reading stopped.
export function resumeMessageCut(text: string): boolean {
  return "here is my resume:\n".length + normalizeChatText(String(text ?? "")).trim().length > MAX_MESSAGE;
}
export function fileCutNote(message: string): string {
  const last = String(message ?? "").trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  const tail = last.length > 60 ? `…${last.slice(-60).trim()}` : last;
  return `Your file's text is longer than the 4,000 characters I can read at once, so I read it only up to "${tail}". Nothing after that is on your record or in the entries below. If an entry you need is missing, send a shorter version (one or two pages) as a PDF or Word file.`;
}
// ONBOARDING ROUND 4: the name the file is stored and later attached under. A long Telegram file name was cut at 200
// characters (telegram.ts), so the file was kept, and attached to applications, with no extension ("My Resume Final ...
// My Resum"); a name over 200 characters reaching this function failed the upload's own check ("couldn't save it just
// now", for ever); a name with a line break or a path ("../../x.pdf") was stored as sent; and a PDF named "resume.docx" was
// kept, and attached, as a Word file. The name now has no control characters or path, at most 120 characters, and the
// extension and type of what the bytes are.
export function storedFilename(name: string, kind: FileKind): string {
  const ext = kind === "pdf" ? ".pdf" : ".docx";
  let base = String(name ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/[\/\\]/g, " ")
    .replace(/\s+/g, " ").trim();
  base = base.replace(/\.(?:pdf|docx?|rtf|odt|txt|pages|png|jpe?g|gif|heic|webp|zip)$/i, "").replace(/^[.\s]+/, "").trim();
  if ([...base].length > 120) base = [...base].slice(0, 120).join("").trim();
  return `${base || "resume"}${ext}`;
}
export const KIND_MIME: Record<FileKind, string> = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

// RELEASE 8 (owner decision, 2026-11-07: "store a cleaned copy"). A Word file is never stored as sent. Each review found a new
// place in the original bytes where a one-time code could sit unread (comments, processing instructions, w:sym digits, field
// instructions, form-field entries, alt text, unknown namespaces, numbering, settings, app properties, custom XML, odd altChunk
// parts), and the original bytes, code and all, were stored. Now a CLEAN copy is rebuilt from an allowlist, gated, and only
// it is stored: the person's resume as Trainee will structure and submit it, so it must also be FAITHFUL.
//   - Parts kept: the body, the headers and footers it references, styles, numbering, settings (the layout settings only), the
//     theme (its colours and fonts), the png/jpeg/gif images the kept parts show (metadata chunks removed), and external links.
//     Every other part (document properties, custom XML, comments, people, notes, glossary, altChunk and embedded files,
//     macros, fonts, web settings) is left out; the content types and relationships are written afresh.
//   - Each kept XML part is read by one linear forward tokenizer and written again element by element: WordprocessingML text,
//     paragraphs, runs, tables, text boxes (wps), pictures, formatting (rPr/pPr/tblPr/tcPr/sectPr and their children) and
//     their value attributes are kept; tracked deletions, field instructions (a field's displayed result is kept), w:sym's
//     digits as text (checked), content-control properties, form fields, bookmarks, comment marks, mc:Fallback copies,
//     VML-only pictures, extension markup, comments and processing instructions are dropped. An attribute is kept only if it
//     is allowlisted: no rsids, names, descr/title, instr, anchor or tooltip, nothing in another namespace, and no value with
//     letters and four or more digits in one word.
//   - Faithfulness first: a construct that cannot be kept without losing what the person sees (an equation, an embedded
//     object, an altChunk, a footnote, a chart or SmartArt, a VML picture with text in it, an image in another format, an
//     unreadable part, or any unknown element carrying text) refuses the file as damaged rather than store a lossy copy.
//   - The clean copy's text (headers, footers and text boxes included), every attribute value ("name: value") and every link
//     target (urlGateLines) is gated before anything is stored.
class Damaged extends Error {}
const NS: Record<string, string> = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main", r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture", wps: "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
  wpg: "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup", mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
  wp14: "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing", w14: "http://schemas.microsoft.com/office/word/2010/wordml",
  a14: "http://schemas.microsoft.com/office/drawing/2010/main",
};
const NS_DECL = Object.entries(NS).map(([p, u]) => ` xmlns:${p}="${u}"`).join("");
const GRAPHIC_URIS = new Set([NS.pic, NS.wps, NS.wpg]);
const MC_REQUIRES = new Set(["wps", "wpg", "wp14", "w14", "a14"]);
const DML = new Set(["wp", "a", "pic", "wps", "wpg"]);
const ENT5: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };
function xmlDecode(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|(lt|gt|amp|quot|apos));|&/g, (_m, h?: string, d?: string, n?: string) => {
    if (n) return ENT5[n];
    if (h === undefined && d === undefined) throw new Damaged("an undefined entity");
    const cp = h !== undefined ? parseInt(h, 16) : parseInt(d!, 10);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13)) throw new Damaged("a character XML does not allow");
    return String.fromCodePoint(cp);
  });
}
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");
type XmlHandler = { start(name: string, attrs: [string, string][], self: boolean): void; end(name: string): void; text(t: string): void };
const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
// One forward pass over the part: every search is an indexOf or a character step from the current position, never a regex
// over the rest of the document. A malformed part (an unclosed tag, comment or quote, a DOCTYPE) is damaged.
function scanXml(s: string, h: XmlHandler): void {
  const n = s.length, ws = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
  let i = 0;
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt < 0) { h.text(xmlDecode(s.slice(i))); break; }
    if (lt > i) h.text(xmlDecode(s.slice(i, lt)));
    if (s.startsWith("<!--", lt)) { const e = s.indexOf("-->", lt + 4); if (e < 0) throw new Damaged("an unclosed comment"); i = e + 3; continue; }
    if (s.startsWith("<?", lt)) { const e = s.indexOf("?>", lt + 2); if (e < 0) throw new Damaged("an unclosed instruction"); i = e + 2; continue; }
    if (s.startsWith("<![CDATA[", lt)) { const e = s.indexOf("]]>", lt + 9); if (e < 0) throw new Damaged("unclosed CDATA"); h.text(s.slice(lt + 9, e)); i = e + 3; continue; }
    if (s.startsWith("<!", lt)) throw new Damaged("a DOCTYPE");
    let j = lt + 1;
    const close = s[j] === "/";
    if (close) j++;
    const ns = j;
    while (j < n && !ws(s.charCodeAt(j)) && s[j] !== ">" && s[j] !== "/") j++;
    const name = s.slice(ns, j);
    if (!NAME.test(name)) throw new Damaged("a bad element name");
    if (close) {
      while (j < n && ws(s.charCodeAt(j))) j++;
      if (s[j] !== ">") throw new Damaged("a bad end tag");
      h.end(name); i = j + 1; continue;
    }
    const attrs: [string, string][] = [];
    for (;;) {
      while (j < n && ws(s.charCodeAt(j))) j++;
      if (j >= n) throw new Damaged("an unclosed tag");
      if (s[j] === ">") { h.start(name, attrs, false); i = j + 1; break; }
      if (s[j] === "/") { if (s[j + 1] !== ">") throw new Damaged("a bad tag"); h.start(name, attrs, true); i = j + 2; break; }
      const as = j;
      while (j < n && !ws(s.charCodeAt(j)) && s[j] !== "=" && s[j] !== ">" && s[j] !== "/") j++;
      const an = s.slice(as, j);
      if (!NAME.test(an)) throw new Damaged("a bad attribute name");
      while (j < n && ws(s.charCodeAt(j))) j++;
      if (s[j] !== "=") throw new Damaged("an attribute with no value");
      j++;
      while (j < n && ws(s.charCodeAt(j))) j++;
      const q = s[j];
      if (q !== "\"" && q !== "'") throw new Damaged("an unquoted attribute");
      const e = s.indexOf(q, j + 1);
      if (e < 0) throw new Damaged("an unclosed attribute");
      const raw = s.slice(j + 1, e);
      if (raw.includes("<")) throw new Damaged("a < in an attribute");
      attrs.push([an, xmlDecode(raw)]);
      j = e + 1;
    }
  }
}
const pfx = (q: string) => { const k = q.indexOf(":"); return k < 0 ? "" : q.slice(0, k); };
const loc = (q: string) => q.slice(q.indexOf(":") + 1);
// A value kept only in its allowlisted shape: short, no control characters, and no word with letters and four or more digits.
// deno-lint-ignore no-control-regex
const valueOk = (v: string) => v.length <= 256 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) && (/^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(v) || !v.split(/\s+/).some((w) => /\p{L}/u.test(w) && /\d{4,}/.test(w)));
// A style id is the name pStyle/rStyle/basedOn refer to; one that fails the value shape is renamed, the same way everywhere.
const styleId = (v: string) => {
  if (valueOk(v) && v.length <= 64) return v;
  let h = 2166136261;
  for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v.charCodeAt(i), 16777619) >>> 0;
  let s = "";
  for (let k = 0; k < 7; k++) { s += String.fromCharCode(97 + (h % 26)); h = Math.floor(h / 26); }
  return `Style${s}`;
};
// The label an attribute value is gated under: its own name, unless that name is itself one of the gate's code words ("type",
// "key"), when the element's name labels it ("tblStylePr: band1Vert", not "type: band1Vert", which reads like "type 1").
const gateLabel = (attr: string, element: string) => attr === "type" ? loc(element) : attr;
// An attribute name kept only as a plain name that is no code word ("w:code", "w:otp482913" are dropped; review of 64c7f13b).
const attrNameOk = (al: string) => /^[A-Za-z]{1,40}$/.test(al) && (al === "type" || !GATE_CTX.test(al));
// Fields kept with their instruction: page numbers, dates and links; any other instruction is dropped (its shown result stays).
const FIELD_OK = /^\s*(?:PAGE|NUMPAGES|SECTIONPAGES|DATE|TIME|HYPERLINK\s+"https?:\/\/[^"\s?#]{1,200}")(?:\s+\\[*@#]\s*(?:"[^"]{0,20}"|[A-Za-z]{1,20}))*\s*$/;
const STYLE_REF = new Set(["w:pStyle", "w:rStyle", "w:tblStyle", "w:basedOn", "w:next", "w:link", "w:numStyleLink", "w:styleLink"]);
// Attributes that carry a writer's free text, never a format: dropped wherever they are.
const W_FREE = new Set(["instr", "anchor", "tooltip", "docLocation", "tgtFrame", "author", "date", "initials", "paraId", "textId"]);
// Kept text never goes elsewhere, so these hold nothing the person sees: dropped silently.
const SILENT = new Set(["w:del", "w:moveFrom", "w:bookmarkStart", "w:bookmarkEnd", "w:commentRangeStart", "w:commentRangeEnd", "w:permStart", "w:permEnd", "w:proofErr",
  "w:moveFromRangeStart", "w:moveFromRangeEnd", "w:moveToRangeStart", "w:moveToRangeEnd", "w:customXmlInsRangeStart", "w:customXmlInsRangeEnd", "w:customXmlDelRangeStart",
  "w:customXmlDelRangeEnd", "w:customXmlMoveFromRangeStart", "w:customXmlMoveFromRangeEnd", "w:customXmlMoveToRangeStart", "w:customXmlMoveToRangeEnd",
  "w:lastRenderedPageBreak", "w:delText", "w:delInstrText", "w:commentReference", "w:annotationRef", "w:separator", "w:continuationSeparator",
  "w:footnoteRef", "w:endnoteRef", "mc:Fallback", "w:sdtPr", "w:sdtEndPr", "w:smartTagPr", "w:customXmlPr", "w:fldData"]);
// What the person sees but a clean copy cannot keep faithfully: the file is refused as damaged.
const LOSSY = new Set(["w:altChunk", "m:oMath", "m:oMathPara", "w:subDoc", "w:object", "w:footnoteReference", "w:endnoteReference", "w:ruby", "w:control", "w:contentPart",
  "w:embedObject", "w:movie"]);
const IGNORABLE = /^(?:w1\d\w*|wp1\d|a1\d\w*|asvg|thm1\d|w16\w*|a16\w*|wne)$/; // extension markup a reader may ignore
const PROPS_DROP = new Set(["ins", "del", "moveFrom", "moveTo", "rsid", "rsids", "rsidRoot", "latentStyles", "aliases", "numPicBullet", "lvlPicBulletId", "nsid", "tmpl",
  "numIdMacAtCleanup", "docVars", "docVar", "attachedTemplate", "placeholder", "dataBinding"]);
const SETTINGS_KEEP = new Set(["defaultTabStop", "evenAndOddHeaders", "mirrorMargins", "gutterAtTop", "autoHyphenation", "consecutiveHyphenLimit", "hyphenationZone",
  "doNotHyphenateCaps", "characterSpacingControl", "compat", "themeFontLang", "decimalSymbol", "listSeparator", "bordersDoNotSurroundHeader", "bordersDoNotSurroundFooter",
  "defaultTableStyle", "displayBackgroundShape", "noPunctuationKerning", "clrSchemeMapping", "doNotUseHTMLParagraphAutoSpacing"]);
const RUN_LEAF = new Set(["w:tab", "w:br", "w:cr", "w:ptab", "w:noBreakHyphen", "w:softHyphen", "w:pgNum", "w:dayShort", "w:monthShort", "w:yearShort", "w:dayLong", "w:monthLong", "w:yearLong"]);
type PartKind = "document" | "header" | "footer" | "styles" | "numbering" | "settings" | "theme";
const ROOT: Record<PartKind, string> = { document: "w:document", header: "w:hdr", footer: "w:ftr", styles: "w:styles", numbering: "w:numbering", settings: "w:settings", theme: "a:theme" };
type Kind = "root" | "block" | "p" | "runc" | "r" | "t" | "instr" | "props" | "tbl" | "tr" | "dml" | "txbx" | "skip";
type Frame = { name: string; keep: boolean; ck: Kind; sp?: "sdt" | "mc" | "sym" | "lvl"; check?: "pict" | "unknown"; body?: boolean; tc?: boolean; lastP?: boolean; chosen?: boolean; leafText?: RegExp };
type RelFn = (element: string, attr: string, id: string) => string | null;
class CleanPart implements XmlHandler {
  out: string[] = []; gate: string[] = []; attrLines = new Set<string>();
  private stack: Frame[] = []; private done = false;
  constructor(private part: PartKind, private rel: RelFn) {}
  private emit(real: string, gate = real) { this.out.push(real); this.gate.push(gate); }
  private top() { return this.stack[this.stack.length - 1]; }
  private container() { for (let k = this.stack.length - 1; k >= 0; k--) if (this.stack[k].keep) return this.stack[k]; return undefined; }
  private attrsOf(name: string, kind: Kind, attrs: [string, string][]): string | null {
    let out = "";
    const dml = DML.has(pfx(name)) || pfx(name) === "a";
    for (const [an, v] of attrs) {
      const ap = pfx(an), al = loc(an);
      if (an === "xmlns" || ap === "xmlns") continue;
      if (an === "xml:space") { if (v === "preserve") out += ` xml:space="preserve"`; continue; }
      if (ap === "r") {
        if (al !== "id" && al !== "embed") continue;
        const nid = this.rel(name, al, v);
        if (nid === null) { if (name === "w:headerReference" || name === "w:footerReference") return null; continue; }
        out += ` r:${al}="${nid}"`;
        continue;
      }
      if (!attrNameOk(al)) continue;
      let val = v;
      if (ap === "w") {
        if (al.startsWith("rsid") || W_FREE.has(al)) continue;
        if ((STYLE_REF.has(name) && al === "val") || (name === "w:style" && al === "styleId")) val = styleId(v);
        if (name === "w:lvlText" && al === "val") {
          // A list label: its level numbers (%1) and a bullet glyph or punctuation, never a figure or long text of its own.
          if (/\p{N}/u.test(v.replace(/%[1-9]/g, "")) || v.length > 12) throw new Damaged("a list label with text in it");
        }
      } else if (ap === "" && (dml || pfx(name) === "mc")) {
        if (al === "descr" || al === "title") continue;
        if (al === "name") val = /^(?:docPr|cNvPr)$/.test(loc(name)) ? "Shape" : /^(?:theme|clrScheme|fontScheme|fmtScheme)$/.test(loc(name)) ? "Office" : v;
        if (name === "mc:Choice" && al === "Requires") { if (!v.split(/\s+/).filter(Boolean).every((t) => MC_REQUIRES.has(t))) throw new Damaged(`content that needs ${v}`); }
        if (name === "a:graphicData" && al === "uri" && !GRAPHIC_URIS.has(v)) throw new Damaged("a chart, diagram or other graphic");
      } else continue; // any other namespace, or an unprefixed attribute on WordprocessingML
      if (!valueOk(val)) { if (kind === "props") return null; continue; }
      out += ` ${an}="${escAttr(val)}"`;
      this.attrLines.add(`${gateLabel(al, name)}: ${val}`.replace(/\s+/g, " ").trim());
    }
    if (name === "a:blip" && !/ r:embed="/.test(out)) throw new Damaged("a linked picture");
    return out;
  }
  // How a child element is kept, from its parent's context.
  private classify(f: Frame, name: string): Frame {
    const keep = (ck: Kind, extra: Partial<Frame> = {}): Frame => ({ name, keep: true, ck, ...extra });
    const unwrap = (ck: Kind, extra: Partial<Frame> = {}): Frame => ({ name, keep: false, ck, ...extra });
    const skip = (check?: "pict" | "unknown"): Frame => ({ name, keep: false, ck: "skip", check });
    const p = pfx(name);
    if (LOSSY.has(name)) throw new Damaged(`${name} cannot be kept`);
    if (/\d{3,}/.test(loc(name)) || (GATE_CTX.test(loc(name)) && loc(name) !== "type")) return skip("unknown");
    if (SILENT.has(name) || IGNORABLE.test(p)) return skip();
    if (f.sp === "sdt") return name === "w:sdtContent" ? unwrap(f.ck) : skip("unknown");
    if (f.sp === "mc") {
      if (name !== "mc:Choice") return skip("unknown");
      if (f.chosen) return skip();
      f.chosen = true;
      return keep(f.ck);
    }
    switch (f.ck) {
      case "root":
        if (this.part === "document") return name === "w:body" ? keep("block", { body: true }) : name === "w:background" ? keep("props") : skip("unknown");
        if (this.part === "settings") return p === "w" && SETTINGS_KEEP.has(loc(name)) ? keep("props") : skip();
        return skip("unknown");
      case "block":
        if (name === "w:p") return keep("p");
        if (name === "w:tbl") return keep("tbl");
        if (name === "w:sectPr" && f.body) return keep("props");
        if (name === "w:tcPr" && f.tc) return keep("props");
        if (name === "w:sdt") return unwrap("block", { sp: "sdt" });
        if (name === "w:customXml" || name === "w:ins" || name === "w:moveTo") return unwrap("block");
        if (name === "mc:AlternateContent") return keep("block", { sp: "mc" });
        return skip("unknown");
      case "p": case "runc":
        if (name === "w:pPr" && f.ck === "p" && f.keep) return keep("props");
        if (name === "w:r") return keep("r");
        if (name === "w:hyperlink" || name === "w:dir" || name === "w:bdo") return keep("runc");
        if (name === "w:fldSimple" || name === "w:smartTag" || name === "w:customXml" || name === "w:ins" || name === "w:moveTo") return unwrap("runc");
        if (name === "w:sdt") return unwrap("runc", { sp: "sdt" });
        if (name === "mc:AlternateContent") return keep("runc", { sp: "mc" });
        return skip("unknown");
      case "r":
        if (name === "w:rPr") return keep("props");
        if (name === "w:t") return keep("t");
        if (name === "w:fldChar") return keep("props");
        if (name === "w:instrText") return keep("instr");
        if (RUN_LEAF.has(name)) return keep("props");
        if (name === "w:sym") return keep("props", { sp: "sym" });
        if (name === "w:drawing") return keep("dml");
        if (name === "mc:AlternateContent") return keep("r", { sp: "mc" });
        if (name === "w:pict") return skip("pict");
        return skip("unknown");
      case "tbl":
        if (name === "w:tblPr" || name === "w:tblGrid") return keep("props");
        if (name === "w:tr") return keep("tr");
        if (name === "w:sdt") return unwrap("tbl", { sp: "sdt" });
        if (name === "w:customXml" || name === "w:ins" || name === "w:moveTo") return unwrap("tbl");
        return skip("unknown");
      case "tr":
        if (name === "w:trPr" || name === "w:tblPrEx") return keep("props");
        if (name === "w:tc") return keep("block", { tc: true });
        if (name === "w:sdt") return unwrap("tr", { sp: "sdt" });
        if (name === "w:customXml" || name === "w:ins" || name === "w:moveTo") return unwrap("tr");
        return skip("unknown");
      case "props": {
        const l = loc(name);
        if (p !== "w" || PROPS_DROP.has(l) || l.endsWith("Change")) return skip();
        if (this.part === "numbering" && l === "name") return skip();
        return keep("props", name === "w:lvlText" ? { sp: "lvl" } : {});
      }
      case "dml":
        if (name === "mc:AlternateContent") return keep("dml", { sp: "mc" });
        if (!DML.has(p)) return skip("unknown");
        if (/^a:(?:extLst|hlinkClick|hlinkHover|hlinkMouseOver)$/.test(name)) return skip();
        if (name === "a:txBody") return skip("unknown");
        if (name === "wps:txbx") return keep("txbx");
        if (name === "wp:posOffset") return keep("dml", { leafText: /^-?\d{1,10}$/ });
        if (name === "wp:align") return keep("dml", { leafText: /^[A-Za-z]{1,16}$/ });
        return keep("dml");
      case "txbx":
        return name === "w:txbxContent" ? keep("block") : skip("unknown");
    }
    return skip("unknown");
  }
  start(name: string, attrs: [string, string][], self: boolean): void {
    if (this.stack.length > 1500) throw new Damaged("nesting too deep");
    let f: Frame;
    const parent = this.top();
    if (!parent) {
      if (this.done || name !== ROOT[this.part]) throw new Damaged(`the part's root is ${name}`);
      f = { name, keep: true, ck: this.part === "header" || this.part === "footer" ? "block" : this.part === "styles" || this.part === "numbering" ? "props" : this.part === "theme" ? "dml" : "root" };
      const a = this.part === "theme" ? ` name="Office"` : "";
      this.emit(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${name}${NS_DECL}${a}${self ? "/" : ""}>`);
      if (self) { this.done = true; return; }
      this.stack.push(f);
      return;
    }
    if (parent.ck === "skip") {
      // A dropped subtree; one that may hold what the person sees is checked, so nothing visible is lost silently.
      if (parent.check === "pict" && attrs.some(([an, v]) => loc(an) === "string" && v.trim())) throw new Damaged("a VML picture with text in it");
      // A Word "Horizontal Line" is a VML shape the clean copy cannot keep: refused, never dropped silently (review of 64c7f13b).
      if (parent.check === "pict" && attrs.some(([an, v]) => an === "o:hr" && /^(?:t|true)$/i.test(v))) throw new Damaged("a horizontal line");
      if (parent.check === "unknown" && /^(?:w:drawing|w:pict|a:blip|v:imagedata|w:t)$/.test(name)) throw new Damaged(`an unknown ${parent.name} with content`);
      if (!self) this.stack.push({ name, keep: false, ck: "skip", check: parent.check });
      return;
    }
    f = this.classify(parent, name);
    if (f.ck === "skip" && f.check === "pict" && attrs.some(([an, v]) => loc(an) === "string" && v.trim())) throw new Damaged("a VML picture with text in it");
    if (f.keep) {
      const a = this.attrsOf(name, f.ck, attrs);
      if (a === null) f = { name, keep: false, ck: "skip" };
      else {
        if (name === "w:p" || name === "w:tbl") { const c = this.container(); if (c?.tc || c?.ck === "block") c.lastP = name === "w:p"; }
        if (f.sp === "sym") {
          // A symbol is checked as the character it shows (a Symbol-font "F034" is a 4), and kept as a symbol.
          const ch = attrs.find(([an]) => an === "w:char")?.[1] ?? "", cp = parseInt(ch, 16);
          const shown = Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp >= 0xf000 && cp <= 0xf0ff ? cp - 0xf000 : cp) : "";
          this.emit(`<${name}${a}/>`, shown ? `<w:t>${escText(shown)}</w:t>` : "");
          if (!self) this.stack.push({ name, keep: false, ck: "skip" }); // a symbol has no content
          return;
        }
        this.emit(`<${name}${a}${self ? "/" : ""}>`);
      }
    }
    if (!self) this.stack.push(f);
  }
  end(name: string): void {
    const f = this.stack.pop();
    if (!f || f.name !== name) throw new Damaged(`a ${name} end tag out of place`);
    if (!f.keep) return;
    if ((f.tc || (this.stack.length === 0 && (this.part === "header" || this.part === "footer"))) && !f.lastP) this.emit("<w:p/>"); // a cell, header or footer ends in a paragraph
    this.emit(`</${name}>`);
    if (this.stack.length === 0) this.done = true;
  }
  text(t: string): void {
    const f = this.top();
    if (!f) { if (t.trim()) throw new Damaged("text outside the root"); return; }
    if (f.ck === "skip") { if (f.check && t.trim()) throw new Damaged(`text in a dropped ${f.name}`); return; }
    if (f.ck === "t") { this.emit(escText(t)); return; }
    if (f.ck === "instr") { if (FIELD_OK.test(t)) { this.emit(escText(t)); this.attrLines.add(`field: ${t.trim()}`); } return; }
    if (f.leafText) { const v = t.trim(); if (!f.leafText.test(v)) throw new Damaged(`a ${f.name} value`); this.emit(v); this.attrLines.add(`${loc(f.name)}: ${v}`); return; }
    if (f.sp === "lvl" && t.trim()) throw new Damaged("text in a list label");
  }
  result(): string {
    if (!this.done || this.stack.length) throw new Damaged("the part ends before its root closes");
    return this.out.join("");
  }
}

// Image bytes without their metadata (PNG text and other ancillary chunks, JPEG EXIF/XMP/comments except the orientation,
// GIF comment and application blocks): pixels only. An image that does not parse is damaged.
function cleanPng(b: Uint8Array): Uint8Array {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (b.length < 8 || SIG.some((x, i) => b[i] !== x)) throw new Damaged("not a PNG");
  const KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "sBIT", "pHYs", "bKGD"]), out: Uint8Array[] = [b.subarray(0, 8)];
  let p = 8, end = false;
  while (p + 12 <= b.length) {
    const len = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0, type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (p + 12 + len > b.length) throw new Damaged("a cut-off PNG");
    if (KEEP.has(type)) out.push(b.subarray(p, p + 12 + len));
    p += 12 + len;
    if (type === "IEND") { end = true; break; }
  }
  if (!end || out.length < 3) throw new Damaged("a PNG with no end");
  return concatBytes(out);
}
function cleanJpeg(b: Uint8Array): Uint8Array {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Damaged("not a JPEG");
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let p = 2;
  for (;;) {
    if (p + 1 >= b.length || b[p] !== 0xff) throw new Damaged("a bad JPEG marker");
    while (b[p + 1] === 0xff) p++;
    const m = b[p + 1];
    if (m === 0xd9) { out.push(Uint8Array.of(0xff, 0xd9)); break; }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { out.push(b.subarray(p, p + 2)); p += 2; continue; }
    if (p + 4 > b.length) throw new Damaged("a cut-off JPEG");
    const len = (b[p + 2] << 8) | b[p + 3], seg = b.subarray(p, p + 2 + len);
    if (p + 2 + len > b.length || len < 2) throw new Damaged("a cut-off JPEG");
    if (m === 0xda) {
      out.push(seg);
      let q = p + 2 + len;
      while (q + 1 < b.length && !(b[q] === 0xff && b[q + 1] !== 0 && !(b[q + 1] >= 0xd0 && b[q + 1] <= 0xd7))) q++;
      if (q + 1 >= b.length) throw new Damaged("a JPEG with no end");
      out.push(b.subarray(p + 2 + len, q));
      p = q; continue;
    }
    if ((m >= 0xc0 && m <= 0xcf) || m === 0xdb || m === 0xdd || m === 0xee || (m === 0xe0 && String.fromCharCode(...seg.subarray(4, 9)) === "JFIF\u0000")) out.push(seg);
    else if (m === 0xe1) { const o = exifOrientation(seg.subarray(4)); if (o > 1 && o <= 8) out.push(Uint8Array.of(0xff, 0xe1, 0, 34, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 1, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0)); }
    p += 2 + len;
  }
  return concatBytes(out);
}
function exifOrientation(d: Uint8Array): number {
  if (d.length < 14 || String.fromCharCode(...d.subarray(0, 4)) !== "Exif") return 0;
  const t = d.subarray(6), le = t[0] === 0x49, u16 = (i: number) => (le ? t[i] | (t[i + 1] << 8) : (t[i] << 8) | t[i + 1]);
  const u32 = (i: number) => (le ? (t[i] | (t[i + 1] << 8) | (t[i + 2] << 16) | (t[i + 3] << 24)) : ((t[i] << 24) | (t[i + 1] << 16) | (t[i + 2] << 8) | t[i + 3])) >>> 0;
  const ifd = u32(4);
  if (ifd + 2 > t.length) return 0;
  for (let k = 0, n = u16(ifd); k < n && ifd + 2 + k * 12 + 12 <= t.length; k++) { const e = ifd + 2 + k * 12; if (u16(e) === 0x0112) return u16(e + 8); }
  return 0;
}
function cleanGif(b: Uint8Array): Uint8Array {
  const head = String.fromCharCode(...b.subarray(0, 6));
  if (head !== "GIF87a" && head !== "GIF89a") throw new Damaged("not a GIF");
  const table = (packed: number) => (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
  const blocks = (q: number) => { while (q < b.length && b[q] !== 0) q += b[q] + 1; if (q >= b.length) throw new Damaged("a cut-off GIF"); return q + 1; };
  let p = 13 + table(b[10]);
  const out: Uint8Array[] = [b.subarray(0, p)];
  for (;;) {
    if (p >= b.length) throw new Damaged("a GIF with no end");
    if (b[p] === 0x3b) { out.push(Uint8Array.of(0x3b)); break; }
    if (b[p] === 0x21) { const e = blocks(p + 2); if (b[p + 1] === 0xf9) out.push(b.subarray(p, e)); p = e; continue; }
    if (b[p] === 0x2c) { const e = blocks(p + 10 + table(b[p + 9]) + 1); out.push(b.subarray(p, e)); p = e; continue; }
    throw new Damaged("a bad GIF block");
  }
  return concatBytes(out);
}
function concatBytes(xs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of xs) { out.set(x, at); at += x.length; }
  return out;
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
// A zip of the clean parts, deflated, with fixed dates, so the same file always gives the same clean bytes (and sha256).
// deno-lint-ignore no-explicit-any
function zipParts(zlib: any, entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = [], central: Uint8Array[] = [];
  let off = 0;
  const le = (n: number, w: number) => { const a = new Uint8Array(w); for (let i = 0; i < w; i++) a[i] = (n >>> (8 * i)) & 0xff; return a; };
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name), comp = new Uint8Array(zlib.deflateRawSync(e.data)), crc = crc32(e.data);
    const common = [le(20, 2), le(0x0800, 2), le(8, 2), le(0, 2), le(0x21, 2), le(crc, 4), le(comp.length, 4), le(e.data.length, 4), le(name.length, 2), le(0, 2)];
    const local = concatBytes([le(0x04034b50, 4), ...common, name]);
    chunks.push(local, comp);
    central.push(concatBytes([le(0x02014b50, 4), le(20, 2), ...common, le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(off, 4), name]));
    off += local.length + comp.length;
  }
  const cd = concatBytes(central);
  return concatBytes([...chunks, cd, le(0x06054b50, 4), le(0, 2), le(0, 2), le(entries.length, 2), le(entries.length, 2), le(cd.length, 4), le(off, 4), le(0, 2)]);
}
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const CT = "application/vnd.openxmlformats-officedocument.";
const PART_CT: Record<string, string> = { document: `${CT}wordprocessingml.document.main+xml`, styles: `${CT}wordprocessingml.styles+xml`, numbering: `${CT}wordprocessingml.numbering+xml`,
  settings: `${CT}wordprocessingml.settings+xml`, theme: `${CT}theme+xml`, header: `${CT}wordprocessingml.header+xml`, footer: `${CT}wordprocessingml.footer+xml` };
export type CleanDocx = { bytes: Uint8Array; text: string[]; attrs: string[]; urls: string[] };
// deno-lint-ignore no-explicit-any
function buildClean(r: any, Buffer: any, zlib: any, bytes: Uint8Array, budget: UploadBudget): CleanDocx {
  const buf = Buffer.from(bytes), names = budget.names(r, buf);
  const find = (n: string) => names.includes(n) ? n : names.find((x) => x.toLowerCase() === n.toLowerCase());
  const raw = (n: string): Uint8Array => { const at = find(n); const p = at ? budget.part(r, buf, at) : null; if (!p) throw new Damaged(`part not readable: ${n}`); return new Uint8Array(p); };
  const dir = (n: string) => n.includes("/") ? n.slice(0, n.lastIndexOf("/") + 1) : "";
  const resolve = (base: string, target: string) => {
    let t = target; try { t = decodeURIComponent(t); } catch { /* as written */ }
    const segs = (t.startsWith("/") ? t.slice(1) : dir(base) + t).split("/"), out: string[] = [];
    for (const s of segs) { if (s === "..") out.pop(); else if (s && s !== ".") out.push(s); }
    return out.join("/");
  };
  type InRel = { type: string; target: string; external: boolean };
  const relsOf = (n: string): Map<string, InRel> => {
    const m = new Map<string, InRel>(), rn = `${dir(n)}_rels/${n.slice(dir(n).length)}.rels`;
    if (!find(rn)) return m;
    scanXml(decodePart(raw(rn), true), { start: (name, attrs) => {
      if (loc(name) !== "Relationship") return;
      const a = Object.fromEntries(attrs.map(([k, v]) => [loc(k), v]));
      if (a.Id) m.set(a.Id, { type: String(a.Type ?? "").split("/").pop() ?? "", target: String(a.Target ?? ""), external: /^external$/i.test(String(a.TargetMode ?? "")) });
    }, end: () => {}, text: () => {} });
    return m;
  };
  const files: { name: string; data: Uint8Array }[] = [], overrides: [string, string][] = [], text: string[] = [], attrs = new Set<string>(), urls: string[] = [];
  const media = new Map<string, string>(), parts = new Map<string, string>(), count: Record<string, number> = {};
  const enc = new TextEncoder();
  const relsXml = (rs: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rs.join("")}</Relationships>`;
  const build = (src: string, kind: PartKind, outName: string) => {
    const inRels = relsOf(src), outRels: string[] = [], byTarget = new Map<string, string>();
    const add = (type: string, target: string, external = false) => {
      const key = `${type} ${target}`;
      if (byTarget.has(key)) return byTarget.get(key)!;
      const id = `rId${outRels.length + 1}`;
      outRels.push(`<Relationship Id="${id}" Type="${REL}${type}" Target="${escAttr(target)}"${external ? ` TargetMode="External"` : ""}/>`);
      byTarget.set(key, id);
      return id;
    };
    const content = kind === "document" || kind === "header" || kind === "footer";
    if (kind === "document") for (const [, rl] of inRels) {
      const k = rl.type as PartKind;
      if (rl.external || !(k === "styles" || k === "numbering" || k === "settings" || k === "theme") || parts.has(k)) continue;
      const nn = k === "theme" ? "theme/theme1.xml" : `${k}.xml`;
      parts.set(k, nn);
      build(resolve(src, rl.target), k, `word/${nn}`);
      add(k, nn);
    }
    const p = new CleanPart(kind, (element, attr, id) => {
      const rl = inRels.get(id);
      if (!rl) { if (element === "a:blip") throw new Damaged("a picture with no image"); return null; }
      if (element === "w:hyperlink" && attr === "id") {
        if (rl.type !== "hyperlink" || !rl.external) return null;
        const url = rl.target.trim();
        if (!/^(?:https?:\/\/|mailto:|tel:)/i.test(url) || url.length > 2048 || /[\s<>"]/.test(url)) return null;
        urls.push(...urlGateLines(url));
        return add("hyperlink", url, true);
      }
      if ((element === "w:headerReference" || element === "w:footerReference") && kind === "document") {
        const t = element === "w:headerReference" ? "header" : "footer";
        if (rl.type !== t || rl.external) return null;
        const from = resolve(src, rl.target);
        let nn = parts.get(from);
        if (!nn) { count[t] = (count[t] ?? 0) + 1; nn = `${t}${count[t]}.xml`; parts.set(from, nn); build(from, t, `word/${nn}`); }
        return add(t, nn);
      }
      if (element === "a:blip" && attr === "embed") {
        if (rl.type !== "image" || rl.external) throw new Damaged("a linked picture");
        const from = resolve(src, rl.target);
        let nn = media.get(from);
        if (!nn) {
          const b = raw(from), kindOf = b[0] === 0x89 && b[1] === 0x50 ? "png" : b[0] === 0xff && b[1] === 0xd8 ? "jpeg" : b[0] === 0x47 && b[1] === 0x49 ? "gif" : null;
          if (!kindOf) throw new Damaged(`a picture the clean copy cannot keep: ${from}`);
          nn = `media/image${media.size + 1}.${kindOf}`;
          media.set(from, nn);
          files.push({ name: `word/${nn}`, data: kindOf === "png" ? cleanPng(b) : kindOf === "jpeg" ? cleanJpeg(b) : cleanGif(b) });
        }
        return add("image", nn);
      }
      return null;
    });
    scanXml(decodePart(raw(src), true), p);
    const xml = p.result();
    for (const l of p.attrLines) attrs.add(l);
    if (content) text.push(docxResumeLines(p.gate.join("")).join("\n"));
    files.push({ name: outName, data: enc.encode(xml) });
    overrides.push([`/${outName}`, PART_CT[kind]]);
    if (outRels.length) files.push({ name: `${dir(outName)}_rels/${outName.slice(dir(outName).length)}.rels`, data: enc.encode(relsXml(outRels)) });
  };
  if (!names.includes("word/document.xml")) throw new Damaged("no document part");
  build("word/document.xml", "document", "word/document.xml");
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>` +
    overrides.map(([n, t]) => `<Override PartName="${n}" ContentType="${t}"/>`).join("") + `</Types>`;
  const root = relsXml([`<Relationship Id="rId1" Type="${REL}officeDocument" Target="word/document.xml"/>`]);
  const order = (n: string) => n === "word/document.xml" ? 0 : 1;
  const zip = zipParts(zlib, [{ name: "[Content_Types].xml", data: enc.encode(types) }, { name: "_rels/.rels", data: enc.encode(root) },
    ...files.sort((a, b) => order(a.name) - order(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))]);
  return { bytes: zip, text, attrs: [...attrs], urls };
}
// deno-lint-ignore no-explicit-any
let cleanRuntime: Promise<any> | null = null;
export async function cleanCopy(bytes: Uint8Array, budget = new UploadBudget()): Promise<CleanDocx> {
  cleanRuntime ??= Promise.all([import("node:zlib"), import("node:crypto"), import("node:buffer")])
    // deno-lint-ignore no-explicit-any
    .then(([zlib, crypto, b]) => ({ r: (CareerRender as any).withRuntime({ zlib, crypto, Buffer: b.Buffer }), Buffer: b.Buffer, zlib }));
  const { r, Buffer, zlib } = await cleanRuntime;
  return buildClean(r, Buffer, zlib, bytes, budget);
}
// The clean copy of a Word file: the bytes stored for it. Throws when no faithful clean copy can be built.
export async function cleanDocx(bytes: Uint8Array): Promise<Uint8Array> {
  return (await cleanCopy(bytes)).bytes;
}
const gateHit = (t: string) => !!t.trim() && (fileCodeLines(t).length > 0 || redactIdentity(t).removed.length > 0 || redactIdentity(codeCheckText(t)).removed.length > 0);
// The clean copy is gated as stored: each part's text as a whole (as the visible text is), each attribute value and each link
// parameter on its own line (a value is judged by its own name, never by its neighbour's).
export function cleanCopyTrips(c: CleanDocx): boolean {
  return c.text.some(gateHit) || c.attrs.some(gateHit) || c.urls.some(gateHit);
}

export type ResumeFileResult ={ ok: true; message: string; uploadId: string; sha256: string; note?: string } | { ok: false; reply: string; why: string; lines?: number[] };
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
  // The identity check also reads the text as the code check does (any script's digits, look-alike letters, no zero-width
  // characters), so a disguised number is not missed by one check and passed by the other.
  const found = [...new Set([...redactIdentity(text).removed, ...redactIdentity(codeCheckText(text)).removed])];
  // A plausible one-time code refuses the file (owner decision on 2de155f0): the reply names only the line and the kind, never
  // the line itself, and nothing from the file is kept or read.
  const codeLines = fileCodeLines(text);
  if (codeLines.length && !found.includes("code")) found.push("code");
  if (found.length) {
    const name: Record<string, string> = { ssn: "a Social Security number", card: "a card number", account: "an account number", password: "a password", code: "a one-time code", key: "a key or token" };
    const kinds = [...new Set(found.map((k) => name[k] ?? "a private number"))];
    return { ok: false, reply: codeLines.length ? fileCodeReply(codeLines, kinds.filter((k) => k !== name.code)) : fileSecretReply(kinds), why: "secret", lines: codeLines };
  }
  // The parts of a Word file the reader does not show are read by the same checks before the file is kept.
  const budget = new UploadBudget(); // shared by the hidden reader and the clean copy below
  if (kind === "docx") {
    let hidden = "";
    // Fail closed: a part that cannot be read may hold anything, so the file is not kept.
    try { hidden = await docxHiddenText(got.bytes, budget); } catch (e) { console.error("resume file: hidden parts not read:", (e as Error)?.message ?? e); return { ok: false, reply: FILE_DAMAGED_REPLY, why: "damaged" }; }
    if (hidden.trim() && (fileCodeLines(hidden).length || redactIdentity(hidden).removed.length || redactIdentity(codeCheckText(hidden)).removed.length)) {
      return { ok: false, reply: FILE_HIDDEN_CODE_REPLY, why: "secret", lines: [] };
    }
  }
  // RELEASE 8: a Word file is stored as its clean copy only (cleanDocx above), gated before it is kept. A file no faithful clean
  // copy can be built from is refused as damaged; nothing is stored on any refusal.
  let stored = got.bytes;
  if (kind === "docx") {
    let clean: CleanDocx;
    try { clean = await cleanCopy(got.bytes, budget); } catch (e) { console.error("resume file: no clean copy:", (e as Error)?.message ?? e); return { ok: false, reply: FILE_DAMAGED_REPLY, why: "damaged" }; }
    if (cleanCopyTrips(clean)) return { ok: false, reply: FILE_HIDDEN_CODE_REPLY, why: "secret", lines: [] };
    stored = clean.bytes;
  }
  const message = resumeMessage(text);
  if (!readsAsResume(message)) return { ok: false, reply: fileNotResumeReply(text), why: "not_resume" };
  const sha256 = await sha256Bytes(stored);
  let uploadId: string;
  try {
    uploadId = await o.record({ userId: o.userId, channel: o.channel, ref: `${o.channel}:${o.doc.uniqueId}`, filename: storedFilename(o.doc.name, kind), mime: KIND_MIME[kind],
      bytes: stored.length, sha256, content_b64: b64(stored), message_sha256: await sha256Text(message) });
  } catch (e) {
    console.error("resume file: not stored:", (e as Error)?.message ?? e);
    return { ok: false, reply: FILE_SAVE_REPLY, why: "store" };
  }
  return { ok: true, message, uploadId, sha256, ...(resumeMessageCut(text) ? { note: fileCutNote(message) } : {}) };
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
// Whether a chat message is the text of a resume file this person uploaded: its sha256 is the message_sha256 the upload stored
// (resumeMessage, above). Such a message skips code-in-chat's code-word pass: a resume line like "Built a customer portal
// serving 120000 customers" is not a one-time code, and removing it changed the stored text so the confirmation lost the
// file (Greptile on #568). Typed text that only starts like a file message has no matching upload, so it is checked as usual.
// The file itself was refused at upload if it carried an identity number or a labeled code (ingestResumeFile, above).
export async function isUploadedResumeText(admin: any, userId: string | null | undefined, text: string): Promise<boolean> {
  if (!userId || !String(text ?? "").startsWith("here is my resume:\n")) return false;
  try {
    const r = await admin.from("career_resume_uploads").select("id").eq("user_id", userId).eq("message_sha256", await sha256Text(text)).limit(1);
    return !r.error && Array.isArray(r.data) && r.data.length > 0;
  } catch {
    return false;
  }
}

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
