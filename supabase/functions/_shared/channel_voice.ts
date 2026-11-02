// V1 TEXTING VOICE (2026-10-27): channel-native delivery. How a reply looks and arrives on each texting channel, the way a
// person texts: links on their own line, messages split where a person would split them (between paragraphs, list items or
// sentences, never inside a sentence or a link, never a "1/3" counter), no markdown on SMS and iMessage, light formatting
// on WhatsApp and Telegram, a typing indicator while Trainee works, and a quick "on it" when a turn runs long, followed
// by the result. Voice spec: docs/architect/specs/TEXTING-VOICE-2026-10-27.md.
//
// This module only shapes and paces what the existing delivery path already sends (channel_adapters.ts and each adapter,
// the outbox and deliverDue in channel.ts, runInbound in channel_inbound.ts). It is switched on per deploy with
// CAREER_TEXTING_NATIVE=on; off, every adapter renders exactly as before.

import { findUrls, safeCut, type UrlSpan, urlsOf } from "./channel_text.ts";
import { toBubbles } from "./conversation.ts";

export type VoiceChannel = "imessage" | "sms" | "whatsapp" | "telegram" | "web";
export const textingNativeOn = (env: { get(k: string): string | undefined }) => env.get("CAREER_TEXTING_NATIVE") === "on";

// CHANNEL DELIVERY SCENARIOS (2026-10-29): links are found by channel_text.ts findUrls (a link's own brackets kept, the
// sentence's punctuation and brackets left out), each link once per line, and removed from the line by its position, so a
// shorter link never eats the start of a longer one.
const MD_LINK = /!?\[([^\]\n]+)\]\((https?:\/\/[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)/g;

// "Data Analyst at Acme (https://x/1) — Chicago" becomes "Data Analyst at Acme — Chicago" then the link on its own line,
// so it previews and taps cleanly; a markdown link [label](url) becomes the label, then the link (once, even when the
// label is the link itself).
// 1v1 (2026-11-01, Q584/Q585/Q632): a line of several sentences is read sentence by sentence, so each link lands right
// after the sentence that says what it is ("Data Analyst at Brex (link1) — Chicago. Data Analyst at Notion (link2)." was
// both sentences, then both links, so neither link sat under its own posting). A line of one sentence is as before.
export function linksOnOwnLine(text: string): string {
  const out: string[] = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(MD_LINK, (_m, label: string, url: string) => {
      const l = label.trim();
      return l === url || urlsOf(l)[0] === url ? url : `${l} ${url}`;
    });
    if (!findUrls(line).length) { out.push(raw); continue; }
    const parts = closedSentences(line);
    if (parts.length < 2) { linkLine(line, out); continue; }
    let plain = "";
    for (const p of parts) {
      if (!findUrls(p).length) { plain = plain ? `${plain} ${p}` : p; continue; }
      if (plain) { out.push(plain); plain = ""; }
      linkLine(p, out);
    }
    if (plain) out.push(plain);
  }
  return out.join("\n");
}
// Sentences whose emphasis and code marks are closed: a sentence that leaves **, __, ~~, a lone * or _, or a backtick
// open is joined with the next until they close (review of #368: "**Bold. Two** sentences" was split open, and the
// unmatched ** reached iMessage raw). Marks inside a link do not count.
function openMarks(s: string): boolean {
  let t = "", at = 0;
  for (const u of findUrls(s)) { t += s.slice(at, u.start) + " "; at = u.end; }
  t += s.slice(at);
  const ticks = (t.match(/`/g) || []).length;
  t = t.replace(/`[^`]*`/g, " ");
  const odd = (re: RegExp) => ((t.match(re) || []).length % 2) === 1;
  return ticks % 2 === 1 || odd(/\*\*/g) || odd(/__/g) || odd(/~~/g) ||
    odd(/(?<![\p{L}\p{N}*])\*(?!\*)|(?<!\*)\*(?![\p{L}\p{N}*])/gu) || odd(/(?<![\p{L}\p{N}_])_(?!_)|(?<!_)_(?![\p{L}\p{N}_])/gu);
}
function closedSentences(line: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const p of sentences(line)) {
    buf = buf ? `${buf} ${p}` : p;
    if (!openMarks(buf)) { out.push(buf); buf = ""; }
  }
  if (buf) out.push(buf);
  return out;
}
function linkLine(line: string, out: string[]) {
  const spans = findUrls(line);
  let rest = "", at = 0;
  for (const sp of spans) { rest += `${line.slice(at, sp.start)} `; at = sp.end; }
  rest += line.slice(at);
  rest = rest.replace(/\(\s*\)|<\s*>|\[\s*\]/g, "").replace(/(\*\*|__|~~|\*|_|`)\s*\1/g, "").replace(/[ \t]+([,.;:!?])(?=\s|$)/g, "$1")
    .replace(/\s{2,}/g, " ").replace(/\s*[:—–-]\s*$/, "").trim();
  // Only a list marker left ("-", "•", "2.") goes with the line; a number that is content ("15.49: <link>") stays.
  const bare = !rest || /^(?:[-*•]|\d{1,3}[.)])?$/.test(rest);
  if (!bare) out.push(rest);
  const seen = new Set<string>();
  for (const sp of spans) if (!seen.has(sp.url)) { seen.add(sp.url); out.push(sp.url); }
}

// 1v1 (Q94): a date in a text reads the way a person writes it ("Oct 19, 2026"), never the database's 2026-10-19. Links are
// never touched.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Review of #368: code (a `span` or a ``` block) is never touched either.
export function humanDates(text: string): string {
  const day = (t: string) => t.replace(/\b(20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b(?![T:\d])/g, (_m, y: string, m: string, d: string) => `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`);
  const prose = (t: string) => { let o = "", at = 0; for (const u of findUrls(t)) { o += day(t.slice(at, u.start)) + u.url; at = u.end; } return o + day(t.slice(at)); };
  let fenced = false;
  return String(text ?? "").split("\n").map((line) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return line; }
    if (fenced) return line;
    return line.split(/(`[^`\n]*`)/).map((part) => /^`[^`]*`$/.test(part) ? part : prose(part)).join("");
  }).join("\n");
}

// A part counter ("(1/3)", "1/3) ") the model wrote at the start or end of its lines is never sent. Only a real count is
// one: two or more lines numbered n/m with the same m, one of them 1 and none past m. A single "(4/5)" is the person's
// content ("Glassdoor rating (4/5)", "(3/4) of the roles are remote") and stays word for word.
const COUNTER_LEAD = /^\s*\(?(\d+)\s*\/\s*(\d+)\)\s+/, COUNTER_TAIL = /\s+\((\d+)\s*\/\s*(\d+)\)\s*$/;
export function stripCounters(text: string): string {
  const lines = String(text ?? "").split("\n");
  const found = lines.map((l) => {
    const m = COUNTER_LEAD.exec(l) ?? COUNTER_TAIL.exec(l);
    return m ? { n: Number(m[1]), of: Number(m[2]), lead: COUNTER_LEAD.test(l) } : null;
  });
  const counted = new Set<number>();
  for (const of of new Set(found.filter((f) => f).map((f) => f!.of))) {
    const ns = found.filter((f) => f && f.of === of).map((f) => f!.n);
    if (of >= 2 && ns.length >= 2 && ns.includes(1) && ns.every((n) => n >= 1 && n <= of) && new Set(ns).size === ns.length) counted.add(of);
  }
  if (!counted.size) return lines.join("\n");
  return lines.map((l, i) => {
    const f = found[i];
    if (!f || !counted.has(f.of)) return l;
    return f.lead ? l.replace(COUNTER_LEAD, "") : l.replace(COUNTER_TAIL, "");
  }).join("\n");
}

// ------------------------------------------------------------------------------------------------ inline formatting
// One reading of the reply's markdown for every channel: a link or a `code` span is never read as formatting (so a
// link's "__" or "*" is never touched), **bold** / __bold__, *italic* / _italic_ (not inside a word: snake_case stays),
// ~~strike~~ and ***both*** are read only when they open and close properly; anything else is the person's text, as
// written. Each channel then writes the same reading in its own markup, so nothing is left half formatted.
type Seg = { t: "text" | "url" | "code"; s: string } | { t: "b" | "i" | "s"; kids: Seg[] };
const WORD = /[\p{L}\p{N}]/u;
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

function closerOf(s: string, from: number, d: string, urls: Map<number, UrlSpan>): number {
  for (let j = from; j < s.length; j++) {
    const u = urls.get(j);
    if (u) { j = u.end - 1; continue; }
    if (s[j] === "`") { const k = s.indexOf("`", j + 1); if (k > j + 1) { j = k; continue; } }
    if (!s.startsWith(d, j) || isSpace(s[j - 1])) continue;
    const after = s[j + d.length];
    if (after !== undefined && (WORD.test(after) || after === d[0])) continue;
    return j;
  }
  return -1;
}
// CHANNEL DELIVERY ROUND 2 (2026-10-30): crossing emphasis. "**a *b** c*" (the italic opens inside the bold and closes
// after it) showed its asterisks on every channel ("a *b c*" on iMessage). It is read as properly nested pieces: bold "a
// " with italic "b" inside, then italic " c" (Telegram <b>a <i>b</i></b><i> c</i>; plain "a b c").
const parseInline = (s: string): Seg[] => parseInlineX(s).segs;
function parseInlineX(s: string): { segs: Seg[]; open: { at: number; d: string } | null } {
  const segs: Seg[] = [];
  const urls = new Map(findUrls(s).map((u) => [u.start, u]));
  let buf = "", i = 0, open: { at: number; d: string } | null = null;
  const node = (d: string, kids: Seg[]): Seg => (d === "***" ? { t: "b", kids: [{ t: "i", kids }] } : { t: d === "~~" ? "s" : d.length === 2 ? "b" : "i", kids });
  const flush = () => { if (buf) { segs.push({ t: "text", s: buf }); buf = ""; } };
  while (i < s.length) {
    const u = urls.get(i);
    if (u) { flush(); segs.push({ t: "url", s: u.url }); i = u.end; continue; }
    const ch = s[i];
    if (ch === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i + 1) { flush(); segs.push({ t: "code", s: s.slice(i + 1, j) }); i = j + 1; continue; }
    }
    const d = s.startsWith("***", i) ? "***" : s.startsWith("**", i) ? "**" : s.startsWith("__", i) ? "__" : s.startsWith("~~", i) ? "~~" : ch === "*" || ch === "_" ? ch : null;
    if (d) {
      const opens = !isSpace(s[i + d.length]) && s[i + d.length] !== d[0] && (i === 0 || !WORD.test(s[i - 1]));
      const j = opens ? closerOf(s, i + d.length + 1, d, urls) : -1;
      if (j > 0) {
        flush();
        const inner = s.slice(i + d.length, j), x = parseInlineX(inner);
        // An emphasis opened inside and never closed there, closed after this one: both close here, it opens again after.
        if (x.open && x.open.d !== d) {
          const rest = s.slice(j + d.length), d2 = x.open.d;
          const k = closerOf(rest, 1, d2, new Map(findUrls(rest).map((u) => [u.start, u])));
          if (k > 0 && !isSpace(rest[k - 1])) {
            segs.push(node(d, [...parseInline(inner.slice(0, x.open.at)), node(d2, parseInline(inner.slice(x.open.at + d2.length)))]));
            segs.push(node(d2, parseInline(rest.slice(0, k))));
            i = j + d.length + k + d2.length;
            continue;
          }
        }
        segs.push(node(d, x.segs));
        i = j + d.length;
        continue;
      }
      if (opens && open === null) open = { at: i, d };
      buf += d; i += d.length; // not formatting: the person's characters, all of them
      continue;
    }
    buf += ch; i++;
  }
  flush();
  return { segs, open };
}
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
type Mode = "plain" | "telegram" | "whatsapp";
function renderSegs(segs: Seg[], mode: Mode): string {
  return segs.map((g) => {
    if (!("kids" in g)) {
      if (g.t !== "code") return mode === "telegram" ? escapeHtml(g.s) : g.s;
      return mode === "telegram" ? `<code>${escapeHtml(g.s)}</code>` : mode === "whatsapp" ? `\`${g.s}\`` : g.s;
    }
    const inner = renderSegs(g.kids, mode);
    if (mode === "plain") return inner;
    if (mode === "telegram") return g.t === "b" ? `<b>${inner}</b>` : g.t === "i" ? `<i>${inner}</i>` : `<s>${inner}</s>`;
    // WhatsApp reads a mark only against a non-space character: spaces at a piece's edge go outside its marks.
    const m = g.t === "b" ? "*" : g.t === "i" ? "_" : "~", lead = /^\s*/.exec(inner)![0], trail = /\s*$/.exec(inner.slice(lead.length))![0];
    const core = inner.slice(lead.length, inner.length - trail.length);
    return core ? `${lead}${m}${core}${m}${trail}` : inner;
  }).join("");
}
// A heading is bold as a whole; bold inside it is just its text (WhatsApp's "**Title**" was a heading with bold in it).
const unbold = (segs: Seg[]): Seg[] => segs.flatMap((g) => (g.t === "b" ? unbold(g.kids) : g.t === "i" || g.t === "s" ? [{ ...g, kids: unbold(g.kids) }] : [g]));
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
function renderLines(base: string, mode: Mode): string {
  const out: string[] = [];
  let fence: string[] | null = null;
  const closeFence = () => {
    if (fence === null) return;
    if (mode === "telegram") { if (fence.length) out.push(`<pre>${escapeHtml(fence.join("\n"))}</pre>`); }
    else if (mode === "whatsapp") out.push("```\n" + fence.join("\n") + "\n```");
    else out.push(...fence);
    fence = null;
  };
  for (const raw of base.split("\n")) {
    if (/^\s*```/.test(raw)) { if (fence) closeFence(); else fence = []; continue; }
    if (fence) { fence.push(raw); continue; }
    let line = raw;
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) || (/\|/.test(line) && /-{2,}/.test(line) && TABLE_SEP.test(line))) continue; // a rule, a table's header line
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().slice(1, -1).split("|").map((c) => c.trim()).filter(Boolean).join(" · ");
    if (mode !== "whatsapp") line = line.replace(/^\s{0,3}>\s?/, ""); // WhatsApp shows "> " as its own quote
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const inner = renderSegs(unbold(parseInline(h[1])), mode);
      out.push(mode === "telegram" ? `<b>${inner}</b>` : mode === "whatsapp" ? `*${inner}*` : inner);
      continue;
    }
    const li = /^(\s*)[*•+]\s+/.exec(line);
    if (li) { out.push(`${li[1]}- ${renderSegs(parseInline(line.slice(li[0].length)), mode)}`); continue; }
    out.push(renderSegs(parseInline(line), mode));
  }
  closeFence();
  return out.join("\n");
}

// Plain text with no markdown at all (SMS, iMessage). List lines keep a plain "- " or "1. "; a table row is its cells.
export function stripMarkdown(text: string): string {
  return renderLines(String(text ?? ""), "plain");
}
// Telegram, with parse_mode HTML: bold, italic, strike and code (links stay bare on their own line, where Telegram
// previews them). Everything else is escaped, so no text of the person's or an employer's can open a tag, and the tags are
// always properly nested (never an entity inside code).
export function telegramHtml(text: string): string {
  return renderLines(String(text ?? ""), "telegram");
}
// The same text without markup, for when Telegram refuses the HTML ("can't parse entities"): sent again as plain text.
export function telegramPlain(html: string): string {
  return String(html ?? "").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
// WhatsApp's own formatting: *bold*, _italic_, ~strike~, `code`.
function whatsappMarks(text: string): string {
  return renderLines(String(text ?? ""), "whatsapp");
}

export function formatForChannel(text: string, channel: VoiceChannel): string {
  const linked = (stripCounters(linksOnOwnLine(String(text ?? "").replace(/<!--[\s\S]*?-->/g, "")))).replace(/\n{3,}/g, "\n\n").trim();
  if (channel === "web") return linked.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, "**$1**");
  const base = humanDates(linked);
  if (channel === "sms" || channel === "imessage") return stripMarkdown(base);
  if (channel === "whatsapp") return whatsappMarks(base);
  return telegramHtml(base);
}

// Sentences of one line: split after . ! ? (not inside a link, an abbreviation like "e.g." or a number like 2.5).
export function sentences(line: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const tok of String(line).split(/(\s+)/)) {
    buf += tok;
    if (/[.!?]["”’)]*$/.test(tok) && !/^https?:\/\//.test(tok) && !/^(e\.g|i\.e|etc|vs|mr|ms|mrs|dr|st|no)\.$/i.test(tok) && !/^\d+\.$/.test(tok)) { out.push(buf.trim()); buf = ""; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// Natural splitting: whole paragraphs while they fit; a longer paragraph splits between its lines (list items, links),
// then between sentences; a link is never cut. Only a single sentence longer than a whole message is cut, at a space.
export function splitNatural(text: string, max: number): string[] {
  const clean = stripCounters(String(text ?? "")).trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  // Units in reading order, each with the separator that joins it to the one before when they share a message.
  const units: { s: string; sep: string }[] = [];
  const paras = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  paras.forEach((p, pi) => {
    const paraSep = pi === 0 ? "" : "\n\n";
    if (p.length <= max) { units.push({ s: p, sep: paraSep }); return; }
    p.split("\n").map((l) => l.trim()).filter(Boolean).forEach((l, li) => {
      const lineSep = li === 0 ? paraSep : "\n";
      if (l.length <= max) { units.push({ s: l, sep: lineSep }); return; }
      sentences(l).forEach((s, si) => {
        const pieces = s.length <= max ? [s] : cutAtSpaces(s, max);
        pieces.forEach((x, xi) => units.push({ s: x, sep: si === 0 && xi === 0 ? lineSep : " " }));
      });
    });
  });
  const out: string[] = [];
  let buf = "";
  for (const u of units) {
    if (buf && buf.length + u.sep.length + u.s.length <= max) buf += u.sep + u.s;
    else { if (buf) out.push(buf); buf = u.s; }
  }
  if (buf) out.push(buf);
  return out.map((b) => b.trim()).filter(Boolean);
}
function cutAtSpaces(s: string, max: number): string[] {
  const out: string[] = [];
  let buf = "";
  for (const w of s.split(/(?<=\s)/)) {
    if (buf && (buf + w).length > max) { out.push(buf.trim()); buf = ""; }
    // A word longer than a whole message (never a link, which stays whole) is cut, never inside a character.
    if (w.length > max && !/^https?:\/\//.test(w)) { let r = w; while (r.length > max) { const c = safeCut(r, max) || max; out.push(r.slice(0, c)); r = r.slice(c); } buf = r; } else buf += w;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// What an adapter renders when CAREER_TEXTING_NATIVE is on: split on the reply's own words, then each message formatted
// for its channel (formatting after splitting, so no bold or tag ever spans two messages).
export function nativeRender(channel: VoiceChannel, max: number): (text: string) => string[] {
  return (text: string) => splitNatural(linksOnOwnLine(String(text ?? "").replace(/<!--[\s\S]*?-->/g, "")), max)
    .map((b) => formatForChannel(b, channel)).filter((b) => b.trim());
}
// iMessage (CHANNEL DELIVERY SCENARIOS, 2026-10-29): the texting voice applies there too (no markdown on SMS and iMessage),
// and the bubbles stay the ones WO-013 shipped: texting-sized, each bare link alone in its bubble for its preview card.
// 1v1 (2026-11-01, Q77): one to three short sentences a bubble. A reply is first cut between paragraphs, lines and sentences
// into texts of at most IMESSAGE_BUBBLE_CHARS (a link never cut), then each goes through the same bubbles.
export const IMESSAGE_BUBBLE_CHARS = 320;
// Only between sentences: a single sentence longer than that is left whole for toBubbles (its 700-char bubbles, as before).
export function imessageNativeRender(text: string): string[] {
  return sentenceTexts(formatForChannel(String(text ?? ""), "imessage"), IMESSAGE_BUBBLE_CHARS).flatMap((t) => toBubbles(t));
}
// Style targets (evals/career/one-v-one/style-targets.json, from the owner's brief, observed): a bubble also carries at most
// TEXT_MAX_SENTENCES sentences. Units are paragraphs, lines and sentences (closed marks only); a unit longer than max stays whole.
export const TEXT_MAX_SENTENCES = 3;
const isSentence = (u: string) => /[\p{L}\p{N}]/u.test(u) && !/^https?:\/\/\S+$/.test(u.trim());
function sentenceTexts(text: string, max: number, maxSentences = TEXT_MAX_SENTENCES): string[] {
  const clean = String(text ?? "").trim();
  if (!clean) return [];
  const units: { s: string; sep: string; n: number }[] = [];
  clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).forEach((p, pi) => {
    const paraSep = pi === 0 ? "" : "\n\n";
    p.split("\n").map((l) => l.trim()).filter(Boolean).forEach((l, li) => {
      const lineSep = li === 0 ? paraSep : "\n";
      closedSentences(l).forEach((x, si) => units.push({ s: x, sep: si === 0 ? lineSep : " ", n: isSentence(x) ? 1 : 0 }));
    });
  });
  if (clean.length <= max && units.reduce((k, u) => k + u.n, 0) <= maxSentences) return [clean];
  const out: string[] = [];
  let buf = "", count = 0;
  for (const u of units) {
    if (buf && buf.length + u.sep.length + u.s.length <= max && count + u.n <= maxSentences) { buf += u.sep + u.s; count += u.n; }
    else { if (buf) out.push(buf); buf = u.s; count = u.n; }
  }
  if (buf) out.push(buf);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// While Trainee works: a typing indicator, refreshed while the turn runs, and one quick acknowledgement when the turn takes
// longer than a few seconds. The ack only says what Trainee is doing now; it never claims a result.

export function ackFor(message: string): string {
  const m = String(message ?? "").toLowerCase();
  if (/\b(find|search|look(ing)? for|show me|any)\b.*\b(jobs?|roles?|openings?|internships?|positions?|postings?)\b|\bjobs?\b.*\bin\b/.test(m)) return "on it — looking for roles now";
  if (/\bapply\b|\bapplications?\b/.test(m) && /\b(status|where|did|go through|heard)\b/.test(m)) return "on it — checking your applications";
  if (/\bapply\b/.test(m)) return "on it — getting that ready";
  if (/\bresume\b|\bcv\b/.test(m)) return "on it — reading that now";
  if (/\b(email|write|draft|message)\b/.test(m)) return "on it — writing that now";
  if (/\b(interview|mock|prep|practice)\b/.test(m)) return "on it — setting that up now";
  // N12: the interim says what Trainee is doing, never just "one sec"; it claims no result.
  return "on it — working on that now";
}

// N12/N13 LATENCY BUDGET (spec 16 speed): on a chat channel the typing indicator goes out as soon as a message arrives
// and again every TYPING_EVERY_MS while Trainee works (Telegram clears it after about 5 s); a turn still running after
// FAST_ACK_MS gets exactly one interim line (ackFor: what Trainee is doing, never a result), then the real answer.
export const TYPING_EVERY_MS = 4000;
export const FAST_ACK_MS = 6000;
export const LATENCY_BUDGET = { typingEveryMs: TYPING_EVERY_MS, ackAfterMs: FAST_ACK_MS } as const;

// The typing indicator from now until stop(): shown at once, then every everyMs; best effort (a failure never touches the
// turn); stop() ends the refresh and waits for a call in flight, so nothing is shown after the answer.
export function typingLoop(o: { typing: () => Promise<unknown>; everyMs?: number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void }) {
  const setT = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = o.clearTimer ?? ((h: unknown) => clearTimeout(h as number));
  let done = false, timer: unknown = null;
  const pending: Promise<unknown>[] = [];
  const show = () => { try { pending.push(Promise.resolve(o.typing()).catch(() => {})); } catch { /* never fails the turn */ } };
  const tick = () => { if (done) return; show(); timer = setT(tick, o.everyMs ?? TYPING_EVERY_MS); };
  tick();
  return {
    async stop() {
      done = true;
      if (timer !== null) clearT(timer);
      timer = null;
      await Promise.all(pending);
    },
  };
}

// One interim at most, armed once: start() arms it (a second start() is a no-op), stop() disarms it and waits for an ack
// already started, so it always reaches the person before the answer. Returns whether the ack went.
export function ackOnce(o: { afterMs: number | null | undefined; ack: () => Promise<unknown>; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void }) {
  const setT = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = o.clearTimer ?? ((h: unknown) => clearTimeout(h as number));
  let armed = false, done = false, acked = false, timer: unknown = null, pending: Promise<unknown> | null = null;
  return {
    start() {
      if (armed || done || o.afterMs === null || o.afterMs === undefined || !(o.afterMs >= 0)) return;
      armed = true;
      timer = setT(() => {
        if (done || acked) return;
        acked = true;
        try { pending = Promise.resolve(o.ack()).catch(() => {}); } catch { /* never fails the turn */ }
      }, o.afterMs);
    },
    async stop(): Promise<boolean> {
      done = true;
      if (timer !== null) clearT(timer);
      timer = null;
      if (pending) await pending;
      return acked;
    },
  };
}

export interface WorkingOptions {
  typing?: (() => Promise<unknown>) | null; // show the indicator once (it lasts a few seconds on the platform)
  typingEveryMs?: number; // refresh it this often while the turn runs (Telegram's lasts 5 s, WhatsApp's 25 s)
  ackAfterMs?: number | null; // send the ack when the turn is still running after this long; null: never
  ack?: (() => Promise<unknown>) | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}
// Runs `work` with the indicator on and the ack armed; whatever happens to them, the turn's own result (or error) is what
// comes back. Returns whether the ack went.
export async function whileWorking<T>(o: WorkingOptions, work: () => Promise<T>): Promise<{ value: T; acked: boolean }> {
  const setT = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = o.clearTimer ?? ((h: unknown) => clearTimeout(h as number));
  let done = false, acked = false;
  const timers: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const quiet = (p: (() => Promise<unknown>) | null | undefined) => { if (!p) return; try { pending.push(Promise.resolve(p()).catch(() => {})); } catch { /* never fails the turn */ } };
  if (o.typing) {
    quiet(o.typing);
    const every = o.typingEveryMs ?? 4000;
    const tick = () => { if (done) return; quiet(o.typing); timers.push(setT(tick, every)); };
    timers.push(setT(tick, every));
  }
  if (o.ack && o.ackAfterMs !== null && o.ackAfterMs !== undefined && o.ackAfterMs >= 0) {
    timers.push(setT(() => { if (done) return; acked = true; quiet(o.ack); }, o.ackAfterMs));
  }
  try {
    const value = await work();
    return { value, acked };
  } finally {
    done = true;
    for (const t of timers) clearT(t);
    // The ack, if it started, finishes before the result goes, so they arrive in order.
    await Promise.all(pending);
  }
}
