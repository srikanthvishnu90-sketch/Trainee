// CONTACT OUTREACH (proposal D-043), the pipeline: from a job post to one professional at that company, their public
// professional facts (up to 25, each cited) and their work address with its evidence score. Nothing here drafts, shows or
// sends anything (career_contact_send.ts does, after the person approves the exact email).
//   contactOutreachOn   CAREER_PEOPLE_SEARCH and CAREER_CONTACT_OUTREACH, both: off unless the owner turns both on.
//   domainOf            the company's own domain from the job post (never an ATS or job board host).
//   resolveContact      company pages and SEC EDGAR for the person; GitHub, OpenAlex, Semantic Scholar, USPTO, speaker
//                       pages and the last 24 months of news for facts; findEmail for the address.
//   ContactStore        kept per person (career_contact_profiles / _facts / _email_evidence, 20261107120200), erasable
//                       ("forget"), expiring; the suppression list is global (career_contact_suppression).
import { releaseFlagOn } from "../agent-chat/release_config.ts";
import { registrable } from "./career_people_gmail.ts";
import type { MxResolver } from "./career_contacts.ts";
import type { WebGate } from "./contact_sources/web_gate.ts";
import {
  admitFound, companyPages, discover, type DiscoverySearch, type FoundPerson, githubFacts, neverSource, openAlexFacts, pageFacts, patentFacts, type PoliteApi,
  type RawFact, readPages, secOfficers, semanticScholarFacts, type SourceRun, speakerFacts,
} from "./career_contact_sources.ts";
import { type ContactFact, FACT_TTL_DAYS, keepFacts } from "./career_contact_facts.ts";
import { type EmailEvidence, findEmail, type Finder, type RcptProbe } from "./career_contact_email.ts";

type Env = { get(k: string): string | undefined };
export const contactOutreachOn = (env: Env) => releaseFlagOn(env, "CAREER_PEOPLE_SEARCH") && releaseFlagOn(env, "CAREER_CONTACT_OUTREACH");
// D-048 option (a), architect amendment (2026-11-10): CAREER_CONTACT_OUTREACH alone puts an email on a card and sends it,
// but only to a recipient the person supplied or confirmed (supplied_by "person": an address they typed, or a person on a
// page they gave). A contact the pipeline found itself (supplied_by "search", the default) also needs CAREER_PEOPLE_SEARCH,
// and resolution, people search and web search stay behind CAREER_PEOPLE_SEARCH whatever the recipient.
export type SuppliedBy = "search" | "person";
export const contactAskOn = (env: Env) => releaseFlagOn(env, "CAREER_CONTACT_OUTREACH");
export const contactSendOn = (env: Env, suppliedBy: unknown) => contactAskOn(env) && (suppliedBy === "person" || releaseFlagOn(env, "CAREER_PEOPLE_SEARCH"));

// Every applicant-tracking system and job board a posting link can sit on: a link on one of these says nothing about the
// employer (acme.teamtailor.com is Teamtailor's host), so no domain comes from it.
const ATS = ["greenhouse.io", "greenhouse-mail.io", "lever.co", "ashbyhq.com", "myworkdayjobs.com", "myworkday.com", "workday.com", "smartrecruiters.com",
  "icims.com", "jobvite.com", "bamboohr.com", "workable.com", "workablemail.com", "recruitee.com", "breezy.hr", "taleo.net", "successfactors.com",
  "successfactors.eu", "jazzhr.com", "rippling.com", "dover.com", "wellfound.com", "teamtailor.com", "personio.de", "personio.com", "pinpointhq.com",
  "applytojob.com", "avature.net", "paylocity.com", "ultipro.com", "eightfold.ai", "phenompeople.com", "brassring.com", "dayforcehcm.com", "oraclecloud.com",
  "adp.com", "gem.com", "join.com", "gupy.io", "welcomekit.co", "softgarden.io", "builtin.com", "remoteok.com", "weworkremotely.com", "dice.com",
  "monster.com", "simplyhired.com", "careerbuilder.com", "ycombinator.com", "otta.com", "hired.com", "jobs.ashbyhq.com", "amazon.jobs"];
export function domainOf(post: { company_url?: string | null; url?: string | null; apply_url?: string | null }): string | null {
  for (const u of [post.company_url, post.url, post.apply_url]) {
    let h = ""; try { h = new URL(String(u ?? "")).hostname.toLowerCase(); } catch { continue; }
    if (!h || neverSource(`https://${h}/`) || ATS.some((a) => h === a || h.endsWith(`.${a}`))) continue;
    return registrable(h).full;
  }
  return null;
}

export interface Person { name: string; title: string; company: string; domain: string; source_url: string; source_type: FoundPerson["source_type"]; supplied_by?: SuppliedBy }
export interface Resolved { ok: true; person: Person; facts: ContactFact[]; dropped: { why: string; claim: string }[]; email: EmailEvidence; runs: SourceRun[]; expires_at: string }
export type ResolveOut = Resolved | { ok: false; why: "no_domain" | "no_person"; runs: SourceRun[] };
export interface ResolveDeps { gate: WebGate; api: PoliteApi; mx: MxResolver; now: () => number; search?: DiscoverySearch | null; probe?: RcptProbe; finder?: Finder | null }
export interface ResolveAsk { company: string; domain: string | null; name?: string | null; title?: string | null; cik?: string | null; employees?: number | null; speakerUrls?: string[]; newsUrls?: string[] }

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
function pick(people: FoundPerson[], ask: ResolveAsk): FoundPerson | null {
  const named = people.filter((p) => p.name && p.name.split(/\s+/).length >= 2);
  if (ask.name) return named.find((p) => p.name.toLowerCase() === ask.name!.trim().toLowerCase()) ?? null;
  if (!ask.title) return null; // no name and no role: nobody is picked for the person
  const want = words(ask.title);
  return named.map((p) => ({ p, n: words(p.title).filter((w) => want.includes(w)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n)[0]?.p ?? null;
}

export async function resolveContact(ask: ResolveAsk, d: ResolveDeps): Promise<ResolveOut> {
  const runs: SourceRun[] = [];
  if (!ask.domain) return { ok: false, why: "no_domain", runs };
  const now = d.now(), domain = ask.domain.toLowerCase();
  const site = await companyPages(d.gate, domain, ask.company); runs.push(site.run);
  const sec = await secOfficers(d.gate, ask.cik); runs.push(sec.run);
  const who = pick([...site.people, ...sec.people], ask);
  if (!who) return { ok: false, why: "no_person", runs };
  const raw: RawFact[] = [];
  raw.push({ claim: `${who.title ? `${who.title} at ${ask.company}` : `Works at ${ask.company}`}`, source_url: who.source_url, source_type: who.source_type, published_at: null, quote: `${who.name}${who.title ? `, ${who.title}` : ""}`, method: who.source_type === "sec_edgar" ? "SEC EDGAR Form 3/4/5" : "company page card", confidence: 0.95 });
  raw.push(...pageFacts(site.pages, who.name, "company_page"), ...sec.facts(who.name));
  const gh = await githubFacts(d.api, who.name, ask.company, domain); runs.push(gh.run); raw.push(...gh.facts);
  if (gh.blog) { admitFound(d.gate, [gh.blog]); const own = await readPages(d.gate, [gh.blog]); raw.push(...pageFacts(own.pages, who.name, "personal_page")); }
  for (const f of [openAlexFacts, semanticScholarFacts, patentFacts]) { const r = await f(d.api, who.name, ask.company); runs.push(r.run); raw.push(...r.facts); }
  const found = await discover(d.search, who.name, ask.company); runs.push(found.run);
  admitFound(d.gate, [...(ask.speakerUrls ?? []), ...found.speakers, ...(ask.newsUrls ?? []), ...found.news]); // found pages: robots-governed, public DNS only
  const sp = await speakerFacts(d.gate, [...(ask.speakerUrls ?? []), ...found.speakers], who.name); runs.push(sp.run); raw.push(...sp.facts);
  const news = await readPages(d.gate, [...(ask.newsUrls ?? []), ...found.news]); runs.push({ ...news.run, source: "news" });
  raw.push(...pageFacts(news.pages, who.name, "news"));
  const kept = keepFacts(raw, { now, employers: [ask.company] }); // the employer's own name is professional (Parish Medical Center)
  const named = [...site.people.filter((p) => p.email).map((p) => ({ email: p.email!, name: p.name }))];
  const published = site.people.filter((p) => p.email && p.name.toLowerCase() === who.name.toLowerCase()).map((p) => ({ email: p.email!, source_url: p.source_url }));
  const email = await findEmail({ name: who.name, domain, now, published, github: gh.email, domainNamed: named, employees: ask.employees, mx: d.mx, probe: d.probe, finder: d.finder });
  return { ok: true, person: { name: who.name, title: who.title, company: ask.company, domain, source_url: who.source_url, source_type: who.source_type }, facts: kept.facts, dropped: kept.dropped,
    email, runs, expires_at: new Date(now + FACT_TTL_DAYS * 86400_000).toISOString() };
}

// ------------------------------------------------------------------------------------------------ the store
export interface ContactStore {
  save(userId: string, c: Resolved): Promise<string>;
  get(userId: string, id: string): Promise<(Resolved & { id: string }) | null>;
  forget(userId: string, id?: string | null): Promise<number>;
  suppressed(emails: string[]): Promise<Set<string>>;
  suppress(email: string, reason: string): Promise<void>;
}
export const emailHash = async (e: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(e.trim().toLowerCase())))].map((b) => b.toString(16).padStart(2, "0")).join("");
export function memoryContactStore(): ContactStore & { rows(): Map<string, Resolved & { id: string; user_id: string }> } {
  const m = new Map<string, Resolved & { id: string; user_id: string }>(), sup = new Map<string, string>();
  return {
    rows: () => m,
    async save(u, c) { const id = crypto.randomUUID(); m.set(id, { ...structuredClone(c), id, user_id: u }); return id; },
    async get(u, id) { const r = m.get(id); return r && r.user_id === u ? r : null; },
    async forget(u, id) { let n = 0; for (const [k, r] of m) if (r.user_id === u && (!id || k === id)) { m.delete(k); n++; } return n; },
    async suppressed(es) { const out = new Set<string>(); for (const e of es) if (sup.has(await emailHash(e))) out.add(e.toLowerCase()); return out; },
    async suppress(e, why) { sup.set(await emailHash(e), why); },
  };
}
// Over the service role: one RPC per call, one jsonb argument p (20261107120200_career_contact_outreach.sql); service only.
export function supabaseContactStore(admin: { rpc: (f: string, a: { p: unknown }) => PromiseLike<{ data: any; error: any }> }): ContactStore {
  const call = async (f: string, a: any) => { const r = await admin.rpc(f, a); if (r.error) throw new Error(`${f}: ${r.error.message ?? r.error}`); return r.data; };
  return {
    async save(u, c) { return String(await call("career_contact_save", { p: { user: u, person: c.person, facts: c.facts, email: c.email, expires_at: c.expires_at } })); },
    async get(u, id) { const r = await call("career_contact_get", { p: { user: u, id } }); return r ? { ok: true, dropped: [], runs: [], ...r } : null; },
    async forget(u, id) { return Number(await call("career_contact_forget", { p: { user: u, id: id ?? null } })); },
    async suppressed(es) { const hs = await Promise.all(es.map(emailHash)); const hit: string[] = (await call("career_contact_suppressed", { p: { hashes: hs } })) ?? []; return new Set(es.filter((_, i) => hit.includes(hs[i])).map((e) => e.toLowerCase())); },
    async suppress(e, why) { await call("career_contact_suppress", { p: { hash: await emailHash(e), reason: why } }); },
  };
}
