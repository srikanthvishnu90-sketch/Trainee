// Work artifacts, triage verdicts (spec WORK-ARTIFACTS.md, rule D9; pack case 0021). Each constraint gets one of three
// verdicts from the newest dated source that speaks to it. A hedge ("may be considered", "may sponsor") is never a
// promise, so it is unknown; an explicit refusal is conflict; only a plain commitment meets. "None actionable" is valid.
export type Verdict = "meets" | "unknown" | "conflict";
export type Limit = { id: string; text: string; kind: string };
export type Source = { source: string; date?: string; says: Record<string, string> };

const HEDGE = /\b(may|might|could|possibly|potentially|consider(ed)?|case[- ]by[- ]case|depend(s|ing)?|not guaranteed|tbd|unclear|open to)\b/i;
const REFUSAL = /\b(will not|won't|cannot|can't|can ?not|do(es)? not|don't|doesn't|unable|not able|not eligible|no longer|never|refuse[sd]?|not (offer|provide|support|sponsor)|no sponsorship|not available|excluded?)\b/i;
const COMMIT = /\b(will|does|do|yes|confirmed?|guarantee[sd]?|provides?|offers?|sponsors?|supports?|available|eligible|included|allowed|meets?)\b/i;

/** Classifies one statement about one constraint. */
export function classify(says: string): Verdict {
  const s = says.trim().toLowerCase();
  if (s === "meets" || s === "unknown" || s === "conflict") return s;
  if (HEDGE.test(s)) return "unknown";
  if (REFUSAL.test(s)) return "conflict";
  if (COMMIT.test(s)) return "meets";
  return "unknown";
}

/** Verdict per constraint id. Newer dated sources override older ones; undated sources rank oldest; ties keep input order. */
export function verdict(limits: Limit[], sources: Source[]): Record<string, Verdict> {
  const ordered = sources.map((s, i) => ({ s, i })).sort((a, b) =>
    (a.s.date ?? "").localeCompare(b.s.date ?? "") || a.i - b.i
  );
  const out: Record<string, Verdict> = {};
  for (const l of limits) {
    let v: Verdict = "unknown";
    for (const { s } of ordered) if (typeof s.says[l.id] === "string") v = classify(s.says[l.id]);
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
