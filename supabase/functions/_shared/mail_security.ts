// What of the person's own inbox may reach a model prompt (find_email, career_mail_reply.ts). Code decides, before any model reads.
// Two layers, and the second never depends on the first or on any wording:
//   redactSecrets  applied to EVERY subject, snippet and body that is returned, in any language. Taken out: every link's path,
//                  query and fragment (the host stays); every standalone run of 4 or more digits, also when grouped by spaces or
//                  dashes, unless it is clearly money, a date, a time, a percentage, a phone number in the usual format or a
//                  postal code after a state; letter-and-digit codes; long key-shaped strings (API keys, tokens, JWTs); SSN-shaped
//                  numbers; IP addresses; and whatever follows "password", "passcode", "credentials" or "PIN" on its line.
//                  Zero-width and full-width characters are normalised first. Cost, accepted: a requisition number, an order
//                  number, a meeting id and a link's path are lost from ordinary mail too.
//   securityMail   whole-mail withholding for mail that is plainly a credential or account-security message (a code stated as
//                  one, a reset or sign-in link, an account alert, a known security sender). Narrow on purpose: a job about
//                  two-factor authentication, a recruiter at auth.acme.com or a line that only mentions a verification code is
//                  ordinary mail, and layer one has already taken any code out of it.
export const REMOVED = "[removed]";
export const normalise = (s: unknown) => String(s ?? "").normalize("NFKC").replace(/[\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "");

const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?`;
// Kept as they are (never a credential by their form): money, percentages, times, dates, a year in a date context, phone numbers
// in the usual format, a US postal code after its state.
const KEEP = new RegExp([
  String.raw`[$€£¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmM]\b)?`, String.raw`\b\d[\d,]*(?:\.\d+)?\s?(?:[kK]|[mM]|usd|eur|gbp|dollars|euros|pounds)\b`,
  String.raw`\b\d+(?:\.\d+)?\s?%`, String.raw`\b\d{1,2}:\d{2}(?::\d{2})?\b`,
  String.raw`\b\d{4}-\d{2}-\d{2}\b`, String.raw`\b\d{1,2}/\d{1,2}/\d{2,4}\b`, String.raw`\b\d{1,2}\.\d{1,2}\.\d{4}\b`,
  String.raw`\b${MONTH}\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?(?:19|20)\d{2}\b`, String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+${MONTH},?\s+(?:19|20)\d{2}\b`,
  String.raw`\b(?:in|since|of|by|from|until|through|during|before|after|spring|summer|fall|autumn|winter|early|late|fy|year)\s+(?:19|20)\d{2}\b`,
  String.raw`(?<![\d-])(?:\+?1[ .-]?)?(?:\(\d{3}\)\s?|\d{3}[ .-])\d{3}[ .-]\d{4}(?![\d-])`, String.raw`\+\d{1,3}(?:[ .-]?\d{2,4}){2,4}(?!\d)`,
  String.raw`\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b`,
].join("|"), "gi");
const URL = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
const SSN = /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g, IP = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;
const PASS_WORD = String.raw`pass(?:word|code|phrase)s?|pwd|credentials?|pin|contraseña|clave|mot de passe|passwort|kennwort|senha|пароль|密码|密碼|パスワード`;
// "password is ...", "Password: ...", "credentials are ...": everything after it on the line.
const PASS_LINE = new RegExp(String.raw`(?<![\p{L}])(${PASS_WORD})(?![\p{L}])(\s*(?:is|are|was|:|=|es|est|ist|lautet|é)(?![\p{L}])\s*)\S.*$`, "iu");
// "the passphrase correct-horse-battery": the one token after it, when it is not a plain word.
const PASS_NEXT = new RegExp(String.raw`(?<![\p{L}])(${PASS_WORD})\s+(?=\S*[\d\-_!@#$%^&*])(\S+)`, "giu");
const KEYS = [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bAKIA[0-9A-Z]{12,}/g, /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{4,})?/g, /\bBearer\s+\S+/g,
  /(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+/_=-]*\d)(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_=-]{20,}(?![A-Za-z0-9+/_=-])/g];
const DIGITS = /(?<![A-Za-z0-9])\d(?:[ -]?\d){3,}(?![A-Za-z0-9])/g;
// Letters and digits mixed, 5 to 12 characters: in capitals (X7K9-QP2M), in both cases (aB3dE9xQ), or interleaved (7f3k-9d2m).
const ALNUM = /(?<![A-Za-z0-9-])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?![A-Za-z0-9-])/g;
function codeLike(tok: string): boolean {
  const t = tok.replace(/-/g, "");
  if (t.length < 5 || t.length > 12 || !/\d/.test(t) || !/[A-Za-z]/.test(t)) return false;
  if (t === t.toUpperCase()) return true;
  if (/[a-z]/.test(t) && /[A-Z]/.test(t) && /\d.*\d/.test(t)) return true;
  return t.length >= 6 && /\d[a-z]+\d|[a-z]\d+[a-z]/i.test(t) && /\d.*\d/.test(t);
}

// A readable email with whatever could sign someone in, or identify an account, taken out.
export function redactSecrets(text: unknown): string {
  return normalise(text).split("\n").map((raw) => {
    const kept: string[] = [];
    const hold = (v: string) => `\u0001${kept.push(v) - 1}\u0001`;
    let out = raw.replace(URL, (u) => { const host = /^(?:https?:\/\/)?([^/?#:\s]+)/i.exec(u)?.[1] ?? ""; return hold(/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? (/^https?:/i.test(u) ? `${u.slice(0, u.indexOf("//") + 2)}${host}` : host) : REMOVED); });
    out = out.replace(PASS_LINE, (_m, w: string, sep: string) => `${w}${sep}${hold(REMOVED)}`).replace(PASS_NEXT, (_m, w: string) => `${w} ${hold(REMOVED)}`);
    for (const k of KEYS) out = out.replace(k, () => hold(REMOVED));
    out = out.replace(SSN, () => hold(REMOVED)).replace(IP, () => hold(REMOVED)).replace(KEEP, (v) => hold(v));
    out = out.replace(ALNUM, (t) => (codeLike(t) ? REMOVED : t)).replace(DIGITS, REMOVED);
    return out.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => kept[Number(i)]);
  }).join("\n");
}

// An address as it may be shown to a model or the person: a plain address with a short local part; otherwise only its host.
export function shownAddress(address: unknown): string {
  const a = normalise(address).trim().toLowerCase(), m = /^([a-z0-9._%+-]{1,64})@((?:[a-z0-9-]{1,63}\.)+[a-z]{2,24})$/.exec(a);
  if (!m) return "an unreadable address";
  return m[1].length <= 32 && !/\d{4}/.test(m[1]) && m[1].split(/[._+-]/).length <= 4 ? a : `an address at ${m[2]}`;
}

// ------------------------------------------------------------------------------------------------ whole-mail withholding
const SECURITY_SENDER = /^(?:no-?reply[-+._])?(?:account-?security|security|verify|verification|otp|2fa|mfa|password-?reset|fraud-?alerts?)(?:[-+._][a-z0-9._+-]*)?@|@(?:accounts\.google\.com|accountprotection\.microsoft\.com|id\.apple\.com|vtext\.com|txt\.att\.net|mms\.att\.net|tmomail\.net|vzwpix\.com|messaging\.sprintpcs\.com|msg\.fi\.google\.com)$/i;
const QUAL = String.raw`verification|verify|security|one[- ]?time|single[- ]use|log[- ]?in|sign[- ]?in|sign[- ]?on|authentication|auth|2fa|two[- ]?factor(?:\s+authentication)?|two[- ]?step|temporary|reset|access|confirmation`;
const CODE_PHRASE = new RegExp(String.raw`\b(?:${QUAL})\s+(?:pass)?(?:codes?|pins?|passwords?)\b|\botps?\b|\bone[- ]time\s+pass(?:words?|codes?)\b|\b(?:backup|recovery)\s+codes?\b|código de verificación|code de vérification|bestätigungscode|verifizierungscode|codice di verifica|código de verificação|验证码|驗證碼|認証コード|код подтверждения`, "i");
const SUBJECT_CODE = new RegExp(String.raw`${CODE_PHRASE.source}|\b(?:your|here'?s your)\s+(?:[a-z]+\s+){0,2}(?:code|pin)\b|\b\d{4,8}\b.{0,20}\bis your\b|\bcode\s*:\s*[\d-]{4,}`, "i");
const RESET = /\b(?:reset|recover|change|create\s+a\s+new|choose\s+a\s+new|set\s+a\s+new)\s+(?:your\s+|the\s+|my\s+)?(?:[a-z]+\s+){0,2}pass(?:word|code)\b|\bpassword\s+(?:reset|recovery|was\s+changed|has\s+been\s+changed)\b|\bforgot(?:ten)?\s+(?:your\s+)?password\b/i;
const SIGNIN = /\b(?:sign[- ]?in|log[- ]?in|magic)\s+link\b|\b(?:click|tap|use|follow)\b[^.\n]{0,40}\b(?:to\s+)?(?:sign|log)\s+in\b|\b(?:verify|confirm)\s+(?:that\s+)?(?:it'?s\s+you|your\s+(?:e-?mail(?:\s+address)?|(?:candidate\s+)?account|identity|device|phone(?:\s+number)?))\b|\bwas\s+used\s+to\s+sign\s+in\b/i;
const TWO_STEP = /\b(?:two|2)[- ]?(?:factor|step)\b|\b2fa\b|\bmfa\b|\bmulti[- ]factor\b|\bauthenticator\s+app\b/i;
const ALERT = /\bsecurity\s+(?:alert|notice|notification|warning)\b|\bnew\s+(?:sign[- ]?(?:in|on)|log[- ]?in)\b|\bnew\s+device\b[^.\n]{0,40}\b(?:sign|log|account)|\b(?:unusual|suspicious|unrecogni[sz]ed|unauthori[sz]ed)\s+(?:sign[- ]?in|log[- ]?in|activity|device|access|transaction|charge|attempt)\b|\byour\s+account\s+(?:was|has\s+been|is)\s+(?:accessed|locked|suspended|compromised|restricted)\b|\bfraud\s+(?:alert|protection|department)\b|\b(?:account|transaction|payment|withdrawal|wire|transfer|deposit|balance)\s+alert\b(?!-)/i;
const MONEY_ALERT = /\b(?:transaction|payment|withdrawal|wire|transfer|deposit|balance|charge|purchase)\b[^\n]{0,80}(?:[$€£]\s?\d|\bending\s+(?:in\s+)?\d{4})|\b(?:card|account)\s+ending\s+(?:in\s+)?\d{4}\b/i;
// What a real security mail does and a recruiter's sentence about the subject does not: tells you to act on it now.
const ACT = /\bclick\b|\btap\b|\blink\b|\bbutton\b|\bbelow\b|https?:\/\/|\bexpires?\b|\bvalid\s+for\b|\bdo(?:n'?t|\s+not)\s+share\b|\bnever\s+(?:share|ask)\b|\bdid(?:n'?t|\s+not)\s+request\b|\bwas(?:n'?t|\s+not)\s+you\b|\bignore\s+this\s+e-?mail\b|\breply\s+(?:yes|no|fraud|stop)\b|\bcall\s+the\s+number\b/i;
const TOKEN = String.raw`(?:[A-Za-z]{1,3}-)?\d(?:[ -]?\d){3,9}|[A-Za-z0-9]{2,6}-[A-Za-z0-9]{2,6}`;
const ASSERTED = new RegExp(String.raw`(?:${CODE_PHRASE.source})[^.!?\n]{0,60}?(?:\bis\b|:|=|\blautet\b|\bes\b|\best\b)\s*(?:${TOKEN})|(?<![\d$€£.,/:-])\d(?:[ -]?\d){3,9}(?![\d%/:])[^.!?\n]{0,30}\bis\s+your\b[^.!?\n]{0,40}\b(?:code|otp|pin|passcode)\b`, "i");
const PLAIN_CODE = /(?<!\b(?:zip|postal|area|dress|job|promo|coupon|discount|referral|reference|requisition|req|country|source|qr|bar|team|honor|building|door|gate|parking|event|course|class|project|product|booking|order|tracking)\s)\b(?:code|otp|pin|passcode)\b[^.!?\n]{0,60}?(?<![\d$€£.,/:-])\d(?:[ -]?\d){3,9}(?![\d%/:])/i;
const MEETING = /\b(?:zoom|meeting|webinar|teams|webex|google\s+meet|dial[- ]in|conference)\b/i;

// True when the email is a credential or account-security message whose text is withheld whole.
export function securityMail(m: { from: string; subject: string; text: string }): boolean {
  const from = normalise(m.from).trim().toLowerCase(), subject = normalise(m.subject).replace(/[\u2018\u2019`]/g, "'"), body = normalise(m.text).replace(/[\u2018\u2019`]/g, "'");
  if (SECURITY_SENDER.test(from)) return true;
  // The subject of a security mail says what it is.
  if (SUBJECT_CODE.test(subject) || RESET.test(subject) || SIGNIN.test(subject) || ALERT.test(subject) || /\bconfirm\s+it'?s\s+you\b/i.test(subject) || (TWO_STEP.test(subject) && /\bcodes?\b/i.test(subject))) return true;
  const all = `${subject}\n${body}`, acts = ACT.test(all);
  // A code stated as a code ("your verification code is 482913"), in any sentence.
  if (ASSERTED.test(body)) return true;
  if (MONEY_ALERT.test(all) && ALERT.test(all)) return true;
  // Reset, sign-in, two-step and alert wording counts in the body only when the email also tells the reader to act on it.
  if (acts && (RESET.test(body) || SIGNIN.test(body) || ALERT.test(body) || (TWO_STEP.test(body) && /\bcodes?\b/i.test(body)))) return true;
  // A plain "code" with digits counts when the email treats it as a secret, and it is not a meeting's passcode.
  if (acts) for (const line of body.split(/\n+/)) if (PLAIN_CODE.test(line) && !MEETING.test(line)) return true;
  return false;
}
