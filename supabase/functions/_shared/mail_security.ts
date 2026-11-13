// What of the person's own inbox may reach a model prompt (find_email, career_mail_reply.ts), and what may never leave in a reply.
// Code decides, before any model reads. Three layers (review of PR #820, round 3: wording rules cannot find every secret, and
// removing every number destroys what recruiter mail is for):
//   securityMail   whole-mail withholding for mail that is plainly a credential or account-security message (a code stated as
//                  one, a reset or sign-in link, an account alert, a known security sender): its body is never returned.
//   redact         HIGH-PRECISION removal from every other subject, snippet and body: (a) a code-like token (digits in any
//                  script, spaced or dashed; a letters-and-digits code; a run of number words) within about eight words of a code
//                  cue in any of the common languages; (b) links: the query and fragment always go; a meeting, scheduling, test or
//                  job link on a known host keeps its path; any other link that carries a token in its query or path, or whose
//                  path asks to sign in, reset or verify, keeps only its host; custom schemes (otpauth://) go whole; (c) secrets by
//                  shape wherever they are: PEM blocks, JWTs, vendor key prefixes, long mixed base32/base64/hex runs, cards that
//                  pass Luhn, IBANs that pass mod 97, SSNs, a phrase after "recovery phrase"; (d) the one token after a password,
//                  passcode, PIN or credentials cue, and "login: X / Y" shapes. Kept: money (a currency mark, or a pay word in the
//                  sentence), dates, times, years, percentages, phone numbers, addresses, postal codes, and ids named as ids.
//                  It returns what it removed, so the turn can refuse to send it (below), and never stores it.
//   output guard   mentionsRemoved / codeInReply: a reply that would carry a removed or withheld token, or a code next to a code
//                  cue, is refused (career_mail_reply.ts draftReply) or stripped (agent/loop.ts, the chat reply).
// What still gets through, by design: a code with no cue anywhere near it ("Type 48291377 into the app"), a password written
// without any password word, words that are a secret only by meaning (a seed phrase with no cue, a security answer in prose).
// Those reach the model as text; the output guard still refuses a reply that pairs a code-like token with a code cue.
export const REMOVED = "[removed]";
// Zero-width, bidi and emoji-keycap marks go; full-width, circled and superscript forms become their plain letters and digits.
export const normalise = (s: unknown) => String(s ?? "").normalize("NFKC").replace(/[\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufe0e\ufe0f\u20e3]/g, "")
  .replace(/<\/?(?:b|i|u|em|strong|span|font|small|big|code|tt|mark|sup|sub)\b[^<>]{0,200}>/gi, "");
export type Removed = { kind: "code" | "secret" | "link"; token: string };

// ------------------------------------------------------------------------------------------------ (a) code-like tokens near a cue
const NUMBER_WORD = String.raw`(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|null|eins|zwei|drei|vier|f[uü]nf|sechs|sieben|acht|neun|z[eé]ro|un|deux|trois|quatre|cinq|sept|huit|neuf|\d)`;
const WORD_RUN = new RegExp(String.raw`(?<![\p{L}\p{Nd}])${NUMBER_WORD}(?:[\s,-]+${NUMBER_WORD}){3,}(?![\p{L}\p{Nd}])`, "giu");
// Digits in any script, single separators between them (a space, dash, dot, slash, underscore, comma or colon).
const DIGIT_RUN = /(?<![\p{L}\p{Nd}])(?<!\p{L}-)\p{Nd}(?:[ \-./_,:]?\p{Nd}){2,18}(?![\p{L}\p{Nd}])/gu;
const ALNUM = /(?<![\p{L}\p{Nd}-])(?=[\p{L}\p{Nd}-]*\p{Nd})(?=[\p{L}\p{Nd}-]*\p{L})[\p{L}\p{Nd}]+(?:-[\p{L}\p{Nd}]+)*(?![\p{L}\p{Nd}-])/gu;
// Cues with word edges (Latin, Cyrillic) and without (scripts written without spaces, or with attached prefixes).
const CUE_WORDS = String.raw`codes?|otps?|passcodes?|pass\s+codes?|passwords?|passwd|pwd|pins?|verification|verify|verifying|one[- ]?time|2fa|mfa|two[- ]?(?:factor|step)|authenticat\w*|log[- ]?in|sign[- ]?in|sign[- ]?on|unlock|digits|tokens?|cvv|cvc|ssn|social\s+security|routing|account\s+(?:no|number|#)|acct|accounts?|cards?|iban|sort\s+code|combination|access\s+(?:code|number)|keys?|passport|zugang|zugangsdaten|acceso|acc[eè]s|clave|contrase[nñ]a|c[oó]digo|verificaci[oó]n|code\s+de\s+v[eé]rification|mot\s+de\s+passe|best[aä]tigungscode|zugangscode|kennwort|passwort|senha|код|пароль`;
const CUE_BARE = String.raw`验证码|驗證碼|密码|密碼|認証コード|確認コード|パスワード|暗証番号|入力|인증번호|비밀번호|رمز|کد|קוד|סיסמה|รหัส|कोड|पासवर्ड|ओटीपी`;
const CUE = new RegExp(String.raw`(?<![\p{L}])(?:${CUE_WORDS})(?![\p{L}])|${CUE_BARE}`, "giu");
// "Enter", "type", "paste": a code only right after them (two words at most), and never a date, a year, money, a phone or an address.
const IMPERATIVE = /(?<![\p{L}])(?:enter|type|paste|input|key\s+in|introduce|introduzca|ingresa|ingrese|escribe|saisissez|tapez|eingeben|geben\s+sie)(?![\p{L}])/giu;
// A "code" that is not a credential: zip code, dress code, job code, code of conduct ...; a PIN or key used as an ordinary word.
const NOT_CUE_BEFORE = /(?:zip|postal|area|country|dress|job|promo|coupon|discount|referral|reference|source|qr|bar|event|course|class|project|product|tracking|honor|honour|building|team|style|tax|sic|naics|program|programme|error|status|morse|da|de|the\s+key|key)\s*$/i;
const NOT_CUE_AFTER = /^\s*(?:bonus|bonuses|sheet|desk|form|of\s+conduct|review|base|reviews|pad|point|points|note|takeaways?|dates?|people|person|players?|skills?|areas?|metrics?|results?|responsibilities|stakeholders?|accounts?\s+(?:manager|executive)|this|that|it|to\s+(?:your|the)\s+calendar|board|insight)\b/i;
// The token itself is not a credential: an id named as an id, money, a date, a time, a year, a percentage, a phone, a postal code.
const ID_BEFORE = /(?:\b(?:req|requisition|job|id|ids|ref|reference|confirmation|conf|application|app|candidate|order|ticket|case|invoice|booking|employee|flight|room|suite|building|floor|ext|extension|meeting|conference|webinar|zip|postal|course|class|policy|claim|member|student|registration|item|model|version|v|chapter|page|step|round|level|grade|unit|seat|req\.?\s*#|#)\s*(?:id|no\.?|number|#|is)?\s*[:#]?\s*)$/i;
const PAY = /\b(?:salary|salaries|base|bonus|bonuses|stipend|rate|rates|compensation|comp|pay|paid|offer|offering|per\s+(?:year|annum|month|hour|week)|annual|annually|hourly|monthly|\/yr|\/hr|\/year|\/hour|ctc|lpa|equity|rsus?|options|relocation|allowance|reimburse\w*|budget|sign-on\s+bonus|raised|grant|usd|eur|gbp|inr|dollars|euros|pounds)\b|[$€£¥₹]/i;
const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?`;
function keepToken(tok: string, before: string, after: string, sentence: string, cueGap: number): boolean {
  const t = tok.trim(), digits = t.replace(/\D/g, "");
  if (ID_BEFORE.test(before)) return true;
  if (/^\s*%/.test(after) || /^\s?(?:k|m|mn|bn|usd|eur|gbp|inr|dollars|euros|pounds|lpa|per\b)/i.test(after)) return true;
  if (/[$€£¥₹]\s?$/.test(before) && (/[,.]\d/.test(t) || PAY.test(sentence.replace(/[$€£¥₹]/g, "")))) return true;
  if (!/[$€£¥₹]\s?$/.test(before) && PAY.test(sentence) && /^\d[\d,. ]*$/.test(t) && cueGap > 1) return true;
  const dm = /^(\d{1,4})[-./](\d{1,2})[-./](\d{1,4})$/.exec(t);
  if (dm) { const [a, b, c] = [Number(dm[1]), Number(dm[2]), Number(dm[3])]; if ((a <= 31 && b <= 12) || (a <= 12 && b <= 31) || (a > 1900 && b <= 12 && c <= 31)) return true; }
  if (/^\d{1,2}[/.]\d{1,2}$/.test(t) && Number(t.split(/[/.]/)[0]) <= 31 && Number(t.split(/[/.]/)[1]) <= 31) return true;
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(t) && Number(t.split(":")[0]) < 24 && Number(t.split(":")[1]) < 60) return true;
  if (/^\d{3,4}$/.test(t) && /^\s*(?:h|hrs?|hours?|ist|gmt|utc|[a-z]{1,2}t)\b/i.test(after) && Number(t.slice(0, -2)) < 24 && Number(t.slice(-2)) < 60) return true;
  if (/^(?:19|20)\d{2}$/.test(t) && cueGap > 2) return true;
  if (new RegExp(String.raw`${MONTH}\s*$`, "i").test(before) || new RegExp(String.raw`^\s*${MONTH}`, "i").test(after)) return true;
  if (/^(?:\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}|\d{3}[ .-]\d{4})$/.test(t) && cueGap > 1) return true;
  if (/\+\s?$/.test(before) && digits.length >= 8) return true;
  if (/\b[A-Z]{2}\s+$/.test(before) && /^\d{5}(?:-\d{4})?$/.test(t) && cueGap > 1) return true;
  return false;
}
function wordsBetween(line: string, a: number, b: number): number { const s = line.slice(Math.min(a, b), Math.max(a, b)).trim(); return s ? s.split(/\s+/).length : 0; }
function cuesIn(line: string): { start: number; end: number; weak: boolean; imp?: boolean }[] {
  const out: { start: number; end: number; weak: boolean; imp?: boolean }[] = [];
  for (const m of line.matchAll(IMPERATIVE)) out.push({ start: m.index!, end: m.index! + m[0].length, weak: true, imp: true });
  for (const m of line.matchAll(CUE)) {
    const start = m.index!, end = start + m[0].length, w = m[0].toLowerCase();
    if (/^(?:codes?|keys?|pins?|tokens?)$/.test(w) && NOT_CUE_BEFORE.test(line.slice(Math.max(0, start - 24), start))) continue;
    if (NOT_CUE_AFTER.test(line.slice(end, end + 40))) continue;
    out.push({ start, end, weak: /^(?:pins?|keys?|tokens?|digits|combination|acct|accounts?|cards?|routing|passport|unlock|入力)$/.test(w) });
  }
  return out;
}
// Removes code-like tokens near a cue in one line; `carried`: a cue on the line before that ended it (or ended with ":").
function codesIn(line: string, carried: boolean, out: Removed[]): string {
  const cues = cuesIn(line);
  if (!cues.length && !carried) return line;
  const near = (start: number, end: number, short: boolean) => {
    if (carried && wordsBetween(line, 0, start) <= 3) return 0;
    // A code cue decides first; an imperative alone ("enter", "type") marks its gap with .5 (the stricter rules below).
    let best = Infinity, imp = Infinity;
    for (const c of cues) {
      if (c.imp && !(c.end <= start)) continue;
      const gap = c.end <= start ? wordsBetween(line, c.end, start) : c.start >= end ? wordsBetween(line, end, c.start) : 0;
      if (c.imp) { if (gap <= 2) imp = Math.min(imp, gap + 0.5); } else if (gap <= (c.weak || short ? 3 : 8)) best = Math.min(best, gap);
    }
    return Number.isFinite(best) ? best : imp;
  };
  const sentence = line;
  const cut: [number, number, string][] = [];
  const consider = (m: RegExpMatchArray, kind: "digits" | "alnum" | "words") => {
    const tok = m[0], start = m.index!, end = start + tok.length;
    if (cut.some(([a, b]) => start < b && end > a)) return;
    const digits = tok.replace(/[^\p{Nd}]/gu, "").length;
    if (kind === "digits" && (digits < 3 || digits > 19)) return;
    if (kind === "alnum" && (tok.length < 4 || tok.length > 24 || /^\p{Nd}+$/u.test(tok) || /^(?:2fa|mfa|otp\d*)$/i.test(tok))) return;
    const gap = near(start, end, kind === "digits" && digits < 4);
    if (gap === Infinity) return;
    const imp = gap % 1 !== 0;
    if (imp && kind === "digits" && digits < 4) return;
    if (kind === "digits" && keepToken(tok, line.slice(Math.max(0, start - 40), start), line.slice(end, end + 16), sentence, imp ? 99 : gap)) return;
    if (imp && kind === "digits" && /^\s+(?:[A-Z][a-z]+\s+)?(?:st|street|ave|avenue|blvd|boulevard|rd|road|lane|ln|dr|drive|way|place|pl|court|ct|square|sq|suite|floor)\b/i.test(line.slice(end, end + 30))) return;
    if (kind === "alnum" && ID_BEFORE.test(line.slice(Math.max(0, start - 40), start))) return;
    cut.push([start, end, tok]);
  };
  for (const m of line.matchAll(WORD_RUN)) consider(m, "words");
  for (const m of line.matchAll(DIGIT_RUN)) consider(m, "digits");
  for (const m of line.matchAll(ALNUM)) consider(m, "alnum");
  if (!cut.length) return line;
  cut.sort((x, y) => y[0] - x[0]);
  for (const [a, b, tok] of cut) { out.push({ kind: "code", token: tok }); line = line.slice(0, a) + REMOVED + line.slice(b); }
  return line;
}

// ------------------------------------------------------------------------------------------------ (b) links
const MEETING_HOSTS = /(?:^|\.)(?:zoom\.us|zoom\.com|zoomgov\.com|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|calendly\.com|cal\.com|savvycal\.com|hackerrank\.com|hackerrankforwork\.com|coderpad\.io|codesignal\.com|codility\.com|docs\.google\.com|drive\.google\.com)$/i;
const ATS = [[/(?:^|\.)greenhouse\.io$/i, /^\/(?:[\w-]+\/)?jobs\/\d+\/?$/], [/(?:^|\.)lever\.co$/i, /^\/[\w-]+\/[0-9a-f-]{36}(?:\/apply)?\/?$/i],
  [/(?:^|\.)ashbyhq\.com$/i, /^\/[\w.-]+\/[0-9a-f-]{36}(?:\/application)?\/?$/i], [/(?:^|\.)myworkdayjobs\.com$/i, /\/job\/[^/]+(?:\/[^/]+)?\/?$/i],
  [/(?:^|\.)linkedin\.com$/i, /^\/(?:in|company|jobs\/view)\/[\w%-]+\/?$/i]] as const;
const AUTH_PATH = /(?:^|\/)(?:reset|password|passwordreset|verify|verification|activate|activation|confirm|confirmation|login|log-in|signin|sign-in|sign_in|magic|auth|oauth|token|unlock|recover|recovery|invite|invitation|continue|onetime|one-time|otp|session|form)(?:\/|$)/i;
const QUERY_TOKEN_KEYS = /^(?:token|tok|tk|t|code|key|sig|signature|auth|otp|secret|ticket|jwt|access_token|id_token|pwd|pass|password|hash|h|k|s|sid|session|er|env|envelope|resourcekey)$/i;
const tokenLike = (s: string, min: number) => s.length >= min && /\d/.test(s) && /[a-z]/i.test(s) && /^[A-Za-z0-9_~-]+$/.test(s);
const mixed = (s: string) => [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(s)).length >= 3;
const URL_RE = /\b(?:[a-z][a-z0-9+.-]{1,20}:\/\/|www\.)[^\s<>"'`)\]]+|(?<![@\w./-])(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}(?::\d{2,5})?\/[^\s<>"'`)\]]*/gi;
function cleanLink(raw: string, out: Removed[]): string {
  const trail = /[.,;:!?]+$/.exec(raw)?.[0] ?? "", u = trail ? raw.slice(0, -trail.length) : raw;
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(?:([^/@\s]*)@)?([^/?#:\s]+)(?::(\d+))?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(u);
  const gone = (why: Removed["kind"]) => { out.push({ kind: why, token: u }); return REMOVED + trail; };
  if (!m) return gone("link");
  const scheme = (m[1] ?? "").toLowerCase(), host = m[3].toLowerCase(), path = m[5] ?? "", query = m[6] ?? "", frag = m[7] ?? "";
  if (scheme && !/^(?:https?|ftp|sftp)$/.test(scheme)) return gone("secret");
  if (host.split(".").some((l) => (l.length >= 12 && tokenLike(l, 12)) || /^xn--/.test(l) && /\d/.test(l))) return gone("link");
  const base = `${scheme ? `${scheme}://` : ""}${host}${m[4] ? `:${m[4]}` : ""}`;
  if (m[2] || query || frag) out.push({ kind: "link", token: u });
  const ats = ATS.find(([h]) => h.test(host));
  if (MEETING_HOSTS.test(host) || (ats && ats[1].test(path))) return base + path + trail;
  const qTok = query.slice(1).split("&").some((kv) => { const [k, v = ""] = kv.split("="); return QUERY_TOKEN_KEYS.test(k) || tokenLike(decodeURIComponent(v.replace(/%(?![0-9a-f]{2})/gi, "")), 12) || v.length >= 20; });
  const segs = path.split("/").filter(Boolean);
  if (ats || qTok || AUTH_PATH.test(path) && segs.length > 1 || segs.some((s) => (s.length >= 20 && /^[A-Za-z0-9_~-]+$/.test(s)) || (s.length >= 12 && mixed(s)))) {
    if (path && path !== "/") out.push({ kind: "link", token: u });
    return base + trail;
  }
  return base + path + trail;
}

// ------------------------------------------------------------------------------------------------ (c) secrets by shape
const luhn = (d: string) => { let s = 0; for (let i = 0; i < d.length; i++) { let n = Number(d[d.length - 1 - i]); if (i % 2) { n *= 2; if (n > 9) n -= 9; } s += n; } return s % 10 === 0; };
const ibanOk = (v: string) => { const s = v.replace(/\s/g, "").toUpperCase(), r = s.slice(4) + s.slice(0, 4); let x = 0; for (const ch of r) { const n = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55); for (const c of n) x = (x * 10 + Number(c)) % 97; } return x === 1; };
const SHAPES: [RegExp, (m: string) => boolean][] = [
  [/-----BEGIN [A-Z0-9 ]{3,40}-----[\s\S]*?(?:-----END [A-Z0-9 ]{3,40}-----|$)/g, () => true],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]{2,})?/g, () => true],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_\w{16,}|\b(?:AKIA|ASIA)[0-9A-Z]{12,}|\bAIza[0-9A-Za-z_-]{20,}|\bxox[abeprs]-[A-Za-z0-9-]{8,}|\bSG\.[\w-]{8,}\.[\w-]{8,}|\bSK[0-9a-f]{32}\b|\bAC[0-9a-f]{32}\b|\bBearer\s+\S{8,}/g, () => true],
  [/(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{16,}(?![A-Za-z0-9+/_=-])/g, (s) => mixed(s) || /^[A-Z2-7]{16,}=*$/.test(s) && /\d/.test(s) || /^[0-9a-f]{24,}$/i.test(s) && /\d/.test(s) && /[a-f]/i.test(s)],
  [/(?<![A-Za-z0-9])(?:[A-Za-z2-7]{4}[ -]){3,}[A-Za-z2-7]{4}(?![A-Za-z0-9])/g, (s) => /\d/.test(s)],
  [/(?<![\d-])\d(?:[ .-]?\d){12,18}(?![\d-])/g, (s) => luhn(s.replace(/\D/g, ""))],
  [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, (s) => ibanOk(s)],
  [/(?<![\d-])(\d{3})[- ](\d{2})[- ](\d{4})(?![\d-])/g, (s) => { const [a, b, c] = s.split(/[- ]/); return a !== "000" && a !== "666" && a[0] !== "9" && b !== "00" && c !== "0000"; }],
];
// ------------------------------------------------------------------------------------------------ (d) after a password cue
const PW_STRONG = String.raw`passwords?|passwort|kennwort|passcodes?|pass\s+code|passphrase|passwd|pwd|pw|mot\s+de\s+passe|contrase[nñ]a|senha|пароль|wi-?fi\s+key|network\s+key`;
const PW_WEAK = String.raw`pins?|credentials?|secret|keys?|tokens?|clave|access\s+code|api\s+key`;
const FILLER = String.raw`(?:\s+(?:is|are|was|will\s+be|for\s+(?:the\s+)?\S+|temporaire|temporal|temporary|temp|new|neue[rs]?|nouveau|initial|one-time|of\s+the\s+day))*`;
const PW_AFTER = new RegExp(String.raw`(?<![\p{L}])(${PW_STRONG}|${PW_WEAK})(?![\p{L}])${FILLER}\s*(?:[:=—–-]|\(|\bis\b|\best\b|\bes\b|\blautet\b|\bé\b)?\s*(?:\n\s*)?("[^"\n]{1,80}"|“[^”\n]{1,80}”|'[^'\n]{1,80}'|[^\s"“'(]+)`, "giu");
const STOP = new Set("a an the and or of on in at to for by from with that this these those it its is are was be your my our their his her please here below above reset resets manager managers management pad policy policies change changed changes field protected requirements rules strength expired expiry hint hints recovery protection free less impressive strong so not if when as you we they will can should must which who what".split(" "));
const secretish = (t: string) => /[\d!@#$%^&*_+=~|\\/<>]/.test(t) || /[a-z][A-Z]|[A-Z]{2,}[a-z]/.test(t) || t.length >= 12;
function afterCues(text: string, out: Removed[]): string {
  text = text.replace(PW_AFTER, (all: string, cue: string, tok: string, at: number, whole: string) => {
    const bare = tok.replace(/^["“']|["”']$/g, ""), weak = new RegExp(`^(?:${PW_WEAK})$`, "iu").test(cue.trim());
    if (!bare || STOP.has(bare.toLowerCase().replace(/[.,;:!?)]+$/, "")) || (weak && !/^["“']/.test(tok) && !secretish(bare.replace(/[.,;:!?)]+$/, "")))) return all;
    // No separator and a plain lowercase word: a password only when it is long and the sentence moves on right after it
    // ("use the password tigerlilymeadow to get in"), never an ordinary phrase ("when your password flows break").
    const sep = /[:=—–(-]|\b(?:is|are|was|est|es|lautet|é)\b/i.test(all.slice(cue.length, all.length - tok.length)) || /^["“']/.test(tok);
    const nextWord = /^\s*([^\s]*)/.exec(whole.slice(at + all.length))?.[1] ?? "";
    if (!sep && /^[a-z]+[.,;:!?)]*$/.test(bare) && !(bare.replace(/[.,;:!?)]+$/, "").length >= 8 && (/[.,;:!?)]$/.test(bare) || /^(?:to|and|for|then|when|at|on|in|or|$)/.test(nextWord)))) return all;
    const clean = bare.replace(/[.,;:!?)]+$/, "");
    if (clean === REMOVED || !clean) return all;
    out.push({ kind: "secret", token: clean });
    return all.slice(0, all.length - tok.length) + tok.replace(clean, REMOVED);
  });
  const lines = text.split("\n").map((line) => line
    .replace(/\b((?:login|log-in|username|user|u|credentials?(?:\s+are)?)\s*[:=]?\s*\S+\s*\/\s*)(\S+)/gi, (_a, pre: string, tok: string) => { out.push({ kind: "secret", token: tok }); return pre + REMOVED; })
    .replace(/^(.*\bu(?:ser)?\s*[:=]\s*\S+.*?\bp\s*[:=]\s*)(\S+)/i, (_a, pre: string, tok: string) => { out.push({ kind: "secret", token: tok }); return pre + REMOVED; })
    .replace(/\b(user\s+\S+\s+pass\s+)(\S+)/i, (_a, pre: string, tok: string) => { out.push({ kind: "secret", token: tok }); return pre + REMOVED; })
    .replace(/(?<![\p{L}\p{Nd}])(\S{4,40})(?=\s+(?:(?:is|are)\s+your|as\s+(?:the|your))\s+(?:\S+\s+){0,2}(?:password|passcode|pin|code|otp|key|login|token)\b)/giu, (tok: string) => { if (!secretish(tok) || STOP.has(tok.toLowerCase())) return tok; out.push({ kind: "secret", token: tok }); return REMOVED; })
    .replace(/\b((?:security|secret)\s+(?:question|answer)s?\b[^\n]*?(?:[:=]|\bis\b)\s*)(\S.*)$/i, (_a, pre: string, rest: string) => { out.push({ kind: "secret", token: rest }); return pre + REMOVED; })
    .replace(/\b((?:recovery|seed|backup|secret|mnemonic)\s+(?:phrase|words?)\b[^\n:=]*[:=]\s*)(\S.*)$/i, (_a, pre: string, rest: string) => { out.push({ kind: "secret", token: rest }); return pre + REMOVED; })
    .replace(/(?<=[\w.-]\+)([A-Za-z0-9_-]{8,})(?=@[\w.-]+\.[a-z]{2,})/gi, (tok: string) => (tokenLike(tok, 8) ? (out.push({ kind: "secret", token: tok }), REMOVED) : tok)));
  return lines.join("\n");
}

// A readable email with what could sign someone in taken out, and the list of what was taken out (kept for the turn only).
export function redact(text: unknown): { text: string; removed: Removed[] } {
  const removed: Removed[] = [];
  // Links are cleaned first and then held aside, so no later rule reads a kept path as a code.
  const held: string[] = [];
  let t = normalise(text).replace(/[\u0001\u0002]/g, "");
  t = t.replace(URL_RE, (u) => { const c = cleanLink(u, removed); return c.startsWith(REMOVED) ? c : `\u0001${held.push(c) - 1}\u0002`; });
  for (const [re, ok] of SHAPES) t = t.replace(re, (s) => (s.includes(REMOVED) || !ok(s) ? s : (removed.push({ kind: "secret", token: s }), REMOVED)));
  t = afterCues(t, removed);
  const lines = t.split("\n");
  let carried = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    lines[i] = codesIn(line, carried, removed);
    if (line.trim()) carried = cuesIn(line).some((c) => !c.imp && wordsBetween(line, c.end, line.length) <= 3) || (carried && /^[\p{Nd} .-]+$/u.test(line.trim()));
  }
  return { text: lines.join("\n").replace(/\u0001(\d+)\u0002/g, (_m, i: string) => held[Number(i)]), removed };
}
export const redactSecrets = (text: unknown) => redact(text).text;

// ------------------------------------------------------------------------------------------------ the output guard
// Tokens of a withheld security mail (never read by the model, but never to be sent either).
export function withheldTokens(text: unknown): string[] {
  const t = normalise(text), out = new Set<string>();
  for (const m of t.matchAll(DIGIT_RUN)) if (m[0].replace(/\D/g, "").length >= 4) out.add(m[0]);
  for (const m of t.matchAll(ALNUM)) if (m[0].length >= 5) out.add(m[0]);
  for (const m of t.matchAll(URL_RE)) out.add(m[0]);
  for (const r of redact(t).removed) out.add(r.token);
  return [...out];
}
const digitsOf = (s: string) => normalise(s).replace(/(?<=\p{Nd})[ \-./_,:](?=\p{Nd})/gu, "");
// Whether a reply would carry something Trainee removed or withheld this turn (by its letters, or by its digits however spaced).
export function mentionsRemoved(text: unknown, tokens: Iterable<string>): string[] {
  const t = normalise(text), td = digitsOf(t), hit: string[] = [];
  for (const raw of tokens) {
    const tok = normalise(raw).trim();
    if (tok.length < 4 || tok === REMOVED) continue;
    const d = digitsOf(tok);
    if (t.includes(tok) || (/^[\p{Nd}]{4,}$/u.test(d) && new RegExp(`(?<!\\p{Nd})${d}(?!\\p{Nd})`, "u").test(td))) hit.push(raw);
  }
  return hit;
}
// A code next to a code cue in text Trainee would send (a reply card): the same rules as redact (a), (c) and (d), links aside.
export function codeInReply(text: unknown): string[] { return redact(text).removed.filter((r) => r.kind !== "link").map((r) => r.token); }
// The chat reply's guard: each removed or withheld token becomes [removed].
export function stripRemoved(text: string, tokens: Iterable<string>): string {
  let out = text;
  for (const tok of mentionsRemoved(text, tokens)) {
    const n = normalise(tok).trim(), d = digitsOf(n);
    out = out.split(tok).join(REMOVED).split(n).join(REMOVED);
    if (/^\p{Nd}{4,}$/u.test(d)) out = out.replace(new RegExp(`(?<!\\p{Nd})${[...d].join("[ \\-./_,:]?")}(?!\\p{Nd})`, "gu"), REMOVED);
  }
  return out;
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
