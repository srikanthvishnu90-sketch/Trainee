// 2026-11-13 (review of PR #788): a salary in the wrong currency or period, or placed against a benchmark in another
// currency, period or country, is a wrong fact. The offer reader says what it could not determine instead of assuming:
//   1. the currency is read from symbols, ISO codes and written names; "$" with a place whose own money is a dollar or a
//      peso, "kr", "¥" and "pesos" are ambiguous; nothing said is "currency not stated" and is never printed with "$";
//   2. an amount with no currency of its own inherits the offer's only stated currency, never dollars by default;
//   3. the period (hour, day, week, two weeks, month, year) is read; a yearly figure worked out from a rate is an estimate
//      with its assumption shown (2,080 hours, 52 weeks, 26 pay periods, 12 months); a daily rate is not annualised;
//   4. US pay data is placed only against a US-dollar offer for a US place (or no place / remote).
// The whole path: the reader, the brain tool's reply, the chat turn and the counter-offer card. No model, no network.
//
//   deno test -A --no-check tests/architect/offer-currency-period-20261113.test.ts
// deno-lint-ignore-file no-explicit-any
import { benchmarks, moneyIn, offerReply, parseOfferWords } from "../../supabase/functions/_shared/career_offer.ts";
import { offerChatTurn } from "../../supabase/functions/_shared/career_offer_chat.ts";

const NOW = Date.UTC(2026, 10, 13, 15);
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
interface Case { m: string; cur: string; base?: number | null; period?: string | null; rate?: number; factor?: number; signing?: string; bonus?: string; bench: boolean; not?: RegExp; has?: RegExp }
const swe = (pay: string, place: string) => `Offer from Acme: ${pay} as a software engineer in ${place}`;
const CASES: Case[] = [
  // ---- finding 1: the currency as said, never US dollars by default, never against US data
  { m: "Offer from Shopify: 95k Canadian dollars base as a software engineer in Toronto", cur: "CAD", base: 95000, bench: false, not: /29% below/ },
  { m: "Offer from Atlassian: 120k Australian dollars base as a software engineer in Sydney", cur: "AUD", base: 120000, bench: false },
  { m: swe("base 550,000 kr", "Stockholm"), cur: "XXX", base: 550000, bench: false, has: /kr/ },
  { m: swe("RMB 400,000 base", "Shanghai"), cur: "CNY", base: 400000, bench: false },
  { m: swe("Rs 1,800,000 base", "Pune"), cur: "INR", base: 1800000, bench: false },
  { m: "Offer from Shopify: $95k base as a software engineer in Toronto", cur: "XXX", base: 95000, bench: false },
  { m: swe("$120k base", "Sydney"), cur: "XXX", base: 120000, bench: false },
  { m: swe("$90k base", "Singapore"), cur: "XXX", base: 90000, bench: false },
  { m: swe("$900,000 base", "Mexico City"), cur: "XXX", base: 900000, bench: false },
  { m: swe("¥8,000,000 base", "Shanghai"), cur: "XXX", base: 8000000, bench: false },
  { m: swe("1,200,000 pesos base", "Mexico City"), cur: "XXX", base: 1200000, bench: false },
  { m: swe("95k base", "Toronto"), cur: "XXX", base: 95000, bench: false },
  { m: swe("110k base", "Berlin"), cur: "XXX", base: 110000, bench: false },
  { m: swe("CAD 95,000 base", "Toronto"), cur: "CAD", base: 95000, bench: false },
  { m: swe("95,000 CAD base", "Toronto"), cur: "CAD", base: 95000, bench: false },
  { m: swe("95k cad base", "Toronto"), cur: "CAD", base: 95000, bench: false },
  { m: swe("C$95k base", "Toronto"), cur: "CAD", base: 95000, bench: false },
  { m: swe("A$120k base", "Melbourne"), cur: "AUD", base: 120000, bench: false },
  { m: swe("NZ$110k base", "Auckland"), cur: "NZD", base: 110000, bench: false },
  { m: swe("£70k base", "London"), cur: "GBP", base: 70000, bench: false },
  { m: swe("70k pounds base", "London"), cur: "GBP", base: 70000, bench: false },
  { m: swe("110k euros base", "Dublin"), cur: "EUR", base: 110000, bench: false },
  { m: swe("₹2,500,000 base", "Bangalore"), cur: "INR", base: 2500000, bench: false },
  { m: swe("INR 2,500,000 base", "Hyderabad"), cur: "INR", base: 2500000, bench: false },
  { m: swe("9,000,000 yen base", "Tokyo"), cur: "JPY", base: 9000000, bench: false },
  { m: swe("JPY 9,000,000 base", "Tokyo"), cur: "JPY", base: 9000000, bench: false },
  { m: swe("400,000 yuan base", "Shenzhen"), cur: "CNY", base: 400000, bench: false },
  { m: swe("CHF 120,000 base", "Zurich"), cur: "CHF", base: 120000, bench: false },
  { m: swe("SGD 96,000 base", "Singapore"), cur: "SGD", base: 96000, bench: false },
  { m: swe("HKD 600,000 base", "Hong Kong"), cur: "HKD", base: 600000, bench: false },
  { m: swe("MXN 900,000 base", "Guadalajara"), cur: "MXN", base: 900000, bench: false },
  { m: swe("R$240k base", "Sao Paulo"), cur: "BRL", base: 240000, bench: false },
  { m: swe("650,000 Swedish kronor base", "Stockholm"), cur: "SEK", base: 650000, bench: false },
  { m: swe("NOK 800,000 base", "Oslo"), cur: "NOK", base: 800000, bench: false },
  { m: swe("DKK 600,000 base", "Copenhagen"), cur: "DKK", base: 600000, bench: false },
  // US dollars said outright for a job in another country: kept in dollars, never placed against US pay data.
  { m: swe("US$95k base", "Toronto"), cur: "USD", base: 95000, bench: false, has: /Toronto/ },
  { m: swe("95k USD base", "London"), cur: "USD", base: 95000, bench: false },
  // ---- true cases: a US place
  { m: swe("$110k base", "Austin"), cur: "USD", base: 110000, bench: true },
  { m: swe("110k base", "Austin"), cur: "USD", base: 110000, bench: true, has: /currency not stated/i },
  { m: swe("$95k base", "Springfield, Illinois"), cur: "USD", base: 95000, bench: true },
  { m: swe("USD 130,000 base", "Seattle"), cur: "USD", base: 130000, bench: true },
  { m: swe("$110,000 a year", "Chicago"), cur: "USD", base: 110000, period: "year", bench: true },
  // ---- finding 2: a figure with no currency of its own
  { m: "Offer from SAP: €60k base, 5k signing, as a data analyst in Berlin", cur: "EUR", base: 60000, signing: "EUR", bench: false, has: /EUR 5,000/ },
  { m: "Offer from Acme: 70k USD base, 10k EUR signing, as a software engineer in Austin", cur: "USD", signing: "EUR", bench: true },
  { m: "Offer from Acme: 70k USD base, 10k EUR signing, 5k bonus, as a software engineer in Austin", cur: "USD", signing: "EUR", bonus: "XXX", bench: true, not: /\$5,000/ },
  { m: "Offer from Acme: $110k base, 15k signing, as a software engineer in Austin", cur: "USD", signing: "USD", bench: true },
  { m: "Coinbase offered me AUD 87,600 base and a $10,000 signing bonus as a complaints analyst in Sydney", cur: "AUD", signing: "XXX", bench: false, not: /\$/ },
  { m: "Offer from Acme: £70k base, 10% bonus, 5k signing, as a data analyst in London", cur: "GBP", signing: "GBP", bench: false },
  // ---- finding 3: the period
  { m: "I got an offer from Acme for $6,500 per month as a software engineer in Austin", cur: "USD", period: "month", rate: 6500, factor: 12, base: 78000, bench: true, not: /9\d% below/, has: /12 months/ },
  { m: "Offer from Acme: 8k a month base as a software engineer in Austin", cur: "USD", period: "month", rate: 8000, factor: 12, base: 96000, bench: true },
  { m: "Offer from Acme: $1,500 a week as a software engineer in Chicago", cur: "USD", period: "week", rate: 1500, factor: 52, base: 78000, bench: true, has: /52 weeks/ },
  { m: "Offer from Acme: $3,000 biweekly as a software engineer in Chicago", cur: "USD", period: "biweek", rate: 3000, factor: 26, base: 78000, bench: true, has: /26 pay periods/ },
  { m: "Offer from Acme: $3,000 every two weeks as a software engineer in Chicago", cur: "USD", period: "biweek", rate: 3000, factor: 26, base: 78000, bench: true },
  { m: "Offer from Acme: $50/hr as a software engineer in Austin", cur: "USD", period: "hour", rate: 50, factor: 2080, base: 104000, bench: true, has: /2,080 hours/ },
  { m: "Offer from Acme: $400 a day as a data analyst in Chicago", cur: "USD", period: "day", rate: 400, base: null, bench: false, has: /daily rate/ },
  { m: "Offer from Acme: £45 an hour as a data analyst in London", cur: "GBP", period: "hour", rate: 45, factor: 2080, bench: false },
  { m: "Offer from Acme: 45 GBP/hr as a data analyst in London", cur: "GBP", period: "hour", rate: 45, factor: 2080, bench: false, has: /GBP 45 an hour/ },
  { m: "Offer from Acme: EUR 40 per hour as a data analyst in Berlin", cur: "EUR", period: "hour", rate: 40, factor: 2080, bench: false },
  { m: "Offer from Acme: 38 CAD an hour as a data analyst in Toronto", cur: "CAD", period: "hour", rate: 38, factor: 2080, bench: false },
  { m: "Offer from Acme: CAD 4,000 a month as a data analyst in Toronto", cur: "CAD", period: "month", rate: 4000, factor: 12, base: 48000, bench: false },
  { m: "Offer from Acme: €5,000 per month as a data analyst in Madrid", cur: "EUR", period: "month", rate: 5000, factor: 12, base: 60000, bench: false },
  { m: "Offer from Acme: 30 an hour as a data analyst in Toronto", cur: "XXX", period: "hour", rate: 30, bench: false },
];

Deno.test(`the offer reader on ${CASES.length} offers: currency, period and benchmark are said as stated or said to be unknown`, async () => {
  if (CASES.length < 40) throw new Error("fewer than 40 table cases");
  const bad: string[] = [];
  for (const c of CASES) {
    try {
      const o: any = parseOfferWords(c.m);
      eq(o.currency, c.cur, "currency");
      if (c.base !== undefined) eq(o.base, c.base, "base");
      if (c.period !== undefined) eq(o.period, c.period, "period");
      if (c.rate !== undefined) eq(o.rate, { amount: c.rate, period: c.period }, "rate");
      if (c.factor !== undefined) eq(o.annualized?.factor, c.factor, "annualising factor");
      if (c.signing) eq(o.currencies?.signing, c.signing, "signing currency");
      if (c.bonus) eq(o.currencies?.bonus, c.bonus, "bonus currency");
      const brain = offerReply(o, []);
      const first = await offerChatTurn({ message: c.m, state: null, now: NOW, postings: null });
      const second = o.base != null ? await offerChatTurn({ message: "help me negotiate", state: first.state, now: NOW + 1000, postings: null }) : null;
      const all = [...brain.messages, brain.draft?.email ?? "", first.answer?.reply ?? "", second?.answer?.reply ?? "", second?.answer?.card?.body ?? ""].join("\n");
      if (!first.answer) throw new Error("the chat turn did not take the offer");
      if (c.cur === "XXX" || c.signing === "XXX" || c.bonus === "XXX") {
        if (!/currency not stated/i.test(all)) throw new Error("an unknown currency is not said to be unknown");
        if (c.cur === "XXX" && !/currency not stated/.test(String(o.currency_fact))) throw new Error(`no currency fact: ${o.currency_fact}`);
      }
      if (![c.cur, c.signing, c.bonus].includes("USD") && all.includes("$")) throw new Error(`"$" printed for an offer with no US-dollar figure: ${all.split("\n").find((l) => l.includes("$"))}`);
      const shown = benchmarks(o).filter((b) => b.shown);
      if (c.bench && !shown.length) throw new Error("a US-dollar yearly offer in a US place lost its benchmark");
      if (!c.bench && (shown.length || /% (?:above|below) the median|median \$|percentile/.test(all))) throw new Error(`placed against US pay data: ${all.split("\n").find((l) => /median|percentile/.test(l))}`);
      if (c.factor !== undefined && c.base != null && !/estimate/.test(all)) throw new Error("a yearly figure worked out from a rate is not said to be an estimate");
      if (c.not && c.not.test(all)) throw new Error(`said ${c.not}: ${all.split("\n").find((l) => c.not!.test(l))}`);
      if (c.has && !c.has.test(all)) throw new Error(`did not say ${c.has}: ${all.slice(0, 400)}`);
    } catch (e) { bad.push(`${c.m}\n    ${(e as Error).message.replace(/\n/g, "\n    ")}`); }
  }
  if (bad.length) throw new Error(`${bad.length} of ${CASES.length} offers wrong:\n  ${bad.join("\n  ")}`);
});

Deno.test("an amount in an unknown currency is written without a symbol, and never added to or weighed against another", async () => {
  eq(moneyIn(95000, "XXX"), "95,000 (currency not stated)");
  eq(moneyIn(95000, "CAD"), "CAD 95,000");
  eq(moneyIn(95000, "USD"), "$95,000");
  // Two unknown-currency figures are not added up; a competing offer in an unknown currency is never the counter's lever.
  const t = await offerChatTurn({ message: "I got an offer from Shopify: $95k base and a $10k signing bonus as a software engineer in Toronto", state: null, now: NOW, postings: null });
  const cash = await offerChatTurn({ message: "I got an offer from Betaworks: $120k base as a software engineer in Toronto", state: t.state, now: NOW + 1, postings: null });
  const cmp = await offerChatTurn({ message: "compare my offers", state: cash.state, now: NOW + 2, postings: null });
  const row = (i: number, k: string) => (cmp.answer as any).comparison.offers[i].rows.find((r: any) => r.k === k)?.v;
  eq(row(0, "Base"), "95,000 (currency not stated)");
  if (/105,000/.test(String(row(0, "Guaranteed first-year cash")))) throw new Error(`added two figures of unknown currency: ${row(0, "Guaranteed first-year cash")}`);
  if (cmp.answer!.reply.includes("$")) throw new Error(`"$" in the comparison: ${cmp.answer!.reply}`);
  const neg = await offerChatTurn({ message: "help me negotiate with Shopify", state: cash.state, now: NOW + 3, postings: null });
  if (/120,000/.test(neg.answer!.card!.body)) throw new Error("an offer in an unknown currency was used as leverage");
  // A competing figure with no currency of its own inherits the only stated one; with two stated, it is unknown.
  eq(parseOfferWords("Offer from Acme: €90k base as a data analyst in Berlin, I also have another offer from Beta for 100k").competing.map((x) => x.currency), ["EUR"]);
  eq(parseOfferWords("Offer from Acme: 90k base as a data analyst in Berlin, I also have another offer from Beta for 100k").competing.map((x) => x.currency), ["XXX"]);
  // The city answered later settles a bare amount: a US metro reads it as US dollars and says that it did.
  const a = await offerChatTurn({ message: "Stripe offered me 150k", state: null, now: NOW, postings: null });
  if (a.answer!.reply.includes("$")) throw new Error(`"$" before the currency is known: ${a.answer!.reply}`);
  const b = await offerChatTurn({ message: "software engineer in Seattle", state: a.state, now: NOW + 5, postings: null });
  eq((b.state as any).offers.at(-1).offer.currency, "USD");
  if (!/currency not stated/i.test(b.answer!.reply) || !/\$150,000/.test(b.answer!.reply)) throw new Error(b.answer!.reply);
  const c = await offerChatTurn({ message: "software engineer in Toronto", state: a.state, now: NOW + 5, postings: null });
  eq((c.state as any).offers.at(-1).offer.currency, "XXX");
});
