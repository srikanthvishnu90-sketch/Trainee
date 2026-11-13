// Pay listed by location (owner must-fix "each figure carries its source link and place"; review of #785 finding 5, and the
// adversarial review of the first fix). A posting that lists pay by place gives the posting's own place's range when exactly one
// place matches it (city AND state when both are given), else every range with its place, else none; never the first range with
// no place on it. Split from ag/applied-check-failclosed (its AC-5) to keep that branch under its size cap.
//   deno test -A --no-check tests/architect/posting-pay-by-location-20261113.test.ts
import assertNode from "node:assert/strict";
import * as P from "../../supabase/functions/_shared/posting_pay.ts";
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);

const COLON = "Pay ranges. San Jose, CA: $32 - $55 per hour. Chicago, IL: $28 - $49 per hour.";
const ALL_COLON = "San Jose, CA: $32 - $55 per hour; Chicago, IL: $28 - $49 per hour";
const PIPE = "Pay by location: San Jose, California | ($32 - $55 Hourly) Chicago, Illinois | ($28 - $49 Hourly) Austin, Texas | ($27 - $47 Hourly)";
const ZONES = "Zone A: $120,000 - $150,000. Zone B: $110,000 - $138,000. Zone C: $100,000 - $125,000.";
const BAY = "Bay Area: $150,000 - $180,000 per year. All other US locations: $130,000 - $160,000 per year.";
const REMOTE = "New York, NY: $50 - $60 per hour. Remote: $40 - $48 per hour.";
const STATES = "California: $35 - $45 per hour. Illinois: $30 - $40 per hour. Texas: $28 - $38 per hour.";
const MIXED = "San Jose, CA: $32 - $55 per hour ($66,560 - $114,400 per year). Chicago, IL: $28 - $49 per hour ($58,240 - $101,920 per year).";
const PROSE = "The range is $32-$55 per hour in San Jose and $28-$49 per hour in Chicago.";
const PORTLAND = "Portland, Oregon | ($30 - $40 Hourly) Portland, Maine | ($20 - $25 Hourly)";
const PART = "The base range is $100,000 - $120,000. In San Francisco, CA: $120,000 - $140,000.";
// [posting text, the posting's location, the pay read]
const PAY: [string, string | null, string | null][] = [
  [COLON, "Chicago, IL", "$28 - $49 per hour (Chicago, IL)"], [COLON, "San Jose, CA", "$32 - $55 per hour (San Jose, CA)"], [COLON, "New York, NY", ALL_COLON],
  [COLON, null, ALL_COLON], [COLON, "Remote", ALL_COLON], [COLON, "Chicago", "$28 - $49 per hour (Chicago, IL)"], [COLON, "Chicago, Illinois", "$28 - $49 per hour (Chicago, IL)"],
  [COLON, "San Jose, CA; Chicago, IL", ALL_COLON], [COLON, "Chicago, IL or Remote", "$28 - $49 per hour (Chicago, IL)"],
  [ZONES, "Chicago, IL", "Zone A: $120,000 - $150,000; Zone B: $110,000 - $138,000; Zone C: $100,000 - $125,000"],
  [BAY, "San Francisco, CA", "$150,000 - $180,000 per year (Bay Area)"], [BAY, "Chicago, IL", "Bay Area: $150,000 - $180,000 per year; All other US locations: $130,000 - $160,000 per year"],
  [REMOTE, "Remote", "$40 - $48 per hour (Remote)"], [REMOTE, "Remote - US", "$40 - $48 per hour (Remote)"], [REMOTE, "New York, NY", "$50 - $60 per hour (New York, NY)"],
  [STATES, "Chicago, IL", "$30 - $40 per hour (Illinois)"], ["CA: $35 - $45 per hour; IL: $30 - $40 per hour", "Chicago, Illinois", "$30 - $40 per hour (IL)"],
  [PIPE, "Austin, Texas", "$27 - $47 Hourly (Austin, Texas)"], [PIPE, "Chicago, IL", "$28 - $49 Hourly (Chicago, Illinois)"],
  [PIPE, "Scottsdale, Arizona", "San Jose, California: $32 - $55 Hourly; Chicago, Illinois: $28 - $49 Hourly; Austin, Texas: $27 - $47 Hourly"],
  ["Compensation by location\nSan Jose, CA\n$32 - $55 per hour\nChicago, IL\n$28 - $49 per hour", "Chicago, IL", "$28 - $49 per hour (Chicago, IL)"],
  [MIXED, "Chicago, IL", "$28 - $49 per hour / $58,240 - $101,920 per year (Chicago, IL)"],
  [MIXED, "Austin, TX", "San Jose, CA: $32 - $55 per hour / $66,560 - $114,400 per year; Chicago, IL: $28 - $49 per hour / $58,240 - $101,920 per year"],
  [PROSE, "Chicago, IL", "$28-$49 per hour (Chicago)"], [PROSE, "Austin, TX", "San Jose: $32-$55 per hour; Chicago: $28-$49 per hour"],
  // Round 2: "hourly" said just before the figures is their period.
  ["The hourly range is $32-$55 in San Jose and $28-$49 in Chicago.", "Chicago, IL", "$28-$49 hourly (Chicago)"],
  [PORTLAND, "Portland, ME", "$20 - $25 Hourly (Portland, Maine)"], [PORTLAND, "Portland", "Portland, Oregon: $30 - $40 Hourly; Portland, Maine: $20 - $25 Hourly"],
  ["Pay: San Jose, California | ($32 - $55 Hourly)", "Chicago, IL", "San Jose, California: $32 - $55 Hourly"], ["Pay: San Jose, California | ($32 - $55 Hourly)", "San Jose, CA", "$32 - $55 Hourly"],
  ["Chicago, IL - $28 to $49 per hour; San Jose, CA - $32 to $55 per hour", "Chicago, IL", "$28 to $49 per hour (Chicago, IL)"],
  ["NYC: $60/hr. Chicago: $50/hr.", "New York, NY", "$60/hr (NYC)"], [PART, "Chicago, IL", null], [PART, "San Francisco, CA", "$120,000 - $140,000 (San Francisco, CA)"],
  ["San Jose, CA: $30 - $40 per hour. Chicago, IL: $30 - $40 per hour.", "Austin, TX", "$30 - $40 per hour"],
  ["Pay: $40-$50/hr. Benefits.", "Chicago, IL", "$40-$50/hr"], ["Pay: $40-$50/hr plus a $5,000 signing bonus.", null, "$40-$50/hr"], ["Competitive pay and benefits.", "Chicago, IL", null],
];
const T1 = "San Francisco, CA: $60 - $70 per hour. New York, NY: $58 - $68 per hour. Austin, TX: $50 - $58 per hour.";
const ALL1 = "San Francisco, CA: $60 - $70 per hour; New York, NY: $58 - $68 per hour; Austin, TX: $50 - $58 per hour";
const T2 = "SF Bay Area: $150,000 - $180,000. NYC: $145,000 - $175,000. Remote-US: $120,000 - $150,000.";
const Z = "Zone A (SF, NYC): $150,000 - $180,000. Zone B (Seattle, Boston): $135,000 - $160,000. Zone C (all other): $120,000 - $145,000.";
const GEN = "The pay range is $100,000 - $120,000. For candidates in New York, NY: $120,000 - $140,000.";
const HYB = "Remote (US): $40 - $48 per hour. Hybrid, New York, NY: $50 - $60 per hour.";
const SPLIT = "Pay range for this role:\nSan Jose, CA: $32 -\n$55 per hour\nChicago, IL: $28 -\n$49 per hour";
const COLO = "In Colorado the range is $90,000 - $110,000. In California the range is $105,000 - $130,000. In Washington the range is $100,000 - $125,000.";
// The adversarial review's 60: [posting text, the posting's location, the pay read]
const REVIEW: [string, string | null, string | null][] = [
  [T1, "SF", "$60 - $70 per hour (San Francisco, CA)"], [T1, "San Francisco Bay Area", "$60 - $70 per hour (San Francisco, CA)"], [T1, "New York City", "$58 - $68 per hour (New York, NY)"],
  [T1, "NYC", "$58 - $68 per hour (New York, NY)"], [T1, "Brooklyn, NY", ALL1], [T1, "Los Angeles, CA", ALL1], [T1, "United States", ALL1], [T1, "Austin, TX; New York, NY", ALL1],
  [T2, "Remote - US", "$120,000 - $150,000 (Remote-US)"], [T2, "Oakland, CA", "$150,000 - $180,000 (SF Bay Area)"], [T2, "New York, NY", "$145,000 - $175,000 (NYC)"],
  [T2, "Denver, CO", "SF Bay Area: $150,000 - $180,000; NYC: $145,000 - $175,000; Remote-US: $120,000 - $150,000"],
  ["New York: $50 - $60 per hour. California: $55 - $65 per hour.", "New York, NY", "$50 - $60 per hour (New York)"], ["New York: $50 - $60 per hour. California: $55 - $65 per hour.", "Buffalo, NY", "$50 - $60 per hour (New York)"],
  ["New York: $50 - $60 per hour. Washington: $55 - $65 per hour.", "Washington, DC", "New York: $50 - $60 per hour; Washington: $55 - $65 per hour"],
  ["Washington: $55 - $65 per hour. Georgia: $40 - $50 per hour.", "Seattle, WA", "$55 - $65 per hour (Washington)"],
  [SPLIT, "Chicago, IL", "$28 - $49 per hour (Chicago, IL)"],
  ["Location | Range\nSan Jose, CA | $32 - $55 per hour\nChicago, IL | $28 - $49 per hour", "Chicago, IL", "$28 - $49 per hour (Chicago, IL)"],
  ["| Location | Min | Max |\n| San Jose, CA | $32/hr | $55/hr |\n| Chicago, IL | $28/hr | $49/hr |", "Chicago, IL", "$28/hr / $49/hr (Chicago, IL)"],
  [Z, "Seattle, WA", "$135,000 - $160,000 (Zone B (Seattle, Boston))"], [Z, "New York, NY", "$150,000 - $180,000 (Zone A (SF, NYC))"],
  ["Tier 1: $150,000 - $180,000; Tier 2: $135,000 - $160,000; Tier 3: $120,000 - $145,000", "Chicago, IL", "Tier 1: $150,000 - $180,000; Tier 2: $135,000 - $160,000; Tier 3: $120,000 - $145,000"],
  [COLON, "", ALL_COLON], [COLON, "Multiple locations", ALL_COLON], [COLON, "San Jose, CA | Chicago, IL | Austin, TX", ALL_COLON], [COLON, "San Jose, Costa Rica", ALL_COLON],
  [COLON, "West Chicago, IL", ALL_COLON], [COLON, "Chicago Heights, IL", ALL_COLON],
  [GEN, "New York, NY", "$120,000 - $140,000 (New York, NY)"], [GEN, "Austin, TX", null],
  ["$100,000 - $120,000 base. New York, NY: $120,000 - $140,000. Seattle, WA: $115,000 - $135,000.", "Austin, TX", null],
  ["Chicago, IL: $28 - $49 per hour or $58,240 - $101,920 annually. San Jose, CA: $32 - $55 per hour or $66,560 - $114,400 annually.", "San Jose, CA", "$32 - $55 per hour / $66,560 - $114,400 annually (San Jose, CA)"],
  ["Interns: $28 - $49 per hour in Chicago. Full-time: $90,000 - $120,000 per year in Chicago. San Jose interns: $32 - $55 per hour.", "Chicago, IL", "$28 - $49 per hour / $90,000 - $120,000 per year (Chicago)"],
  ["London: £45,000 - £55,000. Dublin: €50,000 - €60,000. New York, NY: $90,000 - $110,000.", "London, UK", "£45,000 - £55,000 (London)"],
  ["Toronto, ON: CAD $80,000 - $95,000. Chicago, IL: USD $85,000 - $100,000.", "Toronto, ON", "CAD $80,000 - $95,000 (Toronto, ON)"],
  ["Toronto, ON: CA$80,000 - CA$95,000. Chicago, IL: $85,000 - $100,000.", "Chicago, IL", "$85,000 - $100,000 (Chicago, IL)"],
  [COLO, "Denver, CO", "$90,000 - $110,000 (Colorado)"],
  ["Colorado applicants: $90,000 - $110,000. California applicants: $105,000 - $130,000.", "Los Angeles, CA", "$105,000 - $130,000 (California)"],
  ["The range for this role in San Jose is $32 - $55 per hour. Our Chicago office pays $28 - $49 per hour.", "Chicago, IL", "$28 - $49 per hour (Chicago)"],
  ["Base pay: $32 - $55 per hour (San Jose, CA); $28 - $49 per hour (Chicago, IL)", "Chicago, IL", "$28 - $49 per hour (Chicago, IL)"],
  ["$32 - $55 per hour (San Jose, CA)\n$28 - $49 per hour (Chicago, IL)", "Chicago, IL", "$28 - $49 per hour (Chicago, IL)"],
  ["$32 - $55 per hour - San Jose, CA\n$28 - $49 per hour - Chicago, IL", "Chicago, IL", "$28 - $49 per hour (Chicago, IL)"],
  ["San Jose, CA $32 - $55 per hour Chicago, IL $28 - $49 per hour", "Chicago, IL", "$28 - $49 per hour (Chicago, IL)"],
  ["Ranges: $32 - $55 per hour San Jose; $28 - $49 per hour Chicago", "Chicago, IL", "$28 - $49 per hour (Chicago)"],
  ["Springfield, IL: $28 - $40 per hour. Springfield, MA: $30 - $44 per hour.", "Springfield, MO", "Springfield, IL: $28 - $40 per hour; Springfield, MA: $30 - $44 per hour"],
  ["Portland, OR: $30 - $40 per hour. Chicago, IL: $28 - $49 per hour.", "Portland, ME", "Portland, OR: $30 - $40 per hour; Chicago, IL: $28 - $49 per hour"],
  ["Kansas City, MO: $30 - $40 per hour. Kansas City, KS: $28 - $38 per hour.", "Kansas City", "Kansas City, MO: $30 - $40 per hour; Kansas City, KS: $28 - $38 per hour"],
  ["St. Louis, MO: $30 - $40 per hour. Chicago, IL: $28 - $49 per hour.", "St. Louis, MO", "$30 - $40 per hour (St. Louis, MO)"],
  ["Washington, DC: $60 - $70 per hour. Seattle, WA: $55 - $65 per hour.", "Washington", "Washington, DC: $60 - $70 per hour; Seattle, WA: $55 - $65 per hour"],
  [HYB, "New York, NY (Hybrid)", "$50 - $60 per hour (Hybrid, New York, NY)"], [HYB, "Remote, New York", "$40 - $48 per hour (Remote (US))"],
  ["San Jose, CA: $32 - $55 per hour. Chicago, IL: $28 - $49 per hour. Signing bonus: $5,000 - $10,000.", "Austin, TX", ALL_COLON],
  ["Level I: $28 - $35 per hour. Level II: $36 - $49 per hour.", "Chicago, IL", "Level I: $28 - $35 per hour; Level II: $36 - $49 per hour"],
  ["Undergrad: $28 - $35 per hour. Masters: $36 - $49 per hour. PhD: $50 - $62 per hour.", "Chicago, IL", "Undergrad: $28 - $35 per hour; Masters: $36 - $49 per hour; PhD: $50 - $62 per hour"],
  ["Chicago, IL: $28 - $49 per hour. Other locations may differ: $25 - $60 per hour.", "Austin, TX", null],
  ["Toronto, ON: CAD $80,000 - $95,000. Chicago, IL: USD $85,000 - $100,000.", "Chicago, IL", "USD $85,000 - $100,000 (Chicago, IL)"],
  ["Salem, OR: $30 - $40 per hour. Boston, MA: $35 - $45 per hour.", "Salem, MA", "Salem, OR: $30 - $40 per hour; Boston, MA: $35 - $45 per hour"],
  ["Portland, OR: $30 - $40 per hour. Chicago, IL: $28 - $49 per hour.", "Portland, OR", "$30 - $40 per hour (Portland, OR)"],
  ["In Colorado the range is $90,000 - $110,000. In California the range is $105,000 - $130,000.", "San Francisco, CA", "$105,000 - $130,000 (California)"],
  [SPLIT, "San Jose, CA", "$32 - $55 per hour (San Jose, CA)"],
];
const wrongIn = (rows: [string, string | null, string | null][]) => rows.map(([t, loc, want]) => ({ t, loc, want, got: P.placedPay(t, loc) })).filter((x) => x.got !== x.want);
Deno.test("PAY-1 the first table (38 postings): the posting's own place, or every range with its place, or none", () => {
  ok(PAY.length >= 38);
  eq(wrongIn(PAY), []);
});
Deno.test("PAY-2 the adversarial review's 60: city and state both decide, no unlabelled first range, the currency stays", () => {
  eq(REVIEW.length, 60);
  eq(wrongIn(REVIEW), []);
  // Across both tables: a posting that states more than one range never gets a range with no place on it.
  for (const [t, loc] of [...PAY, ...REVIEW]) {
    const got = P.placedPay(t, loc), ranges = new Set(((P as any).paysWithPlace?.(t) ?? []).map((r: any) => r.pay.replace(/\s+/g, ""))).size;
    if (got !== null && ranges > 1) ok(/\(.+\)$/.test(got) || /: /.test(got), `no place on it: ${got} <= ${t}`);
    ok(!(/\bCAD\b|CA\$/.test(t) && got && /Toronto/.test(got) && !/CAD|CA\$/.test(got)), `a Canadian range printed as dollars: ${got}`);
  }
  // One range, no place words: read as before.
  eq(P.placedPay("Pay: $40-$50/hr. Benefits.", "Chicago, IL"), "$40-$50/hr");
  eq(P.payFrom("The salary range is $153,000 - $221,000 USD."), "$153,000 - $221,000 USD");
});

// Round 3 (the second review's 105, the ones it found wrong or lost, and their neighbours).
const METRO = "NYC metro: $145,000 - $175,000 per year. Bay Area: $155,000 - $185,000 per year. Remote - US: $120,000 - $150,000 per year.";
const ALL_METRO = "NYC metro: $145,000 - $175,000 per year; Bay Area: $155,000 - $185,000 per year; Remote - US: $120,000 - $150,000 per year";
const SLASH = "Hybrid - Chicago, IL: $92,000 - $108,000 / Remote: $85,000 - $100,000";
const INTL = "Toronto, ON: CAD 95,000 - 120,000. London: £70,000 - £90,000. Berlin: €75,000 - €95,000. New York, NY: $130,000 - $160,000.";
const ALL_INTL = "Toronto, ON: CAD 95,000 - 120,000; London: £70,000 - £90,000; Berlin: €75,000 - €95,000; New York, NY: $130,000 - $160,000";
const IN3 = "In New York, the range is $115,000 - $135,000. In California, the range is $120,000 - $140,000. In all other US locations, the range is $100,000 - $120,000.";
const ROUND3: [string, string | null, string | null][] = [
  [METRO, "New York, NY", "$145,000 - $175,000 per year (NYC metro)"], [METRO, "NYC", "$145,000 - $175,000 per year (NYC metro)"], [METRO, "Remote (US)", "$120,000 - $150,000 per year (Remote - US)"],
  [METRO, "Remote - US", "$120,000 - $150,000 per year (Remote - US)"], [METRO, "US Remote", "$120,000 - $150,000 per year (Remote - US)"], [METRO, "SF", "$155,000 - $185,000 per year (Bay Area)"],
  [METRO, "Chicago, IL", ALL_METRO], [METRO, "Sacramento, CA", ALL_METRO],
  // Each range keeps the label that is its own: a "/" between labelled ranges separates them.
  [SLASH, "Chicago, IL (Hybrid)", "$92,000 - $108,000 (Hybrid - Chicago, IL)"], [SLASH, "Remote", "$85,000 - $100,000 (Remote)"], [SLASH, "Austin, TX", "Hybrid - Chicago, IL: $92,000 - $108,000; Remote: $85,000 - $100,000"],
  // A state-qualified range is never given without its state to a posting somewhere else.
  ["For Colorado applicants: the range is $70,000 - $90,000.", "Atlanta, GA", "Colorado: $70,000 - $90,000"], ["For Colorado applicants: the range is $70,000 - $90,000.", "Denver, CO", "$70,000 - $90,000"],
  [IN3, "Buffalo, NY", "$115,000 - $135,000 (New York)"], [IN3, "Dallas, TX", null],
  ["The range is $100,000 - $120,000. The range for the Bay Area and NYC is $120,000 - $145,000.", "San Jose, CA", "$120,000 - $145,000 (Bay Area and NYC)"],
  // The currency says the country: a pound or Canadian range is not a US posting's, London, ON is not London; Georgia the country is not the state.
  [INTL, "London, ON", ALL_INTL], [INTL, "London, UK", "£70,000 - £90,000 (London)"], [INTL, "Toronto, ON", "CAD 95,000 - 120,000 (Toronto, ON)"], [INTL, "Toronto, OH", ALL_INTL], [INTL, "Paris, France", ALL_INTL],
  ["Georgia: $55,000 - $65,000. Texas: $58,000 - $68,000.", "Tbilisi, Georgia", "Georgia: $55,000 - $65,000; Texas: $58,000 - $68,000"], ["Georgia: $55,000 - $65,000. Texas: $58,000 - $68,000.", "Atlanta, Georgia", "$55,000 - $65,000 (Georgia)"],
  ["DC: $60 - $70 per hour. LA: $58 - $66 per hour.", "Washington, DC", "$60 - $70 per hour (DC)"], ["DC: $60 - $70 per hour. LA: $58 - $66 per hour.", "Los Angeles, CA", "$58 - $66 per hour (LA)"],
  // One range, written with its period on both ends or said before it; qualifiers beside the figure stay with it.
  ["Hourly rate: $22/hr - $27/hr", "Columbus, OH", "$22/hr - $27/hr"], ["Monthly stipend of $7,500.", "Boston, MA", "$7,500 monthly"],
  ["Pay: $150,000 - $180,000 OTE.", "Denver, CO", "$150,000 - $180,000 OTE"], ["Salary: $90,000 - $110,000 base, plus equity.", null, "$90,000 - $110,000 base"],
];
Deno.test("PAY-3 round 3: labels as written, each range its own label, aliases and state membership, the currency's country, qualifiers kept", () => {
  eq(wrongIn(ROUND3), []);
});
