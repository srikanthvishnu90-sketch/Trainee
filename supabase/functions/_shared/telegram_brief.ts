// TELEGRAM BRIEF (owner's response brief, 2026-11-01; referenced as "brief P<part>.<rule>"): how a reply looks on Telegram.
//
//   - brief P1.2 / P5.2: answers arrive in bubbles of at most about three sentences, one idea each; a short complete answer
//     stays one bubble (never split for the look of it).
//   - brief P1.3 / P7.4: no visible Markdown syntax (no raw asterisks, header marks or list dashes): plain sentences.
//   - brief P2 / P5.12: a link is its own message, right after one line of context; it is never the first thing said.
//   - brief P1.1 / P5.1 / P7.5: slow work gets an immediate acknowledgment (a reaction where the platform has one, else one
//     short plan line); a question answerable in one line gets none (slowWork below decides which is which).
//
// Structured text a person approves or reads as a whole (an application card's exact answers, a numbered list, label:value
// rows) is kept together in one bubble: splitting it would put one payload across several messages. Structure belongs in a
// File; this layer only shapes what is sent, it never changes a word of it beyond the markup.
import { findUrls } from "./channel_text.ts";
import { formatForChannel } from "./channel_voice.ts";

// CAREER_TELEGRAM_BRIEF=on turns on the bubble shape and the search's File shape on Telegram. Off, Telegram renders as before
// (older acceptance tests pin that shape: a long answer in two messages, the text as iMessage reads it); threading, the eyes
// reaction and the search fixes do not depend on it.
export const telegramBriefOn = (env: { get(k: string): string | undefined }) => env.get("CAREER_TELEGRAM_BRIEF") === "on";
export const BRIEF_SENTENCES = 3; // brief P1.2: at most about three sentences per bubble
export const BRIEF_BUBBLE_CHARS = 1500; // the texting rule's own cap per message (telegram.ts PACK)
export const ACK_REACTION = "\u{1F440}"; // brief P1.1: eyes, "on it"

// Sentences of one line: split after . ! ? (or an ellipsis) followed by a space and a capital, a digit or a quote. A decimal
// ("$32.50"), a domain ("acme.com") and an initial inside a name never end a sentence (no space after the point there).
export function sentencesOf(line: string): string[] {
  const s = String(line ?? "").trim();
  if (!s) return [];
  const out: string[] = [];
  let at = 0;
  const re = /([.!?…]+["”’)]?)\s+(?=["“‘(]?[A-Z0-9$])/g;
  for (let m: RegExpExecArray | null; (m = re.exec(s));) {
    const end = m.index + m[1].length;
    const before = s.slice(at, end);
    // "e.g.", "i.e.", "vs.", "St.", "Inc." and a single capital initial ("J.") do not end a sentence.
    if (/(?:\b(?:e\.g|i\.e|vs|etc|St|Inc|Co|Corp|Ltd|Jr|Sr|Dr|Mr|Ms|Mrs|No|approx)\.|\b[A-Z]\.)$/.test(before)) continue;
    out.push(before.trim());
    at = re.lastIndex;
  }
  const rest = s.slice(at).trim();
  if (rest) out.push(rest);
  return out;
}

// Structured lines: a numbered or bulleted row, or a "Label: value" field. A paragraph of them is one bubble.
const ROW = /^\s*(?:\d{1,3}[.)]\s|[•·▪︎-]\s|[A-Z][A-Za-z /&'()-]{0,40}:\s\S)/;
const isStructured = (lines: string[]) => {
  const rows = lines.filter((l) => ROW.test(l) && l.length <= 300).length;
  return rows >= 2 && rows >= Math.ceil(lines.length / 2);
};

// Plain text: formatForChannel's iMessage reading (the one every channel shares: markdown links become "label url", emphasis
// and header marks go), and list dashes become bullets.
export function plainText(text: string): string {
  return formatForChannel(String(text ?? ""), "imessage")
    .replace(/^(\s*)[-*+]\s+(?=\S)/gm, "$1• ")
    .replace(/\n{3,}/g, "\n\n").trim();
}

// The bubbles of one reply on Telegram (brief P1.2, P1.3, P2).
export function briefBubbles(text: string, max = BRIEF_BUBBLE_CHARS): string[] {
  const clean = plainText(text);
  if (!clean) return [];
  const out: string[] = [];
  let buf: string[] = [], count = 0;
  const flush = () => { const t = buf.join(" ").replace(/[ \t]+\n/g, "\n").trim(); if (t) out.push(t); buf = []; count = 0; };
  const push = (sentence: string, joiner = " ") => {
    if (count >= BRIEF_SENTENCES || (buf.length && buf.join(" ").length + sentence.length + 1 > max)) flush();
    buf.push(buf.length && joiner === "\n" ? `\n${sentence}` : sentence);
    count++;
  };
  const paras = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  // brief P5.2 exception: a short complete answer (three sentences or fewer, no link) is one bubble, whatever its lines.
  const all = paras.flatMap((p) => p.split("\n")).flatMap(sentencesOf);
  if (all.length <= BRIEF_SENTENCES && !findUrls(clean).length && clean.length <= max) return [clean];
  for (const para of paras) {
    const lines = para.split("\n").map((l) => l.trim()).filter(Boolean);
    // One idea per bubble: a paragraph never shares a bubble with the one before it.
    flush();
    if (isStructured(lines) && !lines.some((l) => findUrls(l).length)) {
      // Kept whole (up to the cap): a card's answers, a list, label:value rows.
      let block: string[] = [];
      for (const l of lines) {
        if (block.length && block.join("\n").length + l.length + 1 > max) { out.push(block.join("\n")); block = []; }
        block.push(l);
      }
      if (block.length) out.push(block.join("\n"));
      continue;
    }
    for (const line of lines) {
      const urls = findUrls(line);
      if (!urls.length) { for (const s of sentencesOf(line)) push(s); continue; }
      // brief P2: the line's words are the context, the link follows as its own message.
      let at = 0;
      for (const u of urls) {
        const before = line.slice(at, u.start).replace(/[\s:–—(<\["“‘'-]+$/, "").trim();
        for (const s of sentencesOf(before)) push(s);
        flush();
        out.push(u.url);
        at = u.end;
      }
      const after = line.slice(at).replace(/^[\s)\]>.,;:]+/, "").trim();
      for (const s of sentencesOf(after)) push(s);
    }
  }
  flush();
  // A link is never the first message: with no words before it, the reply is only the link (nothing to add here).
  return out;
}

// brief P1.1 / P5.1 / P7.5: is this message slow work (a live search, an application check, a draft, reading a file)? A question
// answerable in one line (a status word, a yes or no, what Trainee is) is not, and gets no acknowledgment at all.
export function slowWork(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  if (!m.trim() || m.trim().startsWith("/")) return false;
  if (/\b(find|search|look(ing)? for|show( me)?|get me|send( me)?|list|any)\b[^.?!]{0,60}\b(jobs?|roles?|openings?|internships?|positions?|postings?)\b/.test(m)) return true;
  if (/\b(jobs?|roles?|internships?|postings?)\b[^.?!]{0,30}\b(in|near|for|that match|matching)\b/.test(m) && /\b(find|show|search|any|new|real|live)\b/.test(m)) return true;
  if (/\b(tailor|rewrite|draft|write)\b[^.?!]{0,40}\b(resume|cv|cover letter|email|message|note)\b/.test(m)) return true;
  if (/\bapply (?:me )?(?:to|for)\b/.test(m)) return true;
  return false;
}
// The one short plan line, said at once when no reaction could be shown (brief P7.5's own words for a search).
export function planLine(message: string): string {
  const m = String(message ?? "").toLowerCase();
  if (/\b(jobs?|roles?|openings?|internships?|positions?|postings?)\b/.test(m)) return "On it — checking live postings now.";
  if (/\b(tailor|resume|cv)\b/.test(m)) return "On it — working on your resume now.";
  if (/\bapply\b/.test(m)) return "On it — getting that application ready now.";
  return "On it — working on that now.";
}
