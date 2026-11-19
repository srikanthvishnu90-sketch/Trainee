// MESSY TEXT (word-vomit benchmark, owner 2026-11-18: "take a poor sentence that doesn't have a direct claim, figure out how to
// accomplish the task or need within it"). People text the way they talk: apostrophes dropped ("dont", "im"), slang ("kms",
// "wanna"), voice-to-text artifacts ("um", "uh", the words "period" and "comma"), typos in the words that matter
// ("anaylst"), numbers half spelled ("twenty seven", "3 thousand"), and corrections mid-sentence ("in austin wait no not austin
// i meant remote"). The screens and the router read fixed phrases, so each of those slipped past them
// (evals/word-vomit/: "i dont want to be here anymore" missed the crisis screen; "find me software intern roles in austin
// wait no not austin i meant anywhere remote" searched for "software wait meant python stuff").
//
// These functions only rewrite the WORDING code reads. The stored message and the text the brain sees stay what was typed.
// They never add a name, a place, a role, a number or a link that was not in the message, and never decide anything.

// ------------------------------------------------------------------------------------------------ contractions
// The apostrophe-less forms phones produce, back to the form the screens expect ("dont" -> "don't").
const CONTRACTIONS: [RegExp, string][] = [
  [/\b(do|does|did|is|are|was|were|has|have|had|could|would|should|must|need)nt\b/gi, "$1n't"],
  [/\bdont\b/gi, "don't"], [/\bcant\b/gi, "can't"], [/\bwont\b/gi, "won't"], [/\baint\b/gi, "ain't"],
  [/\bim\b/gi, "i'm"], [/\bive\b/gi, "i've"], [/\bidk\b/gi, "i don't know"], [/\bidc\b/gi, "i don't care"],
  [/\b(wanna)\b/gi, "want to"], [/\b(gonna)\b/gi, "going to"], [/\b(gotta)\b/gi, "got to"],
];
export function plainContractions(s: string): string {
  let t = String(s ?? "").replace(/[‘’ʼ`]/g, "'");
  for (const [rx, to] of CONTRACTIONS) t = t.replace(rx, to);
  return t;
}

// ------------------------------------------------------------------------------------------------ crisis wording
// Self-harm slang and plain phrasings, read as the phrase the core's two crisis screens already carry (crisis.ts). Only the
// reading changes; the reply is still the core's own 988 text. "kms" after a number is kilometres ("10 kms away").
const CRISIS_SLANG: [RegExp, string][] = [
  [/(?<![\d.]\s?)\bkms\b/gi, "kill myself"],
  [/\bunalive\s+(?:my\s*self|me)\b/gi, "kill myself"],
  [/(?<!\b(?:n't|not|never)\s+)\b(?:i\s+)?(?:want|wish)\s+(?:to\s+)?(?:die|be dead|not exist)\b(?!\s+on\b)/gi, "i don't want to live"],
  [/\b(?:i\s+)?(?:don't|do not)\s+want\s+to\s+(?:exist|wake up)(?:\s+any\s*more)?\b/gi, "i don't want to live"],
  [/\bend(?:ing)?\s+it\s+all\b/gi, "end it all"],
  [/\b(?:no|not any)\s+(?:point|reason)\s+(?:in|to)\s+(?:living|being alive|go(?:ing)? on)\b/gi, "no reason to live"],
];
/** The message as the crisis screens should read it: apostrophes restored, slang read as its plain phrase. */
export function crisisReading(s: string): string {
  let t = plainContractions(s);
  for (const [rx, to] of CRISIS_SLANG) t = t.replace(rx, to);
  return t;
}

// ------------------------------------------------------------------------------------------------ the routing reading
// What the router and the code-first turns read (handler-career.ts, before careerAskCanon): the message with the talk taken
// out and the corrections applied. The stored message and the brain's text stay as typed.
import { ROLE_NOUNS, slip, slips2, TITLE_WORDS, VERBS } from "./career_ask_canon.ts";

// Voice-to-text: hesitations, and punctuation said as a word. "period" stays a word after a noun it belongs to ("pay period").
const HESITATION = /(^|[\s,])(?:u+m+|u+h+m*|e+r+m+|hm+)(?=[\s,.!?]|$)[,]?/gi;
const PERIOD_NOUNS = /\b(?:pay|trial|grace|probation|probationary|notice|waiting|time|this|that|the|a|review|reporting|billing|vesting|cooling|holiday|blackout|application|quiet|study|exam|testing)\s*$/i;
function dictation(t: string): string {
  let s = t.replace(/\s+question mark\b/gi, "?").replace(/\s+exclamation (?:point|mark)\b/gi, "!").replace(/\s+comma\b/gi, ",").replace(/\s+new ?line\b/gi, "\n");
  s = s.replace(/\s+(?:period|full stop)\b(?=\s+[a-z]|\s*$)/gi, (m, off: number) => PERIOD_NOUNS.test(s.slice(0, off)) ? m : ".");
  return s;
}
// "find me like 20", "is that like 18 an hour": "like" as a hedge after a verb or "so", never "jobs like this" or "I'd like".
const LIKE_HEDGE = /\b(me|need|want|wants|find|get|got|so|is|are|r|be|for|about|maybe|than|that)\s+like\s+(?=\S)/gi;
// "okay so ...", "so um ...": only a lead that ends in "so" (a bare "ok", "ya" or "yeah" is an answer, never filler).
const LEAD = /^\s*(?:(?:ok(?:ay)?|alright|yeah|ya|well|hey|yo)[,\s]+)?so[,\s]+(?=\S)/i;

// A correction mid-sentence: "<B> wait no not <X> i meant <R>", "<B> actually not <X>, <R>", "<B> wait no not <X>". When X is in
// B, X is replaced by R (or dropped with its "or"/"and"/"in" when no R is given). Any other "wait" is left alone.
const CORRECTION = /^([\s\S]*?)[,.\s]+(?:wait|actually|oops|sorry|no wait)[,\s]+(?:no[,\s]+|nvm[,\s]+|scratch that[,\s]+)*not\s+(?:in\s+)?([^,.;!?]+?)(?:[,\s]+(?:i\s+meant?|i\s+mean|make\s+it|instead|rather|just)\s+([^,.;!?]+?))?(?=[,.;!?]|$)([\s\S]*)$/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function corrected(t: string): string {
  const m = t.match(CORRECTION);
  if (!m) return t;
  const [, before, x, r, rest] = m;
  const xs = x.trim();
  if (!xs || xs.split(/\s+/).length > 4) return t;
  const at = before.toLowerCase().lastIndexOf(xs.toLowerCase());
  if (at < 0 || !new RegExp(`\\b${esc(xs)}\\b`, "i").test(before)) return t;
  let b: string;
  if (r && r.trim()) {
    const rep = r.trim().replace(/^(?:in\s+)?anywhere\s+(?=remote\b)/i, "");
    b = before.slice(0, at) + rep + before.slice(at + xs.length);
    // "roles in remote" reads as "remote roles" does: "in" goes before "remote".
    b = b.replace(/\bin\s+(remote)\b/gi, "$1");
  } else {
    b = before.slice(0, at).replace(/[\s,]*(?:\bor\b|\band\b|\bin\b)?\s*$/i, "") + before.slice(at + xs.length);
  }
  return `${b.trim()}${rest}`.trim();
}

// Numbers half spelled: "twenty seven" -> 27, "3 thousand" -> 3000, "a hundred" -> 100. A lone "one" or "two" stays a word
// ("the second one", "one of them").
const UNITS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
function numbers(t: string): string {
  const tens = Object.keys(TENS).join("|"), units = Object.keys(UNITS).join("|"), teens = Object.keys(TEENS).join("|");
  let s = t.replace(new RegExp(`\\b(${tens})[\\s-]+(${units})\\b`, "gi"), (_, a, b) => String(TENS[a.toLowerCase()] + UNITS[b.toLowerCase()]));
  s = s.replace(new RegExp(`\\b(${tens}|${teens})\\b`, "gi"), (w) => String(TENS[w.toLowerCase()] ?? TEENS[w.toLowerCase()]));
  s = s.replace(new RegExp(`\\b(a|${units})\\s+(hundred|thousand)\\b`, "gi"), (_, a, b) => String((a.toLowerCase() === "a" ? 1 : UNITS[a.toLowerCase()]) * (b.toLowerCase() === "hundred" ? 100 : 1000)));
  s = s.replace(/\b(\d+(?:\.\d+)?)\s+(hundred|thousand)\b/gi, (_, n, b) => String(Math.round(Number(n) * (b.toLowerCase() === "hundred" ? 100 : 1000))));
  return s;
}

// Typos in the long words routing depends on ("anaylst", "intrnship", "recuiter"). Six letters or more only, lowercase only:
// a short or capitalized word may be a name ("dana" is not "data").
const LONG_VOCAB = [...new Set([...VERBS, ...ROLE_NOUNS, ...TITLE_WORDS, "recruiter", "recruiters", "interview", "interviews", "negotiate", "applications", "internships", "resume", "followup", "outreach", "deadline", "deadlines"])].filter((v) => v.length >= 6);
function typos(t: string): string {
  return t.replace(/\b[a-z]{6,}\b/g, (w) => {
    if (LONG_VOCAB.includes(w)) return w;
    if (LONG_VOCAB.some((v) => w === `${v}s` || `${w}s` === v)) return w;
    return LONG_VOCAB.find((v) => v[0] === w[0] && slip(w, v)) ?? LONG_VOCAB.find((v) => slips2(w, v) && v[0] === w[0]) ?? w;
  });
}

/** The routing reading of a messy message, or null when nothing in it needed reading differently. */
export function routingReading(message: string): string | null {
  const raw = String(message ?? "");
  // A pasted document (a resume, a posting, an email: several lines or a long block) is the person's own words to keep exactly,
  // and a link is read as typed; only a texted message is read here.
  if (!raw.trim() || raw.length > 600 || raw.split("\n").filter((l) => l.trim()).length > 2 || /https?:\/\//i.test(raw)) return null;
  let t = dictation(raw);
  t = t.replace(HESITATION, "$1");
  t = t.replace(LEAD, "");
  t = corrected(t);
  t = t.replace(LIKE_HEDGE, "$1 ");
  t = numbers(t);
  t = typos(t);
  t = t.replace(/\s+([,.!?])(?=\s|$)/g, "$1").replace(/,\s*\./g, ".").replace(/[ \t]+/g, " ").replace(/^[\s,.]+/, "").trim();
  return t && t !== raw.trim() ? t : null;
}
