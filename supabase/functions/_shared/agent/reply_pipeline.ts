// REPLY PIPELINE (docs/architect/specs/REPLY-PIPELINE.md): evidence ledger -> tagged draft -> verify against the cited units only ->
// one repair pass -> drop -> code's fallback line. One mechanism for every reply that rests on research, a posting or the record;
// nothing here knows any turn of any test set.
//
//   ledger    numbered evidence units, each from one of three places: a page unit (one sentence or table row, with its host and
//             kind), this chat's tool results (a posting's pay by place, its deadline and state, a search's count, a file made), or
//             the person's confirmed record, what it lacks included ("not on file: city, phone").
//   draft     the drafting model gets the units (LEDGER_RULE + Ledger.block()) and tags each factual sentence [E3] or [E3,E7]. A
//             sentence with no figure, name or date needs no tag (support.ts noClaim), nor does a question with no figure.
//   verify    each clause of a tagged sentence (support.ts clausesOf) against the units it cites and nothing else: layer A
//             (findSupport on an index of those units), then the judge, in one batch. Tags are removed before sending.
//   repair    ONE model call for everything that failed (a sentence, the length, the task contract), each with code's reason in
//             code's words; the answer is verified again; what still fails is dropped. It replaces the shortener and the quote fallback.
//   fallback  after the drop, when nothing left answers, code says what it could not verify and what the ledger holds (a posting's
//             pay with its link).
import { ADVICE_CLAIM, bare, clausesOf, findSupport, hardParts, indexPages, judgeAll, nameFoundIn, noClaim, ownAction, personQuestion, plainTalk, recordOnly, splitSentences, type SupportJudge, urlEmployer } from "./research/support.ts";

// ON (ruling 2026-11-14): the drafting prompt asks for tags and every tool result carries its units. The path is chosen by the draft:
// a TAGGED draft goes through this pipeline (no page quote is ever put in place of a sentence); an UNTAGGED one (a model that ignored
// the tags, a scripted test) keeps the support check unchanged, its quote fallback included. The trace says which (`pipeline`).
export const PIPELINE = { on: true };
export const isTagged = (t: string) => /\[E\d+(?:\s*,\s*E\d+)*\]/.test(String(t ?? ""));
export type EvidenceKind = "page" | "chat" | "record" | "absent";
export interface EvidenceUnit { id: string; kind: EvidenceKind; text: string; host?: string | null; url?: string | null; source?: string; places?: string[]; owner?: string | null; named?: string[]; posting?: boolean; dated?: string[] }

// Units a tool added this turn (pages, posting records, counts): the turn rests on evidence only when it has one. Lines carried from
// earlier replies, the person's record and what it lacks do not make a turn an evidence turn.
export const evidenceTurn = (l: Ledger | null) => !!l && l.units.some((u) => (u.kind === "page" || u.kind === "chat") && u.source !== "an earlier reply in this chat");
export class Ledger {
  units: EvidenceUnit[] = [];
  // The turn's clock (PROCESS rule 6): a year in a posting's title names the role only when it is this year or later.
  constructor(readonly now: number = Date.now()) {}
  add(kind: EvidenceKind, text: string, meta: { host?: string | null; url?: string | null; source?: string; places?: string[]; owner?: string | null; named?: string[]; posting?: boolean; dated?: string[] } = {}): string {
    const t = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    const had = this.units.find((u) => u.kind === kind && u.text === t && (u.url ?? null) === (meta.url ?? null));
    if (had) return had.id;
    const id = `E${this.units.length + 1}`;
    // A chat unit written "Employer, Title (Place): …" belongs to that employer even when the caller named no owner (lines carried
    // from earlier replies); a figure's subject is checked against it.
    const guess = kind === "chat" && meta.owner === undefined ? (/^(\p{Lu}[\p{L}&'. -]*?)(?=,|\s\(|:)/u.exec(t)?.[1]?.trim() ?? null) : null;
    // (round 4 of #849: a place, "Chicago, IL: …", is never an owner)
    const place = /^[^,:(]+,\s?[A-Z]{2}\b/.test(t) || (meta.places ?? []).some((p) => guess && p.split(",")[0].trim() === guess);
    const inferred = meta.owner !== undefined ? meta.owner : guess && !place && !/^(?:The|A|An|This|That|These|Those|To|Your|Our|It|Its|Pay|Not)\b/.test(guess) && guess.split(/\s+/).length <= 5 ? guess : null;
    this.units.push({ id, kind, text: t, ...meta, owner: inferred ?? null });
    return id;
  }
  get(id: string): EvidenceUnit | undefined { return this.units.find((u) => u.id === id); }
  // What a tool returned, as units, by the shape of what it returned (never by tool or turn): posting records, pages' units, counts,
  // files made. Returns the ids added.
  fromToolResult(name: string, out: unknown, file: { fileUrl?: string | null; fileTexts?: string[] } = {}): string[] {
    const ids: string[] = [];
    const o = (out && typeof out === "object" ? out : null) as Record<string, any> | null;
    if (!o) return ids;
    const postings: any[] = [...(Array.isArray(o.postings) ? o.postings : []), ...(Array.isArray(o.results) ? o.results : []), ...(o.posting && typeof o.posting === "object" ? [o.posting] : [])];
    for (const p of postings) {
      const url = typeof p?.url === "string" ? p.url : typeof o.url === "string" ? o.url : null;
      // Round 9 of #849 (B4): a posting whose record gives no company (a Workday apply flow) is the employer its own fields name: its
      // URL's ATS board or host, else "… at <Employer>" in its title; spelled as the turn or the posting already spells it.
      const company = typeof p?.company === "string" && p.company.trim() ? p.company.trim() : this.employerOf(p, url);
      const who = [company, p?.title].filter((x) => typeof x === "string" && x.trim()).join(", ");
      // (the posting's title names the role: a year in it, "Summer 2027", dates no figure of the unit; round 10: only this year or a
      // later one, by the turn's clock: "Summer 2023" still dates the figure, so a claim in the present tense must carry it)
      // (round 11: a season or term counts until it ends: Summer to Aug 31, Fall or Autumn to Dec 31, Spring to Jun 30, Winter to Mar 31;
      // a bare year to Dec 31. "Summer 2026" read in November 2026 is over, so it dates the figure)
      const named = typeof p?.title === "string" && p.title.trim() && titleYearsCurrent(p.title, this.now) ? [p.title.trim()] : [];
      // (round 12: a title whose period has ended dates the unit's figures however its year is written, "2026 Summer Internship":
      // a claim on it must carry that year)
      const dated = typeof p?.title === "string" && !titleYearsCurrent(p.title, this.now) ? [...new Set([...p.title.matchAll(/(?<!\d)((?:19|20)\d\d)(?!\d)|['’](\d\d)(?!\d)/g)].map((m: RegExpMatchArray) => m[1] ?? `20${m[2]}`))] : [];
      // (the posting's own places, so layer A reads "Chicago, IL" there as a place, never as an owner)
      const places = [p?.location, ...String(p?.pay ?? "").split(/;\s*/).map((x: string) => /^([^:]+):/.exec(x)?.[1])].filter((x): x is string => typeof x === "string" && /,/.test(x)).map((x) => x.trim());
      if (typeof p?.pay === "string" && p.pay.trim()) for (const part of p.pay.split(/;\s*/)) ids.push(this.add("chat", `${who}${p?.location ? ` (${p.location})` : ""}: pay ${part.trim()}`, { url, source: name, places, owner: company, named, posting: true, dated }));
      const dl = [p?.deadline, p?.closes, p?.close_date].find((x) => typeof x === "string" && x.trim());
      const st = typeof p?.state === "string" ? p.state : null;
      if (st || dl) ids.push(this.add("chat", `${who}: the posting is ${st ?? "listed"}${dl ? `; it closes ${dl}` : ""}.`, { url, source: name, owner: company, named, posting: true, dated }));
    }
    if (Array.isArray(o.postings)) ids.push(this.add("chat", `The search (${name}) returned ${o.postings.length} posting${o.postings.length === 1 ? "" : "s"}.`, { source: name }));
    // Round 3 of #849: a requirement or a sign-in note belongs to its posting's employer, and says so in its text.
    const co: string | null = typeof o.company === "string" ? o.company : typeof o.posting?.company === "string" ? o.posting.company : postings.length === 1 && typeof postings[0]?.company === "string" ? postings[0].company :
      postings.length === 1 ? this.employerOf(postings[0], typeof postings[0]?.url === "string" ? postings[0].url : typeof o.url === "string" ? o.url : null) : null;
    const req = o.requirements && typeof o.requirements === "object" ? o.requirements : null;
    if (req) for (const k of ["required", "preferred"]) for (const x of Array.isArray(req[k]) ? req[k] : []) if (typeof x === "string") ids.push(this.add("chat", `${co ? `${co}: ` : ""}The posting ${k === "required" ? "requires" : "prefers"}: ${x}`, { source: name, owner: co }));
    if (o.sign_in_required === true) ids.push(this.add("chat", `${co ? `${co}: ` : ""}To apply, the person signs in to the employer's careers site themselves; its own questions are behind that sign-in and were not read.`, { source: name, owner: co }));
    for (const s of Array.isArray(o.sources) ? o.sources : []) for (const pt of [...(Array.isArray(o.points) ? o.points : []), ...(Array.isArray(o.summary) ? o.summary : [])])
      if (Array.isArray(pt?.cite) && pt.cite.includes(s?.n) && typeof pt?.text === "string") ids.push(this.add("page", pt.text, { url: s?.url ?? null, host: hostOf(s?.url), source: s?.kind ?? "reported" }));
    // Review of #849: the advice tool's guide passages are evidence too (they were never units, so advice could not be cited).
    for (const pg of Array.isArray(o.passages) ? o.passages : []) if (typeof pg?.text === "string") ids.push(this.add("page", pg.text, { url: typeof pg?.url === "string" ? pg.url : null, host: hostOf(pg?.url), source: typeof pg?.title === "string" ? pg.title : "guide" }));
    const link = typeof o.url === "string" && /file|tracker|page/i.test(name) ? o.url : null;
    if (link) ids.push(this.add("chat", `A ${name.replace(/_/g, " ")} file was made this turn.`, { url: link, source: name }));
    // CodeRabbit on #849: create_file returns no url (the link is the turn's, added after the reply), so a File made this turn is a
    // unit from what the tool reports and the turn records: that it was made, with its link, and its text, which passed the fact guard.
    else if (o.created === true && typeof o.kind === "string") {
      const fileUrl = file.fileUrl ?? null;
      ids.push(this.add("chat", `A ${o.kind.replace(/_/g, " ")} File${typeof o.title === "string" && o.title.trim() ? ` titled "${o.title.trim()}"` : ""} was made this turn.`, { url: fileUrl, source: name, owner: null }));
      for (const t of (file.fileTexts ?? []).slice(0, 40)) ids.push(this.add("chat", `The File made this turn says: ${t}`, { url: fileUrl, source: name, owner: null }));
    }
    return ids.filter(Boolean);
  }
  // The employer a posting with no company field is, from its other fields (round 9 of #849, B4), or null.
  employerOf(p: any, url: string | null): string | null {
    // (round 10 of #849: a known ATS board, or a host the posting's own text names; else "… at <Employer>" in its title; else none)
    const texts = Object.entries(p ?? {}).filter(([k, v]) => typeof v === "string" && !/url|link|href/i.test(k)).map(([, v]) => v as string).join(" \n ");
    const title = typeof p?.title === "string" ? p.title : "";
    const atTitle = /\bat\s+(\p{Lu}[\p{L}&.'-]*(?:\s+\p{Lu}[\p{L}&.'-]*){0,3})\s*$/u.exec(title)?.[1] ?? null;
    const slug = urlEmployer(url, texts) ?? atTitle;
    if (!slug) return null;
    const key = slug.toLowerCase().replace(/[^a-z0-9]/g, "");
    // (spelled as an employer already in the ledger, or as the posting's own text writes it, else in a capital)
    const had = this.units.map((u) => u.owner).find((w) => !!w && w.toLowerCase().replace(/[^a-z0-9]/g, "") === key);
    if (had) return had;
    const seen = [...texts.matchAll(/\p{Lu}[\p{L}&.'-]*(?:\s+\p{Lu}[\p{L}&.'-]*){0,3}/gu)].flatMap((m) => [m[0], ...m[0].split(/\s+/)]).find((w) => w.toLowerCase().replace(/[^a-z0-9]/g, "") === key);
    return seen ?? slug.split(/[-\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
  // The person's confirmed record, a fact per unit, and what it lacks.
  addRecord(facts: string[], absent: string[] = []): void {
    for (const f of facts) this.add("record", f, { source: "record" });
    if (absent.length) this.add("absent", `Not on file: ${absent.join(", ")}.`, { source: "record" });
  }
  block(ids?: string[]): string {
    const us = ids ? this.units.filter((u) => ids.includes(u.id)) : this.units;
    return us.map((u) => `[${u.id}] (${u.kind === "page" ? `page${u.host ? ` ${u.host}` : ""}${u.source ? `, ${u.source}` : ""}` : u.kind === "chat" ? "this chat's tool result" : u.kind === "absent" ? "the person's record lacks" : "the person's confirmed record"}) ${u.text}`).join("\n");
  }
}
const SEASON_END: Record<string, [number, number]> = { summer: [7, 31], fall: [11, 31], autumn: [11, 31], spring: [5, 30], winter: [2, 31] };
// Round 11/12 of #849 (N3): each year in the title (four digits, or "'26") goes with the season word nearest it anywhere in the title,
// before or after ("Summer 2026", "2026 Summer Internship", "Summer Internship 2026", "Summer '26"); with no season it runs to Dec 31.
// The title counts as current only while every such period has not ended by the turn's clock.
export function titleYearsCurrent(title: string, now: number): boolean {
  const t = String(title);
  const seasons = [...t.matchAll(/(?<![\p{L}])(summer|fall|autumn|spring|winter)(?![\p{L}])/giu)].map((m) => ({ at: m.index!, s: m[1].toLowerCase() }));
  const years = [...t.matchAll(/(?<!\d)((?:19|20)\d\d)(?!\d)|['’](\d\d)(?!\d)/gu)].map((m) => ({ at: m.index!, y: m[1] ? Number(m[1]) : 2000 + Number(m[2]) }));
  return years.every(({ at, y }) => {
    const near = seasons.slice().sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
    const [mo, d] = near ? SEASON_END[near.s] : [11, 31];
    return Date.UTC(y, mo, d, 23, 59, 59) >= now;
  });
}
const hostOf = (u: unknown) => { try { return typeof u === "string" ? new URL(u).hostname : null; } catch { return null; } };

export const LEDGER_RULE = "EVIDENCE: the numbered units below (and any `evidence` in a tool result) are the only facts you may state about the world, " +
  "the posting or the person. End each factual sentence with the ids it rests on, like [E3] or [E3,E7]; a sentence with no figure, name or date " +
  "needs none, and neither does a question. Never cite a unit that does not state what the sentence says. Code removes the tags.";

const TAG = /\s*\[(E\d+(?:\s*,\s*E\d+)*)\]/g;
export function tagsOf(sentence: string): { ids: string[]; text: string } {
  const ids = [...String(sentence ?? "").matchAll(TAG)].flatMap((m) => m[1].split(/\s*,\s*/));
  return { ids: [...new Set(ids)], text: String(sentence ?? "").replace(TAG, "").replace(/\s+([.,;:!?])/g, "$1").trim() };
}
export const stripTags = (t: string) => String(t ?? "").replace(TAG, "").replace(/[ \t]+([.,;:!?])/g, "$1");

export interface Failure { sentence: string; reason: string; subject?: string | null }
// `tagged`: what stood, with its tags, in place: what a later pass verifies again (round 8 of #849).
// `citeOf`: each kept sentence with the ids it stands on, so a sentence cut later takes its links with it (round 9 of #849).
export interface Verified { text: string; failures: Failure[]; kept: string[]; cites: string[]; tagged: string; subject: string | null; citeOf: [string, string[]][] }

// What layer A found missing, in code's words: each figure, name or date of the clause that no cited unit holds.
// The organisations a unit names: its owner, or for an unowned unit the capitalised name runs in its text, without its places,
// months and days, and without a sentence's first word when that word is a common opener (round 5 of #849).
const PLACE = /^(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|hampshire|jersey|mexico|york|carolina|dakota|ohio|oklahoma|oregon|pennsylvania|rhode|island|tennessee|texas|utah|vermont|virginia|washington|wisconsin|wyoming|chicago|boston|seattle|austin|dallas|houston|atlanta|denver|miami|francisco|san|los|angeles|diego|jose|new|city|canada|india|london|europe|america|american|states|united)$/i;
const NOT_NAME = /^(?:the|a|an|in|on|at|for|of|to|and|or|but|by|with|from|as|this|that|these|those|it|its|they|their|we|our|you|your|he|she|his|her|i|interns?|internships?|students?|software|engineers?|engineering|most|many|some|all|each|every|median|average|typical|pay|salary|salaries|base|total|jobs?|roles?|positions?|candidates?|applicants?|employers?|companies|firms|new|graduates?|entry|junior|senior|us|u\.s\.|usa|uk|eu|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|note|source|page|report|data|according)$/i;
// Figures in words that support.ts does not read as numbers: singular magnitudes and ordinals (round 5 of #849).
// (round 6: number senses only: "a hundred dollars", "a million", "second round"; "a second look" or a "Second," list opener is no figure)
const UNREAD = /\b(?:a|an|one|a few|several|over a|about a|nearly a|almost a)\s+(?:hundred|thousand|million|billion|trillion|dozen)\b|\b(?:hundreds|thousands|millions|billions)\b|\b(?:first|second|third|fourth|fifth|final|last)\s+(?:round|interview|stage|screen|call|cut|year|place|offer)s?\b|\b(?:twice|thrice)\b/i;
// Round 6 of #849: data sources and job boards are where a figure comes from, not whose it is.
const SOURCE = /^(?:glassdoor|levels(?:\.fyi)?|indeed|linkedin|handshake|payscale|ziprecruiter|reddit|blind|bls|bureau of labor statistics|labor statistics|wikipedia|forbes|bloomberg|reuters|cnbc|google|zippia|salary\.com|comparably|built ?in|wellfound|simplify|yahoo|investopedia)$/i;
export function unitNames(u: EvidenceUnit, weak = false): string[] {
  if (u.owner) return [u.owner];
  // Round 6: only a page's own text names organisations; lines carried from an earlier reply and the record name none here.
  if (u.kind !== "page") return [];
  const host = String(u.host ?? "").toLowerCase().replace(/^www\./, "").split(".")[0];
  const places = new Set((u.places ?? []).flatMap((p) => p.split(/,\s*/)).map((p) => p.trim().toLowerCase()));
  const out: string[] = [];
  const text = String(u.text);
  for (const m of text.matchAll(/\p{Lu}[\p{L}&'.-]*(?:\s+(?:&\s+)?\p{Lu}[\p{L}&'.-]*)*/gu)) {
    // (a single word that opens a sentence is often an ordinary word, "Registered nurses…", so it names no one; a run of two
    // or more, or a capitalised word inside a sentence, does)
    const start = /(?:^|[.!?:]\s+)$/.test(text.slice(0, m.index!));
    const words = m[0].replace(/[.'’]+$/, "").split(/\s+/).filter((w) => !NOT_NAME.test(w.replace(/[.'’s]+$/, "")) && !NOT_NAME.test(w) && !PLACE.test(w));
    // (with `weak`, an opening single word counts when what follows reads as an organisation's: "Citadel interns must…",
    // "Acme pays…", "Stripe's…"; "Registered nurses…" does not)
    // (round 7: an adverb or an appositive may sit between the name and its verb, "X typically requires", "X, a hedge fund,
    // pays"; and a name after at/for/with/joining is an employer too, "At Citadel, interns must…", "interns at Citadel")
    const after = text.slice(m.index! + m[0].length), before = text.slice(Math.max(0, m.index! - 40), m.index!);
    const VERB = "(?:interns?|internships?|employees?|engineers?|analysts?|staff|hires?|hiring|pays?|paid|offers?|requires?|wants?|expects?|asks?|has|have|is|was|gives?|provides?|sponsors?|recruits?|accepts?|rejects?|posted|lists?|needs?|must|will|can|does|doesn't|won't)";
    const orgish = new RegExp(`^(?:['’]s\\b|,\\s[^,.]{1,40},\\s+${VERB}\\b|\\s+(?:(?:typically|reportedly|also|only|usually|now|still|currently|generally|often|always|never)\\s+)?${VERB}\\b)`, "i").test(after) ||
      /^(?:at|for|with|joining|join)\s/i.test(m[0]) ||
      /\b(?:at|for|with|joining|join|from)\s+$/i.test(before) && !/\b(?:according|based|data|figures?|numbers?|reports?)\s+(?:to|on|from)\s+$/i.test(before);
    // (round 7: a source is dropped only where it is used as one, "on Glassdoor", "according to BLS", "per Levels.fyi"; Google or
    // the page's own host stating an employer fact about itself is that employer)
    const asSource = /\b(?:on|per|via|according to|source:|from|data from|reported by|by)\s+(?:the\s+)?$/i.test(before) || /^\s+(?:reports?|data|says|survey|estimates?|lists|shows)\b/i.test(after);
    // Round 6: a name counts only where the page states an employer fact about it ("Citadel interns must…", "Acme pays…");
    // "Python", "Fall 2027" or a source named in passing ("…on Glassdoor") name no employer.
    if (!orgish || asSource) continue;
    if (start && words.length < 2 && m[0].split(/\s+/).length < 2 && !weak) continue;
    const name = words.join(" ").replace(/['’]s$/, "").trim();
    if (name.length > 1 && !places.has(name.toLowerCase()) && !(asSource && (SOURCE.test(name) || name.toLowerCase().replace(/\s+/g, "") === host))) out.push(name);
  }
  return [...new Set(out)];
}
// Round 4 of #849: with `strict`, a name that opens the sentence is checked too ("Google requires…" was never checked), unless it is a
// common sentence opener; the judge path uses strict, so a one-word employer at the start is never left to the judge.
const OPENER = /^(?:want|would|shall|should|can|could|do|did|does|is|are|was|were|will|worth|heads|before|after|if|when|while|since|because|let|happy|glad|sure|ok|okay|thanks|please|may|might|must|need|how|what|which|who|why|where|sadly|unfortunately|note|start|also|however|good|great|here|yes|no|both|all|each|most|some|apply|send|ask|check|look|focus|use|keep|try|first|next|then|finally|overall|today|currently|right|so|still|plus|again|instead|meanwhile|otherwise|honestly|luckily|happily|thankfully|importantly|remember)$/i;
// Round 10 of #849 (D-088): what the judge is asked about advice or Trainee's own offer: that it states no fact the passage does not.
// SUPPORT_JUDGE_SYSTEM reads this shape (support.ts ADVICE_CLAIM).
export const adviceClaim = (sentence: string, subject: string | null) => `${ADVICE_CLAIM}${subject ? ` (it is about ${subject})` : ""}: "${sentence}"`;
// Round 11 of #849: a sentence's first word that is a function word or an imperative opener, never a name: an auxiliary or discourse
// opener (OPENER), an imperative (DIRECTIVE), a common word (NOT_NAME), a negative contraction ("Don't", "Won't"), an adverb in -ly
// ("Politely", "Ideally"), or a discourse adverb.
const FUNCTION_OPENER = (w: string) => { const x = w.replace(/['’]s$/, ""); return OPENER.test(x) || DIRECTIVE.test(x) || NOT_NAME.test(x) || /n['’]t$/i.test(w) || /^\p{L}{3,}ly$/iu.test(x) ||
  /^(?:never|always|just|maybe|perhaps|then|first|second|third|next|also|even|only|still|ever|soon|now|later|again|quick|tip|heads|honestly|anyway|besides|otherwise|instead|therefore|thus|hence|so|yet|once|here|there|now)$/i.test(x); };
// (round 9: an imperative opener, never a quantifier, an auxiliary or a discourse word: "Apply early" is advice; "Most interns…",
// "Also, interns…" are not)
const DIRECTIVE = /^(?:apply|send|ask|check|look|focus|use|keep|try|start|let|let's|remember|please|aim|pick|choose|avoid|skip|write|mention|lead|tailor|follow|reach|prepare|practice|practise|review|read|bring|save|plan|consider|add|make|say|tell|put|show|list|drop|cut|open|be|do|don't|never|always)$/i;
export function missingSpecifics(clause: string, units: EvidenceUnit[], strict = false): string[] {
  const all = units.map((u) => u.text).join(" \n ").toLowerCase(), h = hardParts(clause);
  const names = h.names.map((r, j) => j === 0 && r[0] === h.first && (!strict || OPENER.test(r[0] ?? "")) ? r.slice(1) : r).filter((r) => r.length).map((r) => r.join(" "));
  const figs = [...String(clause).matchAll(/(?:[$€£]\s?)?\d[\d,.]*(?:\s?(?:k|%|percent|days? ago|hours?|an hour|a year|per \w+))?/gi)].map((m) => m[0].trim());
  const digits = (f: string) => (/\d[\d,.]*/.exec(f)?.[0] ?? "").replace(/[.,]$/, "");
  const out = [...figs.filter((f) => !all.includes(digits(f))), ...names.filter((n) => !all.includes(n.replace(/^date(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")))];
  return [...new Set(out)];
}

// Verify a tagged reply against its ledger: what stands (tags removed), and every failure with its reason.
export async function verifyTagged(reply: string, ledger: Ledger, o: { judge?: SupportJudge | null; own?: string[]; onRecord?: (s: string) => boolean | null; ask?: string; carry?: string | null } = {}): Promise<Verified> {
  // (a question to the person may name only what their own record or their ask names)
  const allowed = [String(o.ask ?? ""), ...ledger.units.filter((u) => u.kind === "record").map((u) => u.text)].join("\n");
  const own = new Set((o.own ?? []).map((x) => x.trim()));
  const lines = String(reply ?? "").split("\n").map((l) => /^\s*(?:https?:\/\/\S+\s*)*$/.test(l) ? [l] : splitSentences(l).filter((x) => x.trim()));
  const raw = lines.map((l) => [...l]);
  const failures: Failure[] = [], kept: string[] = [];
  // (`parts`: a clause naming two or more employers, one part per employer, each with that employer's units; round 8 of #849)
  const checks: { a: number; b: number; clause: string; units: EvidenceUnit[]; claim: string; subject?: string | null; soft?: boolean; untagged?: boolean; parts?: { text: string; subject: string; units: EvidenceUnit[] }[]; advice?: boolean }[] = [];
  const bad = new Set<string>(), citeAt = new Map<string, string[]>();
  const fail = (a: number, b: number, sentence: string, reason: string, subject: string | null = null) => { failures.push({ sentence, reason, subject }); bad.add(`${a}:${b}`); };
  // Round 5 of #849: a page unit belongs to every organisation it names (a page sentence about Citadel is Citadel's), so the
  // employers known to the turn are the posting owners and the names in its page units, and a unit naming another one is never
  // used for a sentence about a different subject, or about none.
  const named = new Map(ledger.units.map((u) => [u.id, unitNames(u)]));
  // (for a sentence about no one, any name in the page counts, a sentence-opening one too: "Citadel interns must…")
  const anyNamed = new Map(ledger.units.map((u) => [u.id, unitNames(u, true)]));
  // (CodeRabbit on #849: a name a page opens with, "Acme pays interns…", is an employer of the turn too, so a claim naming it has it
  // as its subject)
  const owners = [...new Set([...ledger.units.map((u) => u.owner), ...[...anyNamed.values()].flat()].filter((w): w is string => !!w && w.trim().length > 1))];
  // (round 6: "one employer or several" counts the posting owners only)
  // (an owner guessed for a line carried from an earlier reply is that line's subject, not another employer of this turn)
  const postingOwners = new Set(ledger.units.filter((u) => u.source !== "an earlier reply in this chat").map((u) => u.owner).filter((w): w is string => !!w && w.trim().length > 1));
  // (round 7: a known employer written anywhere in a page names that page, whatever the phrasing)
  // (and in any unit no one owns, a File's text included: it names that employer too)
  for (const u of ledger.units) if (u.kind === "page" || !u.owner) for (const o of postingOwners) if (nameFoundIn(o, u.text)) {
    for (const map of [named, anyNamed]) { const xs = map.get(u.id) ?? []; if (!xs.includes(o)) map.set(u.id, [...xs, o]); }
  }
  const mine = (u: EvidenceUnit, subj: string | null) => u.owner ? (subj ? u.owner === subj : postingOwners.size < 2)
    : subj ? nameFoundIn(subj, u.text) : (anyNamed.get(u.id) ?? []).length === 0 && !(postingOwners.size >= 2 && u.source === "an earlier reply in this chat");
  // Round 8 of #849 (structural, not lexical): every clause has a subject: the first employer it names, else the one carried from
  // the clause before it, across sentences, whatever words refer back ("it", "the company", "there", "this role", none at all).
  // Only a newly named employer changes it. `o.carry` is the subject the text continues from (what precedes it where it is sent).
  // A carried subject is soft: its clause may stand on that employer's units or on a unit that names no employer at all, never on
  // another employer's, and the judge is always shown the subject. A clause naming two or more employers is a comparison: it is
  // checked part by part, and leaves no single subject to carry.
  // (subjects are the employers the ledger knows, in the order they appear in the text: the first one named is the subject; review
  // of #849, rounds 2 and 4)
  const at = (w: string, t: string) => { const i = t.toLowerCase().indexOf(w.toLowerCase()); return i < 0 ? t.length : i; };
  const mentioned = (t: string) => owners.filter((w) => nameFoundIn(w, t)).sort((x, y) => at(x, t) - at(y, t));
  let carried: string | null = o.carry ?? null;
  // Round 10 of #849: an employer the turn does not know ("Stripe's internship is in Seattle" when no tool result names Stripe) is a
  // subject too: read as a page reads one (unitNames: "X's", "X pays", "at X"), and found in no unit at all. It is carried like any
  // other, so "It pays $60 an hour" after it never stands on another employer's unit.
  // (round 11: a name, never a capitalised function word or an imperative opener read as one: "Don't ask…", "Never…", "Politely…",
  // "Also…" name no one; a single word that opens the sentence counts only when it is none of those classes)
  const unknownIn = (t: string): string | null => unitNames({ id: "", kind: "page", text: t, host: null }, true).find((w) => {
    if (owners.some((x) => nameFoundIn(x, w) || nameFoundIn(w, x)) || SOURCE.test(w)) return false;
    const opens = bare(t).replace(/^["'“‘(]+/, "").toLowerCase().startsWith(w.toLowerCase());
    return !(opens && !/\s/.test(w) && FUNCTION_OPENER(w));
  }) ?? null;
  // (round 11, N4: an employer no unit names stands on no unit: a sentence carried from it never rests on a unit that names no one)
  // (round 12, B1: a name is known only as a posting's or a page's owner, never because some unit's text mentions it, a record line
  // "Intern at Stripe" or a page naming Stripe in passing; such a subject may rest only on a unit that names it as its employer)
  const unknownSubject = (w: string | null) => !!w && !owners.some((x) => x === w);
  const namesAsEmployer = (u: EvidenceUnit, w: string) => !u.owner && unitNames({ ...u, kind: "page", host: null }, true).some((n) => nameFoundIn(w, n) || nameFoundIn(n, w));
  // (a sentence code does not check, a question or a caveat, still names what the next one refers back to)
  // (`unknown`: an advice sentence's object, "Lead with Pixelforge", is not a subject; only a statement carries an unknown employer)
  const carryPast = (t: string, unknown = true) => { const m = mentioned(t); if (m.length) carried = m.length === 1 ? m[0] : null; else if (unknown) { const u = unknownIn(t); if (u) carried = u; } };
  // Round 9 of #849 (B2): code's record check speaks only for the "isn't on file" template alone, never for a clause joined to it,
  // and never for one that names an employer of this turn; every other clause is checked as usual.
  const recordOk = recordOnly(o.onRecord);
  const rec = (t: string) => { const v = recordOk(t); return v === true && mentioned(t).length ? null : v; };
  // Round 9 (B4), round 10 (D-088): advice and Trainee's own offers relax only what evidence a sentence needs, never whether it is
  // checked. Plain talk in the imperative with no figure, name or date ("Apply early", "Lead with…"), and Trainee's own offer or list
  // of what it needs with no figure or date and only names the turn already knows, need no unit that states them; the judge still
  // reads each one against the turn's evidence for its subject, and refuses any fact inside it the evidence does not state ("Remember
  // they don't sponsor visas", "I can confirm PayPal sponsors visas"). A judge "no", or no judge, drops it.
  const known = [allowed, ...postingOwners, ...ledger.units.filter((u) => u.kind === "absent").map((u) => u.text)].join("\n");
  // (advice only: an imperative, "Keep it short", "Mention the team"; a statement in the third person with no figure or name, "Its
  // analysts sit on the credit desk", is a claim about the world and is checked)
  const plain = (t: string) => {
    const b = t.trim(), w = /^[\p{L}']+/u.exec(b)?.[0] ?? "";
    return DIRECTIVE.test(w) && plainTalk(`${w.toLowerCase()}${b.slice(w.length)}`, allowed);
  };
  const free = (t: string) => plain(t) || ownAction(t, known);
  lines.forEach((l, a) => l.forEach((x, b) => {
    if (/^\s*(?:https?:\/\/\S+\s*)*$/.test(x)) return;
    const { ids, text } = tagsOf(x);
    lines[a][b] = text;
    if (!/\p{L}/u.test(text) || own.has(text) || noClaim(text) || personQuestion(text, allowed)) return carryPast(text);
    if (rec(text) === true) return carryPast(text);
    // The record's verdict comes before the plain-sentence rule: a sentence about the record that the record contradicts fails.
    if (rec(text) === false) { failures.push({ sentence: text, reason: "it is not what the person's record holds" }); bad.add(`${a}:${b}`); return; }
    if (free(text)) {
      const subj = mentioned(text)[0] ?? unknownIn(text) ?? carried;
      const pool0 = ids.length ? ids.map((id) => ledger.get(id)).filter((u): u is EvidenceUnit => !!u) : ledger.units;
      const pool = pool0.filter((u) => u.source !== "an earlier reply in this chat" && (subj ? mine(u, subj) || (!unknownSubject(subj) && !u.owner && (anyNamed.get(u.id) ?? []).length === 0) : mine(u, null)));
      if (ids.length) citeAt.set(`${a}:${b}`, ids);
      checks.push({ a, b, clause: text, units: pool, claim: text, subject: subj, advice: true, untagged: !ids.length });
      return carryPast(text, false);
    }
    // Review of #849: a sentence with no figure, no date and no name needs no tag (LEDGER_RULE says so); only one that names or
    // counts something must cite a unit.
    // Review of #849 (round 2): an untagged sentence on an evidence turn is checked against EVERY unit (layer A, then the judge), as the
    // support check always did; it is neither dropped unread nor let through unread.
    const cited = ids.length ? ids : ledger.units.map((u) => u.id);

    const units = cited.map((id) => ledger.get(id)).filter(Boolean) as EvidenceUnit[];
    if (units.length < cited.length) { failures.push({ sentence: text, reason: `it cites ${cited.filter((id) => !ledger.get(id)).join(", ")}, which no evidence unit is` }); bad.add(`${a}:${b}`); return; }
    if (!units.length) { failures.push({ sentence: text, reason: "it states a fact and no evidence unit holds it" }); bad.add(`${a}:${b}`); return; }
    citeAt.set(`${a}:${b}`, ids);
    for (const c of clausesOf(text)) {
      if (noClaim(c) || personQuestion(c, allowed) || rec(c) === true) continue;
      if (rec(c) === false) return fail(a, b, text, `"${c}" is not what the person's record holds`);
      // Round 3 of #849: every clause, not only one with a figure ("The posting is open", "It requires a clearance").
      const names = owners.length ? mentioned(c) : [];
      if (names.length >= 2) {
        // Round 8 (B4): a comparison. Each part runs from one employer's name to the next (the words before the first go with the
        // first); each part may stand only on its own employer's units, and the judge reads the whole clause against them all.
        const pos = names.map((w) => at(w, c));
        const parts = names.map((w, j) => ({ text: c.slice(j === 0 ? 0 : pos[j], j + 1 < names.length ? pos[j + 1] : c.length).trim(), subject: w, units: units.filter((u) => mine(u, w) && !(!u.owner && u.source === "an earlier reply in this chat")) }));
        const none = parts.find((p) => !p.units.length);
        if (none) return fail(a, b, text, `no cited unit is about ${none.subject}`, none.subject);
        checks.push({ a, b, clause: c, units: parts.flatMap((p) => p.units), claim: text, subject: null, parts, untagged: !ids.length });
        carried = null;
        continue;
      }
      const ownSubj = names[0] ?? unknownIn(c) ?? null;
      const subject = ownSubj ?? (owners.length || carried ? carried : null);
      carried = subject;
      // (a carried subject may not rest on a line from an earlier reply whose owner is unknown: it may be another employer's; a soft
      // subject may rest on a unit that names no employer, and the judge is shown the subject)
      // (round 12: an unknown subject rests only on a unit that names it as its employer; a carried subject never rests on a posting
      // record whose employer code cannot tell, which is some other employer's posting)
      const allowedUnits = units.filter((u) => !(subject && !ownSubj && !u.owner && u.source === "an earlier reply in this chat") &&
        (unknownSubject(subject) ? namesAsEmployer(u, subject!) :
          mine(u, subject) || (!!subject && !ownSubj && !u.owner && !u.posting && (anyNamed.get(u.id) ?? []).length === 0)));
      if (!allowedUnits.length) return fail(a, b, text, subject ? `no cited unit is about ${subject}` : "it names no employer, and every unit that could hold it is one employer's", subject);
      checks.push({ a, b, clause: c, units: allowedUnits, claim: text, subject, soft: !ownSubj, untagged: !ids.length });
    }
  }));
  // Layer A: each clause against an index of the units it cites, a record unit read as one record (a fact per line).
  const asks: { k: number; claim: string; source: string }[] = [];
  // (round 12: a posting's state unit is read as one sentence, "… is open and closes …", so the role it names stays with its deadline)
  const indexOf = (us: EvidenceUnit[]) => indexPages(us.map((u) => ({ text: u.posting ? u.text.replace(/; it closes /, " and closes ") : u.text, title: u.kind === "page" ? `Page${u.host ? ` (${u.host})` : ""}` : u.kind === "chat" ? "This chat's tool result" : "The person's confirmed record:", places: u.places ?? [], named: u.named ?? [], lend: u.kind === "chat" && u.owner && u.source !== "an earlier reply in this chat" ? u.owner : null, ...(u.kind === "record" || u.kind === "absent" ? { one: true } : {}) })));
  // Round 8 of #849: the judge always reads a clause with its subject, named or carried ("PayPal: It requires a clearance").
  const withSubject = (c: { clause: string; subject?: string | null }) => `${c.subject && !nameFoundIn(c.subject, c.clause) ? `${c.subject}: ` : ""}${c.clause}`;
  checks.forEach((c, k) => {
    if (bad.has(`${c.a}:${c.b}`)) return;
    if (c.advice) { asks.push({ k, claim: adviceClaim(c.clause, c.subject ?? null), source: (c.units.length ? c.units.map((u) => `- ${u.text}`).join("\n") : "(no evidence was read this turn)").slice(0, 2400) }); return; }
    if (c.parts) {
      // A comparison: each part's figures, names and dates in one unit of that part's own employer (layer A), the part's employer
      // name aside; a part that states nothing but the name is the comparison's frame. Then the judge reads the whole clause
      // against the units that held its parts.
      // Round 9 of #849 (B1): when any employer's part carries no figure or date of its own ("Both PayPal and Citadel pay $80",
      // "PayPal, like Citadel, pays $80", "Citadel pays $80, the same as PayPal", "… and so does PayPal", "PayPal matches Citadel at
      // $80"), the clause's figures and dates are shared: EVERY employer it names must hold all of them in its own unit, whatever
      // the order or the comparing words. Only a clause whose every employer has a figure of its own is read part by part.
      const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const without = (t: string, ws: string[]) => ws.reduce((x, w) => x.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc(w)}(?:['’]s)?(?![\\p{L}\\p{N}])`, "giu"), " "), t).replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
      const figOf = (t: string) => { const hr = hardParts(t); return /\d/.test(t) || hr.numbers.length > 0 || hr.years.length > 0 || hr.quant.length > 0 || UNREAD.test(t); };
      const subjects = c.parts.map((p) => p.subject);
      const shared = c.parts.some((p) => !figOf(without(p.text, [p.subject]))) && figOf(c.clause);
      if (shared && UNREAD.test(c.clause) && !/\d/.test(c.clause) && !hardParts(c.clause).numbers.length) { failures.push({ sentence: c.claim, reason: `"${UNREAD.exec(c.clause)![0]}" is a figure code cannot check` }); bad.add(`${c.a}:${c.b}`); return; }
      const held: EvidenceUnit[] = [], passages: string[] = [];
      for (const p of c.parts) {
        // (shared: the whole clause, the other employers' names aside, against this employer's units; the first word is read as the
        // plain word it is when it opens the comparison, "Both …", "Each …")
        const own = shared ? without(c.clause, subjects.filter((w) => w !== p.subject)).replace(/^(\p{Lu}[\p{L}']*)/u, (w) => OPENER.test(w) ? w.toLowerCase() : w) : p.text;
        const rest = own.replace(new RegExp(esc(p.subject), "i"), " ");
        const hr = hardParts(rest), fig = /\d/.test(rest) || hr.numbers.length > 0 || hr.years.length > 0 || hr.quant.length > 0 || UNREAD.test(rest);
        if (!shared && !fig && !missingSpecifics(rest, []).length) continue;
        if (UNREAD.test(rest) && !hr.numbers.length && !/\d/.test(rest)) { failures.push({ sentence: c.claim, reason: `"${UNREAD.exec(rest)![0]}" is a figure code cannot check`, subject: p.subject }); bad.add(`${c.a}:${c.b}`); return; }
        if (shared && !fig) continue;
        const f = findSupport(own, indexOf(p.units));
        const u = f ? p.units[f.page] : undefined;
        if (!f || !u || (u.owner ? u.owner !== p.subject : !nameFoundIn(p.subject, f.unit.passage))) { failures.push({ sentence: c.claim, reason: shared ? `"${c.clause}" gives ${p.subject} its figures too, and no cited unit about ${p.subject} holds them` : `no cited unit about ${p.subject} holds "${p.text}"`, subject: p.subject }); bad.add(`${c.a}:${c.b}`); return; }
        held.push(u); passages.push(`${p.subject}: ${f.unit.passage}`);
      }
      if (!held.length) { failures.push({ sentence: c.claim, reason: `no cited unit holds "${c.clause}"` }); bad.add(`${c.a}:${c.b}`); return; }
      if (c.untagged) citeAt.set(`${c.a}:${c.b}`, [...new Set([...(citeAt.get(`${c.a}:${c.b}`) ?? []), ...held.map((u) => u.id)])]);
      asks.push({ k, claim: c.clause, source: passages.join("\n").slice(0, 2400) });
      return;
    }
    const f = findSupport(c.clause, indexOf(c.units));
    // Round 3 of #849: a clause with no figure that code cannot place (a paraphrase, as Instinct writes) goes to the judge, shown the
    // cited units of its subject only; a figure is never left to the judge alone.
    // Round 4: a figure is any number code reads, words included ("five", "six-figure", "fifty dollars"), not only a digit.
    const hp = hardParts(c.clause);
    // Round 5: a singular magnitude ("a hundred dollars", "a million") and an ordinal ("a second round") are figures too.
    const figure = /\d/.test(c.clause) || hp.numbers.length > 0 || hp.years.length > 0 || hp.quant.length > 0 ||
      UNREAD.test(c.clause);
    // (a figure code cannot read as a number is refused: no unit check can hold it, and the judge never decides a figure alone)
    if (UNREAD.test(c.clause) && !hp.numbers.length && !/\d/.test(c.clause)) { failures.push({ sentence: c.claim, reason: `"${UNREAD.exec(c.clause)![0]}" is a figure code cannot check`, subject: c.subject ?? null }); bad.add(`${c.a}:${c.b}`); return; }
    if (!f && !figure && o.judge) {
      const pool = c.units; // already only the subject's own units and unowned ones
      // (only when every name of the clause, the opening one too, is in those units: code failed on wording alone, never on a fact)
      // (CodeRabbit on #849: no clause spans two units: each unit that alone holds every name of it is asked on its own, at most
      // three, and one yes is enough)
      const one = pool.filter((u) => !missingSpecifics(c.clause, [u], true).length).slice(0, 3);
      if (one.length) { for (const u of one) asks.push({ k, claim: withSubject(c), source: u.text.slice(0, 2400) }); return; }
    }
    if (!f) { const miss = missingSpecifics(c.clause, c.units); failures.push({ sentence: c.claim, reason: c.untagged ? "it states a fact and cites no evidence unit, and no unit holds it" : miss.length ? miss.map((m) => `'${m}' is in no cited unit`).join("; ") : `no single cited unit holds "${c.clause}"`, subject: c.subject ?? null }); bad.add(`${c.a}:${c.b}`); return; }
    const held = c.units[f.page]; // indexPages makes one page per cited unit, in order
    const stale = (held?.dated ?? []).filter((y) => !c.clause.includes(y) && !c.clause.includes(`'${y.slice(2)}`) && !c.clause.includes(`’${y.slice(2)}`));
    if (stale.length) { failures.push({ sentence: c.claim, reason: `the unit that holds "${c.clause}" is for a period that has ended (${stale.join(", ")}); the sentence must say so`, subject: c.subject ?? null }); bad.add(`${c.a}:${c.b}`); return; }
    const unitOwner = held?.owner ?? null;
    if (c.subject && (unitOwner ? unitOwner !== c.subject : !c.soft && !nameFoundIn(c.subject, f.unit.passage))) { failures.push({ sentence: c.claim, reason: `the unit that holds "${c.clause}" is not about ${c.subject}`, subject: c.subject }); bad.add(`${c.a}:${c.b}`); return; }
    // (an untagged sentence a unit supports keeps that unit's source link, as a tagged one does)
    if (c.untagged && held) citeAt.set(`${c.a}:${c.b}`, [...new Set([...(citeAt.get(`${c.a}:${c.b}`) ?? []), held.id])]);
    asks.push({ k, claim: withSubject(c), source: f.unit.passage });
  });
  const got = await judgeAll(o.judge, asks.map((x) => ({ claim: x.claim, source: x.source })));
  const yesAt = new Set(asks.flatMap((x, j) => got[j] ? [x.k] : []));
  asks.forEach((x, j) => { const c = checks[x.k]; if (!yesAt.has(x.k) && asks.findIndex((y) => y.k === x.k) === j && !bad.has(`${c.a}:${c.b}`)) { failures.push({ sentence: c.claim, reason: c.untagged ? "it states a fact and cites no evidence unit, and no unit states it" : `the cited unit does not state "${x.claim}"`, subject: c.subject ?? null }); bad.add(`${c.a}:${c.b}`); } });
  const text = lines.map((l, a) => l.filter((x, b) => x && !bad.has(`${a}:${b}`)).join(" ")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const cites: string[] = [], citeOf: [string, string[]][] = [];
  lines.forEach((l, a) => l.forEach((x, b) => { if (x && !bad.has(`${a}:${b}`)) { kept.push(x); citeOf.push([x, citeAt.get(`${a}:${b}`) ?? []]); for (const id of citeAt.get(`${a}:${b}`) ?? []) if (!cites.includes(id)) cites.push(id); } }));
  const tagged = raw.map((l, a) => l.filter((x, b) => lines[a][b] && !bad.has(`${a}:${b}`)).join(" ")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, failures, kept, cites, tagged, subject: carried, citeOf };
}

// ------------------------------------------------------------------------------------------------ task contract
// What each intent's reply must contain, in one place, per intent (never per turn). `says` goes to the drafting model up front; `missing`
// is code's check, whose findings go to the repair pass.
export interface Contract { id: string; says: string; missing: (reply: string, ask: string) => string | null }
export const CONTRACTS: Record<string, Contract> = {
  referral: { id: "referral", says: "A referral message asks for the referral itself, plainly.", missing: (r) => /\brefer(?:ral|red|ring)?\b/i.test(r) ? null : "the message never asks for a referral" },
  answer_first: { id: "answer_first", says: "The answer comes first, in the first sentence; the detail after it.", missing: (r) => /^\s*(?:great question|good question|sure|absolutely|of course|happy to help|here(?:'s| is) (?:what|how)|let me|i'll|thanks for)/i.test(r) ? "the first sentence is a preamble, not the answer" : null },
  requirements: { id: "requirements", says: "A question about what is needed lists each thing needed.", missing: (r) => (r.match(/(?:^|\n)\s*(?:\d+[.)]|[-•])\s+/g) ?? []).length >= 2 || (r.match(/,|;/g) ?? []).length >= 2 ? null : "the reply does not list what is needed" },
  draft: { id: "draft", says: "A draft the person sends themselves says, after it, that it was not sent.", missing: (r) => /\bnot sent\b|\bnothing (?:was )?sent\b/i.test(r) ? null : "the draft is not marked as not sent" },
};
// Review rv4 (architect ruling, 2026-11-17: one contract system): the product never picks a contract from the person's message.
// The brain's contracts are attached to the tool whose result the reply reports (task_contracts.ts withContracts) and the
// pipeline's checks come from them (pipelineContracts). This reader is called by nothing in the product; it stays only because
// an existing architect assertion (tests/architect/pending/reply-pipeline-20261114.test.ts) pins it, for the architect to retire.
export function contractsFor(intent: string | null, message: string): Contract[] {
  const m = String(message ?? "").toLowerCase(), out: Contract[] = [CONTRACTS.answer_first];
  if (/\breferr?al\b|\brefer me\b/.test(m)) out.push(CONTRACTS.referral);
  if (/\bdraft|write (?:a|me a|up a) (?:message|note|email|dm)\b/.test(m) || /draft/.test(String(intent ?? ""))) out.push(CONTRACTS.draft);
  if (/\bwhat (?:do i|would i|will i) need\b|\bwhat(?:'s| is) (?:needed|required)\b|\brequirements?\b|\bwhat do you need\b/.test(m)) out.push(CONTRACTS.requirements);
  return out;
}

// ------------------------------------------------------------------------------------------------ repair + fallback
export type RepairModel = (o: { system: string; user: string }) => Promise<string>;
export const REPAIR_SYSTEM = "You fix a text message from a career assistant. You get only the sentences that failed code's checks, each with code's reason, " +
  "and the evidence units they may cite. Return the fixed sentences only, one per line, each tagged with the ids it rests on ([E3]); leave out a sentence you cannot " +
  "support from these units. If a length limit is given, the whole reply must fit it. If something the reply must contain is missing, add one sentence for it. No other text.";
// `calls`: repair calls (at most one). `judgeCalls`/`judgeClaims`: every support-judge call this reply made and the claims they
// carried; `judgeCapped`: a claim went unasked because the cap was reached, and so failed closed (round 9 of #849, B5).
export interface PipelineOut { text: string; repaired: boolean; dropped: Failure[]; calls: number; fallback: boolean; judgeCalls: number; judgeClaims: number; judgeCapped: boolean }
// Round 9 of #849 (B5): a hard cap on the judge per reply. Each verification pass puts all its new claims in ONE call (verifyTagged);
// across the passes of a reply (the draft settled, the repair settled, a length rewrite) at most this many calls and claims are made
// (trunk's decide: 2 calls of 8 claims for one reply). Past the cap a claim is not asked and counts as "no": it fails closed.
export const REPLY_JUDGE_MAX_CALLS = 4, REPLY_JUDGE_MAX_CLAIMS = 32;
export async function runReplyPipeline(draft: string, ledger: Ledger, o: { judge?: SupportJudge | null; repair?: RepairModel | null; own?: string[]; onRecord?: (s: string) => boolean | null;
  ask: string; contracts?: Contract[]; maxChars?: number; answers?: (text: string) => boolean; names?: string[] }): Promise<PipelineOut> {
  // Round 8 of #849: what is sent is verified as it is sent. A dropped sentence changes what the next one refers back to, so the
  // check runs again on what stood until nothing more fails (each pass only removes sentences, so it ends); the repaired sentences
  // are verified in the place they will be sent, after what stood, with its subject carried into them. The judge is asked each
  // (claim, passage) pair once per reply.
  const memo = new Map<string, "yes" | "no">();
  let judgeCalls = 0, judgeClaims = 0, judgeCapped = false, retried = false;
  const judge: SupportJudge | null = o.judge ? async (cs) => {
    const key = (c: { claim: string; source: string }) => `${c.claim}\u0000${c.source}`;
    const need = cs.filter((c, j) => !memo.has(key(c)) && cs.findIndex((d) => key(d) === key(c)) === j);
    if (need.length) {
      const room = judgeCalls < REPLY_JUDGE_MAX_CALLS ? Math.max(0, REPLY_JUDGE_MAX_CLAIMS - judgeClaims) : 0;
      const asked = need.slice(0, room), over = need.slice(asked.length);
      if (over.length) { judgeCapped = true; for (const c of over) memo.set(key(c), "no"); }
      if (asked.length) {
        judgeCalls++; judgeClaims += asked.length;
        let got = await Promise.resolve().then(() => o.judge!(asked)).catch(() => null);
        // (round 11, N1: an answer of the wrong length, or none, is asked once more per reply while the cap holds, as support.ts decide
        // does; a second bad answer fails closed)
        if ((!Array.isArray(got) || got.length !== asked.length) && !retried && judgeCalls < REPLY_JUDGE_MAX_CALLS && judgeClaims + asked.length <= REPLY_JUDGE_MAX_CLAIMS) {
          retried = true; judgeCalls++; judgeClaims += asked.length;
          got = await Promise.resolve().then(() => o.judge!(asked)).catch(() => null);
        }
        if (!Array.isArray(got) || got.length !== asked.length) return asked.length === cs.length ? (got ?? []) as ("yes" | "no")[] : cs.map((c) => memo.get(key(c)) ?? "no");
        asked.forEach((c, j) => memo.set(key(c), got[j]));
      }
    }
    return cs.map((c) => memo.get(key(c)) ?? "no");
  } : null;
  const vo = { ...o, judge };
  const settle = async (t: string, carry: string | null = null): Promise<Verified> => {
    let v = await verifyTagged(t, ledger, { ...vo, carry });
    const all = [...v.failures];
    for (let n = 0; v.failures.length && n < 50; n++) {
      const w = await verifyTagged(v.tagged, ledger, { ...vo, carry });
      all.push(...w.failures); v = w;
    }
    return { ...v, failures: all };
  };
  const v1 = await settle(draft);
  const answersOf = o.answers ?? ((t: string) => splitSentences(t).some((s) => /\p{L}/u.test(s.replace(/https?:\/\/\S+/g, "")) && !noClaim(s) && !/\?\s*$/.test(s)));
  const len = (t: string) => t.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().length;
  const contractMiss = (t: string) => (o.contracts ?? []).map((c) => c.missing(t, o.ask)).filter(Boolean) as string[];
  const tooLong = o.maxChars && len(v1.text) > o.maxChars ? `the reply is ${len(v1.text)} characters; the limit is ${o.maxChars}` : null;
  const miss = contractMiss(v1.text);
  let text = v1.text, calls = 0, repaired = false, dropped = v1.failures, cites = [...v1.cites], citeOf = v1.citeOf;
  if ((v1.failures.length || tooLong || miss.length) && o.repair) {
    const user = [v1.failures.length ? `FAILED SENTENCES:\n${v1.failures.map((f) => `- ${f.sentence} (code: ${f.reason}${f.subject && !f.reason.includes(f.subject) ? `; the sentence is about ${f.subject}` : ""})`).join("\n")}` : "",
      tooLong ? `LENGTH: ${tooLong}. The sentences that stood:\n${v1.text}` : "", miss.length ? `MISSING: ${miss.join("; ")}.` : "",
      `EVIDENCE:\n${ledger.block()}`].filter(Boolean).join("\n\n");
    calls = 1;
    const out = await o.repair({ system: REPAIR_SYSTEM, user }).catch(() => "");
    if (out.trim()) {
      // The repaired sentences join what stood (a repaired opening sentence opens the reply again: the answer comes first).
      const firstFailed = v1.failures.length && tagsOf(splitSentences(String(draft).split("\n")[0] ?? "")[0] ?? "").text === v1.failures[0].sentence;
      // Review of #849: the repair returns only the fixed sentences, so it never replaces what stood (a one-sentence repair wiped the
      // verified answer). A length overrun is handled below by dropping whole sentences from the end.
      const fresh = [...new Set(String(out).split("\n").flatMap((l) => splitSentences(l)).map((x) => x.trim()).filter((x) => x && !text.includes(tagsOf(x).text)))].join(" ");
      if (fresh) {
        // Verified where it will be sent: in front of what stood (from no subject), or after it (from the subject it ends on); then
        // the whole is settled again, since what follows the new sentences now refers back to them.
        const v2 = await settle(firstFailed ? `${fresh}\n${v1.tagged}` : `${v1.tagged}\n${fresh}`);
        const joined = v2.text.replace(/\n+/g, " ").trim();
        if (!o.maxChars || len(joined) <= o.maxChars || len(joined) <= len(text)) { text = joined; repaired = true; cites = [...v2.cites]; citeOf = v2.citeOf; dropped = v2.failures; }
        else if (tooLong) {
          // (CodeRabbit on #849: a length repair is a rewrite of what stood: verified on its own, it replaces the overlong text when it
          // fits the limit and still answers; otherwise what stood is cut below as before)
          const v3 = await settle(fresh);
          const t3 = v3.text.replace(/\n+/g, " ").trim();
          if (t3 && len(t3) <= o.maxChars && len(t3) < len(text) && answersOf(t3)) { text = t3; repaired = true; cites = [...v3.cites]; citeOf = v3.citeOf; dropped = [...v1.failures, ...v3.failures]; }
          else dropped = v2.failures;
        } else dropped = v2.failures;
      } else dropped = v1.failures; // (round 9: nothing new came back; what the first pass dropped stays dropped, and in the trace)
    }
  }
  if (o.maxChars && len(text) > o.maxChars) {
    // Still over: whole sentences from the end go (never a cut mid-sentence; never the first, which answers).
    const ss = splitSentences(text.replace(/\n+/g, " "));
    while (ss.length > 1 && len(ss.join(" ")) > o.maxChars) ss.pop();
    text = ss.join(" ");
    // (round 9 of #849: a sentence cut here takes its source links with it; a kept one keeps its own)
    const left = new Set(ss.map((x) => x.trim()));
    cites = cites.filter((id) => citeOf.some(([x, ids]) => left.has(x.trim()) && ids.includes(id)));
  }
  // (a page's own source numbers, "[1]", mean nothing on this path: the units carry their links)
  text = text.replace(/\s*\[\d+\](?:\s*\[\d+\])*/g, "").split("\n").filter((l) => !/^\s*[.,;:]?\s*$/.test(l) || !l.trim()).join("\n").trim();
  let fallback = false;
  if (!answersOf(text)) { text = [text, fallbackLine(ledger, o.ask, o.names, subjectOf(ledger, o.ask, draft))].filter(Boolean).join("\n\n"); fallback = true; }
  // Live-12 review (item 3; D-024, D-060): the tags go, the sources stay: each kept sentence's cited unit's link, on its own line, once.
  const links = [...new Set(cites.map((id) => ledger.get(id)?.url).filter((u): u is string => !!u))].filter((u) => !text.includes(u));
  if (links.length && !fallback) text = `${text}\n${links.join("\n")}`;
  return { text: stripTags(text).trim(), repaired, dropped, calls, fallback, judgeCalls, judgeClaims, judgeCapped };
}
// The employers a tool named this turn (posting owners; never a line carried from an earlier reply).
const postingOwnersOf = (l: Ledger) => [...new Set(l.units.filter((u) => u.source !== "an earlier reply in this chat").map((u) => u.owner).filter((w): w is string => !!w && w.trim().length > 1))];
// Round 8 of #849 (B5): whom the ask is about: the employer it names, else the one the draft names first (the subject it carried),
// else the turn's one employer; with several and none named, no one.
export function subjectOf(l: Ledger, ask: string, draft = ""): string | null {
  const ws = postingOwnersOf(l);
  const first = (t: string) => ws.filter((w) => nameFoundIn(w, t)).sort((x, y) => t.toLowerCase().indexOf(x.toLowerCase()) - t.toLowerCase().indexOf(y.toLowerCase()))[0] ?? null;
  return first(String(ask ?? "")) ?? first(stripTags(String(draft ?? ""))) ?? (ws.length === 1 ? ws[0] : null);
}
// What could not be verified, and what the ledger does hold for what was asked, with its link. Live-12 review (item 8, D73-6): the ask's
// names (an employer, a place: the words of the ask that are names in this conversation, `names`, or in the ledger) must ALL be in the
// unit: a Citadel ask never gets another employer's pay, and an ask that names no one gets nothing listed.
// Round 8 of #849 (B5): only the subject's own posting facts are listed (a unit its tool result gave that employer); a line whose
// employer code cannot tell is never listed while the turn has an employer, and with several employers and none asked about, nothing.
export function fallbackLine(ledger: Ledger, ask: string, names: string[] = [], subject: string | null = subjectOf(ledger, ask)): string {
  const known = new Set([...names, ...ledger.units.flatMap((u) => u.text.match(/(?<![\p{L}])\p{Lu}[\p{L}&'-]{2,}/gu) ?? [])].map((w) => w.toLowerCase().replace(/'s$/, "")));
  const asked = [...new Set((String(ask ?? "").toLowerCase().match(/\p{L}[\p{L}&'-]{1,}/gu) ?? []).map((w) => w.replace(/'s$/, "")))].filter((w) => known.has(w) && !/^(?:i|the|and|pay|what|how|for|with|is|are|my|your)$/.test(w));
  const ws = postingOwnersOf(ledger);
  const whose = (u: EvidenceUnit) => subject ? u.owner === subject && u.source !== "an earlier reply in this chat" : !ws.length && !u.owner && u.source !== "an earlier reply in this chat";
  // (round 9 of #849: on a turn with one employer, an ask that names none but refers back to it, "what's the pay?", "when does it
  // close?", asks about that employer's posting; a general ask, "what do interns earn", still gets nothing listed)
  const refers = !asked.length && ws.length === 1 && !!subject && /(?<![\p{L}])(?:the|this|that|it|its|it's|they|their|there)(?![\p{L}])/iu.test(String(ask ?? ""));
  const held = ledger.units.filter((u) => u.kind === "chat" && /\d/.test(u.text) && whose(u) && (asked.length ? asked.every((w) => nameFoundIn(w, u.text)) : refers));
  return [`I couldn't verify an answer to that from what I read.${held.length ? " This chat's tool results do hold:" : ""}`, ...held.slice(0, 3).map((u) => `${u.text}${u.url ? `\n${u.url}` : ""}`)].join("\n");
}
