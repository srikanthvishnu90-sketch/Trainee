// CONTACT OUTREACH, release 9 workstream E (proposal D-042): the public sources a contact's professional facts come from.
// Behind CAREER_PEOPLE_SEARCH and CAREER_CONTACT_OUTREACH (career_contact_pipeline.ts contactOutreachOn); both off.
//
// Two doors, both polite, both behind the Fetcher seam (tests pass fixtures; nothing here calls fetch on its own):
//   pages  every web page goes through contact_sources/web_gate.ts WebGate: HTTPS only, public hosts only, robots.txt read
//          and obeyed (unreadable robots = no read), Crawl-delay or 2 s per host at least, no cookies, no redirect off host,
//          a login wall is a stop. The company's own domain (from the job post) and each page a discovery search returned
//          get a robots-governed rule (pageRule); SEC EDGAR keeps its reviewed rules (adapters/edgar.ts secRules).
//   apis   documented public JSON APIs (GitHub, OpenAlex, Semantic Scholar, USPTO PatentSearch) through PoliteApi: one
//          request per host at a time, the API's documented pace, a User-Agent naming Trainee with a contact address. An
//          API's own terms govern it (api.github.com's robots.txt disallows crawlers; its REST API is meant for programs).
// Never opened, by any door, on any country domain or TLD: LinkedIn, Indeed, Handshake, Glassdoor, ZipRecruiter, Google
// Scholar, Crunchbase, Common Crawl.
// A discovery search (workstream C's provider; career_people_provider.ts SearchFn) only proposes URLs to read; what it
// says is never evidence. Everything a page or an API returns is data: instruction-like text never becomes a fact
// (career_contact_facts.ts keepFacts).
import type { SearchFn } from "./career_people_provider.ts";
import { neverOpen } from "./career_people_sites.ts";
import { peopleOnPage } from "./career_people_page.ts";
import { isBlockedHost } from "./contact_sources/types.ts";
import { type Fetcher, type GateResult, type Resolver, type SiteRule, WebGate } from "./contact_sources/web_gate.ts";
import { parseCards, PRESETS } from "./contact_sources/adapters/pages.ts";
import { edgarInsiders, secRules } from "./contact_sources/adapters/edgar.ts";

export type DiscoverySearch = SearchFn; // workstream C's search provider plugs in here; discovery only, never evidence
export type SourceType = "company_page" | "personal_page" | "sec_edgar" | "github" | "openalex" | "semantic_scholar" | "uspto" | "conference" | "news";
// What a source hands the fact keeper: one claim, the page or API record it came from, the words that support it.
export interface RawFact { claim: string; source_url: string; source_type: SourceType; published_at: string | null; quote: string; method: string; confidence: number }
export interface FoundPerson { name: string; title: string; email: string | null; source_url: string; source_type: SourceType }
export interface SourceRun { source: string; status: "ok" | "none" | "denied" | "not_wired" | "error"; detail?: string }

// ------------------------------------------------------------------------------------------------ never, and the agent
// Each name is matched as a whole DNS label under ANY public suffix and at any depth, the way career_people_sites.ts
// neverOpen matches LinkedIn, Indeed and Handshake: glassdoor.co.uk, www.ziprecruiter.ca and crunchbase.co all refuse, and
// a look-alike that carries the label (glassdoor.com.evil.io) refuses too (it fails closed). Google Scholar is the label
// pair scholar.google on any suffix (scholar.google.co.uk, scholar.google.de); the rest of Google is not a never-source.
const NEVER_LABELS = new Set(["linkedin", "lnkd", "licdn", "indeed", "indeedemail", "indeedmail", "joinhandshake", "glassdoor", "ziprecruiter", "crunchbase", "commoncrawl"]);
export function neverSource(url: string): boolean {
  let h = ""; try { h = new URL(url).hostname.toLowerCase().replace(/\.$/, ""); } catch { return true; }
  const labels = h.split(".").filter(Boolean), named = labels.slice(0, -1); // every label but the last (the suffix's end)
  const scholar = named.some((l, i) => l === "scholar" && named[i + 1] === "google");
  return isBlockedHost(h) || neverOpen(h) || scholar || named.some((l) => NEVER_LABELS.has(l));
}
// The User-Agent every request carries: Trainee by name and a reachable contact (the owner sets CAREER_CONTACT_BOT_EMAIL).
export function contactUserAgent(contact: string | null | undefined): string {
  const e = String(contact ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)) throw new Error("CAREER_CONTACT_BOT_EMAIL: a contact address for the User-Agent is required");
  return `TraineeBot/1.0 (+https://trainee.chat/bot; contact ${e})`;
}

// ------------------------------------------------------------------------------------------------ pages
// A robots-governed rule for one host the pipeline was pointed at (the employer's own domain, or a page a search returned).
export function pageRule(host: string, org: string, o: { reviewedOn: string; delayMs?: number }): SiteRule {
  return { host: host.toLowerCase(), org_name: org, terms_url: `https://${host.toLowerCase()}/robots.txt`, terms_reviewed_on: o.reviewedOn,
    terms_reviewed_by: "robots.txt rule (D-042 proposal): public pages only, robots.txt obeyed per request",
    terms_summary: "Public pages read at a polite pace; robots.txt decides every path.", license_note: `Public page on ${host.toLowerCase()}; facts kept with their URL.`,
    min_delay_ms: Math.max(2000, o.delayMs ?? 2000) };
}
// The pipeline's gate: the hosts it was pointed at up front, plus pages found on the way (a discovery search's results, a
// GitHub profile's blog) admitted one host at a time through admit(): an https URL, never a never-source, an exact host
// (precheck still refuses IP literals and internal names), robots.txt per request, and only with a DNS resolver so every
// admitted host's answers are checked as public (WebGate.publicDns). Without a resolver nothing is admitted.
export class ContactGate extends WebGate {
  private admitted: SiteRule[] = [];
  constructor(o: ConstructorParameters<typeof WebGate>[0], private day: string, private canAdmit: boolean) { super(o); }
  override ruleFor(host: string): SiteRule | undefined { return super.ruleFor(host) ?? this.admitted.find((r) => r.host === host.toLowerCase()); }
  admit(urls: string[]): string[] {
    if (!this.canAdmit) return [];
    const added: string[] = [];
    for (const u of urls) {
      let h = ""; try { const x = new URL(u); if (x.protocol !== "https:") continue; h = x.hostname.toLowerCase(); } catch { continue; }
      if (!h || neverSource(`https://${h}/`) || this.ruleFor(h)) continue;
      this.admitted.push(pageRule(h, h, { reviewedOn: this.day })); added.push(h);
    }
    return added;
  }
}
export function contactGate(o: { fetcher: Fetcher; userAgent: string; domain: string; org: string; hosts?: string[]; now: () => number; sleep?: (ms: number) => Promise<void>; resolver?: Resolver }): ContactGate {
  const day = new Date(o.now()).toISOString().slice(0, 10);
  const apex = o.domain.toLowerCase().replace(/^www\./, "");
  const hosts = [...new Set([apex, `www.${apex}`, ...(o.hosts ?? []).map((h) => h.toLowerCase())])].filter((h) => !neverSource(`https://${h}/`));
  return new ContactGate({ allowlist: [...hosts.map((h) => pageRule(h, h.endsWith(apex) ? o.org : h, { reviewedOn: day })), ...secRules(day, "architect (EDGAR fair access)")],
    fetcher: o.fetcher, userAgent: o.userAgent, robotsToken: "TraineeBot", resolver: o.resolver, now: () => new Date(o.now()), sleep: o.sleep }, day, !!o.resolver);
}
// Pages found on the way are admitted to a ContactGate before they are read (any other gate reads only its own list).
export const admitFound = (gate: WebGate, urls: string[]) => (gate instanceof ContactGate ? gate.admit(urls) : []);
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
export const plain = (h: string) => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&(#?\w+);/g, (m, e) => ENT[e] ?? m).replace(/\s+/g, " ").trim();
const titleOf = (h: string) => plain(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h)?.[1] ?? "").slice(0, 120);
const mailtos = (h: string) => [...h.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => decodeURIComponent(m[1]).toLowerCase());
// The date a page says it was published: article:published_time, a JSON-LD datePublished, or the first <time datetime>.
export function publishedAt(h: string): string | null {
  const m = /property=["']article:published_time["'][^>]*content=["']([^"']+)/i.exec(h) ?? /"datePublished"\s*:\s*"([^"]+)"/.exec(h) ?? /<time[^>]*datetime=["']([^"']+)/i.exec(h);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
// Sentences of a page that name the person in full (never a sentence that only shares a surname).
export function sentencesNaming(text: string, name: string): string[] {
  const n = name.toLowerCase();
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 20 && s.toLowerCase().includes(n)).slice(0, 3);
}

export const COMPANY_PATHS = ["/team", "/about", "/about-us", "/leadership", "/about/leadership", "/company/leadership", "/company", "/newsroom", "/news", "/press"];
// The employer's own pages: the people they name (team cards, schema.org Person), every address the domain publishes
// (the learner needs 2+ for a pattern) and a fact for each page that names the person asked about.
export async function companyPages(gate: WebGate, domain: string, org: string): Promise<{ people: FoundPerson[]; addresses: { email: string; source_url: string }[]; pages: { url: string; html: string }[]; run: SourceRun }> {
  const people: FoundPerson[] = [], addresses: { email: string; source_url: string }[] = [], pages: { url: string; html: string }[] = [];
  let denied = 0;
  for (const p of COMPANY_PATHS) {
    const r: GateResult = await gate.fetchText(`https://${domain}${p}`);
    if (!r.ok) { denied++; continue; }
    pages.push({ url: r.final_url, html: r.text });
    for (const e of mailtos(r.text)) if (e.endsWith(`@${domain}`)) addresses.push({ email: e, source_url: r.final_url });
    for (const c of parseCards(r.text, PRESETS.team_page, r.final_url, r.retrieved_at, org, r.rule.license_note)) people.push({ name: c.full_name, title: c.role_title ?? "", email: c.email ?? null, source_url: r.final_url, source_type: "company_page" });
    for (const q of peopleOnPage(r.text).people) if (q.name) people.push({ name: q.name, title: q.title, email: q.email, source_url: r.final_url, source_type: "company_page" });
  }
  return { people, addresses, pages, run: { source: "company_pages", status: pages.length ? "ok" : denied ? "denied" : "none" } };
}
// A fact per sentence naming the person; news keeps its published date (keepFacts drops news without one, or too old).
export function pageFacts(pages: { url: string; html: string }[], name: string, type: SourceType): RawFact[] {
  const out: RawFact[] = [];
  for (const p of pages) {
    const at = publishedAt(p.html);
    const t = titleOf(p.html);
    for (const s of sentencesNaming(plain(p.html), name)) out.push({ claim: type === "news" ? `Mentioned in "${t}"` : s, source_url: p.url, source_type: type, published_at: at, quote: s, method: `${type} page read through robots`, confidence: type === "news" ? 0.7 : 0.85 });
  }
  return out;
}
export async function readPages(gate: WebGate, urls: string[]): Promise<{ pages: { url: string; html: string }[]; run: SourceRun }> {
  const pages: { url: string; html: string }[] = [];
  for (const u of urls) { if (neverSource(u)) continue; const r = await gate.fetchText(u); if (r.ok) pages.push({ url: r.final_url, html: r.text }); }
  return { pages, run: { source: "pages", status: pages.length ? "ok" : "none" } };
}
export async function speakerFacts(gate: WebGate, urls: string[], name: string): Promise<{ facts: RawFact[]; run: SourceRun }> {
  const facts: RawFact[] = [];
  for (const u of urls) {
    if (neverSource(u)) continue;
    const r = await gate.fetchText(u); if (!r.ok) continue;
    const hit = parseCards(r.text, PRESETS.conference_speakers, r.final_url, r.retrieved_at, null, r.rule.license_note).find((c) => c.full_name.toLowerCase() === name.toLowerCase());
    if (hit) facts.push({ claim: `Listed as a speaker at ${titleOf(r.text) || new URL(r.final_url).hostname}${hit.role_title ? ` (${hit.role_title})` : ""}`, source_url: r.final_url, source_type: "conference", published_at: publishedAt(r.text), quote: `${hit.full_name}${hit.role_title ? `, ${hit.role_title}` : ""}`, method: "speaker page card", confidence: 0.85 });
  }
  return { facts, run: { source: "conference", status: facts.length ? "ok" : "none" } };
}
export async function secOfficers(gate: WebGate, cik: string | null | undefined): Promise<{ people: FoundPerson[]; facts: (n: string) => RawFact[]; run: SourceRun }> {
  if (!cik) return { people: [], facts: () => [], run: { source: "sec_edgar", status: "none", detail: "no CIK: not a public company" } };
  try {
    const r = await edgarInsiders({ gate, cik, max: 5 });
    const people = r.candidates.map((c) => ({ name: c.full_name, title: c.role_title ?? "", email: null, source_url: c.provenance.source_url, source_type: "sec_edgar" as const }));
    const facts = (n: string) => r.candidates.filter((c) => c.full_name.toLowerCase() === n.toLowerCase()).slice(0, 1).map((c) => ({ claim: `Named as ${c.role_title ?? "an insider"} of ${c.firm ?? "the company"} in an SEC insider filing`, source_url: c.provenance.source_url, source_type: "sec_edgar" as const, published_at: null, quote: `${c.full_name}, ${c.role_title ?? ""}`.slice(0, 200), method: "SEC EDGAR Form 3/4/5", confidence: 0.95 }));
    return { people, facts, run: { source: "sec_edgar", status: people.length ? "ok" : "none" } };
  } catch (e) { return { people: [], facts: () => [], run: { source: "sec_edgar", status: "error", detail: String((e as Error).message).slice(0, 120) } }; }
}

// ------------------------------------------------------------------------------------------------ apis
export interface ApiRule { host: string; terms_url: string; min_delay_ms: number; key_header?: string }
export const API_RULES = {
  github: { host: "api.github.com", terms_url: "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api", min_delay_ms: 1000 },
  openalex: { host: "api.openalex.org", terms_url: "https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication", min_delay_ms: 200 },
  semantic_scholar: { host: "api.semanticscholar.org", terms_url: "https://www.semanticscholar.org/product/api/license", min_delay_ms: 1100 },
  uspto: { host: "search.patentsview.org", terms_url: "https://search.patentsview.org/docs/", min_delay_ms: 1500, key_header: "X-Api-Key" },
} as const satisfies Record<string, ApiRule>;
export type ApiName = keyof typeof API_RULES;
export type ApiOut = { ok: true; data: any; url: string; retrieved_at: string } | { ok: false; reason: "not_wired" | "http_error" | "fetch_error" | "bad_json" | "redirect_denied"; detail?: string };
export class PoliteApi {
  private last = new Map<string, number>();
  private queue = new Map<string, Promise<void>>();
  constructor(private o: { fetcher: Fetcher; userAgent: string; now: () => number; sleep?: (ms: number) => Promise<void>; keys?: Partial<Record<ApiName, string | null>> }) {}
  private pace(name: ApiName): Promise<void> {
    const gap = API_RULES[name].min_delay_ms;
    const run = async () => {
      const prev = this.last.get(name);
      if (prev != null) { const wait = prev + gap - this.o.now(); if (wait > 0) await (this.o.sleep ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m))))(wait); }
      this.last.set(name, this.o.now());
    };
    const next = (this.queue.get(name) ?? Promise.resolve()).then(run, run);
    this.queue.set(name, next.catch(() => {}));
    return next;
  }
  async json(name: ApiName, path: string): Promise<ApiOut> {
    const rule: ApiRule = API_RULES[name];
    const key = rule.key_header ? this.o.keys?.[name] ?? null : null;
    if (rule.key_header && !key) return { ok: false, reason: "not_wired", detail: `${name} needs the owner's free API key` };
    const url = `https://${rule.host}${path}`;
    await this.pace(name);
    const headers: Record<string, string> = { "User-Agent": this.o.userAgent, Accept: "application/json" };
    if (rule.key_header && key) headers[rule.key_header] = key;
    try {
      const r = await this.o.fetcher(url, { headers, redirect: "manual" });
      if (r.status >= 300 && r.status < 400) return { ok: false, reason: "redirect_denied" };
      if (r.status !== 200) return { ok: false, reason: "http_error", detail: String(r.status) };
      try { return { ok: true, data: JSON.parse(r.text), url, retrieved_at: new Date(this.o.now()).toISOString() }; } catch { return { ok: false, reason: "bad_json" }; }
    } catch (e) { return { ok: false, reason: "fetch_error", detail: String((e as Error).message).slice(0, 120) }; }
  }
}
// The same name or organisation: equal once case, punctuation, a leading @ and legal suffixes are set aside (never a
// substring: "Acme" is not "Acme Analytics", "Jane Doe" is not "Jane Doe-Smith").
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/^@/, "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|sa)\b\.?/g, "").replace(/[^a-z0-9]+/g, "");
const same = (a: unknown, b: unknown) => !!norm(a) && norm(a) === norm(b);
// A host on the company's domain: the domain itself or a subdomain of it (never acme.io.other.org for acme.io).
export const onDomainHost = (host: string, domain: string) => { const h = host.toLowerCase().replace(/\.$/, ""), d = domain.toLowerCase(); return !!d && (h === d || h.endsWith(`.${d}`)); };
const blogOn = (v: unknown, domain: string) => { const t = String(v ?? "").trim(); if (!t) return false; try { return onDomainHost(new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`).hostname, domain); } catch { return false; } };
// An address on the company's domain (or a subdomain of it): the only GitHub email that can name the recipient.
export const emailOn = (v: unknown, domain: string) => { const m = /^[^\s@]+@([^\s@]+)$/.exec(String(v ?? "").trim()); return !!m && onDomainHost(m[1], domain); };
const enc = encodeURIComponent;

// GitHub: a profile counts only when it says it is this person at this company (company field, or a blog/email on the
// company's domain). Its email is used only as the person published it on the profile (no commit mining, ever), and only
// when it is on the company's own domain (emailOn): anyone can make a profile with the person's name and "@Acme" in its
// company field, so the company field alone never vouches for an address; the profile's facts say where they came from.
export async function githubFacts(api: PoliteApi, name: string, company: string, domain: string): Promise<{ facts: RawFact[]; email: { email: string; source_url: string } | null; blog: string | null; run: SourceRun }> {
  const s = await api.json("github", `/search/users?q=${enc(`${name} in:name`)}&per_page=3`);
  if (!s.ok) return { facts: [], email: null, blog: null, run: { source: "github", status: s.reason === "not_wired" ? "not_wired" : "error", detail: s.detail } };
  for (const it of (s.data?.items ?? []).slice(0, 3)) {
    const login = String(it?.login ?? ""); if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) continue;
    const p = await api.json("github", `/users/${login}`); if (!p.ok) continue;
    const u = p.data ?? {};
    if (!same(u.name, name) || !(same(u.company, company) || blogOn(u.blog, domain) || emailOn(u.email, domain))) continue;
    const url = `https://github.com/${login}`;
    const facts: RawFact[] = [];
    if (u.company) facts.push({ claim: `GitHub profile lists ${String(u.company).replace(/^@/, "")} as employer`, source_url: url, source_type: "github", published_at: null, quote: String(u.company), method: "GitHub REST users API", confidence: 0.8 });
    if (u.bio) facts.push({ claim: `GitHub bio: ${String(u.bio).slice(0, 160)}`, source_url: url, source_type: "github", published_at: null, quote: String(u.bio), method: "GitHub REST users API", confidence: 0.75 });
    const repos = await api.json("github", `/users/${login}/repos?sort=pushed&per_page=5`);
    if (repos.ok) for (const r of (Array.isArray(repos.data) ? repos.data : []).filter((r: any) => !r?.fork).slice(0, 3)) {
      facts.push({ claim: `Maintains the ${r.name} repository on GitHub${r.stargazers_count ? ` (${r.stargazers_count} stars)` : ""}${r.description ? `: ${String(r.description).slice(0, 100)}` : ""}`, source_url: String(r.html_url ?? url), source_type: "github", published_at: r.pushed_at ?? null, quote: String(r.description ?? r.name), method: "GitHub REST repos API", confidence: 0.8 });
    }
    const email = typeof u.email === "string" && emailOn(u.email, domain) ? { email: u.email.trim().toLowerCase(), source_url: url } : null;
    return { facts, email, blog: typeof u.blog === "string" && /^https:\/\//.test(u.blog) ? u.blog : null, run: { source: "github", status: "ok" } };
  }
  return { facts: [], email: null, blog: null, run: { source: "github", status: "none" } };
}
export async function openAlexFacts(api: PoliteApi, name: string, company: string): Promise<{ facts: RawFact[]; run: SourceRun }> {
  const a = await api.json("openalex", `/authors?search=${enc(name)}&per-page=5`);
  if (!a.ok) return { facts: [], run: { source: "openalex", status: "error", detail: a.reason } };
  const au = (a.data?.results ?? []).find((x: any) => same(x?.display_name, name) && (x?.last_known_institutions ?? x?.affiliations?.map((y: any) => y.institution) ?? []).some((i: any) => same(i?.display_name, company)));
  if (!au) return { facts: [], run: { source: "openalex", status: "none" } };
  const id = String(au.id ?? "").split("/").pop() ?? "";
  const w = await api.json("openalex", `/works?filter=author.id:${enc(id)}&sort=publication_date:desc&per-page=5`);
  const facts: RawFact[] = (w.ok ? w.data?.results ?? [] : []).slice(0, 4).map((x: any) => ({ claim: `Co-authored "${String(x.title ?? x.display_name).slice(0, 140)}"${x.publication_year ? ` (${x.publication_year})` : ""}`, source_url: String(x.doi ?? x.id), source_type: "openalex" as const, published_at: x.publication_date ?? null, quote: String(x.title ?? x.display_name).slice(0, 200), method: "OpenAlex works API", confidence: 0.85 }));
  return { facts, run: { source: "openalex", status: facts.length ? "ok" : "none" } };
}
export async function semanticScholarFacts(api: PoliteApi, name: string, company: string): Promise<{ facts: RawFact[]; run: SourceRun }> {
  const a = await api.json("semantic_scholar", `/graph/v1/author/search?query=${enc(name)}&fields=name,affiliations,url,papers.title,papers.year,papers.venue,papers.url&limit=5`);
  if (!a.ok) return { facts: [], run: { source: "semantic_scholar", status: "error", detail: a.reason } };
  const au = (a.data?.data ?? []).find((x: any) => same(x?.name, name) && (x?.affiliations ?? []).some((y: unknown) => same(y, company)));
  if (!au) return { facts: [], run: { source: "semantic_scholar", status: "none" } };
  const facts: RawFact[] = (au.papers ?? []).slice(0, 3).map((p: any) => ({ claim: `Published "${String(p.title).slice(0, 140)}"${p.venue ? ` at ${String(p.venue).slice(0, 60)}` : ""}${p.year ? ` (${p.year})` : ""}`, source_url: String(p.url ?? au.url), source_type: "semantic_scholar" as const, published_at: p.year ? `${p.year}-01-01T00:00:00.000Z` : null, quote: String(p.title).slice(0, 200), method: "Semantic Scholar graph API", confidence: 0.8 }));
  return { facts, run: { source: "semantic_scholar", status: facts.length ? "ok" : "none" } };
}
export async function patentFacts(api: PoliteApi, name: string, company: string): Promise<{ facts: RawFact[]; run: SourceRun }> {
  const parts = name.trim().split(/\s+/); const last = parts.pop() ?? ""; const first = parts[0] ?? "";
  const q = JSON.stringify({ _and: [{ "inventors.inventor_name_last": last }, { "inventors.inventor_name_first": first }, { _contains: { "assignees.assignee_organization": company } }] });
  const r = await api.json("uspto", `/api/v1/patent/?q=${enc(q)}&f=${enc(JSON.stringify(["patent_id", "patent_title", "patent_date"]))}&o=${enc(JSON.stringify({ size: 5 }))}`);
  if (!r.ok) return { facts: [], run: { source: "uspto", status: r.reason === "not_wired" ? "not_wired" : "error", detail: r.detail ?? r.reason } };
  const facts: RawFact[] = (r.data?.patents ?? []).slice(0, 3).map((p: any) => ({ claim: `Named inventor on US patent ${p.patent_id}, "${String(p.patent_title).slice(0, 140)}"`, source_url: `https://patents.google.com/patent/US${p.patent_id}`, source_type: "uspto" as const, published_at: p.patent_date ? new Date(p.patent_date).toISOString() : null, quote: String(p.patent_title).slice(0, 200), method: "USPTO PatentSearch API", confidence: 0.9 }));
  return { facts, run: { source: "uspto", status: facts.length ? "ok" : "none" } };
}

// ------------------------------------------------------------------------------------------------ discovery
// URLs a search proposes for a person: speaker pages and news, never a never-source. Only the URLs are used.
export async function discover(search: DiscoverySearch | null | undefined, name: string, company: string): Promise<{ speakers: string[]; news: string[]; run: SourceRun }> {
  if (!search) return { speakers: [], news: [], run: { source: "discovery", status: "not_wired" } };
  const speakers: string[] = [], news: string[] = [];
  for (const [q, into] of [[`"${name}" "${company}" speaker`, speakers], [`"${name}" "${company}"`, news]] as const) {
    const r = await search(q);
    if (r.status !== "ok") return { speakers, news, run: { source: "discovery", status: r.status === "not_wired" ? "not_wired" : "error" } };
    for (const u of r.urls.map((x) => x.url)) if (/^https:\/\//.test(u) && !neverSource(u) && !into.includes(u)) into.push(u);
  }
  return { speakers: speakers.slice(0, 5), news: news.slice(0, 8), run: { source: "discovery", status: "ok" } };
}
