// ONE-TIME CODES AND PASSWORDS IN CHAT (2026-11-06; root-cause report PR-6, offline registry A23): a code or a password the
// person pastes into chat ("Greenhouse sent me code 482913", "the portal's verification code is K7X9P2", "my workday password
// is ...") is answered by code with fixed safety text, never by a model and never by the router's "I didn't catch that":
// codes and passwords never travel through chat (CLAUDE.md, a rule that never moves; owner 2026-10-11, decision 1). The value
// is never stored: identity_redact.ts removes the labeled ones before anything stores the text, and this module removes the
// code-shaped tokens it still finds next to a code word ("portal", "sent me", "verification ... : K7X9P2"), the same way
// ("[code removed]"). Trainee's own path for an employer's emailed code is career_email_code.ts: it reads the code from
// Gmail, and only inside an application the person approved.
//
// Never a number that is not a code: a GPA, a pay figure, a year, a count ("2 years", "$24/hour", "1200 applications"), a
// zip, promo, error or course code. While an employer's emailed code is waiting (WO-100 codePending), the situation turn
// answers instead (it knows which application waits on it); the code itself is still removed (chat_input.ts).

export const CODE_IN_CHAT_INTENT = "career_code_in_chat";
// Fixed safety text (ARCHITECTURE §3.1: safety text is code's).
export const CODE_IN_CHAT_REPLY = "Please don't share one-time codes or passwords in chat, with me or anyone. " +
  "If your Gmail is connected, Trainee reads an employer's emailed code itself, and only during an application you approved. " +
  "Otherwise, type the code into the employer's portal yourself, and sign in there with your own password.";

// reply: whether this turn is answered with CODE_IN_CHAT_REPLY. Redaction (text, userContent) covers every message chat
// accepts; only the safety reply is for chat-length messages.
export type CodeInChat = { text: string; userContent: string; removed: ("code" | "password")[]; reply: boolean };

// A message longer than this is a pasted document (a resume, a posting) or a longer ask: its own turn (the resume read)
// answers it, so it never gets the fixed safety reply. Its code-shaped tokens next to a code word are still removed, at any
// length chat accepts (Greptile P1 on release PR #549, 2026-11-06: identity_redact.ts needs a code label, so an unlabeled
// "the Workday portal sent me 739201" in a message over this limit was stored as typed).
export const CODE_REPLY_MAX_LEN = 400;
const MARKER = /\[(code|password) removed\]/g;
// A code word before the token, in the same sentence. Strong words name a code; weak ones ("portal", "sent me") only say
// something was handed over, so a 4-digit year after them stays a year.
const STRONG = /\b(?:one[- ]time(?:\s+(?:code|pass(?:code|word)?|pin))?|verification|verify|otp|2fa|mfa|two[- ]factor|passcode|pass code|security code|sign[- ]?in code|log[- ]?in code|auth(?:entication)? code|code)\b/gi;
const WEAK = /\b(?:portal|(?:sent|texted|emailed|gave|messaged)\s+me)\b/gi;
// "zip code", "promo code", "error code", "dress code" ...: a named code is a number to keep (identity_redact.ts NAMED_CODE).
const NAMED_BEFORE_CODE = /\b(?:zip|postal|post|area|country|promo|promotional|discount|coupon|referral|course|class|error|status|dial|tax|product|source|job|dress|invite|invitation|gift|reference|ref|airport|sort|swift|bank|routing|color|colour|style|item|sku|qr|bar|tracking|order|confirmation|requisition|req|ticket|case|zip\s*\+\s*4)\s+$/i;
// A digit code: 4 to 8 digits (an optional space or dash inside only after a strong word), not money, a decimal, a time or a count.
const DIGITS = /(?<![\d$€£.,/#\w-])\d(?:[ -]?\d){3,7}(?![\d%\w-]|[.,:/]\d)/g;
const COUNT_AFTER = /^\s*(?:k\b|\+|%|usd|dollars?|bucks|years?|yrs?|months?|weeks?|days?|hours?|hrs?|minutes?|mins?|lines?|applications?|apps?|jobs?|roles?|people|times|words|characters|chars|employees|users|students|miles|am\b|pm\b|per\b|a\s+(?:year|month|week|day)|an\s+hour|\/)/i;
// A short letters-and-digits code (K7X9P2, ab12cd34): 5 to 10 characters with at least two digits and two letters, only
// after a strong word; never a unit ("30min", "401k", "24hr") or a word with a number in it ("Office365" has one letter run).
const ALNUM = /(?<![\w$-])(?=[A-Za-z0-9]{5,10}(?![\w-]))(?=(?:[A-Za-z]*\d){2})(?=(?:\d*[A-Za-z]){2})[A-Za-z0-9]{5,10}(?![\w-])/g;
const UNIT_LIKE = /^\d+(?:am|pm|min|mins|hr|hrs|h|k|th|st|nd|rd|yrs?|gb|mb|kb|px|mph|kg|lbs?)$/i;
const YEAR = /^(?:19|20)\d\d$/;
// What leads a year: a date preposition, or a month or season (2026-11-06, side effect of #544: only "in", "since" and "of"
// counted, so "my verification from 2019" lost its year).
const YEAR_LEAD = /\b(?:in|since|of|from|during|until|till|thru|through|by|before|after|around|circa|between|early|mid|late|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|spring|summer|fall|autumn|winter)\.?,?\s+$|\bmid-$/i;

function contextEnds(sentence: string, re: RegExp): number[] {
  const out: number[] = [];
  for (const m of sentence.matchAll(re)) {
    if (re === STRONG && /^code$/i.test(m[0]) && NAMED_BEFORE_CODE.test(sentence.slice(0, m.index))) continue;
    out.push((m.index ?? 0) + m[0].length);
  }
  return out;
}
// The code-shaped tokens of one sentence that follow a code word within 60 characters.
function tokensIn(sentence: string): { start: number; end: number }[] {
  const strong = contextEnds(sentence, STRONG), weak = contextEnds(sentence, WEAK);
  if (!strong.length && !weak.length) return [];
  const near = (at: number, ends: number[]) => ends.some((e) => at >= e && at - e <= 60);
  const hits: { start: number; end: number }[] = [];
  for (const m of sentence.matchAll(DIGITS)) {
    const at = m.index ?? 0, tok = m[0], after = sentence.slice(at + tok.length);
    if (COUNT_AFTER.test(after)) continue;
    const isStrong = near(at, strong);
    if (!isStrong && !near(at, weak)) continue;
    // Weak context: only a plain run of 4-8 digits that is not a year.
    if (!isStrong && (/[ -]/.test(tok) || YEAR.test(tok))) continue;
    // A year in a year context ("verification from 2019", "in March 2024", "back in 2021") is a year; a year-shaped number
    // right after "code" or "verification" with no such lead ("code 2024", "verification code is 2019") stays removed.
    if (isStrong && YEAR.test(tok) && YEAR_LEAD.test(sentence.slice(0, at))) continue;
    hits.push({ start: at, end: at + tok.length });
  }
  for (const m of sentence.matchAll(ALNUM)) {
    const at = m.index ?? 0, tok = m[0];
    if (UNIT_LIKE.test(tok) || !near(at, strong)) continue;
    hits.push({ start: at, end: at + tok.length });
  }
  return hits;
}

// The turn's message after chat_input.ts (identity_redact.ts) took the labeled secrets out, and what it removed. Returns the
// text to store and answer with (any code-shaped token left next to a code word removed too), or null when the message
// shares no code or password. A message over CODE_REPLY_MAX_LEN returns only when this module removed a token itself
// (reply false): identity_redact.ts's own removals in it are already in the text and its note.
export function codeInChat(message: string, o: { userContent?: string; removed?: readonly string[]; codePending?: boolean } = {}): CodeInChat | null {
  const msg = String(message ?? "");
  if (!msg.trim() || o.codePending) return null;
  const reply = msg.length <= CODE_REPLY_MAX_LEN;
  const removed = new Set<"code" | "password">();
  for (const r of o.removed ?? []) if (r === "code" || r === "password") removed.add(r);
  for (const m of msg.matchAll(MARKER)) removed.add(m[1] as "code" | "password");
  // Sentence by sentence, so "the portal is Workday. I graduated in 2024" never joins a code word to a number.
  const values: string[] = [];
  const text = msg.split(/((?<=[.!?\n])\s+)/).map((part, i) => {
    if (i % 2) return part; // the space between two sentences
    let s = part;
    for (const h of tokensIn(part).sort((a, b) => b.start - a.start)) { values.push(part.slice(h.start, h.end)); s = `${s.slice(0, h.start)}[code removed]${s.slice(h.end)}`; }
    return s;
  }).join("");
  if (values.length) removed.add("code");
  if (!removed.size || (!reply && !values.length)) return null;
  let userContent = String(o.userContent ?? msg);
  for (const v of values) userContent = userContent.split(v).join("[code removed]");
  return { text, userContent, removed: [...removed], reply };
}

// redactionNote's own "never send passwords or codes in a message ..." sentence repeats CODE_IN_CHAT_REPLY; on this turn the
// note keeps only what was removed.
export function noteForCodeTurn(note: string | null): string | null {
  if (!note) return note;
  return note.replace(/\s*Never send passwords or codes in a message:[^.]*\.\s*/, " ").trim() || null;
}
