// Work artifacts, triage verdicts (spec WORK-ARTIFACTS.md, rule D9; pack case 0021). Each constraint gets one of three
// verdicts from the newest dated source that speaks to it. A hedge ("may be considered", "may sponsor") is never a
// promise, so it is unknown; an explicit refusal is conflict; only a plain commitment meets. "None actionable" is valid.
export type Verdict = "meets" | "unknown" | "conflict";
export type Limit = { id: string; text: string; kind: string };
export type Source = { source: string; date?: string; says: Record<string, string> };

// Read fail closed (second review of WO-124c). "meets" needs a plain commitment with no negation, hedge or carve-out
// anywhere in the statement; any doubt is unknown, never meets.
//  - A negation is any refusal word, bare or passive: no, none, nobody, not, n't, never, without, lacks, false, zero,
//    unable, cannot, ineligible, unavailable, declined, "not provided/offered/sponsored", and an answer of "no" or
//    "false" after a colon or question mark ("eligible: no", "we will sponsor? no").
//  - The first clause states the policy. When it is negated (and not hedged by a modal: "may not sponsor" stays open),
//    the verdict is conflict, whatever follows ("cannot sponsor visas but offer great benefits" is conflict).
//  - A commitment followed by a contrast or carve-out ("sponsor H-1B but not OPT", "yes, except interns", "only for
//    seniors") is unknown: whether the person's case is inside it is not stated.
//  - Two negations in one clause ("we don't not sponsor") are unknown.
const MODAL = /\b(may|might|could|possibly|potentially|perhaps|case[- ]by[- ]case|depend(s|ing|ent)?|not guaranteed|tbd|unclear|open to|consider(ed|ing)? on)\b/i;
const HEDGE = /\b(may|might|could|possibly|potentially|perhaps|consider(ed|ing)?|case[- ]by[- ]case|depend(s|ing|ent)?|not guaranteed|tbd|unclear|open to|subject to|typically|usually|generally)\b/i;
const NEG = /\b(no|none|nobody|nothing|not|never|neither|nor|without|lacks?|lacking|false|zero|unable|cannot|ineligible|unavailable|declined?|refuse[sd]?|excluded?|disqualif\w*)\b|n't\b|\bcan ?not\b/gi;
const COMMIT = /\b(will|does|do|yes|true|confirmed?|guarantee[sd]?|provides?|provided|offers?|offered|sponsors?|sponsored|sponsoring|supports?|available|eligible|included|allowed|accepts?|meets?)\b/i;
const CONTRAST = /\s*(?:\bbut\b|\bhowever\b|\bexcept\b|\bexcluding\b|\balthough\b|\bthough\b|\bunless\b|\bother than\b|;)\s*/i;
const CARVE = /\b(only|except|excluding|unless|limited to|other than|not for|restricted to)\b/i;
const negCount = (t: string) => (t.match(NEG) ?? []).length;

/** Classifies one statement about one constraint. */
export function classify(says: string): Verdict {
  const s = says.trim().toLowerCase().normalize("NFKC");
  if (s === "meets" || s === "unknown" || s === "conflict") return s;
  if (!s) return "unknown";
  const [first, ...rest] = s.split(CONTRAST).filter((x) => x.trim());
  const n1 = negCount(first);
  if (n1 >= 2) return "unknown";
  if (n1 === 1) return MODAL.test(first) ? "unknown" : "conflict";
  // The first clause is not negated from here on.
  if (HEDGE.test(s)) return "unknown";
  if (!COMMIT.test(first)) return "unknown";
  if (rest.length || CARVE.test(s) || negCount(s) > 0) return "unknown";
  return "meets";
}

// A source's date as a time. ISO (2026-11-10, with or without a time) and month-name dates (Nov 10, 2026; 10 November
// 2026) are read; anything else is undated. Before, dates were compared as strings, so "Nov 10, 2026" sorted before
// "2026-11-01" and an older ad overrode a newer follow-up.
// A calendar day that exists: Feb 30 and Nov 31 are refused, not rolled into the next month.
const realDay = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() === d; };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function dateOf(d?: string): number | null {
  const s = String(d ?? "").trim().toLowerCase();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (m) {
    if (!realDay(+m[1], +m[2] - 1, +m[3])) return null;
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}${m[7] ? m[7].toUpperCase().replace(/^([+-]\d{2})(\d{2})$/, "$1:$2") : "Z"}`);
    return Number.isFinite(t) ? t : null;
  }
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s) ?? null;
  let mon: string | undefined, day: string | undefined, yr: string | undefined;
  if (m) [mon, day, yr] = [m[1], m[2], m[3]];
  else {
    const n = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/.exec(s);
    if (n) [day, mon, yr] = [n[1], n[2], n[3]];
  }
  const mi = mon ? MONTHS.indexOf(mon) : -1;
  if (mi < 0 || !day || !yr || !realDay(Number(yr), mi, Number(day))) return null;
  return Date.UTC(Number(yr), mi, Number(day));
}

/**
 * Verdict per constraint id. Dated sources are applied oldest to newest, so the newest dated source that speaks to a
 * constraint controls; two sources at the same instant that disagree give unknown. An undated (or unreadable) source cannot be placed in time: when it
 * disagrees with the dated verdict, the verdict is unknown, because either one might be the newer (fail closed).
 */
export function verdict(limits: Limit[], sources: Source[]): Record<string, Verdict> {
  const placed = sources.map((s, i) => ({ s, i, t: dateOf(s.date) }));
  const dated = placed.filter((x) => x.t !== null).sort((a, b) => a.t! - b.t! || a.i - b.i);
  const undated = placed.filter((x) => x.t === null);
  const out: Record<string, Verdict> = {};
  for (const l of limits) {
    let v: Verdict | null = null, at: number | null = null;
    for (const { s, t } of dated) {
      if (typeof s.says[l.id] !== "string") continue;
      const next = classify(s.says[l.id]);
      // Two sources on the same instant that disagree cannot be ordered: unknown (second review of WO-124c).
      v = at === t && v !== null && v !== next ? "unknown" : next;
      at = t;
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
