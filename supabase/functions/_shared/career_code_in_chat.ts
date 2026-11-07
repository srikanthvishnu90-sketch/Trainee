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
    // ...unless that earlier group is a full code itself, 6+ digits on its own line ("Workday sent me 739201\n482913": two codes;
    // phone groups have at most 4 digits).
    const prevGroup = /(\d+)(?:[ \t\u00a0\u2007\u2009\u202f]{1,8}|[ \t\u00a0\u2007\u2009\u202f]{0,8}(?:\r\n|[\r\n\-\u2013\u2014])[ \t\u00a0\u2007\u2009\u202f]{0,8})$/.exec(sentence.slice(0, at));
    const prevIsCode = !!prevGroup && prevGroup[1].length >= 6 && /[\r\n]/.test(sentence.slice(at - (prevGroup[0].length - prevGroup[1].length), at));
    if (!isStrong && prevGroup && !prevIsCode) continue;
    if (!isStrong && /[ \r\n\t\u00a0\u2007\u2009\u202f\-\u2013\u2014]/.test(tok)) {
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
    if ((!near(at, strong) && !near(at, weak)) || COUNT_AFTER.test(after) || DOTTED_MONEY_AFTER.test(after) || DOTTED_MONEY_BEFORE.test(before) || MORE_GROUPS.test(after) || /[-\u2013\u2014]\s*$/.test(before)
      || (!near(at, strong) && (DOTTED_MONEY_NEAR.test(before.slice(-80)) || DOTTED_MONEY_NEAR.test(after.slice(0, 30)) || /^\s*(?:and|to|or)\s+(?:\d|\[code removed\])/i.test(after)))) continue;
    if (hits.some((h) => at < h.end && at + m[0].length > h.start)) continue;
    hits.push({ start: at, end: at + m[0].length });
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
const AFTER_FUNC = /^(?:for|from|to|on|in|at|today|tonight|yesterday|this|that|just|now|earlier|already|again|also|too|twice|once|recently|later|soon|please|thanks|thank|and|or|but|so|which|can|could|would|will|if|when|by|via|as|here|there|it|is|was|are|my|the|a|an|asap|immediately|quickly|back|ago|sent|is)$/i;
// A sign-in purpose: a login word that ends its phrase ("for the portal", "to finish my application"), or a delivery target
// ("to my phone", "by text"); "for the portal redesign" or "the application rollout" is a project, not a sign-in.
const SIGNIN_PURPOSE = /\b(?:(?:for|on|into|in|at)\s+(?:the|my|your|their)?\s*(?:[a-z]+\s+){0,2}|to\s+(?:the|my|your|their)?\s*)(?:portal|site|website|login|log[- ]?in|sign[- ]?in|account|app|application|form|page|profile|password|verification)\b(?=\s*(?:$|[.,;:!?)]|\s(?:and|so|to|please|now|today|thanks|again)\b))|\bto\s+(?:finish|complete|continue|access|open|unlock|confirm|submit)\s+(?:my|the|your)\s+(?:portal|site|login|account|app|application|form|profile)\b(?=\s*(?:$|[.,;:!?)]|\s(?:and|so|please|now|today|thanks|again)\b))|\b(?:phone|cell|mobile|inbox|e-?mail|text|sms|log\s+in|sign\s+in|verify|enter\s+it)\b/i;
// Named labels whose numbers are kept (identity_redact.ts NAMED_CODE's words and resume labels): "CPT codes: 99213",
// "change code: CHG0012345", "exam code: AZ104". Anything else before "code" is read as a code's own label.
const NAMED_LABEL = /^(?:zip|postal|post|area|country|promo|promotional|discount|coupon|referral|course|class|error|status|dial|tax|product|source|job|dress|invite|invitation|gift|reference|ref|airport|naics|sic|cpt|icd|hcpcs|ndc|drg|sort|swift|bank|routing|color|colour|style|item|sku|morse|qr|bar|req|requisition|position|posting|role|department|dept|cost|budget|project|program|module|unit|soc|fips|vendor|supplier|ticket|order|voucher|offer|event|building|store|exam|certification|cert|change|charge|engagement|release|config|configuration|policy|sop|servicenow|wbs|award|clearance|qualification|lot|batch|part|model|taxonomy|denial|adjustment|remark|activity|transaction|t|school|branch|hs|revenue|gl|cage|hazmat|license|licence|machine|billing|diagnosis|procedure|course|location|site|plant|warehouse|accounting|campaign|tracking|hex|paint|booking|reservation|specialty|speciality|subject|flight|room|seat|gate|afsc|mos|nec|rate|rating|grade|series|occupation|occupational|duty|uic|ein|cip|onet|o\*net|isco|esco|noc|anzsco)$/i;
const COUNT_LABEL2 = /\b(?:codes|pins|tokens|passcodes|otps|attempts|logins|sign[- ]?ins|resets)\s+(?:[a-z]+\s+){0,2}(?:issued|reviewed|delivered|sent|reset|rotated|blocked|processed|handled|generated|verified|validated|revoked|expired|enrolled|migrated|served|per\s+\w+)(?:\s+per\s+\w+)?\s*[:\-–—]\s*$|\b(?:codes|pins|otps|passcodes)\s+(?:issued|reviewed|delivered|sent|reset|rotated|blocked)\b[^:]{0,20}[:\-]\s*$|\b(?:adoption|usage|growth|enrollment|enrolment|coverage|uptime|throughput|capacity|traffic|volume|count|total|reach|downloads|installs|users)\s*[:\-–—]\s*$/i;
const COUNT_LABEL = /\b(?:(?!(?:codes|pins|tokens|passcodes|otps|digits)\b|sms\s*[:\-\u2013\u2014]|(?:this|his|is|was|has|its|yes|us|plus|bus|less|class|process|address|access|success|business|status|bonus|campus|focus|alias|bias|chaos|series|news|ss)\b)[a-z]{2,}s|total|volume|count|sales|revenue|traffic|headcount|budget)\s*(?:per\s+\w+\s*)?(?:sent|received|processed|handled|delivered|closed|resolved|served|shipped|made|generated|raised|onboarded|hired|managed)?\s*(?:per\s+\w+\s*)?[:\-–—]\s*$/i;
const ID_LABEL = /\b(?:employee|student|member|badge|staff|license|licence|npi|dea|candidate|requisition|req|job|case|claim|policy|patient|customer|order|invoice|po|cert|certificate|certification|credential|exam)\s*(?:id|no\.?|number|#)\s*[:#]?\s*$/i;
const MONEY_WORDS = /\b(?:credits?|funding|funds|grants?|budget|seed|investment|donations?|revenue|sales|savings|profit|arr|mrr|salary|bonus|stipend|scholarship|award|prize|raise|dollars|usd|eur|gbp)\b/i;
const PHONE = /(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}/g;
const DATE = /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b|\b(?:19|20)\d\d[\/.-]\d{1,2}[\/.-]\d{1,2}\b/;
// The 1-based line numbers of the text read from the file that hold a suspected code (each once, in order).
export function fileCodeLines(text: string): number[] {
  const lines = normalizeChatText(String(text ?? "")).split("\n"), hits: number[] = [];
  const unbullet = (s: string) => s.replace(/^\s*(?:[-*•▪●>]|\d+[.)])\s+/, "");
  lines.forEach((raw, i) => {
    if (lineCodeAt(raw) >= 0) { hits.push(i + 1); return; }
    const n1 = unbullet(lines[i + 1] ?? ""), n2 = unbullet(lines[i + 2] ?? "");
    if (!n1.trim()) return;
    const ctxEnd = LEFT_CTX.test(raw.replace(/\s*$/, " ")), digitEnd = /(?:^|\D)\d{2,4}\s*$/.test(raw);
    const rightNext = /^\s*(?:is|was|are|=|-|\u2013|\u2014|\()/i.test(n1) && RIGHT_CTX.test(" " + n1.trim());
    if (!ctxEnd && !digitEnd && !rightNext) return;
    // The code or its hand-over continues on the next line or two ("Workday sent me" / "739 201", "739" / "201",
    // "739201" / "is my verification code"): judged together, counted on this line when the code starts within it or the
    // next line's first token.
    const join = `${raw.trimEnd()} ${n1.trim()}${/^\d{2,4}$/.test(n1.trim()) && /^\d{2,4}\b/.test(n2.trim()) ? " " + n2.trim() : ""}`;
    const at = lineCodeAt(join), len = raw.trimEnd().length;
    // A split code starts on this line; a carried code is among the next line's first words; a code before "is my ... code"
    // is on this line.
    const ok = at >= 0 && ((digitEnd || rightNext) && at < len || ctxEnd && at <= len + 1 + (/^(?:\S+\s+){0,2}/.exec(n1.trim())?.[0].length ?? 0));
    if (ok) hits.push(i + 1);
  });
  return hits;
}
// The index of the first suspected code on a line, or -1.
function lineCodeAt(raw: string): number {
  if (/\b(?:otp|mfa|2fa)-(?!(?:19|20)\d\d\b)(?:\d{4,8}|(?=[A-Za-z0-9]{5,10}\b)(?=(?:[A-Za-z]*\d){2})(?=(?:\d*[A-Za-z]){2})[A-Za-z0-9]{5,10})\b/i.test(raw)) return 0;
  const money = MONEY_WORDS.test(raw) || /\bgrants?\b|\bawards?\b/i.test(raw);
  const strongCode = STRONG_CODE.test(money ? raw.replace(/\bone[- ]?time\b/gi, " ") : raw), sender = STRONG_SENDER.test(raw);
  // A code spelled out ("seven three nine two zero one") next to a code word.
  if ((strongCode || sender) && /\b(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)[\s,-]+){3,7}(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/i.test(raw)) return 0;
  const line = raw.replace(/\((?![^)]*\d{4})[^)]*\)/g, (m) => " ".repeat(m.length)); // a parenthetical without the code is a connector
  const phones = [...line.matchAll(PHONE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  for (const m of line.matchAll(LINE_TOKEN)) {
    const tok = m[1], at = m.index ?? 0, end = at + tok.length, digits = tok.replace(/\D/g, ""), letters = tok.replace(/[^A-Za-z]/g, "");
    const alnum = letters.length > 0;
    if (alnum ? (digits.length < 2 || letters.length < 2 || !/^[A-Za-z0-9 -]+$/.test(tok) || (/[ -]/.test(tok) && tok.split(/[ -]/).some((g) => !/\d/.test(g) || /^(?:\d+(?:ms|s|m|h|k|x|gb|mb|kb|tb|hz|ghz|px|pt|yr|yrs)|p\d{2,3})$/i.test(g)))) : (digits.length < 4 || digits.length > 8)) continue;
    const before = line.slice(0, at), after = line.slice(end), squashed = tok.replace(/\s+/g, " ").trim();
    if (!alnum && (YEAR_RANGE.test(squashed) || /^(?:19|20)\d\d$/.test(digits) || /^(?:19|20)\d\d\D+(?:19|20)?\d\d$/.test(squashed) && /[-–—\/ ]/.test(tok))) continue;
    if (!alnum && /^\d{1,3}(?:,\d{3})+$/.test(tok) && !strongCode && !sender) continue; // a thousands figure
    if (!alnum && /^\d+\.\d+\.\d+/.test(tok)) continue; // a version or address
    if (phones.some(([p, q]) => at < q && end > p)) continue;
    if (DATE.test(line.slice(Math.max(0, at - 3), end + 3)) && /[\/.-]/.test(tok)) continue;
    if (/[$€£]\s*$/.test(before) || /^\s*(?:k\b|%|usd|eur|gbp|dollars|euros|per\b|a\s+(?:year|month|week|day|hour)|\/\s*(?:hr|hour|yr|year|month))/i.test(after)) continue;
    if (/\s*[-–—]\s*\d/.test(after.slice(0, 4)) || /\d\s*[-–—]\s*$/.test(before)) continue; // a range ("1200 - 1500")
    if (ID_LABEL.test(before) || COUNT_LABEL.test(before) || COUNT_LABEL2.test(before)) continue;
    // A named label right before the code, also in a list ("Billing codes: 99213, 99214", "Exam code | AZ104"), a compound
    // label ("code review:", "code policy:"), or a named word alone ("Microsoft exam AZ104").
    const label = /\b([\w'-]+)[ -]+(?:codes?|pins?)\s*(?:(?:is|was|are)\s*)?[:#=|\-–—]?\s*(?:[A-Za-z0-9-]+\s*(?:,|\band\b|&|\/)\s*)*$/i.exec(before);
    if (label && NAMED_LABEL.test(label[1])) continue;
    if (/\bcodes?[ -]+(?:review|reviews|standard|standards|policy|audit|coverage|quality|style|base|freeze|owner|owners|signing|ownership|health)\b[^:|]{0,20}[:|\-]?\s*$/i.test(before)) continue;
    const bare = /\b([a-z]+)\s*[:|\-]?\s*$/i.exec(before);
    if (alnum && bare && /^(?:exam|course|subject|model|part|lot|batch|sku|item|product|class|module|unit|room|flight|gate|seat|build|release|version)$/i.test(bare[1])) continue;
    if (FILE_NAMED.test(before) && !/\b(?:verification|otp|2fa|mfa|login|sign[- ]?in|one[- ]time|access|security|auth)\b/i.test(before.slice(-30))) continue;
    const next = /^[\s:,.)\-]*([A-Za-z][A-Za-z']*)/.exec(after)?.[1] ?? "";
    if (next && !AFTER_FUNC.test(next) && !/^(?:codes?|passcodes?|pins?|otps?|tokens?)$/i.test(next)) continue; // a count noun
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
