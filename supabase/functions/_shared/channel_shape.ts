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
// parts: a long answer's messages in order (parts[0] is `answer`), each whole sentences, each at most PART_MAX_CHARS; absent for a
// short answer. (The old `more`, one capped follow-up whose tail was dropped, is gone: beta C12, 2026-11-06.)
export interface ShapedReply { answer: string; attachments: ShapedFile[]; links: string[]; notes: string[]; parts?: string[] }
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


// LONG ANSWERS WHOLE (beta C12, 2026-11-06; rootcause-report PR-2). A long answer was a ~700-character head plus ONE follow-up capped
// at 3,000 characters whose tail was dropped, and only the head was stored, so later turns could not see or resend the rest. Now
// a long answer is sent as whole-sentence parts (answerParts below), each at most PART_MAX_CHARS (the outbox's own limit,
// conversation.ts OUTBOX_CHARS), nothing cut, through the parts contract (channel_inbound.ts replyParts); the stored reply is the
// whole answer. Up to MAX_ANSWER_PARTS parts; an answer longer than that ends the last part on a whole sentence with an honest
// note (PARTS_LEFT_NOTE), and the whole answer is still stored. (A hosted page is not used for this: the research_brief page
// needs a source link, file_kinds.ts, and an advice answer has none to give it.)
const LIST_ITEM = /^(?:\d{1,2}[.)]|[-*•])\s/;
const endsClean = (t: string) => /[.!?]["')\]”’]?$/.test(t);
export const PART_MAX_CHARS = 4000; // = conversation.ts OUTBOX_CHARS (not imported: this module stays pure); a test checks they match
export const MAX_ANSWER_PARTS = 4;
export const PARTS_LEFT_NOTE = "This answer is longer than 4 messages, so it stops here. All of it is saved in this chat; ask for the rest and it comes next.";
// Where text may be cut: at a run of whitespace that holds a line break, or that follows the end of a sentence; failing those, any
// whitespace. Each part is an exact slice of the text (trimmed), so the parts together are the text, in order.
function cutsIn(text: string): { at: number; next: number; kind: "line" | "sentence" | "word" }[] {
  const out: { at: number; next: number; kind: "line" | "sentence" | "word" }[] = [];
  for (const m of text.matchAll(/\s+/g)) {
    const at = m.index!, next = at + m[0].length;
    if (at === 0 || next >= text.length) continue;
    const before = text.slice(Math.max(0, at - 6), at);
    // a list marker ("1." "2)") is not the end of a sentence: never cut between it and its item
    const marker = /(?:^|\s)\d{1,2}[.)]$/.test(before) || (at <= 3 && /^\d{1,2}[.)]$/.test(before));
    out.push({ at, next, kind: m[0].includes("\n") ? "line" : !marker && /[.!?]["'”’)\]]*$/.test(before) ? "sentence" : "word" });
  }
  return out;
}
// The head (the first part) is at most ANSWER_MAX_CHARS and never ends on a sentence that opens a list (":") or inside a list.
const lastLine = (t: string) => t.slice(t.lastIndexOf("\n") + 1).trim();
const headOk = (before: string) => { const t = before.trim(), l = lastLine(t); return endsClean(t) && !/:$/.test(t) && !LIST_ITEM.test(l) && !/(?:^|\s)\d{1,2}[.)]\s[^\n]*$/.test(l); };
export function answerParts(answer: string, o: { headMax?: number; max?: number; limit?: number } = {}): { parts: string[]; left: string } {
  const text = String(answer ?? "").replace(/\r\n/g, "\n").trim();
  const headMax = o.headMax ?? ANSWER_MAX_CHARS, max = o.max ?? PART_MAX_CHARS, limit = o.limit ?? MAX_ANSWER_PARTS;
  if (!text) return { parts: [], left: "" };
  const cuts = cutsIn(text);
  const parts: string[] = [];
  let start = 0;
  // the head: the last clean sentence or line end within headMax (none: no short head, the first part is a full one)
  const head = cuts.filter((c) => c.at <= headMax && c.kind !== "word" && headOk(text.slice(0, c.at))).pop();
  if (head && text.length > headMax) { parts.push(text.slice(0, head.at).trim()); start = head.next; }
  while (start < text.length) {
    const last = parts.length === limit - 1;
    const room = last ? max - PARTS_LEFT_NOTE.length - 2 : max;
    if (text.length - start <= max) { parts.push(text.slice(start).trim()); start = text.length; break; }
    const inside = cuts.filter((c) => c.at > start && c.at - start <= room);
    const line = inside.filter((c) => c.kind === "line").pop(), sentence = inside.filter((c) => c.kind !== "word").pop(), word = inside.pop();
    const pick = line && line.at - start >= room / 2 ? line : sentence ?? (last ? undefined : word);
    if (!pick) {
      if (last) break; // the last part ends on a whole sentence or not at all: what is left is said, never cut
      // one unbroken run longer than a part: split on code points (never inside a character)
      let chunk = "";
      for (const ch of text.slice(start, start + max)) { if (chunk.length + ch.length > max) break; chunk += ch; }
      parts.push(chunk); start += chunk.length; continue;
    }
    parts.push(text.slice(start, pick.at).trim()); start = pick.next;
    if (last) break;
  }
  const left = start < text.length ? text.slice(start).trim() : "";
  if (left && parts.length) parts[parts.length - 1] = `${parts[parts.length - 1]}\n\n${PARTS_LEFT_NOTE}`;
  return { parts: parts.filter(Boolean), left };
}

// (Before 2026-11-06 the head was cut at ANSWER_MAX_CHARS by splitLongAnswer and the rest went as one message of at most 3,000
// characters, MORE_MAX_CHARS, past which it was dropped; the page path chunked it for a research_brief page. Both are gone.)
// The answer text with every URL taken out (a line that was only a link goes, a link inside a sentence leaves the sentence).
export function withoutLinks(text: string): string {
  return String(text ?? "").replace(/<!--[\s\S]*?-->/g, "").split("\n").map((line) => {
    const rest = withoutUrls(line), bare = rest.replace(/[\s:()\-–—•*]+/g, "");
    return findUrls(line).length && !bare ? "" : rest.replace(/\s*\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trimEnd();
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The shape of one reply. `allowedLinks`: the URLs the turn may show (those a tool returned or the person typed); null: the
// caller vouches for every link (the code-written replies). A link that is not allowed is dropped from links and answer.
export function shapeReply(raw: RawShape, o: { allowedLinks?: Iterable<string> | null } = {}): ShapedReply {
  const notes: string[] = [];
  const allowed = o.allowedLinks ? new Set([...o.allowedLinks].map(trimUrl)) : null;
  let answer = String(raw.answer ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();

  // Links: whatever the model put in `links`, then every URL left in the answer; each once, http(s) only, in order.
  const wanted = [...(Array.isArray(raw.links) ? raw.links.map((l) => trimUrl(String(l ?? "").trim())) : []), ...urlsIn(answer)];
  const links: string[] = [];
  for (const u of wanted) {
    if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(u)) { notes.push(`link dropped (not a web address): ${u.slice(0, 80)}`); continue; }
    if (allowed && !allowed.has(u)) { notes.push(`link dropped (no tool returned it): ${u.slice(0, 120)}`); continue; }
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
  // A long answer is never a file: it goes as whole-sentence parts (answerParts), the head first, nothing cut (beta C12).
  let parts: string[] | undefined;
  if (answer.length > ANSWER_MAX_CHARS) {
    const p = answerParts(answer);
    if (p.parts.length > 1) {
      parts = p.parts; answer = p.parts[0];
      notes.push(p.left ? `long answer: ${p.parts.length} parts; ${p.left.length} characters past the last part were not sent (the stored reply has them)` : `long answer: ${p.parts.length} parts, whole`);
    }
  }
  return { answer, attachments: files, links, notes, ...(parts ? { parts } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Order of sends: the answer, each attachment, each link. `io` is the channel's own sender (the tests' fake transport too).

export type SendStep = { kind: "answer"; text: string } | { kind: "document"; file: ShapedFile } | { kind: "link"; url: string };
export function planSends(s: ShapedReply, o: { includeAnswer?: boolean } = {}): SendStep[] {
  return [
    ...(o.includeAnswer !== false && s.answer ? [{ kind: "answer" as const, text: s.answer }] : []),
    ...(s.parts ?? []).slice(1).map((text) => ({ kind: "answer" as const, text })),
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
// not an exact payload the person approves. Anything else is returned untouched and carries no shape.
// A long answer comes back as `parts` (the delivery shape, through the parts contract) and `reply` is the WHOLE answer (with the
// links it shows, each on its own line), so the stored reply (agent_messages) holds everything that was said and more turns can
// see it (beta C12: only the head was stored).
export function shapeForTurn(o: { on: boolean; channel: string; writable: boolean; reply: string; attachments?: unknown; allowedLinks?: Iterable<string> | null }):
  { reply: string; parts: string[] | null; shape: { attachments: { filename: string; content: string }[]; links: string[] } | null; notes: string[] } {
  if (!o.on || o.channel !== "telegram" || !o.writable) return { reply: o.reply, parts: null, shape: null, notes: [] };
  const s = shapeReply({ answer: o.reply, attachments: o.attachments }, { allowedLinks: o.allowedLinks });
  if (!s.answer && !s.attachments.length) return { reply: o.reply, parts: null, shape: null, notes: s.notes }; // nothing left to say: today's reply stands
  const shape = s.attachments.length || s.links.length ? { attachments: s.attachments.map((f) => ({ filename: f.filename, content: f.content })), links: s.links } : null;
  if (s.parts) {
    const whole = withoutLinks(String(o.reply ?? "").replace(/<!--[\s\S]*?-->/g, "")).trim();
    return { reply: [whole, ...s.links].join("\n"), parts: s.parts, shape, notes: s.notes };
  }
  return { reply: s.answer || o.reply, parts: null, shape, notes: s.notes };
}
