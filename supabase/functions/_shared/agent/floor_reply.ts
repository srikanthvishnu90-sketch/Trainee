// D-101 (architect ruling, 2026-11-23, S3 r12f): a code floor for a gutted reply. On a turn whose search came back empty, the reply
// pipeline (reply_pipeline.ts) checks every sentence of the draft; when it drops them, what is left can answer nothing: only the
// not-sent line, code's "couldn't verify" fallback, a "not on file" line, a sentence pointing back at a list it dropped, or a pronoun
// sentence that names nothing of the ask or the search. Then code appends a short floor built ONLY from its own records:
//   (a) what was searched: the search's own words, parsed, and only those the person typed this turn (role words, place, constraints);
//   (b) the result count;
//   (c) when the search gave one, the entry-route suggestion unit (entry_routes.ts), said as general career knowledge, never as theirs;
//   (d) one next step that really routes (next_step.ts emptyNextStep: a verified watch, else another search, wider).
// It is code prose about code's own records, so the support judge does not read it. It never replaces kept content: it comes after
// it. Only code's own fallback, a sentence pointing back at a dropped list, a next-step line code would add twice, and a city "not on
// file" clause when the person named the searched place this turn are taken out.
// Review of 4908e3df7 (B1): the search's query is the model's text, so it is never restated as written. A role word, a place or a
// constraint is said only when the person's own message this turn has it too (case aside), cleaned to letters, digits and & + / -,
// capped at 6 words or 60 characters; the role half goes when what is left holds a pronoun, a money, status, employer or Trainee
// word. A pay band is never restated: the search matches words and applies no pay filter.
import { STATE_NAMES, US_CITIES } from "../posting_place.ts";
import { splitSentences } from "./research/support.ts";
import { SEARCH_AGAIN } from "./next_step.ts";
import { listCount } from "./reply_pipeline.ts";

const FALLBACK_HEAD = "I couldn't verify an answer to that from what I read.";
// The not-sent boundary line, in the shapes the brain and code write it.
const NOT_SENT = /^\W*(?:nothing(?:\s+[\p{L}'’]+){0,3}?\s+(?:has|have|was|were|is)\s+(?:been\s+)?(?:sent|submitted|applied|queued)|(?:I|Trainee)\s+(?:haven['’]t|have\s+not|didn['’]t|did\s+not)\s+(?:sent|submitted|applied|queued))(?![\p{L}])[^.!?]*[.!]?\s*$/iu;
const NOT_ON_FILE = /(?<![\p{L}])(?:not|isn['’]t|aren['’]t)\s+on\s+(?:file|record)(?![\p{L}])|^\W*not on file:/iu;
const PLACE_WORD = /(?<![\p{L}])(?:city|cities|location|town|area|address|zip|state|where\s+you(?:['’]re|\s+are)?\s+(?:based|located|live))(?![\p{L}])/iu;
// (review B2) A reference back to a list: the sentence opens with these, those, they or them, asks "which of these/those", or points
// at "the … above". It is dangling only when what the turn dropped held a list of two or more items.
const LIST_REF = /^\W*(?:these|those|they|them)(?![\p{L}'’])|(?<![\p{L}])which\s+of\s+(?:these|those)(?![\p{L}])|(?<![\p{L}])the\s+(?:[\p{L}-]+\s+){0,3}?above(?![\p{L}])/iu;
// A pronoun standing for something the sentence does not name.
const PRONOUN_REF = /(?<![\p{L}'’])(?:it|them|they|these|those|this|that)(?![\p{L}'’])/iu;
const STOP = new Set(["the", "and", "for", "with", "near", "any", "got", "anything", "who", "want", "wants", "only", "you", "your", "can", "could", "still", "will", "this", "that", "them", "they", "these", "those", "chat", "keep", "mind", "jobs", "job", "roles", "role", "look", "find", "some", "something", "have", "has", "what", "there", "here", "just", "now", "later", "know"]);
const contentWords = (t: string) => (String(t ?? "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}&+/-]*/gu) ?? []).filter((w) => w.length > 2 && !STOP.has(w));

export interface FloorIn {
  reply: string; // the reply as it stands after the pipeline
  dropped: boolean; // the pipeline (or the support check) dropped at least one sentence of the draft
  droppedText?: string; // what the turn's draft said that the reply no longer does
  codeLines?: readonly string[]; // code's not-run lines: kept, never substance
  message: string; // this turn's message
  emptyQuery: string | null; // the empty search's words (career_tools.ts c.turn.emptySearch)
  count: number; // the search's result count
  anyFound: boolean; // a search of this turn found postings
  routes?: string | null; // the search's entry-route suggestion unit, as the ledger holds it
  nextStep: string; // next_step.ts emptyNextStep for the empty query
}

// What a sentence of the kept reply is. Only "substance" answers. "weak" (a pronoun sentence naming nothing of the ask or the search)
// and the boilerplate are kept but answer nothing; "back", "fallback" and "step" are taken out when the floor is added.
type Kind = "code" | "step" | "notSent" | "notOnFile" | "fallback" | "back" | "weak" | "substance";
interface Piece { text: string; kind: Kind }
// Code's own next-step lines (next_step.ts): the floor gives its own, so one already there is not kept twice.
const STEP = (s: string) => s === SEARCH_AGAIN || /^Say "watch for .+ roles" and I'll save a watch for them on your list\.$/.test(s);
// A sentence that is only a "not on file" statement (no other clause beside it).
const CLAUSE_SPLIT = /(,\s*(?:so|but|and|which)\s+|;\s+)/iu;
const notOnFileOnly = (s: string) => s.split(CLAUSE_SPLIT).filter((c, i) => i % 2 === 0 && /\p{L}/u.test(c)).every((c) => NOT_ON_FILE.test(c));
function piecesOf(reply: string, codeLines: readonly string[], o: { droppedText?: string; ask?: string } = {}): Piece[] {
  const out: Piece[] = [];
  const d = String(o.droppedText ?? "");
  const listDropped = listCount(d) >= 2 || (d.match(/(?:^|\n)\s*(?:\d{1,2}[.)]|[-•*])\s+\S/g) ?? []).length >= 2;
  const askWords = new Set(contentWords(o.ask ?? ""));
  for (const para of String(reply ?? "").split(/\n{2,}/)) {
    let inFallback = false;
    for (const line of para.split("\n")) {
      // (code's fallback line, and when it says "This chat's tool results do hold:", each unit it lists after it, to the paragraph's end)
      if (inFallback) { out.push({ text: line, kind: "fallback" }); continue; }
      let rest = line;
      const at = line.indexOf(FALLBACK_HEAD);
      if (at >= 0) {
        const after = line.slice(at + FALLBACK_HEAD.length).trim();
        out.push({ text: FALLBACK_HEAD, kind: "fallback" });
        if (/^This chat's tool results do hold:$/.test(after)) { inFallback = true; rest = line.slice(0, at); }
        else rest = `${line.slice(0, at)} ${after}`;
      }
      for (const c of codeLines) if (c && rest.includes(c)) { out.push({ text: c, kind: "code" }); rest = rest.split(c).join(" "); }
      for (const s of splitSentences(rest).map((x) => x.trim()).filter((x) => /\p{L}/u.test(x))) {
        const cw = contentWords(s);
        const kind: Kind = STEP(s) ? "step" : NOT_SENT.test(s) ? "notSent" : NOT_ON_FILE.test(s) && notOnFileOnly(s) ? "notOnFile"
          : LIST_REF.test(s) && listDropped ? "back"
          : PRONOUN_REF.test(s) && !/\d/.test(s) && cw.length <= 2 && !cw.some((w) => askWords.has(w)) ? "weak" : "substance";
        out.push({ text: s, kind });
      }
    }
  }
  return out;
}
// (review B2) The not-on-file rule takes out only its own clause.
function withoutPlaceClause(s: string): string {
  const parts = s.split(CLAUSE_SPLIT);
  const keep: string[] = [];
  for (let i = 0; i < parts.length; i += 2) if (!(NOT_ON_FILE.test(parts[i]) && PLACE_WORD.test(parts[i]))) keep.push(parts[i].trim());
  const t = keep.filter((x) => /\p{L}/u.test(x)).join(", ").replace(/^\W+/, "");
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1).replace(/[.!]?\s*$/, ".")}` : "";
}
// Whether the kept reply answers nothing (D-101).
export function answersNothing(reply: string, codeLines: readonly string[] = [], o: { droppedText?: string; ask?: string } = {}): boolean {
  return !piecesOf(reply, codeLines, o).some((x) => x.kind === "substance");
}

// ---------------------------------------------------------------------------------------------------- (a) what was searched
const STATE_FULL = new Set(Object.values(STATE_NAMES));
const CONSTRAINT: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/(?<![\p{L}])(day|night|evening|overnight|swing|weekend)s?[- ]?shifts?(?![\p{L}])/giu, (m) => `${m[1].toLowerCase()} shift`],
  [/(?<![\p{L}])(days|nights|weekends|evenings)(?![\p{L}])/giu, (m) => `${m[1].toLowerCase().replace(/s$/, "")} shift`],
  [/(?<![\p{L}])(remote|hybrid|on-?site|in-?person)(?![\p{L}])/giu, (m) => m[1].toLowerCase().replace("-", "")],
  [/(?<![\p{L}])(part|full)[- ]?time(?![\p{L}])/giu, (m) => `${m[1].toLowerCase()}-time`],
  [/(?<![\p{L}])(per\s+diem|prn|contract|temporary|seasonal)(?![\p{L}])/giu, (m) => m[1].toLowerCase()],
  [/(?<![\p{L}])(entry[- ]level|new[- ]grad|junior|senior)(?![\p{L}])/giu, (m) => m[1].toLowerCase().replace(/-/g, " ")],
];
// (a pay band is taken out of the words and never restated: the search applies no pay filter)
const PAY = /\$\s?\d[\d,.]*\s?k?(?:\s?(?:-|–|to)\s?\$?\s?\d[\d,.]*\s?k?)?(?:\s?(?:\/|per|an?)\s?(?:hr|hour|year|yr))?|(?<![\p{L}\p{N}])\d{2,3}k(?:\s?(?:-|–|to)\s?\d{2,3}k)?(?![\p{L}])/giu;
const FILLER = /^(?:jobs?|roles?|positions?|openings?|postings?|work|near|in|around|at|for|only|with|the|a|an|and|or|any|area|city|of|to)$/i;
// Words that never stand as role words: a pronoun, money, status, an employer frame or Trainee's own action.
const BARRED = /^(?:i|me|my|mine|you|your|yours|we|us|our|he|she|him|her|his|they|them|their|it|its|pay|pays|paid|salary|salaries|wage|wages|money|dollars?|usd|hour|hourly|year|yearly|annual|bonus|equity|earn\w*|approved?|approval|hired?|hiring|applied|apply|application|applications|submit\w*|sent|send|offer\w*|interview\w*|reject\w*|accepted|status|queued|company|companies|employer|employers|inc|llc|corp|ltd|trainee|say|said|will|ignore|instructions?)$/i;
const clean = (t: string) => String(t ?? "").replace(/[^\p{L}\p{N}\s&+/-]/gu, " ").replace(/\s+/g, " ").trim();
const titleCase = (t: string) => t.replace(/(^|[\s-])(\p{L})/gu, (_m, s: string, c: string) => s + c.toUpperCase());
const capped = (ws: string[]) => { const out: string[] = []; for (const w of ws) { if (out.length >= 6 || [...out, w].join(" ").length > 60) break; out.push(w); } return out; };
function placeOf(words: string[]): { place: string | null; at: number; n: number } {
  // (n1: the longest known city or state wins, with a state code after it: "virginia beach VA" is never "beach VA … Virginia")
  for (let n = 3; n >= 1; n--) for (let i = 0; i + n <= words.length; i++) {
    const ph = words.slice(i, i + n).join(" ").toLowerCase();
    // (a state's name opening a city's, "virginia beach VA": the name and the next word before a state code are the city)
    const code2 = words[i + n + 1];
    if (n === 1 && STATE_FULL.has(ph) && words[i + 1] && /^\p{L}{3,}$/u.test(words[i + 1]) && code2 && /^[A-Za-z]{2}$/.test(code2) && STATE_NAMES[code2.toLowerCase()])
      return { place: `${titleCase(`${ph} ${words[i + 1].toLowerCase()}`)}, ${code2.toUpperCase()}`, at: i, n: 3 };
    if (US_CITIES.has(ph) || (ph.length > 2 && STATE_FULL.has(ph))) {
      const nx = words[i + n];
      const code = nx && /^[A-Za-z]{2}$/.test(nx) && STATE_NAMES[nx.toLowerCase()] && !STATE_FULL.has(ph) ? nx.toUpperCase() : "";
      return { place: `${titleCase(ph)}${code ? `, ${code}` : ""}`, at: i, n: n + (code ? 1 : 0) };
    }
  }
  return { place: null, at: -1, n: 0 };
}
const constraintsOf = (t: string) => { const out: string[] = []; for (const [re, say] of CONSTRAINT) for (const m of String(t ?? "").matchAll(re)) { const c = say(m); if (!out.includes(c)) out.push(c); } return out; };
const sameCity = (a: string | null, b: string | null) => !!a && !!b && a.split(",")[0].toLowerCase() === b.split(",")[0].toLowerCase();
// The search's own words, parsed, cleaned and capped, and only what the person's message this turn also has.
export function searchedParams(query: string, message = ""): { role: string; place: string | null; constraints: string[] } {
  let q = clean(String(query ?? "").replace(PAY, " ")).slice(0, 300);
  const constraints0 = constraintsOf(q);
  for (const [re] of CONSTRAINT) q = q.replace(re, " ");
  const words = q.trim().split(/\s+/).filter(Boolean);
  const p = placeOf(words);
  if (p.place) words.splice(p.at, p.n);
  const m = clean(message);
  const has = new Set(m.toLowerCase().split(/\s+/).filter(Boolean));
  const role0 = capped(words.filter((w) => !FILLER.test(w) && has.has(w.toLowerCase())));
  const role = role0.some((w) => BARRED.test(w)) ? "" : role0.join(" ");
  // (n5: the place counts as theirs when the place their message parses to is the searched one)
  const mw = m.split(/\s+/).filter(Boolean), theirs: string[] = [];
  for (let k = 0; k < 5; k++) { const x = placeOf(mw); if (!x.place) break; theirs.push(x.place); mw.splice(x.at, x.n); }
  const place = p.place && theirs.some((x) => sameCity(p.place, x)) ? p.place : null;
  const mCons = constraintsOf(m);
  const constraints = constraints0.filter((c) => mCons.includes(c));
  return { role, place, constraints };
}
const countSaid = (n: number) => n === 1 ? "found 1 posting" : `found ${n} postings`;
export function searchedLine(query: string, count: number, message = ""): string {
  const p = searchedParams(query, message);
  return `I searched for ${p.role ? `${p.role} roles` : "roles"}${p.place ? ` near ${p.place}` : ""}${p.constraints.length ? ` (${p.constraints.join(", ")})` : ""} and ${countSaid(count)}.`;
}
// (c) the entry-route unit as general career knowledge: the ledger's own words, with its label said plainly.
export function routesLine(unit: string | null | undefined): string | null {
  const t = String(unit ?? "").trim();
  const m = /^General career knowledge, not postings:\s*(people moving into .+)$/i.exec(t);
  return m ? `As general career knowledge, not postings: ${m[1]}` : null;
}

// The reply with code's floor appended, or null when the floor does not apply (nothing was dropped, the search found postings, no
// empty search ran, or what is left still answers).
export function floorReply(o: FloorIn): string | null {
  if (!o.dropped || !o.emptyQuery || o.anyFound) return null;
  const codeLines = o.codeLines ?? [];
  const ps = piecesOf(o.reply, codeLines, { droppedText: o.droppedText, ask: `${o.message} ${o.emptyQuery}` });
  if (ps.some((x) => x.kind === "substance")) return null;
  const placeNamed = !!searchedParams(o.emptyQuery, o.message).place;
  const kept = ps.filter((x) => x.kind === "notSent" || x.kind === "weak" || x.kind === "notOnFile")
    .map((x) => x.kind === "notOnFile" && placeNamed ? withoutPlaceClause(x.text) : x.text).filter((x) => x.trim()).join(" ");
  const floor = [searchedLine(o.emptyQuery, o.count, o.message), routesLine(o.routes)].filter(Boolean).join(" ");
  const code = ps.filter((x) => x.kind === "code").map((x) => x.text).join(" ");
  return [code, kept, floor, o.nextStep].filter((x) => x && x.trim()).join("\n\n");
}
