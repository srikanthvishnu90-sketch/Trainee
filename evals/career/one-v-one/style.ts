// 1v1 style (2026-11-01): how simply a reply reads, against the targets in style-targets.json (derived from the owner's brief,
// observed; numbers only). Pure and free: per reply, what the phone shows (score.ts visible()), measured and checked.
import { findUrls } from "../../../supabase/functions/_shared/channel_text.ts";
import { type Channel, visible } from "./score.ts";

export const TARGETS = JSON.parse(Deno.readTextFileSync(new URL("./style-targets.json", import.meta.url))).targets as {
  max_sentences_per_bubble: number; max_words_per_sentence: number; median_words_per_sentence: number; max_words_per_bubble: number;
  max_reading_grade_fk: number; max_text_bubbles_per_reply: number; max_questions_per_reply: number;
};
export const STYLE_CHECKS = ["sentences_per_bubble", "words_per_sentence", "words_per_bubble", "reading_grade", "bubbles_per_reply", "link_alone", "markdown", "jargon", "questions"] as const;
export type StyleCheck = typeof STYLE_CHECKS[number];

const JARGON = /\b(payload|source class|null|undefined|router|intent|company[- ]file|no row|held for your approval|sized by what the sources yield|containment|boundary|on the record|on record)\b|\b20\d\d-\d\d-\d\d\b/i;
const linkOnly = (b: string) => { const t = b.trim(); const u = findUrls(t); return u.length === 1 && u[0].start === 0 && u[0].end === t.length; };
const noUrls = (s: string) => { let o = "", at = 0; for (const u of findUrls(s)) { o += s.slice(at, u.start); at = u.end; } return o + s.slice(at); };
// Sentences as a reader counts them: a line break or ". ! ?" followed by a capital, digit or quote ends one.
// A list (numbered or "- " lines, or short lines under a line ending ":") counts as one sentence: it is one unit to read.
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let inList = false, prevColon = false;
  for (const raw of noUrls(text).split("\n")) {
    const l = raw.trim();
    if (!/[\p{L}\p{N}]/u.test(l)) continue;
    const item = /^(\d{1,2}[.)]|[-•])\s/.test(l) || (prevColon && !/[.!?]$/.test(l)) || (inList && !/[.!?]$/.test(l));
    if (item) { if (!inList) out.push(l); else out[out.length - 1] += " " + l; inList = true; prevColon = false; continue; }
    inList = false;
    out.push(...l.split(/(?<=[.!?])["”’)]*\s+(?=[A-Z0-9"“$(])/).map((x) => x.trim()).filter((x) => /[\p{L}\p{N}]/u.test(x)));
    prevColon = /:$/.test(l);
  }
  return out;
}
const wordsOf = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
function syllables(w: string): number {
  const x = w.toLowerCase().replace(/[^a-z]/g, "");
  if (!x) return 1;
  let n = (x.match(/[aeiouy]+/g) || []).length;
  if (x.endsWith("e") && n > 1 && !x.endsWith("le")) n--;
  return Math.max(1, n);
}
export function fkGrade(sents: string[]): number {
  const ws = sents.flatMap(wordsOf);
  if (!ws.length || !sents.length) return 0;
  return 0.39 * ws.length / sents.length + 11.8 * ws.reduce((n, w) => n + syllables(w), 0) / ws.length - 15.59;
}

export interface StyleRow { sentencesPerBubble: number; wordsPerSentenceMax: number; wordsPerSentenceMedian: number; wordsPerBubble: number; grade: number; bubbles: number; questions: number; failed: StyleCheck[] }
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function styleOf(bubbles: string[], ch: Channel): StyleRow {
  const shown = bubbles.map((b) => visible(String(b ?? ""), ch)).filter((b) => b.trim());
  const text = shown.filter((b) => !linkOnly(b));
  const per = text.map((b) => sentencesOf(b));
  const sents = per.flat();
  const wps = per.flatMap((p, i) => p.map((x) => x)).map((x) => wordsOf(x).length);
  // A list's words are counted per item for sentence length (a list unit is not one long sentence).
  const itemWords = text.flatMap((b) => noUrls(b).split("\n")).filter((l) => /^(\d{1,2}[.)]|[-•])\s/.test(l.trim())).map((l) => wordsOf(l).length);
  if (itemWords.length) { const listUnits = new Set(per.flat().filter((x) => /^(\d{1,2}[.)]|[-•])\s/.test(x))); for (const u of listUnits) { const i = per.flat().indexOf(u); if (i >= 0) wps[i] = Math.max(...itemWords); } }
  const T = TARGETS;
  const row: StyleRow = {
    sentencesPerBubble: Math.max(0, ...per.map((p) => p.length)), wordsPerSentenceMax: Math.max(0, ...wps), wordsPerSentenceMedian: median(wps),
    wordsPerBubble: Math.max(0, ...text.map((b) => wordsOf(noUrls(b)).length)), grade: Math.round(fkGrade(sents) * 10) / 10, bubbles: ch === "web" ? Math.min(1, text.length) : text.length,
    questions: (noUrls(text.join("\n")).replace(/"[^"\n]*"|“[^”\n]*”/g, "").match(/\?/g) || []).length, failed: [],
  };
  const f = row.failed;
  if (row.sentencesPerBubble > T.max_sentences_per_bubble) f.push("sentences_per_bubble");
  if (row.wordsPerSentenceMax > T.max_words_per_sentence) f.push("words_per_sentence");
  if (row.wordsPerBubble > T.max_words_per_bubble) f.push("words_per_bubble");
  // A reply under 10 words has no meaningful reading grade ("Anytime." scores 20).
  if (row.grade > T.max_reading_grade_fk && sents.flatMap(wordsOf).length >= 10) f.push("reading_grade");
  if (row.bubbles > T.max_text_bubbles_per_reply) f.push("bubbles_per_reply");
  const lines = shown.flatMap((b) => b.split("\n")).map((l) => l.trim()).filter(Boolean);
  if (lines.some((l) => findUrls(l).length && !linkOnly(l))) f.push("link_alone");
  const all = text.join("\n");
  if (/\*\*[^*\n]+\*\*|__[^_\n]+__|^\s{0,3}#{1,6}\s|```|^\s*\|.*\|\s*$|\[[^\]\n]+\]\(https?:/m.test(all)) f.push("markdown");
  if (JARGON.test(noUrls(all))) f.push("jargon");
  if (row.questions > T.max_questions_per_reply) f.push("questions");
  return row;
}

// The fix that would bring a reply inside the targets, per failed check (for the worst-replies table).
export const FIX: Record<StyleCheck, string> = {
  sentences_per_bubble: "split into bubbles of at most 3 sentences",
  words_per_sentence: "break long sentences (one clause each, <=25 words)",
  words_per_bubble: "cut to the answer and one next step; detail goes to a page",
  reading_grade: "plainer words, shorter sentences",
  bubbles_per_reply: "answer in 1-3 bubbles; a list goes to a page",
  link_alone: "put each link alone on its own line",
  markdown: "plain text, no markdown",
  jargon: "drop internal words (on record, company file, ISO dates)",
  questions: "one question at most, at the end",
};
