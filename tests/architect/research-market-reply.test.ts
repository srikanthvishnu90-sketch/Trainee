// R9-C (2026-11-07): market research on the reply path. The three example requests run through the agent brain (career_brain.ts
// agentTurn) with a scripted model, a fake web and no spend: the brain calls research_market and picks the format; code reads every
// page itself, keeps only points whose page passed verifiedLinkGuard, whose quote is on that page and whose numbers are on a page
// it cites; the inline answer ends with numbered sources appended by code; the File link is minted by code. Off (the flag), no
// market research reaches the brain. Synthetic companies and figures only (research-web-fixture.ts).
import assertNode from "node:assert/strict";
import { agentTurn } from "../../supabase/functions/agent-chat/career_brain.ts";
import { marketResearchAsk } from "../../supabase/functions/agent-chat/career_staged.ts";
import { enforceMarketReply, type MarketDeps, researchMarket } from "../../supabase/functions/_shared/agent/research/market.ts";
import * as kinds from "../../supabase/functions/_shared/file_kinds.ts";
import { fetchSources } from "../../supabase/functions/_shared/research_sources.ts";
import { searchProviderFor } from "../../supabase/functions/_shared/research_search.ts";
import { NO_SOURCES } from "../../supabase/functions/_shared/research_reply.ts";
import { fakeWeb, NOW, PAGES } from "./research-web-fixture.ts";
import { askAwareJudge, testSupportJudge } from "./support-test-judge-c.ts";
import type { SupportJudge } from "../../supabase/functions/_shared/agent/research/support.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const KEY = { BRAVE_SEARCH_API_KEY: "test-key-not-real" } as Record<string, string>;
const ISO = new Date(NOW).toISOString();

function deps(env: Record<string, string>, draft: unknown, o: { publish?: boolean; judge?: SupportJudge } = {}) {
  const published: any[] = [], f = fakeWeb();
  const d: MarketDeps = {
    search: searchProviderFor({ get: (k) => env[k] }, f, () => NOW),
    read: (urls) => fetchSources(urls, { fetch: f, now: () => NOW }),
    draft: async () => JSON.stringify(draft),
    publish: o.publish === false ? null : async (data) => { published.push(data); return { url: `https://trainee.example/file?t=v1.brief${published.length}` }; },
    // Architect amendment (owner decision 2026-11-13: research support check switched on): research needs its judge to keep a line.
    judge: o.judge ?? testSupportJudge,
  };
  return { d, published };
}
async function turn(message: string, input: Record<string, unknown>, finalText: string, d: MarketDeps) {
  let step = 0;
  const model = async () => (++step === 1
    ? { content: [{ type: "tool_use", id: "m1", name: "research_market", input: { question: message, ...input } }], stop_reason: "tool_use" }
    : { content: [{ type: "text", text: finalText }], stop_reason: "end_turn" });
  return await agentTurn({ message, history: [], stores: { profile: {} }, userId: "u1", threadId: "t1", now: NOW, model, market: d } as any);
}
// Every citation names a source; every source is a page the fake web served (HTTP 200) this turn, read at NOW; nothing blocked.
function citationsValid(data: any) {
  const n = data.sources.length, cites = [...data.summary, ...data.conditions, ...data.risks, ...(data.comparison?.rows ?? []).flatMap((r: any) => r.cells.filter(Boolean))].flatMap((x: any) => x.cite);
  ok(cites.length && cites.every((c: number) => Number.isInteger(c) && c >= 1 && c <= n), `cites ${cites} within 1..${n}`);
  for (let i = 1; i <= n; i++) ok(cites.includes(i), `source ${i} is cited`);
  for (const s of data.sources) { ok(PAGES[s.url], `${s.url} was a fetched page`); eq(s.fetched_at, ISO); ok(!/linkedin|indeed/.test(s.url)); }
  // With the market File variant on trunk (PR "R9-C 1/2"), the brief is a valid research_brief; before it, this check is skipped.
  if ("marketReadOn" in kinds) ok(kinds.validateKind("research_brief", data, { now: NOW }).ok, JSON.stringify(kinds.validateKind("research_brief", data, { now: NOW })));
}

const MARKET_DRAFT = {
  title: "What would change the market for home batteries", thesis: "Cheaper packs and storage tariffs decide how fast home batteries spread.",
  summary: [
    { text: "Battery pack prices fell 20% in 2024.", quote: "Battery pack prices fell 20% in 2024", url: "https://research.example/battery-prices-2024" },
    { text: "Acme Energy installed 41,000 home batteries in 2025.", quote: "Acme Energy installed 41,000 home batteries in 2025", url: "https://acme.example/annual-report" },
    { text: "Home batteries will be in 60% of homes by 2030.", quote: "Battery pack prices fell", url: "https://research.example/battery-prices-2024" }, // number on no page: dropped
    { text: "LinkedIn says demand doubled.", quote: "demand doubled", url: "https://www.linkedin.com/pulse/batteries" }, // never fetched: dropped
    { text: "Prices keep falling.", quote: "a sentence that is not on the page", url: "https://research.example/battery-prices-2024" }, // quote not on page: dropped
  ],
  conditions: [{ text: "Pack prices keep falling.", urls: ["https://research.example/battery-prices-2024"] }, { text: "Utilities keep paying for stored power at peak hours.", urls: ["https://utility.example/tariffs/storage"] }],
  risks: [{ text: "The state board's yearly tariff review could cut the payments.", urls: ["https://utility.example/tariffs/storage"] }, { text: "See https://evil.example/x", urls: ["https://utility.example/tariffs/storage"] }],
};
Deno.test("example 1, 'what would change the market for X': a research brief File, every claim cited to a fetched page", async () => {
  // Architect amendment (owner decision 2026-11-13: research support check switched on): a File needs a condition a page states; the
  // draft's readings ("Pack prices keep falling", "Utilities keep paying ...") are on no page and are dropped, so this File's draft
  // adds the tariff page's own statement in the model's words as a condition.
  const { d, published } = deps(KEY, { ...MARKET_DRAFT, conditions: [...MARKET_DRAFT.conditions, { text: "The utility pays homes for stored power during peak hours.", urls: ["https://utility.example/tariffs/storage"] }] });
  const q = "What would change the market for home batteries?";
  const out = await turn(q, { format: "file", queries: ["home battery market outlook"] }, "Cheaper packs and storage tariffs decide it. Full details: https://evil.example/brief. Prices will drop 90% next year.", d);
  eq(published.length, 1);
  const data = published[0];
  // Architect amendment (owner decision 2026-11-13: research support check switched on; fix "the install pattern narrowed" and the
  // exact page sentence shown as the page's own): Acme's line, which is its page's sentence word for word, stands as that sentence in
  // quotation marks; any other line is a page's own sentence in quotation marks. The unsupported lines (60%, LinkedIn, the quote not
  // on its page) are still not in the brief.
  const sum = data.summary.map((s: any) => s.text);
  ok(sum[0] === "Battery pack prices fell 20% in 2024." && sum.includes('"Acme Energy installed 41,000 home batteries in 2025."') && sum.slice(1).every((t: string) => /^".+"$/.test(t)), JSON.stringify(sum));
  ok(!sum.some((t: string) => /60%|LinkedIn|doubled|Prices keep falling/.test(t)), JSON.stringify(sum));
  eq(data.risks.length, 1, "a risk with a link in it is dropped");
  citationsValid(data);
  eq(out.fileLinks, ["https://trainee.example/file?t=v1.brief1"], "the File link is code's, sent by the channel");
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the model's "Cheaper packs and storage
  // tariffs decide it" is on no page, so it is not said; the reply is the brief's kept line with its citation. Links and the
  // unsourced 90% are still removed, and the reply is never blank.
  ok(!/https?:|90%|Cheaper packs/.test(out.reply) && /Battery pack prices fell 20% in 2024\.? \[1\]/.test(out.reply), `model links and unsourced figures removed: ${out.reply}`);
});

const COMPARE_DRAFT = {
  title: "Acme Energy, Globex Power and Initech Grid compared", thesis: "Acme Energy and Globex Power sell to homes; Initech Grid sells software to utilities.",
  summary: [{ text: "Initech Grid builds grid software for utilities.", quote: "Initech Grid builds grid software for utilities", url: "https://initech.example/about" },
    { text: "Globex Power sells home batteries, solar panels and EV chargers.", quote: "Globex Power sells home batteries, solar panels and EV chargers", url: "https://globex.example/products" }],
  comparison: { options: ["Acme Energy", "Globex Power", "Initech Grid"], rows: [
    { label: "Home batteries installed (2025)", cells: [{ value: "41,000", quote: "installed 41,000 home batteries in 2025", url: "https://acme.example/annual-report" }, null, { value: "500", quote: "does not sell hardware", url: "https://initech.example/about" }] },
    { label: "Sells to homes", cells: [{ value: "Batteries and solar panels", quote: "sells batteries and solar panels", url: "https://acme.example/annual-report" }, { value: "Batteries, solar, EV chargers", quote: "solar panels and EV chargers", url: "https://globex.example/products" }, { value: "No", quote: "It does not sell hardware to homes", url: "https://initech.example/about" }] },
  ] },
  conditions: [{ text: "Homeowners keep buying hardware rather than software.", urls: ["https://globex.example/products", "https://indeed.com/cmp/acme"] }],
  risks: [{ text: "Initech Grid's utility customers could favour hardware makers.", urls: ["https://initech.example/about"] }],
};
Deno.test("example 2, 'compare these 3 companies': a brief with the comparison table; a cell no page supports is left unknown", async () => {
  const { d, published } = deps(KEY, COMPARE_DRAFT);
  const out = await turn("Compare these 3 companies: Acme Energy, Globex Power, Initech Grid", { format: "file", queries: ["Acme Energy Globex Power Initech Grid compare"], companies: ["Acme Energy", "Globex Power", "Initech Grid"] }, "Acme Energy and Globex Power sell to homes [1][2].", d);
  // Architect amendment (owner decision 2026-11-13: research support check switched on; architect ruling 2026-11-14): a cell that
  // claims more than its page sentence is refused ("Batteries and solar panels" under "Sells to homes": the page never says "to
  // homes"), and so is Initech's "500" (on no page). Only Acme's 41,000 stands, one column, so there is no table; the drafted
  // condition is on no page, so there is no File either. Every cell that is shown is one its page states.
  eq(published.length, 0, "no File for an unsourced condition");
  eq(out.fileLinks?.length ?? 0, 0);
  ok(!/\b500\b/.test(out.reply) && !/indeed\.com/.test(out.reply), out.reply);
  const { d: d2 } = deps(KEY, COMPARE_DRAFT);
  const r: any = await researchMarket({ question: "Compare these 3 companies: Acme Energy, Globex Power, Initech Grid", format: "file", plan: { queries: ["Acme Energy Globex Power Initech Grid compare"], companies: ["Acme Energy", "Globex Power", "Initech Grid"] }, deps: d2 } as any);
  eq(r.status, "ok");
  for (const row of r.comparison?.rows ?? []) for (const c of row.cells) if (c) ok(c.cite.every((n: number) => r.sources.some((x: any) => x.n === n)), JSON.stringify(c));
  ok(!JSON.stringify(r.comparison ?? {}).includes('"500"') && !/Batteries and solar panels|Batteries, solar, EV chargers/.test(JSON.stringify(r.comparison ?? {})), JSON.stringify(r.comparison));
});

const SALARY_DRAFT = {
  title: "Software developer pay in Seattle", thesis: "Software developers in the Seattle metro earn more than the national mean.",
  summary: [{ text: "The annual mean wage for software developers in the Seattle-Tacoma-Bellevue metro area is $180,000.", quote: "Software Developers annual mean wage $180,000 in the Seattle-Tacoma-Bellevue metro area", url: "https://www.bls.gov/oes/current/oes_42660.htm" },
    { text: "The national annual mean wage is $150,000.", quote: "Annual mean wage: $150,000", url: "https://www.bls.gov/oes/current/oes151252.htm" }],
  conditions: [], risks: [],
};
Deno.test("example 3, 'salary for role Y in city Z' with no search key: first-party BLS pages, an inline answer, numbered sources added by code", async () => {
  const { d, published } = deps({}, SALARY_DRAFT);
  const out = await turn("What's the salary for a software developer in Seattle?", { format: "inline", soc: "15-1252", cbsa: "42660" },
    "Software developers in the Seattle metro average $180,000 a year [1], against $150,000 nationally [2]. Senior people get $400,000 [3]. More at https://levels.example/x", d);
  eq(published.length, 0, "inline: no file");
  const [body, list] = out.reply.split("\n\n");
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the model's "average $180,000 a year" is not
  // what the page says (an annual mean wage), so each figure is shown as its page's own sentence in quotation marks with its number.
  // Still: no figure, link or source number that no page gave.
  ok(/^"[^"]*\$180,000[^"]*" \[1\]\. "[^"]*\$150,000[^"]*" \[2\]\.$/.test(body) && !/400,000|levels\.example|\[3\]/.test(out.reply), out.reply);
  eq(list.split("\n"), [
    "[1] Seattle-Tacoma-Bellevue, WA wage estimates: https://www.bls.gov/oes/current/oes_42660.htm (read Nov 7, 2026)",
    "[2] Software Developers: https://www.bls.gov/oes/current/oes151252.htm (read Nov 7, 2026)",
  ]);
});

Deno.test("the format: a File only when the brain asks and a publisher exists (CAREER_RESEARCH_BRIEF); otherwise inline with sources", async () => {
  const off = deps(KEY, MARKET_DRAFT, { publish: false });
  const r = await researchMarket({ question: "What would change the market for home batteries?", format: "file", plan: { queries: ["battery market"] }, deps: off.d });
  ok(r.status === "ok" && r.format === "inline" && r.asked === "file" && r.notes.some((n) => /not switched on/.test(n)));
  const inl = deps(KEY, MARKET_DRAFT);
  const r2 = await researchMarket({ question: "battery market?", format: "inline", plan: { queries: ["battery market"] }, deps: inl.d });
  ok(r2.status === "ok" && r2.format === "inline" && inl.published.length === 0, "the brain chose inline: no file");
  const thin = deps(KEY, { ...MARKET_DRAFT, risks: [] });
  const r3 = await researchMarket({ question: "battery market?", format: "file", plan: { queries: ["battery market"] }, deps: thin.d });
  ok(r3.status === "ok" && r3.format === "inline" && thin.published.length === 0, "a brief without risks is not made");
  ok(/\n\n\[1\] .+: https:\/\/research\.example\/battery-prices-2024 \(read Nov 7, 2026\)/.test(enforceMarketReply("Packs got cheaper [1].", r)));
});

Deno.test("no source could be opened, or none supports an answer: the reply says so and carries no figure", async () => {
  const { d } = deps({}, MARKET_DRAFT);
  const r = await researchMarket({ question: "What would change the market for home batteries?", format: "file", plan: { queries: ["battery market"] }, deps: d });
  eq(r.status, "no_sources");
  // Architect amendment (owner decision 2026-11-13: research support check switched on): "I couldn't open a source for that." is not
  // the closed could-not-confirm form, so no model sentence stands; the reply is code's own no-sources line. Still no figure.
  eq(enforceMarketReply("Batteries will grow 35% a year. I couldn't open a source for that.", r), NO_SOURCES);
  ok(/couldn't find a source/.test(enforceMarketReply("Growth is 35%.", r)));
  // Architect amendment (owner decision 2026-11-13: research support check switched on): this test is about a question the pages do not
  // answer, so its judge also says no to a page sentence quoted for a question it has nothing to do with, as the real judge is asked
  // to (askAwareJudge); support-test-judge.ts says yes to every quote check.
  const bad = deps(KEY, { ...MARKET_DRAFT, summary: [{ text: "x 99%", quote: "nowhere on any page", url: "https://acme.example/annual-report" }] }, { judge: askAwareJudge });
  // Architect amendment (D-073, as left after its review). The input above is the original one. Two things changed around it:
  // (1) The original question ("battery market?") no longer ends in no_sources: the owner's rule is that research is never blank
  //     when a read page speaks to the ask, so the page's own sentence answers, word for word, with its source (D-071, D-073).
  //     What the original assertion guarded still holds and is asserted: the unsupported line (99%) is not shown, and the model's
  //     unquoted conditions and risks are not shown as the answer either (no sentence of their pages says them).
  // (2) The original assertion, unchanged, on the same draft with a question none of the read pages speaks to.
  const r2 = await researchMarket({ question: "battery market?", format: "inline", plan: { queries: ["battery market"] }, deps: bad.d });
  const a2 = enforceMarketReply("", r2);
  ok(r2.status === "ok" && !/99%/.test(a2), a2);
  // Architect amendment (owner decision 2026-11-13: research support check switched on; fix "a page title ends its own line"): the
  // page's own sentence is shown in quotation marks, word for word, without the page title glued to it, with its source.
  eq(a2.split("\n\n")[0], '"Battery pack prices fell 20% in 2024 according to the annual survey of cell makers." [1].', "only the page's own sentence");
  for (const x of [...MARKET_DRAFT.conditions, ...MARKET_DRAFT.risks]) ok(!a2.includes(x.text.replace(/\.$/, "")), `a model-worded reading is not the answer: ${x.text}`);
  const r3 = await researchMarket({ question: "What is the outlook for hydrogen trucks?", format: "inline", plan: { queries: ["battery market"] }, deps: bad.d });
  ok(r3.status === "no_sources" && /couldn't confirm/.test(r3.note));
});

Deno.test("routing: with CAREER_RESEARCH_REPLY=on the three asks go to the brain; off, or a job search or a payload, they do not", () => {
  const on = { get: (k: string) => k === "CAREER_RESEARCH_REPLY" ? "on" : undefined }, off = { get: (k: string) => k === "CAREER_RESEARCH_REPLY" ? "off" : undefined }; // D-047: off is the rollback, named explicitly
  for (const m of ["What would change the market for home batteries?", "Compare these 3 companies: Acme, Globex, Initech", "salary for a data analyst in Austin", "How much do nurses make in Denver?", "what's the market outlook for EV chargers"]) {
    ok(marketResearchAsk(on, m, "question_unclaimed"), m); ok(!marketResearchAsk(off, m, "question_unclaimed"), `off: ${m}`);
  }
  ok(marketResearchAsk(on, "salary for a data analyst in Austin", "career_discovery"), "a pay question is not a job search");
  ok(!marketResearchAsk(on, "find me data analyst jobs in Austin with salary for juniors in Texas", "career_discovery"), "a job search stays code's");
  ok(!marketResearchAsk(on, "compare these 3 companies and apply to all", "career_batch_apply"), "an apply stays code's");
  ok(!marketResearchAsk(on, "thanks!", null));
});
