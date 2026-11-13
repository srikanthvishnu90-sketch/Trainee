// Job search over real postings (WO-006): filter by the query's words, then rank by fit to the person's CONFIRMED facts
// (CareerJobs.scoreFit, 121, through the router's scoring-profile adapter), then newest first. A posting the person is
// knocked out of (a license, a clearance, a degree their confirmed facts don't show) is not hidden: it ranks last and
// carries the reason, so the agent can say what is missing instead of pretending the job doesn't exist.
import { CareerJobs, CareerProfile, CareerRouter } from "./router_core.career.js";
import { matchesWords, searchWords, titleTier, wordStem } from "./career_ingest.ts";
import { placedPay } from "./posting_pay.ts";
import { postingPlaces } from "./posting_place.ts";
import { formUrlFor } from "./posting_key.ts";
import { personalSourceGuard } from "./personal_fact_source.ts";

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

// D6: how many postings this isolate has really scored (121 scoreFit through fitOf), logged on the turn's agent_chat_cpu line
// as scored_n (a count, never content). A cache hit is not a score.
let scoredCount = 0;
export const scoredN = () => scoredCount;
// D6: one turn's scores. Made by the caller per turn (never module-level, so nothing crosses people) and keyed by the scoring
// profile's own content, so a cache filled for one profile is never read for another. A posting asked twice in one turn
// (the agent's tool loop searches again) is scored once.
export interface FitCache { byProfile: Map<string, Map<string, Fit>> }
export const newFitCache = (): FitCache => ({ byProfile: new Map() });
const postingKey = (p: any) => `${p?.job_id ?? ""}\u0001${p?.title ?? ""}\u0001${p?.location ?? ""}\u0001${p?.company ?? ""}\u0001${String(p?.description ?? "").length}\u0001${p?.role_family ?? ""}\u0001${p?.seniority_band ?? ""}\u0001${p?.remote ?? ""}`;

export function fitOf(p: any, sp: any, cache?: Map<string, Fit>): Fit {
  const key = cache ? postingKey(p) : "";
  if (cache) { const hit = cache.get(key); if (hit) return hit; }
  const fit = scoreOne(p, sp);
  if (cache) cache.set(key, fit);
  return fit;
}
function scoreOne(p: any, sp: any): Fit {
  scoredCount++;
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

export function searchPostings(pool: any[], query: unknown, profile: any, limit = 10, cache?: FitCache): { postings: SearchHit[]; total: number; title_matches: number; ranked_by: "goal" | "fit" | "newest"; goal: Goal | null } {
  const words = searchWords(query);
  const matched = pool.filter((p) => p && !p.closed_at && matchesWords(p, words));
  // WO-073: the role first. While any title carries a query word, a posting that only mentions the words elsewhere is not
  // offered; every word in the title ranks above some of them; fit and then newest order postings within a tier.
  const anyTitle = matched.some((p) => titleTier(p, words) < 2);
  const hits = anyTitle ? matched.filter((p) => titleTier(p, words) < 2) : matched;
  const sp = scoringProfileFor(profile), goal = goalOf(profile);
  let fits: Map<string, Fit> | undefined;
  if (cache && sp) { const k = JSON.stringify(sp); fits = cache.byProfile.get(k); if (!fits) cache.byProfile.set(k, fits = new Map()); }
  const scored = hits.map((p) => ({ p, tier: titleTier(p, words), fit: sp ? fitOf(p, sp, fits) : null, goal: goalScore(p, goal) }));
  const newest = (a: any, b: any) => String(b.p.first_seen_at || "").localeCompare(String(a.p.first_seen_at || ""));
  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.goal !== b.goal) return b.goal - a.goal;
    if (a.fit && b.fit) {
      if (a.fit.excluded !== b.fit.excluded) return a.fit.excluded ? 1 : -1;
      const d = (b.fit.score ?? -1) - (a.fit.score ?? -1);
      if (d) return d;
    }
    return newest(a, b);
  });
  const n = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
  return {
    // WO-068: the pay the posting itself states (posting_pay.ts), or null: never an estimate.
    // WO-106 (run 39538248995 called a Credit Risk Analyst one of "two that match" a senior data analyst search): whether the
    // title itself is the role asked for (every role word of the query, or of their goal, in the title), so a related role
    // is said to be related.
    postings: scored.slice(0, n).map(({ p, fit, tier }) => ({ job_id: p.job_id, company: p.company, title: p.title, location: p.location || "", url: p.url || formUrlFor(String(p.job_id ?? "")) || "", first_seen_at: p.first_seen_at ?? null, fit, pay: p.pay ?? placedPay(p.description, p.location),
      role_match: goal && goal.roles.length ? goal.roles.every((w) => searchWords(p.title).map(wordStem).includes(wordStem(w))) : tier === 0 })),
    total: hits.length, title_matches: scored.filter((x) => x.tier === 0).length, ranked_by: goal ? "goal" : sp ? "fit" : "newest",
    goal: goal ? { roles: goal.roles, places: goal.places, remote: goal.remote } : null,
  };
}

// D-070 (live-7 C1, C3: "SWE internship in Chicago or remote" returned only the Chicago posting): every word of a search must
// match, so "chicago or remote" asked for postings in Chicago AND remote, found none, and the relaxed search dropped "remote".
// Words joined by "or" are alternatives: the search runs once per alternative ("... chicago", "... remote") and the results
// are merged, each posting once, taking from each alternative in turn so one place never crowds out the other.
export function orAlternatives(query: unknown): string[] {
  const q = String(query ?? "").replace(/\s+/g, " ").trim();
  const m = /(?:^|\s)((?:[\w+#.-]+\s+or\s+)+[\w+#.-]+)(?=\s|$)/i.exec(q);
  if (!m) return [q];
  const opts = m[1].split(/\s+or\s+/i).map((x) => x.trim()).filter(Boolean);
  if (opts.length < 2) return [q];
  const at = q.indexOf(m[1]);
  return [...new Set(opts.map((o) => `${q.slice(0, at)}${o}${q.slice(at + m[1].length)}`.replace(/\s+/g, " ").trim()))].slice(0, 4);
}
// D-073 (live-9 C1, C3: the person's goal is "Chicago or remote", the brain searched "software engineer intern summer 2027 Chicago
// remote", one query with no "or", so D-071's per-place search never ran and NVIDIA's remote posting was not returned): the places
// the person joined with "or" (in this message, or in their goal on record) stay alternatives whatever the model's query did with
// them. A query that names two or more of them without "or" names them as alternatives ("... Chicago or remote"); a query that names
// one of a pair the person said in this message gets the other ("... Chicago" -> "... Chicago or remote"). Nothing else changes.
const words = (t: string) => t.toLowerCase().match(/[a-z][a-z.'-]*/g) ?? [];
const OR_SKIP = new Set(["either", "this", "that", "more", "less", "something", "anything", "else", "not", "so", "now", "later", "sooner", "one", "two", "both"]);
function orPairs(text: string, known: string[] = []): string[][] {
  const out: string[][] = [];
  for (const m of String(text ?? "").matchAll(/((?:[A-Za-z][\w.'-]*\s+){0,1}[A-Za-z][\w.'-]*)\s+or\s+([A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*)?)/g)) {
    const l = words(m[1]), r = words(m[2]);
    if (!l.length || !r.length) continue;
    // Only places are alternatives ("internships in chicago or should I wait" joins a place and a question, never two places):
    // each side must hold a place by the code's own reading of places, and only those places are kept.
    const L = [l.slice(-2).join(" "), l.slice(-1)[0]].filter((x): x is string => !!x && !OR_SKIP.has(x) && isPlace(x, known));
    const R = [r.slice(0, 2).join(" "), r[0]].filter((x): x is string => !!x && !OR_SKIP.has(x) && isPlace(x, known));
    if (L.length && R.length) out.push([...L, ...R]);
  }
  return out;
}
// A place as the code already reads one: "remote", a place on the person's goal (goalOf), or a city, state or country the posting
// place reader knows (posting_place.ts postingPlaces: a US city or state, a place abroad). Any other word is not a place.
function isPlace(ph: string, known: string[] = []): boolean {
  const w = ph.toLowerCase().trim();
  return w === "remote" || known.includes(w) || postingPlaces(w).some((x) => !!x.country || !!x.state);
}
const hasPhrase = (q: string, ph: string) => new RegExp(`(?<![a-z])${ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`, "i").test(q);
export function placeAlternatives(query: unknown, message: unknown, profile: any = null): string {
  const q = String(query ?? "").replace(/\s+/g, " ").trim();
  if (!q || /\sor\s/i.test(q)) return q;
  const goal = goalOf(profile);
  const goalTexts = (Array.isArray(profile?.facts) ? profile.facts : []).filter((f: any) => f?.kind === "goal" && f.status !== "rejected" && typeof f.text === "string").map((f: any) => f.text as string);
  // The place groups: each "X or Y" the person said (this message first, then their goal), and the goal's places with remote.
  const known = goal?.places ?? [];
  const said = orPairs(String(message ?? ""), known);
  const groups: { phrases: string[]; fromMessage: boolean }[] = [...said.map((g) => ({ phrases: g, fromMessage: true })), ...goalTexts.flatMap((t: string) => orPairs(t, known)).map((g: string[]) => ({ phrases: g, fromMessage: false })),
    ...(goal && goal.remote && goal.places.length ? [{ phrases: [...goal.places, "remote"], fromMessage: false }] : [])];
  for (const g of groups) {
    // One-word places only: orAlternatives reads "X or Y" word by word.
    const inQ = [...new Set(g.phrases.filter((ph) => !ph.includes(" ") && hasPhrase(q, ph)))].filter((ph, _k, all) => !all.some((o) => o !== ph && o.includes(ph)));
    if (inQ.length >= 2 && !g.phrases.some((ph) => ph.includes(" ") && hasPhrase(q, ph))) {
      // Every named place goes; the first one's spot holds them all, joined by "or".
      const first = inQ.map((ph) => ({ ph, at: q.toLowerCase().search(new RegExp(`(?<![a-z])${ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`)) })).sort((a, b) => a.at - b.at);
      let out = q;
      for (const x of first.slice(1)) out = out.replace(new RegExp(`\\s*(?<![a-z])${x.ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`, "i"), "");
      return out.replace(new RegExp(`(?<![a-z])(${first[0].ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![a-z])`, "i"), `$1 or ${first.slice(1).map((x) => x.ph).join(" or ")}`).replace(/\s+/g, " ").trim();
    }
    if (inQ.length === 1 && g.fromMessage && !g.phrases.some((ph) => ph.includes(" ") && hasPhrase(q, ph))) {
      const other = g.phrases.find((ph) => !inQ[0].includes(ph) && !ph.includes(inQ[0]) && ph.split(" ").length === 1 && !hasPhrase(q, ph));
      if (other) return q.replace(new RegExp(`(?<![a-z])(${inQ[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![a-z])`, "i"), `$1 or ${other}`);
    }
  }
  return q;
}
export function searchAlternatives(pool: any[], alts: string[], profile: any, limit = 10, cache?: FitCache): ReturnType<typeof searchPostings> {
  const each = alts.map((a) => searchPostings(pool, a, profile, limit, cache));
  if (each.length === 1) return each[0];
  const seen = new Set<string>(), postings: SearchHit[] = [];
  for (let k = 0; postings.length < limit && each.some((r) => k < r.postings.length); k++) {
    for (const r of each) { const p = r.postings[k]; if (p && !seen.has(String(p.job_id)) && postings.length < limit) { seen.add(String(p.job_id)); postings.push(p); } }
  }
  const all = new Set(each.flatMap((r) => r.postings.map((p) => String(p.job_id))));
  return { ...each[0], postings, total: Math.max(all.size, ...each.map((r) => r.total)), title_matches: each.reduce((n, r) => n + r.title_matches, 0) };
}
