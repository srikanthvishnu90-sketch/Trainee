// deno-lint-ignore-file require-await
// Item 10 loop (k-research): a synthetic company web whose facts are known, for tests/architect/loop-10-research.test.ts. Five made-up
// companies on *.example hosts; every page sentence is listed here with what it measures (volume, forecast, revenue, plain), so the
// scorer can trace each line of a brief to an inspected source without trusting the product's own guards. Nothing here is fetched
// from a real site; every company, figure and page is synthetic.
export const NOW = Date.parse("2026-11-10T15:00:00Z");
export type Kind = "volume" | "forecast" | "revenue" | "plain";
export interface Sentence { text: string; kind: Kind }
export interface Page { url: string; title: string; date: string | null; sentences: Sentence[]; by: "company" | "reported" }
export interface Tension { area: string; area_quote: string; a: string; b: string; url: string }
export interface Company {
  key: string; name: string; host: string; role: string; products: [string, string];
  pages: Page[]; tensions: Tension[]; competitor: string; notNamed: string; frame: string;
  fcDone: string; vol: Sentence & { fig: string; url: string }; fc: Sentence & { fig: string; url: string }; rev: Sentence & { fig: string; url: string };
}
// Words that no page carries: an invented initiative, metric or launch. Any of them in a brief or a reply is an invention.
export const INVENTED = ["crypto lending", "acceptance rate", "IPO", "layoffs", "Project Atlas", "quantum"];

type Spec = { key: string; name: string; host: string; news: string; role: string; products: [string, string]; newsDate: string; rivalDate: string;
  vol: string; volFig: string; fc: string; fcFig: string; fcDone: string; rev: string; revFig: string; pA: string[]; pB: string[]; tA: Omit<Tension, "url">; tB: Omit<Tension, "url">;
  rolePage: string[]; rival: string; competitor: string; notNamed: string; frame: string };
const SPECS: Spec[] = [
  { key: "lumen", name: "Lumen Pay", host: "lumenpay.example", news: "fintechwire.example", role: "Data analyst intern", products: ["Payouts", "Shield"], newsDate: "March 12, 2026", rivalDate: "October 2, 2026",
    vol: "Businesses on Lumen Pay processed $84 billion in total payment volume in 2025, up 22% from 2024.", volFig: "$84 billion",
    fc: "Lumen Pay expects Payouts to reach a $300 million annual run rate in 2026.", fcFig: "$300 million", fcDone: "Payouts reached a $300 million annual run rate in 2026.",
    rev: "Lumen Pay reported $1.1 billion in net revenue for 2025.", revFig: "$1.1 billion",
    pA: ["Payouts lets online platforms send money to their sellers in 40 countries.", "Platforms can pay sellers instantly or hold payouts until an order is delivered."],
    pB: ["Shield uses machine learning to flag fraudulent payments before they settle.", "Flagging more payments lowers fraud losses but declines more good customers."],
    tA: { area: "paying sellers with Payouts", area_quote: "Platforms can pay sellers instantly or hold payouts until an order is delivered.", a: "paying sellers instantly", b: "holding payouts until an order is delivered" },
    tB: { area: "flagging fraudulent payments with Shield", area_quote: "Shield uses machine learning to flag fraudulent payments before they settle.", a: "lowering fraud losses", b: "declining good customers" },
    rolePage: ["The Data Analyst Intern defines metrics and builds dashboards for the Payouts team.", "The Data Analyst Intern writes SQL against payment data every day."],
    rival: "Lumen Pay competes with Corvid Payments for marketplace payout contracts.", competitor: "Corvid Payments", notNamed: "Harbor Pay",
    frame: "Lumen Pay is easier to understand as payout software for online platforms than as card processing alone." },
  { key: "orbit", name: "Orbit Freight", host: "orbitfreight.example", news: "logisticsdaily.example", role: "Operations analyst", products: ["Dispatch", "Track"], newsDate: "February 3, 2026", rivalDate: "September 14, 2026",
    vol: "Shippers booked $3.2 billion of freight through Orbit Freight in 2025.", volFig: "$3.2 billion",
    fc: "Orbit Freight is on track to move 2 million loads a year by 2027.", fcFig: "2 million", fcDone: "Orbit Freight moves 2 million loads a year.",
    rev: "Orbit Freight had $410 million of revenue in 2025.", revFig: "$410 million",
    pA: ["Dispatch matches truckloads with carriers in minutes.", "Dispatch can book the cheapest carrier or the carrier with the best on-time record."],
    pB: ["Track shows shippers where each load is in real time.", "Track can alert shippers about every late load or only about loads that will miss delivery."],
    tA: { area: "matching truckloads with carriers in Dispatch", area_quote: "Dispatch matches truckloads with carriers in minutes.", a: "booking the cheapest carrier", b: "booking the carrier with the best on-time record" },
    tB: { area: "alerting shippers with Track", area_quote: "Track can alert shippers about every late load or only about loads that will miss delivery.", a: "alerting shippers about every late load", b: "alerting only about loads that will miss delivery" },
    rolePage: ["The Operations Analyst builds weekly reports on carrier on-time performance.", "The Operations Analyst works with the Dispatch team to cut empty miles."],
    rival: "Orbit Freight competes with Ridgeline Logistics for enterprise shippers.", competitor: "Ridgeline Logistics", notNamed: "Convoy Lane",
    frame: "Orbit Freight is easier to understand as a marketplace that matches loads with carriers than as a trucking company." },
  { key: "kestrel", name: "Kestrel Health", host: "kestrelhealth.example", news: "healthbeat.example", role: "Product analyst", products: ["Intake", "Claims"], newsDate: "April 21, 2026", rivalDate: "August 30, 2026",
    vol: "Clinics on Kestrel Health processed 41 million patient visits in 2025.", volFig: "41 million",
    fc: "Kestrel Health plans to reach $250 million in annual recurring revenue in 2027.", fcFig: "$250 million", fcDone: "Kestrel Health reached $250 million in annual recurring revenue.",
    rev: "Kestrel Health reported $180 million in revenue for 2025.", revFig: "$180 million",
    pA: ["Intake lets patients check in on their phone before a visit.", "Shorter intake forms finish faster but collect less history for the doctor."],
    pB: ["Claims sends insurance claims for clinics and tracks each payment.", "Claims flags a claim that is likely to be denied before it is sent.", "Holding a flagged claim for review prevents denials, while sending it at once gets the clinic paid sooner."],
    tA: { area: "checking patients in with Intake", area_quote: "Intake lets patients check in on their phone before a visit.", a: "shorter intake forms", b: "collecting more history for the doctor" },
    tB: { area: "flagging likely denials in Claims", area_quote: "Claims flags a claim that is likely to be denied before it is sent.", a: "holding a flagged claim for review", b: "sending it at once to get the clinic paid sooner" },
    rolePage: ["The Product Analyst measures how many patients finish Intake on their phone.", "The Product Analyst runs experiments on the Claims workflow."],
    rival: "Kestrel Health competes with Meridian Clinic Cloud for mid-size clinics.", competitor: "Meridian Clinic Cloud", notNamed: "Epicure Health",
    frame: "Kestrel Health is easier to understand as clinic operations software than as a health insurer." },
  { key: "tidewater", name: "Tidewater Energy", host: "tidewaterenergy.example", news: "gridreport.example", role: "Data science intern", products: ["HomeCell", "GridShare"], newsDate: "January 15, 2026", rivalDate: "July 8, 2026",
    vol: "Tidewater Energy installed 52,000 home batteries in 2025.", volFig: "52,000",
    fc: "Tidewater Energy aims to install 90,000 home batteries in 2026.", fcFig: "90,000", fcDone: "Tidewater Energy installed 90,000 home batteries in 2026.",
    rev: "Tidewater Energy reported $640 million in sales for 2025.", revFig: "$640 million",
    pA: ["HomeCell stores solar power in a home battery for use at night.", "Discharging HomeCell at peak hours saves more money but wears the battery faster."],
    pB: ["GridShare pays homeowners when their batteries send power to the grid.", "Sending more power to the grid raises GridShare payments but leaves less stored power for the home."],
    tA: { area: "storing solar power with HomeCell", area_quote: "HomeCell stores solar power in a home battery for use at night.", a: "saving more money at peak hours", b: "wearing the battery faster" },
    tB: { area: "paying homeowners through GridShare", area_quote: "GridShare pays homeowners when their batteries send power to the grid.", a: "raising GridShare payments", b: "leaving more stored power for the home" },
    rolePage: ["The Data Science Intern forecasts battery demand for each state.", "The Data Science Intern models battery wear from HomeCell usage data."],
    rival: "Tidewater Energy competes with Brightline Solar for homeowners in California.", competitor: "Brightline Solar", notNamed: "Sunvale Power",
    frame: "Tidewater Energy is easier to understand as a home battery company that earns grid payments than as a solar installer." },
  { key: "quill", name: "Quill Learning", host: "quilllearning.example", news: "edtechtimes.example", role: "Marketing analyst", products: ["Tutor", "Market"], newsDate: "May 6, 2026", rivalDate: "October 20, 2026",
    vol: "Learners spent $620 million in gross merchandise volume on Quill Learning courses in 2025.", volFig: "$620 million",
    fc: "Quill Learning projects 12 million paid learners in 2026.", fcFig: "12 million", fcDone: "Quill Learning has 12 million paid learners in 2026.",
    rev: "Quill Learning reported $95 million of revenue in 2025.", revFig: "$95 million",
    pA: ["Tutor matches learners with a live tutor for each course.", "Cheaper tutors attract more learners, while higher-paid tutors earn higher course ratings."],
    pB: ["Market lets teachers sell their own courses on Quill Learning.", "Quill Learning keeps a share of every course sold on Market."],
    tA: { area: "matching learners with tutors in Tutor", area_quote: "Tutor matches learners with a live tutor for each course.", a: "attracting more learners", b: "higher course ratings" },
    tB: { area: "selling courses on Market", area_quote: "Market lets teachers sell their own courses on Quill Learning.", a: "keeping a share of every course sold", b: "letting teachers sell their own courses" },
    rolePage: ["The Marketing Analyst measures which campaigns bring paid learners to Tutor.", "The Marketing Analyst builds dashboards on course sales in Market."],
    rival: "Quill Learning competes with Lantern Academy for adult learners.", competitor: "Lantern Academy", notNamed: "Pathwise",
    frame: "Quill Learning is easier to understand as a course marketplace that keeps a share of sales than as a school." },
];
const kindOf = (s: Spec, t: string): Kind => t === s.vol ? "volume" : t === s.fc ? "forecast" : t === s.rev ? "revenue" : "plain";
export const COMPANIES: Company[] = SPECS.map((s) => {
  const u = (path: string, host = s.host) => `https://${host}${path}`;
  const page = (url: string, title: string, date: string | null, texts: string[], by: "company" | "reported" = "company"): Page => ({ url, title, date, by, sentences: texts.map((text) => ({ text, kind: kindOf(s, text) })) });
  const pages = [
    page(u("/newsroom/2025-results"), `${s.name} 2025 results`, s.newsDate, [s.vol, s.fc, s.rev]),
    page(u(`/products/${s.products[0].toLowerCase()}`), `${s.products[0]} by ${s.name}`, null, s.pA),
    page(u(`/products/${s.products[1].toLowerCase()}`), `${s.products[1]} by ${s.name}`, null, s.pB),
    page(u("/careers/analyst"), `${s.role} at ${s.name}`, null, s.rolePage),
    page(u(`/${s.key}-rivals`, s.news), `Who ${s.name} competes with`, s.rivalDate, [s.rival], "reported"),
  ];
  const at = (t: string) => pages.find((p) => p.sentences.some((x) => x.text === t))!.url;
  return { key: s.key, name: s.name, host: s.host, role: s.role, products: s.products, pages, competitor: s.competitor, notNamed: s.notNamed, frame: s.frame, fcDone: s.fcDone,
    tensions: [{ ...s.tA, url: at(s.tA.area_quote) }, { ...s.tB, url: at(s.tB.area_quote) }],
    vol: { text: s.vol, kind: "volume", fig: s.volFig, url: pages[0].url }, fc: { text: s.fc, kind: "forecast", fig: s.fcFig, url: pages[0].url }, rev: { text: s.rev, kind: "revenue", fig: s.revFig, url: pages[0].url } };
});
export const companyOf = (name: string) => COMPANIES.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null;
const pageHtml = (p: Page) => `<!doctype html><html><head><title>${p.title}</title></head><body>${p.date ? `<p>${p.date}.</p>` : ""}${p.sentences.map((x) => `<p>${x.text}</p>`).join("")}</body></html>`;
const PAGE_BY_URL = new Map(COMPANIES.flatMap((c) => c.pages.map((p) => [p.url, p] as const)));
export const pageAt = (url: string) => PAGE_BY_URL.get(url.replace(/\/$/, "")) ?? null;

// The fake web: Brave answers with every page of the company the query names (and a never-listed site); pages answer; all else 404s.
export function loopWeb(log: string[] = []) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    log.push(req.url);
    if (url.hostname === "api.search.brave.com") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const c = COMPANIES.find((x) => q.includes(x.name.toLowerCase()) || q.includes(x.key));
      const hits = c ? [...c.pages.map((p) => p.url), "https://www.linkedin.com/company/" + c.key] : [];
      return new Response(JSON.stringify({ web: { results: hits.map((h, i) => ({ url: h, title: `Result ${i + 1}`, description: "search engine text, never stored" })) } }), { headers: { "content-type": "application/json" } });
    }
    const p = pageAt(req.url);
    if (p) return new Response(pageHtml(p), { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
  };
}

// What a capable model drafts from those pages: good lines copied from the pages, and the defects E.5 (items 42-49) names.
export function draftFor(c: Company, o: { questionsOnly: boolean; badFrame: boolean }) {
  const [pA, pB, role, rival] = [c.pages[1], c.pages[2], c.pages[3], c.pages[4]];
  const line = (p: Page, i: number, product?: string) => ({ text: p.sentences[i].text, quote: p.sentences[i].text, url: p.url, ...(product ? { product } : {}) });
  const good = c.tensions.map((t) => ({ area: t.area, area_quote: t.area_quote, a: t.a, b: t.b, urls: [t.url] }));
  const inventedTension = { area: "launching a crypto lending product", area_quote: `${c.name} is launching a crypto lending product.`, a: "growth", b: "risk", urls: [c.pages[0].url] };
  if (o.questionsOnly) return { title: `Questions for ${c.name}`, tensions: [...good, inventedTension], business: [line(pA, 0, c.products[0])] };
  return {
    title: `${c.name} interview brief`,
    frame: o.badFrame ? { text: `${c.name}'s new crypto lending push is the most useful way to read the company for this role.`, urls: [pA.url] } : { text: c.frame, urls: [pA.url, pB.url] },
    business: [line(pA, 0, c.products[0]), line(pB, 0, c.products[1]), { text: c.rev.text, quote: c.rev.text, url: c.rev.url },
      // defects: a forecast stated as a result; volume called revenue
      { text: `${c.name} reached its ${c.fc.fig} goal in 2026.`, quote: c.fc.text, url: c.fc.url },
      { text: `${c.name} earned ${c.vol.fig} of revenue in 2025.`, quote: c.vol.text, url: c.vol.url }],
    products: [{ name: c.products[0], angle: pA.sentences[0].text.split(" ").slice(1, 4).join(" ") }],
    developments: [
      { text: c.vol.text, quote: c.vol.text, url: c.vol.url, date: c.pages[0].date },
      { text: c.fc.text, quote: c.fc.text, url: c.fc.url, date: c.pages[0].date },
      { text: `${c.name} revenue was ${c.vol.fig} in 2025.`, quote: c.vol.text, url: c.vol.url, date: c.pages[0].date }, // volume called revenue
      { text: c.fcDone, quote: c.fc.text, url: c.fc.url, date: c.pages[0].date }, // a forecast as a result
      { text: c.rev.text, quote: c.rev.text, url: c.rev.url, date: "2025-06-01" }, // a date the page does not carry
    ],
    competitors: [{ name: c.competitor, text: rival.sentences[0].text, quote: rival.sentences[0].text, url: rival.url },
      { name: c.notNamed, text: rival.sentences[0].text, quote: rival.sentences[0].text, url: rival.url }], // the quote never names it
    role: [line(role, 0), line(role, 1)],
    tensions: [...good, inventedTension],
    unknowns: ["Which team the role sits on and how it is measured.", "The internship's acceptance rate is 3%."],
  };
}
