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
