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
// ("suggestion": code's general career knowledge a tool result gave, such as the roles people commonly start in for a field an empty
// search names (S3 r12, entry_routes.ts); it may hold advice about roles, never a posting, an opening or an employer)
// ("said": a sentence of the person's own messages in this chat, S3 r12c. Never in the drafting ledger, which holds only what they
// confirmed (D-007): verifyTagged reads them so their own words may be said back as theirs; they back no employer or posting claim)
export type EvidenceKind = "page" | "chat" | "record" | "absent" | "suggestion" | "said";
// (`empty`: the count line of a search that returned nothing, S3 r12c)
export interface EvidenceUnit { id: string; kind: EvidenceKind; text: string; host?: string | null; url?: string | null; source?: string; places?: string[]; owner?: string | null; named?: string[]; posting?: boolean; dated?: string[]; empty?: boolean; uses?: boolean }

// Units a tool added this turn (pages, posting records, counts): the turn rests on evidence only when it has one. Lines carried from
// earlier replies, the person's record and what it lacks do not make a turn an evidence turn.
export const evidenceTurn = (l: Ledger | null) => !!l && l.units.some((u) => (u.kind === "page" || u.kind === "chat") && u.source !== "an earlier reply in this chat");
export class Ledger {
  units: EvidenceUnit[] = [];
  // The turn's clock (PROCESS rule 6): a year in a posting's title names the role only when it is this year or later.
  constructor(readonly now: number = Date.now()) {}
  add(kind: EvidenceKind, text: string, meta: { host?: string | null; url?: string | null; source?: string; places?: string[]; owner?: string | null; named?: string[]; posting?: boolean; dated?: string[]; empty?: boolean; uses?: boolean } = {}): string {
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
    // (S3 r12, architect ruling: an empty search states what it searched, so "0 nurse postings near Columbus" rests on it, and its
    // suggestions are units of their own kind)
    const searched = Array.isArray(o.postings) && !o.postings.length && typeof o.searched === "string" && o.searched.trim() ? ` for "${o.searched.trim().slice(0, 120)}"` : "";
    if (Array.isArray(o.postings)) ids.push(this.add("chat", `The search (${name})${searched} returned ${o.postings.length} posting${o.postings.length === 1 ? "" : "s"}.`, { source: name, ...(o.postings.length ? {} : { empty: true }) }));
    for (const sg of Array.isArray(o.suggestions) ? o.suggestions : []) {
      const roles = (Array.isArray(sg?.roles) ? sg.roles : []).filter((r: unknown): r is string => typeof r === "string" && !!r.trim());
      if (typeof sg?.field === "string" && roles.length)
        ids.push(this.add("suggestion", `General career knowledge, not postings: people moving into ${sg.field} commonly start as ${roles.length > 1 ? `${roles.slice(0, -1).join(", ")}, or ${roles.at(-1)}` : roles[0]}.`, { source: name, owner: null }));
      // (D-100: what work in the field commonly involves, a unit of its own, so the D-100 pair reads one passage for the role's half)
      if (typeof sg?.field === "string" && typeof sg?.uses === "string" && sg.uses.trim() && !/\d/.test(sg.uses))
        ids.push(this.add("suggestion", `General career knowledge, not postings: work in ${sg.field} commonly involves ${sg.uses.trim().replace(/[.\s]+$/, "")}.`, { source: name, owner: null, uses: true }));
    }
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
  // A copy with the person's own messages in this chat added, a statement per unit, after every unit the draft could cite (S3 r12c,
  // dev H022): for the check only; the drafting prompt's block is built from the ledger itself, never from this copy. Only what they
  // said about themselves (ownStatements): never pasted or quoted material, another person's facts, or what they deny.
  withSaid(messages: string[]): Ledger {
    const l = new Ledger(this.now);
    l.units = [...this.units];
    for (const x of ownStatements(messages)) l.add("said", x, { source: "said", owner: null });
    return l;
  }
  block(ids?: string[]): string {
    const us = ids ? this.units.filter((u) => ids.includes(u.id)) : this.units;
    return us.map((u) => `[${u.id}] (${u.kind === "page" ? `page${u.host ? ` ${u.host}` : ""}${u.source ? `, ${u.source}` : ""}` : u.kind === "chat" ? "this chat's tool result" : u.kind === "absent" ? "the person's record lacks" : u.kind === "suggestion" ? "code's general career knowledge, not a posting" : u.kind === "said" ? "what the person said in this chat, not confirmed yet" : "the person's confirmed record"}) ${u.text}`).join("\n");
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
// Review of PR #871 (B1): the person's own words are evidence only for what they said about themselves. A message that carries
// someone else's text or facts is read as none of theirs: a long message (a paste), a quoted block, a job post or a posting, what a
// resume, CV or profile "says", or another person's facts ("my friend's resume", "my brother has"). Of the rest, a sentence counts only
// in the first person and not as a question, and a clause that denies something ("I don't know SQL") is no fact of theirs to say back.
export const SAID_MAX = 400;
const PASTED = /```|^\s*>|["“][^"”\n]{40,}["”]|\bjob\s+(?:post(?:ing)?|description|ad|listing|spec)s?\b|\b(?:the|this|that)\s+(?:posting|listing|description|jd)\s+(?:says|said|reads|lists|states|asks|wants|requires)\b|\brequirements?\s*:|\b(?:resume|r[eé]sum[eé]|cv|profile|bio|linkedin|post|ad)\s+(?:says|said|reads|lists|states|shows|has)\b|\b(?:pasted?|copied|copy-paste)\b|\bhere(?:'s|’s| is)\s+(?:the|a|an|his|her|their)\s+(?:job|posting|post|resume|r[eé]sum[eé]|cv|description|listing|role|ad|profile)\b|\b(?:my|his|her|their|our)\s+(?:\w+\s+)?(?:friend|brother|sister|colleague|coworker|co-worker|classmate|roommate|partner|husband|wife|boyfriend|girlfriend|son|daughter|mom|mum|dad|mother|father|cousin|boss|manager|mentor|teammate)s?(?:['’]s)?\b|\b(?:a|some)\s+friend\b/im;
const FIRST_PERSON = /(?<![\p{L}'’])(?:i|i'm|i’m|i've|i’ve|i'd|i’d|im|ive|my|me|mine|myself)(?![\p{L}'’])/iu;
const DENIES = /(?<![\p{L}])(?:not|no|never|none|nor|neither|don['’]?t|doesn['’]?t|didn['’]?t|haven['’]?t|hasn['’]?t|hadn['’]?t|can['’]?t|cannot|couldn['’]?t|won['’]?t|wouldn['’]?t|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t|lack|lacking|without|yet\s+to)(?![\p{L}])/iu;
const OWN_CLAUSE_SPLIT = /\s*;\s*|,?\s+(?:but|though|although|however|except)\s+|,?\s+(?:and|so)\s+(?=(?:i|i'm|i’m|i've|i’ve|i'd|im|ive|my)(?![\p{L}]))/iu;
export function ownStatements(messages: string[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const t = String(m ?? "");
    if (!t.trim() || t.replace(/\s+/g, " ").trim().length > SAID_MAX || PASTED.test(t)) continue;
    for (const x of t.split("\n").flatMap((y) => splitSentences(y))) {
      // (a question states nothing about them)
      if (!FIRST_PERSON.test(x) || /\?\s*["'”’)]*\s*$/.test(x)) continue;
      for (const c of x.split(OWN_CLAUSE_SPLIT).map((y) => y.trim())) if (c.length > 8 && !DENIES.test(c) && !out.includes(c)) out.push(c);
    }
  }
  return out;
}
// Review of PR #871 (B2): the sentence uses a word as an employer's name: "Apple has", "Apple's team", "Apple and Google hire",
// "Goldman would", "at Apple", "for Apple", "joining Apple".
const FRAME_AFTER = "(?:has|have|had|pays?|paid|hires?|hiring|is\\s+hiring|offers?|recruits?|sponsors?|employs?|wants?|needs?|requires?|expects?|posted|posts|lists?|would|could|will|can|is|was|runs?|values?|looks?\\s+for|teams?|analysts?|engineers?|employees?|staff|interns?|internships?|offices?|roles?|jobs?|positions?|openings?|careers?|recruiters?|alums?|alumni|people|folks|hiring)";
export function employerFrame(w: string, t: string): boolean {
  const e = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}])${e}(?:['’]s(?![\\p{L}])|(?:\\s*(?:,|&|and|or)\\s*\\p{Lu}[\\p{L}&.'-]*)*\\s+(?:(?:typically|reportedly|also|really|currently|now|still|usually|often|actually|definitely)\\s+)?${FRAME_AFTER}(?![\\p{L}]))`, "u").test(t) ||
    new RegExp(`(?<![\\p{L}])(?:at|for|joining|join|by|from)\\s+(?:\\p{Lu}[\\p{L}&.'-]*\\s*(?:,|&|and|or)\\s*)*${e}(?![\\p{L}])`, "iu").test(t);
}
// A number of the claim is the said unit's only as a whole token: "12 years" is not in "I graduated in 2012".
const wholeNumbersIn = (claim: string, unit: string) => (String(claim).match(/\d+(?:[.,]\d+)?/g) ?? []).every((n) => new RegExp(`(?<![\\d.,])${n.replace(/[.]/g, "\\.")}(?![\\d]|[.,]\\d)`).test(unit));

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
  /^(?:never|always|just|maybe|perhaps|then|first|second|third|next|also|even|only|still|ever|soon|now|later|again|quick|tip|heads|honestly|anyway|besides|otherwise|instead|therefore|thus|hence|so|yet|once|here|there|now)$/i.test(x) ||
  // (round 12 follow-up, S3 r12: an indefinite pronoun names no one. "Nothing has been sent or applied to." read "Nothing" as an
  // unknown employer, carried it, and dropped every later sentence of the reply as "no cited unit is about Nothing")
  INDEFINITE.test(x); };
const INDEFINITE = /^(?:nothing|nobody|none|noone|no-one|neither|either|everything|everyone|everybody|something|someone|somebody|anything|anyone|anybody|nowhere|everywhere|somewhere|anywhere)$/i;
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
// (S3 r12: a clause that says something is open, posted or hiring is a posting claim; a suggestion unit never holds one)
const POSTING_CLAIM = /\b(?:openings?|postings?|posted|vacanc(?:y|ies)|hiring|hires|listings?|listed|job ads?|positions? (?:open|available)|(?:is|are) open|apply (?:to|for|at)|apply you|now accepting|(?:send|submit) (?:your|my|the) (?:resume|application)s? to|available (?:near|in|around|now|right now)|(?:jobs?|roles?|positions?|work)\s+(?:\w+\s+){0,4}?(?:near|around|close to)\s+(?:you|your|me|here)|(?:near|around) (?:you|your|me)\b[^.?!]{0,40}\b(?:jobs?|roles?)|in your (?:city|area|town))\b/i;
// (a posting denied, "not postings", "no openings", claims none)
const NO_POSTING = /\b(?:not|no|never|nor|zero|0)\s+(?:an?\s+|any\s+)?(?:[\p{L}-]+\s+){0,2}?(?:openings?|postings?|listings?|vacanc(?:y|ies))\b/giu;
const forClaim = (us: EvidenceUnit[], text: string) => POSTING_CLAIM.test(String(text).replace(NO_POSTING, " ")) ? us.filter((u) => u.kind !== "suggestion" && u.kind !== "said") : us;
const TAG_AFTER_STOP = /([.!?])(["'\u201d)\]]*)[ \t]*(\[E\d+(?:\s*,\s*E\d+)*\])/g;
// "those four", "these 3", "the two": a count referring back to items
const COUNT_REF = /\b(those|these|the)\s+(two|three|four|five|six|seven|eight|nine|ten|[2-9]|10)\b/i;
// An explicit back-reference to a list in this reply (review of cbea914e9: never a bare "all N" or "one of the N", which state true
// counts, "I sent all 5 applications"): "those four", "these 3", "the four roles above", "the 3 I listed", "the two below".
const N_WORD = "two|three|four|five|six|seven|eight|nine|ten|[2-9]|10";
const BACK_REF = new RegExp(`\\b(?:those|these)\\s+(${N_WORD})\\b|\\bthe\\s+(${N_WORD})(?:\\s+[\\p{L}-]+){0,2}?\\s+(?:above|listed|below|I (?:named|listed))\\b`, "giu");
const COUNT_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const countOf = (w: string) => COUNT_WORDS[w.toLowerCase()] ?? Number(w);
// How many items the reply lists: its numbered or bulleted lines, or the longest series in one of its sentences ("A, B, C, or D"),
// whichever is more.
export function listCount(reply: string): number {
  const marked = String(reply).split("\n").filter((l) => /^\s*(?:\d{1,2}[.)]|[-\u2022*])\s+\S/.test(l)).length;
  const series = Math.max(0, ...String(reply).split("\n").flatMap((l) => splitSentences(l)).map((x) => {
    const body = x.includes(":") ? x.slice(x.indexOf(":") + 1) : x;
    const parts = body.replace(/[.!?]+$/, "").split(/,\s+(?:(?:and|or)\s+)?/).filter((p) => /\p{L}/u.test(p));
    return parts.length >= 3 ? parts.length : 0;
  }));
  return Math.max(marked, series);
}
const LIST_MARK = /^\s*(?:\(?\d{1,2}[.)]|[-•*]|[a-z][.)])\s*$/i;
// (S3 r12, architect ruling, narrowed after the review of cbea914e9) A sentence that refers back to a list in this reply ("which of
// those four", "the four roles above") dangles only when the list it refers to was DROPPED: the sentences dropped this turn held a
// list, and what is kept no longer shows that many items. Shown items: numbered or bulleted lines, a series in one sentence, a pair
// ("A and B", "A or B") for a count of two, and a File link (the items are in the File). A reply is never emptied by this.
export function danglingRef(sentence: string, kept: string, dropped: string): string | null {
  const refs = [...String(sentence).matchAll(BACK_REF)].map((m) => ({ said: m[0], n: countOf(m[1] ?? m[2] ?? "") })).filter((r) => r.n >= 2);
  if (!refs.length || !String(dropped ?? "").trim() || listCount(dropped) < 2 && !/(?:^|\n)\s*(?:\d{1,2}[.)]|[-\u2022*])\s/.test(dropped)) return null;
  if (/https?:\/\/\S+/.test(kept)) return null;
  const listed = listCount(kept), own = listCount(sentence);
  const pair = /\p{L}[\p{L}\s/-]{1,60}\s(?:and|or)\s\p{L}/u.test(kept);
  const off = refs.find((r) => r.n !== listed && r.n !== own && !(r.n === 2 && pair));
  return off ? off.said : null;
}
// The rule on a finished reply, whichever path made it: `dropped` is what the turn's draft said that the reply no longer does.
export function dropDanglingCounts(reply: string, dropped = ""): string {
  if (!String(dropped ?? "").trim()) return String(reply ?? "");
  const lines = String(reply ?? "").split("\n").map((l) => splitSentences(l));
  const gone = new Set<string>();
  lines.forEach((l, a) => l.forEach((x, b) => {
    const rest = lines.map((l2, i) => l2.filter((_, j) => !(i === a && j === b) && !gone.has(`${i}:${j}`)).join(" ")).join("\n");
    if (danglingRef(x, rest, dropped)) gone.add(`${a}:${b}`);
  }));
  if (!gone.size) return String(reply ?? "");
  const out = lines.map((l, a) => l.filter((_, b) => !gone.has(`${a}:${b}`)).join(" ")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return /\p{L}/u.test(out) ? out : String(reply ?? "");
}
// Review of a339b806a (B2, architect rule, tagged and untagged alike): the person's own words back only a clause whose grammatical
// subject is the person ("You …", "Your SQL …", "With SQL and Excel, you …"). Never a clause about a third party (the role, this
// posting, their team, it, they, the open roles; any team, company or employer frame, named or not), a Trainee first-person action
// ("I applied … for you"), a money figure, or a status or application claim ("You applied … and it is under review").
const SAID_LEAD = /^\W*(?:(?:saved|noted|recorded|got it|and|but|so|also|plus|then|yes|overall|honestly)[:,—–-]?\s+)*(?:(?:with|from|given|based on|going by|per|by|on)\b[^.;:]{1,160}?,\s*(?=you|your))?(?:(?:and|but|so|also)\s+)?/i;
const SAID_SUBJECT = /^(?:you|your|you're|you’re|you've|you’ve|you'd|you’d|you'll|you’ll)(?![\p{L}])/iu;
const SAID_THIRD = /(?<![\p{L}])(?:their|theirs|its|his|her|they|them|team|teams|company|companies|firm|firms|employer|employers|department|org|organization|recruiters?|managers?|hiring|posting|postings|opening|openings|listing|listings)(?![\p{L}])/iu;
const SAID_TRAINEE = /(?<![\p{L}'’])(?:I|I'm|I’m|I've|I’ve|I'll|I’ll|I'd|I’d|we|we've|we’ve|we'll|we’ll|Trainee)(?![\p{L}'’])/u;
const SAID_MONEY = /[$€£¥]|(?<![\p{L}])(?:dollars?|usd|k|per\s+hour|an\s+hour|a\s+year|per\s+year|salary|salaries|pay|pays|paid|wage|wages|earn\w*|income|money|raise|raises|bonus\w*)(?![\p{L}])/iu;
const SAID_STATUS = /(?<![\p{L}])(?:appl(?:y|ied|ies|ying|ication|ications)|submit\w*|sent|send|queued|approv\w*|under\s+review|interview\w*|offer\w*|reject\w*|shortlist\w*|screen(?:ing|ed)?|callback\w*|status|accepted|declined|withdrawn|promot\w*)(?![\p{L}])/iu;
// (a list item's label that is a job title, "Reporting analyst: closest to your 2 years of reporting", heads a verbless line about
// them: the line rests on their words as their own sentence does; with a verb of its own the label is its subject and it does not)
const TITLE_LABEL = /^\W*(?:\d+[.)]\s*)?[\p{L} /&-]{0,40}?\b(?:analyst|engineer|developer|scientist|designer|manager|specialist|coordinator|consultant|associate|assistant|technician|administrator|architect|intern|representative|clerk|tester)s?:\s*/iu;
const FINITE = /(?<![\p{L}])(?:is|are|was|were|has|have|had|needs?|requires?|pays?|wants?|uses?|offers?|hires?|expects?|asks?|lists?|involves?|calls?\s+for|demands?)(?![\p{L}])/iu;
// S3 r12f (follow-up of the independent review of 72e15122e): a clause about the person inside a sentence makes the sentence
// person-subject too, so their words may back it and every rule on a clause about them applies to it (the bars below, the B3 example
// and class-word rule, a field knowledge unit never alone): "Since you know SQL, …", "SQL and Excel, which you know, …", "It's your SQL
// that …", "That gives you a strong base: SQL, …". The third-party, Trainee-action, money and status bars are unchanged and still
// refuse the whole sentence.
// (review of 4908e3df7, B3: ", which you know" only after a verbless head, "SQL and Excel, which you know, …", never after a clause
// of its own, "The role requires SQL, which you know"; "gives you …:" only after that, this, it, which or your-noun; and no embedded
// form when the sentence names the role, job or position)
const SAID_EMBEDDED_OPEN = /^\W*(?:since|because|as|given\s+that|now\s+that)\s+you(?:['’](?:ve|re|d))?(?![\p{L}])/iu;
const SAID_EMBEDDED_WHICH = /,\s*which\s+you(?:['’](?:ve|re))?\s+(?:(?:already|also|clearly)\s+)?(?:know|use|used|have|had|did|done|built|ran|run|do|bring|named|mentioned|said)(?![\p{L}])/iu;
const SAID_EMBEDDED_CLEFT = /^\W*it(?:['’]s|\s+is|\s+was)\s+your(?![\p{L}])/iu;
const SAID_EMBEDDED_GIVES = /^\W*(?:that|this|it|which|your\s+[\p{L}-]+(?:\s+[\p{L}-]+)?)\s+(?:(?:also|really|already)\s+)?gives?\s+you(?![\p{L}])[^:.;!?]{0,80}:\s*\S/iu;
const SAID_EMBEDDED_ROLE = /(?<![\p{L}])(?:the|this|that|these|those)\s+(?:role|job|position)s?(?![\p{L}])/iu;
const saidEmbedded = (t: string) => {
  if (SAID_EMBEDDED_ROLE.test(t)) return false;
  const w = SAID_EMBEDDED_WHICH.exec(t);
  return SAID_EMBEDDED_OPEN.test(t) || (!!w && !FINITE.test(t.slice(0, w.index))) || SAID_EMBEDDED_CLEFT.test(t) || SAID_EMBEDDED_GIVES.test(t);
};
// (review of 4908e3df7, n3, narrowed by the architect after the H022 replay: a definite or past hiring outcome is a status claim, "you
// were/got/have been hired", "you will be hired", "hired within/by …", "you're hired"; a modal possibility naming a kind of role is
// not, "you could/can/might get hired as/into <role>", "you'd be a strong hire for <role>")
const HIRE = /(?<![\p{L}])hir(?:e|ed|es|ing)(?![\p{L}])/iu;
const HIRE_MODAL = /(?<![\p{L}])(?:could|can|might|may|would)\s+(?:(?:likely|probably|realistically)\s+)?(?:get|be)\s+hired\s+(?:as|into|for)\s+(?!(?:at|by|within)\b)|(?<![\p{L}])you(?:['’]d|\s+would|\s+could)\s+be\s+(?:a|an)\s+(?:[\p{L}-]+\s+){0,2}?hire\s+for\s+/giu;
const HIRE_DEFINITE = /(?<![\p{L}])hired\s+(?:within|by|in\s+\d|at|on)(?![\p{L}])/iu;
// (review of 51c798945, B1: a modal hire with a time or certainty marker anywhere in the sentence is an outcome claim, "… within a week",
// "… next month", "… in 2 weeks", "… for sure", "…, guaranteed")
const HIRE_WHEN = /(?<![\p{L}])(?:within|by|in\s+(?:\d+|a|an|one|two|three|four|five|six|a\s+few|few)\s+(?:days?|weeks?|months?|years?)|(?:next|this)\s+(?:week|month|year|quarter|spring|summer|fall|autumn|winter)|soon|right\s+away|immediately|today|tomorrow|for\s+sure|guaranteed|definitely|certainly|surely|will)(?![\p{L}])/iu;
const hireStatus = (t: string) => HIRE.test(t) && (HIRE_DEFINITE.test(t) || HIRE.test(t.replace(HIRE_MODAL, " ")) || HIRE_WHEN.test(t));
export function saidSubject(clause: string): boolean {
  const t = stripTags(String(clause ?? "")).replace(/\*+/g, "").trim();
  const labelled = TITLE_LABEL.exec(t);
  const rest = labelled ? t.slice(labelled[0].length) : t;
  const head = rest.replace(SAID_LEAD, "");
  const fragment = !!labelled && !FINITE.test(rest) && /(?<![\p{L}])your(?![\p{L}])/iu.test(rest);
  const embedded = saidEmbedded(head) || saidEmbedded(rest);
  return (SAID_SUBJECT.test(head) || fragment || embedded) && !SAID_THIRD.test(t) && !SAID_TRAINEE.test(t) && !SAID_MONEY.test(t) && !SAID_STATUS.test(t) && !hireStatus(t);
}
// D-100: a pay, status or outcome claim is never judged as a pair (what they are paid, what was sent, applied for or approved, an
// interview, an offer or a rejection).
const NOT_PAIR = /[$€£]|\b(?:pay|pays|paid|salary|salaries|wage|wages|comp|compensation|earn\w*|money|raises?|income|worth|per\s+hour|an\s+hour|a\s+year|offers?|offered|interview(?:s|ed)?|screen(?:s|ed|ing)?|stages?|callbacks?|hir(?:e|ed|es|ing)|land(?:s|ed|ing)?|promot\w*|reject\w*|accept(?:ed|s)?|appl(?:ied|ication|ications)|submit\w*|sent|queued|approv\w*|status|shortlist\w*)\b/i;
// Review of a339b806a (B3): what a field knowledge unit names as an example (a tool, "Power BI", "Git") is theirs only when their own
// words name it, in any case ("power bi"), anywhere in the clause; and a class word of it (dashboard, spreadsheet, version control)
// credited to them ("your dashboard experience", "you already know …") is theirs only when their words use it too.
const USES_STOP = new Set(["a", "an", "the", "and", "or", "such", "as", "of", "to", "in", "on", "for", "with", "work", "commonly", "involves", "general", "career", "knowledge", "not", "postings", "tool", "tools", "system", "basics", "explaining", "users", "data", "analysis", "it", "fixes"]);
const lowerHas = (hay: string, w: string) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(hay);
export function usesTermsUnsaid(clause: string, usesText: string, theirs: string): string[] {
  const examples = [...String(usesText).matchAll(/\(such as ([^)]+)\)/gi)].flatMap((m) => m[1].split(/\s*,\s*|\s+or\s+/i)).map((x) => x.trim()).filter(Boolean);
  const words = String(usesText).replace(/^General career knowledge, not postings:[^:]*?involves\s*/i, "").replace(/\(such as [^)]+\)/gi, " ").toLowerCase().match(/[\p{L}][\p{L}-]{2,}/gu) ?? [];
  const classes = [...new Set(words.filter((w) => !USES_STOP.has(w)))];
  const escW = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // (S3 r12f: the embedded shapes credit a word to them too: "dashboards, which you know", "gives you a strong base: dashboards")
  // (S3 r12f: a class word is read with its plural too, "your dashboards", "spreadsheets, which you've used")
  const credited = (w: string) => new RegExp(`(?<![\\p{L}])(?:your\\s+(?:[\\p{L}-]+\\s+){0,4}?|you(?:'ve|’ve|\\s+have)?\\s+(?:already\\s+|also\\s+)?(?:know|use|used|have|had|did|done|built|ran|run|do)\\s+(?:[\\p{L}-]+\\s+){0,4}?)${w}(?:s|es)?(?![\\p{L}])`, "iu").test(clause) ||
    new RegExp(`(?<![\\p{L}])${escW(w)}(?:s|es)?(?:\\s+[\\p{L}-]+){0,3}\\s*,\\s*which\\s+you(?![\\p{L}])`, "iu").test(clause) ||
    new RegExp(`(?<![\\p{L}])gives?\\s+you(?![\\p{L}])[^:.;!?]{0,80}:[^.;!?]*?(?<![\\p{L}])${escW(w)}(?:s|es)?(?![\\p{L}])`, "iu").test(clause);
  // (and a class word said in their words counts in either number: "I built dashboards" holds "dashboard")
  const saidIt = (w: string) => lowerHas(theirs, w) || lowerHas(theirs, `${w}s`) || lowerHas(theirs, `${w}es`);
  return [...examples.filter((e) => lowerHas(clause, e) && !lowerHas(theirs, e)), ...classes.filter((w) => credited(w) && !saidIt(w))];
}
// The D-100 pair as one source: both passages marked, each with what it is.
const pairSource = (theirs: EvidenceUnit, role: EvidenceUnit) => [
  `Page title: ${theirs.kind === "said" ? "What the person said in this chat" : "The person's confirmed record"}, and general career knowledge (two passages)`,
  "Whole page, the candidate marked:",
  `>>> ${theirs.kind === "said" ? "What the person said in this chat" : "The person's confirmed record"}: ${theirs.text} | General career knowledge, not postings: ${role.text.replace(/^General career knowledge, not postings:\s*/, "")} <<<`,
].join("\n");
export async function verifyTagged(reply: string, ledger0: Ledger, o: { judge?: SupportJudge | null; own?: string[]; onRecord?: (s: string) => boolean | null; ask?: string; carry?: string | null; said?: string[] } = {}): Promise<Verified> {
  const ledger = o.said?.length ? ledger0.withSaid(o.said) : ledger0;
  // (a question to the person may name only what their own record or their ask names)
  const allowed = [String(o.ask ?? ""), ...ledger.units.filter((u) => u.kind === "record" || u.kind === "said").map((u) => u.text)].join("\n");
  const own = new Set((o.own ?? []).map((x) => x.trim()));
  // (S3 r12: a tag written after the sentence's own stop, "nothing to show yet. [E2] Cashiers…", is that sentence's: the split put it
  // on the next one, so the sentence it ended went uncited and the next one carried a unit that is not about it)
  // (S3 r12, H034: "Which of those four sounds closest to what you want?" after a list of four roles: the count word counts what this
  // reply shows, so it is no figure; the question is read as the plain question it is without it. Any other count still refuses it.)
  const shown = listCount(stripTags(String(reply ?? "")));
  // (never a posting claim: "Which of those four openings should I apply you to?" after an empty search is not a plain question)
  const countedQuestion = (q: string) => { const m = COUNT_REF.exec(q); return !!m && countOf(m[2]) === shown && shown >= 2 && !POSTING_CLAIM.test(q.replace(NO_POSTING, " ")) && personQuestion(q.replace(m[0], m[1]), allowed); };
  const lines = String(reply ?? "").replace(TAG_AFTER_STOP, " $3$1$2").split("\n").map((l) => /^\s*(?:https?:\/\/\S+\s*)*$/.test(l) ? [l] : splitSentences(l).filter((x) => x.trim()));
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
  // (S3 r12c, dev H022: "With SQL, Excel and Tableau …" made "SQL" an unknown employer and "Reporting analyst: …" made "Reporting" one,
  // so every sentence mapping the person's own skills to a role was dropped. A word the person's own lines (their record, what they
  // said in this chat) or a suggestion unit use as a plain word, never as an employer there, names no employer here either; a record
  // line that uses it as one, "Intern at Stripe", still makes it a subject, as round 12 B1 has it)
  // (review of PR #871, B2: what they said clears a word only where this sentence does not use it as an employer. "I love Apple
  // products" said, "Apple has a data analyst team that would suit you" written: Apple is the sentence's subject, so their words, which
  // back no employer claim, are kept out of its units; their record and code's suggestions clear a word as before)
  const ownWords = ledger.units.filter((u) => u.kind === "record" || u.kind === "said" || u.kind === "suggestion");
  const usedAsName = (us: EvidenceUnit[], w: string) => us.some((u) => unitNames({ ...u, kind: "page", host: null, owner: null }, true).some((n) => nameFoundIn(w, n) || nameFoundIn(n, w)));
  const plainOwnWord = (w: string, t: string) => {
    if (usedAsName(ownWords, w)) return false;
    const strong = ownWords.filter((u) => u.kind !== "said");
    if (strong.some((u) => nameFoundIn(w, u.text))) return true;
    return ownWords.some((u) => u.kind === "said" && nameFoundIn(w, u.text)) && !employerFrame(w, t);
  };
  // (S3 r12c, dev H022 turn 1 in the probes: "… a reporting analyst, BI analyst, data analyst …" made "BI" an unknown employer, carried
  // it, and every later sentence failed "no cited unit is about BI". A word written straight before a job title's singular head
  // noun is that title's qualifier, "BI analyst", "Reporting analyst", never an employer; an employer is read with the plural, "Citadel
  // analysts", as unitNames reads it)
  const jobTitleWord = (w: string, t: string) => new RegExp(`(?<![\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(?:analyst|engineer|developer|scientist|designer|manager|specialist|coordinator|consultant|associate|assistant|technician|administrator|architect|intern|representative|clerk|tester)(?![\\p{L}])`, "iu").test(t);
  // (review of PR #871, B2: a sentence that uses any name as an employer, "Goldman would be a great first employer for you", rests
  // on no word of theirs, whether or not code reads that name as its subject: their words back no employer claim)
  const saidBarred = (t: string) => [...bare(t).matchAll(/(?<![\p{L}])\p{Lu}[\p{L}&.'-]+/gu)].some((m) => {
    const w = m[0].replace(/['’]s$/, "");
    const opens = /^\W*$/.test(bare(t).slice(0, m.index!));
    return w !== "I" && !SOURCE.test(w) && !jobTitleWord(w, t) && !(opens && FUNCTION_OPENER(w)) && !NOT_NAME.test(w) && employerFrame(w, t);
  });
  const unknownIn = (t: string): string | null => unitNames({ id: "", kind: "page", text: t, host: null }, true).find((w) => {
    if (owners.some((x) => nameFoundIn(x, w) || nameFoundIn(w, x)) || SOURCE.test(w) || plainOwnWord(w, t) || jobTitleWord(w, t)) return false;
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
  // S3 r12e (dev H022, s3sub 52e2025c9 p3): the person's own words are units of the check only (withSaid), never of the drafting
  // ledger, so the draft can never cite them. A sentence the draft tagged with what it could cite ("… your 2 years of reporting is the
  // closest experience to it. [E2]", the empty search's count line) was checked against that unit alone: their words were never
  // shown to code or to the judge, and every sentence mapping their stated skills failed ("'2' is in no cited unit"). Their words
  // join the units of a tagged sentence as they join an untagged one's; every rule on them stands (only a clause about them, never
  // one with an employer subject or an employer frame, a figure only as a whole number, and the judge reads every clause).
  const withSaidUnits = (us: EvidenceUnit[]) => [...us, ...ledger.units.filter((u) => u.kind === "said" && !us.includes(u))];
  // D-100 (architect ruling, 2026-11-21): what a field commonly involves (a `uses` unit) is never, on its own, evidence for a clause
  // about the person: "You know Python" rests on nothing they said. It is only ever the role half of the D-100 pair below.
  const aboutThem = (t: string) => /(?<![\p{L}'’])(?:you|your|you're|you’re|you've|you’ve|yours)(?![\p{L}])/iu.test(t);
  const notUsesFor = (t: string) => (u: EvidenceUnit) => !(u.uses && aboutThem(t));
  // (review of a339b806a, B3: a field knowledge example or class word credited to them must be in the words of theirs a clause rests on)
  const theirWords = ledger.units.filter((u) => u.kind === "said" || u.kind === "record").map((u) => u.text).join("\n");
  const usesSaid = (t: string, u: EvidenceUnit) => ledger.units.filter((x) => x.uses).every((x) => !usesTermsUnsaid(t, x.text, u.text).length);
  lines.forEach((l, a) => l.forEach((x, b) => {
    if (/^\s*(?:https?:\/\/\S+\s*)*$/.test(x)) return;
    const { ids, text } = tagsOf(x);
    lines[a][b] = text;
    // (review of 51c798945, B1: a hiring outcome said about the person, a definite one or a modal one with a time or certainty marker,
    // rests on no unit and no words of theirs; it is refused in code, tagged or not, before the no-claim rule could let it pass unread)
    if (/\p{L}/u.test(text) && !own.has(text) && aboutThem(text) && hireStatus(text) && !/\?\s*["'”’)]*\s*$/.test(text)) { fail(a, b, text, "it states a hiring outcome for the person, which nothing this turn holds"); return carryPast(text); }
    if (!/\p{L}/u.test(text) || own.has(text) || noClaim(text) || personQuestion(text, allowed) || countedQuestion(text)) return carryPast(text);
    if (rec(text) === true) return carryPast(text);
    // The record's verdict comes before the plain-sentence rule: a sentence about the record that the record contradicts fails.
    if (rec(text) === false) { failures.push({ sentence: text, reason: "it is not what the person's record holds" }); bad.add(`${a}:${b}`); return; }
    if (free(text)) {
      const subj = mentioned(text)[0] ?? unknownIn(text) ?? carried;
      const pool0 = forClaim(ids.length ? withSaidUnits(ids.map((id) => ledger.get(id)).filter((u): u is EvidenceUnit => !!u)) : ledger.units, text);
      const pool = pool0.filter(notUsesFor(text)).filter((u) => u.source !== "an earlier reply in this chat" && !(u.kind === "said" && (subj || saidBarred(text) || !saidSubject(text) || !usesSaid(text, u))) && (subj ? mine(u, subj) || (!unknownSubject(subj) && !u.owner && (anyNamed.get(u.id) ?? []).length === 0) : mine(u, null)));
      if (ids.length) citeAt.set(`${a}:${b}`, ids);
      checks.push({ a, b, clause: text, units: pool, claim: text, subject: subj, advice: true, untagged: !ids.length });
      return carryPast(text, false);
    }
    // Review of #849: a sentence with no figure, no date and no name needs no tag (LEDGER_RULE says so); only one that names or
    // counts something must cite a unit.
    // Review of #849 (round 2): an untagged sentence on an evidence turn is checked against EVERY unit (layer A, then the judge), as the
    // support check always did; it is neither dropped unread nor let through unread.
    const cited = ids.length ? ids : ledger.units.map((u) => u.id);

    const units0 = cited.map((id) => ledger.get(id)).filter(Boolean) as EvidenceUnit[];
    if (units0.length < cited.length) { failures.push({ sentence: text, reason: `it cites ${cited.filter((id) => !ledger.get(id)).join(", ")}, which no evidence unit is` }); bad.add(`${a}:${b}`); return; }
    if (!units0.length) { failures.push({ sentence: text, reason: "it states a fact and no evidence unit holds it" }); bad.add(`${a}:${b}`); return; }
    const units = ids.length ? withSaidUnits(units0) : units0;
    citeAt.set(`${a}:${b}`, ids);
    for (const c of clausesOf(text)) {
      if (noClaim(c) || personQuestion(c, allowed) || countedQuestion(c) || rec(c) === true) continue;
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
      // (S3 r12f: a person-subject clause, an embedded one included, that credits them with a field knowledge example or class word
      // their own words and record never name is refused in code, whatever unit it cites: "Dashboards, which you know, …")
      const unsaidCredit = saidSubject(c) ? [...new Set(ledger.units.filter((u) => u.uses).flatMap((x) => usesTermsUnsaid(c, x.text, theirWords)))] : [];
      if (unsaidCredit.length) return fail(a, b, text, `it credits the person with ${unsaidCredit.map((w) => `"${w}"`).join(", ")}, which their own words and record do not name`);
      const ownSubj = names[0] ?? unknownIn(c) ?? null;
      const subject = ownSubj ?? (owners.length || carried ? carried : null);
      carried = subject;
      // (a carried subject may not rest on a line from an earlier reply whose owner is unknown: it may be another employer's; a soft
      // subject may rest on a unit that names no employer, and the judge is shown the subject)
      // (round 12: an unknown subject rests only on a unit that names it as its employer; a carried subject never rests on a posting
      // record whose employer code cannot tell, which is some other employer's posting)
      // (S3 r12c: the person's own words back only a clause about them, never one about an employer)
      const allowedUnits = forClaim(units, c).filter(notUsesFor(c)).filter((u) => !(subject && !ownSubj && !u.owner && u.source === "an earlier reply in this chat") && !(u.kind === "said" && (subject || saidBarred(c) || saidBarred(text) || !saidSubject(c) || !usesSaid(c, u))) &&
        (unknownSubject(subject) ? namesAsEmployer(u, subject!) :
          mine(u, subject) || (!!subject && !ownSubj && !u.owner && !u.posting && (anyNamed.get(u.id) ?? []).length === 0)));
      if (!allowedUnits.length) return fail(a, b, text, subject ? `no cited unit is about ${subject}` : "it names no employer, and every unit that could hold it is one employer's", subject);
      checks.push({ a, b, clause: c, units: allowedUnits, claim: text, subject, soft: !ownSubj, untagged: !ids.length });
    }
  }));
  // Layer A: each clause against an index of the units it cites, a record unit read as one record (a fact per line).
  const asks: { k: number; claim: string; source: string }[] = [];
  // (round 12: a posting's state unit is read as one sentence, "… is open and closes …", so the role it names stays with its deadline)
  const indexOf = (us: EvidenceUnit[]) => indexPages(us.map((u) => ({ text: u.posting ? u.text.replace(/; it closes /, " and closes ") : u.text, title: u.kind === "page" ? `Page${u.host ? ` (${u.host})` : ""}` : u.kind === "chat" ? "This chat's tool result" : u.kind === "suggestion" ? "General career knowledge" : u.kind === "said" ? "What the person said in this chat:" : "The person's confirmed record:", places: u.places ?? [], named: u.named ?? [], lend: u.kind === "chat" && u.owner && u.source !== "an earlier reply in this chat" ? u.owner : null, ...(u.kind === "record" || u.kind === "absent" || u.kind === "said" ? { one: true } : {}) })));
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
    // D-100 (architect ruling, 2026-11-21, S3 r12e, dev H022; amends the one-unit rule of the #849 review for this shape only): a
    // clause about the person that maps what they said to a field ("Your SQL, Excel and Tableau are the core of data analysis work")
    // is never one passage: their half is in their own words, the field's half is general career knowledge. Such a clause may be
    // judged against exactly two units, one said or record unit and one suggestion unit, sent as one source with both passages
    // marked. Code holds their half: every name and figure of the clause is in their unit (a job title's qualifier aside), each
    // figure a whole number written in digits there (no word figure, year or amount), and the clause shares at least one of them with
    // it. The judge holds the rest: a yes means each half is stated by its own passage. Never for a clause with an employer subject or
    // frame (c.units holds their unit only then; saidBarred), a posting claim (forClaim), or a pay, status or outcome claim.
    let paired = false, pairAsks: { k: number; claim: string; source: string }[] = [];
    if (o.judge && !c.subject && saidSubject(c.clause) && !saidBarred(c.clause) && !saidBarred(c.claim) && !NOT_PAIR.test(c.clause) && !POSTING_CLAIM.test(c.clause.replace(NO_POSTING, " ")) &&
      !hp.quant.length && !hp.years.length && hp.numbers.length === (c.clause.match(/\d+(?:[.,]\d+)?/g) ?? []).length) {
      const roleHalf = ledger.units.filter((u) => u.kind === "suggestion");
      const own = (u: EvidenceUnit) => wholeNumbersIn(c.clause, u.text) && !missingSpecifics(c.clause, [u], true).some((m) => /\d/.test(m) || !jobTitleWord(m, c.clause)) &&
        (hp.numbers.length > 0 || hardParts(c.clause).names.length > 0);
      const theirs = c.units.filter((u) => (u.kind === "said" || u.kind === "record") && own(u)).slice(0, 2);
      // (B3: checked against every field knowledge unit of the turn, so a second suggestion unit never carries what the first refuses)
      const usesTexts = ledger.units.filter((u) => u.uses).map((u) => u.text);
      const pairs = theirs.filter((t) => usesTexts.every((x) => !usesTermsUnsaid(c.clause, x, t.text).length)).flatMap((t) => roleHalf.map((r) => [t, r] as const)).slice(0, 3);
      pairAsks = pairs.map(([t, r]) => ({ k, claim: withSubject(c), source: pairSource(t, r) }));
    }
    // (layer A may place the clause in their unit alone, which never states the field's half: the pair is asked beside it, one yes enough)
    if (!f) { asks.push(...pairAsks); paired = pairAsks.length > 0; }
    if (!f && !figure && o.judge) {
      const pool = c.units; // already only the subject's own units and unowned ones
      // (only when every name of the clause, the opening one too, is in those units: code failed on wording alone, never on a fact)
      // (CodeRabbit on #849: no clause spans two units: each unit that alone holds every name of it is asked on its own, at most
      // three, and one yes is enough)
      const one = pool.filter((u) => !missingSpecifics(c.clause, [u], true).length).slice(0, 3);
      if (one.length) { for (const u of one) asks.push({ k, claim: withSubject(c), source: u.text.slice(0, 2400) }); return; }
    }
    if (paired) return;
    if (!f) { const miss = missingSpecifics(c.clause, c.units); failures.push({ sentence: c.claim, reason: c.untagged ? "it states a fact and cites no evidence unit, and no unit holds it" : miss.length ? miss.map((m) => `'${m}' is in no cited unit`).join("; ") : `no single cited unit holds "${c.clause}"`, subject: c.subject ?? null }); bad.add(`${c.a}:${c.b}`); return; }
    const held = c.units[f.page]; // indexPages makes one page per cited unit, in order
    // (review of PR #871, B1: a figure their words hold is theirs only as a whole number, never a part of a year)
    if (held?.kind === "said" && !wholeNumbersIn(c.clause, held.text)) { failures.push({ sentence: c.claim, reason: `a figure of "${c.clause}" is not one the person said`, subject: c.subject ?? null }); bad.add(`${c.a}:${c.b}`); return; }
    const stale = (held?.dated ?? []).filter((y) => !c.clause.includes(y) && !c.clause.includes(`'${y.slice(2)}`) && !c.clause.includes(`’${y.slice(2)}`));
    if (stale.length) { failures.push({ sentence: c.claim, reason: `the unit that holds "${c.clause}" is for a period that has ended (${stale.join(", ")}); the sentence must say so`, subject: c.subject ?? null }); bad.add(`${c.a}:${c.b}`); return; }
    const unitOwner = held?.owner ?? null;
    if (c.subject && (unitOwner ? unitOwner !== c.subject : !c.soft && !nameFoundIn(c.subject, f.unit.passage))) { failures.push({ sentence: c.claim, reason: `the unit that holds "${c.clause}" is not about ${c.subject}`, subject: c.subject }); bad.add(`${c.a}:${c.b}`); return; }
    // (an untagged sentence a unit supports keeps that unit's source link, as a tagged one does)
    if (c.untagged && held) citeAt.set(`${c.a}:${c.b}`, [...new Set([...(citeAt.get(`${c.a}:${c.b}`) ?? []), held.id])]);
    asks.push({ k, claim: withSubject(c), source: f.unit.passage }, ...(held && (held.kind === "said" || held.kind === "record") ? pairAsks : []));
  });
  const got = await judgeAll(o.judge, asks.map((x) => ({ claim: x.claim, source: x.source })));
  const yesAt = new Set(asks.flatMap((x, j) => got[j] ? [x.k] : []));
  asks.forEach((x, j) => { const c = checks[x.k]; if (!yesAt.has(x.k) && asks.findIndex((y) => y.k === x.k) === j && !bad.has(`${c.a}:${c.b}`)) { failures.push({ sentence: c.claim, reason: c.untagged ? "it states a fact and cites no evidence unit, and no unit states it" : `the cited unit does not state "${x.claim}"`, subject: c.subject ?? null }); bad.add(`${c.a}:${c.b}`); } });
  // (S3 r12: a list marker split off as its own piece, "1." of "1. Help desk …", goes with the item it numbers: an item dropped above
  // left "1. 2. 3." standing as the reply)
  // (a counted question stands only while what it counts still stands: its items checked above, it is checked again on what is kept)
  // (S3 r12, architect ruling, narrowed after the review of cbea914e9: a kept sentence that refers back to a list goes when that list
  // was among what this pass dropped, danglingRef; never the last thing standing)
  const droppedText = lines.filter((l, i) => l.some((y, j) => y && bad.has(`${i}:${j}`))).map((l) => l.filter((y) => !!y).join(" ")).join("\n");
  lines.forEach((l, a) => l.forEach((x, b) => {
    const key = `${a}:${b}`;
    if (!x || bad.has(key) || !droppedText.trim()) return;
    const keptText = lines.map((l2, i) => l2.filter((y, j) => y && !bad.has(`${i}:${j}`) && `${i}:${j}` !== key).join(" ")).join("\n");
    const off = danglingRef(x, keptText, droppedText);
    if (off && /\p{L}/u.test(keptText.replace(/https?:\/\/\S+/g, ""))) { failures.push({ sentence: x, reason: `"${off}" counts items this reply no longer shows` }); bad.add(key); }
  }));
  lines.forEach((l, a) => l.forEach((x, b) => { if (LIST_MARK.test(x) && (b + 1 >= l.length || bad.has(`${a}:${b + 1}`) || LIST_MARK.test(l[b + 1] ?? ""))) bad.add(`${a}:${b}`); }));
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
  ask: string; contracts?: Contract[]; maxChars?: number; answers?: (text: string) => boolean; names?: string[]; said?: string[] }): Promise<PipelineOut> {
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
      `EVIDENCE:\n${ledger.block()}`,
      // (S3 r12c: the check reads the person's own words too, so the repair sees them, as what they said and nothing more)
      ownStatements(o.said ?? []).length ? `THE PERSON'S OWN WORDS IN THIS CHAT (say them back only as what they told you, never as confirmed, never as a fact about an employer or a posting):\n${ownStatements(o.said ?? []).map((x) => `- ${x.replace(/\s+/g, " ").trim().slice(0, 300)}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
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
