// APPROVAL WORDS: how a texted answer to something shown for approval (an application card, an outreach batch, a billing
// cancel) is read before each path's own parser sees it. It only READS; it never approves. Each path still approves only
// while the card or batch it showed is the thread's last word, and only the exact items shown, each bound to the hash it was
// shown with (D-MS-1, D-MN-2). The model decides, code enforces (ARCHITECTURE 3.1): nothing here holds a send door.
//
// readApproval(text) returns what an unambiguous approval says, or null. It is a whitelist: EVERY word of the message must
// be an approval word, a word saying what to approve ("it", "all", "both", one number), or politeness padding ("pls",
// "thanks", "🙏"). One word of anything else (a negation, a hedge, a condition, a time, a change, an unknown word, a
// question mark, a quote) and it is null, and the text goes to the path's parser exactly as the person wrote it. A negation
// is never a typo of anything and never padding, so a message with a negation in it is never an approval.
//
// approvalWords(text) rewrites an approval read that way into the one English form every parser reads ("yes", "yes, send
// it", "send all", "send both", "send 3", "approve #3"); every other text is returned unchanged.
//
// Owner rules this keeps (tests/architect/scenarios-approvals.test.ts, scenarios-adversarial-r2.test.ts, 2026-10-29):
//   - "ok", "okay", "sure" alone are not a clear yes; with an explicit send ("ok send") they are.
//   - a thumbs-up alone (any skin tone, repeated) is "yes"; every other reaction alone (✅ 👌 🙌 ...) approves nothing.
//   - a fragment ("ye", "approv"), a look-alike letter, an invisible character or a spaced-out word approves nothing:
//     a typo is corrected only in a word of 3+ plain letters, keeping its first letter, never a cut-off word.
// D-044 (owner, 2026-11-08, replacing the 2026-10-29 English-only rule): a clear yes in Spanish, Hindi/Hinglish (romanized
// or Devanagari), French, German or Portuguese reads as the same English yes, under the same hash and last-word rules.
// Every other language and script still approves nothing. The table is read by default; { languages: "en" } reads
// English only.

export type ApprovalScope = "batch" | "it" | "all" | "both" | "number";
// `marked`: the number was said as a position ("#2", "number 2"), which the card reads as clear (one bare number may be a count).
export type Approval = { scope: Exclude<ApprovalScope, "number"> } | { scope: "number"; n: number; verb: "send" | "approve"; marked: boolean };
export interface ApprovalOptions { languages?: "en" | "all" }

// "send_it" / "send_all": one word that is a send and its object (Spanish "mándalo", "envíalos").
type Cls = "strong" | "soft" | "action" | "weak" | "it" | "all" | "both" | "pad" | "num_lead" | "send_it" | "send_all";
// Words that end any reading: a negation, hold, hedge, condition, contrast or time. Never corrected, never padding.
export const NEGATIONS = new Set([
  // en
  "no", "nope", "nah", "naw", "n", "not", "dont", "don't", "never", "none", "nothing", "wait", "hold", "stop", "cancel", "later", "but", "except",
  "without", "unless", "until", "if", "maybe", "change", "edit", "fix", "redo", "undo", "skip", "tomorrow", "nvm", "jk", "first", "after",
  // es / pt
  "nunca", "pero", "espera", "luego", "después", "despues", "mañana", "manana", "ninguno", "nada", "não", "nao", "mas", "depois", "amanhã", "amanha",
  // hi
  "nahi", "nahin", "nai", "mat", "na", "ruko", "baad", "kal", "नहीं", "नही", "मत", "ना", "रुको", "बाद", "कल", "लेकिन",
  // fr / de
  "non", "pas", "ne", "attends", "attendez", "demain", "mais", "nein", "nicht", "kein", "keine", "warte", "später", "spater", "morgen", "aber",
  // reactions that say no or doubt
  "👎", "❌", "✋", "🤔", "🛑",
]);

const EN: Record<string, Cls> = {
  yes: "strong", yep: "strong", yeah: "strong", yea: "strong", yup: "strong", ya: "strong", y: "strong", "👍": "strong",
  ok: "soft", okay: "soft", k: "soft", kk: "soft", sure: "soft", alright: "soft", okey: "soft",
  send: "action", submit: "action", approve: "action", approved: "action", confirm: "action", confirmed: "action", lgtm: "action",
  "go ahead": "action", "go for it": "action", "do it": "action", "lets go": "action", "let's go": "action",
  go: "weak",
  it: "it", this: "it", that: "it", "this one": "it", "that one": "it", "the email": "it", "the draft": "it", "the application": "it",
  all: "all", them: "all", everything: "all", "them all": "all", "all of them": "all", em: "all", "em all": "all", "all of em": "all",
  both: "both", "both of them": "both",
  please: "pad", pls: "pad", plz: "pad", plez: "pad", thanks: "pad", "thank you": "pad", thx: "pad", ty: "pad", now: "pad", rn: "pad",
  asap: "pad", fr: "pad", "for real": "pad", just: "pad", then: "pad", so: "pad", yo: "pad", hey: "pad",
  "🙏": "pad", "🙌": "pad", "🙂": "pad", "😊": "pad", "😄": "pad", "🔥": "pad", "💯": "pad", "🚀": "pad",
  number: "num_lead", "#": "num_lead",
};
// D-044: Spanish, Hindi/Hinglish (romanized and Devanagari), French, German, Portuguese (not read with { languages: "en" }).
// German "es" alone is not an object: "y es" (a split "yes") would read as "yes, send it". It is read only in "schick es ab", "mach es".
// One table per language. A reply is read in ONE of them (or English with one of them, as Hinglish is): words from two
// other languages together, or the English "y" with any other-language word ("y la", "todos y": Spanish "y" is "and"),
// are not a clear yes in any language and approve nothing.
const ES: Record<string, Cls> = {
  "sí": "strong", si: "strong", claro: "strong", dale: "action", "envía": "action", envia: "action", enviar: "action", manda: "action",
  "mándalo": "send_it", "mándala": "send_it", "envíalo": "send_it", "envíala": "send_it", "mándalos": "send_all", "mándalas": "send_all",
  "envíalos": "send_all", "envíalas": "send_all", adelante: "action", hazlo: "action", vale: "soft", bueno: "soft", todos: "all", todas: "all",
  "los dos": "both", "las dos": "both", ambos: "both", ambas: "both", "por favor": "pad", porfa: "pad", porfis: "pad", gracias: "pad",
};
const HI: Record<string, Cls> = {
  haan: "strong", haa: "strong", han: "strong", haanji: "strong", hanji: "strong", "haan ji": "strong", "ji haan": "strong", bilkul: "strong",
  "theek hai": "soft", "thik hai": "soft", accha: "soft", acha: "soft", achha: "soft", bhejo: "action", "bhej do": "action", bhejdo: "action",
  "bhej dijiye": "action", "kar do": "action", kardo: "action", "kar dijiye": "action", chalo: "weak", sab: "all", sabko: "all", "sab ko": "all",
  saare: "all", sare: "all", dono: "both", "dono ko": "both", ise: "it", isko: "it", ji: "pad", kripya: "pad", shukriya: "pad",
  // hi (Devanagari): हाँ / हां yes, भेजो / भेज दो send, सब all, दोनों both, इसे it, कृपया please
  "हाँ": "strong", "हां": "strong", "हाँ जी": "strong", "जी हाँ": "strong", "भेजो": "action", "भेज दो": "action", "भेज दीजिए": "action", "सब": "all",
  "सबको": "all", "दोनों": "both", "इसे": "it", "कृपया": "pad", "जी": "pad", "धन्यवाद": "pad",
};
const FR: Record<string, Cls> = {
  oui: "strong", ouais: "strong", "d'accord": "soft", daccord: "soft", dac: "soft", envoie: "action", envoyez: "action", envoyer: "action",
  "vas y": "action", "allez y": "action", la: "it", le: "it", "ça": "it", les: "all", tous: "all", toutes: "all", tout: "all", "les deux": "both",
  "s'il te plaît": "pad", "s'il vous plaît": "pad", "sil te plait": "pad", "sil vous plait": "pad", stp: "pad", svp: "pad", merci: "pad",
};
const DE: Record<string, Cls> = {
  ja: "strong", jawohl: "strong", jep: "strong", "in ordnung": "soft", passt: "soft", schick: "action", schicke: "action", "schick es ab": "action",
  abschicken: "action", senden: "action", sende: "action", "mach es": "action", "mach das": "action", los: "weak", das: "it",
  alle: "all", alles: "all", beide: "both", bitte: "pad", danke: "pad", jetzt: "pad",
};
const PT: Record<string, Cls> = {
  sim: "strong", "beleza": "soft", envie: "action", mande: "action", "pode mandar": "action", "pode enviar": "action", vai: "weak", bora: "action",
  tudo: "all", "os dois": "both", "as duas": "both", obrigado: "pad", obrigada: "pad", valeu: "pad",
  // shared with Spanish
  manda: "action", envia: "action", todos: "all", todas: "all",
};
const TABLES: [string, Record<string, Cls>][] = [["es", ES], ["hi", HI], ["fr", FR], ["de", DE], ["pt", PT]];
const OTHER: Record<string, Cls> = Object.assign({}, ...TABLES.map(([, t]) => t));
// The languages each other-language word belongs to.
const LANGS_OF = new Map<string, Set<string>>();
for (const [lang, t] of TABLES) for (const w of Object.keys(t)) LANGS_OF.set(w, (LANGS_OF.get(w) ?? new Set()).add(lang));
// A one-letter typo (a letter missing, extra, swapped or wrong) is corrected only to these, and only in a word of 3+ plain
// letters a-z that keeps the first letter and is not a cut-off of the word ("approv" is a fragment, not a typo).
const TYPO_TARGETS = ["yes", "yeah", "yep", "yup", "send", "submit", "approve", "ahead", "please", "confirm"];
// Real words one letter away from a target: never "corrected" into it.
const REAL_WORDS = new Set(["yet", "yen", "yew", "yer", "yeh", "year", "yeas", "yelp", "yap", "yum", "yuk", "yip", "sent", "seed", "sand", "sane", "sens",
  "spend", "sena", "summit", "conform", "pleat", "pease",
  // real English words with a held letter: never folded into an approval word
  "less", "loss", "lass", "pass", "mass", "boss", "toss", "moss", "miss", "kiss", "goo", "goes", "seen", "sees", "yell", "sell", "tell", "all's"]);

const MAX_LEN = 80, MAX_WORDS = 10;
// Every character must be a letter, a digit, one of these separators, an apostrophe, a hyphen, a Devanagari sign (its
// vowel signs and nasal marks are combining marks; no other script's are allowed), or one of the listed
// emoji (with skin tones and the emoji variation selector). Anything else (a quote, a ?, an invisible character, a
// combining mark, a symbol) ends the reading.
const ALLOWED = /^(?:[\p{L}\p{Nd}\s,.!;:'’#-]|[ऀ-ॿ]|\u{1F44D}|[\u{1F3FB}-\u{1F3FF}]|\u{FE0F}|\u{1F64F}|\u{1F64C}|\u{1F642}|\u{1F60A}|\u{1F604}|\u{1F525}|\u{1F4AF}|\u{1F680}|\u{1F44E}|\u{274C}|\u{270B}|\u{1F914}|\u{1F6D1})+$/u;

function damerau1(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const d: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push(i);
    return d.length === 1 || (d.length === 2 && d[1] === d[0] + 1 && a[d[0]] === b[d[1]] && a[d[1]] === b[d[0]]);
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  return false;
}
const collapse = (w: string) => w.replace(/(.)\1+/g, "$1");
function correct(w: string, vocab: Record<string, Cls>): string | null {
  if (vocab[w]) return w;
  if (REAL_WORDS.has(w)) return null;
  // A held letter ("yesss", "pleeease", "allll") is the English word. Only English words are folded: "less" is not the
  // French "les", "loss" not the German "los", "haaa" not "haa", "dass" not "das" (S2 review of #611).
  const c = collapse(w);
  if (c !== w) {
    if (NEGATIONS.has(c)) return null;
    for (const k of Object.keys(EN)) if (!k.includes(" ") && collapse(k) === c) return k;
  }
  if (!/^[a-z]{3,}$/.test(w) || REAL_WORDS.has(w)) return null;
  for (const t of TYPO_TARGETS) {
    if (t[0] !== w[0] || t.startsWith(w)) continue;
    if (damerau1(w, t)) return t;
  }
  return null;
}

export function readApproval(text: string, o: ApprovalOptions = {}): Approval | null {
  const raw = String(text ?? "").normalize("NFC").trim();
  if (!raw || raw.length > MAX_LEN || !ALLOWED.test(raw)) return null;
  // A sign or range on a number ("send -1", "send 1-3") is the path's parser's to read, never one number.
  if (/-\s*\p{Nd}|\p{Nd}\s*-/u.test(raw)) return null;
  // An apostrophe only inside a word ("let's", "d'accord"): one around a word is a quote ("'yes'"), never the person's yes.
  if (/(?:^|[^\p{L}])['’]|['’](?:$|[^\p{L}])/u.test(raw)) return null;
  const vocab: Record<string, Cls> = o.languages === "en" ? EN : { ...EN, ...OTHER };
  const lower = raw.toLowerCase().replace(/’/g, "'");
  // Words, numbers and listed emoji; separators split. "#3" is "#", "3"; "envoie-la" is "envoie", "la".
  const tokens = lower.replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}]/gu, "").match(/[\p{L}ऀ-ॣ०-ॿ']+|\p{Nd}+|#|\p{Extended_Pictographic}/gu) ?? [];
  if (!tokens.length || tokens.length > MAX_WORDS) return null;
  // A negation anywhere ends it, before any correction.
  if (tokens.some((t) => NEGATIONS.has(t) || NEGATIONS.has(t.replace(/'/g, "")) || NEGATIONS.has(collapse(t)))) return null;
  // Words of a listed phrase ("do" in "do it", "bhej" in "bhej do") are kept as they are until the phrases are joined.
  const phrases = Object.keys(vocab).filter((k) => k.includes(" ")).sort((a, b) => b.split(" ").length - a.split(" ").length);
  const inPhrase = new Set(phrases.flatMap((p) => p.split(" ")));
  const fixed: string[] = [];
  for (const t of tokens) {
    if (/^\p{Nd}+$/u.test(t) || inPhrase.has(t)) { fixed.push(t); continue; }
    const w = correct(t, vocab) ?? correct(t.replace(/'/g, ""), vocab);
    if (!w) return null;
    fixed.push(w);
  }
  // Longest phrases first ("all of them", "go ahead", "bhej do").
  const words: string[] = [];
  for (let i = 0; i < fixed.length;) {
    const hit = phrases.find((p) => p.split(" ").every((x, j) => fixed[i + j] === x));
    if (hit) { words.push(hit); i += hit.split(" ").length; } else { words.push(fixed[i]); i++; }
  }
  const nums = words.filter((w) => /^\p{Nd}+$/u.test(w));
  const cls = words.filter((w) => !/^\p{Nd}+$/u.test(w)).map((w) => vocab[w]);
  if (cls.some((c) => c === undefined)) return null;
  // ONE language: every other-language word must share a language, and the English "y" never joins one ("y la", "y los").
  const foreign = words.filter((w) => !/^\p{Nd}+$/u.test(w) && !(w in EN) && LANGS_OF.has(w));
  if (foreign.length) {
    const common = foreign.slice(1).reduce((acc, w) => acc.filter((l) => LANGS_OF.get(w)!.has(l)), [...LANGS_OF.get(foreign[0])!]);
    if (!common.length) return null;
    if (words.includes("y")) return null;
    // Unaccented Spanish "si" is also "if" ("si todos": if all): a yes only alone or as "si, claro" / "si por favor".
    if (words.includes("si") && words.some((w) => w !== "si" && w !== "claro" && vocab[w] !== "pad")) return null;
  }
  const has = (c: Cls) => cls.includes(c) || (c === "action" && (cls.includes("send_it") || cls.includes("send_all"))) ||
    (c === "it" && cls.includes("send_it")) || (c === "all" && cls.includes("send_all"));
  const strong = has("strong"), action = has("action"), weak = has("weak"), soft = has("soft");
  // An approval word is needed: a clear yes or an explicit send. "ok" / "sure" / "go" alone are not one.
  if (!(strong || action || (soft && weak))) return null;
  const objs = (["it", "all", "both"] as const).filter((c) => has(c));
  if (nums.length) {
    // One number after an explicit send or approve ("send 1", "approve #2", "yes send 1 pls"). Lists, ranges and counts are
    // the path's own parser's: returned unchanged.
    if (nums.length !== 1 || objs.length || !action) return null;
    const n = Number(nums[0]);
    if (!(n >= 1 && n <= 100000)) return null;
    const verb = words.includes("approve") || words.includes("approved") ? "approve" : "send";
    // The number comes last (padding aside): "send 1", not "1 send".
    const lastWord = [...words].reverse().find((w) => vocab[w] !== "pad");
    if (lastWord !== nums[0]) return null;
    return { scope: "number", n, verb, marked: has("num_lead") };
  }
  if (has("num_lead")) return null;
  if (objs.length > 1) return null; // "send it all", "both of it": not one thing
  return { scope: objs[0] ?? "batch" };
}

const THUMBS = /^(?:\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?\u{FE0F}?)+\s*([.!]*)$/u;
export function canonicalApproval(a: Approval): string {
  switch (a.scope) {
    case "batch": return "yes";
    case "it": return "yes, send it";
    case "all": return "send all";
    case "both": return "send both";
    case "number": return `${a.verb} ${a.marked ? "#" : ""}${a.n}`;
  }
}
export function approvalWords(text: string, o: ApprovalOptions = {}): string {
  const raw = String(text ?? "");
  const t = raw.trim();
  const thumbs = THUMBS.exec(t);
  if (thumbs) return `yes${thumbs[1]}`;
  const a = readApproval(t, o);
  return a ? canonicalApproval(a) : raw;
}
