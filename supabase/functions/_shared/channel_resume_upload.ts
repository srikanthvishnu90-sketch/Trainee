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
import { normalizeChatText, redactIdentity } from "./identity_redact.ts";
import { fileCodeLines, fileText as codeCheckText } from "./career_code_in_chat.ts";
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
  // CDATA is text: escaped and kept, so the tag-stripping readers see it ("<w:t><![CDATA[OTP 482913]]></w:t>").
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, c: string) => c.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
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
      return new TextDecoder(cs, { fatal: false }).decode(b);
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
const queryOf = (url: string) => { const q = decodeXml(url).replace(/^[^?#]*/, ""); try { return decodeURIComponent(q); } catch { return q; } };
const STRUCTURAL = /^(?:word\/(?:styles|stylesWithEffects|settings|webSettings|fontTable|numbering|people|commentsIds|commentsExtensible|commentsExtended)\.xml|word\/theme\/[^/]+\.xml|docProps\/app\.xml|\[Content_Types\]\.xml|customXml\/[^/]+\.xml|word\/(?:glossary\/)?(?:styles|settings|webSettings|fontTable|numbering)\.xml)$/i;
async function hiddenOf(r: any, buf: any, depth: number): Promise<string[]> {
  const names: string[] = r.docxPartNames(buf) ?? [];
  if (!names.includes("word/document.xml")) throw new Error("no document part");
  const out: string[] = [];
  for (const n of names) {
    const text = /\.(?:xml|rels|vml|html?|txt|mht|docx)$/i.test(n), part = text ? r.docxPart(buf, n) : null;
    if (text && !part) throw new Error(`part not readable: ${n}`);
    if (!part || STRUCTURAL.test(n)) continue;
    if (/\.docx$/i.test(n)) { if (depth > 0) throw new Error(`nested file too deep: ${n}`); out.push(...(r.extractDocxLines?.(part) ?? []).map(String), ...(await hiddenOf(r, part, depth + 1))); continue; }
    const s = decodePart(new Uint8Array(part), !/\.(?:txt|mht)$/i.test(n));
    if (n === "word/document.xml") {
      const fallbacks = [...s.matchAll(new RegExp(String.raw`<${P}Fallback\b[\s\S]*?</${P}Fallback>`, "g"))].flatMap((m) => allText(m[0]));
      // DrawingML and other non-w text, its runs joined per paragraph ("O" "T" "P" ": " "4" ... reads "OTP: 4...").
      const nonW = [...s.matchAll(/<((?!w:)[\w.-]+):p\b[\s\S]*?<\/\1:p>/g)].flatMap((m) => runText(m[0])).concat(
        [...s.matchAll(/<((?!w:)[\w.-]+):t(?:\s[^>]*)?>([^<]*)<\/\1:t>/g)].map((m) => m[2]).join("").trim() ? lines([...s.matchAll(/<((?!w:)[\w.-]+):t(?:\s[^>]*)?>([^<]*)<\/\1:t>/g)].map((m) => m[2]).join("")) : []);
      // Text runs outside any paragraph (the visible reader reads paragraphs only).
      const loose = runText(s.replace(new RegExp(String.raw`<${P}p\b[\s\S]*?</${P}p>`, "g"), "\n"));
      out.push(...runText(s, "delText|instrText"), ...attrText(s), ...fallbacks, ...nonW, ...loose); continue;
    }
    if (/\.rels$/i.test(n)) { out.push(...attrVals(s, "Target").map(queryOf).filter((q) => q.length > 1)); continue; }
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
export async function docxHiddenText(bytes: Uint8Array): Promise<string> {
  reader ??= Promise.all([import("node:zlib"), import("node:crypto"), import("node:buffer")])
    // deno-lint-ignore no-explicit-any
    .then(([zlib, crypto, b]) => ({ r: (CareerRender as any).withRuntime({ zlib, crypto, Buffer: b.Buffer }), Buffer: b.Buffer }));
  const { r, Buffer } = await reader;
  return (await hiddenOf(r, Buffer.from(bytes), 0)).join("\n");
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

export type ResumeFileResult = { ok: true; message: string; uploadId: string; sha256: string; note?: string } | { ok: false; reply: string; why: string; lines?: number[] };
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
  if (kind === "docx") {
    let hidden = "";
    // Fail closed: a part that cannot be read may hold anything, so the file is not kept.
    try { hidden = await docxHiddenText(got.bytes); } catch (e) { console.error("resume file: hidden parts not read:", (e as Error)?.message ?? e); return { ok: false, reply: FILE_DAMAGED_REPLY, why: "damaged" }; }
    if (hidden.trim() && (fileCodeLines(hidden).length || redactIdentity(hidden).removed.length || redactIdentity(codeCheckText(hidden)).removed.length)) {
      return { ok: false, reply: FILE_HIDDEN_CODE_REPLY, why: "secret", lines: [] };
    }
  }
  const message = resumeMessage(text);
  if (!readsAsResume(message)) return { ok: false, reply: fileNotResumeReply(text), why: "not_resume" };
  const sha256 = await sha256Bytes(got.bytes);
  let uploadId: string;
  try {
    uploadId = await o.record({ userId: o.userId, channel: o.channel, ref: `${o.channel}:${o.doc.uniqueId}`, filename: storedFilename(o.doc.name, kind), mime: KIND_MIME[kind],
      bytes: got.bytes.length, sha256, content_b64: b64(got.bytes), message_sha256: await sha256Text(message) });
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
