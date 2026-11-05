// Job search over real postings (WO-006): filter by the query's words, then rank by fit to the person's CONFIRMED facts
// (CareerJobs.scoreFit, 121, through the router's scoring-profile adapter), then newest first. A posting the person is
// knocked out of (a license, a clearance, a degree their confirmed facts don't show) is not hidden: it ranks last and
// carries the reason, so the agent can say what is missing instead of pretending the job doesn't exist.
import { CareerJobs, CareerProfile, CareerRouter } from "./router_core.career.js";
import { matchesWords, searchWords, titleTier, wordStem } from "./career_ingest.ts";
import { payFrom } from "./posting_pay.ts";
import { formUrlFor } from "./posting_key.ts";
import { personalSourceGuard } from "./personal_fact_source.ts";
import { dupKeys, isInternPosting, parseSearchQuery, placeFit, postingLevel, postingStatus, postingTerms, type Term } from "./career_search_query.ts";

export interface Fit { score: number | null; bucket: string | null; excluded: boolean; reasons: string[]; gaps: string[] }
export interface SearchHit { job_id: string; company: string; title: string; location: string; url: string; first_seen_at: string | null; fit: Fit | null; pay: string | null; role_match: boolean }

// WO-106 (F3, live 2026-10-21: results ignored the goal the bot had saved): the person's goal, from their account, as words
// to rank by. Said-but-unconfirmed goals count: ranking sends nothing anywhere, so D-007's confirmation is not needed for it.
export interface Goal { roles: string[]; places: string[]; remote: boolean }
const GOAL_FILLER = new Set(["want", "wants", "looking", "role", "roles", "job", "jobs", "position", "work", "based", "live", "living", "move", "moving", "now", "in", "at", "near", "around", "the", "my", "a", "an", "i", "im", "am", "get", "find", "new", "next", "career"]);
const goalWords = (t: unknown) => searchWords(t).filter((w) => !GOAL_FILLER.has(w));
export function goalOf(profile: any): Goal | null {
  const sourceDenied = personalSourceGuard([profile]);
  if (sourceDenied(profile)) return null;
  const p = profile ?? {}, pref = sourceDenied(p.preferences) ? {} : p.preferences ?? {};
  const basics = sourceDenied(p.basics) ? {} : p.basics ?? {};
  const facts: any[] = (Array.isArray(p.facts) ? p.facts : []).filter((f: any) =>
    f && typeof f === "object" && !Array.isArray(f) && typeof f.text === "string" && !!f.text.trim() &&
    f.status !== "rejected" && !sourceDenied(f));
  // A goal said in one breath ("senior data analyst role in Chicago or remote"): the role before "in", the place after.
  const goals = facts.filter((f) => f?.kind === "goal").map((f) => String(f.text ?? "").split(/\b(?:in|near|around|based in|based out of|located in)\b/i));
  const roles = [...new Set([...(pref.roles ?? []), ...goals.map((g) => g[0])].flatMap(goalWords))].filter((w) => w !== "remote");
  const places = [...new Set([...(pref.locations ?? []), basics.location, ...goals.map((g) => g.slice(1).join(" ")), ...facts.filter((f) => f?.kind === "location").map((f) => f.text)].flatMap(goalWords))]
    .filter((w) => w !== "remote" && w !== "or" && w !== "and");
  const remote = /remote/i.test(String(pref.remote ?? "")) || facts.some((f) => (f?.kind === "goal" || f?.kind === "location" || f?.kind === "preference") && /\bremote\b/i.test(String(f.text)));
  return roles.length || places.length || remote ? { roles, places, remote } : null;
}
// How well a posting meets the goal: each goal role word in its title, then its place (or remote, when they want remote).
export function goalScore(p: any, g: Goal | null): number {
  if (!g) return 0;
  const title = searchWords(p?.title).map(wordStem), loc = String(p?.location ?? "").toLowerCase();
  const role = g.roles.filter((w) => title.includes(wordStem(w))).length;
  const place = g.places.some((w) => loc.includes(w)) || (g.remote && /remote/.test(loc)) ? 1 : 0;
  return role * 2 + place;
}

export function scoringProfileFor(profile: any): any | null {
  const confirmed = profile ? CareerProfile.confirmedFacts(profile) : [];
  if (!confirmed.length) return null;
  const sp: Record<string, unknown> = CareerRouter.scoringProfile({ ...profile, facts: confirmed });
  // Years of experience are known only from dated experience facts. "3 years at Acme" said in chat has no dates, and the
  // router's adapter would count it as 0, so a fit line would say "your profile is 0 yrs experience" to someone with
  // three. Unknown stays unknown: seniority and minimum-years knockouts then do not fire.
  if (!confirmed.some((f: any) => f.kind === "experience" && /\d{4}-\d{2}/.test(String(f.start || "")))) delete sp.experience_years;
  return sp;
}

export function fitOf(p: any, sp: any): Fit {
  const posting = {
    job_id: p.job_id, company: p.company, title: p.title || "", location: p.location || "", jd_text: p.description || "",
    role_family: p.role_family || CareerJobs.roleFamily(p.title || "", p.description || ""),
    seniority_band: p.seniority_band || CareerJobs.seniorityBand(p.title || "", p.description || ""),
    remote: p.remote || (/\bremote\b/i.test(p.location || "") ? "remote" : /\bhybrid\b/i.test(p.location || "") ? "hybrid" : "onsite"),
    department: p.department || "", posted_at: p.posted_at || null,
  };
  const f = CareerJobs.scoreFit(posting, sp);
  return { score: f.score, bucket: f.bucket, excluded: !!f.excluded, reasons: (f.reasons || []).slice(0, 4), gaps: (f.gaps || []).slice(0, 3) };
}

// How a posting's own stated term sits against the term asked: 0 states it, 1 states none (or only an unsure one that
// differs), 2 its TITLE states another (never offered). Review 2026-11-05: the term is the posting's own (career_search_query.ts
// postingTerms), never a graduation or eligibility line, and a term read from the description only ranks, never hides.
function termRank(p: any, want: Term | null): 0 | 1 | 2 {
  if (!want) return 0;
  const { terms, sure } = postingTerms(p);
  if (!terms.length) return 1;
  if (terms.some((t) => (want.year === null || t.year === want.year) && (!want.season || t.season === want.season))) return 0;
  return sure ? 2 : 1;
}
export interface SearchOpts { now?: number }
export function searchPostings(pool: any[], query: unknown, profile: any, limit = 10, opts: SearchOpts = {}): { postings: SearchHit[]; total: number; title_matches: number; ranked_by: "goal" | "fit" | "newest"; goal: Goal | null; screened?: Record<string, number>; duplicates?: number; asked?: { level: string | null; places: string[]; term: Term | null } } {
  // SEARCH COVERAGE (career_search_query.ts): the sentence is read as role words + level + place + term. Level and place are
  // filters; a term filters only against a posting that states another; closed / past-term / scam postings are not offered;
  // one job listed twice is offered once.
  const pq = parseSearchQuery(query), words = pq.roleWords, now = opts.now ?? Date.now();
  const screened: Record<string, number> = {};
  const rank = new Map<any, { place: number; term: number }>();
  const matched = pool.filter((p) => {
    if (!p || p.closed_at || !matchesWords(p, words)) return false;
    const sv = postingStatus(p, now);
    if (!sv.open) { screened[sv.reason] = (screened[sv.reason] ?? 0) + 1; return false; }
    if (pq.level === "intern" && !isInternPosting(p)) return false;
    if (pq.level === "new_grad") { const lv = postingLevel(p); if (lv === "senior" || lv === "intern") return false; }
    const pf = placeFit(p.location, pq.places, pq.remote);
    if (pf === "no") return false;
    const tr = termRank(p, pq.term);
    if (tr === 2) return false;
    rank.set(p, { place: pf === "yes" ? 0 : 1, term: tr });
    return true;
  });
  // WO-073: the role first. While any title carries a query word, a posting that only mentions the words elsewhere is not
  // offered; every word in the title ranks above some of them; fit and then newest order postings within a tier.
  const anyTitle = matched.some((p) => titleTier(p, words) < 2);
  const hits = anyTitle ? matched.filter((p) => titleTier(p, words) < 2) : matched;
  const sp = scoringProfileFor(profile), goal = goalOf(profile);
  let scored: any[] = hits.map((p) => ({ p, tier: titleTier(p, words), fit: sp ? fitOf(p, sp) : null, goal: goalScore(p, goal) }));
  const newest = (a: any, b: any) => String(b.p.first_seen_at || "").localeCompare(String(a.p.first_seen_at || ""));
  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const ra = rank.get(a.p)!, rb = rank.get(b.p)!;
    if (ra.place !== rb.place) return ra.place - rb.place;
    if (ra.term !== rb.term) return ra.term - rb.term;
    if (a.goal !== b.goal) return b.goal - a.goal;
    if (a.fit && b.fit) {
      if (a.fit.excluded !== b.fit.excluded) return a.fit.excluded ? 1 : -1;
      const d = (b.fit.score ?? -1) - (a.fit.score ?? -1);
      if (d) return d;
    }
    return newest(a, b);
  });
  // The same job twice (one posting id, or one link that carries an id): the better-ranked row is kept.
  const seenKeys = new Set<string>(), uniq: any[] = [];
  for (const x of scored) { const ks = dupKeys(x.p); if (ks.some((k) => seenKeys.has(k))) continue; ks.forEach((k) => seenKeys.add(k)); uniq.push(x); }
  const duplicates = scored.length - uniq.length;
  scored = uniq;
  const n = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
  return {
    // WO-068: the pay the posting itself states (posting_pay.ts), or null: never an estimate.
    // WO-106 (run 39538248995 called a Credit Risk Analyst one of "two that match" a senior data analyst search): whether the
    // title itself is the role asked for (every role word of the query, or of their goal, in the title), so a related role
    // is said to be related.
    postings: scored.slice(0, n).map(({ p, fit, tier }) => ({ job_id: p.job_id, company: p.company, title: p.title, location: p.location || "", url: p.url || formUrlFor(String(p.job_id ?? "")) || "", first_seen_at: p.first_seen_at ?? null, fit, pay: p.pay ?? payFrom(p.description),
      role_match: goal && goal.roles.length ? goal.roles.every((w) => searchWords(p.title).map(wordStem).includes(wordStem(w))) : tier === 0 })),
    total: scored.length, ...(Object.keys(screened).length ? { screened } : {}), ...(duplicates ? { duplicates } : {}),
    asked: { level: pq.level, places: pq.places.map((x) => x.label), term: pq.term }, title_matches: scored.filter((x) => x.tier === 0).length, ranked_by: goal ? "goal" : sp ? "fit" : "newest",
    goal: goal ? { roles: goal.roles, places: goal.places, remote: goal.remote } : null,
  };
}
