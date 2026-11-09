// deno-lint-ignore-file no-explicit-any require-await
// R9 free sources, the brief (split 3/4 of #615 on 2026-11-09): the gaps no free source filled are on the page, the cover thesis
// names its sources or says it summarizes them, a long host ends in an ellipsis, a heading or form name is never a fact, and two
// sources that differ on a figure are both shown. Fake web, fake resolver, scripted model: no network, no spend. Every company,
// figure and page is synthetic. The test bodies are #615's, unchanged; the synthetic web is tests/helpers/research_free_web.ts.
import assertNode from "node:assert/strict";
import { disagreementsIn, figuresIn, hasPredicate, type MarketDeps, researchMarket } from "../../supabase/functions/_shared/agent/research/market.ts";
import { bodyHtml, textOf, validateKind } from "../../supabase/functions/_shared/file_kinds.ts";
import { fetchSources, isBlockedHost } from "../../supabase/functions/_shared/research_sources.ts";
import { freeProvider, freeReader } from "../../supabase/functions/_shared/research_free_sources.ts";
import { freeWeb, html, nf, NOW, PUBLIC } from "../helpers/research_free_web.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);

// ---------------------------------------------------------------- end to end: a brief from free sources only
Deno.test("a research brief File from free sources: the ATS count is cited to the board it came from, and the gaps are on the page", async () => {
  const f = freeWeb(), read = freeReader({ fetch: f, resolver: PUBLIC, now: () => NOW }), published: any[] = [];
  const draft = { title: "Zentrafin as a first job", thesis: "Zentrafin hires new grads into engineering.",
    summary: [
      { text: "The Greenhouse job board with the token zentrafin lists 4 open roles.", quote: "The Greenhouse job board with the token zentrafin lists 4 open roles.", url: "https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs" },
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

Deno.test("the cover thesis names its sources, or says it summarizes the cited sections; a long host ends in an ellipsis, never mid-word", async () => {
  const f = freeWeb(), read = freeReader({ fetch: f, resolver: PUBLIC, now: () => NOW });
  const mk = async (thesis: string) => {
    const published: any[] = [];
    const draft = { title: "Zentrafin", thesis, summary: [{ text: "The Greenhouse job board with the token zentrafin lists 4 open roles.", quote: "The Greenhouse job board with the token zentrafin lists 4 open roles.", url: "https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs" }],
      conditions: [{ text: "Zentrafin keeps hiring new grads into engineering.", urls: ["https://zentrafin.example/careers"] }], risks: [{ text: "Fewer open roles would mean fewer first jobs.", urls: ["https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs"] }] };
    await researchMarket({ question: "research Zentrafin", format: "file", plan: { queries: ["Zentrafin"], companies: ["Zentrafin"], sites: ["zentrafin.example"] },
      deps: { search: freeProvider({ fetch: f, now: () => NOW, userAgent: null }), read, draft: async () => JSON.stringify(draft), publish: async (d) => { published.push(d); return { url: "https://trainee.example/file?t=v1.x" }; } } });
    const v: any = validateKind("research_brief", published[0], { now: NOW });
    ok(v.ok, JSON.stringify(v));
    return { d: v.data, h: bodyHtml({ id: "f", userId: "u", kind: "research_brief", data: v.data, state: {}, tag: null, created_at: NOW, expires_at: NOW + 1, revoked_at: null } as any, "fs1." + "a".repeat(64)) };
  };
  const a = await mk("Zentrafin hires new grads into engineering.");
  ok(Array.isArray(a.d.thesis_cite) && a.d.thesis_cite.length >= 1 && !a.d.thesis_summary, JSON.stringify(a.d));
  ok(/<p class="rb-thesis">Zentrafin hires new grads into engineering\. <span class="rb-cite">\[\d\]/.test(a.h));
  const b = await mk("Zentrafin is a sensible first employer.");
  eq([b.d.thesis_cite, b.d.thesis_summary], [undefined, true]);
  ok(b.h.includes('<p class="rb-basis">A summary of the cited sections below.</p>'));
  ok(/<span class="rb-host" title="zentrafin\.example">zentrafin\.example<\/span> · Read/.test(a.h));
  ok(!validateKind("research_brief", { ...a.d, thesis_cite: [9] }, { now: NOW }).ok, "a thesis cite must be a source number");
});

// ---------------------------------------------------------------- architect follow-ups on #615, second round (2026-11-08)
Deno.test("facts guard: a heading or form name is never a fact; a filing's form code is not a number", async () => {
  eq(figuresIn("Form 10-K Hollow Oak Logistics Inc."), []);
  eq(figuresIn("an 8-K filed under DEF 14A and S-1").length, 0);
  eq(figuresIn("Hollow Oak Logistics had 3,900 employees in its 10-K").map((n: any) => n.v), [3900]);
  ok(!hasPredicate("Form 10-K Hollow Oak Logistics Inc.", "Hollow Oak Logistics Inc. Form 10-K"));
  ok(!hasPredicate("Zentrafin Inc.", ""));
  ok(hasPredicate("Hollow Oak Logistics operates 14 distribution centers.", "Hollow Oak Logistics Inc. Form 10-K"));
  // End to end: the heading is dropped, the real fact on the same page stands.
  const page = "https://www.sec.gov/Archives/edgar/data/9990001/000999000126000002/hoak-10k.htm";
  const f = (async (i: RequestInfo | URL) => String(i) === page ? html("Hollow Oak Logistics Inc. Form 10-K", "Form 10-K Hollow Oak Logistics Inc. Hollow Oak Logistics operates 14 distribution centers in the Midwest.") : nf()) as typeof fetch;
  const draft = { title: "Hollow Oak", thesis: "", summary: [
    { text: "Form 10-K Hollow Oak Logistics Inc.", quote: "Form 10-K Hollow Oak Logistics Inc.", url: page },
    { text: "Hollow Oak Logistics operates 14 distribution centers in the Midwest.", quote: "Hollow Oak Logistics operates 14 distribution centers in the Midwest.", url: page }], conditions: [], risks: [] };
  const r: any = await researchMarket({ question: "research Hollow Oak Logistics", format: "inline", plan: { queries: ["x"] },
    deps: { search: { id: "first_party", needsKey: false, search: async () => ({ hits: [{ url: page, title: "t", provider: "sec_edgar", foundAt: NOW }], notes: [], provider: "first_party", searches: 1 }) }, read: (u) => fetchSources(u, { fetch: f, resolver: PUBLIC, now: () => NOW }), draft: async () => JSON.stringify(draft) } });
  eq([r.points.map((p: any) => p.text), r.dropped], [["Hollow Oak Logistics operates 14 distribution centers in the Midwest."], 1]);
});

Deno.test("when two cited sources differ on a figure, the brief shows both with their sources and says so; it never picks one", async () => {
  eq(disagreementsIn([{ text: "Hollow Oak Logistics employs about 600 people across 10 offices.", cite: [1] }, { text: "Hollow Oak Logistics had 3,900 full-time employees at the end of the fiscal year.", cite: [3] }]),
    [{ label: "Headcount, Hollow Oak Logistics", values: [{ value: "600", cite: [1] }, { value: "3,900", cite: [3] }] }]);
  // Not a disagreement: the same figure; one source; a national and a metro median; two companies' headcounts.
  eq(disagreementsIn([{ text: "Zentrafin employs 2,400 people.", cite: [1] }, { text: "Zentrafin had 2,400 employees as of 2025.", cite: [2] }]), []);
  eq(disagreementsIn([{ text: "Zentrafin employs 2,400 people.", cite: [1] }, { text: "Zentrafin had 900 employees in 2019.", cite: [1] }]), []);
  eq(disagreementsIn([{ text: "The annual median wage for Software Developers is $131,450.", cite: [1] }, { text: "Software Developers in the New York metro area earn an annual median wage of $158,200.", cite: [2] }]), []);
  eq(disagreementsIn([{ text: "Acme employs 600 people.", cite: [1] }, { text: "Globex employs 3,900 people.", cite: [2] }]), []);
  // End to end: both figures stay in the summary, and the brief has a section that names both with their sources.
  const a = "https://hollowoak.example/", b = "https://www.sec.gov/Archives/edgar/data/9990001/000999000126000002/hoak-10k.htm", published: any[] = [];
  const f = (async (i: RequestInfo | URL) => String(i) === a ? html("Hollow Oak Logistics", "Hollow Oak Logistics hires new grads every year. Hollow Oak Logistics employs about 600 people across 10 offices.")
    : String(i) === b ? html("Hollow Oak Logistics Inc. Form 10-K", "Hollow Oak Logistics had 3,900 full-time employees at the end of the fiscal year.") : nf()) as typeof fetch;
  const draft = { title: "Hollow Oak Logistics", thesis: "Hollow Oak Logistics hires new grads every year.", summary: [
    { text: "Hollow Oak Logistics employs about 600 people across 10 offices.", quote: "Hollow Oak Logistics employs about 600 people across 10 offices.", url: a },
    { text: "Hollow Oak Logistics had 3,900 full-time employees at the end of the fiscal year.", quote: "Hollow Oak Logistics had 3,900 full-time employees at the end of the fiscal year.", url: b }],
    conditions: [{ text: "Hollow Oak Logistics keeps hiring new grads.", urls: [a] }], risks: [{ text: "Hiring could slow at Hollow Oak Logistics.", urls: [a] }] };
  const r: any = await researchMarket({ question: "research Hollow Oak Logistics and give me a file", format: "file", plan: { queries: ["x"] },
    deps: { search: { id: "first_party", needsKey: false, search: async () => ({ hits: [a, b].map((url) => ({ url, title: "t", provider: "company_site" as const, foundAt: NOW })), notes: [], provider: "first_party", searches: 1 }) },
      read: (u) => fetchSources(u, { fetch: f, resolver: PUBLIC, now: () => NOW }), draft: async () => JSON.stringify(draft), publish: async (d) => { published.push(d); return { url: "https://trainee.example/file?t=v1.d" }; } } });
  eq(r.disagreements, [{ label: "Headcount, Hollow Oak Logistics", values: [{ value: "600", cite: [1] }, { value: "3,900", cite: [2] }] }]);
  eq(r.points.length, 2, "both figures stay; neither is dropped or chosen");
  const v: any = validateKind("research_brief", published[0], { now: NOW });
  ok(v.ok, JSON.stringify(v));
  const h = bodyHtml({ id: "f", userId: "u", kind: "research_brief", data: v.data, state: {}, tag: null, created_at: NOW, expires_at: NOW + 1, revoked_at: null } as any, "fs1." + "a".repeat(64));
  ok(h.includes('<h2>Where the sources differ</h2>') && /Headcount, Hollow Oak Logistics: 600 <span class="rb-cite">\[1\]<\/span> · 3,900 <span class="rb-cite">\[2\]<\/span>\. The sources differ; Trainee has not picked one\./.test(h), h.slice(h.indexOf("differ") - 200, h.indexOf("differ") + 300));
  ok(h.indexOf(">Summary<") < h.indexOf(">Where the sources differ<") && h.indexOf(">Where the sources differ<") < h.indexOf(">What would have to be true<"));
  // An inline answer is told to give both.
  const inline: any = await researchMarket({ question: "how many people work at Hollow Oak Logistics", format: "inline", plan: { queries: ["x"] },
    deps: { search: { id: "first_party", needsKey: false, search: async () => ({ hits: [a, b].map((url) => ({ url, title: "t", provider: "company_site" as const, foundAt: NOW })), notes: [], provider: "first_party", searches: 1 }) }, read: (u) => fetchSources(u, { fetch: f, resolver: PUBLIC, now: () => NOW }), draft: async () => JSON.stringify(draft) } });
  ok(/give each value with its source number and say they differ; never pick one/.test(inline.note));
});

// Review of #628 (follow-up, on #629): a host name with a trailing dot is judged without it.
Deno.test("isPrivateHost: \"localhost.\", \"x.internal.\" and \"a.local.\" are private names; a trailing dot does not hide them", async () => {
  const f = (async () => html("t", "a page with some words")) as typeof fetch;
  for (const u of ["https://localhost./x", "https://x.internal./y", "https://a.local./z"]) eq((await fetchSources([u], { fetch: f, now: () => NOW })).rejected.map((r) => r.why), ["private_address"], u);
  eq((await fetchSources(["https://public.example./ok"], { fetch: f, now: () => NOW })).verified.length, 1);
});
