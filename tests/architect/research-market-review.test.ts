// R9-C review regressions for PR #589. Each fails on the code before its fix:
//   a claim stands only on a quote that says it (subject and figures), never on a quote that merely shares a number;
//   an inline sentence's figures must come from a point that cites what that sentence cites, and an uncited sentence is dropped;
//   a long page's relevant passage reaches the model's draft input, not only its first 6,000 characters.
import assertNode from "node:assert/strict";
import { agrees, enforceMarketReply, type MarketDeps, researchMarket } from "../../supabase/functions/_shared/agent/research/market.ts";
import { fetchSources, type FetchedSources } from "../../supabase/functions/_shared/research_sources.ts";
import { searchProviderFor } from "../../supabase/functions/_shared/research_search.ts";
import { fakeWeb, NOW } from "./research-web-fixture.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const KEY = { BRAVE_SEARCH_API_KEY: "test-key-not-real" } as Record<string, string>;
const deps = (env: Record<string, string>, draft: unknown): MarketDeps => {
  const f = fakeWeb();
  return { search: searchProviderFor({ get: (k) => env[k] }, f, () => NOW), read: (urls) => fetchSources(urls, { fetch: f, now: () => NOW }), draft: () => Promise.resolve(JSON.stringify(draft)), publish: null };
};
const BATTERY = "https://research.example/battery-prices-2024", ACME = "https://acme.example/annual-report";

Deno.test("review: a claim stands only on a quote that says it", async () => {
  const r = await researchMarket({ question: "battery market?", format: "inline", plan: { queries: ["battery market"] }, deps: deps(KEY, {
    title: "Battery market", thesis: "Packs got cheaper.",
    summary: [
      { text: "Solar panel prices fell 20% in 2024.", quote: "Battery pack prices fell 20% in 2024", url: BATTERY },
      { text: "Acme Energy installed 41,000 solar panels in 2025.", quote: "Acme Energy installed 41,000 home batteries in 2025", url: ACME },
      { text: "Acme Energy installed 41,000 home batteries.", quote: "Acme Energy installed 41,000 home batteries in 2025", url: ACME },
      { text: "Battery pack prices fell 20% in 2024.", quote: "Battery pack prices fell 20% in 2024", url: BATTERY },
    ] }) });
  ok(r.status === "ok", JSON.stringify(r));
  if (r.status !== "ok") return;
  eq(r.points.map((p) => p.text), ["Acme Energy installed 41,000 home batteries.", "Battery pack prices fell 20% in 2024."], "another subject on the same figure is dropped");
  eq(r.dropped, 2);
  ok(!agrees("Battery pack prices fell 25% in 2024", "Battery pack prices fell 20% in 2024", "Battery pack prices fell 20% in 2024 according to the survey."), "a figure the quote does not state");
  ok(agrees("The national annual mean wage is $150,000.", "Annual mean wage: $150,000", "15-1252 Software Developers. National estimates. Annual mean wage: $150,000 (synthetic fixture)."), "a heading just before the quote counts");
});

const SALARY = {
  title: "Software developer pay in Seattle", thesis: "Seattle pays more than the national mean.",
  summary: [{ text: "The annual mean wage for software developers in the Seattle-Tacoma-Bellevue metro area is $180,000.", quote: "Software Developers annual mean wage $180,000 in the Seattle-Tacoma-Bellevue metro area", url: "https://www.bls.gov/oes/current/oes_42660.htm" },
    { text: "The national annual mean wage is $150,000.", quote: "Annual mean wage: $150,000", url: "https://www.bls.gov/oes/current/oes151252.htm" }],
};
Deno.test("review: an inline sentence's figures come from the points its own citations name", async () => {
  const r = await researchMarket({ question: "salary for a software developer in Seattle?", format: "inline", plan: { queries: [], soc: "15-1252", cbsa: "42660" }, deps: deps({}, SALARY) });
  ok(r.status === "ok" && r.sources.length === 2, JSON.stringify(r));
  const body = (s: string) => enforceMarketReply(s, r).split("\n\n")[0];
  eq(body("The national annual mean wage is $180,000 [2]. Seattle developers average $180,000 [1]."), "Seattle developers average $180,000 [1].", "$180,000 is source 1's, never source 2's");
  eq(body("Pay is rising fast everywhere. Seattle developers average $180,000 [1]."), "Seattle developers average $180,000 [1].", "an uncited sentence is dropped");
  eq(body("Seattle averages $180,000 [1], against $150,000 nationally [2]."), "Seattle averages $180,000 [1], against $150,000 nationally [2].", "each figure with its own source stands");
});

Deno.test("review: a long page's relevant passage reaches the draft input", async () => {
  const filler = Array.from({ length: 900 }, (_, i) => `Row ${i}: Occupation code 99-${String(i).padStart(4, "0")} miscellaneous workers.`).join("\n");
  const long = `Metro area wage estimates, May 2025.\n${filler}\n15-2051 Data Scientists annual mean wage $131,500 in this metro area.\n${filler}`;
  ok(long.length > 60000 / 2 && long.indexOf("Data Scientists") > 6000, "the row sits past the first 6,000 characters");
  let seen = "";
  const page = { url: "https://www.bls.gov/oes/current/oes_99999.htm", requested: "https://www.bls.gov/oes/current/oes_99999.htm", status: 200 as const, title: "Metro wage estimates", text: long, fetchedAt: NOW };
  const d: MarketDeps = {
    search: { id: "first_party", needsKey: false, search: () => Promise.resolve({ provider: "first_party", hits: [{ url: page.url, title: page.title }], notes: [] } as never) },
    read: () => Promise.resolve({ verified: [page], rejected: [] } as unknown as FetchedSources),
    draft: (p) => { seen = p.messages[0].content; return Promise.resolve("{}"); }, publish: null,
  };
  await researchMarket({ question: "What do data scientists earn in this metro?", format: "inline", plan: { queries: ["data scientists wage"] }, deps: d });
  ok(seen.includes("15-2051 Data Scientists annual mean wage $131,500"), "the matching row is in what the model reads");
  ok(seen.includes("Metro area wage estimates"), "the page's opening is kept");
  ok(seen.length < 8000, `still bounded: ${seen.length}`);
});
