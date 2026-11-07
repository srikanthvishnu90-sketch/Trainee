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

// reply: true when the fixed safety text answers the turn; false for a long pasted document, which keeps its own turn (its
// token is removed all the same).
export type CodeInChat = { text: string; userContent: string; removed: ("code" | "password")[]; reply: boolean };

// A message longer than this is a pasted document (a resume, a posting): its own turn (the resume read) answers it instead
// of the safety text. Only the REPLY is limited by this: a code-shaped token next to a code word is removed from a message of
// any accepted length (Greptile P1 on PR #549: a 480-character message used to keep "Workday sent me 739201").
const MAX_CHAT_LEN = 400;
const MARKER = /\[(code|password) removed\]/g;
// A code word before the token, in the same sentence. Strong words name a code; weak ones ("portal", "sent me") only say
// something was handed over, so a 4-digit year after them stays a year.
const STRONG = /\b(?:one[- ]time(?:\s+(?:code|pass(?:code|word)?|pin))?|verification|verify|otp|2fa|mfa|two[- ]factor|passcode|pass code|security code|sign[- ]?in code|log[- ]?in code|auth(?:entication)? code|code)\b/gi;
const WEAK = /\b(?:portal|(?:sent|texted|emailed|gave|messaged)\s+me)\b/gi;
// "zip code", "promo code", "error code", "dress code" ...: a named code is a number to keep (identity_redact.ts NAMED_CODE).
const NAMED_BEFORE_CODE = /\b(?:zip|postal|post|area|country|promo|promotional|discount|coupon|referral|course|class|error|status|dial|tax|product|source|job|dress|invite|invitation|gift|reference|ref|airport|sort|swift|bank|routing|color|colour|style|item|sku|qr|bar|tracking|order|confirmation|requisition|req|ticket|case|zip\s*\+\s*4)\s+$/i;
// A digit code: 4 to 8 digits (an optional space or dash inside only after a strong word), not money, a decimal, a time or a count.
const DIGITS = /(?<![\d$€£.,/#\w-])\d(?:(?:[ \t\u00a0\u2007\u2009\u202f]{0,8}(?:(?:\r\n|[\r\n\-\u2013\u2014])[ \t\u00a0\u2007\u2009\u202f]{0,8})?)\d){3,7}(?![\d%\w-]|[.,:/]\d)/g;
const COUNT_AFTER = /^\s*(?:k\b|\+|%|usd|dollars?|bucks|years?|yrs?|months?|weeks?|days?|hours?|hrs?|minutes?|mins?|lines?|applications?|apps?|jobs?|roles?|people|times|words|characters|chars|employees|users|students|miles|am\b|pm\b|per\b|a\s+(?:year|month|week|day)|an\s+hour|\/)/i;
// A short letters-and-digits code (K7X9P2, ab12cd34): 5 to 10 characters with at least two digits and two letters, only
// after a strong word; never a unit ("30min", "401k", "24hr") or a word with a number in it ("Office365" has one letter run).
const ALNUM = /(?<![\w$-])(?=[A-Za-z0-9]{5,10}(?![\w-]))(?=(?:[A-Za-z]*\d){2})(?=(?:\d*[A-Za-z]){2})[A-Za-z0-9]{5,10}(?![\w-])/g;
const UNIT_LIKE = /^\d+(?:am|pm|min|mins|hr|hrs|h|k|th|st|nd|rd|yrs?|gb|mb|kb|px|mph|kg|lbs?)$/i;
const YEAR = /^(?:19|20)\d\d$/;
// A code split in two by a space, a line break (\n, \r\n or \r) or a dash ("739 201", "739-201", "739\n201"; Greptile on #566 and #567) after a weak cue: exactly 3+3 digits, and no more digit groups
// after it (so "415 555 1234" and "415-555-1234" stay phone numbers).
const SPLIT_CODE = /^\d{3}(?:[ \t\u00a0\u2007\u2009\u202f]{1,8}|[ \t\u00a0\u2007\u2009\u202f]{0,8}(?:\r\n|[\r\n\-\u2013\u2014])[ \t\u00a0\u2007\u2009\u202f]{0,8})\d{3}$/;
const MORE_GROUPS = /^(?:[ \t\u00a0\u2007\u2009\u202f]{1,8}|[ \t\u00a0\u2007\u2009\u202f]{0,8}(?:\r\n|[\r\n\-\u2013\u2014])[ \t\u00a0\u2007\u2009\u202f]{0,8})\d/;
// A sentence that hands over the value of a code the previous sentence named: "The portal sent a code. It is 739201."
const VALUE_LEAD = /^\s*(?:it(?:'s|\s+is|\s+was)|its|that(?:'s|\s+is|\s+was)|the\s+(?:code|number|password|pin)\s+(?:is|was)|here(?:'s|\s+it\s+is)|(?:it|they)\s+said|the\s+digits\s+(?:are|were))\b/i;

function contextEnds(sentence: string, re: RegExp): number[] {
  const out: number[] = [];
  // A redaction marker ("[security code removed]") is not a code word: the code it names is already gone, so the next number
  // ("the zip is 94107", a year on the next line) is kept (reconciliation of Greptile record 22).
  const marks = [...sentence.matchAll(/\[[A-Za-z][A-Za-z -]{0,40} removed\]/g)].map((k) => [k.index ?? 0, (k.index ?? 0) + k[0].length]);
  for (const m of sentence.matchAll(re)) {
    if (marks.some(([a, b]) => (m.index ?? 0) >= a && (m.index ?? 0) < b)) continue;
    if (re === STRONG && /^code$/i.test(m[0]) && NAMED_BEFORE_CODE.test(sentence.slice(0, m.index))) continue;
    out.push((m.index ?? 0) + m[0].length);
  }
  return out;
}
// The code-shaped tokens of one sentence that follow a code word within 60 characters.
function tokensIn(sentence: string, carried = false): { start: number; end: number }[] {
  const strong = contextEnds(sentence, STRONG), weak = contextEnds(sentence, WEAK);
  if (carried) strong.push(0);
  if (!strong.length && !weak.length) return [];
  const near = (at: number, ends: number[]) => ends.some((e) => at >= e && at - e <= 60);
  const hits: { start: number; end: number }[] = [];
  for (const m of sentence.matchAll(DIGITS)) {
    // A token joins digit groups across a line break ("7392\n01" is one code). Only when the joined token is followed by a
    // count ("739201\n2 minutes ago") and the first line's group is a code by itself is the first line its own token, so the
    // count neither hides the code nor is removed with it (Greptile on #574 and #575).
    const at = m.index ?? 0, firstLine = m[0].split(/\r\n|[\r\n]/)[0].replace(/[^\d]+$/, "");
    const lineCut = firstLine !== m[0] && firstLine.replace(/\D/g, "").length >= 4 && COUNT_AFTER.test(sentence.slice(at + m[0].length));
    let tok = lineCut ? firstLine : m[0], after = sentence.slice(at + tok.length);
    if (COUNT_AFTER.test(after)) continue;
    const isStrong = near(at, strong);
    if (!isStrong && !near(at, weak)) continue;
    // Weak context: only a plain run of 4-8 digits that is not a year.
    // Weak context: a later group of a spaced run ("555 1234" in "415 555 1234") is part of a phone number or a date.
    if (!isStrong && /\d(?:[ \t\u00a0\u2007\u2009\u202f]{1,8}|[ \t\u00a0\u2007\u2009\u202f]{0,8}(?:\r\n|[\r\n\-\u2013\u2014])[ \t\u00a0\u2007\u2009\u202f]{0,8})$/.test(sentence.slice(0, at))) continue;
    if (!isStrong && /[ \r\n\t\u00a0\u2007\u2009\u202f\-\u2013\u2014]/.test(tok)) {
      // Weak context, a split token: a 3+3 code, or two groups split by a line break that make 6 to 8 digits ("7392\n01",
      // "1234\n5678"). Otherwise a first line of 4+ digits is the code by itself ("4821\n9"); anything else is skipped (review on #575).
      const groups = tok.split(/\D+/).filter(Boolean), digits = groups.join("").length, broken = /[\r\n]/.test(tok);
      const joined = SPLIT_CODE.test(tok) || (broken && groups.length === 2 && digits >= 6 && digits <= 8);
      if (!joined || MORE_GROUPS.test(after)) {
        const first = firstLine.replace(/\D/g, "");
        if (!broken || first.length < 4 || first !== firstLine || YEAR.test(first)) continue;
        tok = firstLine; after = sentence.slice(at + tok.length);
      }
    } else if (!isStrong && YEAR.test(tok)) continue;
    if (isStrong && YEAR.test(tok) && (carried && !contextEnds(sentence, STRONG).length || /\bin\s+$|\bsince\s+$|\bof\s+$/i.test(sentence.slice(0, at)))) continue;
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
// shares no code or password.
export function codeInChat(message: string, o: { userContent?: string; removed?: readonly string[]; codePending?: boolean; originalLength?: number } = {}): CodeInChat | null {
  const msg = String(message ?? "");
  if (!msg.trim() || o.codePending) return null;
  const removed = new Set<"code" | "password">();
  for (const r of o.removed ?? []) if (r === "code" || r === "password") removed.add(r);
  for (const m of msg.matchAll(MARKER)) removed.add(m[1] as "code" | "password");
  // Sentence by sentence, so "the portal is Workday. I graduated in 2024" never joins a code word to a number.
  const values: string[] = [];
  let prevNamedCode = false;
  // ...but not between two digit groups split by a line break and spaces ("739\n  201" is one token; Greptile on #568).
  const text = msg.split(/((?<=[.!?\n])(?![ \t\u00a0\u2007\u2009\u202f]*\d)\s+|(?<=[.!?]|[^\d\s]\n)\s+)/).map((part, i) => {
    if (i % 2) return part; // the space between two sentences
    let s = part;
    const carried = prevNamedCode && VALUE_LEAD.test(part);
    prevNamedCode = contextEnds(part, STRONG).length > 0;
    for (const h of tokensIn(part, carried).sort((a, b) => b.start - a.start)) { values.push(part.slice(h.start, h.end)); s = `${s.slice(0, h.start)}[code removed]${s.slice(h.end)}`; }
    return s;
  }).join("");
  if (values.length) removed.add("code");
  if (!removed.size) return null;
  let userContent = String(o.userContent ?? msg);
  for (const v of values) userContent = userContent.split(v).join("[code removed]");
  return { text, userContent, removed: [...removed], reply: (o.originalLength ?? msg.length) <= MAX_CHAT_LEN };
}

// redactionNote's own "never send passwords or codes in a message ..." sentence repeats CODE_IN_CHAT_REPLY; on this turn the
// note keeps only what was removed.
export function noteForCodeTurn(note: string | null): string | null {
  if (!note) return note;
  return note.replace(/\s*Never send passwords or codes in a message:[^.]*\.\s*/, " ").trim() || null;
}
