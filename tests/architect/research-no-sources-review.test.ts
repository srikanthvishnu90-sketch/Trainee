// R9-F review regressions for PR #592 (on R9-C's market research). Each fails on the code before its fix:
//   a fact never names another company than the one its quote names (Globex on Acme's quote);
//   when research found nothing to stand on, a confident sentence never survives: only wording that says it could not
//   confirm an answer, else the plain no-source line.
import assertNode from "node:assert/strict";
import { enforceMarketReply, type MarketDeps, researchMarket } from "../../supabase/functions/_shared/agent/research/market.ts";
import { NO_SOURCES } from "../../supabase/functions/_shared/research_reply.ts";
import { fetchSources } from "../../supabase/functions/_shared/research_sources.ts";
import { searchProviderFor } from "../../supabase/functions/_shared/research_search.ts";
import { fakeWeb, NOW } from "./research-web-fixture.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const KEY = { BRAVE_SEARCH_API_KEY: "test-key-not-real" } as Record<string, string>;
const deps = (env: Record<string, string>, draft: unknown): MarketDeps => {
  const f = fakeWeb();
  return { search: searchProviderFor({ get: (k) => env[k] }, f, () => NOW), read: (urls) => fetchSources(urls, { fetch: f, now: () => NOW }), draft: () => Promise.resolve(JSON.stringify(draft)), publish: null };
};
const ACME = "https://acme.example/annual-report";

Deno.test("review: a fact never names another employer than its quote", async () => {
  const r = await researchMarket({ question: "Compare Acme Energy and Globex Power", format: "inline", plan: { queries: ["Acme Energy Globex Power compare"] }, deps: deps(KEY, {
    title: "Acme Energy and Globex Power", thesis: "Both sell to homes.",
    summary: [
      { text: "Globex Power installed 41,000 home batteries in 2025.", quote: "Acme Energy installed 41,000 home batteries in 2025", url: ACME },
      { text: "Acme Energy installed 41,000 home batteries in 2025.", quote: "Acme Energy installed 41,000 home batteries in 2025", url: ACME },
    ] }) });
  ok(r.status === "ok", JSON.stringify(r));
  if (r.status !== "ok") return;
  eq(r.points.map((p) => p.text), ["Acme Energy installed 41,000 home batteries in 2025."], "Acme's figure is never Globex's");
});

Deno.test("review: failed research never sounds certain", async () => {
  const r = await researchMarket({ question: "What would change the market for home batteries?", format: "inline", plan: { queries: ["battery market"] }, deps: deps({}, {}) });
  eq(r.status, "no_sources");
  eq(enforceMarketReply("The market is growing rapidly.", r), NO_SOURCES, "a confident claim with no source");
  eq(enforceMarketReply("The market is growing rapidly. Batteries are the future!", r), NO_SOURCES);
  eq(enforceMarketReply("I couldn't find a source, but demand is clearly rising.", r), NO_SOURCES, "a claim riding on the admission");
  eq(enforceMarketReply("Demand is rising. I couldn’t confirm an answer from any page I could open.", r), "I couldn’t confirm an answer from any page I could open.");
});
