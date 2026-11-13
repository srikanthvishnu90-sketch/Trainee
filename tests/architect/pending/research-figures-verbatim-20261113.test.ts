// deno-lint-ignore-file no-explicit-any require-await
// PENDING (architect, 2026-11-13): the acceptance test of market.ts FAIL_CLOSED.figures, the whole of design A, B and C from the
// review of PR #801: a research line with a number reaches the person ONLY as its cited page's own sentence, word for word; a reply
// sentence with a number stands only when it is such a kept sentence; the brief's thesis is a verified line or the first kept one.
// It passes with the switch on (this file turns it on). The switch is off in the product because, with it on, these existing
// assertions fail (each pins a figure in the model's own words as the expected output) and may not be edited to pass:
//   research-market-reply.test.ts (points "Battery pack prices fell 20% in 2024.", cell "41,000", the inline salary answer),
//   research-market-review.test.ts ("Seattle developers average $180,000 [1]." stands), research-market-subject-review.test.ts,
//   research-no-sources-review.test.ts, web-research-d060.test.ts ("Self-reported total compensation is $400,000, and those
//   reports can lag."), research-company-brief-20261109.test.ts, research-free-brief.test.ts (an unverified thesis as a "summary").
// Synthetic pages and figures; no network, no spend, no model.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/research-figures-verbatim-20261113.test.ts
import assertNode from "node:assert/strict";
import { enforceMarketReply, FAIL_CLOSED, researchMarket } from "../../../supabase/functions/_shared/agent/research/market.ts";

FAIL_CLOSED.figures = true;
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const NOW = Date.parse("2026-11-13T03:00:00Z");
type Page = { url: string; title: string; text: string };
const marketDeps = (pages: Page[], draft: unknown, extra: Record<string, unknown> = {}) => ({
  search: { id: "t", needsKey: false, search: async () => ({ hits: pages.map((p) => ({ url: p.url, title: p.title, provider: "t", foundAt: NOW })), notes: [], provider: "t" }) },
  read: async () => ({ verified: pages.map((p) => ({ url: p.url, requested: p.url, status: 200, title: p.title, text: p.text, fetchedAt: NOW })), rejected: [] }),
  draft: async () => JSON.stringify(draft), ...extra,
});
const URL1 = "https://citadel.example/pay";
const page = (text: string): Page[] => [{ url: URL1, title: "Citadel compensation notes", text }];
const run = (pages: Page[], draft: unknown, o: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  researchMarket({ question: "Citadel pay", ask: "what does citadel pay", format: "inline", plan: { queries: ["citadel pay"], companies: ["Citadel"] }, deps: marketDeps(pages, draft, extra) as any, ...o } as any) as Promise<any>;
const body = (reply: string) => reply.split(/\n\n\[1\] /)[0];

Deno.test("A: a line with a number is the page's own sentence, whatever words the model gave it (no negating word needed to catch it)", async () => {
  const own = "Senior traders, who mentor interns at Citadel, earn $5,000 a week.";
  for (const draft of [{ summary: [{ text: "Citadel interns earn $5,000 a week.", quote: "earn $5,000 a week", url: URL1 }], conditions: [], risks: [] }, { summary: [], conditions: [{ text: "Citadel interns earn $5,000 a week.", urls: [URL1] }], risks: [] }]) {
    const r = await run(page(own), draft);
    eq([r.status, [...r.points, ...r.conditions].map((p: any) => p.text)], ["ok", [own]]);
    for (const reply of ["", "Citadel interns earn $5,000 a week [1]."]) eq(body(enforceMarketReply(reply, r)), "Senior traders, who mentor interns at Citadel, earn $5,000 a week [1].");
  }
});

Deno.test("B: a reply sentence with a number stands only when it is a kept page sentence, the whole of it", async () => {
  const kept = "Senior traders at Citadel received a signing bonus of $5,000.";
  const r = await run(page(kept), { summary: [{ text: kept, quote: kept, url: URL1 }], conditions: [], risks: [] });
  for (const reply of ["Citadel pays $5,000 [1].", "Citadel interns earn $5,000 a week [1].", "Traders at Citadel received a signing bonus of $5,000 [1].", "A signing bonus of $5,000 [1]."])
    eq(body(enforceMarketReply(reply, r)), "Senior traders at Citadel received a signing bonus of $5,000 [1].", reply);
  // A sentence with no number still stands by the support check; the kept sentence said as it is stands once.
  eq(body(enforceMarketReply("Senior traders at Citadel received a signing bonus of $5,000 [1].", r)), "Senior traders at Citadel received a signing bonus of $5,000 [1].");
});

Deno.test("C: a thesis no page sentence says is never the File's cover, with or without a number", async () => {
  const pages = page("Citadel interns earn $5,000 a week. The relocation stipend is $9,000 for interns at Citadel.");
  const published: any[] = [];
  const r = await run(pages, { thesis: "Citadel is the best paying firm for interns.", summary: [{ text: "Citadel interns earn $5,000 a week.", quote: "Citadel interns earn $5,000 a week.", url: URL1 }],
    conditions: [{ text: "The relocation stipend is $9,000 for interns at Citadel.", urls: [URL1] }], risks: [{ text: "Citadel interns earn $5,000 a week.", urls: [URL1] }] },
    { format: "file" }, { publish: async (d: unknown) => { published.push(d); return { url: "https://trainee.example/file?t=v1.c" }; } });
  eq([r.format, published[0].thesis, published[0].thesis_cite, published[0].thesis_summary], ["file", "Citadel interns earn $5,000 a week.", [1], undefined]);
  ok(!/9,000 a week/.test(enforceMarketReply("Citadel interns earn $9,000 a week.", r)));
});
