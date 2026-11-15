// Work artifacts, triage verdicts (spec WORK-ARTIFACTS.md, rule D9; pack case 0021). Each constraint gets one of three
// verdicts from the newest dated source that speaks to it. A hedge ("may be considered", "may sponsor") is never a
// promise, so it is unknown; an explicit refusal is conflict; only a plain commitment meets. "None actionable" is valid.
export type Verdict = "meets" | "unknown" | "conflict";
export type Limit = { id: string; text: string; kind: string };
export type Source = { source: string; date?: string; says: Record<string, string> };

// Read fail closed, by allow-list (third review of WO-124c: a word list cannot read English safely, so it must not be
// the thing that says "meets").
//  - meets: ONLY a short, closed set of plain commitment forms (MEETS below), after normalising case, curly quotes,
//    zero-width characters and spacing. "yes", "we sponsor visas", "sponsorship is available". Anything longer or
//    different (a condition, a time, a group, a past tense, a hedge) is not on the list and is unknown.
//  - conflict: a refusal in the first clause (a negation word, an apostrophe-less contraction, "nope", "non-",
//    "stopped", "no longer", "used to"), unless a modal hedges it or it is a known positive idiom ("no questions asked",
//    "no problem", "without exception"). An ambiguous statement is unknown, never conflict.
//  - everything else: unknown.
const MEETS: RegExp[] = [
  /^(?:yes|yep|yeah|confirmed|correct|true|meets)$/,
  /^(?:yes,? )?(?:we |they |the company |the employer |it )?(?:do |does |will |can |always )?(?:sponsors?|offers?|provides?|supports?)(?: (?:visas?|work visas?|visa sponsorship|sponsorship|it|that|this))?$/,
  /^(?:yes,? )?(?:visa |work visa )?sponsorship (?:is )?(?:available|offered|provided|included|supported)$/,
  /^(?:yes,? )?(?:relocation|remote work|remote|hybrid|the stipend|housing|a stipend)(?: support)? (?:is )?(?:available|offered|provided|included|allowed|paid|covered)$/,
  /^(?:yes,? )?(?:it|this|that) is (?:available|offered|provided|included|allowed|covered)$/,
];
const MODAL = /\b(may|might|could|possibly|potentially|perhaps|case[- ]by[- ]case|depend(s|ing|ent)?|not guaranteed|tbd|unclear|open to|pending|subject to)\b/i;
const NEG = /\b(no|none|nope|nah|nobody|nothing|not|never|neither|nor|without|lacks?|lacking|false|zero|unable|cannot|ineligible|unavailable|declined?|refuse[sd]?|excluded?|disqualif\w*|stopped|discontinued|no longer|used to|non|dont|wont|cant|doesnt|isnt|arent|wasnt|didnt|cannot)\b|n't\b|\bcan ?not\b/i;
const POSITIVE_IDIOM = /\b(no questions asked|no problem|no worries|without (?:exception|question|issue)|no exceptions?|no cap|no limit|nothing stops|never (?:refuse|decline|deny)|not a problem|no issue)\b/i;
const CONTRAST = /\s*(?:\bbut\b|\bhowever\b|\bexcept\b|\bexcluding\b|\balthough\b|\bthough\b|\bunless\b|\bother than\b|;)\s*/i;

export function normalise(says: string): string {
  return String(says ?? "").normalize("NFKC").toLowerCase()
    .replace(/[​-‍⁠﻿­]/g, "")
    .replace(/[‘’‛′´`]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, " ").trim();
}

/** Classifies one statement about one constraint. */
export function classify(says: string): Verdict {
  const s = normalise(says);
  if (s === "meets" || s === "unknown" || s === "conflict") return s;
  if (!s) return "unknown";
  const bare = s.replace(/[.!]+$/, "").trim();
  if (MEETS.some((re) => re.test(bare))) return "meets";
  const first = s.split(CONTRAST).filter((x) => x.trim())[0] ?? s;
  const negs = (first.match(new RegExp(NEG.source, "gi")) ?? []).length;
  if (negs === 1 && !MODAL.test(first) && !POSITIVE_IDIOM.test(s)) return "conflict";
  return "unknown";
}

// A source's date as a time, with its precision. ISO (2026-11-10, with or without a time) and month-name dates (Nov 10,
// 2026; 10 November 2026) are read, and only real month names and real days; anything else is undated.
const MONTH_NAMES: Record<string, number> = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 };
const realDay = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() === d; };
export function datePlaced(d?: string): { t: number; day: number; timed: boolean } | null {
  const s = String(d ?? "").trim().toLowerCase();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (m) {
    if (!realDay(+m[1], +m[2] - 1, +m[3])) return null;
    if (m[4] !== undefined && !m[7]) return null; // a time with no offset cannot be placed: undated
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}${m[7] ? m[7].toUpperCase().replace(/^([+-]\d{2})(\d{2})$/, "$1:$2") : "Z"}`);
    if (!Number.isFinite(t)) return null;
    return { t, day: Date.UTC(+m[1], +m[2] - 1, +m[3]), timed: m[4] !== undefined };
  }
  m = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  let mon: string | undefined, day: string | undefined, yr: string | undefined;
  if (m) [mon, day, yr] = [m[1], m[2], m[3]];
  else {
    const n = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{4})$/.exec(s);
    if (n) [day, mon, yr] = [n[1], n[2], n[3]];
  }
  const mi = mon !== undefined && mon in MONTH_NAMES ? MONTH_NAMES[mon] : -1;
  if (mi < 0 || !day || !yr || !realDay(Number(yr), mi, Number(day))) return null;
  const t = Date.UTC(Number(yr), mi, Number(day));
  return { t, day: t, timed: false };
}
export function dateOf(d?: string): number | null { return datePlaced(d)?.t ?? null; }

/**
 * Verdict per constraint id. Dated sources are applied oldest to newest, so the newest dated source that speaks to a
 * constraint controls. Two sources that cannot be ordered and disagree give unknown: the same instant, or the same
 * calendar day when either has no time. An undated (or unreadable) source cannot be placed in time: when it disagrees
 * with the dated verdict, the verdict is unknown, because either one might be the newer (fail closed).
 */
export function verdict(limits: Limit[], sources: Source[]): Record<string, Verdict> {
  const placed = sources.map((s, i) => ({ s, i, p: datePlaced(s.date) }));
  const dated = placed.filter((x) => x.p !== null).sort((a, b) => a.p!.t - b.p!.t || a.i - b.i);
  const undated = placed.filter((x) => x.p === null);
  const out: Record<string, Verdict> = {};
  for (const l of limits) {
    const speaking = dated.filter(({ s }) => typeof s.says[l.id] === "string").map(({ s, p }) => ({ v: classify(s.says[l.id]), p: p! }));
    let v: Verdict | null = null;
    if (speaking.length) {
      const last = speaking[speaking.length - 1];
      // Every source that cannot be ordered against the newest: same instant, or same day with either one untimed.
      const tied = speaking.filter((x) => x.p.t === last.p.t || (x.p.day === last.p.day && (!x.p.timed || !last.p.timed)));
      v = tied.every((x) => x.v === last.v) ? last.v : "unknown";
    }
    const loose = undated.filter(({ s }) => typeof s.says[l.id] === "string").map(({ s }) => classify(s.says[l.id]));
    if (v === null) v = loose.length && loose.every((x) => x === loose[0]) ? loose[0] : "unknown";
    else if (loose.some((x) => x !== v)) v = "unknown";
    out[l.id] = v;
  }
  return out;
}

/** Actionable: no conflict and every verdict meets. Open: no conflict but something unknown. Blocked: any conflict. */
export function rank(jobs: { id: string; verdicts: Record<string, Verdict> }[]) {
  const actionable: string[] = [], open: { id: string; unknown: string[] }[] = [], blocked: { id: string; conflict: string[] }[] = [];
  for (const j of jobs) {
    const by = (v: Verdict) => Object.entries(j.verdicts).filter(([, x]) => x === v).map(([k]) => k);
    const conflict = by("conflict"), unknown = by("unknown");
    if (conflict.length) blocked.push({ id: j.id, conflict });
    else if (unknown.length) open.push({ id: j.id, unknown });
    else actionable.push(j.id);
  }
  open.sort((a, b) => a.unknown.length - b.unknown.length);
  return { actionable, open, blocked };
}
