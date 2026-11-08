// deno-lint-ignore-file no-explicit-any require-await
// R9 free sources (owner, 2026-11-08): research brief Files from FREE first-party sources only (no search key, no paid data), and the
// three review fixes from #589: research_market's effect is write_own when it publishes a File; the RESOLVED address of every fetch
// and redirect is checked (DNS rebinding); "give me an overview of everything I applied to" stays with export. Fake web, fake
// resolver, scripted model: no network, no spend. Every company, figure and page is synthetic.
import assertNode from "node:assert/strict";
import { agentTurn } from "../../supabase/functions/agent-chat/career_brain.ts";
import { marketResearchAsk, researchAsk } from "../../supabase/functions/agent-chat/career_staged.ts";
import { type MarketDeps, researchMarket } from "../../supabase/functions/_shared/agent/research/market.ts";
import { bodyHtml, textOf, validateKind } from "../../supabase/functions/_shared/file_kinds.ts";
import { fetchSources, isBlockedHost } from "../../supabase/functions/_shared/research_sources.ts";
import { boardText, convertFree, freeProvider, freeReader, OOH, researchSearchFor, robotsGate, slugsFor } from "../../supabase/functions/_shared/research_free_sources.ts";
import { browserChecks, dataChecks } from "../../evals/career/research-free/quality.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.parse("2026-11-08T15:00:00Z");
const html = (t: string, b: string) => new Response(`<!doctype html><html><head><title>${t}</title></head><body><p>${b}</p></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
const json = (x: unknown) => new Response(JSON.stringify(x), { headers: { "content-type": "application/json; charset=utf-8" } });
const nf = () => new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
const PUBLIC = async () => ["203.0.113.10"];

// ---------------------------------------------------------------- a synthetic free web
const GH_JOBS = { jobs: [
  { title: "Software Engineer, New Grad", location: { name: "New York, NY" } }, { title: "Senior Software Engineer", location: { name: "New York, NY" } },
  { title: "Data Analyst Intern", location: { name: "Chicago, IL" } }, { title: "Account Executive", location: { name: "Remote" } },
], meta: { total: 4 } };
const WIKI = { type: "standard", title: "Zentrafin", description: "American financial technology company", extract: "Zentrafin is a payments company.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Zentrafin" } }, wikibase_item: "Q999001" };
const WD = { entities: { Q999001: { id: "Q999001", labels: { en: { value: "Zentrafin" } }, descriptions: { en: { value: "American financial technology company" } }, claims: {
  P1128: [{ rank: "normal", mainsnak: { datavalue: { value: { amount: "+2400" } } }, qualifiers: { P585: [{ datavalue: { value: { time: "+2025-00-00T00:00:00Z" } } }] } }],
  P571: [{ rank: "normal", mainsnak: { datavalue: { value: { time: "+2016-01-01T00:00:00Z" } } } }],
  P856: [{ rank: "normal", mainsnak: { datavalue: { value: "https://www.zentrafin.example" } } }] } } } };
const GH_ORG = { login: "zentrafin", name: "Zentrafin", public_repos: 37, blog: "https://zentrafin.example", location: "New York", created_at: "2017-03-01T00:00:00Z", description: "Payments infrastructure" };
const RSS = `<?xml version="1.0"?><rss><channel><item><title>Zentrafin opens a Chicago office</title><link>https://news.example/zentrafin-chicago</link><pubDate>Tue, 04 Nov 2026 10:00:00 GMT</pubDate></item><item><title>Zentrafin review roundup</title><link>https://www.glassdoor.co.uk/zentrafin</link></item></channel></rss>`;
const FTS = { hits: { hits: [{ _id: "0009990001-26-000004:zen-8k.htm", _source: { ciks: ["0009990001"], display_names: ["Zentrafin Inc (ZEN) (CIK 0009990001)"], form: "8-K", file_date: "2026-10-01" } }] } };
function freeWeb(log: string[] = [], o: { robots?: Record<string, Response | (() => Response)> } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input), u = new URL(url);
    log.push(`${url} ua=${new Headers(init.headers).get("user-agent") ?? ""} key=${new Headers(init.headers).get("authorization-key") ?? ""}`);
    if (u.pathname === "/robots.txt") { const r = o.robots?.[u.hostname]; return r ? (typeof r === "function" ? r() : r) : nf(); }
    if (url === "https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs") return json(GH_JOBS);
    if (url === "https://en.wikipedia.org/api/rest_v1/page/summary/Zentrafin") return json(WIKI);
    if (url === "https://en.wikipedia.org/wiki/Zentrafin") return html("Zentrafin - Wikipedia", "Zentrafin is an American financial technology company founded in 2016.");
    if (url === "https://www.wikidata.org/wiki/Special:EntityData/Q999001.json") return json(WD);
    if (url === "https://api.github.com/orgs/zentrafin") return json(GH_ORG);
    if (u.hostname === "efts.sec.gov") return json(FTS);
    if (u.hostname === "api.gdeltproject.org") return new Response(RSS, { headers: { "content-type": "application/rss+xml" } });
    if (u.hostname === "data.usajobs.gov" && u.pathname === "/api/search") return json({ SearchResult: { SearchResultCountAll: 48, SearchResultItems: [{ MatchedObjectDescriptor: { PositionTitle: "IT Specialist", OrganizationName: "Department of Synthetic Affairs", PositionLocationDisplay: "Chicago, Illinois", PositionRemuneration: [{ MinimumRange: "72000", MaximumRange: "98000", RateIntervalCode: "PA" }] } }] } });
    if (u.hostname === "data.usajobs.gov") return json({ paging: { metadata: { totalCount: 212 } }, data: [{ positionTitle: "IT Specialist (APPSW)", hiringAgencyName: "Department of Synthetic Affairs", minimumSalary: 72000, maximumSalary: 98000, positionLocations: [{ positionLocationCity: "Chicago", positionLocationState: "Illinois" }] }] });
    if (url === "https://zentrafin.example/") return html("Zentrafin", "Zentrafin builds payment software.");
    if (url === "https://zentrafin.example/careers") return html("Careers at Zentrafin", "Zentrafin hires new grads into engineering every fall.");
    return nf();
  }) as typeof fetch;
}

// ---------------------------------------------------------------- the never-list, on any TLD
Deno.test("never-list: LinkedIn, Indeed, Glassdoor, ZipRecruiter, Handshake, Crunchbase and Google Scholar on any TLD and depth", async () => {
  for (const u of ["https://www.glassdoor.co.uk/x", "https://glassdoor.com/x", "https://linkedin.cn/in/a", "https://www.ziprecruiter.ca/j", "https://indeed.de/q", "https://crunchbase.co/o", "https://scholar.google.co.uk/s", "https://glassdoor.com.evil.example/x", "https://joinhandshake.com/a"])
    ok(isBlockedHost(u), u);
  for (const u of ["https://www.bls.gov/ooh/", "https://zentrafin.example/", "https://google.com/", "https://en.wikipedia.org/wiki/Glassdoor"]) ok(!isBlockedHost(u), u);
  const got = await fetchSources(["https://www.glassdoor.co.uk/Reviews/x"], { fetch: freeWeb(), resolver: PUBLIC });
  eq(got.rejected.map((r) => r.why), ["blocked_site"]);
  // A redirect to a never-listed site is refused at that hop.
  const hop = (async (i: RequestInfo | URL) => String(i).includes("zentrafin") ? new Response(null, { status: 302, headers: { location: "https://uk.glassdoor.co.uk/r" } }) : html("x", "y")) as typeof fetch;
  eq((await fetchSources(["https://zentrafin.example/reviews"], { fetch: hop, resolver: PUBLIC })).rejected.map((r) => r.why), ["blocked_site"]);
});

// ---------------------------------------------------------------- DNS rebinding
Deno.test("DNS rebinding: the resolved address is checked on every fetch and every redirect; one private answer refuses the page", async () => {
  const asked: string[] = [];
  const f = (async (i: RequestInfo | URL) => { const u = new URL(String(i)); return u.hostname === "start.example" ? new Response(null, { status: 301, headers: { location: "https://rebind.example/page" } }) : html("t", "a public page"); }) as typeof fetch;
  // The redirect target's name resolves to a private address: refused at that hop, never fetched.
  const res1 = async (h: string) => { asked.push(h); return h === "rebind.example" ? ["93.184.216.34", "10.0.0.5"] : ["203.0.113.10"]; };
  eq((await fetchSources(["https://start.example/"], { fetch: f, resolver: res1 })).rejected.map((r) => r.why), ["private_address"]);
  eq(asked, ["start.example", "rebind.example"], "every hop resolves");
  // The same name answers public, then private (a rebinding server): the second fetch of it is refused.
  let n = 0;
  const flip = async () => (n++ === 0 ? ["203.0.113.10"] : ["127.0.0.1"]);
  eq((await fetchSources(["https://flip.example/a"], { fetch: f, resolver: flip })).verified.length, 1);
  eq((await fetchSources(["https://flip.example/b"], { fetch: f, resolver: flip })).rejected.map((r) => r.why), ["private_address"]);
  // Metadata, CGNAT, IPv6 loopback, link-local and v4-mapped answers all refuse; no answer at all is unreachable.
  for (const ip of ["169.254.169.254", "100.64.0.1", "::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0"])
    eq((await fetchSources(["https://x.example/"], { fetch: f, resolver: async () => [ip] })).rejected.map((r) => r.why), ["private_address"], ip);
  eq((await fetchSources(["https://x.example/"], { fetch: f, resolver: async () => { throw new Error("NXDOMAIN"); } })).rejected.map((r) => r.why), ["unreachable"]);
  // The production reader always resolves: a reader built without a resolver uses the system one (here, Deno.resolveDns stubbed).
  const real = Deno.resolveDns;
  try {
    (Deno as any).resolveDns = async (_h: string, t: string) => (t === "A" ? ["10.1.2.3"] : []);
    eq((await freeReader({ fetch: f, now: () => NOW })(["https://looks-public.example/"])).rejected.map((r) => r.why), ["private_address"]);
  } finally { (Deno as any).resolveDns = real; }
});

// ---------------------------------------------------------------- robots.txt
Deno.test("robots.txt: obeyed for every page host (404 = no rules; unreadable = no read); documented APIs follow their terms", async () => {
  const robots = { "zentrafin.example": new Response("User-agent: *\nDisallow: /careers\n", { status: 200 }), "down.example": () => new Response("", { status: 503 }) };
  const f = freeWeb([], { robots });
  const read = freeReader({ fetch: f, resolver: PUBLIC, now: () => NOW });
  const got = await read(["https://zentrafin.example/", "https://zentrafin.example/careers", "https://down.example/about", "https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs"]);
  eq(got.verified.map((v) => v.url), ["https://zentrafin.example/", "https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs"]);
  eq(got.rejected.map((r) => [r.url, r.why]), [["https://zentrafin.example/careers", "robots_disallow"], ["https://down.example/about", "robots_disallow"]]);
  // A TraineeBot group wins over *.
  const g = robotsGate((async () => new Response("User-agent: *\nDisallow: /\n\nUser-agent: TraineeBot\nAllow: /\n", { status: 200 })) as typeof fetch);
  ok(await g("https://open-to-us.example/about"));
});

// ---------------------------------------------------------------- JSON and RSS become plain sentences, by code
Deno.test("convertFree: ATS boards, GitHub, Wikidata, USAJOBS and news RSS become sentences from their fields; counts are counted", () => {
  const gh = convertFree("https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs", "application/json", JSON.stringify(GH_JOBS))!;
  ok(gh.text.includes("The Greenhouse job board zentrafin lists 4 open roles."));
  ok(gh.text.includes("2 of the 4 open roles on the Greenhouse job board zentrafin say intern, new grad, junior, associate or entry level in the title."));
  ok(gh.text.includes("2 open roles on the Greenhouse job board zentrafin are in New York, NY."));
  const lever = convertFree("https://api.lever.co/v0/postings/zentrafin?mode=json", "application/json", JSON.stringify([{ text: "Junior Analyst", categories: { location: "Austin, TX" } }]))!;
  ok(lever.text.startsWith("The Lever job board zentrafin lists 1 open roles."));
  const ashby = convertFree("https://api.ashbyhq.com/posting-api/job-board/zentrafin", "application/json", JSON.stringify({ jobs: [{ title: "Engineer", location: "Remote", isListed: true }, { title: "Hidden", isListed: false }] }))!;
  ok(ashby.text.startsWith("The Ashby job board zentrafin lists 1 open roles.") && !ashby.text.includes("Hidden"));
  const sr = convertFree("https://api.smartrecruiters.com/v1/companies/zentrafin/postings", "application/json", JSON.stringify({ totalFound: 9, content: [{ name: "Sales Associate", location: { city: "Denver", region: "CO", country: "us" } }] }))!;
  ok(sr.text.includes("lists 9 open roles") && sr.text.includes("Sales Associate, Denver, CO, US"));
  ok(convertFree("https://api.github.com/orgs/zentrafin", "application/json", JSON.stringify(GH_ORG))!.text.includes("has 37 public repositories"));
  const wd = convertFree("https://www.wikidata.org/wiki/Special:EntityData/Q999001.json", "application/json", JSON.stringify(WD))!.text;
  ok(wd.includes("Zentrafin had 2,400 employees as of 2025, according to Wikidata.") && wd.includes("founded in 2016") && wd.includes("official website is zentrafin.example"));
  ok(convertFree("https://data.usajobs.gov/api/historicjoa?PositionSeries=2210&StartPositionOpenDate=2026-08-10", "application/json", JSON.stringify({ paging: { metadata: { totalCount: 212 } }, data: [] }))!.text.includes("212 federal job announcements in occupational series 2210 opened since 2026-08-10"));
  const news = convertFree("https://api.gdeltproject.org/api/v2/doc/doc?query=%22Zentrafin%22&format=rss", "application/rss+xml", RSS)!.text;
  ok(news.includes("Zentrafin opens a Chicago office") && !/glassdoor|review roundup/i.test(news), "a never-listed item is dropped");
  eq(convertFree("https://unknown.example/api", "application/json", "{}"), null, "unknown JSON is not read");
  eq(boardText("Lever", "x", []).text, "The Lever job board x lists 0 open roles.");
  eq(slugsFor("Zentrafin Inc", ["zentrafin.example"]), ["zentrafin"]);
});

// ---------------------------------------------------------------- the provider
Deno.test("free provider: every free source is proposed with no search key; the brief's gaps say what no free source had", async () => {
  const log: string[] = [];
  const p = freeProvider({ fetch: freeWeb(log), now: () => NOW, userAgent: "Trainee research test@example.com" });
  const out = await p.search({ queries: ["what do software developers earn"], companies: ["Zentrafin"], sites: ["zentrafin.example"], soc: "15-1252", cbsa: "16980" });
  const kinds = new Set(out.hits.map((h) => h.provider));
  for (const k of ["bls_oes", "bls_ooh", "usajobs", "company_site", "ats_board", "wikipedia", "wikidata", "github", "sec_fts", "news_rss"]) ok(kinds.has(k as any), `proposes ${k}: ${[...kinds]}`);
  ok(out.hits.some((h) => h.url === `https://www.bls.gov/ooh/${OOH["15-1252"].path}`));
  ok(out.hits.some((h) => h.url === "https://www.sec.gov/Archives/edgar/data/9990001/000999000126000004/zen-8k.htm"));
  for (const s of ["/", "/about", "/careers", "/press", "/team"]) ok(out.hits.some((h) => h.url === `https://zentrafin.example${s}`.replace(/\/$/, "/")), s);
  ok(out.hits.length <= 16 && out.hits.every((h) => h.url.startsWith("https://") && !isBlockedHost(h.url) && h.foundAt === NOW));
  ok(log.filter((l) => /sec\.gov|usajobs/.test(l)).every((l) => l.includes("ua=Trainee research test@example.com")), "SEC and USAJOBS get the declared contact");
  ok(log.every((l) => !/brave|search\.api|serpapi|bing\.com/.test(l)), "no paid or keyed search");
  // A company with no free source: the gaps say so, in plain words, with no link and no env name.
  const none = await freeProvider({ fetch: freeWeb(), now: () => NOW, userAgent: null }).search({ queries: ["how much does a nurse make at Quillmont"], companies: ["Quillmont"] });
  ok(none.gaps!.some((g) => /No public Greenhouse, Lever, Ashby or SmartRecruiters job board was found for Quillmont/.test(g)));
  ok(none.gaps!.some((g) => /Wikipedia has no company article found for Quillmont/.test(g)));
  ok(none.gaps!.some((g) => /SEC filings were not read/.test(g)));
  ok(none.gaps!.some((g) => /No government pay figure/.test(g)));
  ok(none.gaps!.every((g) => !/https?:|[A-Z_]{8,}/.test(g)));
  // With the owner's free USAJOBS key, the open-announcements search is used, the key in its header only.
  const keyed: string[] = [];
  const pk = researchSearchFor({ get: (k) => ({ RESEARCH_USER_AGENT: "Trainee research test@example.com", USAJOBS_API_KEY: "usajobs-test-key-not-real" } as Record<string, string>)[k] }, freeWeb(keyed), () => NOW);
  const ko = await pk.search.search({ queries: ["pay"], soc: "15-1252" });
  ok(ko.hits.some((h) => h.url.startsWith("https://data.usajobs.gov/api/search?Keyword=")));
  const real = Deno.resolveDns;
  try { (Deno as any).resolveDns = async (_h: string, t: string) => (t === "A" ? ["203.0.113.10"] : []); eq((await pk.read(ko.hits.filter((h) => h.provider === "usajobs").map((h) => h.url))).verified.length, 1); }
  finally { (Deno as any).resolveDns = real; }
  ok(keyed.filter((l) => l.includes("key=usajobs-test-key-not-real")).every((l) => l.startsWith("https://data.usajobs.gov/api/search")) && keyed.some((l) => l.includes("key=usajobs-test-key-not-real")));
  eq(researchSearchFor({ get: () => undefined }, freeWeb()).search.id, "first_party");
});

// ---------------------------------------------------------------- end to end: a brief from free sources only
Deno.test("a research brief File from free sources: the ATS count is cited to the board it came from, and the gaps are on the page", async () => {
  const f = freeWeb(), read = freeReader({ fetch: f, resolver: PUBLIC, now: () => NOW }), published: any[] = [];
  const draft = { title: "Zentrafin as a first job", thesis: "Zentrafin hires new grads into engineering.",
    summary: [
      { text: "The Greenhouse job board zentrafin lists 4 open roles.", quote: "The Greenhouse job board zentrafin lists 4 open roles.", url: "https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs" },
      { text: "Zentrafin had 2,400 employees as of 2025.", quote: "Zentrafin had 2,400 employees as of 2025, according to Wikidata.", url: "https://www.wikidata.org/wiki/Special:EntityData/Q999001.json" },
      { text: "Zentrafin had 9,000 employees.", quote: "Zentrafin had 2,400 employees as of 2025", url: "https://www.wikidata.org/wiki/Special:EntityData/Q999001.json" },
    ],
    conditions: [{ text: "Zentrafin keeps hiring new grads into engineering.", urls: ["https://zentrafin.example/careers"] }],
    risks: [{ text: "Fewer open roles would mean fewer first jobs.", urls: ["https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs"] }] };
  const deps: MarketDeps = { search: freeProvider({ fetch: f, now: () => NOW, userAgent: null }), read, draft: async () => JSON.stringify(draft),
    publish: async (d) => { published.push(d); return { url: "https://trainee.example/file?t=v1.free1" }; } };
  const r = await researchMarket({ question: "research Zentrafin as an employer and give me a file", format: "file", plan: { queries: ["Zentrafin employer"], companies: ["Zentrafin"], sites: ["zentrafin.example"] }, deps });
  eq([r.status, r.format, (r as any).dropped], ["ok", "file", 1], "the 9,000 claim is dropped: its number is not in its quote");
  const d = published[0];
  ok(d.summary.some((s: any) => /lists 4 open roles/.test(s.text)));
  ok(d.sources.every((s: any) => s.url.startsWith("https://") && !isBlockedHost(s.url)));
  ok(d.gaps?.some((g: string) => /SEC filings were not read/.test(g)), JSON.stringify(d.gaps));
  const v = validateKind("research_brief", d, { now: NOW });
  ok(v.ok, JSON.stringify(v));
  const rec = { id: "f1", userId: "u", kind: "research_brief", data: (v as any).data, state: {}, tag: null, created_at: NOW, expires_at: NOW + 3600_000, revoked_at: null } as any;
  const body = bodyHtml(rec, "fs1." + "a".repeat(64)), heads = [...body.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
  eq(heads, ["Summary", "What would have to be true", "Risks", "Not found in a free source", "Sources"]);
  ok(textOf(rec, { now: NOW }).includes("## Not found in a free source"));
  ok(!validateKind("research_brief", { ...d, gaps: ["see https://evil.example"] }, { now: NOW }).ok, "a gap line carries no link");
});

// ---------------------------------------------------------------- review fix: research_market's effect
Deno.test("research_market's effect is write_own when it published a File, read when it answered inline", async () => {
  const f = freeWeb(), read = freeReader({ fetch: f, resolver: PUBLIC, now: () => NOW });
  const draft = { title: "Zentrafin", thesis: "Zentrafin hires new grads into engineering.", summary: [{ text: "The Greenhouse job board zentrafin lists 4 open roles.", quote: "The Greenhouse job board zentrafin lists 4 open roles.", url: "https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs" }],
    conditions: [{ text: "Zentrafin keeps hiring new grads into engineering.", urls: ["https://zentrafin.example/careers"] }], risks: [{ text: "Fewer open roles would mean fewer first jobs.", urls: ["https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs"] }] };
  const run = async (format: "file" | "inline") => {
    const d: MarketDeps = { search: freeProvider({ fetch: f, now: () => NOW, userAgent: null }), read, draft: async () => JSON.stringify(draft), publish: async () => ({ url: "https://trainee.example/file?t=v1.free2" }) };
    let step = 0;
    const model = async () => (++step === 1 ? { content: [{ type: "tool_use", id: "m1", name: "research_market", input: { question: "research Zentrafin", format, companies: ["Zentrafin"], sites: ["zentrafin.example"] } }], stop_reason: "tool_use" }
      : { content: [{ type: "text", text: "Zentrafin is hiring; the brief is in the file." }], stop_reason: "end_turn" });
    const t: any = await agentTurn({ message: "research Zentrafin and give me a file", history: [], stores: { profile: {} }, userId: "u1", threadId: "t1", now: NOW, model, market: d } as any);
    return t.tool_calls.find((c: any) => c.name === "research_market");
  };
  eq((await run("file")).effect, "write_own");
  eq((await run("inline")).effect, "read");
});

// ---------------------------------------------------------------- review fix: export, not research
Deno.test("RESEARCH_ASK: an overview of the person's own applications stays with export; research about companies stays research", () => {
  const env = { get: (k: string) => (k === "CAREER_RESEARCH_REPLY" ? "on" : undefined) };
  for (const m of ["give me an overview of everything I applied to", "can you give me a rundown of all the jobs I've applied for", "a report on all my applications please", "overview of everything i’ve applied to", "summary of all of it"]) {
    eq(researchAsk(m), false, m); eq(marketResearchAsk(env as any, m, null), false, m);
  }
  for (const m of ["give me an overview of the fintech market in Chicago", "research the companies I applied to and give me a file", "compare Zentrafin and Quillmont", "research Zentrafin as an employer"])
    eq(researchAsk(m), true, m);
});

// ---------------------------------------------------------------- the quality rubric catches what it claims to
Deno.test("quality rubric (evals/career/research-free/quality.ts): each line fails on the defect it names", () => {
  const good = { scrollW: 390, innerW: 390, texts: [{ el: "span.rb-t", color: [20, 20, 20], ground: [255, 255, 255], link: false, size: 18, fact: true }], over: [], grounds: [], fills: [], taps: [{ el: "a", h: 44 }], heads: ["Summary", "What would have to be true", "Risks", "Sources"], empty: [], emptyLi: 0 };
  eq(browserChecks(good, 390), { r2: [], r3: [], r4: [], r5: [] });
  const bad = { ...good, scrollW: 420, texts: [{ el: "p.x", color: [0x5c, 0x27, 0x51], ground: [255, 255, 255], link: false, size: 12, fact: false }, { el: "span.rb-t", color: [150, 150, 150], ground: [255, 255, 255], link: false, size: 15, fact: true }],
    grounds: [{ el: "div.wash", c: [0x5c, 0x27, 0x51], mark: false }], taps: [{ el: "a", h: 30 }], heads: ["Risks", "Summary", "Sources"], empty: ["Risks"] };
  const c = browserChecks(bad, 390);
  ok(c.r2.length === 2 && c.r3.some((x) => /out of order/.test(x)) && c.r3.some((x) => /missing section: What would have to be true/.test(x)));
  ok(c.r4.some((x) => /sideways/.test(x)) && c.r4.some((x) => /empty section/.test(x)));
  ok(c.r5.some((x) => /fact text 15px/.test(x)) && c.r5.some((x) => /text 12px/.test(x)) && c.r5.some((x) => /under AA/.test(x)) && c.r5.some((x) => /tap target 30px/.test(x)));
  const d = dataChecks({ title: "Pay in 2026", thesis: "Pay is $90,000.", summary: [{ text: "a", cite: [] }], conditions: [{ text: "b", cite: [3] }], risks: [], sources: [{ url: "https://a.example/" }] }, { "https://a.example/": "pay in 2026 was 85,000" });
  ok(d.r1.some((x) => /summary\[0\]/.test(x)) && d.r1.some((x) => /conditions\[0\]/.test(x)) && d.r1.some((x) => /90,000/.test(x)) && !d.r1.some((x) => /2026/.test(x)));
});
