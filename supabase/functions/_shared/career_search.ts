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
import { ORGS } from "./person_claims.ts";

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
// Review of #790 (MAJOR), round 2. "frontend engineer san francisco or new york" searched "... san francisco york" and "... san new
// york": the two sides of an "or" were read one word each. The first fix read whole sides and broke what the one-word reading had
// right ("oracle or salesforce account executive"). The rule now: an alternative is the MINIMAL unit beside the "or":
//   a place the code knows ("new york", "st louis", "boston, ma", "remote"), an employer it knows (person_claims ORGS: "goldman
//   sachs"), a fixed compound ("part time", "new grad", "private equity", "summer 2027");
//   a whole role when both sides end in a role's head word ("data scientist or ml engineer");
//   beside a known unit, the unknown side up to the next head word, preposition, known unit or end ("san jose or remote", "jp morgan
//   or bank of america analyst");
//   else the one word (or hyphenated term) on each side, as before.
// Parentheses scope the alternatives to what is inside them. A preposition said again ("at X or at Y") is said once. Everything
// outside the alternatives is shared by every search. Each "or" group is crossed with the others; at most four searches run, chosen
// so every alternative is searched when four can cover them, and the combinations left out are returned (not_searched), never dropped.
// A job title's head word ("data SCIENTIST", "legal ASSISTANT"), and the generic or level words a title can be followed by.
const TITLE_HEAD = /^(?:analysts?|engineers?|developers?|scientists?|designers?|managers?|associates?|consultants?|researchers?|recruiters?|architects?|specialists?|coordinators?|administrators?|programmers?|accountants?|bankers?|traders?|doctors?|nurses?|practitioners?|physicians?|lawyers?|attorneys?|teachers?|executives?|assistants?|editors?|writers?|reporters?|directors?|technicians?|tellers?|officers?|generalists?|hygienists?|strategists?|copywriters?|paralegals?|pharmacists?|swe|sde)$/;
const ROLE_HEAD = { test: (w: string) => TITLE_HEAD.test(w) || /^(?:interns?|internships?|roles?|jobs?|positions?|openings?)$/.test(w) };
// The first word of a two-word city the place reader may not know ("san jose", "el paso", "new haven").
const CITY_FIRST = new Set(["san", "los", "las", "fort", "ft", "st", "saint", "el", "santa", "baton", "des", "palo", "ann", "new"]);
const OR_PREP = new Set(["in", "at", "for", "near", "with"]);
const COMPOUND = new Set(["part time", "full time", "new grad", "entry level", "mid level", "senior level", "investment banking", "private equity", "venture capital", "machine learning", "bay area", "site reliability", "middle school", "high school", "front end", "back end", "full stack"]);
const bare = (w: string) => w.toLowerCase().replace(/,$/, "");
const usPlace = (ph: string) => postingPlaces(ph.toLowerCase()).some((x) => x.country === "us" || !!x.state);
// The known unit at the end (or start) of a run of words: how many words it takes, 0 when the word beside the "or" is not known.
function knownUnit(ws: string[], end: boolean): number {
  const ph = (n: number) => (end ? ws.slice(-n) : ws.slice(0, n)).join(" "), low = (n: number) => ph(n).toLowerCase().replace(/,$/, "");
  for (const n of [3, 2].filter((k) => k <= ws.length)) {
    const p = low(n), w = p.split(" ");
    // "boston, ma" is a place; a comma anywhere else ("engineer, boston", "milwaukee, wi accountant") joins nothing.
    if (p.includes(",") ? /^[a-z .'-]+, [a-z]{2}$/.test(p) && usPlace(p) : usPlace(p) || ORGS.includes(p) || COMPOUND.has(p) || (n === 2 && /^(?:spring|summer|fall|autumn|winter) 20\d\d$/.test(p))) return n;
    if (n === 2 && !p.includes(",") && CITY_FIRST.has(w[0]) && /^[a-z]{3,}$/.test(w[1]) && !ROLE_HEAD.test(w[1])) return 2;
  }
  return ws.length && (isPlace(low(1)) || ORGS.includes(low(1))) ? 1 : 0;
}
const stops = (w: string) => ROLE_HEAD.test(bare(w)) || OR_PREP.has(bare(w)) || isPlace(bare(w)) || ORGS.includes(bare(w));
// The two alternatives of one "or": how many words to its left and to its right, and whether a repeated preposition is dropped.
function unitsOf(A: string[], B0: string[]): { l: number; r: number; skip: number } {
  const prep = B0.length > 1 && OR_PREP.has(bare(B0[0])), B = prep ? B0.slice(1) : B0;
  let l = knownUnit(A, true), r = knownUnit(B, false);
  const grow = (ws: string[], end: boolean) => { let n = 1; while (n < ws.length && !stops(end ? ws[ws.length - 1 - n] : ws[n])) n++; return n; };
  if (l && !r) r = grow(B, false);
  else if (r && !l) l = grow(A, true);
  else if (!l && !r) {
    const head = B.slice(0, 3).findIndex((w) => TITLE_HEAD.test(bare(w)));
    // Said in parallel: the same word before both ("cdl a or cdl b", "dental hygienist or dental assistant") or after both
    // ("night shift or day shift", "front end or back end") makes each side two words.
    if (A.length > 1 && B.length > 1 && (bare(A[A.length - 2]) === bare(B[0]) || bare(A[A.length - 1]) === bare(B[1]))) { l = 2; r = 2; }
    else if (TITLE_HEAD.test(bare(A[A.length - 1])) && head >= 0) {
      // Two whole roles: the left one back to a place, an employer or a preposition; the right one through its head word(s).
      r = head + 1; while (r < B.length && TITLE_HEAD.test(bare(B[r]))) r++;
      l = 1; while (l < A.length && !(OR_PREP.has(bare(A[A.length - 1 - l])) || isPlace(bare(A[A.length - 1 - l])) || ORGS.includes(bare(A[A.length - 1 - l])))) l++;
    } else { l = 1; r = 1; }
  }
  // A left alternative of several words that ends in a role's head word is a whole role, so the right one runs through its own head word too.
  if (l > 1 && TITLE_HEAD.test(bare(A[A.length - 1])) && !B.slice(0, r).some((w) => TITLE_HEAD.test(bare(w)))) { const h = B.slice(r, r + 2).findIndex((w) => TITLE_HEAD.test(bare(w))); if (h >= 0) r += h + 1; }
  // "at X or at Y": the second "at" is the first one said again; "remote or in denver": the "in" belongs to denver.
  const again = prep && A.length > l && bare(A[A.length - 1 - l]) === bare(B0[0]);
  return { l, r: prep && !again ? r + 1 : r, skip: again ? 1 : 0 };
}
export interface OrSearch { queries: string[]; groups: string[][]; not_searched: string[] }
// How many combinations search_jobs runs: each is one database read, in parallel, with no model call.
export const SEARCH_ALTERNATIVES_MAX = 9;
export function orSearch(query: unknown, max = 4): OrSearch {
  const q = String(query ?? "").replace(/\s+/g, " ").trim();
  const none: OrSearch = { queries: [q], groups: [], not_searched: [] };
  // Parts: shared text and groups of alternatives, in the order said.
  const parts: (string | string[])[] = [];
  const read = (text: string) => {
    const ws = text.replace(/\band\/or\b/gi, "or").split(" ").filter((w) => w && !/^either$/i.test(w)).filter((w, k, all) => !(/^or$/i.test(w) && k > 0 && /^or$/i.test(all[k - 1])));
    const ors = ws.map((w, k) => /^or$/i.test(w) && k > 0 && k < ws.length - 1 ? k : -1).filter((k) => k >= 0);
    let from = 0;
    for (let n = 0; n < ors.length; n++) {
      // One chain ("a or b or c"): each middle alternative is the whole run between its two "or"s.
      const group: string[] = [];
      let k = n, u = unitsOf(ws.slice(from, ors[k]), ws.slice(ors[k] + 1, ors[k + 1] ?? ws.length));
      parts.push(ws.slice(from, ors[k] - u.l).join(" "));
      group.push(ws.slice(ors[k] - u.l, ors[k]).join(" "));
      for (;;) {
        const next = ors[k + 1], mid = next === undefined ? [] : ws.slice(ors[k] + 1 + u.skip, next);
        const u2 = next === undefined ? null : unitsOf(mid, ws.slice(next + 1, ors[k + 2] ?? ws.length));
        if (u2 && mid.length <= 3 && (u.r >= mid.length || u2.l >= mid.length)) { group.push(mid.join(" ")); k++; u = u2; continue; }
        group.push(ws.slice(ors[k] + 1 + u.skip, ors[k] + 1 + u.skip + u.r).join(" "));
        from = ors[k] + 1 + u.skip + u.r;
        break;
      }
      parts.push(group);
      n = k;
    }
    parts.push(ws.slice(from).join(" "));
  };
  let rest = q;
  for (let m = /\(([^()]*\sor\s[^()]*)\)/i.exec(rest); m; m = /\(([^()]*\sor\s[^()]*)\)/i.exec(rest)) {
    read(rest.slice(0, m.index).trim());
    parts.push(m[1].split(/\s+or\s+/i).map((x) => x.trim()).filter(Boolean));
    rest = rest.slice(m.index + m[0].length).trim();
  }
  read(rest);
  const groups = parts.filter((p): p is string[] => Array.isArray(p)).map((g) => [...new Set(g)]);
  if (!groups.length || groups.some((g) => g.length < 2 || g.some((a) => !a))) return none;
  // Every combination, in the order said; four at most are searched, the ones that cover the most alternatives first.
  let combos: number[][] = [[]];
  for (const g of groups) combos = combos.flatMap((c) => g.map((_, k) => [...c, k]));
  const text = (c: number[]) => { let k = 0; return parts.map((p) => Array.isArray(p) ? groups[k][c[k++]] : p).filter(Boolean).join(" ").replace(/\s+/g, " ").trim(); };
  let picked = combos;
  if (combos.length > max) {
    picked = [];
    const seen = new Set<string>(), gain = (c: number[]) => c.filter((a, g) => !seen.has(`${g}:${a}`)).length;
    while (picked.length < max) {
      const best = combos.filter((c) => !picked.includes(c)).reduce((b, c) => gain(c) > gain(b) ? c : b);
      picked.push(best); best.forEach((a, g) => seen.add(`${g}:${a}`));
    }
  }
  return { queries: [...new Set(picked.map(text))], groups, not_searched: combos.filter((c) => !picked.includes(c)).map(text) };
}
export function orAlternatives(query: unknown): string[] { return orSearch(query).queries; }
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
