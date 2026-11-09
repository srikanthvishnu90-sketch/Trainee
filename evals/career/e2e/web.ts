// The e2e eval's stub web (release 9, workstream F): the only web pages the research area can read. One made-up host per research
// task under .e2e.test (no real host serves them; every real host stays unreachable in the eval), each with a home page that states
// the figures a brief should cite and an /about page with the conditions and risks. Every company, figure and quote here is
// synthetic, written for the eval. The research tool reaches them the way it reaches a company site without a search key
// (research_search.ts firstPartyProvider: https://<site>/ and https://<site>/about), so the brief cites them through the
// product's own fetch, guard and file paths.
// The page text is plain sentences: one claim each, a figure in every home-page sentence after the first, none in the
// /about sentences (the fake model's research draft, fake_model.ts, keeps a sentence with a figure as a cited fact and one
// without as Trainee's reading).

export interface StubPage { title: string; home: string[]; about: string[] }
export const STUB_WEB: Record<string, StubPage> = {
  "chicago-analyst-market.e2e.test": {
    title: "Data analyst job market in Chicago",
    home: ["Data analyst hiring in Chicago is steady and favors candidates who know SQL.", "Chicago employers posted 4,200 data analyst openings in the last year.", "The median data analyst salary in Chicago is $78,000.", "About 35% of Chicago data analyst postings accept a bachelor's degree with no prior experience."],
    about: ["Demand holds if Chicago finance and healthcare firms keep growing their data teams.", "A slowdown in consulting hiring could shrink the number of entry-level data analyst roles in Chicago."],
  },
  "stripe-new-grads.e2e.test": {
    title: "Stripe as an employer for new grads",
    home: ["Stripe hires new grads into engineering, data and operations teams.", "Stripe employs about 8,000 people across 20 offices.", "Stripe's new grad program took in 300 graduates last year.", "New grad engineers at Stripe start at a base salary of $165,000."],
    about: ["Stripe stays a strong first job if payments volume keeps rising.", "A hiring freeze at Stripe would cut the new grad intake first."],
  },
  "austin-backend-market.e2e.test": {
    title: "New grad backend roles in Austin",
    home: ["The Austin market for new grad backend engineers is competitive but growing.", "Austin had 1,150 open backend roles for new grads this year.", "The median new grad backend salary in Austin is $112,000.", "Backend openings in Austin grew 12% over the prior year."],
    about: ["Growth continues if large tech employers keep expanding their Austin offices.", "Return-to-office moves elsewhere could pull backend hiring away from Austin."],
  },
  "nyc-financial-analyst-pay.e2e.test": {
    title: "Entry-level financial analyst pay in New York",
    home: ["Entry-level financial analyst pay in New York is among the highest in the country.", "Entry-level financial analysts in New York earn a median base salary of $85,000.", "The top 10% of entry-level financial analysts in New York earn over $110,000.", "First-year bonuses for financial analysts in New York average $9,500."],
    about: ["Pay stays high if New York banks keep competing for analysts.", "A weak deal market could shrink bonuses for financial analysts in New York."],
  },
  "ramp-growth.e2e.test": {
    title: "Ramp's growth and hiring",
    home: ["Ramp is growing fast and hiring across engineering, sales and finance.", "Ramp grew its headcount to 1,000 employees this year.", "Ramp's annualized revenue passed $700 million.", "Ramp has 140 open roles on its careers page."],
    about: ["Hiring keeps pace if Ramp keeps winning mid-size business customers.", "Tighter venture funding could slow Ramp's hiring plans."],
  },
  "chicago-frontend-internships.e2e.test": {
    title: "Frontend internship market in Chicago",
    home: ["Frontend internships in Chicago are spread across startups, agencies and large firms.", "Chicago companies posted 620 frontend internship openings this season.", "Frontend interns in Chicago earn a median of $28 per hour.", "About 40% of Chicago frontend internships ask for a React project."],
    about: ["The frontend internship market holds if Chicago startups keep raising money.", "A drop in agency work could cut frontend internship openings in Chicago."],
  },
  "stripe-vs-ramp.e2e.test": {
    title: "Stripe and Ramp as places to start a career",
    home: ["Stripe and Ramp both hire early-career people, at very different sizes.", "Stripe has about 8,000 employees and Ramp has about 1,000.", "Stripe's new grad program took in 300 graduates last year while Ramp hired 60 new grads.", "Ramp's headcount grew 45% this year compared with 5% at Stripe."],
    about: ["Ramp suits someone who wants broad scope early if its growth continues.", "Stripe suits someone who wants structured training, unless its hiring slows."],
  },
  "chicago-analyst-employers.e2e.test": {
    title: "Employers hiring data analysts in Chicago",
    home: ["Stripe, Lumen and Mosaic are among the companies hiring data analysts in Chicago.", "Stripe employs about 8,000 people and lists 25 data roles.", "Lumen has 1,200 employees and is hiring 6 data analysts in Chicago.", "Mosaic has 450 employees and opened 4 analyst roles this quarter."],
    about: ["These employers stay good bets if their data teams keep growing.", "A pullback in fintech funding could slow hiring at the smaller companies."],
  },
  "chicago-data-science-interns.e2e.test": {
    title: "Data science intern market in Chicago",
    home: ["The data science intern market in Chicago is mid-sized and concentrated in finance.", "Chicago employers posted 900 data science internship openings this year.", "Data science interns in Chicago earn a median of $32 per hour.", "About 55% of Chicago data science internships are at trading or insurance firms."],
    about: ["The market grows if Chicago trading firms keep expanding their research teams.", "A downturn in finance would hit data science internships in Chicago hardest."],
  },
  "nyc-ib-summer-analyst.e2e.test": {
    title: "Investment banking summer analyst programs in New York",
    home: ["Investment banking summer analyst programs in New York are highly selective.", "The largest New York banks hire about 2,400 summer analysts each year.", "Summer analysts in investment banking in New York earn a pro-rated $110,000 salary.", "About 75% of investment banking summer analysts receive a full-time return offer."],
    about: ["Return offers stay common if deal volume in New York holds up.", "A weak year for mergers could cut summer analyst classes at investment banks."],
  },
};
// The scaled set's pages (generate.ts): one made-up host per research task, added before the run reads them.
export function addStubPages(pages: Record<string, StubPage>) { for (const [h, pg] of Object.entries(pages)) if (/\.e2e\.test$/.test(h)) STUB_WEB[h] = pg; }
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const page = (title: string, lines: string[]) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><main><h1>${esc(title)}</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join("")}</main></body></html>`;
export const isStubWebHost = (host: string) => Object.prototype.hasOwnProperty.call(STUB_WEB, host);
// The stub site's answer: GET / or /about on a listed host; anything else 404.
export function stubWebFetch(req: Request): Response {
  const u = new URL(req.url), site = STUB_WEB[u.hostname];
  if (!site || req.method !== "GET" || u.protocol !== "https:") return new Response("not found", { status: 404 });
  if (u.pathname === "/") return new Response(page(site.title, site.home), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  if (u.pathname === "/about") return new Response(page(`About: ${site.title}`, site.about), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  return new Response("not found", { status: 404 });
}

// ---------------------------------------------------------------- the free first-party sources (R9 free sources, 2026-11-08)
// One small synthetic fixture per free source (research_free_sources.ts), so each appears in at least one eval brief: BLS OEWS
// (national and metro) and OOH pages, USAJOBS, SEC EDGAR (10-K and full-text search), the four ATS board APIs, Wikipedia and
// Wikidata, a GitHub org, and GDELT's news RSS. Every company, figure and headline is made up for the eval and marked so; the
// addresses are the real sources' own, answered here and never fetched (nothing else is reachable in the eval).
const J = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
const H = (title: string, lines: string[]) => new Response(page(title, lines), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
const NOTE = "(synthetic eval fixture)";
const OES: Record<string, [string, string, string]> = { // SOC: [title, national median, national mean]
  "151252": ["Software Developers", "$131,450", "$144,570"], "132051": ["Financial and Investment Analysts", "$101,350", "$116,210"], "152051": ["Data Scientists", "$112,590", "$124,870"],
};
const METRO: Record<string, [string, Record<string, string>]> = { // CBSA: [area, SOC -> annual median]
  "35620": ["New York-Newark-Jersey City, NY-NJ", { "151252": "$158,200", "132051": "$124,600", "152051": "$139,800" }],
  "12420": ["Austin-Round Rock-San Marcos, TX", { "151252": "$136,900", "132051": "$97,300", "152051": "$118,400" }],
  "12060": ["Atlanta-Sandy Springs-Roswell, GA", { "151252": "$127,300", "132051": "$95,100", "152051": "$109,700" }],
  "41860": ["San Francisco-Oakland-Fremont, CA", { "151252": "$187,500", "132051": "$141,900", "152051": "$162,300" }],
};
const OOH_PAGES: Record<string, [string, string[]]> = {
  "/ooh/computer-and-information-technology/software-developers.htm": ["Software Developers, Quality Assurance Analysts, and Testers", ["Employment of software developers is projected to grow 15 percent from 2024 to 2034 " + NOTE + ".", "Software developers typically need a bachelor's degree in computer and information technology or a related field."]],
  "/ooh/business-and-financial/financial-analysts.htm": ["Financial Analysts", ["Employment of financial analysts is projected to grow 9 percent from 2024 to 2034 " + NOTE + ".", "Financial analysts typically need a bachelor's degree in finance, accounting or economics."]],
  "/ooh/math/data-scientists.htm": ["Data Scientists", ["Employment of data scientists is projected to grow 34 percent from 2024 to 2034 " + NOTE + ".", "Data scientists typically need at least a bachelor's degree in mathematics, statistics or computer science."]],
};
const USAJOBS: Record<string, [number, any[]]> = {
  "2210": [184, [{ positionTitle: "IT Specialist (APPSW)", hiringAgencyName: "Department of Synthetic Affairs " + NOTE, minimumSalary: 74000, maximumSalary: 117000, positionLocations: [{ positionLocationCity: "Atlanta", positionLocationState: "Georgia" }] }]],
  "1160": [37, [{ positionTitle: "Financial Analyst", hiringAgencyName: "Office of Example Budgets " + NOTE, minimumSalary: 68000, maximumSalary: 106000, positionLocations: [{ positionLocationCity: "New York", positionLocationState: "New York" }] }]],
  "1560": [22, [{ positionTitle: "Data Scientist", hiringAgencyName: "Bureau of Placeholder Statistics " + NOTE, minimumSalary: 86000, maximumSalary: 134000, positionLocations: [{ positionLocationCity: "Washington", positionLocationState: "District of Columbia" }] }]],
};
const role = (title: string, location: string) => ({ title, location });
const BOARDS: Record<string, { ats: string; roles: { title: string; location: string }[] }> = {
  silverpinerobotics: { ats: "greenhouse", roles: [role("Robotics Software Engineer, New Grad", "Pittsburgh, PA"), role("Controls Engineer", "Pittsburgh, PA"), role("Manufacturing Engineering Intern", "Austin, TX"), role("Field Service Technician", "Remote")] },
  deltabayfreight: { ats: "lever", roles: [role("Operations Analyst, Early Career", "Oakland, CA"), role("Logistics Coordinator", "Oakland, CA"), role("Account Manager", "Seattle, WA")] },
  hollowoaklogistics: { ats: "ashby", roles: [role("Junior Data Analyst", "Chicago, IL"), role("Warehouse Systems Engineer", "Chicago, IL"), role("Product Manager", "Remote")] },
  redwoodcapital: { ats: "smartrecruiters", roles: [role("Investment Analyst, Associate", "New York, NY"), role("Fund Accountant", "New York, NY"), role("Compliance Officer", "Boston, MA")] },
};
const WIKI_ORGS: Record<string, { q: string; desc: string; lines: string[]; employees: number; at: string; founded: string; site: string }> = {
  "Silverpine_Robotics": { q: "Q99000101", desc: "fictional American robotics company " + NOTE, lines: ["Silverpine Robotics is a robotics company based in Pittsburgh " + NOTE + ".", "Silverpine Robotics was founded in 2014 by three engineering graduates.", "In 2025 Silverpine Robotics shipped 1,800 warehouse robots."], employees: 1250, at: "2025", founded: "2014", site: "https://silverpine.example" },
};
const GH_ORGS: Record<string, any> = { deltabayfreight: { login: "deltabayfreight", name: "Delta Bay Freight", public_repos: 23, blog: "https://deltabayfreight.example", location: "Oakland, CA", description: "Open source routing tools " + NOTE, created_at: "2018-05-02T00:00:00Z" } };
const NEWS: Record<string, { title: string; link: string; date: string }[]> = {
  "Delta Bay Freight": [{ title: "Delta Bay Freight adds 120 jobs at its Oakland hub " + NOTE, link: "https://news.example/delta-bay-freight-oakland", date: "Mon, 03 Nov 2026 09:00:00 GMT" }, { title: "Delta Bay Freight opens a graduate program for 2027 " + NOTE, link: "https://news.example/delta-bay-graduates", date: "Thu, 23 Oct 2026 14:00:00 GMT" }],
};
const SEC_CO = { cik: 9990001, ticker: "HOAK", title: "HOLLOW OAK LOGISTICS INC" };
const SEC_10K = `https://www.sec.gov/Archives/edgar/data/${SEC_CO.cik}/000999000126000002/hoak-10k.htm`, SEC_8K = `https://www.sec.gov/Archives/edgar/data/${SEC_CO.cik}/000999000126000007/hoak-8k.htm`;
const rss = (items: { title: string; link: string; date: string }[]) => new Response(`<?xml version="1.0"?><rss version="2.0"><channel><title>GDELT</title>${items.map((i) => `<item><title>${esc(i.title)}</title><link>${esc(i.link)}</link><pubDate>${i.date}</pubDate></item>`).join("")}</channel></rss>`, { status: 200, headers: { "content-type": "application/rss+xml" } });
export const FREE_FIXTURE_HOSTS = new Set(["www.bls.gov", "data.usajobs.gov", "www.sec.gov", "data.sec.gov", "efts.sec.gov", "boards-api.greenhouse.io", "api.lever.co", "api.ashbyhq.com", "api.smartrecruiters.com", "en.wikipedia.org", "www.wikidata.org", "api.github.com", "api.gdeltproject.org"]);
export const isFreeFixtureHost = (host: string) => FREE_FIXTURE_HOSTS.has(host.toLowerCase());
// Does this address belong to the fixtures? boards-api.greenhouse.io is shared with the stub ATS (worlds.ts), which answers every
// posting the apply path checks there: only the fixture boards' own paths are research fixtures.
export function servesFreeFixture(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (!isFreeFixtureHost(host)) return false;
  if (host === "boards-api.greenhouse.io") return BOARDS[decodeURIComponent(url.pathname.split("/")[3] ?? "")]?.ats === "greenhouse";
  return true;
}
export function freeFixtureFetch(req: Request): Response {
  const u = new URL(req.url), host = u.hostname, p = u.pathname, nf = () => new Response("not found", { status: 404 });
  if (req.method !== "GET" || u.protocol !== "https:" || p === "/robots.txt") return nf();
  if (host === "www.bls.gov") {
    let m = /^\/oes\/current\/oes(\d{6})\.htm$/.exec(p);
    if (m && OES[m[1]]) { const [t, med, mean] = OES[m[1]]; return H(`${t} - Occupational Employment and Wages`, [`National estimates for ${t}.`, `The annual median wage for ${t} is ${med} ${NOTE}.`, `The annual mean wage for ${t} is ${mean} ${NOTE}.`]); }
    m = /^\/oes\/current\/oes_(\d{5})\.htm$/.exec(p);
    if (m && METRO[m[1]]) { const [area, by] = METRO[m[1]]; return H(`${area} - May 2025 Metropolitan Area Occupational Employment and Wage Estimates`, Object.entries(by).map(([soc, med]) => `${OES[soc][0]} in the ${area} metro area earn an annual median wage of ${med} ${NOTE}.`)); }
    const o = OOH_PAGES[p]; return o ? H(`${o[0]} : Occupational Outlook Handbook`, o[1]) : nf();
  }
  if (host === "data.usajobs.gov" && p === "/api/historicjoa") { const x = USAJOBS[u.searchParams.get("PositionSeries") ?? ""]; return x ? J({ paging: { metadata: { totalCount: x[0] } }, data: x[1] }) : J({ paging: { metadata: { totalCount: 0 } }, data: [] }); }
  if (host === "www.sec.gov" && p === "/files/company_tickers.json") return J({ 0: { cik_str: SEC_CO.cik, ticker: SEC_CO.ticker, title: SEC_CO.title } });
  if (host === "data.sec.gov" && p === `/submissions/CIK${String(SEC_CO.cik).padStart(10, "0")}.json`) return J({ filings: { recent: { form: ["8-K", "10-K"], accessionNumber: ["0009990001-26-000007", "0009990001-26-000002"], primaryDocument: ["hoak-8k.htm", "hoak-10k.htm"] } } });
  if (host === "efts.sec.gov" && /Hollow Oak Logistics/i.test(u.searchParams.get("q") ?? "")) return J({ hits: { hits: [{ _id: "0009990001-26-000007:hoak-8k.htm", _source: { ciks: ["0009990001"], display_names: ["Hollow Oak Logistics Inc (HOAK) (CIK 0009990001)"], form: "8-K", file_date: "2026-10-14" } }] } });
  if (host === "efts.sec.gov") return J({ hits: { hits: [] } });
  if (u.href === SEC_10K) return H("Hollow Oak Logistics Inc. Form 10-K", ["Hollow Oak Logistics had 3,900 full-time employees at the end of the fiscal year " + NOTE + ".", "Hollow Oak Logistics operates 14 distribution centers in the Midwest " + NOTE + "."]);
  if (u.href === SEC_8K) return H("Hollow Oak Logistics Inc. Form 8-K", ["Hollow Oak Logistics announced a new Chicago automation center with 250 roles " + NOTE + "."]);
  const slug = decodeURIComponent(p.split("/")[3] ?? ""), b = BOARDS[slug];
  if (host === "boards-api.greenhouse.io" && b?.ats === "greenhouse" && p.endsWith("/jobs")) return J({ jobs: b.roles.map((r) => ({ title: r.title, location: { name: r.location } })), meta: { total: b.roles.length } });
  if (host === "api.lever.co" && b?.ats === "lever") return J(b.roles.map((r) => ({ text: r.title, categories: { location: r.location } })));
  if (host === "api.ashbyhq.com" && b?.ats === "ashby") return J({ jobs: b.roles.map((r) => ({ title: r.title, location: r.location, isListed: true })) });
  if (host === "api.smartrecruiters.com" && b?.ats === "smartrecruiters") { return J({ totalFound: b.roles.length, content: b.roles.map((r) => ({ name: r.title, location: { city: r.location.split(", ")[0], region: r.location.split(", ")[1], country: "us" } })) }); }
  if (host === "en.wikipedia.org") {
    const m = /^\/api\/rest_v1\/page\/summary\/(.+)$/.exec(p), w = WIKI_ORGS[decodeURIComponent(m?.[1] ?? p.replace(/^\/wiki\//, ""))];
    if (!w) return nf();
    const t = decodeURIComponent(m?.[1] ?? p.replace(/^\/wiki\//, "")).replace(/_/g, " ");
    return m ? J({ type: "standard", title: t, description: w.desc, extract: w.lines[0], content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, "_"))}` } }, wikibase_item: w.q }) : H(`${t} - Wikipedia`, w.lines);
  }
  if (host === "www.wikidata.org") {
    const w = Object.values(WIKI_ORGS).find((x) => p === `/wiki/Special:EntityData/${x.q}.json`), name = Object.keys(WIKI_ORGS).find((k) => WIKI_ORGS[k] === w)?.replace(/_/g, " ");
    return w ? J({ entities: { [w.q]: { id: w.q, labels: { en: { value: name } }, descriptions: { en: { value: w.desc } }, claims: {
      P1128: [{ rank: "normal", mainsnak: { datavalue: { value: { amount: `+${w.employees}` } } }, qualifiers: { P585: [{ datavalue: { value: { time: `+${w.at}-00-00T00:00:00Z` } } }] } }],
      P571: [{ rank: "normal", mainsnak: { datavalue: { value: { time: `+${w.founded}-01-01T00:00:00Z` } } } }], P856: [{ rank: "normal", mainsnak: { datavalue: { value: w.site } } }] } } } }) : nf();
  }
  if (host === "api.github.com") { const g = GH_ORGS[decodeURIComponent(p.replace(/^\/orgs\//, ""))]; return g ? J(g) : nf(); }
  if (host === "api.gdeltproject.org") { const q = (u.searchParams.get("query") ?? "").replace(/"/g, ""), n = NEWS[q]; return n ? rss(n) : nf(); }
  return nf();
}
