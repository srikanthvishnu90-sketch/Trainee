// Search-parameter eval (2026-10-28, owner requirement): when a person says "SWE internship Chicago summer 2027", the agent
// must FIND matching postings and every parameter they stated (role, place or remote, level, pay, company, visa, term)
// must constrain what comes back. Deterministic: no model, no network, no spend. The code under test is the production
// chat path: the real router parse (CareerRouter.handleChat -> discovery.lastParams), askFromRouter, and searchJudgeTurn
// (judge off) over an in-memory SearchSources that behaves like the live board (every word must match) and the snapshot.
// The postings are invented fixtures (search-params/fixtures.ts) with ground truth the code never sees.
//   deno run -A --no-check evals/career/search-params.ts [--json out.json] [--verbose]
// A case passes when (a) zero returned postings violate a stated parameter and (b) it returns min(3, relevant) of the
// postings that satisfy every parameter (when none exist, an empty answer is the pass).
import { CareerRouter, CareerJobs } from "../../supabase/functions/_shared/router_core.career.js";
import { CareerPool } from "../../supabase/functions/_shared/career_pool.js";
import * as Judge from "../../supabase/functions/_shared/career_search_judge.ts";
import type { SearchSources, SourcePosting } from "../../supabase/functions/_shared/career_search_judge.ts";
const { askFromRouter, searchJudgeTurn } = Judge, askFor = (Judge as any).askFor as undefined | ((m: string, o: unknown, d: unknown) => { ask: any; append: boolean } | null); // askFor is absent before 2026-10-28: the baseline then uses the router's parse alone
import { statedBand } from "../../supabase/functions/_shared/posting_constraints.ts";
import { matchesWords } from "../../supabase/functions/_shared/career_ingest.ts";
import { type Band, FIXTURES, type Fam, type Fx, type Meta } from "./search-params/fixtures.ts";

export interface Want {
  fam?: Fam[]; band?: Band[]; city?: string; country?: Meta["country"]; remote?: "only" | "ok"; payMinHr?: number; payMinYr?: number;
  company?: string; needsSponsor?: boolean; term?: string; title?: RegExp;
}
export interface Case { id: string; say: string; want: Want }
const HR = 2080;
export const CASES: Case[] = [
  { id: "c01", say: "I want a software engineering internship", want: { fam: ["swe"], band: ["intern"] } },
  { id: "c02", say: "SWE internship Chicago summer 2027", want: { fam: ["swe"], band: ["intern"], city: "chicago", term: "summer 2027" } },
  { id: "c03", say: "find me software engineering internships in New York for summer 2027", want: { fam: ["swe"], band: ["intern"], city: "new york", term: "summer 2027" } },
  { id: "c04", say: "remote data analyst, $30+/hr", want: { title: /analyst/i, fam: ["data"], remote: "only", payMinHr: 30 } },
  { id: "c05", say: "new grad backend, no sponsorship needed", want: { title: /backend/i, fam: ["swe"], band: ["new_grad", "junior"] } },
  { id: "c06", say: "find me new grad backend engineer jobs, I need visa sponsorship", want: { title: /backend/i, fam: ["swe"], band: ["new_grad", "junior"], needsSponsor: true } },
  { id: "c07", say: "find me data analyst jobs in Chicago", want: { title: /analyst/i, fam: ["data"], city: "chicago" } },
  { id: "c08", say: "find me data analyst jobs in Chicago paying at least $100k", want: { title: /analyst/i, fam: ["data"], city: "chicago", payMinYr: 100000 } },
  { id: "c09", say: "find me software engineer roles at Stripe", want: { fam: ["swe"], company: "stripe" } },
  { id: "c10", say: "find software engineer roles at Stripe in Toronto", want: { fam: ["swe"], company: "stripe", city: "toronto" } },
  { id: "c11", say: "find me remote software engineer internships", want: { fam: ["swe"], band: ["intern"], remote: "only" } },
  { id: "c12", say: "find me senior software engineer jobs in Chicago", want: { fam: ["swe"], band: ["senior"], city: "chicago" } },
  { id: "c13", say: "find me junior data analyst roles remote in Canada", want: { title: /analyst/i, fam: ["data"], band: ["junior"], remote: "only", country: "ca" } },
  { id: "c14", say: "find me data analyst jobs in London", want: { title: /analyst/i, fam: ["data"], city: "london" } },
  { id: "c15", say: "entry level data analyst jobs in Chicago, not senior", want: { title: /analyst/i, fam: ["data"], band: ["junior", "new_grad"], city: "chicago" } },
  { id: "c16", say: "find me nursing jobs in Chicago over $40 an hour", want: { title: /nurse/i, fam: ["nurse"], city: "chicago", payMinHr: 40 } },
  { id: "c17", say: "SWE intern fall 2027 Austin", want: { fam: ["swe"], band: ["intern"], city: "austin", term: "fall 2027" } },
  { id: "c18", say: "find me product manager internships for summer 2027", want: { fam: ["pm"], band: ["intern"], term: "summer 2027" } },
  { id: "c19", say: "find me remote machine learning internships for summer 2027", want: { fam: ["ml"], band: ["intern"], remote: "only", term: "summer 2027" } },
  { id: "c20", say: "new grad software engineer jobs in San Francisco, I will need sponsorship", want: { fam: ["swe"], band: ["new_grad", "junior"], city: "san francisco", needsSponsor: true } },
  { id: "c21", say: "find me remote backend engineer jobs paying $140k or more", want: { title: /backend/i, fam: ["swe"], remote: "only", payMinYr: 140000 } },
  { id: "c22", say: "find me software engineering internships paying at least $50 an hour", want: { fam: ["swe"], band: ["intern"], payMinHr: 50 } },
  { id: "c23", say: "investment banking summer analyst 2027 in New York", want: { fam: ["finance"], band: ["intern"], city: "new york", term: "summer 2027" } },
  { id: "c24", say: "find me software engineering jobs in Seattle", want: { fam: ["swe"], city: "seattle" } },
  { id: "c25", say: "data analyst internship in Chicago, summer 2027, $25/hr or more", want: { title: /analyst/i, fam: ["data"], band: ["intern"], city: "chicago", term: "summer 2027", payMinHr: 25 } },
  { id: "c26", say: "find me software engineer roles in Berlin", want: { fam: ["swe"], city: "berlin" } },
  { id: "c27", say: "find me software engineer jobs in Chicago or remote", want: { fam: ["swe"], city: "chicago", remote: "ok" } },
  { id: "c28", say: "find me software engineering internships in Chicago", want: { fam: ["swe"], band: ["intern"], city: "chicago" } },
  // Phrasings written after the fixes, not tuned against: lowercase, abbreviations, no job noun, a place with nothing there.
  { id: "c29", say: "software engineer jobs near austin", want: { fam: ["swe"], city: "austin" } },
  { id: "c30", say: "swe new grad nyc", want: { fam: ["swe"], band: ["new_grad", "junior"], city: "new york" } },
  { id: "c31", say: "i'm looking for a remote ml internship, summer 2027, at least $45/hr", want: { fam: ["ml"], band: ["intern"], remote: "only", term: "summer 2027", payMinHr: 45 } },
  { id: "c32", say: "any remote data engineer openings paying 150k+", want: { fam: ["dataeng"], remote: "only", payMinYr: 150000 } },
  { id: "c33", say: "software engineering internships in Boston", want: { fam: ["swe"], band: ["intern"], city: "boston" } },
  { id: "c34", say: "can you find product designer jobs that are remote", want: { fam: ["design"], remote: "only" } },
  { id: "c35", say: "show me registered nurse jobs in Evanston", want: { fam: ["nurse"], city: "evanston" } },
  { id: "c36", say: "senior backend engineer, remote, $200k or more", want: { title: /backend/i, band: ["senior"], remote: "only", payMinYr: 200000 } },
];

// True when a level was asked for and the posting's own text states none (the fixture's ground-truth band is not shown to the code under test).
export const unstatedLevel = (f: Fx, w: Want) => !!w.band && statedBand(f.title, f.text) === "unstated";
// Why a posting violates a stated parameter ("" = it does not). Unknown facts never violate: only what the posting states.
// `levelStated` false: the posting's text states no level, so the level is not graded (reported as unstated-level kept instead).
export function violation(m: Meta, w: Want, levelStated = true): string {
  if (w.fam && !w.fam.includes(m.fam)) return `role: ${m.fam}`;
  if (w.title && !w.title.test(m.title)) return `role: ${m.title}`;
  if (levelStated && w.band && !w.band.includes(m.band)) return `level: ${m.band}`;
  if (w.company && m.company.toLowerCase() !== w.company) return `company: ${m.company}`;
  if (w.remote === "only" && m.remote !== "remote") return `not remote: ${m.remote}`;
  if (w.country && m.country !== w.country) return `country: ${m.country}`;
  if (w.city && !(w.remote === "ok" && m.remote === "remote") && m.city !== w.city) return `place: ${m.city || m.remote}`;
  if (w.payMinHr != null && ((m.payHr != null && m.payHr < w.payMinHr) || ((m.payYrMax ?? m.payYr) != null && (m.payYrMax ?? m.payYr)! < w.payMinHr * HR))) return `pay below ${w.payMinHr}/hr`;
  if (w.payMinYr != null && (((m.payYrMax ?? m.payYr) != null && (m.payYrMax ?? m.payYr)! < w.payMinYr) || (m.payHr != null && m.payHr * HR < w.payMinYr))) return `pay below ${w.payMinYr}/yr`;
  if (w.needsSponsor && m.sponsors === "no") return "does not sponsor";
  if (w.term && m.term && m.term !== w.term) return `term: ${m.term}`;
  return "";
}

const NOW = Date.parse("2026-10-28T12:00:00Z"), DAY = 86400000;
const jobs = { roleFamily: CareerJobs.roleFamily, seniorityBand: CareerJobs.seniorityBand, stripHtml: CareerJobs.stripHtml };
const url = (f: Fx) => `https://boards.example.test/${f.id.split(":").join("/")}`;
const seen = (f: Fx) => new Date(NOW - f.ageDays * DAY).toISOString();
const rowOf = (f: Fx) => CareerPool.mapKbPosting({ posting_key: f.id, title: f.title, company: f.company, location: f.location, url: url(f), text_excerpt: f.text, source: "greenhouse", posted_at: seen(f), fetched_on: "2026-10-28" }, jobs);
const live = (f: Fx): SourcePosting => ({ job_id: f.id, company: f.company, title: f.title, location: f.location, url: url(f), description: f.text, first_seen_at: seen(f), closed_at: null });
const sources: SearchSources = {
  async live(words, limit) { return FIXTURES.filter((f) => matchesWords({ title: f.title, company: f.company, location: f.location, description: f.text }, words)).slice(0, limit).map(live); },
  async liveHasRows() { return true; },
  async snapshot(roleWords, place, limit) {
    return FIXTURES.filter((f) => roleWords.every((w) => f.title.toLowerCase().includes(w)) && (!place || f.location.toLowerCase().includes(place.toLowerCase()))).slice(0, limit).map(live);
  },
};
const metaOf = new Map(FIXTURES.map((f) => [f.id, f.meta]));

export interface CaseResult { id: string; say: string; route: string; parsed: unknown; via: string; returned: string[]; violations: string[]; unstatedKept: string[]; relevant: number; found: number; pass: boolean; why: string }
export async function runCase(c: Case): Promise<CaseResult> {
  const ctx: any = { now: NOW, postings: FIXTURES.map(rowOf), profile: null };
  const out: any = CareerRouter.handleChat(c.say, ctx);
  // The handler's order (agent-chat/handler-career.ts): the router's own search first, else a search the message states.
  const ask = askFor ? askFor(c.say, out, ctx.discovery)?.ask ?? null : askFromRouter(c.say, out, ctx.discovery);
  let ids: string[] = [], via = "router";
  if (ask) {
    const r = await searchJudgeTurn({ message: c.say, ask, userId: "eval", now: NOW, profile: null, sources, judge: { on: false } });
    if (r) { ids = r.shortlist.map((s) => String(s.id)); via = "search"; }
  }
  if (via === "router") ids = (out?.shortlist ?? []).map((s: any) => String(s.id));
  ids = ids.filter((id) => metaOf.has(id));
  const fxOf = new Map(FIXTURES.map((f) => [f.id, f]));
  const stated = (id: string) => !unstatedLevel(fxOf.get(id)!, c.want);
  // Returned postings whose text states no level while one was asked for, and whose ground-truth level differs: kept by rule, reported so the leak is visible.
  const unstatedKept = ids.filter((id) => !stated(id) && !c.want.band!.includes(metaOf.get(id)!.band)).map((id) => `${metaOf.get(id)!.company} ${metaOf.get(id)!.title} (is ${metaOf.get(id)!.band})`);
  const violations = ids.map((id) => ({ id, v: violation(metaOf.get(id)!, c.want, stated(id)) })).filter((x) => x.v).map((x) => `${metaOf.get(x.id)!.company} ${FIXTURES.find((f) => f.id === x.id)!.title} (${x.v})`);
  const rel = new Set(FIXTURES.filter((f) => !violation(f.meta, c.want)).map((f) => f.id));
  const found = ids.filter((id) => rel.has(id)).length, need = Math.min(3, rel.size);
  const pass = violations.length === 0 && found >= need;
  const why = violations.length ? `${violations.length} violate: ${violations.slice(0, 2).join("; ")}` : found < need ? `found ${found} of ${need} needed (${rel.size} satisfy everything)` : "";
  return { id: c.id, say: c.say, route: String(out?.intent ?? "none"), parsed: ctx.discovery?.lastParams ? { role: ctx.discovery.lastParams.roleText, where: ctx.discovery.lastParams.whereText, remote: ctx.discovery.lastParams.remote } : null, via: ask ? via : `${via}(no ask)`, returned: ids, violations, unstatedKept, relevant: rel.size, found, pass, why };
}
export async function runAll(cases = CASES) {
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runCase(c));
  const passed = results.filter((r) => r.pass).length;
  const returned = results.reduce((a, r) => a + r.returned.length, 0), bad = results.reduce((a, r) => a + r.violations.length, 0);
  const recall = results.filter((r) => r.relevant).reduce((a, r) => a + Math.min(1, r.found / Math.min(3, r.relevant)), 0) / results.filter((r) => r.relevant).length;
  const unstatedKept = results.flatMap((r) => r.unstatedKept.map((u) => `${r.id} ${u}`));
  return { results, passed, total: results.length, returned, violating: bad, unstatedKept, recall };
}

if (import.meta.main) {
  const o = await runAll();
  for (const r of o.results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.id} [${r.route}/${r.via}] "${r.say}"${r.pass ? "" : `\n       ${r.why}`}${Deno.args.includes("--verbose") ? `\n       parsed ${JSON.stringify(r.parsed)} returned ${r.returned.length}` : ""}`);
  console.log(`\nsearch-params: ${o.passed}/${o.total} cases pass; ${o.violating} of ${o.returned} returned postings violate a stated parameter; ${o.unstatedKept.length} kept with the level not stated; mean recall@3 ${(o.recall * 100).toFixed(0)}%`);
  if (o.unstatedKept.length) console.log("unstated-level kept (posting text states no level; not counted as a violation):\n  " + o.unstatedKept.join("\n  "));
  const j = Deno.args.indexOf("--json");
  if (j >= 0) await Deno.writeTextFile(Deno.args[j + 1], JSON.stringify(o, null, 1) + "\n");
}
