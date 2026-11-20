// FEATURE 12 unit tests: the offer turn's pieces (career_offer_chat.ts) on the WO-036 fixture datasets. The handler-level
// proof is flow-offer-benchmark.test.ts.
import assertNode from "node:assert/strict";
import { offerChatTurn, offerData, type OfferChatState, percentileOf, postedPay, yearlyRange } from "../../supabase/functions/_shared/career_offer_chat.ts";
import { offerTurn, parseOfferWords, payData } from "../../supabase/functions/_shared/career_offer.ts";
import { HYGIENE } from "../../evals/career/compare.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const root = new URL("../../", import.meta.url);
const readJson = async (p: string) => JSON.parse(await Deno.readTextFile(new URL(p, root)));
const NOW = Date.UTC(2026, 9, 25, 15);
const fixtures = { ...payData(), lca_wages: await readJson("tests/fixtures/career-pay/lca-wages.fixture.json"), oews_metro: await readJson("tests/fixtures/career-pay/oews-metro.fixture.json") };
offerData.get = () => fixtures;
const rows = (mids: number[], title = "Data Analyst", location = "Chicago, IL") => mids.map((m, i) => ({ company: `Co${i}`, title, location, pay: `$${m - 5000}–$${m + 5000}` }));
const reader = (r: any[]) => ({ search: async () => r });
function clean(parts: string[]) {
  for (const p of parts) {
    assert(p.length <= 1500, `a message of ${p.length}`);
    for (const h of HYGIENE) if (h.id !== "too_long") assert(!h.test(p), `${h.what}: ${p}`);
  }
}

Deno.test("F12/U1 percentile: exact where published, a labeled straight-line estimate between, never extrapolated past the band", () => {
  const b = { p25: 90000, median: 120000, p75: 160000 };
  eq(percentileOf(120000, b), "at exactly the 50th percentile");
  eq(percentileOf(110000, b), "at about the 42nd percentile (estimated between the published 25th and 50th)");
  eq(percentileOf(140000, b), "at about the 63rd percentile (estimated between the published 50th and 75th)");
  eq(percentileOf(80000, b), "below the 25th percentile");
  eq(percentileOf(200000, b), "above the 75th percentile");
  eq(percentileOf(100000, { p25: null, median: 120000, p75: null }), null, "one published point places nothing");
});

Deno.test("F12/U2 posted ranges: yearly USD only; hourly, monthly and other currencies are not converted", () => {
  eq(yearlyRange("$120,000–$150,000 (Base salary)"), { lo: 120000, hi: 150000 });
  eq(yearlyRange("$95k - $110k"), { lo: 95000, hi: 110000 });
  eq(yearlyRange("from $100,000"), { lo: 100000, hi: 100000 });
  for (const t of ["$40–$55 per hour", "$8,000 per month", "EUR 60,000–75,000", "£50,000", null, "", "$500"]) eq(yearlyRange(t), null, String(t));
});

Deno.test("F12/U3 postings: a median only from 5 or more; fewer is a refusal with the count; an unreadable read is said", async () => {
  const o = parseOfferWords("is $95k good for a data analyst in Chicago", fixtures);
  const four = await postedPay(o, reader(rows([90000, 100000, 110000, 120000])), fixtures, NOW);
  eq([four!.shown, four!.n, four!.median], [false, 4, null]);
  assert(/only 4 open postings on file state a yearly pay range, too few for a median \(I need at least 5\)/.test(four!.reason!), four!.reason!);
  const five = await postedPay(o, reader([...rows([90000, 100000, 110000, 120000, 130000]), ...rows([500000], "Data Analyst", "Austin, TX"), ...rows([500000], "Data Engineer")]), fixtures, NOW);
  eq([five!.shown, five!.n, five!.median, five!.below], [true, 5, 110000, 1], "other metros and other titles are left out");
  const down = await postedPay(o, { search: () => Promise.reject(new Error("boom")) }, fixtures, NOW);
  eq([down!.shown, down!.reason], [false, "the postings could not be read just now"]);
});

Deno.test("F12/U4 the turn: a half-told ask is the last word only; another ask drops it and the router answers", async () => {
  const a = await offerChatTurn({ message: "Stripe offered me 150k", state: null, now: NOW });
  eq(a.answer?.intent, "career_offer_ask");
  const b = await offerChatTurn({ message: "find software engineer jobs in Seattle", state: a.state, now: NOW + 1000 });
  eq(b.answer, null, "a search is never the offer's missing piece");
  eq(b.state?.asked, []);
  const c = await offerChatTurn({ message: "software engineer in Seattle", state: b.state, now: NOW + 2000 });
  eq(c.answer, null, "the ask was dropped, so a later message is not read as its answer");
  // The state keeps the shape WO-036's brain tool reads.
  const brain = offerTurn({ words: "software engineer in Seattle", pending: a.state as any, now: NOW + 3000, data: fixtures });
  eq(brain.result.offer.company, "Stripe");
});

// Architect amendment (owner decision 2026-11-13, D-078: confirm before compare): an offer's reading is shown first and the
// person's plain yes to it comes before any comparison or counter, so `told` answers the reading shown with "yes".
async function told(message: string, state: OfferChatState | null) {
  const r = await offerChatTurn({ message, state, now: NOW });
  return r.answer?.intent === "career_offer_confirm" ? offerChatTurn({ message: "yes", state: r.state, now: NOW, lastReply: r.answer.reply }) : r;
}
Deno.test("F12/U5 compare: two places say no cost-of-living data; equity is never valued; nothing is invented for a missing field", async () => {
  let s: OfferChatState | null = null;
  for (const m of ["Stripe offered me $160k base as a software engineer in New York with 0.1% equity", "Acme Robotics offered 150k base, Seattle, software engineer, 10% target bonus"]) {
    s = (await told(m, s)).state; // Architect amendment (D-078): each reading confirmed
  }
  const r = await offerChatTurn({ message: "which offer is better? compare them", state: s, now: NOW });
  eq(r.answer?.intent, "career_offer_compare");
  const t = r.answer!.reply;
  assert(/Cost of living: no cost-of-living dataset is on file, so the places are not adjusted against each other\./.test(t), t);
  assert(/Equity: Stripe 0\.1% equity \(as you said it, not valued\); Acme Robotics not given\./.test(t), t);
  assert(/Bonus: Stripe not given; Acme Robotics target 10% \(target, not guaranteed\)\./.test(t), t);
  assert(/Acme Robotics no market number with enough data|Acme Robotics median/.test(t), t);
  clean(r.answer!.parts);
});

Deno.test("F12/U6 counter: a competing offer leads, the benchmark is still cited; with no market number none is cited", async () => {
  let s: OfferChatState | null = null;
  s = (await told("JPM offered 110k base, 15k signing, NYC, analyst", s)).state; // Architect amendment (D-078): each reading confirmed
  s = (await told("Citi offered me 115k base in New York as an analyst", s)).state;
  const r = await offerChatTurn({ message: "help me negotiate with JPM", state: s, now: NOW });
  eq(r.answer?.intent, "career_offer_counter");
  const body = r.answer!.card!.body;
  assert(/I have another offer from Citi with a base of \$115,000\./.test(body) && /shows a median of \$120,000\./.test(body), body);
  eq(r.answer!.card!.sent, false);
  clean(r.answer!.parts);
  const none = await told("Acme offered me $150k as a product manager in Denver. Help me negotiate", null); // Architect amendment (D-078)
  eq(none.answer?.intent, "career_offer_counter");
  assert(/I have no market number with enough data behind it, so the draft cites none/.test(none.answer!.reply) && !/median/.test(none.answer!.card!.body), none.answer!.reply);
});

Deno.test("F12/U7 not claimed: no number, no offer words, or nothing on file", async () => {
  for (const m of ["I got an offer from Stripe!", "what's a good salary to ask for?", "help me negotiate", "find data analyst jobs paying 95k in Chicago"]) {
    eq((await offerChatTurn({ message: m, state: null, now: NOW })).answer, null, m);
  }
});
