// R9-C review regressions for PR #589 (the subject of a figure, after "Quotes allow unrelated claims" and "Replies can cite
// wrong figures"). Each fails on the code before its fix:
//   a comparison cell stands only when its quote speaks of that cell's company: Acme's 41,000 never fills Globex's column;
//   an inline sentence names only who its cited points name: "Globex Power installed 41,000 home batteries [1]" on Acme's
//   point [1] is dropped, though the figure and the citation match.
import assertNode from "node:assert/strict";
import { enforceMarketReply, type MarketDeps, researchMarket } from "../../supabase/functions/_shared/agent/research/market.ts";
import { fetchSources } from "../../supabase/functions/_shared/research_sources.ts";
import { searchProviderFor } from "../../supabase/functions/_shared/research_search.ts";
import { fakeWeb, NOW } from "./research-web-fixture.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const KEY = { BRAVE_SEARCH_API_KEY: "test-key-not-real" } as Record<string, string>;
const deps = (draft: unknown): MarketDeps => {
  const f = fakeWeb();
  return { search: searchProviderFor({ get: (k) => KEY[k] }, f, () => NOW), read: (urls) => fetchSources(urls, { fetch: f, now: () => NOW }), draft: () => Promise.resolve(JSON.stringify(draft)), publish: null };
};
const ACME = "https://acme.example/annual-report", GLOBEX = "https://globex.example/products";
const plan = { queries: ["Acme Energy Globex Power compare"] };

Deno.test("review: a comparison cell's figure is that column's company's, never another's", async () => {
  const r = await researchMarket({ question: "Compare Acme Energy and Globex Power", format: "inline", plan, deps: deps({
    title: "Acme Energy and Globex Power", thesis: "Both sell to homes.",
    summary: [{ text: "Acme Energy installed 41,000 home batteries in 2025.", quote: "Acme Energy installed 41,000 home batteries in 2025", url: ACME }],
    comparison: { options: ["Acme Energy", "Globex Power"], rows: [
      { label: "Home batteries installed (2025)", cells: [
        { value: "41,000", quote: "installed 41,000 home batteries in 2025", url: ACME },
        { value: "41,000", quote: "installed 41,000 home batteries in 2025", url: ACME }] },
      { label: "Sells", cells: [
        { value: "Batteries and solar panels", quote: "sells batteries and solar panels", url: ACME },
        { value: "Home batteries, solar panels and EV chargers", quote: "sells home batteries, solar panels and EV chargers", url: GLOBEX }] },
    ] } }) });
  ok(r.status === "ok" && r.comparison, JSON.stringify(r));
  if (r.status !== "ok" || !r.comparison) return;
  eq(r.comparison.rows.map((x) => x.cells.map((c) => c?.value ?? null)), [["41,000", null], ["Batteries and solar panels", "Home batteries, solar panels and EV chargers"]],
    "Acme's quote fills Acme's cell only; Globex's cell stands on Globex's page");
  eq(r.dropped, 1);
});

Deno.test("review: an inline sentence names only who its cited points name", async () => {
  const r = await researchMarket({ question: "Compare Acme Energy and Globex Power", format: "inline", plan, deps: deps({
    title: "Acme Energy and Globex Power", thesis: "Both sell to homes.",
    summary: [{ text: "Acme Energy installed 41,000 home batteries in 2025.", quote: "Acme Energy installed 41,000 home batteries in 2025", url: ACME },
      { text: "Globex Power sells home batteries, solar panels and EV chargers.", quote: "Globex Power sells home batteries, solar panels and EV chargers", url: GLOBEX }] }) });
  ok(r.status === "ok" && r.sources.length === 2, JSON.stringify(r));
  if (r.status !== "ok") return;
  const body = (s: string) => enforceMarketReply(s, r).split("\n\n")[0];
  eq(body("Globex Power installed 41,000 home batteries in 2025 [1]. Globex Power also sells EV chargers [2]."), "Globex Power also sells EV chargers [2].",
    "Acme's figure under Globex's name is dropped though [1] and 41,000 match");
  eq(body("Acme Energy installed 41,000 home batteries in 2025 [1], and Globex Power sells EV chargers [2]."),
    "Acme Energy installed 41,000 home batteries in 2025 [1], and Globex Power sells EV chargers [2].", "each name with its own source stands");
  eq(body("In 2025 Acme Energy installed 41,000 home batteries [1]."), "In 2025 Acme Energy installed 41,000 home batteries [1].");
});
