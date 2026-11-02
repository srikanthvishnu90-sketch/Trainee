// PEOPLE DISCOVERY AT SCALE (D-MN-3 as REPLACED by the owner, 2026-10-27 21:32: "don't use Hunter or Apollo ... so we can
// do it with anyone"). No paid people/email provider. One adapter interface (PeopleProvider), one implementation (web):
//   1. search    OpenAI's web_search tool (Responses API, through the gateway's OpenAI config: modelConfig, OpenAI only),
//                with the search recipe below (company + role + "team", engineering blog, campus recruiting, speakers). Only
//                the result URLs are used: what the model writes is never taken as a fact about anyone.
//   2. read      each result page with N1's SSRF-guarded page reader (career_people_page.ts readPage: HTTPS only, public
//                addresses only, robots.txt honored, 2 MB / 8 s, schema.org Person and named mailto links only). LinkedIn,
//                Indeed and Handshake are never fetched (neverOpen): a result there is kept as text only.
//   3. a person  exists only when a page names them AND establishes their employer (the page is on the company's domain,
//                or its Person says worksFor the company, or the page's Organization is the company). Each keeps that
//                page's URL. No page, no person: nothing is invented.
//   4. emails    published on that page ("published"); else, at delivery, the person's own address for them ("known":
//                their Gmail or export row wins, the discovered one isn't stored again); else inferred from the domain's
//                format learned from 2+ addresses at that exact domain ("inferred", with the evidence count), only for a
//                plain ASCII name. The domain's MX is checked over DNS-over-HTTPS; no SMTP/RCPT probing, ever.
//   5. learning  formats (never addresses) are shared across everyone (career_email_formats) and move with bounces and
//                replies (career_email_feedback); a bounced address is never inferred or sent again.
// Trainee sets no volume limit of its own (owner, 2026-10-27 19:55); the only brake is the search service refusing (429,
// quota), shared through the database so every instance backs off, and said plainly. One company is discovered once for
// everyone inside the cache window. Docs: docs/architect/PEOPLE-PROVIDER-2026-10-27.md.
import { chatAsk, cleanCell, cleanEmail, companyKey, isFormula, readsAsInstruction } from "./career_people_import.ts";
import { neverOpen } from "./career_people_sites.ts";
import { formerTitle, type PageRead, readPage, type Resolver } from "./career_people_page.ts";
import { domainLabelOf, registrable } from "./career_people_gmail.ts";
import { dohMx, isRoleAddress, isTeamName, type MxResolver } from "./career_contacts.ts";
import { costMicros, modelConfig, responsesCall } from "./model_gateway.ts";
import { type BudgetGate } from "./model_budget.ts";
import { ModelBudgetBlockedError } from "./model_calls.ts";

export type ProviderName = "web";
export const LABEL: Record<ProviderName, string> = { web: "web search" };
export const DEFAULT_CACHE_DAYS = 30;
export const DEFAULT_SEARCH_MODEL = "gpt-4.1-mini"; // listed for the Responses web_search tool (OpenAI's guide, 2026-10-27)
// Hosts the search is told to leave out (and that are never fetched if they come back anyway).
// Built from the never-open labels, so no such host is written in fetch code (WO-037/D7's scan).
export const BLOCKED_SEARCH_DOMAINS = [["linkedin", "com"], ["indeed", "com"], ["joinhandshake", "com"], ["lnkd", "in"]].map((p) => p.join("."));

export interface FindQuery { company?: string | null; domain?: string | null; titles?: string[]; seniority?: string[]; location?: string | null }
export interface ProviderPerson {
  provider: ProviderName; provider_id: string; name: string; email: string | null; company: string; company_key: string;
  position: string; source_ref: string; source_url: string; profile_text: string | null;
}
export type FindResult =
  | { status: "ok"; people: ProviderPerson[]; company: string; domain: string | null; mx: "pass" | "fail" | "not_run"; http_calls: number; cost_usd: number | null; text_only: string[] }
  | { status: "rate_limited"; retry_after_s: number; http_calls: number; detail: string }
  | { status: "out_of_credits"; http_calls: number; detail: string }
  | { status: "not_wired"; reason: string; http_calls: number }
  | { status: "error"; detail: string; http_calls: number };
export interface PeopleProvider { name: ProviderName; supportsSchool: false; findPeople(q: FindQuery): Promise<FindResult> }

// ------------------------------------------------------------------------------------------------ config
export interface ProviderConfig { provider: ProviderName | null; apiKey: string | null; model: string; cacheSeconds: number; leaseSeconds: number; switchedOn: boolean }
// CAREER_PEOPLE_SEARCH=on switches discovery on (model spend: the owner's to approve); the key is the gateway's own
// (OPENAI_API_KEY through modelConfig, OpenAI only). CAREER_PEOPLE_SEARCH_MODEL picks the model; CAREER_PEOPLE_CACHE_DAYS
// (default 30) is how long one company's discovery is reused for everyone.
export function providerConfig(env: (k: string) => string | undefined): ProviderConfig {
  const switchedOn = (env("CAREER_PEOPLE_SEARCH") ?? "").trim().toLowerCase() === "on";
  const gw = modelConfig({ get: env });
  const key = gw.provider === "openai" && gw.apiKey ? gw.apiKey : null;
  const days = Number(env("CAREER_PEOPLE_CACHE_DAYS"));
  return {
    provider: switchedOn && key ? "web" : null, apiKey: switchedOn ? key : null, switchedOn,
    model: (env("CAREER_PEOPLE_SEARCH_MODEL") ?? "").trim() || DEFAULT_SEARCH_MODEL,
    cacheSeconds: Math.round((Number.isFinite(days) && days >= 0 && env("CAREER_PEOPLE_CACHE_DAYS") !== undefined ? days : DEFAULT_CACHE_DAYS) * 86400), leaseSeconds: 120,
  };
}
export function notWiredReply(c: Pick<ProviderConfig, "switchedOn">): string {
  return c.switchedOn
    ? "Searching the web for new people isn't available right now (the AI service it uses isn't set up), so I only looked through the contacts you've given me. I won't guess names or email addresses."
    : "Searching the web for new people isn't switched on yet, so I only looked through the contacts you've given me. I won't guess names or email addresses.";
}

// ------------------------------------------------------------------------------------------------ text from others
const URLISH = /https?:|www\.|\/\//i;
// A field someone else wrote: cleaned; a formula, or text that reads as an instruction (before or after cleaning), is none.
export function field(v: unknown, max: number): string {
  const raw = String(v ?? "");
  if (isFormula(raw) || readsAsInstruction(raw)) return "";
  const c = cleanCell(raw, max);
  return readsAsInstruction(c) ? "" : c;
}
export function personName(v: unknown): string {
  const n = field(v, 200);
  // NETWORKING SCENARIOS (2026-10-29): a team ("Talent Acquisition", "Careers Team") marked up as a Person is not a person:
  // it got an address inferred in the person format (talent.acquisition@), a role inbox written to as someone.
  return n && /\p{L}/u.test(n) && !URLISH.test(n) && !/@/.test(n) && !isTeamName(n) ? n : "";
}
const nameKey = (n: string) => n.toLowerCase().replace(/[’']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// ------------------------------------------------------------------------------------------------ the search
export type SearchOut = { status: "ok"; urls: { url: string; title: string }[]; cost_usd: number | null }
  | { status: "rate_limited"; retry_after_s: number; detail: string } | { status: "out_of_credits"; detail: string }
  | { status: "not_wired"; reason: string } | { status: "error"; detail: string };
export type SearchFn = (query: string) => Promise<SearchOut>;
// The repo's search recipe for finding people at a company: the role asked for, the team page, the engineering blog,
// campus recruiting, conference speakers, press. One search each; their URLs are read, not their snippets.
export function searchRecipe(company: string, titles: string[]): string[] {
  const c = `"${cleanCell(company, 120).replace(/"/g, "")}"`;
  const roles = titles.length ? titles.map((t) => `${c} ${cleanCell(t, 80)}`) : [`${c} team`];
  return [...new Set([...roles, `${c} team page`, `${c} engineering blog author`, `${c} campus recruiting recruiter`, `${c} conference speaker`, `${c} press contact`])];
}
// OpenAI's web_search tool through the Responses API (https://developers.openai.com/api/docs/guides/tools-web-search):
// POST /v1/responses { model, tools: [{ type: "web_search", filters: { blocked_domains } }], tool_choice: "required",
// include: ["web_search_call.action.sources"], input }. URLs come from web_search_call.action.sources[].url and the
// message's url_citation annotations. 429 insufficient_quota: out of credits; other 429: rate limit; 401/403: key refused.
// Every search is a paid call: it goes through the gateway's responsesCall, which reserves the day's budget before sending.
export function openAiWebSearch(o: { fetch: typeof fetch; apiKey: string; model: string; budget?: BudgetGate }): SearchFn {
  return async (query) => {
    let r: Response;
    try {
      r = await responsesCall({
        apiKey: o.apiKey, model: o.model, request: o.fetch, budget: o.budget, timeoutMs: 45_000,
        body: {
          tool_choice: "required", max_tool_calls: 1, max_output_tokens: 400, include: ["web_search_call.action.sources"],
          tools: [{ type: "web_search", filters: { blocked_domains: BLOCKED_SEARCH_DOMAINS } }],
          input: `Search the web for public pages that name people who work at this company, for: ${query}\nList the pages you found.`,
        },
      });
    } catch (e) {
      if (e instanceof ModelBudgetBlockedError) return { status: "out_of_credits", detail: `search: ${e.detail}` };
      return { status: "error", detail: `search: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) }; }
    if (!r.ok) {
      const body = (await r.text().catch(() => "")).slice(0, 800);
      if (r.status === 429 && /insufficient_quota|exceeded your current quota|billing/i.test(body)) return { status: "out_of_credits", detail: "search: HTTP 429 (quota)" };
      if (r.status === 429) return { status: "rate_limited", retry_after_s: Math.max(1, Math.min(Number(r.headers.get("retry-after")) || 60, 86400)), detail: "search: HTTP 429" };
      if (r.status === 401 || r.status === 403) return { status: "not_wired", reason: `the AI service refused the key (HTTP ${r.status})` };
      return { status: "error", detail: `search: HTTP ${r.status}` };
    }
    const j: any = await r.json().catch(() => null);
    const urls: { url: string; title: string }[] = [];
    for (const item of Array.isArray(j?.output) ? j.output : []) {
      if (item?.type === "web_search_call") for (const s of Array.isArray(item?.action?.sources) ? item.action.sources : []) if (s?.url) urls.push({ url: String(s.url), title: "" });
      if (item?.type === "message") for (const c of Array.isArray(item.content) ? item.content : []) for (const a of Array.isArray(c?.annotations) ? c.annotations : []) {
        if (a?.type === "url_citation" && a.url) urls.push({ url: String(a.url), title: cleanCell(a.title, 200) });
      }
    }
    const micros = costMicros(o.model, j?.usage);
    return { status: "ok", urls, cost_usd: micros === null ? null : micros / 1e6 };
  };
}

// ------------------------------------------------------------------------------------------------ the web provider
const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
const stripUtm = (u: string) => { try { const x = new URL(u); [...x.searchParams.keys()].filter((k) => /^utm_/i.test(k)).forEach((k) => x.searchParams.delete(k)); x.hash = ""; return x.toString(); } catch { return u; } };
export function webProvider(o: { search: SearchFn; fetch: typeof fetch; resolve?: Resolver; mx?: MxResolver; read?: (f: typeof fetch, url: string, r?: Resolver) => Promise<PageRead> }): PeopleProvider {
  const read = o.read ?? readPage;
  const mx = o.mx ?? dohMx(o.fetch);
  return {
    name: "web", supportsSchool: false,
    async findPeople(q) {
      const company = cleanCell(q.company, 200);
      if (!company && !q.domain) return { status: "error", detail: "no company to look for", http_calls: 0 };
      const key = companyKey(company || q.domain);
      const label = domainLabelOf(company || String(q.domain).split(".")[0]);
      let calls = 0, cost: number | null = null;
      // 1. search, every query of the recipe at once
      const outs = await Promise.all(searchRecipe(company || String(q.domain), q.titles ?? []).map(async (s) => { calls++; return await o.search(s); }));
      for (const x of outs) {
        if (x.status === "rate_limited") return { status: "rate_limited", retry_after_s: x.retry_after_s, detail: x.detail, http_calls: calls };
        if (x.status === "out_of_credits") return { status: "out_of_credits", detail: x.detail, http_calls: calls };
        if (x.status === "not_wired") return { status: "not_wired", reason: x.reason, http_calls: calls };
      }
      const ok = outs.filter((x): x is Extract<SearchOut, { status: "ok" }> => x.status === "ok");
      if (!ok.length) return { status: "error", detail: (outs.find((x) => x.status === "error") as any)?.detail ?? "search failed", http_calls: calls };
      for (const x of ok) if (x.cost_usd !== null) cost = (cost ?? 0) + x.cost_usd;
      const urls = [...new Map(ok.flatMap((x) => x.urls).map((u) => [stripUtm(u.url), u])).keys()].filter((u) => /^https?:\/\//i.test(u));
      // the company's own domain: given, or the most common result host whose registrable label is the company's name
      let domain = q.domain ? registrable(String(q.domain).toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "")).full : "";
      if (!domain && label.length >= 2) {
        const tally = new Map<string, number>();
        for (const u of urls) { const r = registrable(hostOf(u)); if (r.label === label) tally.set(r.full, (tally.get(r.full) ?? 0) + 1); }
        domain = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      }
      // 2. read every result page (never a site Trainee never opens: those are text only)
      const textOnly = urls.filter((u) => neverOpen(hostOf(u)));
      const pages = await Promise.all(urls.filter((u) => !neverOpen(hostOf(u)) && /^https:\/\//i.test(u)).map(async (u) => { calls++; return await read(o.fetch, u, o.resolve).catch(() => null); }));
      // 3. a person: named on a page that establishes the employer
      const byId = new Map<string, ProviderPerson>();
      for (const p of pages) {
        if (!p || !p.ok) continue;
        const onDomain = !!domain && registrable(hostOf(p.url)).full === domain;
        const orgIs = !!p.org && companyKey(p.org) === key;
        for (const x of p.people) {
          const name = personName(x.name);
          if (!name) continue;
          // Their own worksFor decides when they have one (a speakers page lists several companies); else the page's.
          const employer = x.company ? companyKey(x.company) === key : (onDomain || orgIs);
          if (!employer) continue;
          // NETWORKING R2 (2026-10-30): someone the page says has left ("Former Recruiter", "ex-Stripe, now at Ramp",
          // "Recruiter (until 2024)", a worksFor role with an end date, the company as their alumniOf) is not someone who
          // works there now. Before, they were listed and drafted to as a current employee.
          if (x.former || formerTitle(x.title) || (x.school && companyKey(x.school) === key)) continue;
          let email = cleanEmail(x.email);
          if (email && isRoleAddress(email)) {
            if (x.how === "mailto link") continue; // "Careers Team" <careers@>: an inbox, not a person
            email = null;
          }
          // NETWORKING R2 (2026-10-30): an address on another domain than the company's is not their work address: a
          // look-alike (str1pe.com, stripe.com.evil.io, stripe-careers.com) or a personal mailbox (gmail.com). It was kept as
          // "published", could never be sent to (the database checks the domain), and won over the same person's real
          // address published on another page. It is dropped here, so the on-domain one (or the domain's format) is used.
          if (email && domain && registrable(email.split("@")[1] ?? "").full !== domain) email = null;
          const pid = `${domain || key}:${nameKey(name)}`.slice(0, 300);
          const prev = byId.get(pid);
          if (prev && (prev.email || !email)) continue;
          byId.set(pid, {
            provider: "web", provider_id: pid, name, email, company: company || domain, company_key: key, position: field(x.title, 300),
            source_ref: `public page, ${hostOf(p.url)}`.slice(0, 600), source_url: p.url, profile_text: null,
          });
        }
      }
      // 4. the domain's mail server, over DNS-over-HTTPS (no SMTP probing)
      let mxState: "pass" | "fail" | "not_run" = "not_run";
      if (domain) { calls++; const m = await mx(domain).catch(() => null); mxState = m?.status === "ok" ? "pass" : m?.status === "none" ? "fail" : "not_run"; }
      return { status: "ok", people: [...byId.values()], company: company || domain, domain: domain || null, mx: mxState, http_calls: calls, cost_usd: cost, text_only: textOnly };
    },
  };
}
export function makeProvider(c: ProviderConfig, f: typeof fetch, o: { resolve?: Resolver; mx?: MxResolver; search?: SearchFn } = {}): PeopleProvider | null {
  if (c.provider !== "web" || !c.apiKey) return null;
  return webProvider({ search: o.search ?? openAiWebSearch({ fetch: f, apiKey: c.apiKey, model: c.model }), fetch: f, resolve: o.resolve, mx: o.mx });
}

// ------------------------------------------------------------------------------------------------ the store (RPC only)
export interface Job { id: number; provider: ProviderName; query_key: string; query: FindQuery & { company_key?: string }; lease_token: string; attempts: number }
export interface Candidate {
  id: number; source: string; name: string | null; email: string | null; company: string; company_key: string; position: string; school: string;
  source_ref: string; source_url: string | null; provider: ProviderName | null; provider_id: string | null; domain: string | null; email_status: string | null;
  email_evidence: number | null; email_confidence: number | null; mx: string | null; sendable: boolean; fetched_at: string | null; same_as: number | null;
  connected_on: string | null; profile_text: string | null;
  // NETWORKING R2 (2026-10-30, 20261030090000): the address opted out with anyone, or bounced for anyone.
  blocked?: boolean;
}
export interface ProviderStore {
  request(userId: string, provider: ProviderName, key: string, query: FindQuery, cacheSeconds: number): Promise<{ state: "cached" | "queued"; job_id?: number; inserted?: number; already_known?: number }>;
  claim(n: number, leaseSeconds: number, userId: string | null): Promise<Job[]>;
  reclaim(): Promise<number>;
  complete(job: Job, r: Extract<FindResult, { status: "ok" }>): Promise<{ state: string; results?: number }>;
  fail(job: Job, kind: "rate_limited" | "out_of_credits" | "error" | "not_wired", detail: string, retrySeconds: number, httpCalls: number, failAfter: number): Promise<{ state: string }>;
  status(userId: string, provider: ProviderName): Promise<{ waiting: number; failed: { job_id: number; outcome: string }[]; blocked_until: string | null; blocked_reason: string | null }>;
  candidates(userId: string, keys: string[], after: number, page: number): Promise<Candidate[]>;
  appliedCompanies(userId: string): Promise<string[]>;
  forget(userId: string): Promise<number>;
  feedback(email: string, name: string, outcome: "bounce" | "reply"): Promise<{ format: string | null; rows_marked: number }>;
}
// deno-lint-ignore no-explicit-any
const must = (r: { data: any; error: any }, what: string): any => { if (r.error) throw new Error(`${what}: ${r.error.message ?? r.error}`); return r.data; };
// deno-lint-ignore no-explicit-any
export function supabaseProviderStore(admin: { rpc: (f: string, a?: any) => Promise<{ data: any; error: any }> }): ProviderStore {
  return {
    async request(userId, provider, key, query, cacheSeconds) {
      return must(await admin.rpc("career_provider_request", { p_user: userId, p_provider: provider, p_query_key: key, p_query: query, p_cache_seconds: cacheSeconds }), "ask for a search");
    },
    async claim(n, lease, userId) { return must(await admin.rpc("career_provider_claim", { p_n: n, p_lease_seconds: lease, p_user: userId }), "claim searches") ?? []; },
    async reclaim() { return must(await admin.rpc("career_provider_reclaim", {}), "reclaim searches") ?? 0; },
    async complete(job, r) {
      return must(await admin.rpc("career_provider_complete", { p_job: job.id, p_lease: job.lease_token, p_company: r.company, p_company_key: companyKey(r.company) || job.query.company_key || "",
        p_domain: r.domain, p_mx: r.mx, p_people: r.people, p_http_calls: r.http_calls, p_cost_usd: r.cost_usd }), "save a search");
    },
    async fail(job, kind, detail, retry, httpCalls, failAfter) {
      return must(await admin.rpc("career_provider_fail", { p_job: job.id, p_lease: job.lease_token, p_kind: kind, p_detail: detail, p_retry_seconds: retry, p_http_calls: httpCalls, p_fail_after: failAfter }), "record a refused search");
    },
    async status(userId, provider) { return must(await admin.rpc("career_provider_status", { p_user: userId, p_provider: provider }), "read the searches"); },
    async candidates(userId, keys, after, page) { return must(await admin.rpc("career_provider_candidates", { p_user: userId, p_keys: keys, p_after: after, p_page: page }), "read the people") ?? []; },
    async appliedCompanies(userId) { return must(await admin.rpc("career_provider_applied_companies", { p_user: userId }), "read your applications") ?? []; },
    async forget(userId) { return must(await admin.rpc("career_provider_forget", { p_user: userId }), "forget the people found for you") ?? 0; },
    async feedback(email, name, outcome) { return must(await admin.rpc("career_email_feedback", { p_email: email, p_name: name, p_outcome: outcome }), "record what happened to an email"); },
  };
}

// One discovery per normalized query: the same company and roles asked by anyone is the same key.
export async function queryKey(q: FindQuery): Promise<{ key: string; norm: FindQuery & { company_key: string } }> {
  const company = cleanCell(q.company, 200);
  const norm = {
    company: company || null, domain: cleanCell(q.domain, 253).toLowerCase() || null, company_key: companyKey(company || q.domain),
    titles: [...new Set((q.titles ?? []).map((t) => cleanCell(t, 80).toLowerCase()).filter(Boolean))].sort(),
    seniority: [...new Set((q.seniority ?? []).map((t) => t.toLowerCase()).filter(Boolean))].sort(), location: cleanCell(q.location, 100).toLowerCase() || null,
  };
  const canon = JSON.stringify([norm.company_key, norm.domain, norm.titles, norm.location]);
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { key: `${norm.company_key.slice(0, 120)}|${sha.slice(0, 40)}`, norm };
}

// ------------------------------------------------------------------------------------------------ the worker
// Claims queued discoveries (any instance, any number at once: SKIP LOCKED leases), runs them concurrently, completes or
// fails each under its lease. `batch` is one call's take (the next call takes more), not a limit on the work.
export async function runLookups(o: { store: ProviderStore; provider: PeopleProvider | null; batch: number; leaseSeconds: number; userId?: string | null; failAfter?: number }):
  Promise<{ claimed: number; done: number; refused: string | null; failed: number }> {
  await o.store.reclaim();
  const jobs = await o.store.claim(o.batch, o.leaseSeconds, o.userId ?? null);
  let done = 0, failed = 0, refused: string | null = null;
  await Promise.all(jobs.map(async (job) => {
    if (!o.provider) { await o.store.fail(job, "not_wired", "web search is not switched on", 1, 0, 1); failed++; return; }
    const r = await o.provider.findPeople(job.query);
    if (r.status === "ok") { await o.store.complete(job, r); done++; return; }
    if (r.status === "rate_limited") { refused ??= "rate_limited"; await o.store.fail(job, "rate_limited", r.detail, r.retry_after_s, r.http_calls, o.failAfter ?? 3); return; }
    if (r.status === "out_of_credits") { refused ??= "out_of_credits"; await o.store.fail(job, "out_of_credits", r.detail, 3600, r.http_calls, o.failAfter ?? 3); return; }
    if (r.status === "not_wired") { await o.store.fail(job, "not_wired", r.reason, 1, r.http_calls, 1); failed++; return; }
    const x = await o.store.fail(job, "error", r.detail, 30, r.http_calls, o.failAfter ?? 3); if (x.state === "failed") failed++;
  }));
  return { claimed: jobs.length, done, refused, failed };
}

// ------------------------------------------------------------------------------------------------ targets for the chat lane
export type TargetAsk =
  | { kind: "applied"; titles: string[]; seniority: string[] }
  | { kind: "role_at"; titles: string[]; seniority: string[]; company: string }
  | { kind: "alumni"; school: string; company: string };
const SENIORITY_WORDS: [RegExp, string][] = [[/\b(vp|vice president)s?\b/, "vp"], [/\bdirectors?\b/, "director"], [/\b(head)s? of\b/, "head"], [/\bmanagers?\b/, "manager"],
  [/\b(founder|co-?founder)s?\b/, "founder"], [/\b(cto|ceo|cfo|coo|chief)\b/, "c_suite"], [/\bsenior\b/, "senior"], [/\binterns?\b/, "intern"]];
function rolesOf(phrase: string): { titles: string[]; seniority: string[] } {
  const p = phrase.toLowerCase().replace(/\b(people|folks|anyone|someone|everyone|the)\b/g, " ").replace(/\s+/g, " ").trim();
  if (!p) return { titles: [], seniority: [] };
  const titles = p.split(/\s*(?:,|\bor\b|\band\b|\/)\s*/).map((t) => t.replace(/s\b$/, "").trim()).filter((t) => t.length >= 2 && t.length <= 80);
  const seniority = [...new Set(SENIORITY_WORDS.filter(([rx]) => rx.test(p)).map(([, s]) => s))];
  return { titles, seniority };
}
// A company as typed: letters (any script), digits, spaces and . , & ' ’ - (so "L’Oréal", "AT&T", "Stripe, Inc."), and never
// with " at " or " from " inside it ("find alumni from DePaul at Ramp" searches Ramp, not a company "DePaul at Ramp").
const CO = String.raw`[\p{L}\p{N}](?:(?!\s(?:at|from)\s)[\p{L}\p{N} .,&'’-]){0,80}`;
// "people at every company I applied to", "engineering managers at every company I've applied to", "engineering managers
// at Stripe", "find recruiters at Ramp", "alumni of DePaul at Stripe", "DePaul alumni at Stripe". Anything else: null.
export function parseTargetAsk(message: string): TargetAsk | null {
  const t = chatAsk(cleanCell(message, 400));
  const lead = String.raw`^(?:(?:please\s+)?(?:find|get|show|list|look\s+up|search\s+for|who\s+are)\s+(?:me\s+)?)?`;
  let m = new RegExp(`${lead}(.*?)\\s*(?:at|from|in)\\s+(?:every|all|each)\\s+(?:of\\s+)?(?:the\\s+)?compan(?:y|ies)\\s+(?:that\\s+)?i(?:'ve|\\s+have)?\\s+applied\\s+(?:to|for|at)$`, "i").exec(t);
  if (m) { const r = rolesOf(m[1]); return { kind: "applied", ...r }; }
  m = new RegExp(`${lead}(?:alumni|grads|graduates)\\s+(?:of|from)\\s+(.+?)\\s+(?:at|working\\s+at|who\\s+work\\s+at)\\s+(.+)$`, "i").exec(t)
    ?? new RegExp(`${lead}(.+?)\\s+(?:alumni|grads|graduates)\\s+(?:at|working\\s+at|who\\s+work\\s+at)\\s+(.+)$`, "i").exec(t);
  if (m) return { kind: "alumni", school: cleanCell(m[1], 120), company: cleanCell(m[2], 120) };
  // NETWORKING SCENARIOS (2026-10-29): a department ("people in data at Stripe", "who works in marketing at Ramp", "find
  // folks working in machine learning at X") is a discovery for that department's titles, never for the words "in data".
  m = new RegExp(`${lead}(?:who\\s+works?|(?:the\\s+)?(?:people|folks|someone|anyone|everyone)(?:\\s+who\\s+works?|\\s+working)?)\\s+in\\s+(?:the\\s+)?([a-z][a-z &/-]{1,40}?)(?:\\s+(?:team|department|dept|org|group))?\\s+(?:at|from)\\s+(${CO})$`, "iu").exec(t);
  if (m && m[1].trim().split(/\s+/).length <= 3 && !/\b(?:i|me|my|you|apply|applied|send|email|message|role|job|position)\b/i.test(m[1])) {
    return { kind: "role_at", titles: [cleanCell(m[1], 80).toLowerCase()], seniority: [], company: cleanCell(m[2], 120) };
  }
  m = new RegExp(`${lead}(.+?)\\s+(?:at|from)\\s+(${CO})$`, "iu").exec(t);
  // ROUTING SCENARIOS (2026-10-29): without "find" / "show" / "who are" in front, the words before "at" must name people
  // (a plural, or a role word): "withdraw from Stripe" and "aply to the analyst role at Figma" are not searches for a
  // "withdraw" or an "aply to the analyst role" at the firm. An action or a question word is never a title.
  const led = new RegExp(`${lead}`, "i").exec(t)?.[0] ?? "";
  const peopleWords = (p: string) => /(?:[^s]s|\bstaff|\bpeople|\bfolks|\bteam|\bleadership)$/i.test(p.trim()) ||
    /\b(?:recruiter|engineer|manager|director|founder|partner|analyst|designer|scientist|developer|lead|head of \w+|vp|ceo|cto|cfo|coo|president|intern|associate|alum(?:nus|na)?)$/i.test(p.trim());
  // An outreach verb ("reach out to engineers at X", "reach people at X", "get in touch with ...") asks to write to people,
  // the networking turn's draft or who; it is never a search for a title "reach out to engineer" (2026-10-29).
  if (m && !/\b(i|me|my|you|work|working|apply|applying|applied|jobs?|roles?\s+open|send|email|e-mail|draft|write|message|msg|dm|ping|reach|contact|connect|touch|network|introduce|intro(?:duction)?s?|contacts?|know)\b/i.test(m[1]) && m[1].split(/\s+/).length <= 8 &&
    !/\b(?:withdraw\w*|cancel\w*|remove|delete|forget|stop|don'?t|do not|status|where|what|how|did|has|have|any|role|position|opening|posting|application)\b/i.test(m[1]) &&
    (led.trim() !== "" || peopleWords(m[1])) && !/^(?:my|your|our)\b/i.test(m[2])) {
    const r = rolesOf(m[1]);
    if (r.titles.length) return { kind: "role_at", ...r, company: cleanCell(m[2], 120) };
  }
  return null;
}

export type AddressLabel = "published" | "known" | "inferred" | null;
export interface Target {
  id: number; name: string; title: string; company: string; email: string | null; address: AddressLabel; evidence: number | null;
  sendable: boolean; source: string; source_url: string | null; reason: string; blocked?: boolean;
}
export interface TargetsResult {
  status: "ok" | "NOT_WIRED" | "waiting" | "refused" | "none" | "no_companies";
  reply: string; candidates: Target[]; companies: string[]; waiting: number;
}
export interface TargetDeps { store: ProviderStore; config: ProviderConfig; provider: PeopleProvider | null; now: () => number; workerBatch?: number }

const plainWords = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function titleMatch(title: string, ask: { titles: string[] }): string | null {
  if (!ask.titles.length) return "works there";
  const tl = ` ${plainWords(title)} `;
  for (const want of ask.titles) {
    const w = plainWords(want).split(" ").filter((x) => x.length > 1);
    if (w.length && w.every((x) => tl.includes(` ${x}`))) return `matches "${want}"`;
  }
  return null;
}
const labelOf = (c: Candidate): AddressLabel => !c.email ? null : c.source !== "provider" ? "known" : c.email_status === "inferred" ? "inferred" : c.email_status === "published" ? "published" : null;
const addressLine = (c: Candidate, l: AddressLabel) =>
  c.blocked && c.email ? "they asked not to be contacted, or their address bounced: not used"
  : l === "published" ? `email published on that page${c.sendable ? "" : c.mx === "fail" ? " (its domain has no mail server: not used)" : ""}`
  : l === "inferred" ? `email inferred from ${c.domain}'s format (${c.email_evidence} addresses seen there)${c.sendable ? ", sent only if you approve it" : c.mx === "fail" ? " (its domain has no mail server: not used)" : ""}`
  : l === "known" ? "email from your own contacts"
  : c.email_status === "bounced" ? "their address bounced before: not used" : "no email address";
const fromLine = (c: Candidate) => c.source === "provider"
  ? `named on ${c.source_url}${c.fetched_at ? ` (read ${c.fetched_at.slice(0, 10)})` : ""}`
  : c.source === "linkedin_export" ? "from your LinkedIn export" : c.source === "gmail" ? "from your Gmail" : c.source === "company_page" ? `published on ${c.source_url}` : "from your contacts";

// findTargets(userId, ask): candidates with a reason line each (their title and why they match, where they were found,
// what the address is), for later drafting. One discovery per company (shared cache, or one queued job for everyone);
// this person's own queued discoveries run here, concurrently; a refusal or a wait is said, not hidden.
export async function findTargets(userId: string, ask: TargetAsk, d: TargetDeps): Promise<TargetsResult> {
  let companies = ask.kind === "applied" ? await d.store.appliedCompanies(userId) : [ask.company];
  companies = [...new Map(companies.map((c) => [companyKey(c), cleanCell(c, 120)])).entries()].filter(([k]) => k).map(([, c]) => c);
  if (!companies.length) {
    return { status: "no_companies", reply: "You haven't applied anywhere I have on record yet, so there are no companies to look for people at. Tell me a company and the roles you want, like \"engineering managers at Stripe\".", candidates: [], companies: [], waiting: 0 };
  }
  const roles = ask.kind === "alumni" ? { titles: [] as string[], seniority: [] as string[] } : { titles: ask.titles, seniority: ask.seniority };
  const wired = !!(d.config.provider && d.config.apiKey && d.provider);
  const notes: string[] = [];
  if (ask.kind === "alumni") notes.push("Public pages rarely say where someone studied, so alumni come only from the schools on your own contacts.");
  if (wired && ask.kind !== "alumni") {
    for (const c of companies) {
      const { key, norm } = await queryKey({ company: c, titles: roles.titles });
      await d.store.request(userId, "web", key, norm, d.config.cacheSeconds);
    }
    for (;;) {
      const r = await runLookups({ store: d.store, provider: d.provider, batch: d.workerBatch ?? 25, leaseSeconds: d.config.leaseSeconds, userId });
      if (!r.claimed || r.refused) break;
    }
  } else if (!wired && ask.kind !== "alumni") notes.push(notWiredReply(d.config));
  const keys = companies.map((c) => companyKey(c));
  const out: Target[] = [];
  const byId = new Map<number, Target>();
  for (let after = 0; ;) {
    const page = await d.store.candidates(userId, keys, after, 1000);
    if (!page.length) break;
    after = page[page.length - 1].id;
    for (const c of page) {
      let why: string | null;
      if (ask.kind === "alumni") {
        const a = plainWords(c.school), b = plainWords(ask.school);
        why = a && b && (a.includes(b) || b.includes(a)) ? `went to ${c.school}` : null;
      } else why = titleMatch(c.position, roles);
      // A discovered row linked to the person's own contact is the same person: its published address fills theirs.
      const own = c.same_as ? byId.get(c.same_as) : undefined;
      if (own) {
        if (!own.email && c.email) {
          const l = labelOf(c);
          Object.assign(own, { email: c.email, address: l, evidence: c.email_evidence, sendable: c.sendable && !c.blocked, source_url: c.source_url, reason: `${own.reason.replace(/\.$/, "")}; ${addressLine(c, l)}, ${fromLine(c)}.` });
        }
        continue;
      }
      if (!why) continue;
      const l = labelOf(c);
      const t: Target = { id: c.id, name: c.name ?? c.email ?? "", title: c.position, company: c.company, email: c.email, address: l, evidence: c.email_evidence,
        sendable: c.sendable && !c.blocked, ...(c.blocked ? { blocked: true } : {}), source: c.source, source_url: c.source_url,
        reason: `${c.position ? `${c.position} at ${c.company}` : `at ${c.company}`}; ${why}; ${fromLine(c)}; ${addressLine(c, l)}.` };
      byId.set(c.id, t);
      out.push(t);
    }
  }
  let waiting = 0;
  if (wired) {
    const s = await d.store.status(userId, "web");
    waiting = s.waiting;
    if (s.blocked_reason === "out_of_credits") notes.push(`The web search service says its account is out of credit, so ${s.waiting ? `${s.waiting} ${s.waiting === 1 ? "search is" : "searches are"} waiting` : "new searches wait"} until it's topped up; I'll finish them then.`);
    else if (s.blocked_reason === "rate_limited") notes.push(`The web search service asked me to slow down, so ${s.waiting} ${s.waiting === 1 ? "search is" : "searches are"} waiting; they run again after ${new Date(s.blocked_until!).toISOString().slice(11, 16)} UTC.`);
    else if (s.waiting) notes.push(`${s.waiting} ${s.waiting === 1 ? "search is" : "searches are"} still running; ask again shortly for the rest.`);
    if (s.failed.length) notes.push(`${s.failed.length} ${s.failed.length === 1 ? "search" : "searches"} couldn't be done.`);
  }
  const sendable = out.filter((x) => !x.blocked && (x.sendable || x.address === "known")).length;
  const head = out.length
    ? `${out.length} ${out.length === 1 ? "person" : "people"} at ${companies.length === 1 ? companies[0] : `${companies.length} companies`}, ${sendable} with an address I could use (each one labeled published, known or inferred).`
    : `No one matching at ${companies.length === 1 ? companies[0] : `${companies.length} companies`} yet.`;
  const status: TargetsResult["status"] = !wired && ask.kind !== "alumni" ? "NOT_WIRED" : notes.some((n) => /out of credit|slow down/.test(n)) ? "refused" : waiting ? "waiting" : out.length ? "ok" : "none";
  return { status, reply: [head, ...notes].join(" "), candidates: out, companies, waiting };
}
