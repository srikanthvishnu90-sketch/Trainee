// What of the person's own inbox may reach a model prompt (find_email, career_mail_reply.ts). Code decides, before any model reads:
//   securityMail   one-time codes, verification and sign-in mail, password resets, two-step and account or bank security alerts:
//                  the body, snippet and subject are withheld; the model is told only that a security email from X was found.
//   redactSecrets  in every other email: a code-like token next to a code word, a password given in the text, and a link that
//                  signs in, resets, verifies or carries a token are replaced by a marker.
// Recruiter and employer mail stays readable: a meeting passcode, a job or requisition code, a zip code and a date are not secrets.
const SECURITY_SENDER = /^(?:no-?reply[-+._]?)?(?:account-?security|security(?:-?(?:alerts?|noreply))?|verify|verification|otp|2fa|mfa|password|passwordreset|identity|fraud(?:-?alerts?)?|login|signin|sign-in|auth)(?:[-+._][a-z0-9]+)*@|@(?:accounts|account|security|login|auth|id|verify)\.[a-z0-9.-]+$/i;
// A code word that only a credential uses.
const STRONG = /\b(?:verification|verify|security|one[- ]?time|single[- ]use|log[- ]?in|sign[- ]?in|authentication|auth|2fa|two[- ]?factor|two[- ]?step|otp|temporary|reset)\s+(?:pass)?(?:codes?|pins?|passwords?)\b|\botps?\b|\bone[- ]time\s+pass(?:words?|codes?)\b|\b(?:code|pin)\s+(?:to|for)\s+(?:sign|log|verif|confirm\s+(?:it'?s|your\s+identity))/i;
const RESET = /\b(?:reset|recover|change|create\s+a\s+new|choose\s+a\s+new|set\s+a\s+new)\s+(?:your\s+|the\s+|my\s+)?(?:[a-z]+\s+){0,2}pass(?:word|code)\b|\bpassword\s+(?:reset|recovery|change[d]?|was\s+changed|has\s+been\s+changed)\b|\bforgot(?:ten)?\s+(?:your\s+)?password\b/i;
const SIGNIN = /\b(?:sign[- ]?in|log[- ]?in|magic)\s+link\b|\b(?:click|tap|use|follow)\b[^.\n]{0,40}\b(?:to\s+)?(?:sign|log)\s+in\b[^.\n]{0,40}\b(?:link|button|below|here)\b|\b(?:verify|confirm)\s+(?:that\s+)?(?:it'?s\s+you|your\s+(?:e-?mail(?:\s+address)?|account|identity|device|phone(?:\s+number)?))\b/i;
const TWO_STEP = /\b(?:two|2)[- ]?(?:factor|step)\b|\b2fa\b|\bmfa\b|\bmulti[- ]factor\b|\bauthenticator\s+app\b|\bbackup\s+codes?\b|\brecovery\s+codes?\b/i;
const ALERT = /\bsecurity\s+(?:alert|notice|notification|warning)\b|\bnew\s+(?:sign[- ]?in|log[- ]?in|device)\b|\b(?:unusual|suspicious|unrecogni[sz]ed|unauthori[sz]ed)\s+(?:sign[- ]?in|log[- ]?in|activity|device|access|transaction|charge|attempt)\b|\byour\s+account\s+(?:was|has\s+been|is)\s+(?:accessed|locked|suspended|compromised|restricted)\b|\bfraud\s+(?:alert|protection|department)\b|\b(?:transaction|payment|withdrawal|wire|transfer|deposit|balance)\s+alert\b|\b(?:card|account)\s+ending\s+(?:in\s+)?\d{4}\b/i;
const NOT_SECRET = String.raw`(?<!\b(?:zip|postal|area|dress|job|promo|coupon|discount|referral|reference|requisition|req|country|source|qr|bar|team|honor|building|door|gate|parking|meeting|zoom|conference|dial-in|event|course|class|project|product|booking|order|tracking)\s)`;
const CODE_TOKEN = String.raw`(?:[A-Z]{1,3}-)?\d(?:[ -]?\d){3,7}`;
const NEAR_CODE = new RegExp(String.raw`${NOT_SECRET}\b(?:code|otp|pin|passcode)\b[^\n]{0,60}?(?<![\d$€£.,/:-])(${CODE_TOKEN})(?![\d%/:]|\s*(?:am|pm|usd|dollars|years|people)\b)|(?<![\d$€£.,/:-])(${CODE_TOKEN})(?![\d%/:])[^\n]{0,30}\bis\s+your\b[^\n]{0,40}\b(?:code|otp|pin|passcode)\b`, "i");
const URGENT = /\bexpires?\b|\bvalid\s+for\b|\bdo(?:n'?t|\s+not)\s+share\b|\bnever\s+share\b|\bdid(?:n'?t|\s+not)\s+request\b|\bwasn'?t\s+you\b|\bif\s+this\s+was(?:n'?t|\s+not)\s+you\b/i;
const MEETING = /\b(?:zoom|meeting|webinar|teams|webex|google\s+meet|dial[- ]in|conference|calendar\s+invite|interview\s+link)\b/i;

// True when the email is a credential or account-security message whose text must never reach a model.
export function securityMail(m: { from: string; subject: string; text: string }): boolean {
  const from = String(m.from ?? "").trim().toLowerCase(), all = `${String(m.subject ?? "")}\n${String(m.text ?? "")}`.replace(/[‘’`]/g, "'");
  if (SECURITY_SENDER.test(from)) return true;
  if (RESET.test(all) || SIGNIN.test(all) || TWO_STEP.test(all) || ALERT.test(all)) return true;
  if (STRONG.test(all)) return true;
  // A plain "code" with digits counts when the email treats it as a secret, and it is not a meeting's passcode.
  for (const line of all.split(/\n+/)) if (NEAR_CODE.test(line) && !MEETING.test(line) && URGENT.test(all)) return true;
  return false;
}

export const CODE_REMOVED = "[code removed]", LINK_REMOVED = "[link removed]", PASSWORD_REMOVED = "[password removed]";
const SECRET_LINK = /https?:\/\/[^\s<>"')\]]*(?:reset|verif|confirm|sign-?in|log-?in|magic|oauth|authori[sz]e|\bauth\b|password|passwd|otp|activate|recover|unlock|session|[?&#](?:token|code|key|sig|signature|auth|otp|secret|ticket|jwt|access_token|id_token)=)[^\s<>"')\]]*/gi;
const PASSWORD_GIVEN = /\b(pass(?:word|code)|pwd)\s*(?:is|:|=)\s*\S{4,}/gi;
// A readable email with whatever could still sign someone in taken out.
export function redactSecrets(text: unknown): string {
  return String(text ?? "").split("\n").map((line) => {
    let out = line.replace(SECRET_LINK, LINK_REMOVED);
    if (!MEETING.test(out)) {
      out = out.replace(PASSWORD_GIVEN, (_m, w) => `${w}: ${PASSWORD_REMOVED}`);
      for (let i = 0; i < 4; i++) {
        const m = NEAR_CODE.exec(out), tok = m?.[1] ?? m?.[2];
        if (!m || !tok) break;
        out = out.replace(tok, CODE_REMOVED);
      }
    }
    return out;
  }).join("\n");
}
