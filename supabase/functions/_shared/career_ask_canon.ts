// fix/r9-apply-completion (2026-11-08): the apply and job-search asks as people text them, read into the plain English
// shapes the apply turn (career_apply_chat.ts applyTurn) and the router's search already read. The 1,000-task eval
// (evals/career/e2e) showed the same ask failing on its wording alone: "apply to the X role at Y 🙏", "lowkey ... no cap",
// "can you apply me to the X job at Y?", "please submit an application for X at Y", a typo ("appply", "rle", "firrst",
// "sicence"), Spanish ("aplica al puesto de X en Y", "busca roles de X en Austin", "aplica al primero") and romanized Hindi
// ("Y pe X role ke liye apply kar do", "Austin mein X roles dhundo", "pehle wale mein apply kar do"). Each fell through to
// the staged brain, which does not apply (career_staged.ts STAGED_WITHHELD_TOOLS), so no card was ever made.
//
// What this does, and only this: it rewrites the WORDS of an ask that is already one of those asks into the English shape,
// keeping every name, title, place and link exactly as the person typed it. It never adds an employer, a role or a link,
// never turns a question about how to apply or a "don't apply" into an ask, never touches a reply to a card or a question
// ("yes pls", "haan", "send 1": no apply or search words), and never decides anything: the apply turn and the router decide
// as before, with all their screens, and nothing goes anywhere without the person's yes to the exact payload (D-MS-1).
// The person's own text is what is stored and shown; this reading is only what code routes by.

const NAMED = "[A-Z0-9][A-Za-z0-9&.'’-]*";
// A title or an employer as typed: capitalized words, with "of", "and", "&" and a comma before a capitalized word inside
// ("Software Engineer, New Grad", "FP&A Analyst", "Bank of Ideas").
const PROPER = `${NAMED}(?:(?:,\\s+|\\s+)(?:${NAMED}|of|and|&))*`;
const URL_IN = /https?:\/\/\S+/i;

// Chat filler around an ask: greetings and hedges before it, sign-offs, emoji and punctuation after it.
const LEAD = /^(?:yo|ok so|okay so|ok|okay|ngl|lowkey|hey|hi|hello|so|um|also|pls|plz|please|bro)\b[,!:]?\s+/i;
const TAIL = /[\s,]+(?:fr|lmk|ty|thx|thanks|thank you|no cap|pls|plz|please|rn|asap|porfa|por favor|bro|fam)\s*$/i;
const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu;
// Never an ask to act: a negation, the past, or a question about how.
const NEGATED = /\b(?:don'?t|dont|do not|never|not|no longer|stop|cancel|withdraw|nahi|nahin|mat|no apliques|no aplicar)\b/i;
const HOW = /^\s*(?:how|what|where|when|why|which|should|is|are|am|do|does|did|cómo|como|qué|que|kaise|kya|kyun)\b/i;

function clean(s: string): string {
  let t = String(s ?? "").replace(EMOJI, " ").replace(/[ \t]+/g, " ").trim();
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(LEAD, "").replace(/[\s.!]+$/, "").replace(TAIL, "").trim();
    if (t === before) break;
  }
  // Texting forms of the few words the shapes read ("can u apply", "go 4 the first one").
  return t.replace(/\bu\b/gi, "you").replace(/(^|\s)4(?=\s+the\b)/gi, "$1for").replace(/\b(apply|application|resume|me)\s+4\s+/gi, "$1 for ");
}

// ------------------------------------------------------------------------------------------------ typos
// One slip of the keys (a letter dropped, doubled, added or swapped) in a word this reading depends on. Only the
// keywords below and the common words of job titles are corrected; a name, a title as typed with capitals, a link
// and a number are never touched.
function slip(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // one letter changed
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // two swapped
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1); // one added / one dropped
}
// Two slips in a long word ("sicence", "analyyst" are one; "financal" is one): allowed only from 7 letters on.
function slips2(a: string, b: string): boolean {
  if (Math.min(a.length, b.length) < 7 || Math.abs(a.length - b.length) > 2) return false;
  for (let k = 0; k < a.length; k++) if (slip(a.slice(0, k) + a.slice(k + 1), b) || slip(a, b.slice(0, k) + b.slice(k + 1))) return true;
  return false;
}
const VERBS = ["apply", "find", "search", "submit", "application", "please", "want", "tailor", "resume"];
const ROLE_NOUNS = ["role", "roles", "job", "jobs", "position", "positions", "opening", "openings", "internship", "internships"];
const TITLE_WORDS = ["analyst", "analysts", "analytics", "engineer", "engineers", "engineering", "software", "data", "science", "scientist", "financial",
  "finance", "frontend", "backend", "developer", "designer", "design", "intern", "interns", "internship", "manager", "product", "marketing", "sales",
  "research", "business", "intelligence", "machine", "learning", "new", "grad", "graduate", "full", "stack", "operations", "consultant", "consulting",
  "accountant", "accounting", "associate", "investment", "banking", "summer", "entry", "level", "junior", "remote", "security", "quantitative",
  "first", "top", "second", "third", "one"];
const KEEP = new Set(["the", "to", "for", "at", "in", "and", "of", "me", "my", "all", "them", "these", "those", "a", "an", "on", "it", "is", "be", "do", "go", "rn", "date", "roll", "rule", "rope", "rose",
  // Spanish and romanized Hindi function words the shapes read: never "corrected" into English ("rol" is not a typo of "role").
  "rol", "de", "en", "al", "la", "el", "los", "las", "por", "con", "para", "mi", "ke", "ki", "ka", "pe", "par", "mein", "kar", "karo", "aur", "sab", "hai", "liye", "wale", "wala"]);
function fix(word: string, vocab: readonly string[]): string {
  const w = word.toLowerCase();
  if (w.length < 3 || KEEP.has(w) || !/^[a-z]+$/.test(w) || vocab.includes(w)) return word;
  const hit = vocab.find((v) => v[0] === w[0] && slip(w, v)) ?? vocab.find((v) => slip(w, v) && v.length >= 4) ?? vocab.find((v) => slips2(w, v));
  return hit ?? word;
}
// Lowercase words only: the person's capitalized names and titles stay exactly as typed.
const fixWords = (s: string, vocab: readonly string[]) => s.replace(/\b[a-z]+\b/g, (w) => fix(w, vocab));

// ------------------------------------------------------------------------------------------------ the shapes
const single = (role: string, company: string) => `apply to the ${role.replace(/\s+(?:role|job|position|opening|posting)$/i, "").trim()} role at ${company.trim()}`;
const PAIR_SEP = /\s+(?:and|y|aur)\s+(?:the\s+|a\s+|al\s+)?/;

// "Tailor my resume for the X role at Y and apply with it": the one shape the tailor-then-apply turn reads
// (career_compound_ask.ts tailorAndApplyOf).
const tailorThenApply = (role: string, company: string) => `tailor my resume for the ${role.replace(/\s+(?:role|job|position|opening|posting)$/i, "").trim()} role at ${company.trim()} and apply with it`;

// The English shapes, once filler and typos are gone.
function english(t: string): string | null {
  // "tailor and apply: X at Y" / "tailor my resume for the X role at Y and apply with it"
  let tm = t.match(new RegExp(`^tailor\\s+and\\s+apply(?:\\s+(?:to|for))?:?\\s+(?:the\\s+)?(${PROPER})(?:\\s+(?:role|job|position|opening))?\\s+at\\s+(${PROPER})$`));
  if (tm) return tailorThenApply(tm[1], tm[2]);
  tm = t.match(new RegExp(`^tailor\\s+(?:my\\s+)?(?:resume|cv)\\s+(?:for|to)\\s+(?:the\\s+)?(${PROPER})\\s+(?:role|job|position|opening|internship)\\s+at\\s+(${PROPER}),?\\s+and\\s+(?:then\\s+)?apply(?:\\s+(?:with|using)\\s+it)?$`));
  if (tm) return tailorThenApply(tm[1], tm[2]);
  // "go for the first one, apply" / "apply to the top one" / "the first one, apply"
  let m = t.match(/^(?:go\s+for\s+|take\s+)?the\s+(first|top|1st)\s+one,?\s+(?:and\s+)?apply(?:\s+(?:to|for)\s+(?:it|that))?$/i);
  if (m) return `apply to the ${m[1].toLowerCase() === "top" ? "top" : "first"} one`;
  m = t.match(/^apply\s+(?:me\s+)?(?:to|for)\s+the\s+(first|top|1st)\s+one$/i);
  if (m) return `apply to the ${m[1].toLowerCase() === "top" ? "top" : "first"} one`;
  // "please submit an application for the X role at Y" / "submit an application to X at Y"
  m = t.match(new RegExp(`^submit\\s+(?:an?\\s+|my\\s+)?application\\s+(?:for|to)\\s+(?:the\\s+)?(${PROPER})(?:\\s+(?:role|job|position|opening))?\\s+at\\s+(${PROPER})$`));
  if (m) return single(m[1], m[2]);
  // "apply me to the X job at Y" (with the role noun's typo already fixed): the apply turn's own shape.
  m = t.match(new RegExp(`^apply\\s+(?:me\\s+)?(?:to|for)\\s+(?:the\\s+)?(${PROPER})\\s+(?:role|job|position|opening|internship)\\s+at\\s+(${PROPER})$`));
  if (m && !PAIR_SEP.test(` ${m[2]} `)) return single(m[1], m[2]);
  // "I want to apply for Acme's Data Analyst opening": the employer's possessive.
  m = t.match(new RegExp(`^(?:[Ii]\\s+(?:want|would like|'d like|wanna)\\s+to\\s+)?apply\\s+(?:me\\s+)?(?:to|for)\\s+(?:the\\s+)?([A-Z0-9][A-Za-z0-9&.-]*(?:\\s+[A-Z0-9][A-Za-z0-9&.-]*)*)['’]s?\\s+(${PROPER})(?:\\s+(?:role|job|position|opening|posting))?$`));
  if (m && /^[A-Z0-9]/.test(m[1]) && /^[A-Z0-9]/.test(m[2])) return single(m[2], m[1]);
  return null;
}

function spanish(t: string): string | null {
  // "adapta mi currículum para X en Y y aplica con él"
  const tm = t.match(new RegExp(`^(?:adapta|ajusta|personaliza)(?:r)?\\s+mi\\s+(?:curr[ií]culum|cv|hoja\\s+de\\s+vida)\\s+(?:para|al\\s+puesto\\s+de)\\s+(${PROPER})\\s+en\\s+(${PROPER})\\s+y\\s+(?:aplica|postula)(?:\\s+con\\s+[eé]l)?$`, "u"));
  if (tm) return tailorThenApply(tm[1], tm[2]);
  const verb = "(?:aplica(?:me)?|apl[ií]came|aplicar|quiero aplicar|quisiera aplicar|postula(?:me)?|post[uú]lame|quiero postularme)";
  // "aplica a estos 5 por favor: <links>"
  if (URL_IN.test(t) && new RegExp(`^${verb}\\b`, "i").test(t)) {
    const links = t.slice(t.search(URL_IN));
    return `apply to all of these:\n${links.trim()}`;
  }
  // "aplica al primero" / "aplica a la primera"
  if (new RegExp(`^${verb}\\s+(?:al\\s+primero|a\\s+la\\s+primera|al\\s+primer\\s+(?:rol|puesto|trabajo|empleo))$`, "i").test(t)) return "apply to the first one";
  // "busca roles de X en Austin (y aplica a todos)"
  let m = t.match(/^(?:busca|b[uú]scame|encuentra)\s+(?:roles|trabajos|empleos|puestos|vacantes)\s+de\s+(.+?)\s+en\s+(.+?)(\s+y\s+(?:aplica|postula)(?:me)?\s+a\s+todos)?$/i);
  if (m) return `find ${m[1].trim()} roles in ${m[2].trim()}${m[3] ? " and apply to all of them" : ""}`;
  // "aplica al puesto de X en Y", "quiero aplicar al rol de X en Y", "aplica a X en Y y a Z en W"
  m = t.match(new RegExp(`^${verb}\\s+(.+)$`, "i"));
  if (!m) return null;
  const parts = m[1].split(/\s+y\s+(?=(?:a|al|a\s+la)\s+)/i);
  const asks: string[] = [];
  for (const p of parts) {
    const one = p.match(new RegExp(`^(?:al\\s+(?:puesto|rol|trabajo|empleo|cargo)\\s+de|a\\s+la\\s+vacante\\s+de|al|a)\\s+(${PROPER})\\s+en\\s+(${PROPER})$`));
    if (!one) return null;
    asks.push(single(one[1], one[2]).replace(/^apply to /, ""));
  }
  return asks.length ? `apply to ${asks.join(" and ")}` : null;
}

function hindi(t: string): string | null {
  // "Y ke X ke liye resume tailor karo aur apply kar do"
  const tm = t.match(new RegExp(`^(${PROPER})\\s+(?:ke|ki|ka)\\s+(${PROPER})(?:\\s+(?:role|job))?\\s+ke\\s+liye\\s+(?:mera\\s+)?resume\\s+tailor\\s+(?:karo|kar\\s+do|kardo)\\s+aur\\s+apply\\s+(?:kar\\s+do|karo|kardo)$`));
  if (tm) return tailorThenApply(tm[2], tm[1]);
  const act = "apply\\s+(?:kar\\s*(?:do|o|dijiye|dena|na\\s+hai|ni\\s+hai)|karna\\s+hai|karo|kardo)";
  // "in sab ke liye apply kar do: <links>"
  if (URL_IN.test(t) && new RegExp(`\\b${act}\\b`, "i").test(t.slice(0, Math.max(0, t.search(URL_IN))))) {
    return `apply to all of these:\n${t.slice(t.search(URL_IN)).trim()}`;
  }
  // "pehle wale mein apply kar do"
  if (new RegExp(`^(?:pehle|pehla|pehli|first|top)\\s+(?:wale|wala|wali|vale|vala)\\s+(?:mein|me|ke\\s+liye|par|pe)\\s+${act}$`, "i").test(t)) return "apply to the first one";
  // "Austin mein X roles dhundo (aur sab mein apply kar do)"
  let m = t.match(new RegExp(`^(${PROPER})\\s+(?:mein|me)\\s+(.+?)\\s+(?:roles|jobs|positions|naukri)\\s+(?:dhundo|dhundho|dhoondo|khojo|search\\s+karo|find\\s+karo)(\\s+aur\\s+(?:sab|sabhi|sab\\s+ke\\s+liye)\\s+(?:mein|me|ke\\s+liye)?\\s*${act})?$`));
  if (m) return `find ${m[2].trim()} roles in ${m[1].trim()}${m[3] ? " and apply to all of them" : ""}`;
  // "Y ke X aur W ke Z dono mein apply kar do"
  m = t.match(new RegExp(`^(${PROPER})\\s+(?:ke|ki|ka)\\s+(${PROPER})\\s+aur\\s+(${PROPER})\\s+(?:ke|ki|ka)\\s+(${PROPER})\\s+(?:dono|donon)\\s+(?:mein|me|ke\\s+liye)\\s+${act}$`));
  if (m) return `apply to ${single(m[2], m[1]).replace(/^apply to /, "")} and ${single(m[4], m[3]).replace(/^apply to /, "")}`;
  // "Y pe X role ke liye apply kar do", "mujhe Y ke X job ke liye apply karna hai"
  m = t.match(new RegExp(`^(?:mujhe\\s+|mere\\s+liye\\s+)?(${PROPER})\\s+(?:pe|par|mein|me|ke|ki|ka)\\s+(${PROPER})(?:\\s+(?:role|job|position|opening|internship))?\\s+(?:ke\\s+liye|ki\\s+liye|mein|me)\\s+${act}$`));
  if (m) return single(m[2], m[1]);
  return null;
}

// The canonical English reading of an apply or job-search ask, or null when the message is not one (or is already in the
// shape code reads: nothing to change).
export function careerAskCanon(message: string): string | null {
  const raw = String(message ?? "");
  if (!raw.trim() || raw.length > 4000) return null;
  // The links, if any, are kept byte for byte: only the words before the first one are read.
  const at = raw.search(URL_IN);
  const head = at >= 0 ? raw.slice(0, at) : raw, links = at >= 0 ? raw.slice(at) : "";
  let t = clean(head);
  if (!t && !links) return null;
  // "can you apply me to ...?", "could you please find ..." asks to act: the ask itself.
  const asked = /^(?:can|could|would|will)\s+you\s+(?:please\s+|pls\s+|plz\s+)?/i;
  t = t.replace(/\?+$/, "").trim();
  if (asked.test(t)) t = t.replace(asked, "");
  if (HOW.test(t) || NEGATED.test(t) || /\bapplied\b/i.test(t)) return null;
  // Keyword slips first ("appply", "rle", "fid"), then the common title words of a search ("analyyst", "sicence").
  t = clean(fixWords(t, [...VERBS, ...ROLE_NOUNS, ...TITLE_WORDS]));
  if (asked.test(t)) t = t.replace(asked, "");
  const words = (s: string) => s.replace(/\s+/g, " ").trim();
  let out: string | null = null;
  if (links) {
    const esHi = spanish(`${t} ${links}`) ?? hindi(`${t} ${links}`);
    if (esHi) out = esHi.replace(/:\n[\s\S]*$/, `:\n${links.trim()}`);
    // An English ask with links: only filler or a slip taken out, the links where they were (nothing to change otherwise).
    else if (/\bapply\b/i.test(t) && t !== words(head)) out = `${t}${/\n\s*$/.test(head) ? "\n" : " "}${links}`;
  } else {
    out = english(t) ?? spanish(t) ?? hindi(t);
    // "find X roles in City (and apply to all of them)" with the filler and slips gone.
    if (!out) {
      const m = t.match(/^(?:find|search\s+for|search|look\s+for)(?:\s+me)?\s+(.+?)\s+(?:roles|jobs|positions|openings|internships)\s+in\s+(.+?)(\s+and\s+apply\s+(?:me\s+)?to\s+(?:all|all\s+of\s+them|every\s+one|them\s+all))?$/i);
      if (m) out = `find ${m[1]} roles in ${m[2]}${m[3] ? " and apply to all of them" : ""}`;
    }
    // Otherwise any apply ask, only cleaned (the apply turn's own grammar reads it, as typed but without the filler).
    if (!out && /^apply\b/i.test(t)) out = t;
  }
  if (!out) return null;
  out = links ? out : words(out);
  return out !== raw.trim() ? out : null;
}
