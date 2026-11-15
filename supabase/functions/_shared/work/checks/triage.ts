// Work artifacts, triage verdicts (spec WORK-ARTIFACTS.md, rule D9; pack case 0021). Each constraint gets one of three
// verdicts from the newest dated source that speaks to it. A hedge ("may be considered", "may sponsor") is never a
// promise, so it is unknown; an explicit refusal is conflict; only a plain commitment meets. "None actionable" is valid.
export type Verdict = "meets" | "unknown" | "conflict";
export type Limit = { id: string; text: string; kind: string };
export type Source = { source: string; date?: string; says: Record<string, string> };

const HEDGE = /\b(may|might|could|possibly|potentially|consider(ed)?|case[- ]by[- ]case|depend(s|ing)?|not guaranteed|tbd|unclear|open to)\b/i;
// A modal hedge keeps even a negative statement open ("may not sponsor" is not a refusal). "consider" is not modal:
// "do not consider" and "will not be considered" are refusals (review of WO-124c).
const MODAL = /\b(may|might|could|possibly|potentially|case[- ]by[- ]case|depend(s|ing)?|not guaranteed|tbd|unclear|open to)\b/i;
const REFUSAL = /\b(will not|won't|cannot|can't|can ?not|do(es)? not|don't|doesn't|unable|not able|not eligible|no longer|never|refuse[sd]?|not (offer|provide|support|sponsor|consider(ed)?)|no sponsorship|not available|excluded?)\b/i;
const COMMIT = /\b(will|does|do|yes|confirmed?|guarantee[sd]?|provides?|offers?|sponsors?|supports?|available|eligible|included|allowed|meets?)\b/i;
// A commitment with a carve-out ("sponsor H-1B but not OPT", "only for seniors", "except interns") does not say
// whether the person's case is inside it, so it is never meets; it is unknown until the person's case is matched.
const CARVE_OUT = /\b(but not|except|excluding|other than|only|unless|limited to|not for|\bnot\b)\b/i;

/** Classifies one statement about one constraint. */
export function classify(says: string): Verdict {
  const s = says.trim().toLowerCase();
  if (s === "meets" || s === "unknown" || s === "conflict") return s;
  if (REFUSAL.test(s) && !MODAL.test(s) && !COMMIT_THEN_CARVE.test(s)) return "conflict";
  if (HEDGE.test(s)) return "unknown";
  if (COMMIT.test(s) && !CARVE_OUT.test(s)) return "meets";
  return "unknown";
}
// "sponsors H-1B but does not sponsor OPT": a commitment then a refusal of part of it is a carve-out, not a refusal.
const COMMIT_THEN_CARVE = /\b(sponsors?|offers?|provides?|supports?|accepts?|allows?|will)\b.*\b(but|except|however)\b/i;

// A source's date as a time. ISO (2026-11-10, with or without a time) and month-name dates (Nov 10, 2026; 10 November
// 2026) are read; anything else is undated. Before, dates were compared as strings, so "Nov 10, 2026" sorted before
// "2026-11-01" and an older ad overrode a newer follow-up.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function dateOf(d?: string): number | null {
  const s = String(d ?? "").trim().toLowerCase();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2}))?(z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (m) {
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
  if (mi < 0 || !day || !yr || Number(day) < 1 || Number(day) > 31) return null;
  return Date.UTC(Number(yr), mi, Number(day));
}

/**
 * Verdict per constraint id. Dated sources are applied oldest to newest, so the newest dated source that speaks to a
 * constraint controls; ties keep input order. An undated (or unreadable) source cannot be placed in time: when it
 * disagrees with the dated verdict, the verdict is unknown, because either one might be the newer (fail closed).
 */
export function verdict(limits: Limit[], sources: Source[]): Record<string, Verdict> {
  const placed = sources.map((s, i) => ({ s, i, t: dateOf(s.date) }));
  const dated = placed.filter((x) => x.t !== null).sort((a, b) => a.t! - b.t! || a.i - b.i);
  const undated = placed.filter((x) => x.t === null);
  const out: Record<string, Verdict> = {};
  for (const l of limits) {
    let v: Verdict | null = null;
    for (const { s } of dated) if (typeof s.says[l.id] === "string") v = classify(s.says[l.id]);
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
