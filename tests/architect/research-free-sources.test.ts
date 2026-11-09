// deno-lint-ignore-file no-explicit-any require-await
// R9 free sources (owner, 2026-11-08; split 2/4 of #615 on 2026-11-09): the no-key sources and the reader. The never-list on any
// TLD, robots.txt, JSON/RSS answers turned into sentences by code, every free source proposed with no search key, and the gaps
// that say what no free source had. Fake web, fake resolver: no network, no spend. Every company, figure and page is synthetic.
// The test bodies are #615's, unchanged; the synthetic web moved to tests/helpers/research_free_web.ts.
import assertNode from "node:assert/strict";
import { fetchSources, isBlockedHost } from "../../supabase/functions/_shared/research_sources.ts";
import { boardText, cbsaFor, convertFree, freeProvider, freeReader, OOH, researchSearchFor, robotsGate, slugsFor, socFor } from "../../supabase/functions/_shared/research_free_sources.ts";
import { GH_JOBS, GH_ORG, html, NOW, PUBLIC, RSS, WD, freeWeb } from "../helpers/research_free_web.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

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
  const none = await freeProvider({ fetch: freeWeb(), now: () => NOW, userAgent: null }).search({ queries: ["how much does a zookeeper make at Quillmont"], companies: ["Quillmont"] });
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

// ---------------------------------------------------------------- architect follow-ups on #615 (2026-11-08)
Deno.test("pay with no SOC: the role is matched to a BLS occupation (and the city to its metro), and the brief says which", async () => {
  eq(socFor("research software engineer pay in New York")?.soc, "15-1252");
  eq(socFor("¿cuánto gana un data scientist junior en Atlanta?")?.soc, "15-2051");
  eq(socFor("what do entry-level financial analysts earn"), { soc: "13-2051", title: "financial analyst", said: "financial analysts" });
  eq(socFor("what does a zookeeper earn"), null);
  eq(cbsaFor("pay in New York"), { cbsa: "35620", city: "New York" });
  const out = await freeProvider({ fetch: freeWeb(), now: () => NOW, userAgent: null }).search({ queries: ["research software engineer pay in Atlanta"] });
  ok(out.hits.some((h) => h.url === "https://www.bls.gov/oes/current/oes151252.htm") && out.hits.some((h) => h.url === "https://www.bls.gov/oes/current/oes_12060.htm"));
  eq(out.basis, ['Pay figures use BLS occupation 15-1252 (software developers), matched from "software engineer" with Trainee\'s table of BLS job titles, and the Atlanta metro area (CBSA 12060).']);
  ok(!(out.gaps ?? []).some((g) => /No government pay figure/.test(g)));
  // Not a pay question: no occupation is guessed. A code the turn gave is never replaced.
  eq((await freeProvider({ fetch: freeWeb(), now: () => NOW, userAgent: null }).search({ queries: ["make me a file on data analyst hiring in Denver"] })).basis, undefined);
  ok((await freeProvider({ fetch: freeWeb(), now: () => NOW, userAgent: null }).search({ queries: ["software engineer pay"], soc: "15-1254" })).hits.some((h) => /oes151254/.test(h.url)));
});

Deno.test("gap lines are grouped: one line per source naming every company it had nothing for", async () => {
  const out = await freeProvider({ fetch: freeWeb(), now: () => NOW, userAgent: null }).search({ queries: ["compare Quillmont and Brasswick"], companies: ["Quillmont", "Brasswick"] });
  eq(out.gaps!.filter((g) => /job board/.test(g)), ["No public Greenhouse, Lever, Ashby or SmartRecruiters job board was found for Quillmont or Brasswick, so open roles were not counted."]);
  eq(out.gaps!.filter((g) => /Wikipedia/.test(g)), ["Wikipedia has no company article found for Quillmont or Brasswick."]);
});

// The free reader resolves every page itself (review of #589): built without a resolver it uses the system one.
Deno.test("free reader: built without a resolver, every page is resolved by the system resolver; a private answer refuses it", async () => {
  const f = (async () => html("t", "a public page")) as typeof fetch;
  const real = Deno.resolveDns;
  try {
    (Deno as any).resolveDns = async (_h: string, t: string) => (t === "A" ? ["10.1.2.3"] : []);
    eq((await freeReader({ fetch: f, now: () => NOW, probe: async () => ({ ok: true, why: "stub" }) })(["https://looks-public.example/"])).rejected.map((r) => r.why), ["private_address"]);
  } finally { (Deno as any).resolveDns = real; }
});

