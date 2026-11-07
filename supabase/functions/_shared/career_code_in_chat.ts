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

import { normalizeChatText } from "./identity_redact.ts";
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
// Sentence boundaries, captured, so split() keeps the spaces between sentences: never between two digit groups split by a line
// break and spaces ("739\n  201" is one token; Greptile on #568).
const SENTENCE_SPLIT = /((?<=[.!?\n])(?![ \t\u00a0\u2007\u2009\u202f]*\d)\s+|(?<=[.!?]|[^\d\s]\n)\s+)/;
const DOTTED_MONEY_AFTER = /^\s*(?:eur|euros?|€|usd|gbp|£|chf|sek|nok|dkk|pln|brutto|netto|gross|net|base|salary|a\s+year|per\b|\/|[-\u2013\u2014][ \t]*\d|and\s+\d|to\s+\d)/i;
const DOTTED_MONEY_BEFORE = /(?:€|\$|£|\b(?:eur|usd|gbp|chf|offer(?:ed)?(?:\s+of)?|salary|pay|paid|base|range|between|from|req|requisition|job|ref|reference|order|ticket|case|id|no\.?|number|#)\s*)$/i;
const DOTTED_MONEY_NEAR = /\b(?:offers?|offered|salary|salaries|pay|paid|base|range|compensation|comp|bonus|rate|wage|income|eur|euros?|usd|gbp|chf)\b|[€$£]/i;
const DOTTED = /(?<![\d$€£.,\w-])\d{3}\.\d{3}(?![\d%\w-]|[.,:\/]\d)/g;
// A code split in two by a space, a line break (\n, \r\n or \r) or a dash ("739 201", "739-201", "739\n201"; Greptile on #566 and #567) after a weak cue: exactly 3+3 digits, and no more digit groups
// after it (so "415 555 1234" and "415-555-1234" stay phone numbers).
const SPLIT_CODE = /^\d{3}(?:[ \t\u00a0\u2007\u2009\u202f]{1,8}|[ \t\u00a0\u2007\u2009\u202f]{0,8}(?:\r\n|[\r\n\-\u2013\u2014])[ \t\u00a0\u2007\u2009\u202f]{0,8})\d{3}$/;
const MORE_GROUPS = /^(?:[ \t\u00a0\u2007\u2009\u202f]{1,8}|[ \t\u00a0\u2007\u2009\u202f]{0,8}(?:\r\n|[\r\n\-\u2013\u2014])[ \t\u00a0\u2007\u2009\u202f]{0,8})\d/;
// A sentence that hands over the value of a code the previous sentence named: "The portal sent a code. It is 739201."
const VALUE_LEAD = /^\s*(?:it(?:'s|\s+is|\s+was)|its|that(?:'s|\s+is|\s+was)|the\s+(?:code|number|password|pin)\s+(?:is|was)|here(?:'s|\s+it\s+is)|(?:it|they)\s+said|the\s+digits\s+(?:are|were))\b/i;

// A code label AFTER the token, in the same sentence, within about 40 characters and with only connector words between: "739201 is my
// verification code", "739 201 is the code Workday sent", "482913 - that's the login code" (r8 leak: a code typed before its label
// was stored as typed). Strong code words only; the label must close the clause or be followed by who sent it, so "1200 is the
// code count", "94107 is my zip code", "4500 is the error code" and "2024 is the year I got my code" stay numbers.
const CONNECT_AFTER = String.raw`[ \t,:]*(?:(?:[-\u2013\u2014]+|is|was|it'?s|it\s+is|that'?s|that\s+(?:is|was)|this\s+(?:is|was)|here'?s)[ \t,:]*)*`;
const LABEL_WORDS = String.raw`(?:(?:my|the|your|our|a)\s+)?(?:(?:one[- ]time|verification|verify|login|log[- ]?in|sign[- ]?in|security|2fa|mfa|otp|two[- ]factor|auth(?:entication)?)\s+)?(?:code|passcode|pass\s+code|otp|one[- ]time\s+(?:pass(?:code|word)?|pin))`;
// What may follow the label: the clause ends, or who sent it ("the code Workday sent", "the code from Greenhouse").
const LABEL_CLOSE = String.raw`(?=[ \t]*(?:$|[.,!?;:)\n\-\u2013\u2014])|[ \t]+(?:(?:that|which)\s+)?(?:[\w'-]+\s+){0,3}(?:sent|texted|emailed|gave|messaged|shared)\b|[ \t]+(?:from|for)\b|[ \t]+i\s+(?:got|received|was\s+sent)\b)`;
const LABEL_AFTER = new RegExp(String.raw`^(${CONNECT_AFTER})${LABEL_WORDS}${LABEL_CLOSE}`, "i");
const labelAfter = (after: string) => { const m = LABEL_AFTER.exec(after); return !!m && m[1].length <= 40; };
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
  if (!strong.length && !weak.length && !STRONG.test(sentence)) return [];
  STRONG.lastIndex = 0;
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
    // A label after the token counts as a strong word before it, for a plain run or a 3+3 split code only, and never a later
    // group of a spaced number ("1234" of "415 555 1234 is my code").
    const prevBefore = /\d[ \t\u00a0\u2007\u2009\u202f\-\u2013\u2014]*$/.test(sentence.slice(0, at));
    const labeled = !near(at, strong) && !prevBefore && (/^\d+$/.test(tok) || SPLIT_CODE.test(tok)) && !MORE_GROUPS.test(after) && !NAMED_BEFORE_CODE.test(sentence.slice(0, at)) && labelAfter(after);
    const isStrong = near(at, strong) || labeled;
    if (!isStrong && !near(at, weak)) continue;
    // Weak context: only a plain run of 4-8 digits that is not a year.
    // Weak context: a later group of a spaced run ("555 1234" in "415 555 1234") is part of a phone number or a date.
    // ...unless that earlier group is a full code itself, 6+ digits on its own line ("Workday sent me 739201\n482913": two codes;
    // phone groups have at most 4 digits).
    const prevGroup = /(\d+)(?:[ \t\u00a0\u2007\u2009\u202f]{1,8}|[ \t\u00a0\u2007\u2009\u202f]{0,8}(?:\r\n|[\r\n\-\u2013\u2014])[ \t\u00a0\u2007\u2009\u202f]{0,8})$/.exec(sentence.slice(0, at));
    const prevIsCode = !!prevGroup && prevGroup[1].length >= 6 && /[\r\n]/.test(sentence.slice(at - (prevGroup[0].length - prevGroup[1].length), at));
    if (!isStrong && prevGroup && !prevIsCode) continue;
    if (!isStrong && /[ \r\n\t\u00a0\u2007\u2009\u202f\-\u2013\u2014]/.test(tok)) {
      // Never money after a weak cue: "Workday sent me an offer of 120 000", "HR gave me 125 000 and equity" (a spaced
      // thousands figure), the same guards as the dotted form (review of d3fd6027).
      const pre = sentence.slice(0, at);
      // Only a money word right before it or a currency/unit right after: a money word elsewhere in the sentence is not enough,
      // since an offer portal sends codes ("Workday sent me 739 201 for the offer portal" is removed; review of 12de38d7).
      if (DOTTED_MONEY_AFTER.test(after) || DOTTED_MONEY_BEFORE.test(pre) || /^\s*(?:and|plus)\s+(?:equity|stock|bonus|benefits)\b/i.test(after)) continue;
      // Weak context, a split token: a 3+3 code, or two groups split by a line break that make 6 to 8 digits ("7392\n01",
      // "1234\n5678"). Otherwise a first line of 4+ digits is the code by itself ("4821\n9"); anything else is skipped (review on #575).
      const groups = tok.split(/\D+/).filter(Boolean), digits = groups.join("").length, broken = /[\r\n]/.test(tok);
      // Across a space or a dash only a 3+3 code joins, as on trunk: "2018-2022", "9123 4567" (an 8-digit phone) and "1200 1500"
      // stay. Across a line break, two groups of 6 to 8 digits join unless both are years ("2024\n2025"; review of f609ce7d).
      const years = groups.length === 2 && groups.every((g) => YEAR.test(g) || /^\d{2}$/.test(g)) && YEAR.test(groups[0]);
      const hhmm = (g: string) => g.length === 4 && Number(g.slice(0, 2)) <= 23 && Number(g.slice(2)) <= 59;
      const phoneOrTimes = groups.length === 2 && ((groups[0].length === 3 && groups[1].length === 4) || (hhmm(groups[0]) && hhmm(groups[1])));
      const joined = SPLIT_CODE.test(tok) || (broken && groups.length === 2 && digits >= 6 && digits <= 8 && !years && !phoneOrTimes);
      if (!joined || MORE_GROUPS.test(after)) {
        const first = firstLine.replace(/\D/g, "");
        if (!broken || years || phoneOrTimes || first.length < 4 || first !== firstLine || YEAR.test(first)) continue;
        tok = firstLine; after = sentence.slice(at + tok.length);
      }
    } else if (!isStrong && YEAR.test(tok)) continue;
    if (isStrong && YEAR.test(tok) && (carried && !contextEnds(sentence, STRONG).length || /\bin\s+$|\bsince\s+$|\bof\s+$/i.test(sentence.slice(0, at)))) continue;
    hits.push({ start: at, end: at + tok.length });
  }
  // A code in two 3-digit groups split by a period ("Verification code: 739.201", "Workday sent me 739.201"): never a decimal
  // ("3.85", "$120.50") or a longer dotted run (a version, an IP address); Greptile inventory, separator residuals.
  for (const m of sentence.matchAll(DOTTED)) {
    const at = m.index ?? 0, after = sentence.slice(at + m[0].length), before = sentence.slice(0, at);
    // Only after a code word or a hand-over ("sent me"), and never money ("120.000 EUR", "an offer of 120.000"), a range ("90.000 - 110.000") or a
    // named number ("req 739.201"): a European thousands figure has the same shape (review of f62e2033).
    const dotLabeled = !NAMED_BEFORE_CODE.test(before) && labelAfter(after);
    if ((!near(at, strong) && !near(at, weak) && !dotLabeled) || COUNT_AFTER.test(after) || DOTTED_MONEY_AFTER.test(after) || DOTTED_MONEY_BEFORE.test(before) || MORE_GROUPS.test(after) || /[-\u2013\u2014]\s*$/.test(before)
      || (!near(at, strong) && (DOTTED_MONEY_NEAR.test(before.slice(-80)) || DOTTED_MONEY_NEAR.test(after.slice(0, 30)) || /^\s*(?:and|to|or)\s+(?:\d|\[code removed\])/i.test(after)))) continue;
    if (hits.some((h) => at < h.end && at + m[0].length > h.start)) continue;
    hits.push({ start: at, end: at + m[0].length });
  }
  for (const m of sentence.matchAll(ALNUM)) {
    const at = m.index ?? 0, tok = m[0];
    if (UNIT_LIKE.test(tok) || (!near(at, strong) && (NAMED_BEFORE_CODE.test(sentence.slice(0, at)) || !labelAfter(sentence.slice(at + tok.length))))) continue;
    hits.push({ start: at, end: at + tok.length });
  }
  return hits;
}

// The turn's message after chat_input.ts (identity_redact.ts) took the labeled secrets out, and what it removed. Returns the
// text to store and answer with (any code-shaped token left next to a code word removed too), or null when the message
// shares no code or password.
export function codeInChat(message: string, o: { userContent?: string; removed?: readonly string[]; codePending?: boolean; originalLength?: number } = {}): CodeInChat | null {
  const msg = String(message ?? "");
  // While an employer's code is pending the tokens are still removed; only the fixed safety reply is left to the pending-code
  // turn (Greptile record 95).
  if (!msg.trim()) return null;
  const removed = new Set<"code" | "password">();
  for (const r of o.removed ?? []) if (r === "code" || r === "password") removed.add(r);
  for (const m of msg.matchAll(MARKER)) removed.add(m[1] as "code" | "password");
  // Sentence by sentence, so "the portal is Workday. I graduated in 2024" never joins a code word to a number.
  const values: string[] = [];
  let prevNamedCode = false;
  // ...but not between two digit groups split by a line break and spaces ("739\n  201" is one token; Greptile on #568).
  const text = msg.split(SENTENCE_SPLIT).map((part, i) => {
    if (i % 2) return part; // the space between two sentences
    let s = part;
    const carried = prevNamedCode && VALUE_LEAD.test(part);
    prevNamedCode = contextEnds(part, STRONG).length > 0;
    for (const h of tokensIn(part, carried).sort((a, b) => b.start - a.start)) { values.push(part.slice(h.start, h.end)); s = `${s.slice(0, h.start)}[code removed]${s.slice(h.end)}`; }
    return s;
  }).join("");
  // While a code is pending, the pending-code turn answers: nothing new removed here means nothing to report.
  if (o.codePending && !values.length) return null;
  if (values.length) removed.add("code");
  if (!removed.size) return null;
  let userContent = String(o.userContent ?? msg);
  for (const v of values) userContent = userContent.split(v).join("[code removed]");
  return { text, userContent, removed: [...removed], reply: !o.codePending && (o.originalLength ?? msg.length) <= MAX_CHAT_LEN };
}

// redactionNote's own "never send passwords or codes in a message ..." sentence repeats CODE_IN_CHAT_REPLY; on this turn the
// note keeps only what was removed.
export function noteForCodeTurn(note: string | null): string | null {
  if (!note) return note;
  return note.replace(/\s*Never send passwords or codes in a message:[^.]*\.\s*/, " ").trim() || null;
}

// A resume line's named codes are numbers to keep: identity_redact.ts NAMED_CODE's words (CPT, ICD, NAICS, department, cost,
// building ...) and a store code (review of 470e25d9).
const FILE_NAMED = /\b(?:zip|postal|post|area|country|promo|promotional|discount|coupon|referral|course|class|error|status|dial|tax|product|source|job|dress|invite|invitation|gift|reference|ref|airport|naics|sic|cpt|icd|sort|swift|bank|routing|color|colour|style|item|sku|morse|qr|bar|req|requisition|position|posting|role|department|dept|cost|budget|project|program|module|unit|soc|fips|vendor|supplier|ticket|order|voucher|offer|event|building|store|zip\+4)[\s-]+(?:codes?|pins?)\b[^\n]{0,24}$/i;
// Privacy first for a FILE (owner decision on 2de155f0): text alone cannot always tell a handed-over code from a look-alike
// ("2FA: AB12CD" / "MFA: SC300", "Verification code: K7X9P2" / "Insurance verification code: VB102", "OTP-4821"), so a
// plausible code refuses the upload and the reply names only its line and kind, never the line. Resume lines that are clearly
// not a code stay: a count noun after the number, a year or range, trunk's named codes, money after "gave/sent me" with a
// non-login purpose, and a topic word earlier on the line.
export function fileSharesCode(text: string): boolean {
  return fileCodeLines(text).length > 0;
}
// The file check reads each line on its own (reviews of 63e324a0 and 5df04035). Privacy first: a code-shaped token on a line
// with a strong code word anywhere on it (code, OTP, token, verification, 2FA, sign in, SMS, a hiring system or sign-in service
// ...) is a suspected code, and so is one next to a weaker hand-over word (sent, got, received, told, says, enter ...), unless
// the token has a safe shape: a noun after it or a plural label before it (a count), a year, range or date, money, a phone
// number, an ID label, or a named label on the list ("CPT codes:", "change code:", "exam code:"). A code split across a line
// break, or carried after a line that ends in a hand-over, is joined with the next line.
const LINE_TOKEN = /(?<![\w$€£.,\/@]|(?<![A-Za-z])[a-z]-|[\w]{2}-|\d-)(\d{1,4}(?:[ ,._\/·-]\d{1,4}){1,5}(?![\d\w])|\d{4,8}(?![\d])|(?=[A-Za-z0-9]{5,10}(?![\w]))(?=(?:[A-Za-z]*\d){2})(?=(?:\d*[A-Za-z]){2})[A-Za-z0-9]{5,10}|(?=[A-Za-z]{0,3}\d)[A-Za-z0-9]{2,4}(?:[ -](?=[A-Za-z]{0,3}\d)[A-Za-z0-9]{2,4}){1,3}(?![\w]))(?![\w%]|[.,]\d)/g;
const SENDERS = String.raw`workday|greenhouse|lever|icims|taleo|smartrecruiters|jobvite|ashby|bamboohr|successfactors|indeed|linkedin|okta|duo|microsoft|google|apple|amazon|recruiter|portal`;
const STRONG_CODE = /\b(?:codes?|otps?|passcodes?|pins?|tokens?|verification|verify|2fa|mfa|two[- ]?(?:factor|step)|2[- ]?step|sign[- ]?in|log[- ]?in|login|password|authenticator|one[- ]?time|onetime|single[- ]?use|sms|texted|text(?:\s+message)?|digits|to\s+my\s+(?:phone|cell|mobile|email|inbox|number))\b/i;
const STRONG_SENDER = new RegExp(String.raw`\b(?:${SENDERS})\b`, "i");
const CTX = String.raw`(?:codes?|passcodes?|pins?|otp|2fa|mfa|one[- ]time|verification|verify|sign[- ]?in|log[- ]?in|login|sms|text(?:ed)?|sent|send|sending|emailed|messaged|dm'?d|gave|got|received|told|shared|issued|provided|generated|assigned|says|said|enter|type|input|use|using|it'?s|it\s+is|number\s+is|following|${SENDERS})`;
const LINK = String.raw`(?:[\s:,#=|~_.\-–—→>"'‘’“”\[\]()<>*\x60]|\b(?:me|my|the|a|an|your|our|this|that|is|was|are|it|its|for|from|said|says|via|by|as|in|came|arrived|new|of|just|here|below|this|morning|afternoon|evening|tonight|today|yesterday|earlier|again|now|over|along|with|to|following)\b|\b(?:from|for)\s+(?:the\s+)?[A-Z][\w.'-]*|\b(?:for|from)\s+(?:the|my|your|our)\s+[a-z]+)`;
const LEFT_CTX = new RegExp(String.raw`\b${CTX}(?:${LINK})*$`, "i");
const CTX_WORDS = String.raw`(?:codes?|passcodes?|pins?|otp|2fa|mfa|one[- ]time|verification|verify|sign[- ]?in|log[- ]?in|login|sms|text(?:ed)?|sent|send|emailed|messaged|told|shared|issued|says|said)`;
const RIGHT_CTX = new RegExp(String.raw`^(?:[\s:,"'\])>-]|\b(?:is|was|my|the|a|your|our|this|that|via|by|sent|from|for)\b|\b[A-Z][\w.'-]*\b)*(?:\b${CTX_WORDS}\b)|^\s*(?:sent\s+)?(?:from|by|via)\s+(?:the\s+)?(?:${SENDERS})\b(?!\s+[a-z]{2,})`, "i");
const FROM_SENDER = new RegExp(String.raw`^\s*from\s+(?:the\s+)?(?:${SENDERS})\b(?!\s+[a-z]{3,})`, "i");
// The first word after the number: a function or time word keeps the phrase going; any other word is a count noun.
const AFTER_FUNC = /^(?:for|from|to|on|in|at|today|tonight|yesterday|this|that|just|now|earlier|already|again|also|too|twice|once|recently|later|soon|please|thanks|thank|and|or|but|so|which|can|could|would|will|if|when|by|via|as|here|there|it|is|was|are|my|the|a|an|asap|immediately|quickly|back|ago|sent)$/i;
// A sign-in purpose: a login word that ends its phrase ("for the portal", "to finish my application"), or a delivery target
// ("to my phone", "by text"); "for the portal redesign" or "the application rollout" is a project, not a sign-in.
const SIGNIN_PURPOSE = /\b(?:(?:for|on|into|in|at)\s+(?:the|my|your|their)?\s*(?:[a-z]+\s+){0,2}|to\s+(?:the|my|your|their)?\s*)(?:portal|site|website|login|log[- ]?in|sign[- ]?in|account|app|application|form|page|profile|password|verification)\b(?=\s*(?:$|[.,;:!?)]|\s(?:and|so|to|please|now|today|thanks|again)\b))|\bto\s+(?:finish|complete|continue|access|open|unlock|confirm|submit)\s+(?:my|the|your)\s+(?:portal|site|login|account|app|application|form|profile)\b(?=\s*(?:$|[.,;:!?)]|\s(?:and|so|please|now|today|thanks|again)\b))|\b(?:phone|cell|mobile|inbox|e-?mail|text|sms|log\s+in|sign\s+in|verify|enter\s+it)\b/i;
// Named labels whose numbers are kept (identity_redact.ts NAMED_CODE's words and resume labels): "CPT codes: 99213",
// "change code: CHG0012345", "exam code: AZ104". Anything else before "code" is read as a code's own label.
const NAMED_LABEL = /^(?:zip|postal|post|area|country|promo|promotional|discount|coupon|referral|course|class|error|status|dial|tax|product|source|job|dress|gift|reference|ref|airport|naics|sic|cpt|icd|hcpcs|ndc|drg|sort|swift|routing|color|colour|style|item|sku|morse|qr|bar|req|requisition|position|posting|role|department|dept|cost|budget|project|program|module|unit|soc|fips|vendor|supplier|ticket|order|voucher|offer|building|store|exam|certification|cert|change|charge|engagement|release|config|configuration|policy|sop|servicenow|wbs|award|clearance|qualification|lot|batch|part|model|taxonomy|denial|adjustment|remark|activity|transaction|t|school|branch|hs|revenue|gl|cage|hazmat|machine|billing|diagnosis|procedure|location|site|plant|warehouse|accounting|campaign|tracking|hex|paint|booking|reservation|specialty|speciality|subject|flight|room|seat|gate|afsc|mos|nec|rate|rating|grade|series|occupation|occupational|duty|uic|ein|cip|onet|o\*net|isco|esco|noc|anzsco|fund|task|teacher|lesson|engine|fault|diagnostic|alarm|ward|trouble|dtc|obd|nmc|nhs|gmc|hcpc|harmonized|route|carrier|scac|icao|iata|station|airline|port|hts|expense|labor|labour|payroll|union|district|provider|facility|tariff|commodity|ceeb|un)$/i;
const COUNT_LABEL2 = /\b(?:codes|pins|tokens|passcodes|otps|attempts|logins|sign[- ]?ins|resets)\s+(?:[a-z]+\s+){0,2}(?:issued|reviewed|delivered|sent|reset|rotated|blocked|processed|handled|generated|verified|validated|revoked|expired|enrolled|migrated|served|per\s+\w+)(?:\s+per\s+\w+)?\s*[:\-–—]\s*$|\b(?:codes|pins|otps|passcodes)\s+(?:issued|reviewed|delivered|sent|reset|rotated|blocked)\b[^:]{0,20}[:\-]\s*$|\b(?:adoption|usage|growth|enrollment|enrolment|coverage|uptime|throughput|capacity|traffic|volume|count|total|reach|downloads|installs|users)\s*[:\-–—]\s*$/i;
const COUNT_LABEL = /\b(?:(?!(?:codes|pins|tokens|passcodes|otps|digits)\b|sms\s*[:\-\u2013\u2014]|(?:this|his|is|was|has|its|yes|us|plus|bus|less|class|process|address|access|success|business|status|bonus|campus|focus|alias|bias|chaos|series|news|ss)\b)[a-z]{2,}s|total|volume|count|sales|revenue|traffic|headcount|budget)\s*(?:per\s+\w+\s*)?(?:sent|received|processed|handled|delivered|closed|resolved|served|shipped|made|generated|raised|onboarded|hired|managed)?\s*(?:per\s+\w+\s*)?[:\-–—]\s*$/i;
const ID_LABEL = /\b(?:employee|student|member|badge|staff|license|licence|npi|dea|candidate|requisition|req|job|case|claim|policy|patient|customer|order|invoice|po|cert|certificate|certification|credential|exam)\s*(?:id|no\.?|number|#)\s*[:#]?\s*$/i;
const MONEY_WORDS = /\b(?:credits?|funding|funds|grants?|budget|seed|investment|donations?|revenue|sales|savings|profit|arr|mrr|salary|bonus|stipend|scholarship|award|prize|raise|dollars|usd|eur|gbp)\b/i;
const PHONE = /(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}/g;
const DATE = /\b(\d{1,2})[\/.-](\d{1,2})[\/.-]\d{2,4}\b|\b(?:19|20)\d\d[\/.-](\d{1,2})[\/.-](\d{1,2})\b/;
// A month and year ("05/2025", "2023-06", "6.2021"), or a range of them, possibly open ("05/2025 - present").
const MY = String.raw`(?:(?:0?[1-9]|1[0-2])[\/.\-](?:19|20)\d\d|(?:19|20)\d\d[\/.\-](?:0?[1-9]|1[0-2]))`;
const MONTH_YEAR = new RegExp(String.raw`^${MY}(?:\s?[-\u2013\u2014]\s?(?:${MY}|present|now|current|today))?$`, "i");
// A real calendar date: a month (1-12) and a day (1-31) in either order ("12/34/56" is not one).
const isDate = (s: string) => {
  const m = DATE.exec(s);
  if (!m) return false;
  const [a, b] = (m[1] ? [m[1], m[2]] : [m[3], m[4]]).map(Number);
  return a >= 1 && b >= 1 && ((a <= 12 && b <= 31) || (b <= 12 && a <= 31));
};
// A code's own label right before it ("Verification code 739201", "Your code is", "OTP:"): a following word, a range dash or
// a date shape does not make it a count, a range or a date.
const DIRECT = /\b(?:code|otp|passcode|pin|token|verification|2fa|mfa)\s*(?:(?:is|=)\s*)?[:#=|\-\u2013\u2014]?\s*$/i;
const COUNT_AFTER_LABEL = /^(?!(?:expires|is|was|this|has|does|goes|works|stays|lasts|remains|always|thanks|minutes|seconds|digits|its|yes|us|plus)$)(?:[a-z]{3,}s|sq|ft|loc|sloc|kloc|rps|qps|tps|ms|gb|tb|mb|kb|k|m|hrs?|mins?)$/i;
// accents off, zero-width characters as a space, and Cyrillic or Greek letters that look Latin as Latin ("Сode" is "Code").
const LOOKALIKE: Record<string, string> = { "κ": "k", "ε": "e", "ι": "i", "υ": "u", "χ": "x", "а": "a", "в": "b", "с": "c", "е": "e", "һ": "h", "і": "i", "ј": "j", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "ѕ": "s", "т": "t", "у": "y", "х": "x", "ԁ": "d", "ԛ": "q", "ԝ": "w",
  "А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H", "І": "I", "Ј": "J", "К": "K", "М": "M", "О": "O", "Р": "P", "Ѕ": "S", "Т": "T", "У": "Y", "Х": "X",
  "α": "a", "ο": "o", "ρ": "p", "τ": "t", "ν": "v", "Α": "A", "Β": "B", "Ε": "E", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Χ": "X", "Υ": "Y", "Ζ": "Z" };
// The zero of each decimal-digit block (every Unicode Nd run is a whole number of 0-9 blocks), built once on first use.
let ND_ZEROS: number[] | null = null;
function digitValue(cp: number): number {
  if (!ND_ZEROS) {
    ND_ZEROS = [];
    for (let c = 0x30; c <= 0x1ffff; c++) {
      if (!/\p{Nd}/u.test(String.fromCodePoint(c))) continue;
      let e = c; while (/\p{Nd}/u.test(String.fromCodePoint(e + 1))) e++;
      for (let z = c; z <= e; z += 10) ND_ZEROS.push(z);
      c = e;
    }
  }
  let lo = 0, hi = ND_ZEROS.length - 1, z = ND_ZEROS[0];
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (ND_ZEROS[mid] <= cp) { z = ND_ZEROS[mid]; lo = mid + 1; } else hi = mid - 1; }
  return cp - z;
}
// The file's text for the check only (never stored or shown): compatibility forms, any script's digits as ASCII, accents off,
// zero-width characters removed, and Cyrillic or Greek letters that look Latin as Latin ("Сode" is "Code").
export function fileText(text: unknown): string {
  return String(text ?? "").replace(/\r\n?/g, "\n").normalize("NFKD").replace(/\p{M}/gu, "").replace(/[\p{Cf}ㅤᅟᅠﾠ᠎͏]/gu, "")
    .replace(/[❶-➓⓫-⓾]/g, (c) => { const n = c.codePointAt(0)!; return String(n >= 0x24eb && n <= 0x24f4 ? n - 0x24eb + 11 : n >= 0x24f5 ? n - 0x24f5 + 1 : (n - 0x2776) % 10 + 1); })
    .replace(/\p{Nd}/gu, (d) => d <= "9" && d >= "0" ? d : String(digitValue(d.codePointAt(0)!)))
    .replace(/[\u0370-\u03ff\u0400-\u04ff\u0500-\u052f]/g, (c) => LOOKALIKE[c.toLowerCase()] ?? c.toLowerCase());
}
// After a code's own label (code, OTP, PIN, passcode, token, verification, 2FA, MFA; not a named label such as "tariff code"),
// the value that follows it, past connectors, brackets and quotes, is a code unless it has a safe shape: years, a real date with
// a four-digit year, a standard ("ISO-27001", "NIST-800-53"), money, a count noun after a figure that is not code-length, or a
// credential word after a certification ("OTP: AZ500 certified"). Privacy first: anything else refuses the file.
const TAIL_LABEL = /(?:^|[^\w])(?:([\w'-]+)[ -]+)?(codes?|otps?|passcodes?|pins?|tokens?|verification|2fa|mfa)(?![\w])/gi;
const TAIL_LEAD = /^(?:[\s:#=|~*>→–—"'‘’“”()\[\]{}<>-]|\b(?:is|was|are|as)\b)*/i;
const TAIL_VALUE = /^[A-Za-z0-9]+(?:(?:\s?[-–—]\s?|[.\/·_]|(?<=\d)\s(?=\d))[A-Za-z0-9]+)*/;
const STANDARD = /^(?:iso|iec|nist|soc|erc|eip|rfc|pci|hipaa|itil|cmmi|ieee|ansi|sp|fips|astm|din|en|bs|mil|nfpa|osha|ul|csa|cwe|cve|owasp|hl7|icd|cpt|dsm|iata|icao)$/i;
const COUNT_NOUNS = /^(?:users?|customers?|clients?|accounts|devices|builds?|lines|loc|sloc|kloc|hours?|hrs?|days|weeks|months|years|modules|microservices|services|apps|applications|tickets|cases|claims|charts|records|files|pages|tests|prs|pull|commits|repos|repositories|deployments|releases|employees|people|staff|students|patients|members|sites|stores|locations|servers|nodes|endpoints|apis|requests|rps|qps|tps|transactions|orders|sales|calls|merchants|partners|vendors|projects|resets|doors|sq|ft|ms|gb|tb|mb|kb|k|m|per|percent|items|products|skus|units|contracts|reviews|issues|bugs|incidents|alerts|rules|policies|controls|seats|licenses|beds|clinics|hospitals|schools|branches|regions|countries|languages|teams|engineers|developers|agents|installs|downloads|visits|views|sessions|events|jobs|roles|hires|candidates|applicants|interviews|inmails|emails|resumes|profiles|leads|referrals|offers|invites|invitations|documents|reports|laptops|patents|hits|matches|connections|followers|impressions|clicks|signups|registrations|enrollments|new|more|total|additional|extra|questions|invoices|packages|newsletters|signatures|reminders|relocation|bonus|stipend|credits|points|miles|samples|surveys|responses|tasks|assignments|shifts|cards|boxes|units)$/i;
const CREDENTIAL_AFTER = /^(?:certified|certification|certificate|exam|exams|course|courses|badge|credential|holder|compliant|compliance|standard|contracts?|tokens?|rev|revision|study|practice|vouchers?|results?|materials|prep|training|labs?)$/i;
// A hand-over to the person: a sender, "sent me", "gave me" ..., or a code's own label right before the figure.
const handedTo = (before: string, sender: boolean) => sender || /\b(?:sent|send|gave|texted|emailed|messaged|dm'?d|got|received|told|shared|issued)\s+(?:me|us)\b/i.test(before) || DIRECT.test(before);
function labelTailAt(line: string, safe: number[][] = []): number {
  for (const m of line.matchAll(TAIL_LABEL)) {
    if (m[1] && NAMED_LABEL.test(m[1])) continue;
    const start = (m.index ?? 0) + m[0].length, rest = line.slice(start), lead = TAIL_LEAD.exec(rest)?.[0] ?? "";
    const v = TAIL_VALUE.exec(rest.slice(lead.length));
    if (!v) continue;
    // The value ends before its first word ("K7X9P2 - expires" is "K7X9P2"); a value that starts with a word is a phrase.
    const parts = v[0].split(/(\s?[-–—]\s?|[.\/·_]|\s)/);
    let val = "";
    for (let k = 0; k < parts.length; k += 2) {
      if (/^[A-Za-z]{5,}$/.test(parts[k]) && !/^(?:present|current|today)$/i.test(parts[k])) break;
      val += (k ? parts[k - 1] : "") + parts[k];
    }
    if (!val || (/^[A-Za-z]{4,}$/.test(parts[0]) && !STANDARD.test(parts[0]))) continue;
    const vStart = start + lead.length, flat = val.replace(/[^A-Za-z0-9]/g, ""), digits = flat.replace(/\D/g, "").length, letters = flat.length - digits;
    if (!(flat.length >= 4 && (digits >= 4 || (digits >= 2 && letters >= 2)))) continue;
    const groups = val.split(/\s?[-–—]\s?|[.\/·_]|\s/).filter(Boolean);
    const after = line.slice(vStart + val.length), next = /^[\s:,.)\]"'’”]*([A-Za-z%][A-Za-z']*|%)/.exec(after)?.[1] ?? "";
    const rising = groups.length === 2 && groups.every((g) => /^\d{3,}$/.test(g)) && groups[0].length === groups[1].length && Number(groups[1]) > Number(groups[0]);
    const codeLength = /^\d{6,8}$/.test(flat) && letters === 0 && !rising;
    const safeShape = (/\bpin\s*code\s*[:#-]?\s*$/i.test(line.slice(0, vStart)) && /^[1-8]\d{5}$/.test(val) && !/\b(?:verification|verify|otp|login|sign[- ]?in|sms|one[- ]time|2fa|mfa|bank|atm|card)\b/i.test(line)) // an Indian postal PIN code
      || (/\bkode\s+pos\s*[:#-]?\s*$/i.test(line.slice(0, vStart)) && /^\d{5}$/.test(val)) // an Indonesian postal code
      || (/\b(?:icd|cpt|hcpcs|obd|dtc|fault|trouble|diagnostic)\b/i.test(line) && /^[A-Z]\d{2,4}(?:\.\d{1,4})?$/.test(val) && !STRONG_LABEL.test(line.slice(0, vStart))) // a medical or fault code
      || groups.every((g) => /^(?:19|20)\d\d$/.test(g)) // years
      || (groups.length === 2 && /^(?:19|20)\d\d$/.test(groups[0]) && /^(?:\d\d|present|now|current|today)$/i.test(groups[1]))
      || (/(?:19|20)\d\d/.test(val) && isDate(val.replace(/\s/g, "").replace(/[–—]/g, "-"))) // a real date
      || STANDARD.test(groups[0]) // "ISO-27001", "NIST-800-53"
      || /[$€£]\s*$/.test(line.slice(0, vStart)) || /^(?:%|k|usd|eur|gbp|dollars|euros)$/i.test(next) // money
      || (letters === 0 && !codeLength && COUNT_NOUNS.test(next)) // a count ("Code: 1200 builds")
      || (letters > 0 && CREDENTIAL_AFTER.test(next)); // a certification ("OTP: AZ500 certified")
    if (!safeShape) return vStart;
    safe.push([vStart, vStart + val.length]);
  }
  return -1;
}
// After a code's own label, a range stays only as two equal-length numbers that rise before a count ("Code: 1200 - 1500 builds").
function risingRange(line: string, at: number): boolean {
  const m = /(\d{3,})\s*[-\u2013\u2014]\s*(\d{3,})[\s:,.)]*([A-Za-z][A-Za-z']*)/.exec(line.slice(Math.max(0, line.lastIndexOf(" ", Math.max(0, at - 4)))));
  return !!m && m[1].length === m[2].length && Number(m[2]) > Number(m[1]) && COUNT_AFTER_LABEL.test(m[3]);
}
// The 1-based line numbers of the text read from the file that hold a suspected code (each once, in order).
export function fileCodeLines(text: string): number[] {
  // A profile link's path (a LinkedIn or GitHub handle such as "linkedin.com/in/wei-zhang-4b7a19120") is the link, not a value:
  // masked, keeping the line's length; a query string ("?code=482913") is still read.
  const PROFILE = /\b(?:https?:\/\/)?(?:[\w-]+\.)?(?:linkedin\.com\/(?:in|pub|company)|github\.com|gitlab\.com|behance\.net|dribbble\.com|medium\.com|x\.com|twitter\.com|stackoverflow\.com\/users|orcid\.org|kaggle\.com|scholar\.google\.com\/citations|researchgate\.net\/profile|bitbucket\.org|codepen\.io|leetcode\.com\/(?:u\/)?|hackerrank\.com\/(?:profile\/)?)\/?[^\s?#|,;)]*/gi;
  const lines = normalizeChatText(fileText(text)).split("\n").map((l) => l.replace(PROFILE, (m) => " ".repeat(m.length))), hits: number[] = [];
  const unbullet = (s: string) => s.replace(/^\s*(?:[-*•▪●>]|\d+[.)])\s+/, "");
  lines.forEach((raw, i) => {
    if (lineCodeAt(raw) >= 0) { hits.push(i + 1); return; }
    // A value alone on its line, and a line within three text lines after one that ends in a hand-over ("Code:", "Workday
    // sent me", "Verification code follows"), are judged by the gate whatever their own words are.
    if (standaloneCodeAt(raw) >= 0) { hits.push(i + 1); return; }
    const prevText = lines.slice(Math.max(0, i - 6), i).filter((l) => l.trim()).slice(-3);
    if (prevText.some((l) => GATE_END.test(l)) && gateCodeAt(raw, true) >= 0) { hits.push(i + 1); return; }
    // A line that ends in a code word, a sender or a hand-over verb ("Workday sent me", "My phone shows", "Code:") is judged
    // with the next line that holds text, past blank lines, by the strict rule ("Workday sent me" / "«064-448»").
    if (GATE_END.test(raw)) {
      const nextText = lines.slice(i + 1, i + 6).find((l) => l.trim());
      if (nextText !== undefined) {
        const join = `${raw.trimEnd()} ${unbullet(nextText).trim()}`;
        if (gateCodeAt(join, true) >= raw.trimEnd().length) { hits.push(i + 1); return; }
      }
    }
    // The next lines that hold text (up to two blank lines skipped); a line of punctuation alone (":") joins the one after it.
    const rest = lines.slice(i + 1, i + 6).map(unbullet).filter((l) => l.trim()).slice(0, 3);
    if (rest.length > 1 && /^[\s:#=|\-\u2013\u2014.]+$/.test(rest[0])) rest.splice(0, 2, `${rest[0].trim()} ${rest[1].trim()}`);
    const n1 = rest[0] ?? "", n2 = rest[1] ?? "";
    if (!n1.trim() || !lines.slice(i + 1, i + 6).some((l) => l.trim())) return;
    const ctxEnd = LEFT_CTX.test(raw.replace(/\s*$/, " ")) || /\b(?:codes?|otps?|passcodes?|pins?|tokens?|verification|2fa|mfa)[\s:#=|\-\u2013\u2014>"'(\[]*$/i.test(raw), digitEnd = /(?:^|\D)\d{2,4}\s*$/.test(raw) && /^\d/.test(n1.trim()); // a split code continues with digits
    const rightNext = /^\s*(?:is|was|are|=|-|\u2013|\u2014|\()/i.test(n1) && RIGHT_CTX.test(" " + n1.trim());
    if (!ctxEnd && !digitEnd && !rightNext) return;
    // The code or its hand-over continues on the next line or two ("Workday sent me" / "739 201", "739" / "201",
    // "739201" / "is my verification code"): judged together, counted on this line when the code starts within it or the
    // next line's first token.
    const join = `${raw.trimEnd()} ${n1.trim()}${/^\d{2,4}$/.test(n1.trim()) && /^\d{2,4}\b/.test(n2.trim()) ? " " + n2.trim() : ""}`;
    const at = lineCodeAt(join), len = raw.trimEnd().length;
    // A split code starts on this line; a carried code is among the next line's first words; a code before "is my ... code"
    // is on this line.
    const ok = at >= 0 && ((digitEnd || rightNext) && at < len || ctxEnd && at <= len + 1 + (/^["'\[({<\u201c\u2018]*(?:\S+\s+){0,2}/.exec(n1.trim())?.[0].length ?? 0));
    if (ok) hits.push(i + 1);
  });
  return hits;
}
// The file gate (owner decisions on 2de155f0 and a7b76b6f: privacy first, fail closed, structural). Two keys on each line:
// CONTEXT, a code word, sign-in service or hand-over phrase from a finite lexicon (English and the main resume languages) on the
// line itself or ending one of the three text lines before it; and SHAPE, a code-shaped value after normalisation (every
// invisible format character dropped, wrappers removed, short separators joined). A value with both keys refuses the file
// unless it has a strict, context-independent safe shape (years, quarters, dates, times, phones, postal codes, money,
// percentages, versions, certification exam codes, standards, DOIs, patents, tickets, counts, named labels). A value that
// stands alone on its line refuses whatever surrounds it. The reply names only the line and the kind.
const CTX_LATIN = String.raw`(?!(?:bar|de|en|op|uni|geo|zip|post|trans|source|qr|area|dress|pass|zero|low|no|hard|en)code)\p{L}{0,16}(?:codi|codul|kod\p{L}{0,4}|kood\p{L}{0,3}|koodi\p{L}{0,4}|ko[d\u00f0]i|ikhodi|cod\s+dilysu|verifikasiekode|bekreftelseskode|code(?=\s*(?:[:=]|is|es|est|ist|er|ir|on|je|är|lautet)\b))(?![\p{L}])|has(?:l|\u0142)o(?:\s+jednorazowe)?|nambari\s+(?:yako|ya\s+siri)|mat\s+khau(?:\s+mot\s+lan)?|ma\s*:|szamkod|codes?|otps?|passcodes?|passkeys?|pins?|tokens?|verification|verify|verified|2fa|mfa|totp|hotp|two[- ]?(?:factor|step)|2[- ]?step|sign[- ]?in|log[- ]?in|login|authenticator|one[- ]?time|single[- ]?use|sms|texted|text(?:\s+message)?|security\s+key|secret(?:\s+key)?|key\s*[:=]|steam\s+guard|magic\s+link|backup\s+codes?|recovery\s+codes?|sent|send|emailed|messaged|gave|got|received|shared|forwarded|pinged|dm'?d|shows|showed|displays|displayed|use|enter|type|paste|key\s+in|try|reply\s+with|respond\s+with|confirm\s+with|here'?s|here\s+is|it'?s|mine(?:\s+is)?\s*:?|number\s*:|(?:the\s+)?number\s+(?:is|was)|digits|follows|below|guard|c[oó]digo|clave|contrase[nñ]a|verificaci[oó]n|acceso|senha|verifica[cç][aã]o|v[eé]rification|mot\s+de\s+passe|codice|best[aä]tigungscode|sicherheitscode|kennwort|passwort|tan|kode|verifikasi|sandi|kod|weryfikacyjny|verificatiecode|bekr[aä]ftelsekod|dogrulama|m[aã]\s+x[aá]c|код|пароль|подтверждени\p{L}*|رمز|التحقق|\p{L}{0,14}(?:inlog|inloggnings|verifierings|anmelde|verifizierungs|bestatigungs|bekraeftelses|bekræftelses|engangs|vahvistus|kertakayttoinen\s+|ellenorzo\s+|dogrulama\s+|giris\s+|onay\s+|engångs)(?:code|kod|kode|koodi|kodu)\p{L}{0,6}|kod(?:u\p{L}{0,4}|en|er|i|ot)|koodi\p{L}{0,4}|codul|cod\s+de\s+verificare|nambari\s+ya\s+siri|kodi\s+yako|einmalcode|einmalkennwort|zugangscode|engangskod|engangskode|kertakoodi|vahvistuskoodi|toegangscode|kod\s+dostepu|jednorazowy|codice\s+d'?accesso|code\s+d'?acces|code\s+unique|codigo\s+unico|parola|sifre|chase|authy|steam|1password|lastpass|bitwarden|signal|whatsapp|telegram|paypal|venmo|stripe|twilio|yubikey|slack|discord|teams|zoom|the\s+app|bank|${SENDERS}`;
const CTX_OTHER_WORDS = ["验证码", "校验码", "认证码", "动态码", "验证", "密码", "驗證碼", "確認碼", "認証コード", "確認コード", "認証番号", "ワンタイム", "パスワード", "인증번호", "인증 코드", "비밀번호", "코드", "सत्यापन कोड", "कोड", "ओटीपी", "код", "код подтверждения", "пароль", "رمز التحقق", "رمز", "کد", "รหัส", "קוד", "κωδικός", "mã xác minh", "mã xác nhận", "mã otp", "mã của bạn", "mã đăng nhập", "登录码", "登錄碼", "动态口令", "口令", "ログインコード", "認証番号", "κωδικός", "κωδικός επαλήθευσης", "κωδικοσ", "ওটিপি", "কোড", "যাচাইকরণ কোড", "کوڈ", "او ٹی پی", "کد تایید", "รหัสยืนยัน", "รหัส otp"];
// The lexicon in the form the check reads (accents off, look-alike letters mapped, Hangul and kana decomposed), so a label is
// found in the normalised file text.
const lexForm = (w: string) => w.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[\u0370-\u03ff\u0400-\u04ff\u0500-\u052f]/g, (c) => LOOKALIKE[c.toLowerCase()] ?? c.toLowerCase()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*");
const CTX_CJK = CTX_OTHER_WORDS.map(lexForm).join("|");
const CTX_CJK_N = CTX_CJK;
export const GATE_CTX = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${CTX_LATIN})(?![\p{L}])|${CTX_CJK}`, "iu");
// A phrase that hands over what follows when it ends a line ("Workday sent me", "Verification code follows", "Code:").
export const GATE_END = new RegExp(String.raw`(?:(?<![\p{L}\p{N}])(?:codes?|otps?|passcodes?|passkeys?|pins?|tokens?|verification|2fa|mfa|totp|hotp|sms|authenticator|secret|key|c[oó]digo|clave|senha|codice|kode|kod|tan|sent\s+(?:me|us)|texted\s+(?:me|us)|emailed\s+(?:me|us)|messaged\s+(?:me|us)|gave\s+(?:me|us)|shared|forwarded|pinged\s+(?:me|us)|dm'?d\s+(?:me|us)|shows|displays|enter|type|paste|use|reply\s+with|here'?s|here\s+is|it'?s|mine(?:\s+is)?|follows|below|bestätigungscode|sicherheitscode|код|رمز)|${CTX_CJK})[\s\p{P}\p{S}]*$`, "iu");
const STRICT_VERBS = /^(?:opens|unlocks|verifies|expires|works|logs|signs|grants|gives|lets|gets|allows|activates|confirms|completes|authorizes|authenticates|validates|enables|accesses|is|was|has|does|goes|remains|stays|lasts|its|this|thanks|yes|us|plus|minutes|seconds|digits|texts|logins|messages|sms)$/i;
// Separators that join a value's groups: one or two of - – — . , / · : # + \ ; * = ~ |, optionally spaced, or one or two
// spaces between digit groups.
const GATE_SEP = String.raw`(?:\s?[-–—]{1,2}\s?|[.,\/·:#+\x5c;*=~|]{1,2}(?!\s)|(?<=\d)\s{1,2}(?=\d))`;
const GATE_SEP_LOOSE = String.raw`(?:${GATE_SEP}|(?<=[A-Z0-9])\s{1,2}(?=[A-Z0-9]))`;
// A code's own label right before the value (any lexicon language).
const GATE_DIRECT = new RegExp(String.raw`(?:(?<![\p{L}\p{N}])(?:(?!(?:bar|de|en|op|uni|geo|zip|post|trans|source|qr|area|dress|pass|zero|low|no|hard|en)code)\p{L}{0,16}(?:codi|codul|kod\p{L}{0,4}|kood\p{L}{0,3}|koodi\p{L}{0,4}|ko[d\u00f0]i|ikhodi|cod\s+dilysu|verifikasiekode|bekreftelseskode|code(?=\s*(?:[:=]|is|es|est|ist|er|ir|on|je|är|lautet)\b))(?![\p{L}])|has(?:l|\u0142)o(?:\s+jednorazowe)?|nambari\s+(?:yako|ya\s+siri)|mat\s+khau(?:\s+mot\s+lan)?|ma\s*:|szamkod|\p{L}{0,14}(?:inlog|inloggnings|verifierings|anmelde|verifizierungs|bestatigungs|bekraeftelses|bekræftelses|engangs|vahvistus|engångs)(?:code|kod|kode|koodi|kodu)\p{L}{0,6}|(?:kertakayttoinen|ellenorzo|dogrulama|giris|onay)\s+kod\p{L}{0,6}|kod(?:u\p{L}{0,4}|en|er|i|ot)|koodi\p{L}{0,4}|codul(?:\s+\p{L}+){0,3}|cod\s+de\s+verificare|codes?|otps?|passcodes?|passkeys?|pins?|tokens?|verification|2fa|mfa|totp|hotp|secret|key|c[oó]digo(?:\s+de\s+\p{L}+)?|clave|senha|codice(?:\s+di\s+verifica)?|codice\s+d'?accesso|kode(?:\s+verifikasi)?|tan|einmalcode|zugangscode|engangskod|bestatigungscode|sicherheitscode|code\s+d'?acces|kod\s+dostepu|dogrulama\s+kodu|код(?:\s+подтверждения)?|рмз|رمز(?:\s+التحقق)?)|${CTX_CJK})\s*(?:(?:is|=)\s*)?[\s\p{P}\p{S}]*$`, "iu");
const STRONG_LABEL = /(?:backup|recovery|verification|security|one[- ]?time|otp|2fa|mfa|login|log[- ]?in|sign[- ]?in|authenticator|totp|hotp|access|reset|confirmation)\s+codes?\s*[:=#-]?\s*$/i;
const TECH_WORDS = /^(?:COBOL|JAVA|HTML|CSS|SQL|PYTHON|REACT|RUST|SWIFT|KOTLIN|SCALA|PERL|RUBY|GOLANG|DART|JSON|YAML|BASH|LINUX|UNIX|MATLAB|FORTRAN|PASCAL|ABAP|APEX|NODE|DOCKER|AZURE|AWS|GCP|SAP|ORACLE|EXCEL|NONE|DONE|OPEN|LIVE|BETA|ALPHA|LEGACY|CLEAN|REVIEW)$/;
const CERT_SHAPE = /^(?:AZ|SC|MS|MO|DP|PL|AI|MB|MD|DA|AD|SAA|SAP|SOA|DVA|CLF|ANS|DOP|SCS|DAS|MLS|DEA|PCA|PCD|PDE|ACE|SY0|N10|CV0|PK0|XK0|CS0|CAS|PT0|DS0|CY0|220)-?[A-Z]?\d{2,4}$/; // AZ-104, MO-200, SC300, SAA-C03, SY0-701
const TICKET_SHAPE = /^(?:INC|CHG|REQ|RITM|PRB|TASK|JIRA|CASE|BUG|PR|CR|SR|CVE|GHSA)[- ]?\d{2,8}(?:-\d{2,8})?$/i;
const GATE_STANDARD = /^(?:iso|iec|nist|soc|erc|eip|rfc|pci|hipaa|itil|cmmi|ieee|ansi|sp|fips|astm|din|en|bs|mil|nfpa|osha|ul|csa|cwe|owasp|hl7|icd|cpt|dsm|iata|icao|gdpr|sox|cis|nerc|ferpa|aws|az|sc|dp|pl|ms|mo|md|ai|ai-?\d)$/i;
const handedToGate = (before: string) => /\b(?:sent|send|gave|texted|emailed|messaged|dm'?d|got|received|told|shared|issued|forwarded|pinged)\s+(?:me|us)\b/i.test(before)
  || /^\s*(?:got|received|copied|grabbed|pulled)\s*$/i.test(before)
  || new RegExp(String.raw`\b(?:${SENDERS}|authy|chase|steam)\b[^.;]{0,30}\b(?:sent|texted|emailed|messaged|gave|shared|forwarded|pinged|dm'?d|shows|displays)\b`, "i").test(before)
  || GATE_DIRECT.test(before);
function gateLine(raw: string): string {
  raw = raw.replace(/(?<=[A-Za-z])['’](?=[A-Za-z])/g, ""); // "it's" reads "its", "DM'd" reads "DMd"
  // Wrappers become spaces; an underscore inside an identifier joins it ("ftm_v73"), at an edge it is a wrapper ("_482913_").
  return raw.replace(/(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, (m) => " ".repeat(m.length))
    .replace(/(?<![A-Za-z0-9])\*+|\*+(?![A-Za-z0-9])/g, (m) => "\u001f".repeat(m.length))
    .replace(/[`«»‹›"'“”‘’„()\[\]{}<>「」【】（）]/g, "\u001f")
    .replace(/(?<![A-Za-z0-9])(?:p(?:50|75|90|95|99|999)|\d{1,4}(?:\.\d+)?(?:ms|ns|us|s|h|hrs?|GB|MB|KB|TB|PB|gb|mb|kb|tb|pb|Hz|kHz|MHz|GHz|hz|khz|mhz|ghz|px|pt|yrs?|rps|qps|tps|fps|kW|MW|kg|lbs?|km|mi|cm|mm|nm|um|x))(?![A-Za-z0-9])/g, (m) => " ".repeat(m.length))
    .replace(/(?<![A-Za-z0-9])(?:A3[0-9]{2}(?:neo|ceo)?|B7[0-9]7(?:MAX|-\d{3})?|E1[79]5|CRJ\d{3,4}|ATR\s?[47]2)(?=\s+type\b)/g, (m) => " ".repeat(m.length)); // an aircraft before "type rating"
}
// The value straight after a code's label or a hand-over phrase ("PIN: 1z ck cn j0", "My phone shows WFJ073", "The digits are
// 8669..."), read up to a stop word or a long word, whatever its separators. Figures of 8 digits or fewer with no letters are
// left to gateCodeAt, which knows counts and money.
const TAIL_ANCHOR = new RegExp(String.raw`(?:(?<![\p{L}\p{N}])(?:(?!(?:bar|de|en|op|uni|geo|zip|post|trans|source|qr|area|dress|pass|zero|low|no|hard|en)code)\p{L}{0,16}(?:codi|codul|kod\p{L}{0,4}|kood\p{L}{0,3}|koodi\p{L}{0,4}|ko[d\u00f0]i|ikhodi|cod\s+dilysu|verifikasiekode|bekreftelseskode|code(?=\s*(?:[:=]|is|es|est|ist|er|ir|on|je|är|lautet)\b))(?![\p{L}])|has(?:l|\u0142)o(?:\s+jednorazowe)?|nambari\s+(?:yako|ya\s+siri)|mat\s+khau(?:\s+mot\s+lan)?|ma\s*:|szamkod|\p{L}{0,14}(?:inlog|inloggnings|verifierings|anmelde|verifizierungs|bestatigungs|bekraeftelses|bekræftelses|engangs|vahvistus|engångs)(?:code|kod|kode|koodi|kodu)\p{L}{0,6}|(?:kertakayttoinen|ellenorzo|dogrulama|giris|onay)\s+kod\p{L}{0,6}|kod(?:u\p{L}{0,4}|en|er|i|ot)|koodi\p{L}{0,4}|codul(?:\s+\p{L}+){0,3}|cod\s+de\s+verificare|codes?|otps?|passcodes?|passkeys?|pins?|tokens?|verification|2fa|mfa|totp|hotp|secret|key|steam\s+guard|digits|c[oó]digo(?:\s+de\s+\p{L}+)?|clave|senha|codice(?:\s+di\s+verifica)?|codice\s+d'?accesso|kode(?:\s+verifikasi)?|tan|einmalcode|zugangscode|engangskod|bestatigungscode|sicherheitscode|code\s+d'?acces|kod\s+dostepu|dogrulama\s+kodu|(?:the\s+)?(?:number|digits|one)\s+(?:is|was|are))(?![\p{L}])(?:\s+(?:is|are|was|=))?|(?<![\p{L}\p{N}])(?:sent|texted|emailed|messaged|gave|shared|forwarded|pinged|dm'?d)\s+(?:me|us)(?![\p{L}])|(?<![\p{L}\p{N}])(?:(?:phone|app|screen|authenticator|device|watch|sms)\s+(?:shows|showed|displays|displayed|says|said)|enter|type|paste|use|key\s+in|(?:reply|respond|confirm|verify|sign\s+in|log\s+in|login)\s+with|here'?s|here\s+is|it'?s|mine(?:\s+is)?)(?![\p{L}])|${CTX_CJK_N})\s*[:=#\-–—>|~]*\s*`, "giu");
const TAIL_STOP = /^(?:to|for|via|now|from|valid|expires?|expired|in|on|at|the|an?|is|was|are|my|your|please|mins?|minutes?|ago|do|not|share|and|or|with|sms|it|this|that|if|when|after|before|until|codes?|otp|pin|token|login|sign|verification|app|phone|email|text|texted|sent|me|us|you|here|there|today|tonight|yesterday|seconds?|hours?|days?|by|of|thanks?|ok|okay|asap|again|also|just|only|then|so|but|be|will|can|use|enter|type|was|were)$/i;
// A value read backwards from "is my code", "- my OTP", "was the verification code" ("KsT6 LBnn kY5 is my code", "jb - 3m - 73 -
// my OTP"): the same reading as after a label, toward the start of the line.
const BACK_LABEL = new RegExp(String.raw`[\s\u001f]*(?:[-–—:|]\s*)?(?:(?:is|was|are|=)\s+)?(?:my|the|your|our|their)\s+(?:[\p{L}'-]+'s\s+)?(?:new\s+|one[- ]time\s+|login\s+|sign[- ]in\s+|verification\s+|security\s+|access\s+)?(?:codes?|otps?|passcodes?|pins?|tokens?|2fa|mfa|totp|key|${CTX_CJK})(?![\p{L}])`, "giu");
export function beforeLabelCodeAt(raw: string): number {
  const line = gateLine(raw);
  for (const b of line.matchAll(BACK_LABEL)) {
    const end = b.index ?? 0, parts = line.slice(Math.max(0, end - 256), end).split(/(\s+|[-\u2013\u2014.,\/\u00b7:#+\x5c;*=~|\u001f]{1,3})/);
    const got: string[] = [];
    for (let k = parts.length - 1; k >= 0 && got.length < 24; k--) {
      const p = parts[k];
      if (k % 2 === 1 || !p) continue;
      if (TAIL_STOP.test(p) || (/^[a-z]+$/.test(p) && p.length >= 5) || (/^[A-Z][a-z][A-Za-z]{2,}$/.test(p) && !/\d/.test(p))) break;
      if (/^[a-z]{3,}$/.test(p) && /[aeiouy]/.test(p) && !got.some((g) => /[A-Za-z]\d|\d[A-Za-z]/.test(g))) break;
      got.unshift(p);
    }
    const val = got.join(""), digits = val.replace(/\D/g, "").length, letters = val.length - digits;
    if (val.length < 4 || val.length > 64 || digits === 0) continue;
    const mixed = got.filter((g) => /[A-Za-z]/.test(g) && /\d/.test(g));
    const look = digits >= 4 || mixed.length >= 2 || mixed.some((g) => g.length >= 4) || (got.length >= 2 && got.every((g) => g.length <= 5) && letters >= 2);
    if (!look) continue;
    if (letters === 0 && (/^(?:19|20)\d\d$/.test(val) || /^(?:19|20)\d\d(?:19|20)\d\d$/.test(val))) continue;
    if (CERT_SHAPE.test(val)) continue;
    return Math.max(0, end - val.length);
  }
  return -1;
}
export function tailCodeAt(raw: string): number {
  const back = beforeLabelCodeAt(raw);
  if (back >= 0) return back;
  const line = gateLine(raw).replace(/\u001f/g, " "); // a wrapper is a space to the reader
  for (const a of line.matchAll(TAIL_ANCHOR)) {
    const start = (a.index ?? 0) + a[0].length, before = line.slice(0, start);
    const named = /\b([\w'-]+)[ -]+(?:codes?|pins?)\b[^:;.]{0,24}\s*(?:(?:is|are|was)\s*)?[:#=|\-–—]?\s*$/i.exec(before);
    if (named && NAMED_LABEL.test(named[1].replace(/-\d+$/, ""))) continue; // "Billing codes: 99213, 99214"
    const parts = line.slice(start, start + 256).split(/(\s+|[-\u2013\u2014.,\/\u00b7:#+\x5c;*=~|]{1,2})/);
    let val = "", n = 0;
    for (let k = 0; k < parts.length && n < 24; k++) {
      const p = parts[k];
      if (k % 2 === 1) { if ((/^[,;]$/.test(p) && /^\s/.test(parts[k + 1] ?? "")) || /[.!?;,]\s/.test(p) || p === "\u001f") break; continue; }
      if (!p) continue;
      if (TAIL_STOP.test(p) || (/^[a-z]+$/.test(p) && p.length >= 5) || (/^[a-z]{3,}$/.test(p) && /[aeiouy]/.test(p) && !/[A-Za-z]\d|\d[A-Za-z]/.test(val) && !STRONG_LABEL.test(before)) || (/^[A-Z][a-z][A-Za-z]{2,}$/.test(p) && !/\d/.test(p)) || (/^\p{L}+$/u.test(p) && !/^[A-Za-z]+$/.test(p))) break;
      val += p; n++;
    }
    const digits = val.replace(/\D/g, "").length, letters = val.length - digits;
    if (val.length < 4 || val.length > 64) continue;
    if (letters === 0 && digits <= 8) continue; // gateCodeAt judges counts and money
    const strongLbl = STRONG_LABEL.test(before) || GATE_DIRECT.test(before);
    // The read value must look like a code: two or more short letter-and-digit groups or one of 4+ characters, more than 8
    // digits, or capital letters (or anything after a strong code label) with no digits. "CCNA 200-301", "CMA 2021" do not.
    const chunks = val.split(/(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/).length;
    const groupsRead = (parts.filter((p, k) => k % 2 === 0 && p).slice(0, n));
    const mixedGroups = groupsRead.filter((g) => /[A-Za-z]/.test(g) && /\d/.test(g));
    const randomLook = mixedGroups.length >= 2 || mixedGroups.some((g) => g.length >= 4 && !CERT_SHAPE.test(g) && !/^(?:[A-Z]{1,3}\d{1,2}|\d{1,2}[A-Z]{1,2})$/.test(g)) || (letters === 0 && digits > 8) || (digits === 0 && strongLbl) || chunks >= 4
      || (strongLbl && groupsRead.length >= 2 && groupsRead.every((g) => g.length <= 5 && !COUNT_NOUNS.test(g) && !/^(?:sq|ft|in|cm|mm|km|kg|lbs?|hrs?|mins?|ms|gb|mb|tb|kb|k|m|x)$/i.test(g)) && groupsRead.some((g) => /[A-Z]/.test(g)) && digits >= 1 && letters >= 2 && !GATE_STANDARD.test(groupsRead[0])); // "Code: HSV MUC 01"
    const code = randomLook && (digits >= 1 || strongLbl) && !(digits === 0 && TECH_WORDS.test(val)) && !(digits === 0 && !(/^[A-Z]{4,16}$/.test(val) || STRONG_LABEL.test(before)));
    if (!code) continue;
    // Safe shapes for a read value.
    if (CERT_SHAPE.test(val) && !GATE_DIRECT.test(before)) continue;
    if (/\b(?:icd|cpt|hcpcs|obd|dtc|fault|trouble|diagnostic)\b/i.test(line) && /^[A-Z]\d{2,4}(?:\.\d{1,4})?$/.test(val) && !STRONG_LABEL.test(before)) continue; // a medical or fault code
    if (/^(?:19|20)\d\d(?:(?:19|20)\d\d)*$/.test(val) || /^(?:Q[1-4]|H[12]|FY)(?:19|20)?\d\d$/i.test(val)) continue;
    if (GATE_STANDARD.test(val.replace(/\d.*$/, "")) && /^[A-Za-z]{2,6}\d{1,5}$/.test(val) && !GATE_DIRECT.test(before)) continue;
    if (GATE_STANDARD.test(groupsRead[0] ?? "") && groupsRead.length > 1 && groupsRead.slice(1).every((g) => /^\d{1,5}$|^[A-Za-z]{1,6}$/.test(g))) continue; // "ISO-27001-2013"
    if ([...raw.matchAll(PHONE)].some((p) => (p.index ?? 0) >= start - 2)) { if (letters === 0) continue; }
    return start;
  }
  return -1;
}
// A wrapped value next to a hand-over ("It's `2z.Sf.wC.C8.RB`", "«mx,0p,73» is my code", "OTP: (tR wH zK rX 73)"): the text
// inside quotes, backticks, brackets, guillemets or markdown is one value, separators and spaces dropped. It is a code unless it
// reads as words or has a safe shape.
const WRAP_PAIRS: [string, string][] = [["`", "`"], ["\"", "\""], ["'", "'"], ["«", "»"], ["“", "”"], ["„", "“"], ["‘", "’"], ["[", "]"], ["(", ")"], ["{", "}"], ["<", ">"], ["**", "**"], ["*", "*"], ["_", "_"]];
const WRAP_AFTER = new RegExp(String.raw`^[\x60"'»”’\])}>*_]*\s*(?:[-–—:]\s*)?(?:is|was|=|are)?\s*(?:my|the|your|our|their)?\s*(?:[\p{L}'-]+'s\s+|[\p{L}]+\s+)?(?:${CTX_LATIN}|key|number|digits|${CTX_CJK})`, "iu");
const WRAP_BEFORE = new RegExp(String.raw`(?:(?<![\p{L}\p{N}])(?:${CTX_LATIN}|(?:the\s+)?(?:number|digits|one|pin|key)\s+(?:is|was|are))|${CTX_CJK})[\s:=#\-–—>|~\x60"'«“‘\[({<*_]*(?:(?:is|was|are)\s+)?$`, "iu");
export function wrappedCodeAt(raw: string): number {
  for (const [open, close] of WRAP_PAIRS) {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${esc(open)}([^\\n]{3,90}?)${esc(close)}`, "g");
    for (const m of raw.matchAll(re)) {
      const at = m.index ?? 0, inner = m[1], before = raw.slice(Math.max(0, at - 60), at), after = raw.slice(at + m[0].length, at + m[0].length + 60);
      if (!WRAP_BEFORE.test(before) && !WRAP_AFTER.test(after)) continue;
      const words = inner.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      if (words.some((w) => /^\p{L}{5,}$/u.test(w) && /[aeiouy]/i.test(w) && !/^[A-Z]+$/.test(w))) continue; // words, not a code
      if (GATE_STANDARD.test(words[0] ?? "") && words.slice(1).every((w) => /^\d{1,5}$|^[A-Za-z]{1,6}$/.test(w))) continue; // "(RFC 6238)", "(ISO 27001)"
      if (words.filter((w) => /^\p{Ll}{3,4}$/u.test(w) && /[aeiou]/.test(w)).length >= 2 && !words.some((w) => /\d/.test(w))) continue;
      const flat = words.join(""), digits = flat.replace(/\D/g, "").length, letters = flat.length - digits;
      if (flat.length < 4 || flat.length > 64 || !(digits >= 4 || (digits >= 1 && letters >= 1))) continue;
      const v = inner.trim();
      if (CERT_SHAPE.test(v) || /^(?:19|20)\d\d(?:\s*[-–—,]\s*(?:(?:19|20)\d\d|present))?$/i.test(v) || isDate(v) || PHONE.test(v)) { PHONE.lastIndex = 0; continue; }
      PHONE.lastIndex = 0;
      if (letters === 0 && digits <= 8 && !WRAP_BEFORE.test(before) && !WRAP_AFTER.test(after)) continue;
      return at;
    }
  }
  return -1;
}
// A sign-in purpose after a value: a named label ("Ref:", "Store code:") does not make it safe ("Ref: 482913 use this to sign in").
const SIGNIN_AFTER = /\b(?:sign[- ]?in|log[- ]?in|login|verify|verification|otp|one[- ]time|passcode|2fa|mfa|authenticate|unlock)\b/i;
// The index of the first value on the line that the gate refuses, or -1.
export function gateCodeAt(raw: string, ctx?: boolean): number {
  return windowed(raw, (s) => gateCodeAtOne(s, ctx ?? GATE_CTX.test(s)));
}
export function gateCodeAtOne(raw: string, ctx = GATE_CTX.test(raw)): number {
  if (!ctx) return -1;
  const wrapped = wrappedCodeAt(raw);
  if (wrapped >= 0) return wrapped;
  const tail = tailCodeAt(raw);
  if (tail >= 0) return tail;
  const line = gateLine(raw);
  const phones = [...raw.matchAll(PHONE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const money = MONEY_WORDS.test(line) || /\b(?:salary|pay|offer|range|rate|budget)\b/i.test(line);
  const strongCode = STRONG_CODE.test(MONEY_WORDS.test(line) ? line.replace(/\bone[- ]?time\b/gi, " ") : line);
  const tokRe = new RegExp(String.raw`(?<![A-Za-z0-9_])[A-Za-z0-9_]+(?:${GATE_SEP_LOOSE}[A-Za-z0-9_]+)*`, "g");
  for (const m of line.matchAll(tokRe)) {
    // Groups; a word (two lowercase letters in a row and no digit, or a lexicon word) before the value is skipped, after it
    // ends the value. After a strong code label even a lowercase or all-capital letters value counts ("Backup codes: abcd").
    const pieces = m[0].split(new RegExp(`(${GATE_SEP_LOOSE})`));
    let val = "", offset = 0, started = false;
    for (let k = 0; k < pieces.length; k += 2) {
      const g = pieces[k], before0 = line.slice(0, (m.index ?? 0) + offset);
      const lexWord = /^(?:otps?|mfa|2fa|sms|pins?|codes?|tokens?|passcodes?|ref|id|no|sku|cpt|icd|key|tan|totp|hotp|secret)$/i.test(g);
      const strong = !started && STRONG_LABEL.test(before0) && !/\d/.test(line.slice((m.index ?? 0) + offset));
      const prefix = /^[A-Z]{1,6}$/.test(g) && /^\s?[-–—.\/:#]\s?$/.test(pieces[k + 1] ?? "") && /^\d/.test(pieces[k + 2] ?? "");
      const word = lexWord || (!/\d/.test(g) && /[a-z]/.test(g) && !strong) || (!/\d/.test(g) && /^[A-Z]+$/.test(g) && !GATE_DIRECT.test(before0) && !started && !prefix);
      if (word) { if (started) break; offset += g.length + (pieces[k + 1]?.length ?? 0); continue; }
      val += (started ? pieces[k - 1] : "") + g; started = true;
    }
    if (!val) continue;
    // A space join between letter groups stands only when some group mixes letters and digits ("AUS WUK 76V"); otherwise the
    // value ends at the first such space ("25000 LOC", "3500 COBOL").
    {
      const segs = val.split(/(?<=[A-Za-z0-9])\s{1,2}(?=[A-Za-z0-9])(?<!\d\s{1,2}(?=\d))/);
      if (segs.length > 1 && !segs.some((g) => g.split(/[^A-Za-z0-9]/).some((x) => /[A-Za-z]/.test(x) && /\d/.test(x) && x.length <= 8))) val = segs[0];
    }
    const at = (m.index ?? 0) + offset, end = at + val.length;
    const flat = val.replace(/[^A-Za-z0-9]/g, ""), digits = flat.replace(/\D/g, "").length, letters = flat.length - digits;
    const before = line.slice(0, at), after = line.slice(end), direct = GATE_DIRECT.test(before);
    const lettersOnly = digits === 0 && flat.length >= 4 && flat.length <= 16 && direct && /(?:[:=#]|\bis|\bare|\bes|\bist)\s*$/i.test(before) && (/^[A-Z]+(?:[^A-Za-z0-9]+[A-Z]+)*$/.test(val) || STRONG_LABEL.test(before)) && !TECH_WORDS.test(flat);
    if (flat.length > 64 || !(lettersOnly || (flat.length >= 4 && (digits >= 4 || (digits >= 2 && letters >= 2) || (direct && digits >= 1 && letters >= 1))))) continue;
    const groups = val.split(new RegExp(GATE_SEP_LOOSE)).filter(Boolean);
    const next = /^[\s:,.;!?)\]-]*([A-Za-z%][A-Za-z'-]*|%)/.exec(after)?.[1] ?? "";
    const next2 = /^[\s:,.;!?)\]-]*[A-Za-z0-9%][\w'-]*\s+([A-Za-z][A-Za-z'-]*)/.exec(after)?.[1] ?? "";
    const label = /\b([\w'-]+)[ -]+(?:codes?|pins?)\s*(?:(?:is|was|are)\s*)?[:#=|\-–—]?\s*(?:[A-Za-z0-9-]+\s*(?:,|\band\b|&|\/)\s*)*$/i.exec(before);
    const bareLabel = /\b([\w'-]+)\s*[:#]\s*$/.exec(before);
    const handed = handedToGate(before);
    const codeLength = letters === 0 && /^\d{6,8}$/.test(flat);
    const rising = groups.length === 2 && groups.every((g) => /^\d{3,}$/.test(g)) && groups[0].length === groups[1].length && Number(groups[1]) > Number(groups[0]);
    const compact = val.replace(/\s/g, "").replace(/[–—]/g, "-");
    // Context-independent safe shapes.
    if (lettersOnly) { if (!direct || (label && NAMED_LABEL.test(label[1].replace(/-\d+$/, "")))) continue; return at; }
    if (groups.every((g) => /^(?:19|20)\d\d$/.test(g)) || (groups.length === 2 && /^(?:19|20)\d\d$/.test(groups[0]) && /^(?:\d\d|present|now|current|today)$/i.test(groups[1]))) continue; // years
    if (/^(?:Q[1-4]|H[12])\s?(?:'?\d{2}|(?:19|20)\d\d)$|^FY\s?'?(?:\d{2}|(?:19|20)\d\d)(?:[-\/]\d{2,4})?$/i.test(val.trim())) continue; // quarters, fiscal years
    if (/^(?:19|20)\d\d\.\d{1,2}$/.test(val) && !direct) continue; // a year version ("Tableau 2023.1")
    if (/(?:19|20)\d\d/.test(val) && isDate(compact)) continue; // a real date
    if (MONTH_YEAR.test(val.trim())) continue; // a month and year, or a range of them ("05/2025 - 08/2025", "2023-06")
    if (!direct && isDate(line.slice(Math.max(0, at - 3), end + 3)) && /[\/.-]/.test(val)) continue;
    if (/^(?:[01]?\d|2[0-3])[:.][0-5]\d$/.test(val) && !direct) continue; // a time
    if (groups.length === 2 && groups.every((g) => /^(?:[01]\d|2[0-3])[0-5]\d$/.test(g))) continue; // two clock times ("0800 1600 shift")
    if (groups.length === 1 && /^(?:[01]\d|2[0-3])[0-5]\d$/.test(val) && /\b(?:start|starts|starting|at|from|until|till|by|shift|ends?|ending|begins?)\s*$/i.test(before)) continue;
    if (phones.some(([p, q]) => at < q && end > p)) continue;
    if (/^\d{5}-\d{4}$/.test(val)) continue; // a ZIP+4
    if (/\bpin\s*code\s*[:#-]?\s*$/i.test(before) && /^[1-8]\d{5}$/.test(val) && !/\b(?:verification|verify|otp|login|sign[- ]?in|sms|one[- ]time|2fa|mfa|bank|atm|card)\b/i.test(line)) continue; // an Indian postal PIN code
    if (/\bkode\s+pos\s*[:#-]?\s*$/i.test(before) && /^\d{5}$/.test(val)) continue; // an Indonesian postal code
    if (/,\s*[A-Z]{2}\s*$/.test(before) && /^\d{5}$/.test(val)) continue; // a US ZIP after its state ("Seattle, WA 98109")
    if (/(?:zip|postal|post\s*code|plz|cep|code\s+postal|c[oó]digo\s+postal|postcode)\s*[:#]?\s*$/i.test(before) && /^\d{4,6}$/.test(flat)) continue; // a postal code
    if (/\b(?:US|EP|WO|CN|JP)\s?$/.test(before) && /^\d{1,2},\d{3},\d{3}(?:\s?[A-Z]\d?)?$/.test(val)) continue; // a patent number
    if (/\bpatents?\b|\bpat\.\s*$/i.test(before) && /^\d{1,2},\d{3},\d{3}$/.test(val)) continue;
    if (/^10\.\d{4,9}$/.test(val) && /^\//.test(raw.slice(end))) continue; // a DOI ("10.1145/...")
    if (/\bdoi\b/i.test(before) && /^10\./.test(val)) continue;
    if (/^[A-Z]\d{2}-?[A-Z]{2}\d{6}$/.test(val) && !direct) continue; // a grant number ("R01-CA248291")
    if (TICKET_SHAPE.test(val) && !direct) continue; // a ticket or advisory ("INC-48291")
    if (/\b(?:incident|ticket|issue|case|change|request|jira|story|epic|bug|pr|pull\s+request)\s*#?\s*$/i.test(before) && /^[A-Z]{2,10}-\d{1,7}$/.test(val) && !direct) continue;
    if (CERT_SHAPE.test(val) && (!direct || CREDENTIAL_AFTER.test(next))) continue; // a certification exam ("AZ-104")
    if (GATE_STANDARD.test(groups[0]) && groups.length > 1 && groups.slice(1).every((g) => /^\d{1,5}$|^[A-Za-z]{1,6}$/.test(g)) && /\d/.test(groups.slice(1).join(""))) continue; // a standard ("ISO-27001", "NIST-800-53")
    if (label && NAMED_LABEL.test(label[1].replace(/-\d+$/, "")) && !SIGNIN_AFTER.test(after)) continue;
    if (/\b(?:bank|swift|bic|routing|sort)\b/i.test(before) && (/^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(val) || /^\d{2}-\d{2}-\d{2}$/.test(val)) && !STRONG_LABEL.test(before)) continue; // a SWIFT/BIC or sort code
    const clause = /\b([\w'-]+)[ -]+(?:codes?|pins?)\b[^:;.]{0,24}[:#]?\s*(?:[A-Za-z0-9.-]+\s*(?:,|\band\b|&|\/)\s*)*$/i.exec(before);
    if (clause && NAMED_LABEL.test(clause[1].replace(/-\d+$/, "")) && !SIGNIN_AFTER.test(after)) continue; // "Zip codes covered: 94103", "ICD-10 codes F32.1"
    if (/\b(?:icd|cpt|hcpcs|obd|dtc|fault|trouble|diagnostic)\b/i.test(line) && /^[A-Z]\d{2,4}(?:\.\d{1,4})?$/.test(val) && !STRONG_LABEL.test(before)) continue; // a medical or fault code
    if (/\b(?:iso|iec|nist|nfpa|ieee|ansi|astm|osha|rfc|pci|soc|fips|hl7|en|bs|din|ul|mil|cfr|cpt|icd|hcpcs|ndc|drg)\s?$/i.test(before) && /^[\d.:-]{1,12}$/.test(val) && !direct) continue; // "NFPA 72", "ISO 27001:2013"
    if (bareLabel && NAMED_LABEL.test(bareLabel[1]) && !SIGNIN_AFTER.test(after)) continue; // "ref: RQ4821" (not "Ref: 482913 use this to sign in")
    if (/^\d+(?:ms|s|m|h|k|x|gb|mb|kb|tb|hz|ghz|px|pt|yr|yrs|rps|qps|tps)$/i.test(flat) || /^p\d{2,3}$/i.test(flat)) continue;
    if ((money || /\b(?:salary|pay|offer|range|rate)\b/i.test(line)) && /^\d{1,3}(?:\.\d{3})+(?:\s?[-–—]\s?\d{1,3}(?:\.\d{3})+)?$/.test(val) && !direct) continue; // European thousands
    if (ID_LABEL.test(before) || ((COUNT_LABEL.test(before) || COUNT_LABEL2.test(before)) && !direct && !(codeLength && strongCode) && !new RegExp(String.raw`(?:ss|\b(?:${SENDERS}|lastpass|1password|bitwarden|authy|signal|whatsapp|telegram|slack|zoom|bank))\s*[:\-–—]\s*$`, "i").test(before))) continue;
    if (!direct && /\b(?:certificate|certification|license|licence|credential|card|badge|npi|dea|member|registration|permit|grant|award|serial|part|model|lot|batch|naics|cage|uei|duns|ein|tracking|shipment|waybill|invoice|order)\s*(?:no\.?|number|#|id)?\s*[:#]?\s*$/i.test(before)) continue; // an ID after its own label
    if (!direct && /[$€£¥₹]\s*$/.test(before)) continue; // money (never right after a code's label: "OTP: $482913")
    if (/^(?:%|k|m|bn|usd|eur|gbp|inr|jpy|cny|dollars|euros|rupees|percent)$/i.test(next) || /^\s*(?:k|m)\b/i.test(after)) { if (!direct) continue; }
    if (!direct && letters === 0 && /^\d{1,3}(?:,\d{3})+$/.test(val) && !(handed && /^\d{6,8}$/.test(flat) && !COUNT_NOUNS.test(next))) continue; // a thousands figure
    if (!direct && letters === 0 && /^v?\d+(?:\.\d+){1,3}$/.test(val) && digits < 6) continue; // a version
    // A figure given for a purpose ("VP gave me 4500 and a deadline"), never with a code word on the line.
    const lc = LEFT_CTX.exec(before), verb = lc ? lc[0].trim().split(/[\s:,]+/)[0].toLowerCase() : "", sender = STRONG_SENDER.test(line);
    if (!direct && letters === 0 && !strongCode && !RIGHT_CTX.test(after) && (money || /^(?:sent|emailed|messaged|got|received|gave)$/.test(verb) || (sender && /\b(?:sent|emailed|messaged|gave|got|received)\b/i.test(before)))
      && !SIGNIN_PURPOSE.test(after) && !/^\s*(?:from|via|on|in)\s+(?:the\s+|my\s+)?(?:app|authenticator|phone|sms|text|texts|bank|1password|lastpass|bitwarden|signal|whatsapp|telegram|slack|zoom|teams|discord|authy|okta|duo|hr|it|helpdesk|support|admin|recruit\w*|hiring|security)\b/i.test(after) && (money || (!FROM_SENDER.test(after) && (/^\s*(?:(?:for|to|in|on|at|as|by|from)\s+\S|,\s*(?:a|an|and|plus|with)\b|and\s+(?:a|an|the|\d))/i.test(after) || (verb === "gave" && /\w/.test(after)))))) continue;
    // A count: a plural noun (or a known count noun) after the figure, past one acronym; never a code-length figure handed to
    // the person or right after a code's label ("Okta sent me 482913 users").
    const strictLen = codeLength && (handed || direct);
    const plural = (w: string) => COUNT_NOUNS.test(w) || (/^[a-z][a-z'-]*s$/.test(w) && !STRICT_VERBS.test(w));
    if (letters === 0 && !strictLen && (plural(next) || (/^(?:[A-Z][\w-]*|[A-Z0-9-]{2,})$/.test(next) && plural(next2)) || /^\s*[A-Za-z]+\/(?:day|week|month|year|hr|hour|min|sec|s)\b/i.test(after))) continue;
    if (letters === 0 && rising && (COUNT_NOUNS.test(next) || COUNT_NOUNS.test(next2))) continue;
    if (letters === 0 && /^(?:per|a|an|each|every)$/i.test(next) && !codeLength) continue;
    if (letters === 0 && /^\s*(?:万|亿|千|百|名|人|个|家|次|元|年|月|件|台|位|项|份|條|万人|万用户|億|人以上)/.test(after) && !direct) continue; // a CJK count ("3000 万用户")
    if (letters > 0 && !direct && CREDENTIAL_AFTER.test(next)) continue;
    if (letters > 0 && !direct && /\b(?:exam|course|subject|model|part|lot|batch|sku|item|product|class|module|unit|room|flight|gate|seat|build|release|version)\s*[:|\-]?\s*$/i.test(before)) continue;
    return at;
  }
  return -1;
}
// A line that is a value and nothing else ("672480", "`K7X9-P2QM`", "- 7392 0184 2231"): refused unless it is a safe shape,
// whatever the lines around it say.
export function standaloneCodeAt(raw: string): number {
  const plain = raw.replace(/^\s*(?:[-*•▪●>]|\d+[.)])\s+/, "");
  if ([...plain.matchAll(PHONE)].some((p) => p[0].length >= plain.replace(/[\s.,;:!?]+$/, "").trim().length - 2)) return -1; // a phone number alone
  const body = gateLine(plain).replace(/[\s.,;:!?]+$/, "");
  const m = new RegExp(String.raw`^\s*([A-Za-z0-9]+(?:${GATE_SEP_LOOSE}[A-Za-z0-9]+)*)\s*$`).exec(body);
  if (!m) return -1;
  const v = m[1], flat = v.replace(/[^A-Za-z0-9]/g, ""), digits = flat.replace(/\D/g, "").length, letters = flat.length - digits;
  if (flat.length < 4 || flat.length > 24 || !(digits >= 4 || (digits >= 2 && letters >= 2))) return -1;
  return gateCodeAt(v, true) >= 0 ? raw.indexOf(v[0]) : -1;
}
// The index of the first suspected code on a line, or -1.
// A long line is judged piece by piece so the work stays linear in its length. A piece is one or more whole sentences (split at
// ". ", "; ", "! ", "? ", " | "), up to 512 characters, judged with the end of the sentence before it (up to 64 characters) as
// context, so a value is never cut from its label or its safe shape. A run with no such break is cut at a space, 448 characters
// at a time with 64 shared.
function windowed(raw: string, f: (s: string) => number): number {
  if (raw.length <= 600) return f(raw);
  const pieces: [number, number][] = [];
  const cuts = [0, ...[...raw.matchAll(/(?<=[.;!?])\s+|\s+\|\s+/g)].map((m) => (m.index ?? 0) + m[0].length), raw.length];
  let start = 0;
  for (let k = 1; k < cuts.length; k++) {
    if (cuts[k] - start > 512 && cuts[k - 1] > start) { pieces.push([start, cuts[k - 1]]); start = cuts[k - 1]; }
    while (cuts[k] - start > 512) { // one sentence longer than a piece: cut at a space
      let end = raw.lastIndexOf(" ", start + 448);
      if (end <= start) end = start + 448;
      pieces.push([start, end]); start = end;
    }
  }
  if (start < raw.length) pieces.push([start, raw.length]);
  for (const [a, b] of pieces) {
    // At least 64 characters of the text before the piece, from a word start when there is one within 128 more.
    const sp = a === 0 ? -1 : raw.lastIndexOf(" ", Math.max(0, a - 64)), from = a === 0 ? 0 : sp >= a - 192 ? sp + 1 : Math.max(0, a - 64), at = f(raw.slice(from, b));
    if (at >= 0) return from + at;
  }
  return -1;
}
export function lineCodeAt(raw: string): number {
  return windowed(raw, lineCodeAtOne);
}
function lineCodeAtOne(raw: string): number {
  const wrapped = wrappedCodeAt(raw);
  if (wrapped >= 0) return wrapped;
  const strict = gateCodeAt(raw);
  if (strict >= 0) return strict;
  const safeSpans: number[][] = [], tail = labelTailAt(raw, safeSpans);
  if (tail >= 0) return tail;
  // A run of 9 or more digits handed to the person ("Workday sent me 4829130217"), which the token rule's 4-8 digits miss.
  // A run of 9 or more digits, or a letter-and-digit code of 4 or 11+ characters, handed to the person ("Workday sent me 4829130217",
  // "Okta sent me K7X9"), which the token rule's 4-8 digits and 5-10 characters miss. Labels are judged by labelTailAt.
  for (const m of raw.matchAll(/(?<![\w$\u20ac\u00a3.,])(?:\d{9,}|(?=[A-Za-z0-9]{4}(?![\w])|[A-Za-z0-9]{11,40}(?![\w]))(?=(?:[A-Za-z]*\d){2})(?=(?:\d*[A-Za-z]){2})[A-Za-z0-9]+)(?![\w%])/g)) {
    const before = raw.slice(0, m.index);
    if (STRONG_SENDER.test(raw) || /\b(?:sent|send|gave|texted|emailed|messaged|dm'?d|got|received|told|shared|issued)\s+(?:me|us)\b/i.test(before)) return m.index ?? 0;
  }
  // Grouped digits handed to the person ("Workday sent me 7392 0184 2231"): 6 or more digits in 2+ groups that are not a rising
  // range, a date, years or a phone number.
  for (const m of raw.matchAll(/\b(?:sent|send|gave|texted|emailed|messaged|dm'?d|got|received|told|shared|issued)\s+(?:me|us)\b[\s:,"'([]*(\d{2,6}(?:\s?[-\u2013\u2014.\/]\s?\d{2,6}|\s\d{2,6})+)(?![\w])/gi)) {
    const val = m[1], groups = val.split(/\D+/).filter(Boolean), digits = groups.join("").length, at = (m.index ?? 0) + m[0].length - val.length;
    if (digits < 6) continue;
    if (groups.length === 2 && groups[0].length === groups[1].length && Number(groups[1]) > Number(groups[0])) continue; // a range
    if (groups.every((g) => /^(?:19|20)\d\d$/.test(g)) || isDate(val.replace(/\s/g, ""))) continue;
    if ([...raw.matchAll(PHONE)].some((p) => (p.index ?? 0) <= at && at < (p.index ?? 0) + p[0].length)) continue;
    return at;
  }
  if (/\b(?:otp|mfa|2fa|code|passcode|pin)(?=\d)(?!(?:19|20)\d\d\b)\d{4,8}\b/i.test(raw)) return 0;
  if (/\b(?:otp|mfa|2fa)-(?!(?:19|20)\d\d\b)(?:\d{4,8}|(?=[A-Za-z0-9]{5,10}\b)(?=(?:[A-Za-z]*\d){2})(?=(?:\d*[A-Za-z]){2})[A-Za-z0-9]{5,10})\b/i.test(raw)) return 0;
  // A code split by a spaced dash right after its own label ("OTP: 739 - 201"); two years are a range ("Code: 2019 - 2021").
  const spaced = /\b(?:code|otp|passcode|pin|token|verification|2fa|mfa)\s*(?:(?:is|was|=)\s*)?[:#=|]?\s*(\d{2,4})\s+[-–—]\s+(\d{2,4})(?!\d)/i.exec(raw);
  if (spaced && (spaced[1] + spaced[2]).length >= 6 && !/^(?:19|20)\d\d$/.test(spaced[1]) && !risingRange(raw, spaced.index + spaced[0].length - spaced[2].length)) return spaced.index;
  const money = MONEY_WORDS.test(raw) || /\bgrants?\b|\bawards?\b/i.test(raw);
  const strongCode = STRONG_CODE.test(money ? raw.replace(/\bone[- ]?time\b/gi, " ") : raw), sender = STRONG_SENDER.test(raw);
  // A code spelled out ("seven three nine two zero one") next to a code word.
  if ((strongCode || sender) && /\b(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)[\s,-]+){3,7}(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/i.test(raw)) return 0;
  const line = raw.replace(/\((?![^)]*\d[^)]*\d)[^)]*\)/g, (m) => " ".repeat(m.length)); // a parenthetical with no code-shaped value (two digits or more) is a connector
  const phones = [...line.matchAll(PHONE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  for (const m of line.matchAll(LINE_TOKEN)) {
    const tok = m[1], at = m.index ?? 0, end = at + tok.length, digits = tok.replace(/\D/g, ""), letters = tok.replace(/[^A-Za-z]/g, "");
    const alnum = letters.length > 0;
    if (alnum ? (digits.length < 2 || letters.length < 2 || !/^[A-Za-z0-9 -]+$/.test(tok) || (/[ -]/.test(tok) && tok.split(/[ -]/).some((g) => !/\d/.test(g) || /^(?:\d+(?:ms|s|m|h|k|x|gb|mb|kb|tb|hz|ghz|px|pt|yr|yrs)|p\d{2,3})$/i.test(g)))) : (digits.length < 4 || digits.length > 8)) continue;
    const before = line.slice(0, at), after = line.slice(end), squashed = tok.replace(/\s+/g, " ").trim();
    const direct = DIRECT.test(before);
    if (!alnum && (YEAR_RANGE.test(squashed) || /^(?:19|20)\d\d$/.test(digits) || /^(?:19|20)\d\d\D+(?:19|20)?\d\d$/.test(squashed) && /[-–—\/ ]/.test(tok))) continue;
    if (!alnum && /^\d{1,3}(?:,\d{3})+$/.test(tok) && !direct && !(handedToGate(before) && /^\d{6,8}$/.test(digits) && !COUNT_NOUNS.test(/^[\s:,.)\-]*([A-Za-z][A-Za-z']*)/.exec(after)?.[1] ?? ""))) continue; // a thousands figure (not "Workday sent me 739,201")
    if (!alnum && !direct && /^\d+\.\d+\.\d+/.test(tok)) continue; // a version or address
    if (!alnum && /^\d+(?:\.\d+)+$/.test(tok) && /\b(?:release|version|ver|v|ubuntu|ios|android|python|java|node|excel|office|windows|sql|tableau|sap|hl7|ielts|toefl|gpa)\s*$/i.test(before)) continue; // a version or score
    if (phones.some(([p, q]) => at < q && end > p)) continue;
    if (safeSpans.some(([p, q]) => at >= p && end <= q)) continue; // judged safe after its own label
    if ((!direct || /(?:19|20)\d\d/.test(tok)) && isDate(line.slice(Math.max(0, at - 3), end + 3)) && /[\/.-]/.test(tok)) continue;
    if (/[$€£]\s*$/.test(before) || /^\s*(?:k\b|%|usd|eur|gbp|dollars|euros|per\b|a\s+(?:year|month|week|day|hour)|\/\s*(?:hr|hour|yr|year|month))/i.test(after)) continue;
    if ((!direct || risingRange(line, at)) && (/\s*[-–—]\s*\d/.test(after.slice(0, 4)) || /\d\s*[-–—]\s*$/.test(before))) continue; // a range ("1200 - 1500")
    if (ID_LABEL.test(before) || COUNT_LABEL.test(before) || COUNT_LABEL2.test(before)) continue;
    if (/,\s*[A-Z]{2}\s*$/.test(before) && /^\d{5}$/.test(tok)) continue; // a US ZIP after its state
    if (/\bpin\s*code\s*[:#-]?\s*$/i.test(before) && /^[1-8]\d{5}$/.test(tok) && !/\b(?:verification|verify|otp|login|sign[- ]?in|sms|one[- ]time|2fa|mfa|bank|atm|card)\b/i.test(line)) continue; // an Indian postal PIN code
    if (/\bkode\s+pos\s*[:#-]?\s*$/i.test(before) && /^\d{5}$/.test(tok)) continue; // an Indonesian postal code
    if (/\b(?:icd|cpt|hcpcs|obd|dtc|fault|trouble|diagnostic)\b/i.test(line) && /^[A-Z]\d{2,4}(?:\.\d{1,4})?$/.test(tok) && !STRONG_LABEL.test(before)) continue; // a medical or fault code
    if (!direct && /\b(?:certificate|certification|license|licence|credential|card|badge|npi|dea|member|registration|permit|grant|award|serial|part|model|lot|batch|naics|cage|uei|duns|ein|tracking|shipment|waybill|invoice|order)\s*(?:no\.?|number|#|id)?\s*[:#]?\s*$/i.test(before)) continue; // an ID after its own label
    // A named label right before the code, also in a list ("Billing codes: 99213, 99214", "Exam code | AZ104"), a compound
    // label ("code review:", "code policy:"), or a named word alone ("Microsoft exam AZ104").
    const label = /\b([\w'-]+)[ -]+(?:codes?|pins?)\s*(?:(?:is|was|are)\s*)?[:#=|\-–—]?\s*(?:[A-Za-z0-9-]+\s*(?:,|\band\b|&|\/)\s*)*$/i.exec(before);
    if (label && NAMED_LABEL.test(label[1])) continue;
    if (/\bcodes?[ -]+(?:review|reviews|standard|standards|policy|audit|coverage|quality|style|base|freeze|owner|owners|signing|ownership|health)\b[^:|]{0,20}[:|\-]?\s*$/i.test(before)) continue;
    const bare = /\b([a-z]+)\s*[:|\-]?\s*$/i.exec(before);
    if (alnum && bare && /^(?:exam|course|subject|model|part|lot|batch|sku|item|product|class|module|unit|room|flight|gate|seat|build|release|version)$/i.test(bare[1])) continue;
    if (FILE_NAMED.test(before) && !/\b(?:verification|otp|2fa|mfa|login|sign[- ]?in|one[- ]time|access|security|auth)\b/i.test(before.slice(-30))) continue;
    const next = /^[\s:,.)\-]*([A-Za-z][A-Za-z']*)/.exec(after)?.[1] ?? "";
    // After a code's own label only a count (a plural noun or a unit: "Code: 4500 builds", "Pin: 4500 sq ft") or a credential
    // word ("OTP: AZ500 certified") keeps the figure; "valid", "expires", "Workday" or a name after it is a handed-over code.
    if (next && !(direct && !COUNT_AFTER_LABEL.test(next) && !(alnum && /^(?:certified|certification|certificate|exam|course|badge|credential|holder|compliant|compliance)$/i.test(next))) && !AFTER_FUNC.test(next) && !/^(?:codes?|passcodes?|pins?|otps?|tokens?)$/i.test(next)
      && !(sender && /^(?:texts?|logins?|sign-?ins?|sms|messages?|verifications?|otps?|digits)$/i.test(next))
      // After a hand-over (a sender, or "sent me", "gave me" ...) only a known count noun makes the figure a count.
      && !(handedToGate(before) && !COUNT_NOUNS.test(next) && !(alnum && CREDENTIAL_AFTER.test(next)))) continue; // a count noun
    const left = LEFT_CTX.exec(before), right = RIGHT_CTX.test(after);
    const verb = left ? left[0].trim().split(/[\s:,]+/)[0].toLowerCase() : "";
    // A figure with a money purpose: "Client sent me 120000 for review", "VP gave me 4500 and a deadline", "Received 50000 from
    // Amazon in credits" (never when a strong code word is on the line).
    if (!alnum && !strongCode && !right && (money || (/^(?:sent|emailed|messaged|got|received|gave)$/.test(verb) || (sender && /\b(?:sent|emailed|messaged|gave|got|received)\b/i.test(before))))
      && !SIGNIN_PURPOSE.test(after) && (money || (!FROM_SENDER.test(after) && (/^\s*(?:(?:for|to|in|on|at|as|by|from)\s+\S|,\s*(?:a|an|and|plus|with)\b|and\s+(?:a|an|the|\d))/i.test(after) || (verb === "gave" && /\w/.test(after)))))) continue;
    if (strongCode || sender || left || right) return at;
  }
  return -1;
}
// The code-shaped tokens of a whole text, as offsets into it: the same sentence split and token rules as codeInChat.
export function codeTokens(msg: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let prevNamedCode = false, off = 0;
  for (const [i, part] of msg.split(SENTENCE_SPLIT).entries()) {
    if (i % 2 === 0) {
      const carried = prevNamedCode && VALUE_LEAD.test(part);
      prevNamedCode = contextEnds(part, STRONG).length > 0;
      for (const h of tokensIn(part, carried)) out.push({ start: off + h.start, end: off + h.end });
    }
    off += part.length;
  }
  return out;
}
const YEAR_RANGE = /^(?:19|20)\d\d(?:\s*[-\u2013\u2014]\s*(?:(?:19|20)\d\d|present|now))?$/i;
