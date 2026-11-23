// D-101 (architect ruling, 2026-11-23, S3 r12f): a code floor for a gutted reply. On a turn whose search came back empty, the reply
// pipeline (reply_pipeline.ts) checks every sentence of the draft; when it drops them, what is left can answer nothing: only the
// not-sent line, code's "couldn't verify" fallback, a "not on file" line, or a sentence that points back at items it dropped ("Which
// of these roles …", "I can still keep it in mind …"). Then code adds a short floor reply built ONLY from its own records:
//   (a) what was searched, restated from the search's own words: role words, place and constraints (day shift, remote, a pay band);
//   (b) the result count;
//   (c) when the search gave one, the entry-route suggestion unit (entry_routes.ts), said as general career knowledge, never as theirs;
//   (d) one next step that really routes (next_step.ts emptyNextStep: a verified watch, else another search, wider).
// It is code prose about code's own records, so the support judge does not read it, and it says nothing about the person: no line
// here names what they want, have or are. "Couldn't verify an answer to that from what I read" never stays as the whole substance
// of the reply: in a gutted reply the floor takes its place. A city "not on file" is never said when the search searched a place this
// turn's message named.
import { STATE_NAMES, US_CITIES } from "../posting_place.ts";
import { splitSentences } from "./research/support.ts";
import { SEARCH_AGAIN } from "./next_step.ts";

const FALLBACK_HEAD = "I couldn't verify an answer to that from what I read.";
// The not-sent boundary line, in the shapes the brain and code write it.
const NOT_SENT = /^\W*(?:nothing(?:\s+[\p{L}'’]+){0,3}?\s+(?:has|have|was|were|is)\s+(?:been\s+)?(?:sent|submitted|applied|queued)|(?:I|Trainee)\s+(?:haven['’]t|have\s+not|didn['’]t|did\s+not)\s+(?:sent|submitted|applied|queued))(?![\p{L}])[^.!?]*[.!]?\s*$/iu;
const NOT_ON_FILE = /(?<![\p{L}])(?:not|isn['’]t|aren['’]t)\s+on\s+(?:file|record)(?![\p{L}])|^\W*not on file:/iu;
const PLACE_WORD = /(?<![\p{L}])(?:city|cities|location|town|area|address|zip|state|where\s+you(?:['’]re|\s+are)?\s+(?:based|located|live))(?![\p{L}])/iu;
// A reference back to items the reply does not show: these, those, them, they, "it" as an object, "the ones above". "This chat" and
// "it is …" (the expletive) are not references back.
const BACK_REF = /(?<![\p{L}'’])(?:these|those|them|they|they['’](?:re|ve|ll)|the\s+(?:ones?|roles?|options?|jobs?|postings?|openings?)\s+(?:above|below|listed|I\s+(?:named|listed|mentioned|found)))(?![\p{L}'’])|(?<![\p{L}'’])it(?![\p{L}'’])(?!\s+(?:is|was|may|might|can|could|would|will|seems|looks)(?![\p{L}]))/iu;

export interface FloorIn {
  reply: string; // the reply as it stands after the pipeline
  dropped: boolean; // the pipeline (or the support check) dropped at least one sentence of the draft
  codeLines?: readonly string[]; // code's not-run lines: kept, never substance
  message: string; // this turn's message
  emptyQuery: string | null; // the empty search's words (career_tools.ts c.turn.emptySearch)
  count: number; // the search's result count
  anyFound: boolean; // a search of this turn found postings
  routes?: string | null; // the search's entry-route suggestion unit, as the ledger holds it
  nextStep: string; // next_step.ts emptyNextStep for the empty query
}

// What a sentence of the kept reply is: boilerplate (kept, not substance), a reference back (dropped), or substance.
type Kind = "code" | "step" | "notSent" | "notOnFile" | "fallback" | "back" | "substance";
// Code's own next-step lines (next_step.ts): the floor gives its own, so one already there is not kept twice.
const STEP = (s: string) => s === SEARCH_AGAIN || /^Say "watch for .+ roles" and I'll save a watch for them on your list\.$/.test(s);
interface Piece { text: string; kind: Kind; para: number }
function piecesOf(reply: string, codeLines: readonly string[]): Piece[] {
  const out: Piece[] = [];
  let inFallback = false;
  String(reply ?? "").split(/\n{2,}/).forEach((para, p) => {
    inFallback = false;
    for (const line of para.split("\n")) {
      // (code's fallback line, and when it says "This chat's tool results do hold:", each unit it lists and its link after it, to the
      // paragraph's end)
      let rest = line;
      if (inFallback) { out.push({ text: line, kind: "fallback", para: p }); continue; }
      const at = line.indexOf(FALLBACK_HEAD);
      if (at >= 0) {
        const after = line.slice(at + FALLBACK_HEAD.length).trim();
        out.push({ text: FALLBACK_HEAD, kind: "fallback", para: p });
        if (/^This chat's tool results do hold:$/.test(after)) { inFallback = true; rest = line.slice(0, at); }
        else rest = `${line.slice(0, at)} ${after}`;
      }
      for (const c of codeLines) if (c && rest.includes(c)) { out.push({ text: c, kind: "code", para: p }); rest = rest.split(c).join(" "); }
      for (const s of splitSentences(rest).map((x) => x.trim()).filter((x) => /\p{L}/u.test(x))) out.push({ text: s, kind: STEP(s) ? "step" : NOT_SENT.test(s) ? "notSent" : NOT_ON_FILE.test(s) ? "notOnFile" : "substance", para: p });
    }
  });
  // A reference back with nothing of substance before it points at what was dropped.
  let seen = false;
  for (const x of out) {
    if (x.kind !== "substance") continue;
    if (!seen && BACK_REF.test(x.text)) { x.kind = "back"; continue; }
    seen = true;
  }
  return out;
}
// Whether the kept reply answers nothing (D-101): every sentence is boilerplate or a reference back to dropped items.
export function answersNothing(reply: string, codeLines: readonly string[] = []): boolean {
  return !piecesOf(reply, codeLines).some((x) => x.kind === "substance");
}

// ---------------------------------------------------------------------------------------------------- (a) what was searched
const STATE_FULL = new Set(Object.values(STATE_NAMES));
const CONSTRAINT: [RegExp, (m: RegExpExecArray) => string][] = [
  [/(?<![\p{L}])(day|night|evening|overnight|swing|weekend)s?[- ]?shifts?(?![\p{L}])/iu, (m) => `${m[1].toLowerCase()} shift`],
  [/(?<![\p{L}])(days|nights|weekends)\s+only(?![\p{L}])/iu, (m) => `${m[1].toLowerCase().replace(/s$/, "")} shift`],
  [/(?<![\p{L}])(remote|hybrid|on-?site|in-?person)(?![\p{L}])/iu, (m) => m[1].toLowerCase()],
  [/(?<![\p{L}])(part|full)[- ]?time(?![\p{L}])/iu, (m) => `${m[1].toLowerCase()}-time`],
  [/(?<![\p{L}])(per\s+diem|prn|contract|temporary|temp|seasonal)(?![\p{L}])/iu, (m) => m[1].toLowerCase()],
  [/(?<![\p{L}])(entry[- ]level|new[- ]grad|junior|senior)(?![\p{L}])/iu, (m) => m[1].toLowerCase().replace(/-/g, " ")],
  [/\$\s?\d[\d,.]*\s?k?(?:\s?(?:-|–|to)\s?\$?\s?\d[\d,.]*\s?k?)?(?:\s?(?:\/|per|an?)\s?(?:hr|hour|year|yr))?|(?<![\p{L}\p{N}])\d{2,3}k(?:\s?(?:-|–|to)\s?\d{2,3}k)?(?![\p{L}])/iu, (m) => m[0].replace(/\s+/g, " ").trim()],
];
const FILLER = /^(?:jobs?|roles?|positions?|openings?|postings?|work|near|in|around|at|for|only|with|the|a|an|and|or|any|area|city|of|to)$/i;
const titleCase = (t: string) => t.replace(/(^|[\s-])(\p{L})/gu, (_m, s: string, c: string) => s + c.toUpperCase());
// The search's own words, parsed: its role words, its place and its constraints. Nothing else is read.
export function searchedParams(query: string): { role: string; place: string | null; constraints: string[] } {
  let q = ` ${String(query ?? "").replace(/["“”'‘’`]/g, "").replace(/\s+/g, " ").trim()} `;
  const constraints: string[] = [];
  for (const [re, say] of CONSTRAINT) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of [...q.matchAll(g)]) { const c = say(m as unknown as RegExpExecArray); if (!constraints.includes(c)) constraints.push(c); }
    q = q.replace(g, " ");
  }
  const words = q.trim().split(/\s+/).filter(Boolean);
  // A place: a city or state the posting place reader knows (one to three words), with a state code after it ("Columbus OH").
  let place: string | null = null;
  for (let n = 3; n >= 1 && !place; n--) for (let i = 0; i + n <= words.length && !place; i++) {
    const ph = words.slice(i, i + n).join(" ").replace(/,$/, "");
    if (US_CITIES.has(ph.toLowerCase()) || (n > 1 || ph.length > 2) && STATE_FULL.has(ph.toLowerCase())) {
      const code = words[i + n] && /^[A-Z]{2},?$/.test(words[i + n]) && STATE_NAMES[words[i + n].replace(/,$/, "").toLowerCase()] ? words[i + n].replace(/,$/, "") : "";
      place = `${titleCase(ph)}${code ? `, ${code}` : ""}`;
      words.splice(i, n + (code ? 1 : 0));
    }
  }
  const role = words.filter((w) => !FILLER.test(w)).join(" ").replace(/\s+/g, " ").trim();
  return { role, place, constraints };
}
const countSaid = (n: number) => n === 0 ? "found 0 postings" : n === 1 ? "found 1 posting" : `found ${n} postings`;
export function searchedLine(query: string, count: number): string {
  const p = searchedParams(query);
  const what = p.role ? `${p.role} roles` : "roles";
  return `I searched for ${what}${p.place ? ` near ${p.place}` : ""}${p.constraints.length ? ` (${p.constraints.join(", ")})` : ""} and ${countSaid(count)}.`;
}
// (c) the entry-route unit as general career knowledge: the ledger's own words, with its label said plainly.
export function routesLine(unit: string | null | undefined): string | null {
  const t = String(unit ?? "").trim();
  const m = /^General career knowledge, not postings:\s*(people moving into .+)$/i.exec(t);
  return m ? `As general career knowledge, not postings: ${m[1]}` : null;
}
// The person named the searched place in this turn's message.
const namedHere = (place: string | null, message: string) => !!place && new RegExp(`(?<![\\p{L}])${place.split(",")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu").test(String(message ?? ""));

// The reply with code's floor, or null when the floor does not apply (nothing was dropped, the search found postings, no empty search
// ran, or what is left still answers).
export function floorReply(o: FloorIn): string | null {
  if (!o.dropped || !o.emptyQuery || o.anyFound) return null;
  const codeLines = o.codeLines ?? [];
  const ps = piecesOf(o.reply, codeLines);
  const place = searchedParams(o.emptyQuery).place;
  const placeNamed = namedHere(place, o.message);
  // (never a city "not on file" when the search searched a place they named this turn)
  const keep = (x: Piece) => x.kind === "notSent" || (x.kind === "notOnFile" && !(placeNamed && PLACE_WORD.test(x.text)));
  const substance = ps.some((x) => x.kind === "substance");
  if (substance) return null;
  const floor = [searchedLine(o.emptyQuery, o.count), routesLine(o.routes)].filter(Boolean).join(" ");
  const kept = ps.filter(keep).map((x) => x.text).join(" ");
  const code = ps.filter((x) => x.kind === "code").map((x) => x.text).join(" ");
  return [code, floor, kept, o.nextStep].filter((x) => x && x.trim()).join("\n\n");
}
