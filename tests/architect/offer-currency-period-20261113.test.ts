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
interface Case { m: string; cur: string; base?: number | null; period?: string | null; rate?: number; factor?: number; signing?: string; bonus?: string; bench: boolean; not?: RegExp; has?: RegExp; assumed?: string[]; wrote?: string[] }
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
  { m: "Offer from Acme: £70k base, 10% bonus, 5k signing, as a data analyst in London", cur: "GBP", signing: "GBP", bench: false },
  // ---- read as US dollars on an assumption (a "$" or nothing, for a place code cannot confirm is in the United States, or a "$"
  // beside another stated currency): the parsed currency stays USD, marked assumed; it is never benchmarked, added or weighed,
  // the reply asks to confirm it, and the counter email writes the figure as the person wrote it.
  { m: swe("110k base", "Berlin"), cur: "USD", base: 110000, bench: false, assumed: ["base"], wrote: ["110k"], not: /base of \$110,000/ },
  { m: swe("$110k base", "Berlin"), cur: "USD", base: 110000, bench: false, assumed: ["base"], wrote: ["$110k"], not: /base of \$110,000/ },
  { m: "Coinbase offered me AUD 87,600 base and a $10,000 signing bonus as a complaints analyst in Sydney", cur: "AUD", signing: "USD", bench: false, assumed: ["signing"], wrote: ["$10,000"] },
  { m: "Dropbox offered me PLN 368,000 base and a $10,000 signing bonus as an infrastructure software engineer in Warsaw", cur: "PLN", signing: "USD", bench: false, assumed: ["signing"], wrote: ["$10,000"], not: /378,000/ },
  { m: swe("$95,000 base", "London"), cur: "USD", base: 95000, bench: false, assumed: ["base"], wrote: ["$95,000"] },
  { m: swe("95,000 base", "Pune"), cur: "USD", base: 95000, bench: false, assumed: ["base"], wrote: ["95,000"], not: /base of \$95,000/ },
  { m: swe("$120k base and a $10k signing bonus", "Dublin"), cur: "USD", signing: "USD", bench: false, assumed: ["base", "signing"], wrote: ["$120k", "$10k"], not: /130,000/ },
  { m: swe("CAD 95,000 base and a $5,000 signing bonus", "Toronto"), cur: "CAD", signing: "USD", bench: false, assumed: ["signing"], wrote: ["$5,000"], not: /100,000/ },
  { m: swe("€60k base and a $5k signing bonus", "Berlin"), cur: "EUR", signing: "USD", bench: false, assumed: ["signing"], wrote: ["$5k"], not: /65,000/ },
  { m: swe("$40 an hour", "Warsaw"), cur: "USD", period: "hour", rate: 40, bench: false, assumed: ["base"], wrote: ["$40 an hour"], not: /base of \$83,200/ },
  { m: swe("$6,000 a month", "Tokyo"), cur: "USD", period: "month", rate: 6000, bench: false, assumed: ["base"], wrote: ["$6,000 a month"] },
  { m: swe("85k base", "Scottsdale"), cur: "USD", base: 85000, bench: false, assumed: ["base"], wrote: ["85k"] },
  { m: swe("$85k base", "Lagos"), cur: "USD", base: 85000, bench: false, assumed: ["base"], wrote: ["$85k"] },
  { m: "Offer from Acme: 80k base, 5k signing, as a data analyst in Amsterdam", cur: "USD", signing: "USD", bench: false, assumed: ["base", "signing"], wrote: ["80k", "5k"], not: /85,000/ },
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
      // The counter writes each figure as the person wrote it; everywhere else no "$" is printed for a figure that is not US dollars.
      const said = Object.values(o.written ?? {}).reduce((x: string, w) => x.split(String(w)).join(""), all);
      if (![c.cur, c.signing, c.bonus].includes("USD") && said.includes("$")) throw new Error(`"$" printed for an offer with no US-dollar figure: ${said.split("\n").find((l) => l.includes("$"))}`);
      eq(Object.keys(o.currency_assumed ?? {}), c.assumed ?? [], "figures read on an assumption");
      if (c.assumed) {
        if (!/currency not stated/i.test(all) || !/read as US dollars/.test(all) || !/please confirm the currency/.test(all)) throw new Error("an assumed currency is not said to be one, or not asked about");
        for (const mail of [brain.draft?.email ?? "", second?.answer?.card?.body ?? ""]) for (const w of c.wrote ?? []) if (!mail.includes(w)) throw new Error(`the counter does not write "${w}" as the person wrote it: ${mail}`);
      }
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
  eq(parseOfferWords("Offer from Acme: 90k base as a data analyst in Berlin, I also have another offer from Beta for 100k").competing.map((x) => [x.currency, x.assumed]), [["USD", true]]);
  eq(parseOfferWords("Offer from Acme: 90k base as a data analyst in Toronto, I also have another offer from Beta for 100k").competing.map((x) => x.currency), ["XXX"]);
  // The city answered later settles a bare amount: a US metro reads it as US dollars and says that it did.
  const a = await offerChatTurn({ message: "Stripe offered me 150k", state: null, now: NOW, postings: null });
  if (a.answer!.reply.includes("$")) throw new Error(`"$" before the currency is known: ${a.answer!.reply}`);
  const b = await offerChatTurn({ message: "software engineer in Seattle", state: a.state, now: NOW + 5, postings: null });
  eq((b.state as any).offers.at(-1).offer.currency, "USD");
  if (!/currency not stated/i.test(b.answer!.reply) || !/\$150,000/.test(b.answer!.reply)) throw new Error(b.answer!.reply);
  const c = await offerChatTurn({ message: "software engineer in Toronto", state: a.state, now: NOW + 5, postings: null });
  eq((c.state as any).offers.at(-1).offer.currency, "XXX");
});

// ---------------------------------------------------------------- round 2: the completeness rule, the place, hours, the counter
// Every money, currency, period, range, total-pay or place word must be taken by exactly one field; what is not is `open`, the
// offer is `unsettled`, and the reply restates what was read and asks: no benchmark, no percent, no leverage, no counter.
const G = (pay: string, where = "in Seattle") => `Google offered me ${pay} as a software engineer ${where}`;
const run = async (m: string) => { let state: any = null, last: any = null; for (const x of m.split(" >> ")) { last = await offerChatTurn({ message: x, state, now: NOW, postings: null }); state = last.state; } return { last, state, o: state?.offers?.at(-1)?.offer }; };
interface R2 { m: string; unsettled?: true; cur?: string; base?: number | null; metro?: string | null; kind?: string; bench?: boolean; total?: string; occ?: null; part?: true; period?: string }
const ROUND2: R2[] = [
  // A: a currency said away from the figure settles it; a contradiction, a range, a second figure or a second place does not
  { m: G("150k base", "in Seattle, paid in CAD"), cur: "CAD", bench: false }, { m: G("150k base in Canadian dollars"), cur: "CAD", bench: false },
  { m: G("$150k (CAD) base"), cur: "CAD", bench: false }, { m: G("150k base", "in Seattle (Canadian dollars)"), cur: "CAD", bench: false },
  { m: `${G("150k base")}. It's in CAD`, cur: "CAD", bench: false }, { m: `${G("150k base")} >> sorry that's in CAD`, cur: "CAD", bench: false },
  { m: G("150,000 sterling base", "in New York"), cur: "GBP", bench: false }, { m: G("GBP150k base", "in New York"), cur: "GBP", bench: false },
  { m: G("150k base and a 20k signing bonus in CAD"), cur: "CAD", bench: false }, { m: G("€150k base", "in Seattle, paid in CAD"), unsettled: true },
  { m: G("Rs. 1,800,000 base"), cur: "INR", bench: false }, { m: G("Rs. 1800000 base", "in Pune"), cur: "INR", bench: false }, { m: G("18 lakhs base", "in Hyderabad"), cur: "XXX", base: 1800000, bench: false },
  { m: G("$5,000 twice a month", "in Atlanta"), base: 120000, period: "semimonth", bench: true }, { m: G("$5,000 semi-monthly", "in Atlanta"), base: 120000, period: "semimonth" },
  { m: G("$1,5k a week", "in Chicago"), unsettled: true }, { m: G("90-110k base"), unsettled: true }, { m: G("$90k-$110k base"), unsettled: true }, { m: G("between 90k and 110k"), unsettled: true },
  { m: G("150k base and 250k total comp"), base: 150000, total: "250k", bench: true }, { m: G("250k OTE"), base: null, total: "250k" }, { m: G("TC 250k"), base: null, total: "250k" },
  { m: "Google offered me 150k base as a software engineer in Seattle and Meta offered me 160k in London", unsettled: true }, { m: "Google offered me $150k in Seattle or C$160k in Toronto as a software engineer", unsettled: true },
  { m: G("120m base", "in Chicago"), unsettled: true }, { m: G("$150,000.00 base"), base: 150000, bench: true }, { m: G("a monthly salary of 9,500", "in Boston"), base: 114000, period: "month" },
  // B: the stated place wins over a metro guess
  { m: G("$100k base", "in Tbilisi, Georgia"), unsettled: true }, { m: G("$100k base", "in Toronto, CA"), unsettled: true }, { m: G("100k base", "in Vancouver, CA"), unsettled: true },
  { m: G("$100k base", "in San Jose, Costa Rica"), metro: null, kind: "other", bench: false }, { m: G("$150k base", "in Queens, Ontario"), metro: null, kind: "dollar", bench: false },
  { m: G("$150k base", "in Miami, Australia"), metro: null, kind: "dollar", bench: false }, { m: G("$100k base", "in Arlington, Texas"), metro: null, kind: "us", bench: true },
  { m: G("$100k base", "in Newark, Delaware"), metro: null, kind: "us" }, { m: G("100k base", "in Manhattan, Kansas"), metro: null, kind: "us" }, { m: G("$130k base", "in Cambridge, MA"), metro: "boston", bench: true },
  { m: G("$130k base", "in Cambridge"), metro: null, kind: "other", bench: false }, { m: G("$100k base", ", relocating from Toronto to Seattle"), metro: "seattle", cur: "USD", bench: true },
  { m: G("$100k base", ", relocating from Seattle to Toronto"), metro: null, cur: "XXX", bench: false }, { m: G("$150k base", "in Washington, DC"), metro: "washington-dc", bench: true },
  // C: stated hours, a duration, part-time, an internship or a contract: the rate is not compared as a yearly figure
  { m: G("$45/hr for a 12-week internship"), part: true, bench: false }, { m: G("$45/hr, 20 hrs/week,"), part: true, bench: false }, { m: G("$45 an hour part-time"), part: true, bench: false },
  { m: G("a 6 month contract at $80/hr", "in Austin"), part: true, bench: false }, { m: G("$45/hr"), base: 93600, bench: true },
  // E: an occupation only on a whole-phrase match
  { m: "Google offered me $150k base as a real estate developer in Seattle", occ: null, bench: false }, { m: "Google offered me $150k base as a sales consultant in Seattle", occ: null, bench: false },
  { m: "Google offered me $90k base as a market research analyst in Chicago", occ: null, bench: false }, { m: "Google offered me $90k base as a business developer in Chicago", occ: null, bench: false },
  { m: "Google offered me $150k base as a senior software engineer in Seattle", bench: true },
];
Deno.test(`round 2: ${ROUND2.length} offers are read whole or left unsettled; nothing half-read is compared`, async () => {
  const bad: string[] = [];
  for (const c of ROUND2) {
    try {
      const { last, state, o } = await run(c.m);
      const reply = String(last.answer?.reply ?? "");
      if (c.unsettled) {
        if (!o?.unsettled || !(o.open ?? []).length) throw new Error(`not unsettled: ${JSON.stringify([o?.base, o?.currency, o?.place, o?.open])}`);
        if (last.answer?.status !== "unsettled" || !/I could not place/.test(reply) || !/Here is what I read/.test(reply)) throw new Error(`the reply does not restate and ask: ${reply}`);
        if (/median|percentile|% (?:above|below)/.test(reply) || benchmarks(o).length) throw new Error("an unsettled offer was compared");
        const neg = await offerChatTurn({ message: "help me negotiate", state, now: NOW + 9, postings: null });
        if (neg.answer?.card) throw new Error("a counter was drafted for an unsettled offer");
        continue;
      }
      if (!o && c.base !== null) throw new Error(`not kept: ${reply}`);
      const got = o ?? parseOfferWords(c.m);
      if (got.unsettled) throw new Error(`unsettled: ${JSON.stringify(got.open)}`);
      if (c.cur) eq(got.currency, c.cur, "currency");
      if (c.base !== undefined) eq(got.base, c.base, "base");
      if (c.period) eq(got.period, c.period, "period");
      if (c.metro !== undefined) eq(got.metro, c.metro, "metro");
      if (c.kind) eq(got.place_kind, c.kind, "place kind");
      if (c.total) eq(got.total?.written, c.total, "total pay");
      if (c.occ === null) eq(got.occupation, null, "occupation");
      if (c.part && !got.part_year) throw new Error("the hours or duration signal was not read");
      const shown = benchmarks(got).filter((b) => b.shown);
      if (c.bench === true && !shown.length) throw new Error("lost its benchmark");
      if (c.bench === false && (shown.length || /% (?:above|below) the median|median \$|percentile/.test(reply))) throw new Error(`compared: ${reply.split("\n").find((l) => /median|percentile/.test(l))}`);
    } catch (e) { bad.push(`${c.m}\n    ${(e as Error).message.replace(/\n/g, "\n    ")}`); }
  }
  if (bad.length) throw new Error(`${bad.length} of ${ROUND2.length} wrong:\n  ${bad.join("\n  ")}`);
});

// D: the counter. Figures as written and in their own period; a rate never against a yearly median; another offer weighed only
// like for like, else cited as written; drafted to the company named, never to one only mentioned; never "the role role".
const EMAILS: { m: string; has?: RegExp[]; not?: RegExp[]; none?: true }[] = [
  { m: `${G("$150k base")}. I also have an offer from Meta for $170k >> help me negotiate`, has: [/Software engineer offer, Google/, /another offer from Meta with a base of \$170,000/], not: [/role role/, /base of \$170,000\. Before/] },
  { m: `${G("$150k base")}. I also have another offer from Meta for $95/hr >> help me negotiate`, has: [/offer, Google/, /I also have an offer from Meta: \$95\/hr\./], not: [/197,600/, /bring the base to/] },
  { m: `${G("$150k base")}. I also have another offer from Meta for $14k a month >> help me negotiate`, has: [/Meta: \$14k a month\./], not: [/168,000/] },
  { m: `${G("£90k base", "in London")}. I also have an offer from Meta for 100k >> help me negotiate`, has: [/base of £90k/, /Meta: 100k\./], not: [/GBP 100,000/, /bring the base to/] },
  { m: `${G("100k base", "in London")}. I also have an offer from Meta for £110k >> help me negotiate`, has: [/base of 100k/, /Meta: £110k\./], not: [/GBP/, /bring the base to/] },
  { m: `${G("150k base")}. I also have an offer from Shopify for 170k in Toronto >> help me negotiate`, has: [/offer, Google/, /Shopify: 170k\./], not: [/\$170,000/, /bring the base to/] },
  { m: `${G("$45/hr")} >> help me negotiate`, has: [/base of \$45\/hr/], not: [/93,600/, /median/] },
  { m: `${G("$8,500 a month", "in New York")} >> help me negotiate`, has: [/\$8,500 a month/], not: [/102,000/, /median/] },
  { m: `${G("$3,000 biweekly", "in Chicago")} >> help me negotiate`, has: [/\$3,000 biweekly/], not: [/78,000/, /median/] },
  { m: `${G("$150k base")} >> Stripe offered me $15k a month as a software engineer in Seattle >> help me negotiate with Google`, has: [/offer, Google/, /base of \$150,000/, /Stripe: \$15k a month\./], not: [/180,000/, /15,000 a month\. Before/] },
  { m: `${G("$150k base")} >> Stripe offered me 180k base as a software engineer in Dublin >> help me negotiate with Google >> help me negotiate`, has: [/offer, Google/, /Stripe: 180k\./], not: [/\$180,000/] },
  { m: `${G("$150k base")} >> Stripe offered me €140k base as a software engineer in Dublin >> help me negotiate`, none: true },
  { m: `${G("$150k base", "in Tbilisi, Georgia")} >> help me negotiate`, none: true },
];
Deno.test(`round 2: ${EMAILS.length} counter emails say only what the person said, to the company they are negotiating with`, async () => {
  const bad: string[] = [];
  for (const c of EMAILS) {
    const { last } = await run(c.m), body = String(last.answer?.card?.body ?? "");
    if (c.none) { if (last.answer?.card || !/Which offer|could not place/.test(String(last.answer?.reply))) bad.push(`${c.m}\n    drafted, or did not ask: ${last.answer?.reply}`); continue; }
    for (const re of c.has ?? []) if (!re.test(body)) bad.push(`${c.m}\n    missing ${re}: ${body}`);
    for (const re of c.not ?? []) if (re.test(body)) bad.push(`${c.m}\n    said ${re}: ${body}`);
  }
  if (bad.length) throw new Error(`${bad.length} wrong:\n  ${bad.join("\n  ")}`);
  // The compare view labels a yearly figure worked out from a rate as an estimate, with its basis.
  const cmp = await run(`${G("$150k base")} >> Stripe offered me $9,000 a month as a software engineer in Austin >> compare my offers`);
  if (!/Stripe \$108,000 \(an estimate: \$9,000 a month x 12 months\)/.test(cmp.last.answer.reply)) throw new Error(cmp.last.answer.reply);
  if (!cmp.last.answer.comparison.offers[1].rows.some((r: any) => r.k === "Yearly base basis" && /An estimate, not a stated salary/.test(r.v))) throw new Error("the File row does not label the estimate");
});

// ---------------------------------------------------------------- round 3: the third review's 175 messages, labelled
// tests/fixtures/career-offers/review3-20261113.json: 120 single messages and 55 conversations. Each label says what must hold:
// `b` the base kept on a settled offer; `bu` that base, or nothing stated as fact; `U` nothing stated as fact; `nb` never
// benchmarked; `bench` benchmarked; `card`/`nocard` a counter drafted or not; `has`/`no` what the replies and the counter
// must and must not say (a ZIP code or an id as pay, a stale base after a correction, a control phrase as the job title, a
// currency taken from an ordinary word, a friend's or declined offer as leverage, a yearly figure for an internship's rate).
Deno.test("round 3: the 175 labelled messages of the third review, through the chat turn", async () => {
  const labels: any[] = JSON.parse(await Deno.readTextFile(new URL("../fixtures/career-offers/review3-20261113.json", import.meta.url)));
  const BENCH = /% (?:above|below) the median|percentile|right at the median/, wrong: string[] = [];
  for (const [i, c] of labels.entries()) {
    let state: any = null, last: any = null; const all: string[] = [];
    for (const x of c.m.split(" >> ")) { last = await offerChatTurn({ message: x, state, now: NOW, postings: null }); state = last.state; all.push(last.answer?.reply ?? "", last.answer?.card?.body ?? ""); }
    const text = all.join("\n"), lastReply = String(last?.answer?.reply ?? ""), settled = (state?.offers ?? []).map((f: any) => f.offer).filter((o: any) => !o.unsettled);
    const fact = BENCH.test(text) || /^Your offer:|^Checking:/m.test(text), bad: string[] = [];
    if (c.b != null && !settled.some((o: any) => o.base === c.b)) bad.push(`base ${c.b} not kept`);
    if (c.bu != null && !(settled.some((o: any) => o.base === c.bu) || !fact)) bad.push(`neither base ${c.bu} nor unsettled`);
    if (c.U && fact) bad.push("stated as fact");
    if (c.nb && BENCH.test(text)) bad.push("benchmarked");
    if (c.bench && !BENCH.test(text)) bad.push("no benchmark");
    if (c.lastnb && BENCH.test(lastReply)) bad.push("last reply benchmarked");
    if (c.lastsettled && !/^Your offer:/m.test(lastReply)) bad.push("last reply not settled");
    if (c.card && !last?.answer?.card) bad.push("no counter");
    if (c.nocard && last?.answer?.card) bad.push("a counter was drafted");
    for (const r of c.no ?? []) if (new RegExp(r).test(text)) bad.push(`said /${r}/`);
    for (const r of c.has ?? []) if (!new RegExp(r).test(text)) bad.push(`missing /${r}/`);
    if (bad.length) wrong.push(`#${i + 1} ${c.m}\n    ${bad.join("; ")}`);
  }
  if (wrong.length) throw new Error(`${wrong.length} of ${labels.length} wrong:\n  ${wrong.join("\n  ")}`);
});
