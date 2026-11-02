// The chat reply for an open career question: ONE short paragraph, verdict first (what is realistic now, what comes later),
// ending with the file link. The model writes it; this file only checks it. Returns the problems found; empty means it may be sent.
import { unsupported } from "./guard.ts";

export const CHAT_MAX_WORDS = 105, CHAT_MIN_WORDS = 25, CHAT_MAX_SENTENCES = 6;
const FILLER = ["i hope this helps", "great question", "as an ai", "best of luck", "good luck", "it's important to", "it is important to", "there are many factors", "everyone's journey", "don't be afraid", "put yourself out there", "think outside the box", "reach out to your network", "leverage your", "it depends on many", "every situation is unique", "feel free to", "let me know if", "in today's competitive", "job market is tough", "it'd be tough", "it would be tough", "generally speaking", "to be honest", "i think maybe", "might possibly", "kind of", "sort of", "a lot of", "basically", "just remember", "at the end of the day", "hope that helps", "i'd be happy", "happy to help"];
const OPENERS = /^\s*(?:great|good|excellent|interesting|fair|sure|absolutely|certainly|of course|thanks|thank you|well|so|ok|okay|hey|hi|hello|i understand|i see|that's a)\b/i;
const NOW = /\b(?:now|today|this (?:semester|year|summer|term|season)|right now|at this stage|currently|for now|first)\b/i;
const ACTION = /\b(?:this (?:week|month|semester|year|summer)|today|start|begin|first (?:step|move|weeks?|days?)|build|apply|take|join|learn|ask|message|finish|confirm|pass|log|sort|lock|replace|use|have|send|book|write|pick|talk|get|getting|practice|prepare|target|show|reach)\b/i;
const PROMISE = /\bguarantee(?:d|s)?\b|\byou(?:['’]ll| will) (?:definitely |certainly |surely )?(?:be (?:hired|promoted|accepted|admitted|selected)|get (?:the|an?|that) (?:offer|job|seat|internship))\b|\b(?:certain|sure|bound) to (?:get|be) (?:hired|in|accepted|an offer)\b/i;
const MONEY_ASK = /\b(?:wire|venmo|zelle|western union)\b|\b(?:send|pay|transfer)\b[^.]{0,30}\b(?:money|deposit|fee|payment|funds)\b|\bgift cards?\b|\b(?:bitcoin|crypto) (?:payment|wallet)\b|\bdeposit to secure\b/i;
const LATER = /\b(?:later|next (?:year|summer|semester|season)|after|once|eventually|then|over time|down the line)\b/i;

export function lintChat(p: string, o: { link?: string | null; noLink?: boolean; facts: { text: string; quote: string; label: string }[]; person: string[]; message: string }): string[] {
  const bad: string[] = [];
  const t = p.trim(), link = o.link ?? null;
  const prose = link ? t.replace(link, "").trim() : t.replace(/https?:\/\/\S+/g, "").trim();
  const words = (prose.match(/\S+/g) ?? []).length;
  if (/\n\s*\n|\n\s*(?:[-*•]|\d+[.)]|#)/.test(t) || /^\s*(?:[-*•#]|\d+[.)])/.test(t)) bad.push("not one plain paragraph");
  if (words > CHAT_MAX_WORDS) bad.push(`too long (${words} words, cap ${CHAT_MAX_WORDS})`);
  if (words < CHAT_MIN_WORDS) bad.push(`too short (${words} words)`);
  if (o.noLink) {
    if (/https?:\/\//.test(t) || /\b(?:file|attached|attachment|link|brief|document)\b/i.test(t)) bad.push("claims a file or link that does not exist");
  } else if (link ? !t.endsWith(link) : !/https?:\/\/\S+$/.test(t)) bad.push("does not end with the file link");
  const sents = prose.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sents.length > CHAT_MAX_SENTENCES) bad.push(`too many sentences (${sents.length})`);
  const lower = prose.toLowerCase().replace(/[‘’]/g, "'");
  const filler = FILLER.filter((x) => lower.includes(x));
  if (filler.length) bad.push(`hedging or filler: ${filler.join(", ")}`);
  if (OPENERS.test(prose)) bad.push("canned opener");
  if (!NOW.test(sents[0] ?? "") && !/\b(?:realistic|realistically)\b/i.test(sents[0] ?? "")) bad.push("verdict is not first (say what is realistic now)");
  if (!LATER.test(prose)) bad.push("no mention of what comes later");
  if (!ACTION.test(prose)) bad.push("no concrete next action (say one thing to do this week)");
  if ((prose.match(/\?/g) ?? []).length > 1) bad.push("more than one question");
  if (/!/.test(prose) || /[\u{1F300}-\u{1FAFF}☀-➿]/u.test(prose)) bad.push("exclamation mark or emoji");
  // grammar a regex can see
  if (/ {2,}\S|\b(\w{3,})\s+\1\b/i.test(prose)) bad.push("repeated word or double space");
  if (sents.some((s) => /^[a-z]/.test(s))) bad.push("sentence starts lowercase");
  if (/\bi\b(?!['’])/.test(prose.replace(/"[^"]*"/g, ""))) bad.push("lowercase I");
  if (!/[.?:]$/.test(prose)) bad.push("last sentence has no end punctuation");
  // RESEARCH SCENARIOS (2026-10-29): a promise about the person's outcome or an ask for money is never advice a source
  // supports (and is what an injected page asks the model to say): "you are guaranteed an offer", "wire the deposit".
  if (PROMISE.test(prose)) bad.push("promises an outcome no source supports");
  if (MONEY_ASK.test(prose)) bad.push("asks for money or a payment");
  const support = [...o.facts.flatMap((f) => [f.text, f.quote, f.label]), ...o.person, o.message];
  const extra = unsupported(prose.replace(/\[[^\]]*\]/g, ""), support);
  if (extra.length) bad.push(`specifics with no source: ${extra.join(", ")}`);
  return bad;
}
