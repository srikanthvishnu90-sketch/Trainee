// Identity digits never reach storage or a model (owner rule: never store OTPs, passwords or identity digits). Found by
// the testing agent (evals/agent/run.ts, O-20): "my ssn is 123-45-6789, send mike 40" was saved word for word into
// agent_messages and sent to the model. The chat input is redacted before anything else sees it; the person is told what
// was removed, and the rest of the message is still answered.
//   - a Social Security number: 3-2-4 digits with dashes or spaces, or 9 digits right after "ssn", "social security",
//     "itin" or "tax id"
//   - a card number: 13 to 19 digits (spaces, dashes or dots allowed) that pass the Luhn check, unless an order, job or
//     other reference label sits right before it; and 13 to 19 digits labeled as a card ("card", "visa", "amex", "cc#",
//     "debit", "credit") even when they fail the check (a mistyped card number is still a card number)
//   - an account or routing number: 6 to 17 digits right after "account", "acct", "routing" or "aba"
//   - a password (owner, 2026-10-11: secrets never travel through chat, decision 1): the word after "password is",
//     "password:", "pw =", "passcode is" (unless it describes the password: "my password is wrong"), or a value with a
//     digit or symbol a few words after "password ... is" ("my robinhood password is hunter2"); also "pass=", "pass:",
//     "password's", "password - x", "the password for workday is x", "use x as the password", a bare "pw x" or
//     "password x" when x has a digit or symbol or a sign-in label is beside it ("username alex password x"), and the
//     part after the slash in a sign-in pair ("login is alex / x", "creds: alex/x")
//   - a labeled one-time code ("my 2fa code is 482913", "otp: 482913", "code is 4821", "the code they texted me is
//     482-913", "pin: 4821"), never a zip, area, promo, course, error or other named code; and a card security code
//     ("cvv 123")
//   (scenarios-secrets.test.ts runs thousands of generated phrasings and controls through this.)
// Phone numbers (3-3-4), dates, amounts, order ids and a bare code are left alone (a bare code answers a paused
// cancellation once and is withheld from storage by the handler).
export type Redaction = { text: string; removed: ("ssn" | "card" | "account" | "password" | "code")[] };

const SSN_SHAPED = /\b(?<!\d[- ])\d{3}[- ]\d{2}[- ]\d{4}\b(?![- ]\d)/g;
const SSN_LABELED = /\b(ssn|social security(?: number| no\.?| #)?|itin|tax id(?: number)?)(\s*(?:is|=|:|#)?\s*)(\d{9})\b/gi;
const ACCOUNT_LABELED = /\b(account|acct|routing|aba)(\s*(?:number|no\.?|#)?\s*(?:is|=|:|#)?\s*)(\d{6,17})\b/gi;
const CARD_CANDIDATE = /(?<!\d[.,-]?)(?<![.,]\d*)\b(?:\d(?:[ -]?\d){12,18}|\d{4}\.\d{4}\.\d{4}\.\d{4}(?:\.\d{1,3})?|\d{4}\.\d{6}\.\d{5})\b(?![.,-]?\d)(?!-?[0-9a-f]{2,})/gi;
const CARD_LABELED = /\b(card|visa|amex|american express|mastercard|master card|discover|cc#?|debit|credit)(\s*(?:card)?\s*(?:number|no\.?|num|#)?\s*(?:is|=|:|#)?\s*)(\d(?:[ .-]?\d){12,18})\b(?![.,-]?\d)(?!-?[0-9a-f]{2,})/gi;
// A reference right before the digits: an order, confirmation or tracking number, or a job, posting or application id.
const REFERENCE_BEFORE = /\b(?:order|confirmation|conf|ref|reference|tracking|invoice|case|ticket|job|posting|requisition|req|application|applicant|candidate|employee|student)\s*(?:id|number|no\.?|#)?\s*(?:is\s*)?[:#]?\s*$/i;
const PW_WORD = String.raw`(?:password|passwd|passcode|passphrase|pwd|pw)`;
// The word right after "password is" is the password, unless it describes it ("my password is wrong").
const NOT_A_PASSWORD = /^(?:wrong|incorrect|expired|invalid|not|too|the|a|an|my|same|correct|right|saved|stored|reset|changed|locked|weak|strong|missing|required|needed|forgotten|case|different|new|old|long|short|fine|ok|okay|working|broken|blocked|bad|good|stuck|gone|compromised|leaked|hacked)$/i;
const PASSWORD_LABELED = new RegExp(String.raw`\b(${PW_WORD})(\s*(?:is|was|=|:)\s*)("[^"\n]+"|'[^'\n]+'|\S{3,})`, "gi");
const PASSWORD_LOOSE = new RegExp(String.raw`\b(${PW_WORD}\b(?!\s+(?:managers?|policy|policies|requirements?|rules?|hint|field|strength|reset|vault|app)\b)[^.\n]{1,40}?\s(?:is|=|:)\s*)(\S*[\d!@#$%^&*_+=?~]\S*)`, "gi");
// "password's x", "password - x", "pass=x", "pass: x", "the password for workday is x", "use x as the password".
const PASSWORD_SEP = new RegExp(String.raw`\b(${PW_WORD}(?:'s|’s)\s+|${PW_WORD}\s+[-–—]\s+|(?<!\b(?:first|second|third|final|last|another|quick|one|boarding|bus|hall|day|season|free|your|a|the|const|let|var|q|x)\s*\.?\s*)\bpass\s*[:=]\s*)("[^"\n]+"|'[^'\n]+'|\S{3,})`, "gi");
const PASSWORD_FOR = new RegExp(String.raw`\b(${PW_WORD}\s+(?:for|to|of|on)\s+[^.\n]{1,40}?\s(?:is|=|:)\s*)("[^"\n]+"|'[^'\n]+'|\S{3,})`, "gi");
const PASSWORD_AS = new RegExp(String.raw`\b(use|using|it's|its|it is)(\s+)(\S{3,})(?=\s+as\s+(?:the|my|a)\s+${PW_WORD}\b)`, "gi");
// A bare "pw x" / "password x": x is the password when it has a digit or symbol, or a sign-in label or "my password"
// is beside it ("username alex password x", "here's my password x"); never a word about the password.
const PASSWORD_BARE = new RegExp(String.raw`(?<![\[-])\b(${PW_WORD})([ \t]+)(\S{3,})`, "gi");
// Right before it: a user name ("username alex password x", "login: alex pw x") or "my" ("here's my password x").
const SIGN_IN_NEAR = /(?:(?:\buser ?name\b(?:\s+for\s+[^:\n]{1,25})?\s*[:=]?\s*\S+|\b(?:user|login|log-in|email|e-mail)\b(?:\s+for\s+[^:\n]{1,25})?\s*(?:[:=]|\bis\b)\s*\S+|\b(?:user|login|email)\s+\S*[@._\d]\S*)\s*,?\s*(?:and\s+)?$|(?:^|[^\w'])my\s+(?:[a-z]+\s+)?$)/i;
const NOT_A_BARE_PASSWORD = /^(?:is|was|for|to|of|on|in|at|and|or|the|a|an|my|your|his|her|their|our|manager|managers|reset|resets|field|fields|here|please|that|this|it|you|i|we|they|again|change|changed|changes|update|updated|recovery|requirements?|rules?|policy|hint|protected|link|email|page|screen|box|prompt|expired|expires|works|worked|doesn't|didn't|isn't|won't|wont|doesnt|didnt|keeps|stopped|needs|has|had|got|will|should|must|can|could|would|might|may|did|does|do|so|but|if|when|because|since|after|before|with|without|too|now|yet|still|then|anymore|either|via|from|by|as|be|being|been|are|were|went|ever|never|yesterday|today|tonight|tomorrow|recently|already|last|earlier|lately|twice|once|removed\]?)$/i;
// "login is alex / x", "creds: alex/x", "sign in with alex@x.edu / x": the part after the slash.
// The label is followed by its value ("login is", "login:", "login for the portal:"); "login/signup pages" and "user
// research / design" are no pair.
const SIGN_IN_WAY = /^(?:sso|saml|oauth2?|openid|oidc|google|apple|github|gitlab|microsoft|azure|okta|facebook|linkedin|email|phone|sms|passkeys?|face ?id|touch ?id|biometrics?|magic link|ldap|kerberos|face|fingerprint|pin|device|passcode|password|touch|voice)$/i;
const SIGN_IN_PAIR = /\b(login|log-in|sign[- ]?in with|creds|credentials|user ?name)((?:\s+(?:for|to|on)\s+[^/:\n]{1,30}?)?\s*(?:\bis\b|\bare\b|=|:|-)\s*|(?<=with)\s+)([^\s/:]+\s*\/\s*)([^\s/]{3,})/gi;
const CODE_LABELED = /\b((?:one[- ]time|verification|security|sign[- ]?in|login|log[- ]in|2fa|mfa|otp|auth(?:entication)?)\s*(?:code|pin|passcode|number)?)(\s*(?:is|=|:|#)?\s*)(\d(?:[ -]?\d){3,7})\b/gi;
// "code is 4821", "here's the code: 482 913", "sms code 4821", "pin: 4821", "the code they texted me is 482-913": a code or
// PIN, unless the code is named as something else (a zip, area, promo, course, error, referral ... code).
const NAMED_CODE = String.raw`(?<!\b(?:zip|postal|post|area|country|promo|promotional|discount|coupon|referral|course|class|error|status|dial|tax|product|source|job|dress|invite|invitation|gift|reference|ref|airport|naics|sic|cpt|icd|sort|swift|bank|routing|color|colour|style|item|sku|morse|qr|bar|req|requisition|position|posting|role|department|dept|cost|budget|project|program|module|unit|soc|fips|vendor|supplier|ticket|order|voucher|offer|event|building|naics|source|zip\+4)[\s-])`;
const CODE_ANY = new RegExp(String.raw`${NAMED_CODE}\b(code|pin(?: code| number)?)(\s*(?:\bis\b|=|:|#)\s*|\s+)(\d(?:[ -]?\d){3,7})\b(?![-.\/]?\d)`, "gi");
const CODE_LOOSE = new RegExp(String.raw`${NAMED_CODE}\b(code\b[^.\n\d]{1,40}?\s(?:is|was|=|:)\s*)(\d(?:[ -]?\d){3,7})\b(?![-.\/]?\d)`, "gi");
const DATE_LIKE = /^(?:19|20)\d\d-\d\d?-\d\d?$/;
const CVV_LABELED = /\b(cvv2?|cvc2?|csc)(\s*(?:code|number)?\s*(?:is|=|:)?\s*)(\d{3,4})\b/gi;

function luhn(digits: string) {
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

// WO-100: while an employer's emailed code is waiting (career_situation.ts codePending), a bare 6-8 digit number is that
// code, so it is removed too ("Plaid emailed me a code, it's 482913"). Never otherwise: a bare number stays a number.
const BARE_CODE = /(?<![\d$€£.,:/#-])\b\d{6,8}\b(?![\d.,:/-]|\s*(?:k\b|%|usd|dollars|a year|per\b|\/))/gi;
export function redactIdentity(input: string, o: { codePending?: boolean } = {}): Redaction {
  const removed = new Set<Redaction["removed"][number]>();
  let t = String(input ?? "");
  t = t.replace(SSN_LABELED, (_m, label, sep) => { removed.add("ssn"); return `${label}${sep}[SSN removed]`; });
  t = t.replace(SSN_SHAPED, () => { removed.add("ssn"); return "[SSN removed]"; });
  // An order, confirmation or tracking number is a reference, not a card, even when its digits happen to pass Luhn.
  t = t.replace(CARD_CANDIDATE, (m, at: number, all: string) => { const d = m.replace(/\D/g, ""); if (d.length < 13 || d.length > 19 || !luhn(d) || REFERENCE_BEFORE.test(all.slice(Math.max(0, at - 30), at))) return m; removed.add("card"); return "[card number removed]"; });
  t = t.replace(CARD_LABELED, (_m, label, sep) => { removed.add("card"); return `${label}${sep}[card number removed]`; });
  t = t.replace(ACCOUNT_LABELED, (_m, label, sep) => { removed.add("account"); return `${label}${sep}[number removed]`; });
  t = t.replace(PASSWORD_LABELED, (m, label, sep, value: string) => {
    if (NOT_A_PASSWORD.test(value.replace(/[.,!?;]+$/, "")) || value.startsWith("[")) return m;
    removed.add("password"); return `${label}${sep}[password removed]`;
  });
  t = t.replace(PASSWORD_LOOSE, (m, lead, value: string) => { if (value.startsWith("[")) return m; removed.add("password"); return `${lead}[password removed]`; });
  const pw = (m: string, lead: string, value: string) => {
    if (value.startsWith("[") || NOT_A_PASSWORD.test(value.replace(/[.,!?;]+$/, ""))) return m;
    removed.add("password"); return `${lead}[password removed]`;
  };
  t = t.replace(PASSWORD_SEP, (m, lead: string, value: string, at: number, all: string) => {
    if (/^pass/i.test(lead) && !/[\d!@#$%^&*_+=?~]/.test(value.replace(/^[^\w]+/, "").replace(/[.,!?;:]+$/, ""))
      && !SIGN_IN_NEAR.test(all.slice(Math.max(0, at - 40), at)) && !/^\s*(?:(?:ok|okay|fyi|btw|and|my)[\s,:]+)*$/i.test(all.slice(0, at))) return m;
    return pw(m, lead, value);
  }).replace(PASSWORD_FOR, pw);
  t = t.replace(PASSWORD_AS, (m, verb, sp, value: string) => { if (value.startsWith("[")) return m; removed.add("password"); return `${verb}${sp}[password removed]`; });
  t = t.replace(SIGN_IN_PAIR, (m, label, gap, user: string, value: string) => {
    // A date or a fraction ("my login from 10/29") is no sign-in pair.
    const u = user.replace(/\s*\/\s*$/, "");
    if (value.startsWith("[") || /^\d+$/.test(u) && /^\d+[.,!?;]*$/.test(value) || /^https?$/i.test(u)) return m;
    // "sign in with SSO / SAML", "sign in with Google / Apple": ways to sign in, not a user name and password.
    if (/with$/i.test(label) && [u, value.replace(/[.,!?;]+$/, "")].some((x) => SIGN_IN_WAY.test(x))) return m;
    removed.add("password"); return `${label}${gap}${user}[password removed]`;
  });
  t = t.replace(CODE_LABELED, (_m, label, sep) => { removed.add("code"); return `${label}${sep}[code removed]`; });
  t = t.replace(CODE_ANY, (m, label, sep, code: string) => { if (DATE_LIKE.test(code)) return m; removed.add("code"); return `${label}${sep}[code removed]`; });
  t = t.replace(CODE_LOOSE, (m, lead, code: string) => { if (DATE_LIKE.test(code)) return m; removed.add("code"); return `${lead}[code removed]`; });
  t = t.replace(PASSWORD_BARE, (m, label, sp, value: string, at: number, all: string) => {
    const word = value.replace(/[.,!?;:]+$/, "");
    if (value.startsWith("[") || /[<>]/.test(value) || /^(?:is|was|=|:|-|–|—)$/.test(word) || NOT_A_BARE_PASSWORD.test(word) || NOT_A_PASSWORD.test(word)) return m;
    const strong = /[\d!@#$%^&*_+=?~]/.test(word.replace(/^[^\w]+/, ""));
    // "pw x" and "pwd x" are always a password; "password x" when x looks like one or a sign-in label is beside it.
    if (!strong && !/^pwd?$/i.test(label) && !SIGN_IN_NEAR.test(all.slice(Math.max(0, at - 40), at))) return m;
    removed.add("password"); return `${label}${sp}[password removed]`;
  });
  t = t.replace(CVV_LABELED, (_m, label, sep) => { removed.add("card"); return `${label}${sep}[security code removed]`; });
  if (o.codePending) t = t.replace(BARE_CODE, () => { removed.add("code"); return "[code removed]"; });
  return { text: t, removed: [...removed] };
}

const NAMES = { ssn: "Social Security number", card: "card number", account: "account number", password: "password", code: "one-time code" } as const;
export function redactionNote(removed: Redaction["removed"]): string | null {
  if (!removed.length) return null;
  const what = removed.map((r) => NAMES[r]);
  const list = what.length === 1 ? what[0] : `${what.slice(0, -1).join(", ")} and ${what[what.length - 1]}`;
  // A password or code also gets the way it should go: never in a message, only on the company's own page or the secure link.
  const how = removed.some((r) => r === "password" || r === "code") ? " Never send passwords or codes in a message: you sign in yourself on the company's own page, and anything else sensitive goes on Upmore's secure link." : "";
  return `(I removed the ${list} from your message and didn't keep it. Upmore never needs it here.)${how}`;
}
