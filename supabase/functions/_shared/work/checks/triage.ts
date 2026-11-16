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
  /^(?:yes,? )?(?:relocation|remote work|remote|hybrid)(?: support)? (?:is )?(?:available|offered|provided|included|allowed|paid|covered)$/,
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

// Round 5: a commitment that names its subject meets only a constraint about that subject ("Hybrid is available" does
// not meet "fully remote"). A statement with no named subject ("yes", "we do") is read as about the constraint asked.
const SUBJECTS: [RegExp, RegExp][] = [
  [/\b(?:visas?|sponsor\w*|h[- ]?1b|opt|work visa)\b/, /\b(?:visa|sponsor|h[- ]?1b|immigration|work authori[sz]ation)|\bopt\b/],
  [/\breloc\w*\b/, /\breloc/],
  [/\bremote\b/, /\bremote\b/],
  [/\bhybrid\b/, /\bhybrid\b/],
];
// The constraint's own subjects: a subject word counts only when no negation stands within three words before it
// ("fully remote, not relocation" is about remote, not relocation; round 6).
// Round 10: a subject is wanted only when no negation stands anywhere in its clause, before or after it ("remote not
// acceptable", "Remote: no.", "relocation is not wanted").
// Round 11: the whole text is read, not clause by clause; a split at a comma or a bracket cut "Remote, not acceptable"
// from its negation. Several subjects are already refused before this (round 7), so nothing needs splitting.
const REFUSAL = /\b(?:dealbreaker|deal breaker|unacceptable|not acceptable|not ok|not okay|out of the question|won't|can't|avoid\w*|is out|anything but|opposite|un acceptable|off the table|rejected|forbidden|prohibited|hard pass)\b|❌/;
function topicHas(topic: string, about: RegExp): boolean {
  return new RegExp(about.source).test(topic) && !NEG.test(topic) && !REFUSAL.test(topic);
}
function aboutOther(s: string, limit?: { id: string; text: string }): boolean {
  if (!limit) return false;
  // When the constraint's id names a subject, that is its subject; otherwise its text's un-negated subjects are.
  const id = normalise(`${String(limit.id).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")} ${String(limit.id).replace(/[_-]+/g, " ")}`);
  // Round 12: a constraint that names a subject and carries a negation or refusal anywhere, in its id or its text, does not
  // plainly want that subject, so no commitment meets it: not one naming a subject, and not "yes", "it is available" or
  // "we offer it" either (the subject named only in the id, with "Not acceptable" as the text, had met).
  // Round 14: every dash and invisible format character, and camelCase ids ("noRemote"), are read as spaces; the subject
  // lists accept "h 1b" (round 13's hyphen map hid "H-1B").
  const spaced = (x: string) => String(x ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[\p{Cf}\u034F]/gu, "").replace(/[\p{Pd}_\u2212]+/gu, " ").replace(/\u02BC/g, "'");
  // Round 15: the split and the unsplit forms both, so a camelCase split inside a word ("ReLocation") hides nothing.
  const unsplit = (x: string) => String(x ?? "").replace(/[\p{Cf}\u034F]/gu, "").replace(/[\p{Pd}_\u2212]+/gu, " ").replace(/\u02BC/g, "'");
  // Round 16: an invisible format character is also read as a space (then camelCase split), so one between two words
  // ("not\u200Bacceptable", "no\u200Bremote") does not glue them into a word no list matches.
  const gapped = (x: string) => String(x ?? "").replace(/[\p{Cf}\u034F]/gu, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[\p{Pd}_\u2212]+/gu, " ").replace(/\u02BC/g, "'");
  const full = normalise([limit.id, limit.text ?? ""].flatMap((x) => [spaced(String(x)), unsplit(String(x)), gapped(String(x))]).join(" ")); // round 13: "deal-breaker", "un-acceptable"
  const refuses = NEG.test(full) || REFUSAL.test(full);
  if (SUBJECTS.some(([, a]) => new RegExp(a.source).test(full)) && refuses) return true;
  // Round 16: a constraint that refuses something (any negation or refusal in its id or text) is not plainly met by a
  // statement naming no subject ("yes", "it is available"), whatever it refuses, listed subject or not ("Moving is a
  // dealbreaker"): which thing the statement answers cannot be read, so it is unknown.
  if (refuses && !SUBJECTS.some(([said]) => said.test(s))) return true;
  // Round 8: the id goes through the same rules as the text: a negated subject (no_hybrid) is not the subject, and an id or
  // text naming several subjects (visa_and_relocation) lets no subject-bearing statement meet.
  const idSubjects = SUBJECTS.filter(([, about]) => about.test(id));
  if (idSubjects.length) {
    if (idSubjects.length > 1) return SUBJECTS.some(([said]) => said.test(s));
    const [, about] = idSubjects[0];
    // A negation anywhere in the id (no_hybrid, hybrid_not_ok) means the id does not plainly want its subject.
    if (!topicHas(id, about) || NEG.test(id)) return SUBJECTS.some(([said]) => said.test(s));
    const textSubjects = SUBJECTS.filter(([, a]) => a.test(normalise(limit.text ?? "")));
    if (textSubjects.some(([, a]) => a !== about)) return SUBJECTS.some(([said]) => said.test(s));
    if (!topicHas(normalise(limit.text ?? "") || id, about) && textSubjects.length) return SUBJECTS.some(([said]) => said.test(s));
    return SUBJECTS.some(([said, a]) => said.test(s) && a !== about);
  }
  const topic = normalise(`${limit.id} ${limit.text}`);
  // Round 7: when the constraint's text names more than one subject, which one it wants cannot be read safely ("Fully
  // remote, won't relocate"; "remote only, hybrid is a dealbreaker"), so any statement naming a subject is unknown.
  const named = SUBJECTS.filter(([, about]) => about.test(topic));
  if (named.length > 1) return SUBJECTS.some(([said]) => said.test(s));
  return SUBJECTS.some(([said, about]) => said.test(s) && !topicHas(topic, about));
}

/** Classifies one statement about one constraint (pass the constraint so a commitment about another subject is unknown). */
export function classify(says: string, limit?: { id: string; text: string }): Verdict {
  const s = normalise(says);
  // Round 13: a literal "meets" goes through the subject check like any commitment; only the fail-closed words return at once.
  if (s === "unknown" || s === "conflict") return s;
  if (s === "meets") return aboutOther(s, limit) ? "unknown" : "meets";
  if (!s) return "unknown";
  const bare = s.replace(/[.!]+$/, "").trim();
  if (MEETS.some((re) => re.test(bare))) return aboutOther(bare, limit) ? "unknown" : "meets";
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
  // Each constraint id once (round 7: a repeated id let the second constraint overwrite the first's verdict).
  const ids = limits.map((l) => l.id);
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup !== undefined) throw new RangeError(`constraint id "${dup}" is used twice`);
  const placed = sources.map((s, i) => ({ s, i, p: datePlaced(s.date) }));
  const dated = placed.filter((x) => x.p !== null).sort((a, b) => a.p!.t - b.p!.t || a.i - b.i);
  const undated = placed.filter((x) => x.p === null);
  const out: Record<string, Verdict> = Object.create(null); // no inherited keys ("__proto__" is an ordinary id)
  for (const l of limits) {
    // A source that gives this constraint a value that is not a string (false, null, ["no"]) has spoken, but not in a
    // form that can be read: unknown, never skipped (round 6: an older "yes" won over a newer false).
    const said = (x: unknown): boolean => Object.prototype.hasOwnProperty.call(x ?? {}, l.id) && (x as Record<string, unknown>)[l.id] !== undefined;
    const read = (s: Source, lim: Limit): Verdict => typeof s.says[l.id] === "string" ? classify(s.says[l.id], lim) : "unknown";
    const speaking = dated.filter(({ s }) => said(s.says)).map(({ s, p }) => ({ v: read(s, l), p: p! }));
    let v: Verdict | null = null;
    if (speaking.length) {
      const last = speaking[speaking.length - 1];
      // Every source that cannot be ordered against the newest: same instant, or same day with either one untimed.
      // Unordered with the newest: the same instant; or, when either has no time, any instant that could fall on that
      // calendar day somewhere on Earth. Round 4: a timed "yes" late on the 11th west of UTC outranked an untimed "no"
      // dated the 12th; round 5: the window's bounds were swapped.
      const H = 3600_000;
      // A calendar day spans [day - 14 h, day + 36 h) in UTC across every zone (UTC+14 starts it first, UTC-12 ends it last).
      const could = (day: number, t: number) => t >= day - 14 * H && t < day + 36 * H;
      const unordered = (a: typeof last.p, b: typeof last.p) => a.t === b.t ||
        (!a.timed && !b.timed && a.day === b.day) || (!a.timed && b.timed && could(a.day, b.t)) || (a.timed && !b.timed && could(b.day, a.t));
      const tied = speaking.filter((x) => unordered(x.p, last.p));
      v = tied.every((x) => x.v === last.v) ? last.v : "unknown";
    }
    const loose = undated.filter(({ s }) => said(s.says)).map(({ s }) => read(s, l));
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
    // Allow-list (round 4): a job is actionable only when every verdict is exactly "meets"; any value that is not a
    // verdict ("Conflict", "no", undefined) is unknown.
    const entries = Object.entries(j.verdicts ?? {});
    const conflict = entries.filter(([, x]) => x === "conflict").map(([k]) => k);
    const unknown = entries.filter(([, x]) => x !== "conflict" && x !== "meets").map(([k]) => k);
    if (!entries.length) { open.push({ id: j.id, unknown: ["(no verdicts)"] }); continue; }
    if (conflict.length) blocked.push({ id: j.id, conflict });
    else if (unknown.length) open.push({ id: j.id, unknown });
    else actionable.push(j.id);
  }
  open.sort((a, b) => a.unknown.length - b.unknown.length);
  return { actionable, open, blocked };
}
