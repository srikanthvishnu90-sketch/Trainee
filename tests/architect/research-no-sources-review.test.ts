// R9-F review regressions for PR #592 (on R9-C's market research). Each fails on the code before its fix:
//   a fact never names another company than the one its quote names (Globex on Acme's quote);
//   when research found nothing to stand on, a confident sentence never survives: only wording that says it could not
//   confirm an answer, else the plain no-source line.
import assertNode from "node:assert/strict";
import { enforceMarketReply, enforceMarketReplySupported, type MarketDeps, researchMarket } from "../../supabase/functions/_shared/agent/research/market.ts";
import { NO_SOURCES } from "../../supabase/functions/_shared/research_reply.ts";
import { fetchSources } from "../../supabase/functions/_shared/research_sources.ts";
import { searchProviderFor } from "../../supabase/functions/_shared/research_search.ts";
import { fakeWeb, NOW } from "./research-web-fixture.ts";
import { testSupportJudge } from "./support-test-judge-c.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const KEY = { BRAVE_SEARCH_API_KEY: "test-key-not-real" } as Record<string, string>;
const deps = (env: Record<string, string>, draft: unknown): MarketDeps => {
  const f = fakeWeb();
  return { search: searchProviderFor({ get: (k) => env[k] }, f, () => NOW), read: (urls) => fetchSources(urls, { fetch: f, now: () => NOW }), draft: () => Promise.resolve(JSON.stringify(draft)), publish: null,
    // Architect amendment (owner decision 2026-11-13: research support check switched on): research needs its judge to keep a line.
    judge: testSupportJudge };
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
  // Architect amendment (owner decision 2026-11-13: research support check switched on): with the check on, a page's own sentence that
  // answers the ask may be added in quotation marks (the Globex page's own line); Acme's figure is still never Globex's, and the
  // true Acme line stands in the model's words.
  const texts = r.points.map((p) => p.text);
  ok(!texts.some((t) => /Globex/.test(t) && /41,000/.test(t)), `Acme's figure is never Globex's: ${JSON.stringify(texts)}`);
  ok(texts.every((t) => t === "Acme Energy installed 41,000 home batteries in 2025." || /^".+"$/.test(t)), JSON.stringify(texts));
  ok(texts.includes("Acme Energy installed 41,000 home batteries in 2025."), `the true Acme line stands: ${JSON.stringify(texts)}`);
});

Deno.test("review: failed research never sounds certain", async () => {
  const r = await researchMarket({ question: "What would change the market for home batteries?", format: "inline", plan: { queries: ["battery market"] }, deps: deps({}, {}) });
  eq(r.status, "no_sources");
  eq(enforceMarketReply("The market is growing rapidly.", r), NO_SOURCES, "a confident claim with no source");
  eq(enforceMarketReply("The market is growing rapidly. Batteries are the future!", r), NO_SOURCES);
  eq(enforceMarketReply("I couldn't find a source, but demand is clearly rising.", r), NO_SOURCES, "a claim riding on the admission");
  // Architect amendment (owner decision 2026-11-13: research support check switched on): "…from any page I could open." is not the
  // closed could-not-confirm form, so no model sentence stands and the reply is code's own no-source line, in the synchronous form
  // and in the judged one; the confident "Demand is rising." never survives either way.
  eq(enforceMarketReply("Demand is rising. I couldn’t confirm an answer from any page I could open.", r), NO_SOURCES);
  eq(await enforceMarketReplySupported("Demand is rising. I couldn’t confirm an answer from any page I could open.", r, [], { judge: testSupportJudge, ask: "What would change the market for home batteries?" }), NO_SOURCES);
});
