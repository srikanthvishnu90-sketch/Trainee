// LOOP 13 (item 13, offers and negotiation; VERIFICATION-15): 20 offer cases with hand-computed totals, through the REAL
// handler (handleChat on real Postgres) and the F-15 path (the compare turn's meta.offer_comparison rendered by
// offerComparisonFile). The bar: 100% correct arithmetic; every value labelled by its source (offer letter, verbal, your
// estimate, you told me, unknown when not given, worked out for code's arithmetic); no invented leverage or market data
// (every dollar figure said is one the person gave, one worked out from those, or one the cited pay data publishes); a
// counter draft that makes no false claim (no competing offer the person does not have, no deadline they did not give).
// Equity is never added to cash. Cost of living is never adjusted without a cited dataset (none is on file).
// The pay datasets are the WO-036 test fixtures (invented rows), as in flow-offer-benchmark.test.ts.
//   PGBIN=/usr/lib/postgresql/16/bin deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/loop-13-offers.test.ts
import assertNode from "node:assert/strict";
import { pgBinDir, type Pg, startPg } from "../flow/pg.ts";
import { careerHandler, type Chat, supabaseParity } from "../flow/handler.ts";
import { benchmarks, parseOfferWords, payData } from "../../supabase/functions/_shared/career_offer.ts";
import { familyPage } from "../../supabase/functions/_shared/file_family.ts";
import { offerComparisonFile } from "../../supabase/functions/_shared/file_family_apply.ts";

const CI = Deno.env.get("CI") === "true";
const root = new URL("../../", import.meta.url);
const readJson = async (p: string) => JSON.parse(await Deno.readTextFile(new URL(p, root)));
const usd = (n: number) => "$" + n.toLocaleString("en-US");

// What a case expects of one offer, worked out by hand.
interface Want {
  company: string; base: number; baseSrc: string;
  signing?: [number, string]; bonus?: string; bonusSrc?: string;
  equity?: string[]; equitySrc?: string; benefits?: string[]; benefitsSrc?: string;
  guaranteed: number; withTarget?: number;
}
interface Case { id: string; says: string[]; want: Want[]; negotiate?: string; draftHas?: RegExp[]; draftNot?: RegExp[]; replyNot?: RegExp[] }

const CASES: Case[] = [
  { id: "01 letter: base, target %, signing", says: ["My offer letter from Acme Robotics: $120,000 base, 10% target bonus, $15,000 signing bonus, software engineer in Seattle"],
    // 120,000 + 15,000 = 135,000 guaranteed; 10% of 120,000 = 12,000 target; 147,000 with it.
    want: [{ company: "Acme Robotics", base: 120000, baseSrc: "offer letter", signing: [15000, "offer letter"], bonus: "target 10% of base = $12,000, not guaranteed", bonusSrc: "offer letter", guaranteed: 135000, withTarget: 147000 }] },
  { id: "02 hourly", says: ["Bluebird offered me $24/hour as a data analyst in Chicago"],
    // 24 x 2,080 = 49,920.
    want: [{ company: "Bluebird", base: 49920, baseSrc: "you told me", guaranteed: 49920 }] },
  { id: "03 RSUs, grant over years, 1-year cliff", says: ["Nimbus offered $150k base as a software engineer in Seattle with $100k in RSUs over 4 years, 1-year cliff"],
    // 100,000 / 4 = 25,000 a year; the cliff at 12 months vests the first year's 25,000.
    want: [{ company: "Nimbus", base: 150000, baseSrc: "you told me", equity: ["$25,000 a year", "1-year cliff", "year one $25,000"], equitySrc: "you told me", guaranteed: 150000 }] },
  { id: "04 RSUs per year", says: ["Quarry offered $130k as a data analyst in Chicago, plus $40k of RSUs per year vesting over 4 years"],
    // 40,000 a year over 4 years = 160,000 granted; no cliff given, so year one is not stated.
    want: [{ company: "Quarry", base: 130000, baseSrc: "you told me", equity: ["$160,000 over 4 years", "$40,000 a year", "cliff not given"], guaranteed: 130000 }] },
  { id: "05 RSUs, 18-month cliff", says: ["Tidewater offered $140,000 as a software engineer in Seattle with $90k RSUs vesting over 3 years, 18-month cliff"],
    // 90,000 / 3 = 30,000 a year; nothing vests before month 18, so year one is $0.
    want: [{ company: "Tidewater", base: 140000, baseSrc: "you told me", equity: ["$30,000 a year", "18-month cliff", "year one $0"], guaranteed: 140000 }] },
  { id: "06 options are not valued", says: ["Fernwood offered $125k as a software engineer in Seattle with 10,000 stock options vesting over 4 years"],
    want: [{ company: "Fernwood", base: 125000, baseSrc: "you told me", equity: ["10,000 stock options", "not valued"], guaranteed: 125000 }], replyNot: [/\$2,500\b/, /\$10,000\b/] },
  { id: "07 verbal", says: ["The recruiter said on the phone that Kestrel is offering $130k base as a data analyst in Chicago"],
    want: [{ company: "Kestrel", base: 130000, baseSrc: "verbal", guaranteed: 130000 }] },
  { id: "08 mixed sources in one message", says: ["The offer letter from Larkspur says $115k base as a data analyst in Chicago; the recruiter mentioned a $5k signing bonus verbally"],
    want: [{ company: "Larkspur", base: 115000, baseSrc: "offer letter", signing: [5000, "verbal"], guaranteed: 120000 }] },
  { id: "09 your estimate is not an offer you can cite", says: ["I think Orbit will offer around $140k as a software engineer in Seattle", "Nimbus offered $130,000 as a software engineer in Seattle"],
    want: [{ company: "Orbit", base: 140000, baseSrc: "your estimate", guaranteed: 140000 }, { company: "Nimbus", base: 130000, baseSrc: "you told me", guaranteed: 130000 }],
    negotiate: "help me negotiate the Nimbus offer", draftNot: [/another offer/i, /Orbit/, /\$140,000/] },
  { id: "10 benefits only as given; 401k is not a salary", says: ["Acme Data offered $100k as a data analyst in Chicago, $3,000 relocation, 4% 401k match"],
    want: [{ company: "Acme Data", base: 100000, baseSrc: "you told me", benefits: ["$3,000 relocation", "4% 401(k) match (not valued)"], benefitsSrc: "you told me", guaranteed: 100000 }], replyNot: [/\$401,000/, /\$103,000/] },
  { id: "11 '401k' and 'pay' in one clause", says: ["Pinecrest offered to pay a 4% 401k match on a $90,000 salary as a data analyst in Chicago"],
    want: [{ company: "Pinecrest", base: 90000, baseSrc: "you told me", benefits: ["4% 401(k) match (not valued)"], guaranteed: 90000 }], replyNot: [/\$401,000/] },
  { id: "12 two offers, same city", says: ["Alder offered $120k base and a $10k signing bonus as a data analyst in Chicago", "Birchwood offered $110k base, 15% target bonus and a $20k signing bonus as a data analyst in Chicago"],
    // Alder 120,000 + 10,000 = 130,000. Birchwood 110,000 + 20,000 = 130,000; 15% of 110,000 = 16,500; 146,500 with it.
    want: [{ company: "Alder", base: 120000, baseSrc: "you told me", signing: [10000, "you told me"], guaranteed: 130000 },
      { company: "Birchwood", base: 110000, baseSrc: "you told me", signing: [20000, "you told me"], bonus: "target 15% of base = $16,500, not guaranteed", guaranteed: 130000, withTarget: 146500 }] },
  { id: "13 two cities, no cost-of-living adjustment", says: ["Cobalt offered $150k as a software engineer in New York", "Dunmore offered $135k as a software engineer in Seattle"],
    want: [{ company: "Cobalt", base: 150000, baseSrc: "you told me", guaranteed: 150000 }, { company: "Dunmore", base: 135000, baseSrc: "you told me", guaranteed: 135000 }],
    replyNot: [/adjusted for cost of living/i] },
  { id: "14 an uncited cost-of-living claim is not used", says: ["Elmstead offered $100k as a data analyst in Chicago", "Foxglove offered $120k as a data analyst in New York. New York is 30% more expensive"],
    want: [{ company: "Elmstead", base: 100000, baseSrc: "you told me", guaranteed: 100000 }, { company: "Foxglove", base: 120000, baseSrc: "you told me", guaranteed: 120000 }],
    replyNot: [/\$130,000/, /\$92,308/, /\$76,923/, /\$156,000/] },
  { id: "15 counter with no competing offer and no deadline", says: ["Granite offered $95k as a data analyst in Chicago"],
    want: [{ company: "Granite", base: 95000, baseSrc: "you told me", guaranteed: 95000 }],
    negotiate: "help me negotiate the Granite offer", draftNot: [/another offer/i, /get back to you by/i] },
  { id: "16 counter cites a competing offer the person has", says: ["Hollis offered $100k as a data analyst in Chicago. I also have an offer from Ivyline for $110k"],
    want: [{ company: "Hollis", base: 100000, baseSrc: "you told me", guaranteed: 100000 }],
    negotiate: "help me negotiate the Hollis offer", draftHas: [/I have another offer from Ivyline with a base of \$110,000\./, /Could you bring the base to \$110,000\?/] },
  { id: "17 a lower other offer is never the ask", says: ["Juniper offered $120k as a data analyst in Chicago", "Kingfisher offered $105k as a data analyst in Chicago"],
    want: [{ company: "Juniper", base: 120000, baseSrc: "you told me", guaranteed: 120000 }, { company: "Kingfisher", base: 105000, baseSrc: "you told me", guaranteed: 105000 }],
    negotiate: "help me negotiate the Juniper offer", draftNot: [/bring the base (?:closer )?to \$105,000/] },
  { id: "18 a stated deadline is the only deadline", says: ["Lumen offered $98k as a data analyst in Chicago, need to answer by Nov 14"],
    want: [{ company: "Lumen", base: 98000, baseSrc: "you told me", guaranteed: 98000 }],
    negotiate: "help me negotiate the Lumen offer", draftHas: [/I'll get back to you by Nov 14\./] },
  { id: "19 a bonus amount said as a target is not guaranteed cash", says: ["Marlow offered $110k base and a $15k target bonus as a data analyst in Chicago"],
    // 110,000 guaranteed; 125,000 if the 15,000 target pays in full.
    want: [{ company: "Marlow", base: 110000, baseSrc: "you told me", bonus: "target $15,000, not guaranteed", guaranteed: 110000, withTarget: 125000 }] },
  { id: "20 three offers; equity never added to cash", says: ["Norland offered $140k as a software engineer in Seattle with $80k in RSUs over 4 years, 1-year cliff",
    "Oakhurst offered $150k and a $10k signing bonus as a software engineer in Seattle", "Pellucid offered $130k base, 20% target bonus as a software engineer in Seattle"],
    // Norland 140,000 cash, 20,000 a year equity (never 160,000). Oakhurst 160,000. Pellucid 130,000; 20% = 26,000; 156,000.
    want: [{ company: "Norland", base: 140000, baseSrc: "you told me", equity: ["$20,000 a year", "year one $20,000"], guaranteed: 140000 },
      { company: "Oakhurst", base: 150000, baseSrc: "you told me", signing: [10000, "you told me"], guaranteed: 160000 },
      { company: "Pellucid", base: 130000, baseSrc: "you told me", bonus: "target 20% of base = $26,000, not guaranteed", guaranteed: 130000, withTarget: 156000 }],
    replyNot: [/\$160,000[^.;]*Norland|Norland \$160,000/] },
];

const LABELS = ["offer letter", "verbal", "your estimate", "you told me", "worked out"];
const DOLLAR = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?([kK]\b)?/g;
const dollars = (s: string) => [...s.matchAll(DOLLAR)].map((m) => Math.round(Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1)));

Deno.test({ name: "LOOP 13: 20 offers through the real handler and the F-15 path: exact arithmetic, every value sourced, no invented leverage", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const fixtures = { ...payData(), lca_wages: await readJson("tests/fixtures/career-pay/lca-wages.fixture.json"), oews_metro: await readJson("tests/fixtures/career-pay/oews-metro.fixture.json") };
  const mod: any = await import("../../supabase/functions/_shared/career_offer_chat.ts");
  mod.offerData.get = () => fixtures;
  const people: Record<string, string> = {};
  CASES.forEach((_, i) => { people[`tok-${i}`] = `7b0f8f8e-6a43-4a49-9d2c-0000000013${String(i).padStart(2, "0")}`; });
  const pg: Pg = await startPg();
  let handler: Awaited<ReturnType<typeof careerHandler>> | null = null;
  const fails: string[] = [];
  let correct = 0;
  try {
    await supabaseParity(pg);
    for (const id of Object.values(people)) {
      await pg.sql(`insert into auth.users (id, email) values ('${id}', '${id}@example.test'); insert into public.profiles (id) values ('${id}');
        insert into public.career_watch_kv (user_id, key, value) values ('${id}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    }
    handler = await careerHandler(pg, people);
    for (const [i, c] of CASES.entries()) {
      const bad: string[] = [];
      const ok = (v: unknown, m: string) => { if (!v) bad.push(m); };
      const chat: Chat = handler.chat(`tok-${i}`);
      const said: string[] = [];
      // Every dollar figure a reply may say: what the person said, the hand-computed values, and what the cited pay data publishes.
      const allowed = new Set<number>(c.says.flatMap(dollars));
      for (const w of c.want) {
        [w.base, w.guaranteed, w.withTarget, w.signing?.[0]].forEach((n) => n != null && allowed.add(n));
        for (const t of [w.bonus, ...(w.equity ?? []), ...(w.benefits ?? [])]) if (t) dollars(t).forEach((n) => allowed.add(n));
      }
      for (const m of c.says) {
        const o = parseOfferWords(m, fixtures);
        for (const b of benchmarks(o, fixtures)) [b.p25, b.median, b.p75].forEach((n) => n != null && allowed.add(n));
      }
      for (const m of c.says) {
        const r = await chat.say(m);
        ok(r.status === 200 && String(r.intent).startsWith("career_offer_"), `turn "${m}": ${r.intent} ${r.reply.slice(0, 200)}`);
        said.push(r.reply);
      }
      const cmp = await chat.say("compare my offers");
      said.push(cmp.reply);
      const d = cmp.body?.meta?.offer_comparison;
      ok(cmp.intent === "career_offer_compare" && d, `compare: ${cmp.intent}, meta ${JSON.stringify(cmp.body?.meta ?? null).slice(0, 200)}`);
      if (d) {
        const html = familyPage(offerComparisonFile(d), { now: Date.UTC(2026, 10, 10), tz: "UTC" });
        ok(!/\btotal\b/i.test(d.offers.flatMap((o: any) => o.rows.map((r: any) => r.k)).join(" ")), "no row called a total");
        for (const w of c.want) {
          const o = d.offers.find((x: any) => x.company === w.company);
          if (!o) { bad.push(`F-15 has no ${w.company}: ${d.offers.map((x: any) => x.company)}`); continue; }
          const row = (k: string) => o.rows.find((r: any) => r.k === k);
          const has = (k: string, v: string, src?: string) => {
            const r = row(k);
            ok(r && r.v != null && r.v.includes(v), `${w.company} ${k} wants "${v}", has ${JSON.stringify(r)}`);
            if (src) ok(r?.src?.label === src, `${w.company} ${k} source wants "${src}", has ${JSON.stringify(r?.src)}`);
          };
          const none = (k: string) => { const r = row(k); ok(r && r.v == null && /^Unknown/.test(r.missing ?? ""), `${w.company} ${k} should be unknown: ${JSON.stringify(r)}`); };
          has("Base", usd(w.base), w.baseSrc);
          w.signing ? has("Signing bonus", usd(w.signing[0]), w.signing[1]) : none("Signing bonus");
          w.bonus ? has("Bonus", w.bonus, w.bonusSrc) : none("Bonus");
          if (w.equity) for (const e of w.equity) has("Equity", e, w.equitySrc); else none("Equity");
          if (w.benefits) for (const e of w.benefits) has("Benefits", e, w.benefitsSrc); else none("Benefits");
          has("Guaranteed first-year cash", usd(w.guaranteed), "worked out");
          if (w.withTarget) has("First-year cash if the target bonus pays in full", usd(w.withTarget), "worked out");
          else ok(!row("First-year cash if the target bonus pays in full"), `${w.company}: no target bonus, so no with-target row`);
          for (const r of o.rows) ok(r.v == null ? /^Unknown/.test(r.missing ?? "") : LABELS.includes(r.src?.label), `${w.company} ${r.k}: every value labelled by its source: ${JSON.stringify(r)}`);
          ok(html.includes(usd(w.guaranteed)), `${w.company}: the rendered F-15 page shows the guaranteed cash`);
        }
      }
      if (c.want.length > 1) {
        // The compare text: guaranteed cash per offer, exactly, and the places never adjusted for cost of living.
        const line = cmp.reply.split("\n").find((l) => l.startsWith("First-year cash (base, signing and a stated bonus amount)")) ?? "";
        for (const w of c.want) ok(line.includes(`${w.company} ${usd(w.guaranteed)}`), `compare line: ${w.company} ${usd(w.guaranteed)} in "${line}"`);
        ok(/Cost of living: (?:same place|no cost-of-living dataset is on file)/.test(cmp.reply), "cost of living not adjusted");
      }
      let draft = "";
      if (c.negotiate) {
        const r = await chat.say(c.negotiate);
        said.push(r.reply);
        const card = r.body?.meta?.offer_card;
        ok(r.intent === "career_offer_counter" && card?.sent === false && card?.requires_approval === true, `counter: ${r.intent}`);
        draft = String(card?.body ?? "");
        for (const re of c.draftHas ?? []) ok(re.test(draft), `draft wants ${re}: ${draft}`);
        for (const re of c.draftNot ?? []) ok(!re.test(draft), `draft must not ${re}: ${draft}`);
      }
      const all = said.join("\n") + "\n" + draft;
      for (const n of dollars(all)) ok(allowed.has(n), `a dollar figure nobody gave and nothing cites: ${usd(n)}`);
      for (const re of c.replyNot ?? []) ok(!re.test(all), `reply must not ${re}`);
      if (bad.length) fails.push(`CASE ${c.id}:\n  - ${[...new Set(bad)].join("\n  - ")}`);
      else correct++;
    }
  } finally {
    handler?.restore();
    await pg.stop();
  }
  console.log(`LOOP-13 offers: ${correct}/${CASES.length} cases fully correct`);
  if (fails.length) console.log(fails.join("\n"));
  assertNode.equal(correct, CASES.length, `${CASES.length - correct} offer cases wrong`);
} });
