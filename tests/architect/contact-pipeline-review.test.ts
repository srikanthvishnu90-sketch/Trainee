// CONTACT OUTREACH (proposal D-042), review regressions for PR #590. Each test reproduces one review finding and fails on
// the code before its fix:
//   1. pages a discovery search found (a news site, a conference site) are read: the gate admits their hosts (robots.txt,
//      public DNS) instead of refusing every host it was not told about up front;
//   2. one published address is one piece of evidence, however many pages or parsers repeat it;
//   3. an unknown answer to the catch-all probe never lets an accepted address score 80;
//   4. a GitHub profile counts only for the same person at the same company, and a blog or email on the company's domain
//      means that host, not a string that contains it;
//   5. a published or GitHub address on another domain gets that domain's MX checked, and no mail server means no approval;
//   6. an ATS host (any of them, Teamtailor included) is never taken for the employer's domain.
import assertNode from "node:assert/strict";
import type { Fetcher } from "../../supabase/functions/_shared/contact_sources/web_gate.ts";
import { contactGate, contactUserAgent, githubFacts, PoliteApi } from "../../supabase/functions/_shared/career_contact_sources.ts";
import { findEmail, learnFormat, type RcptProbe } from "../../supabase/functions/_shared/career_contact_email.ts";
import { domainOf, resolveContact } from "../../supabase/functions/_shared/career_contact_pipeline.ts";
import { MX_NOT_WIRED } from "../../supabase/functions/_shared/career_contacts.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const NOW = Date.parse("2026-11-07T15:00:00Z");
const UA = contactUserAgent("owner@trainee.dev");
const mx = (hosts: Record<string, string[]>) => (d: string) => Promise.resolve(hosts[d] ? { status: "ok" as const, hosts: hosts[d] } : { status: "none" as const });

const TEAM = `<html><head><title>Acme team</title></head><body>
<div class="team-member"><h3 class="name">Jane Doe</h3><p class="title">VP Engineering</p></div></body></html>`;
const NEWS = `<html><head><title>Acme raises Series B</title><meta property="article:published_time" content="2026-03-02T10:00:00Z"></head>
<body><p>Acme raised $40M on Tuesday. Jane Doe, VP Engineering at Acme, said the money goes to the API platform.</p></body></html>`;
const SPEAKERS = `<html><head><title>APIConf 2026 speakers</title></head><body><div class="speaker"><h3 class="name">Jane Doe</h3><p class="title">VP Engineering, Acme</p></div></body></html>`;

Deno.test("contact review 1: pages a discovery search found are read (hosts admitted through robots and public DNS)", async () => {
  const pages: Record<string, string> = { "https://acme.io/team": TEAM, "https://news.example.org/acme-series-b": NEWS, "https://apiconf.example.com/speakers": SPEAKERS };
  const seen: string[] = [];
  const fetcher: Fetcher = (url) => {
    seen.push(url);
    if (url.endsWith("/robots.txt")) return Promise.resolve({ status: 200, url, text: "User-agent: *\nAllow: /\n" });
    if (url in pages) return Promise.resolve({ status: 200, url, text: pages[url] });
    return Promise.resolve({ status: 404, url, text: "" });
  };
  const search = (q: string) => Promise.resolve({ status: "ok" as const, cost_usd: 0, urls: q.endsWith("speaker")
    ? [{ url: "https://apiconf.example.com/speakers", title: "" }]
    : [{ url: "https://news.example.org/acme-series-b", title: "" }, { url: "https://internal.example.net/acme", title: "" }] });
  // Public answers for the found hosts; a private one for a host that resolves inside a network.
  const resolver = (h: string) => Promise.resolve(h === "internal.example.net" ? ["10.0.0.5"] : ["93.184.216.34"]);
  // The gate is told only the employer's domain: no found host is listed in advance.
  const gate = contactGate({ fetcher, userAgent: UA, domain: "acme.io", org: "Acme", now: () => NOW, sleep: async () => {}, resolver });
  const api = new PoliteApi({ fetcher, userAgent: UA, now: () => NOW, sleep: async () => {} });
  const r = await resolveContact({ company: "Acme", domain: "acme.io", title: "VP Engineering" }, { gate, api, mx: mx({ "acme.io": ["mx1.mailhost.example"] }), now: () => NOW, search });
  ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  const types = new Set(r.facts.map((f) => f.source_type));
  ok(types.has("news"), `a fact from the news page the search found: ${JSON.stringify(r.facts.map((f) => f.source_type))}`);
  ok(types.has("conference"), "a fact from the speaker page the search found");
  const robots = seen.indexOf("https://news.example.org/robots.txt"), page = seen.indexOf("https://news.example.org/acme-series-b");
  ok(robots >= 0 && robots < page, "robots.txt is read on a found host before its page");
  ok(!seen.includes("https://internal.example.net/acme"), "a found host whose DNS answer is private is never fetched");

  // Without a DNS resolver nothing is admitted: a found host cannot be checked as public, so it stays unread.
  const seen2: string[] = [];
  const f2: Fetcher = (url, init) => { seen2.push(url); return fetcher(url, init); };
  const g2 = contactGate({ fetcher: f2, userAgent: UA, domain: "acme.io", org: "Acme", now: () => NOW, sleep: async () => {} });
  await resolveContact({ company: "Acme", domain: "acme.io", title: "VP Engineering" }, { gate: g2, api: new PoliteApi({ fetcher: f2, userAgent: UA, now: () => NOW, sleep: async () => {} }), mx: mx({}), now: () => NOW, search });
  ok(!seen2.some((u) => u.startsWith("https://news.example.org/")), "no resolver: no found host is read");
});

Deno.test("contact review 2: one published address counts once toward the domain's format", () => {
  const john = { email: "john.roe@acme.io", name: "John Roe" };
  eq(learnFormat([john, john], "acme.io"), null, "the same address twice is still one address");
  eq(learnFormat([john, { ...john, email: "John.Roe@acme.io" }], "acme.io"), null, "case does not make a second address");
  eq(learnFormat([john, { email: "mary.major@acme.io", name: "Mary Major" }], "acme.io"), { format: "first.last", evidence: 2 });
});

Deno.test("contact review 3: an unknown catch-all answer never approves an accepted address", async () => {
  const named = [{ email: "john.roe@acme.io", name: "John Roe" }, { email: "mary.major@acme.io", name: "Mary Major" }];
  const asked: string[] = [];
  const probe: RcptProbe = { name: "stub", on: true, probe: (e) => { asked.push(e); return Promise.resolve(e === "jane.doe@acme.io" ? "accept" : "unknown"); } };
  const r = await findEmail({ name: "Jane Doe", domain: "acme.io", now: NOW, domainNamed: named, mx: mx({ "acme.io": ["mx.other.example"] }), probe, random: () => "zz9random" });
  eq([r.method, r.score, r.approvable, r.catch_all], ["pattern_unverified", 50, false, null], JSON.stringify(r));
  eq(asked, ["zz9random@acme.io"], "the person's address is not probed when the catch-all check is unknown");
  const rejecting: RcptProbe = { name: "stub", on: true, probe: (e) => Promise.resolve(e === "jane.doe@acme.io" ? "accept" : "reject") };
  const v = await findEmail({ name: "Jane Doe", domain: "acme.io", now: NOW, domainNamed: named, mx: mx({ "acme.io": ["mx.other.example"] }), probe: rejecting });
  eq([v.method, v.score, v.approvable, v.catch_all, v.rcpt], ["pattern_rcpt_valid", 80, true, false, "accept"], "a rejected made-up address, then an accepted one: 80");
});

Deno.test("contact review 4: GitHub profiles match the same person at the same company, by host", async () => {
  const run = async (user: Record<string, unknown>) => {
    const json: Record<string, unknown> = {
      "https://api.github.com/search/users?q=Jane%20Doe%20in%3Aname&per_page=3": { items: [{ login: "janedoe" }] },
      "https://api.github.com/users/janedoe": { login: "janedoe", name: "Jane Doe", blog: "", email: null, bio: "Engineer", ...user },
      "https://api.github.com/users/janedoe/repos?sort=pushed&per_page=5": [],
    };
    const fetcher: Fetcher = (url) => Promise.resolve(url in json ? { status: 200, url, text: JSON.stringify(json[url]) } : { status: 404, url, text: "" });
    return await githubFacts(new PoliteApi({ fetcher, userAgent: UA, now: () => NOW, sleep: async () => {} }), "Jane Doe", "Acme", "acme.io");
  };
  eq((await run({ company: "Acme Analytics", email: "jane@acmeanalytics.com" })).run.status, "none", "another company that starts with the same word is not Acme");
  eq((await run({ name: "Jane Doe-Smith", company: "@acme" })).run.status, "none", "a longer name is another person");
  eq((await run({ company: null, blog: "https://acme.io.other.org" })).run.status, "none", "a blog host that merely contains acme.io is not on it");
  eq((await run({ company: null, email: "jane@acme.io.other.org" })).email, null, "an email domain that merely contains acme.io is not on it");
  eq((await run({ company: null, blog: "https://eng.acme.io/jane" })).run.status, "ok", "a blog on a subdomain of acme.io counts");
  eq((await run({ company: "Acme, Inc." })).run.status, "ok", "the same company with a legal suffix counts");
});

Deno.test("contact review 5: an address on another domain gets that domain's MX; no mail server means no approval", async () => {
  const gh = { email: "jane@janedoe.dev", source_url: "https://github.com/janedoe" };
  const none = await findEmail({ name: "Jane Doe", domain: "acme.io", now: NOW, github: gh, mx: mx({ "acme.io": ["mx.other.example"] }) });
  ok(none.email !== gh.email && none.method !== "github_public" && !none.approvable, `an off-domain GitHub email is never used, the employer's MX never borrowed for it: ${JSON.stringify(none)}`);
  ok(/not on acme\.io/.test(none.why), `refused with its reason: ${none.why}`);
  const pub = await findEmail({ name: "Jane Doe", domain: "acme.io", now: NOW, published: [{ email: "jane@acme-mail.net", source_url: "https://acme.io/team" }], mx: mx({ "acme.io": ["mx.other.example"] }) });
  eq([pub.mx, pub.approvable], ["fail", false], "a published address on a domain with no mail server is not approvable");
  const good = await findEmail({ name: "Jane Doe", domain: "acme.io", now: NOW, github: gh, mx: mx({ "janedoe.dev": ["aspmx.l.google.com"] }) });
  ok(good.email !== gh.email && good.method !== "github_public" && good.score < 70 && !good.approvable, `a working mail server on another domain still does not make it the corporate address: ${JSON.stringify(good)}`);
  ok(/not on acme\.io/.test(good.why), `refused with its reason: ${good.why}`);
  const dnsDown = await findEmail({ name: "Jane Doe", domain: "acme.io", now: NOW, github: gh, mx: MX_NOT_WIRED });
  eq([dnsDown.mx, dnsDown.approvable], ["unknown", false], "an MX that could not be checked is not approvable");
});

Deno.test("contact review 6: no ATS host is ever the employer's domain", () => {
  eq(domainOf({ url: "https://acme.teamtailor.com/jobs/123" }), null, "Teamtailor");
  for (const u of ["https://acme.jobs.personio.de/job/1", "https://acme.pinpointhq.com/jobs/1", "https://acme.applytojob.com/apply/1", "https://jobs.dover.com/acme/1", "https://acme.recruitee.com/o/x"]) eq(domainOf({ apply_url: u }), null, u);
  eq(domainOf({ url: "https://acme.teamtailor.com/jobs/123", company_url: "https://www.acme.io" }), "acme.io", "the company's own URL still wins");
  eq(domainOf({ apply_url: "https://careers.acme.io/jobs/1" }), "acme.io", "the employer's own careers host");
});
