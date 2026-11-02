// REPLY SHAPE (owner, 2026-10-28): the way a Telegram reply is laid out. The agent returns { answer, attachments[], links[] };
// the channel sends the answer, then each attachment as a document message, then each link as its own message (so the
// platform shows its link preview card), in that order.
//
//   answer       ONE short plain paragraph that answers the question. What is published or confirmed is kept apart from what
//                is unknown (the prompt's rule, _shared/agent/prompt.ts SHAPE_RULES; this module only enforces size and form).
//   attachments  detail that does not fit (research, a comparison, a full posting list, a batch of drafts): a .md or .txt
//                file, a named document, never a wall of text. A text over the limit is split into parts, never cut.
//   links        http(s) URLs only, one per message, at most MAX_LINKS; a URL that no tool returned and the person did not
//                give is dropped (D-007: no invented links).
//
// Pure: no I/O, no model, no canned prose. The words are the model's; this code only measures, names and orders them.
// Text the person approves word for word (a card, an email or outreach draft, a reply in parts) is never shaped: the
// caller decides that (career_reply_writer.ts writable()).

import { findUrls, urlsOf } from "./channel_text.ts";

export const ANSWER_MAX_CHARS = 700; // one short paragraph
export const FILE_MAX_BYTES = 6144; // "4 KB-ish": one document carries at most this; more is split into parts
export const MAX_FILES = 5; // per reply
export const MAX_LINKS = 5; // per reply, each its own message

export interface ShapedFile { filename: string; content: string; mime: string; bytes: number }
export interface ShapedReply { answer: string; attachments: ShapedFile[]; links: string[]; notes: string[]; more?: string[] } // more: the one follow-up message
export interface RawShape { answer?: unknown; attachments?: unknown; links?: unknown }

const enc = new TextEncoder();
export const byteLength = (s: string) => enc.encode(s).length;
const trimUrl = (u: string) => u.replace(/[.,;:!?]+$/, "");
// CHANNEL DELIVERY SCENARIOS (2026-10-29): links found by channel_text.ts findUrls, so a link's own brackets are kept
// ("…/wiki/Foo_(bar)" was sent as "…/wiki/Foo_") and the sentence's are not.
export const urlsIn = (text: string): string[] => [...new Set(urlsOf(String(text ?? "")))];
const withoutUrls = (line: string) => { let out = "", at = 0; for (const u of findUrls(line)) { out += line.slice(at, u.start); at = u.end; } return out + line.slice(at); };

// A file name a person can read: lowercase words joined by "-", .md or .txt (anything else becomes .md), no path.
export function safeFilename(name: unknown, fallback = "details"): { filename: string; mime: string } {
  const raw = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const m = /\.(md|txt)$/i.exec(raw.trim());
  const ext = m ? m[1].toLowerCase() : "md";
  const stem = (m ? raw.trim().slice(0, -m[0].length) : raw.replace(/\.[A-Za-z0-9]{1,5}$/, ""))
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || fallback;
  return { filename: `${stem}.${ext}`, mime: ext === "txt" ? "text/plain" : "text/markdown" };
}

// Text into pieces of at most `max` bytes: paragraphs travel together while they fit, a longer paragraph is split on
// lines, then words (a single word longer than `max` on code points). Nothing is cut or dropped.
export function packBytes(text: string, max: number): string[] {
  const clean = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const pieces: string[] = [];
  const hard = (w: string) => { let b = ""; for (const ch of w) { if (byteLength(b + ch) > max) { pieces.push(b); b = ""; } b += ch; } return b; };
  const out: string[] = [];
  let buf = "";
  const add = (piece: string, sep: string) => {
    if (buf && byteLength(buf) + sep.length + byteLength(piece) <= max) buf += sep + piece;
    else { if (buf) out.push(buf); buf = piece; }
  };
  for (const para of clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    if (byteLength(para) <= max) { add(para, "\n\n"); continue; }
    for (const line of para.split("\n")) {
      if (byteLength(line) <= max) { add(line, "\n"); continue; }
      let cur = "";
      for (const word of line.split(/\s+/)) {
        if (byteLength(word) > max) { if (cur) { add(cur, "\n"); cur = ""; } pieces.length = 0; const tail = hard(word); for (const p of pieces) add(p, "\n"); add(tail, "\n"); continue; }
        if (cur && byteLength(cur) + 1 + byteLength(word) > max) { add(cur, "\n"); cur = word; } else cur = cur ? `${cur} ${word}` : word;
      }
      if (cur) add(cur, "\n");
    }
  }
  if (buf) out.push(buf);
  return out;
}

// One attachment, named and sized: whole when it fits, else numbered parts ("company-research-1-of-2.md").
export function fileParts(filename: unknown, content: unknown): ShapedFile[] {
  const { filename: name, mime } = safeFilename(filename);
  const parts = packBytes(String(content ?? "").replace(/<!--[\s\S]*?-->/g, ""), FILE_MAX_BYTES);
  const dot = name.lastIndexOf("."), stem = name.slice(0, dot), ext = name.slice(dot);
  return parts.map((p, i) => ({ filename: parts.length === 1 ? name : `${stem}-${i + 1}-of-${parts.length}${ext}`, content: p, mime, bytes: byteLength(p) }));
}

const sentences = (s: string) => s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);

// A long answer (owner, 2026-10-29: nobody downloads anything; no .md/.txt for advice overflow, on any channel). The reply is its
// leading COMPLETE sentences up to ANSWER_MAX_CHARS, never cut mid-sentence and never ending on a dangling list ("...these five
// things: 1) Pick..."): a sentence that opens a list (ends with ":") or is a list item goes to the rest with its list. The rest is
// whole sentences too, at most MORE_MAX_CHARS; what is beyond that is skipped (a hosted page carries it when one is configured).
export const MORE_MAX_CHARS = 3000; // the one follow-up message (Telegram allows 4096)
export const PAGE_CHUNK_CHARS = 580; // one finding on the hosted page; the page holds 12
export const PAGE_MAX_CHUNKS = 12;
const LIST_ITEM = /^(?:\d{1,2}[.)]|[-*•])\s/;
const endsClean = (t: string) => /[.!?]["')\]]?$/.test(t);
// Sentences, with an inline numbered list ("1) Pick one. 2) Do two.") kept as items of their own.
function pieces(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    out.push(...t.replace(/\s+(?=\d{1,2}[.)]\s+[A-Z])/g, "\n").split("\n").flatMap((x) => sentences(x)));
  }
  return out;
}
const cleanEnd = (t: string) => { const x = t.trim().replace(/[\s,;:–—-]+$/, ""); return endsClean(x) ? x : `${x}.`; };
// Whole sentences packed into pieces of at most `max` chars (a sentence longer than `max` is cut at a clause or word, ending with a full stop).
export function chunkSentences(text: string, max: number, limit = Infinity): { chunks: string[]; trimmed: boolean } {
  const chunks: string[] = [];
  let cur = "";
  const push = () => { if (cur) { chunks.push(cur); cur = ""; } };
  for (let s of pieces(text)) {
    while (s.length > max) { const c = s.slice(0, max), at = Math.max(c.lastIndexOf(", "), c.lastIndexOf("; ")), w = (at > max / 2 ? c.slice(0, at) : c.replace(/\s+\S*$/, "")).trim(); push(); chunks.push(cleanEnd(w)); s = s.slice(w.length).replace(/^[\s,;]+/, ""); }
    if (cur && cur.length + 1 + s.length > max) push();
    cur = cur ? `${cur} ${s}` : s;
  }
  push();
  return { chunks: chunks.slice(0, limit), trimmed: chunks.length > limit };
}
export function splitLongAnswer(answer: string): { head: string; rest: string; full: string; trimmed: boolean } | null {
  const text = answer.trim();
  if (text.length <= ANSWER_MAX_CHARS) return null;
  const ps = pieces(text);
  let n = 0, len = 0;
  while (n < ps.length) {
    const add = (n ? 1 : 0) + ps[n].length;
    if (len + add > ANSWER_MAX_CHARS) break;
    len += add; n++;
  }
  // never end on the sentence that opens a list or on a list item: that goes on to the rest
  while (n > 1 && (/:$/.test(ps[n - 1]) || LIST_ITEM.test(ps[n - 1]) || !endsClean(ps[n - 1]))) n--;
  let head = ps.slice(0, n).join(" ");
  let rest = ps.slice(n);
  if (n === 1 && (/:$/.test(ps[0]) || LIST_ITEM.test(ps[0]))) { head = ""; rest = ps; }
  if (!head) { // the first sentence alone is too long: end at a clause, else at a word, with a full stop
    const first = ps[0] ?? text;
    const cut = first.slice(0, ANSWER_MAX_CHARS);
    const clause = Math.max(cut.lastIndexOf(", "), cut.lastIndexOf("; "));
    const w = (clause > ANSWER_MAX_CHARS / 2 ? cut.slice(0, clause) : cut.replace(/\s+\S*$/, "")).trim();
    head = cleanEnd(w);
    rest = [first.slice(w.length).replace(/^[\s,;]+/, "").trim(), ...ps.slice(1)].filter(Boolean);
  }
  const more: string[] = [];
  let used = 0;
  for (const r of rest) { if (used + r.length + 1 > MORE_MAX_CHARS) break; more.push(r); used += r.length + 1; }
  while (more.length && (/:$/.test(more[more.length - 1]) || !endsClean(more[more.length - 1]))) more.pop();
  return { head, rest: more.join(" "), full: rest.join(" "), trimmed: more.length < rest.length };
}

// The answer text with every URL taken out (a line that was only a link goes, a link inside a sentence leaves the sentence).
export function withoutLinks(text: string): string {
  return String(text ?? "").replace(/<!--[\s\S]*?-->/g, "").split("\n").map((line) => {
    const rest = withoutUrls(line), bare = rest.replace(/[\s:()\-–—•*]+/g, "");
    return findUrls(line).length && !bare ? "" : rest.replace(/\s*\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trimEnd();
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// LINK SAFETY (reqs Q632, Q633): no shortened or opaque URL is sent. A shortener hides where a tap goes (a posting, a phishing page,
// anything), and Trainee cannot show the destination it names, so the link is never sent and the words say one was removed. Only
// the exact hosts of public URL shorteners: a company's own domain ("bitly.com", "acme.co") is a named site and stays.
export const SHORTENER_HOSTS = new Set(["bit.ly", "bitly.ws", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "buff.ly", "is.gd", "v.gd", "rebrand.ly", "cutt.ly", "shorturl.at",
  "t.ly", "rb.gy", "lnkd.in", "tiny.cc", "bl.ink", "s.id", "shorte.st", "adf.ly", "clck.ru", "qr.ae", "trib.al", "dlvr.it", "soo.gd", "tr.im", "x.co", "u.to", "y2u.be"]);
export function isShortLink(url: string): boolean {
  try { return SHORTENER_HOSTS.has(new URL(url).hostname.toLowerCase().replace(/^www\./, "")); } catch { return false; }
}
export const SHORT_LINK_REMOVED = "[shortened link removed]";
// The text with every shortened link replaced by SHORT_LINK_REMOVED (said, never silently dropped), and how many there were.
export function withoutShortLinks(text: string): { text: string; removed: string[] } {
  const s = String(text ?? ""), removed: string[] = [];
  let out = "", at = 0;
  for (const u of findUrls(s)) { if (!isShortLink(u.url)) continue; out += s.slice(at, u.start) + SHORT_LINK_REMOVED; at = u.end; removed.push(u.url); }
  return { text: removed.length ? out + s.slice(at) : s, removed };
}

// The shape of one reply. `allowedLinks`: the URLs the turn may show (those a tool returned or the person typed); null: the
// caller vouches for every link (the code-written replies). A link that is not allowed is dropped from links and answer.
export function shapeReply(raw: RawShape, o: { allowedLinks?: Iterable<string> | null; overflowLink?: string | null } = {}): ShapedReply {
  const notes: string[] = [];
  const allowed = o.allowedLinks ? new Set([...o.allowedLinks].map(trimUrl)) : null;
  let answer = String(raw.answer ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();

  // Links: whatever the model put in `links`, then every URL left in the answer; each once, http(s) only, in order.
  const wanted = [...(Array.isArray(raw.links) ? raw.links.map((l) => trimUrl(String(l ?? "").trim())) : []), ...urlsIn(answer)];
  const links: string[] = [];
  for (const u of wanted) {
    if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(u)) { notes.push(`link dropped (not a web address): ${u.slice(0, 80)}`); continue; }
    if (allowed && !allowed.has(u)) { notes.push(`link dropped (no tool returned it): ${u.slice(0, 120)}`); continue; }
    if (isShortLink(u)) { notes.push(`link dropped (shortened, hides its destination): ${u.slice(0, 120)}`); continue; }
    if (links.includes(u)) continue;
    if (links.length >= MAX_LINKS) { notes.push(`link dropped (over ${MAX_LINKS}): ${u.slice(0, 120)}`); continue; }
    links.push(u);
  }
  answer = withoutLinks(answer);

  // Attachments: sanitized, sized, at most MAX_FILES.
  const files: ShapedFile[] = [];
  const add = (fs: ShapedFile[]) => {
    for (const f of fs) {
      if (files.length >= MAX_FILES) { notes.push(`file dropped (over ${MAX_FILES}): ${f.filename}`); continue; }
      let name = f.filename;
      for (let n = 2; files.some((x) => x.filename === name); n++) name = f.filename.replace(/(\.[a-z]+)$/, `-${n}$1`);
      files.push({ ...f, filename: name });
    }
  };
  for (const a of Array.isArray(raw.attachments) ? raw.attachments : []) {
    const r = a && typeof a === "object" ? a as Record<string, unknown> : {};
    const parts = fileParts(r.filename, r.content);
    if (!parts.length) { notes.push("file dropped (empty)"); continue; }
    add(parts);
  }
  // A long answer is never a file: its head is the reply; the rest is the hosted page's link (code-minted, only when configured),
  // else one short second message. At most 2 messages.
  const long = splitLongAnswer(answer);
  const more: string[] = [];
  if (long) {
    answer = long.head;
    if (o.overflowLink && /^https:\/\//.test(o.overflowLink)) { if (!links.includes(o.overflowLink) && links.length < MAX_LINKS) links.push(o.overflowLink); notes.push("long answer: rest on a page"); }
    else { if (long.rest) more.push(long.rest); notes.push(long.trimmed ? "long answer: rest in a second message, ended on a sentence; the end was left out (over the 2-message budget)" : "long answer: rest in a second message"); }
  }
  return { answer, attachments: files, links, notes, ...(more.length ? { more } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Order of sends: the answer, each attachment, each link. `io` is the channel's own sender (the tests' fake transport too).

export type SendStep = { kind: "answer"; text: string } | { kind: "document"; file: ShapedFile } | { kind: "link"; url: string };
export function planSends(s: ShapedReply, o: { includeAnswer?: boolean } = {}): SendStep[] {
  return [
    ...(o.includeAnswer !== false && s.answer ? [{ kind: "answer" as const, text: s.answer }] : []),
    ...(s.more ?? []).map((text) => ({ kind: "answer" as const, text })),
    ...s.attachments.map((file) => ({ kind: "document" as const, file })),
    ...s.links.map((url) => ({ kind: "link" as const, url })),
  ];
}
export interface ShapeIO {
  text?: (text: string) => Promise<{ ok: boolean }>;
  document: (f: { filename: string; mime: string; bytes: Uint8Array }) => Promise<{ ok: boolean }>;
  link: (url: string) => Promise<{ ok: boolean }>;
}
// Runs the plan in order, one message each. A step that fails does not stop the next; the counts say what went.
export async function deliverShaped(s: ShapedReply, io: ShapeIO, o: { includeAnswer?: boolean } = {}): Promise<{ sent: number; failed: number; files: number; links: number }> {
  let sent = 0, failed = 0, files = 0, links = 0;
  for (const step of planSends(s, o)) {
    const r = await (step.kind === "answer" ? (io.text ? io.text(step.text) : Promise.resolve({ ok: false }))
      : step.kind === "document" ? io.document({ filename: step.file.filename, mime: step.file.mime, bytes: enc.encode(step.file.content) })
      : io.link(step.url)).catch(() => ({ ok: false }));
    if (r.ok) { sent++; if (step.kind === "document") files++; if (step.kind === "link") links++; } else failed++;
  }
  return { sent, failed, files, links };
}

// The turn's decision (agent-chat): shape only a Telegram turn, only with CAREER_REPLY_WRITER on, only a turn whose words are
// not an exact payload the person approves. Anything else carries no shape; its words are untouched except that a shortened link
// is removed (said) on every channel, and an exact payload is never changed at all.
export function shapeForTurn(o: { on: boolean; channel: string; writable: boolean; reply: string; attachments?: unknown; allowedLinks?: Iterable<string> | null; overflowLink?: string | null }):
  { reply: string; shape: { attachments: { filename: string; content: string }[]; links: string[]; more?: string[] } | null; notes: string[] } {
  if (!o.writable) return { reply: o.reply, shape: null, notes: [] };
  // Q632/Q633 on every channel, shaped or not: a shortened link never reaches the person (an exact payload above is never changed).
  const short = withoutShortLinks(o.reply);
  const reply = short.text, shortNotes = short.removed.map((u) => `link removed (shortened, hides its destination): ${u.slice(0, 120)}`);
  if (!o.on || o.channel !== "telegram") return { reply, shape: null, notes: shortNotes };
  const s = shapeReply({ answer: reply, attachments: o.attachments }, { allowedLinks: o.allowedLinks, overflowLink: o.overflowLink });
  s.notes.unshift(...shortNotes);
  if (!s.answer && !s.attachments.length) return { reply, shape: null, notes: s.notes }; // nothing left to say: today's reply stands
  return { reply: s.answer || reply, shape: s.attachments.length || s.links.length || s.more?.length ? { attachments: s.attachments.map((f) => ({ filename: f.filename, content: f.content })), links: s.links, ...(s.more?.length ? { more: s.more } : {}) } : null, notes: s.notes };
}
