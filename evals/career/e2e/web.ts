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
