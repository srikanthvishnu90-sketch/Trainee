// Step 4: the guard. Code, not the model, decides which specifics survive. A "specific" is a number (digits OR words: "seventy
// thousand dollars", "ninety percent", "$70k", "half", "one in three", ranges, ordinals) or a named thing (employer, program,
// exam, credential body), in any case. It may appear in a brief or a reply only if:
//   numbers   a number in a retrieved source passage (or the person's own words) equals it AND that passage shares the claim's
//             subject words, so "6 percent" cannot ride on a sentence about something else;
//   names     the name appears, case-insensitively, in a retrieved source or the person's facts. Capitalized names are found by
//             shape; lowercase and sentence-initial names by a gazetteer of well-known employers and programs plus the cue
//             "at/with/from/join <word the writing vocabulary does not know>". Both are backstops: the rule is "introduced by the
//             model => must be in a source", and general-knowledge lines are linted to contain none.
// Everything else is dropped by code (D-007).
import { PLAYBOOKS } from "../knowledge/playbooks.generated.ts";
import { FIELDS, GK_PHRASES, GK_TERMS, OVERLAYS } from "./fields.ts";
import type { Fact } from "./ground.ts";
import { readsAsInstruction } from "../../career_people_import.ts";

// Folding comes first, everywhere: full-width and other compatibility forms become plain ASCII (NFKC), invisible characters go, and
// look-alike Cyrillic and Greek letters become the Latin letters they imitate, so "Gооgle" is read as Google and "８４,２００" as 84,200.
const LOOK: Record<string, string> = Object.fromEntries(
  ("а:a е:e о:o р:p с:c х:x у:y і:i ј:j ѕ:s һ:h ԁ:d ӏ:l к:k м:m т:t н:h в:b ѵ:v ԛ:q ԝ:w ɡ:g ı:i " +
   "А:A В:B С:C Е:E Н:H І:I Ј:J К:K М:M О:O Р:P Ѕ:S Т:T Х:X У:Y Ү:Y " +
   "Α:A Β:B Ε:E Ζ:Z Η:H Ι:I Κ:K Μ:M Ν:N Ο:O Ρ:P Τ:T Υ:Y Χ:X α:a ε:e ι:i κ:k ν:v ο:o ρ:p τ:t υ:u χ:x").split(" ").map((x) => [x[0], x[2]]));
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
// Every Unicode decimal digit (Nd) reads as its ASCII value: Nd characters come in contiguous runs of ten that start at zero.
const ND = (() => {
  const m = new Map<string, string>(); let run = 0;
  for (let cp = 0x660; cp < 0x1E960; cp++) {
    const c = String.fromCodePoint(cp);
    if (/\p{Nd}/u.test(c)) { m.set(c, String(run % 10)); run++; } else run = 0;
  }
  return m;
})();
const ARABIC_MARKS: Record<string, string> = { "٪": "%", "٬": ",", "٫": ".", "﹪": "%" };
export const fold = (s: string) => String(s ?? "").normalize("NFKC").replace(INVISIBLE, "").replace(/\p{Nd}|[٪٬٫﹪]/gu, (c) => ND.get(c) ?? ARABIC_MARKS[c] ?? c).replace(/[\u0370-\u03FF\u0400-\u04FF\u0131\u0261]/g, (c) => LOOK[c] ?? c);
const norm = (s: string) => fold(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
export const stripNonClaims = (s: string) => s.replace(/\[[^\]]*\]/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/`[^`]*`/g, " ");

// ---------------------------------------------------------------------------------------------- numbers
const ONES: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALE: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const ORD: Record<string, number> = { fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, hundredth: 100, thousandth: 1000 };
const VAGUE = new Set(["dozens", "hundreds", "thousands", "millions", "billions"]);
const FRAC: Record<string, number> = { half: 0.5, halves: 0.5, quarter: 0.25, quarters: 0.25, thirds: 1 / 3, fifths: 0.2 };
const NUMWORD = new Set([...Object.keys(ONES), ...Object.keys(TENS), ...Object.keys(SCALE), "and", "a", "an"]);
const isNumWord = (w: string) => w in ONES || w in TENS || w in SCALE;
const TIME_UNIT = /^(?:days?|weeks?|months?|years?)\b/;
const MONEY_UNIT = /^(?:dollars?|usd|eur|gbp|bucks|euros?|pounds?|rupees?|yen)\b/;
const PCT_UNIT = /^(?:percent|per cent|percentage points?|%)/;

// kind: what the number counts. pct, usd, yrs (years), dur (other spans of time), cnt (a plain thing: "6 openings"), or "" when
// nothing follows to say. A claim's kind must equal the kind of the number it matches in the source.
export type Kind = "pct" | "usd" | "yrs" | "dur" | "cnt" | "";
export interface Num { v: number; unit: "pct" | "usd" | ""; raw: string; word?: string; date?: boolean; kind?: Kind }
// All the numbers in a text. Spelled numbers up to ten are ordinary counting ("one question", "two or three samples") and are
// ignored unless they carry a percent, a money unit or a time span ("five years").
const NOT_A_THING = new Set(("median average mean total typical annual annually monthly weekly daily yearly overall roughly approximately nationally nationwide " +
  "more less fewer higher lower over under above below plus minus per each a an the of in on at to for from with by and or but as is are was were be").split(" "));
const YEAR_UNIT = /^(?:years?|yrs?|yr)\b/;
const DUR_UNIT = /^(?:days?|weeks?|months?|hours?|hrs?|minutes?|mins?|seconds?|semesters?|quarters?)\b/;
function kindOf(n: Num, next: string): Kind {
  if (n.unit) return n.unit;
  if (n.date) return "";
  if (YEAR_UNIT.test(next)) return "yrs";
  if (DUR_UNIT.test(next)) return "dur";
  const w = /^[a-z][a-z-]*/.exec(next)?.[0];
  return w && !NOT_A_THING.has(w) && !/ly$/.test(w) ? "cnt" : "";
}
export function numbersIn(text: string): Num[] {
  let t = norm(text).replace(/(\d),(?=\d{3}\b)/g, "$1");
  for (const p of GK_PHRASES) t = t.split(p).join(" ");
  const out: Num[] = [];
  const unitAfter = (rest: string, pre: string): "pct" | "usd" | "" => (/[$€£¥₹]$/.test(pre) || MONEY_UNIT.test(rest.trimStart()) ? "usd" : PCT_UNIT.test(rest.trimStart()) ? "pct" : "");
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => { out.push({ v: Date.parse(m) || 0, unit: "", raw: m, date: true }); return " "; });
  // ratios and fractions first: "one in three", "3 out of 10", "3/4"
  t = t.replace(/\b(\d+|[a-z]+)\s+(?:in|out of)\s+(\d+|[a-z]+)\b/g, (m, a, b) => {
    const x = /^\d+$/.test(a) ? +a : ONES[a], y = /^\d+$/.test(b) ? +b : ONES[b];
    if (x === undefined || y === undefined || !y) return m;
    out.push({ v: x / y, unit: "", raw: m }); return " ";
  }).replace(/\b(\d+)\/(\d+)\b/g, (m, a, b) => { if (+b) out.push({ v: +a / +b, unit: "", raw: m }); return " "; });
  const re = /([$€£¥₹]?)(\d+(?:\.\d+)?)(?:st|nd|rd|th)?\s?(k|m|b|bn|thousand|million|billion)?\b|([a-z]+(?:-[a-z]+)*)/g;
  let m: RegExpExecArray | null;
  const toks: { n: Num; scaled: boolean; at: number; end: number }[] = [];
  while ((m = re.exec(t))) {
    const rest = t.slice(re.lastIndex);
    if (m[2] !== undefined) {
      const sc = m[3] ? { k: 1e3, m: 1e6, b: 1e9, bn: 1e9, thousand: 1e3, million: 1e6, billion: 1e9 }[m[3]]! : 1;
      toks.push({ n: { v: +m[2] * sc, unit: unitAfter(rest, m[1] + (m[0].endsWith("%") ? "" : "")), raw: m[0].trim() }, scaled: sc > 1, at: m.index, end: re.lastIndex });
      if (t[re.lastIndex] === "%") toks[toks.length - 1].n.unit = "pct";
      continue;
    }
    // spelled numbers: a run like "seventy thousand", "twenty-five", "two hundred and fifty", "a hundred"
    const words = m[4].split("-");
    if (m[4] in FRAC) { const prev = toks[toks.length - 1]; if (prev && prev.end >= m.index - 6 && /^(?:one|two|three|four|five|a|an)$/.test(t.slice(prev.at, m.index).trim())) toks.pop(); out.push({ v: FRAC[m[4]], unit: "", raw: m[4] }); continue; }
    if (VAGUE.has(m[4])) { out.push({ v: -1, unit: "", raw: m[4], word: m[4] }); continue; }
    if (m[4] in ORD) { out.push({ v: ORD[m[4]], unit: "", raw: m[4] }); continue; }
    if (!words.some(isNumWord)) continue;
    // extend the run over following number words
    let j = re.lastIndex, run = words.filter((w) => w in ONES || w in TENS || w in SCALE || w === "and");
    for (;;) {
      const nx = /^\s+(and\s+)?([a-z]+(?:-[a-z]+)*)/.exec(t.slice(j));
      if (!nx) break;
      const ws = nx[2].split("-");
      if (!ws.every((w) => isNumWord(w))) break;
      run = run.concat(nx[1] ? ["and"] : [], ws); j += nx[0].length;
    }
    re.lastIndex = j;
    let total = 0, cur = 0;
    for (const w of run) { if (w in ONES) cur += ONES[w]; else if (w in TENS) cur += TENS[w]; else if (w === "hundred") cur = (cur || 1) * 100; else if (w in SCALE) { total += (cur || 1) * SCALE[w]; cur = 0; } }
    toks.push({ n: { v: total + cur, unit: unitAfter(t.slice(j), ""), raw: run.join(" ") }, scaled: run.some((w) => w in SCALE && w !== "hundred"), at: m.index, end: j });
  }
  for (let i = 0; i < toks.length; i++) {
    const { n } = toks[i], next = t.slice(toks[i].end).trimStart(), prevText = t.slice(i ? toks[i - 1].end : 0, toks[i].at);
    // "50 to 60 thousand": the scale of the second number is the first one's too
    const nx = toks[i + 1];
    if (nx && nx.scaled && !toks[i].scaled && n.v < 1000 && /^\s*(?:to|-|or|and)\s*$/.test(t.slice(toks[i].end, nx.at))) n.v *= nx.n.v >= 1e9 ? 1e9 : nx.n.v >= 1e6 ? 1e6 : 1e3;
    const small = n.v <= 10 && Number.isInteger(n.v) && !/^\d/.test(n.raw) && !/\d/.test(n.raw);
    const significant = !small || n.unit !== "" || TIME_UNIT.test(next) || /[$€£¥₹]$/.test(prevText);
    // a range inherits the kind of its far end: "5 to 10 percent"
    n.kind = kindOf(n, next);
    if (n.kind === "" && nx && /^\s*(?:to|-|or|and)\s*$/.test(t.slice(toks[i].end, nx.at))) n.kind = kindOf(nx.n, t.slice(nx.end).trimStart());
    if (significant) out.push(n);
  }
  return out;
}
const numEq = (s: Num, n: Num) => (s.v === n.v || Math.abs(s.v - n.v) <= 1e-9 * Math.max(1, Math.abs(n.v)))
  && (n.unit !== "pct" || s.unit === "pct") && (n.unit !== "usd" || s.unit !== "pct")
  && (!n.kind || !s.kind || n.kind === s.kind);

// ---------------------------------------------------------------------------------------------- words
const STOP = new Set(("the a an and or but of in on at to for from with by as is are was were be been being it its this that these those there their they them you your we our i me my he she his her not no do does did can could will would should may might must have has had over under about into than then also only just more most less very much many some any each every per via out up down off such so if when while which who whom what how why where all both other another same own after before between during through against among within without across around toward until since because is's").split(" "));
const stem = (w: string) => w.replace(/ies$/, "y").replace(/(?:ss|x|ch|sh)es$/, (m) => m.slice(0, -2)).replace(/s$/, "").replace(/(?:ing|ed|ly)$/, "").replace(/e$/, "");
export const contentWords = (s: string) => new Set((norm(s).match(/[a-z][a-z'-]{2,}/g) ?? []).filter((w) => !STOP.has(w) && !isNumWord(w) && !(w in FRAC) && !VAGUE.has(w) && !(w in ORD) && !/^(?:percent|dollars?|usd)$/.test(w)).map(stem));
// Subject words: the occupation, group or thing a number is ABOUT. Measure words ("median", "wage", "earned", "grow"), verbs and
// generic time words say what kind of number it is, not whose it is, so they never count as the subject.
const MEASURE = new Set(("median mean average typical annual yearly monthly weekly hourly daily wage wages pay paid salary salaries income incomes compensation earn earns earned earning earnings make makes made rate rates percent percentage growth grow grows grew grown growing increase increases increased decrease decreased decline declined rise rose fall fell project projected projects employment expected expect expects reach reached range ranges ranged around about roughly nearly approximately over under least most recent latest year years decade survey report reports reported according data source number numbers total amount figure figures value level levels cost costs last lasts hire hires hired work works worked get gets got receive receives received see sees saw need needs must may require requires required typically usually often will would should can could pass passes finish finishes stay stays remain remains offer offers").split(" ").map(stem));
const subjectsOf = (s: string) => new Set([...contentWords(s)].filter((w) => !MEASURE.has(w) && !/(?:ed|ing)$/.test(w)));
const sentences = (s: string) => s.split(/(?<=[.!?;])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n; };

// ---------------------------------------------------------------------------------------------- names
const GAZETTEER = ("goldman|lazard|mckinsey|bain|bcg|deloitte|pwc|kpmg|jpmorgan|jp morgan|morgan stanley|citigroup|citi|barclays|ubs|evercore|moelis|houlihan|blackstone|kkr|carlyle|apollo|jefferies|rothschild|amazon|google|alphabet|meta|facebook|apple|microsoft|netflix|nvidia|tesla|stripe|uber|airbnb|openai|anthropic|oracle|salesforce|ibm|intel|cisco|adobe|palantir|spacex|boeing|lockheed|raytheon|northrop|ford|toyota|walmart|costco|kaiser|mayo|cleveland clinic|johns hopkins|ibew|mit|stanford|harvard|yale|princeton|duke|teach for america|americorps|peace corps|skillbridge|hack reactor|coursera|udemy|general assembly|springboard|linkedin|indeed|glassdoor|handshake|accenture|booz allen|capgemini|infosys|tcs|wipro|cognizant|fidelity|vanguard|blackrock|schwab|wells fargo|bank of america|chase|capital one|american airlines|delta|united airlines|southwest|disney|pixar|blizzard|ubisoft|riot|epic games|nintendo|sony").split("|");
const GAZ_RX = new RegExp(`(?<![a-z])(?:${GAZETTEER.map((g) => g.replace(/ /g, "\\s+")).join("|")})(?![a-z])`, "gi");
let VOCAB: Set<string> | null = null;
function vocab(): Set<string> {
  if (VOCAB) return VOCAB;
  const text = [...PLAYBOOKS.map((b) => b.body), ...FIELDS.flatMap((f) => [f.label, f.now, f.later, ...Object.values(f.slots), ...f.targets, ...f.credentials, ...f.who, ...f.asks, ...f.verify, ...f.queries.map((q) => q.q)]),
    ...OVERLAYS.flatMap((o) => [o.read, o.stage ?? "", o.network ?? "", o.verify ?? ""]), [...STOP].join(" "),
    "advice conversation call chat message email note resume portfolio project projects interview interviews intern internship internships role roles job jobs hire hired hiring offer offers firm firms company companies team teams manager managers recruiter recruiters career careers school college university class campus program programs club clubs alumni mentor mentors friend friends family professor professors office hours skills skill experience degree license licenses certificate certification exam exams training apprentice apprenticeship union contractor contractors hospital hospitals clinic clinics district districts agency agencies startup startups bank banks studio studios employer employers industry sector field fields market local state states city cities country region area areas week weeks month months year years season semester summer fall spring winter term hand scratch hour minute minutes today tomorrow friday monday"]
    .join(" ").toLowerCase().match(/[a-z][a-z'-]+/g) ?? [];
  VOCAB = new Set(text.map(stem));
  return VOCAB;
}
const CUE = /\b(?:at|with|from|joining|join|joined|by|for|inside|within)\s+([a-z][a-z0-9&'-]{2,})/g;

// Is the number n in this passage within a short stretch of words (12) that also holds one of the claim's subject words?
function nearSubject(passage: string, n: Num, subj: Set<string>): boolean {
  if (!subj.size) return true;
  const w = fold(passage).split(/\s+/).filter(Boolean);
  for (let i = 0; i < Math.max(1, w.length - 11); i++) {
    const win = w.slice(i, i + 12).join(" ");
    if (numbersIn(win).some((x) => numEq(x, n)) && overlap(subj, subjectsOf(win)) > 0) return true;
  }
  return false;
}

export interface Specifics { numbers: string[]; names: string[] }
const COMMON = new Set(["i", "i'm", "i'll", "i've", "i'd", ...STOP, "ask", "use", "get", "take", "keep", "build", "apply", "start", "look", "add", "write", "finish", "check", "learn", "join", "move", "plan", "pick", "practice", "replace", "translate", "update", "target", "choose", "confirm", "complete", "pass", "become", "have", "now", "later", "first", "second", "once", "assuming", "treat", "usually", "rarely", "often", "hi", "thanks", "source", "sources", "general", "knowledge", "retrieved", "none", "nothing", "right", "realistic", "written", "what", "which", "who", "how", "why"]);
function capitalizedNames(t: string): string[] {
  const names = new Set<string>(), re = /[A-Za-z][A-Za-z0-9&'’.-]*/g, words: { w: string; start: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) words.push({ w: m[0].replace(/[.'’-]+$/, ""), start: /(^|[.?!:"“—–(]|\n)\s*$/.test(t.slice(0, m.index)) });
  for (let i = 0; i < words.length; i++) {
    const { w, start } = words[i];
    if (w.length < 2 || !/^[A-Z]/.test(w)) continue;
    const next = words[i + 1], acronym = /^[A-Z][A-Z0-9&-]{1,}$/.test(w);
    if (start && !acronym && !(next && !next.start && /^[A-Z]/.test(next.w) && !COMMON.has(next.w.toLowerCase()))) continue;
    if (COMMON.has(w.toLowerCase())) continue;
    names.add(w);
  }
  return [...names];
}
const clean = (text: string) => stripNonClaims(fold(text)).replace(/\bF-1\b/g, "F").replace(/^\s*(?:[-*]|\d+[.)])\s+/gm, "").replace(/\*\*/g, "");
export function specifics(text: string): Specifics {
  const t = clean(text);
  return { numbers: [...new Set(numbersIn(t).map((n) => n.raw))], names: [...new Set([...capitalizedNames(t), ...(t.match(GAZ_RX) ?? []).map((x) => x.toLowerCase())])] };
}

// Does the support account for every number and name in `text`? `support` is a list of passages (or one string).
export function unsupported(text: string, support: string | string[], allowGK = true): string[] {
  const passages = (Array.isArray(support) ? support : [support]).flatMap((p) => sentences(String(p))).filter(Boolean);
  const supFlat = norm(passages.join(" \n ")), out: string[] = [];
  const pNums = passages.map((p) => ({ text: p, nums: numbersIn(p), words: contentWords(p) }));
  const t = clean(text);
  for (const s of sentences(t)) {
    const nums = numbersIn(s);
    if (!nums.length) continue;
    const words = contentWords(s), need = Math.min(2, words.size), subj = subjectsOf(s);
    for (const n of nums) {
      const ok = n.word ? supFlat.includes(n.word) : pNums.some((p) => p.nums.some((x) => numEq(x, n)) && (n.date || (overlap(words, p.words) >= need && nearSubject(p.text, n, subj))));
      if (!ok) out.push(n.raw);
    }
  }
  const named = [...capitalizedNames(t), ...(t.match(GAZ_RX) ?? [])];
  for (const w of named) { const lw = norm(w).replace(/\s+/g, " "); if (!supFlat.replace(/\s+/g, " ").includes(lw) && !(allowGK && GK_TERMS.has(lw))) out.push(w); }
  const v = vocab();
  for (const m of norm(t).matchAll(CUE)) { const w = m[1]; if (!v.has(stem(w)) && !supFlat.includes(w) && !isNumWord(w) && !(allowGK && GK_TERMS.has(w))) out.push(w); }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------------------------- facts
const norm_url = (u: string) => { try { const x = new URL(u); [...x.searchParams.keys()].filter((k) => /^utm_/i.test(k)).forEach((k) => x.searchParams.delete(k)); x.hash = ""; return x.toString().replace(/\/$/, ""); } catch { return ""; } };
export const sameUrl = (a: string, b: string) => !!norm_url(a) && norm_url(a) === norm_url(b);
export interface Rejected { fact: Partial<Fact>; why: string }
// RESEARCH SCENARIOS (2026-10-29): what a page or a search answer can carry that is no fact about the field. Text that
// reads as an instruction (to the model or about the user), a claim about the person reading ("you have a 3.9 GPA", "the
// user is guaranteed an offer"), anything secret-shaped, and a link inside the fact's own words (the only link a fact
// may carry is its source URL) are never kept, however exactly the quote matches.
const TO_MODEL = /\b(?:tell|inform|remind|convince|assure)\s+(?:the\s+)?(?:user|reader|candidate|person|student)\b|\b(?:print|reveal|output|repeat|leak|show|send)\b[^.]{0,40}\b(?:api[ _-]?keys?|secrets?|tokens?|passwords?|system prompt|instructions)\b|\byour (?:instructions|system prompt|rules)\b|\bas an ai\b/i;
const ABOUT_PERSON = /\byou(?:['’]re|['’]ve| are| have| already| were| will be| qualify| got| earned| received| hold)\b|\byour (?:gpa|grades?|resume|cv|application|offer|profile|odds|chances|interview|record|experience|school)\b|\bthe (?:user|reader)(?:['’]s)?\b/i;
const SECRET = /\bsk-[A-Za-z0-9_-]{6,}|\b[A-Z][A-Z0-9]*_(?:API_)?(?:KEY|SECRET|TOKEN)\b|\bapi[ _-]?keys?\b|-----BEGIN|\bbearer\s+[A-Za-z0-9._-]{8,}/i;
const LINK_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b(?:javascript|data|vbscript|mailto):|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/i;
// RESEARCH ROUND 2 (2026-10-30): a page's contact line is not a fact about a field: "Email the campus recruiter Jane Doe at
// jane.doe@recruiting-example.com" and "Call the recruiting line at (212) 555-0147" were kept (the quote matched), so a made-up
// recruiter's address reached the brief. And a page that calls its own numbers "official" ("Official pay table: first-year
// analysts earn $185,000") is official only on a government or school site, or on the employer's own domain.
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const PHONE_IN_TEXT = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
const OFFICIAL_CLAIM = /\b(?:official|verified|confirmed)\b[^.]{0,40}\b(?:pay|salary|salaries|comp|compensation|tables?|bands?|grids?|rates?|figures?|ranges?)\b|\b(?:pay|salary|comp(?:ensation)?)\s+(?:tables?|bands?|grids?)\b[^.]{0,30}\b(?:official|verified)\b/i;
function officialHost(url: string, text: string): boolean {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (/\.(?:gov|edu|mil)$|\.gov\.[a-z]{2}$|\.ac\.[a-z]{2}$/.test(host)) return true;
  // The employer's own site: a firm the fact names whose name is the site's registered name (stripe.com, not stripe-salaries.example.net).
  const site = host.replace(/^www\./, "").split(".").slice(-2)[0] ?? "";
  return (text.match(GAZ_RX) ?? []).some((n) => n.toLowerCase().replace(/[^a-z0-9]/g, "") === site);
}
export function notAFact(f: { text?: string; quote?: string; url?: string }): string | null {
  const text = fold(String(f.text ?? "")), quote = fold(String(f.quote ?? ""));
  if (readsAsInstruction(text) || readsAsInstruction(quote) || TO_MODEL.test(text) || TO_MODEL.test(quote)) return "reads as an instruction, not a fact";
  if (SECRET.test(text) || SECRET.test(quote)) return "carries something secret-shaped";
  if (ABOUT_PERSON.test(text)) return "a claim about the person, not the field";
  if (LINK_IN_TEXT.test(text)) return "a link inside the fact's words";
  if (EMAIL_IN_TEXT.test(text) || PHONE_IN_TEXT.test(text)) return "a contact address or number, not a fact";
  if ((OFFICIAL_CLAIM.test(text) || OFFICIAL_CLAIM.test(quote)) && !officialHost(String(f.url ?? ""), `${text} ${quote}`)) return "says it is official, but its source is not a government, school or employer page";
  return null;
}
// A retrieved fact stays only if: its URL is one the search returned; it carries a verbatim quote; and every number in the fact's
// text is in a quote passage that shares the claim's subject words, and every name is in the quote. The model's paraphrase can
// drop words but cannot add a figure, change a number's subject, or introduce an employer.
export function acceptFacts(facts: Fact[], returnedUrls: string[]): { kept: Fact[]; rejected: Rejected[] } {
  const kept: Fact[] = [], rejected: Rejected[] = [];
  for (const f of facts) {
    const bad = (why: string) => rejected.push({ fact: f, why });
    if (!f || typeof f.text !== "string" || !f.text.trim()) { bad("empty"); continue; }
    if (!/^https:\/\//i.test(String(f.url ?? ""))) { bad("no https source URL"); continue; }
    const source = returnedUrls.find((u) => sameUrl(u, f.url));
    if (!source) { bad("URL not among the sources the search returned"); continue; }
    if (!/^https:\/\//i.test(source)) { bad("no https source URL"); continue; }
    if (!f.quote || f.quote.trim().length < 8) { bad("no quote from the source"); continue; }
    if (f.text.length > 320) { bad("too long to verify"); continue; }
    const not = notAFact(f);
    if (not) { bad(not); continue; }
    const extra = unsupported(f.text, [f.quote], false);
    if (extra.length) { bad(`not in the quote: ${extra.join(", ")}`); continue; }
    // The link shown is the source's own URL, exactly as the search returned it (never the model's copy, never rewritten).
    kept.push({ ...f, url: source });
  }
  return { kept, rejected };
}

// ---------------------------------------------------------------------------------------------- the finished brief
// What the harness and the tool both ask of a finished brief: every number and name in its body is in a kept fact (text or
// quote), in the person's confirmed or said facts, in the message, or in the general-knowledge list. The sources list and the
// headings are not claims. Returns what is unsourced; empty is the only pass.
export function unsourcedIn(brief: string, support: { facts: Fact[]; person: string[]; message: string }): string[] {
  const body = brief.replace(/^\d+\. S\d+: https?:\/\/.*$/gm, " ").replace(/^#+ .*$/gm, " ").replace(/\[S\d+[^\]]*\]/g, " ").replace(/\(general knowledge[^)]*\)/gi, " ");
  const passages = [...support.facts.flatMap((f) => [f.text, f.quote, f.label]), ...support.person, support.message];
  const out = new Set<string>();
  for (const line of body.split("\n")) for (const x of unsupported(line, passages)) out.add(x);
  return [...out];
}
