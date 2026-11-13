// D-078 (owner decision 2026-11-13, in the architect's chat): confirm before compare. Rule-based reading of free text stalls at
// about 15% wrong, so the reading becomes a step the person confirms.
//   1. OFFERS: the reading is shown back in one block (company, role, base with currency and period as read, other components
//      as written, place, anything unclear marked "not sure"); nothing compares, benchmarks, computes a percent or drafts a
//      counter until the person's plain yes to THAT block (bound by its hash). A correction shows it again; a later change
//      puts a confirmed offer back to unconfirmed; a yes after another turn, or to another reading, confirms nothing.
//   2. INFERRED SKILLS: a skill read from experience text does not print on a resume until the person says yes to it; it is
//      asked once ("I read these skills from your experience: X, Y: keep them?"). Skills they stated directly print.
// Offline: the pay datasets are the WO-036 fixtures; the resume store is in memory and the PDF renders in this process.
//   deno test -A --no-check tests/architect/confirm-before-compare-20261113.test.ts
import assertNode from "node:assert/strict";
import { offerChatTurn, offerData, type OfferChatState, type OfferTurnResult } from "../../supabase/functions/_shared/career_offer_chat.ts";
import { offerTurn, payData, readingBlock, readingHash, parseOfferWords } from "../../supabase/functions/_shared/career_offer.ts";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { edgeRenderer, memoryPersonaStore, memoryResumeStore, tailorForPosting, withoutInferredSkills } from "../../supabase/functions/_shared/career_tailor.ts";
import { offerCases, rng } from "./scenarios/research-r2-generator.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const root = new URL("../../", import.meta.url);
const readJson = async (p: string) => JSON.parse(await Deno.readTextFile(new URL(p, root)));
const NOW = Date.UTC(2026, 10, 13, 15);
const fixtures = { ...payData(), lca_wages: await readJson("tests/fixtures/career-pay/lca-wages.fixture.json"), oews_metro: await readJson("tests/fixtures/career-pay/oews-metro.fixture.json") };
offerData.get = () => fixtures;

// Nothing in a reply before the yes compares, places, benchmarks or drafts.
const COMPARED = /\bmedian\b|percentile|\bmiddle half\b|Could you (?:bring|improve)|side by side|First-year cash|H-1B filings|BLS pay/i;
function unconfirmedReply(r: OfferTurnResult, m: string) {
  eq(r.answer?.intent, "career_offer_confirm", `${m}: the reading is shown for a yes (${r.answer?.intent}: ${r.answer?.reply})`);
  eq(r.answer?.card ?? null, null, `${m}: no card before the yes`);
  ok(!COMPARED.test(r.answer!.reply), `${m}: nothing compared before the yes:\n${r.answer!.reply}`);
  ok(/Is that right\? Reply yes, or tell me what to change\./.test(r.answer!.reply), `${m}: it asks`);
  ok(r.state?.shown?.hash && r.state.shown.hash.length === 64, `${m}: the reading shown is kept by its hash`);
}
async function say(msgs: string[], state: OfferChatState | null = null, now = NOW) {
  const out: OfferTurnResult[] = [];
  let s = state, t = now;
  for (const m of msgs) { const r = await offerChatTurn({ message: m, state: s, now: t }); out.push(r); s = r.state; t += 60_000; }
  return { out, state: s };
}

// ---------- 1. show the reading -> yes -> the comparison ----------
const SHOW_YES: { says: string; then: RegExp; intent?: string; block: RegExp[] }[] = [
  { says: "JPM offered 110k base, 15k signing, NYC, analyst", then: /Your offer: JPMorganChase, analyst, New York metro, base \$110,000, signing \$15,000/, block: [/Company: JPMorganChase/, /Role: analyst/, /Base: \$110,000 a year/, /Signing bonus: \$15,000/, /Location: New York metro/] },
  { says: "Stripe offered me $160k base as a software engineer in New York", then: /Your offer: Stripe, software engineer/, block: [/Company: Stripe/, /Base: \$160,000 a year .*, USD/] },
  { says: "Bluebird offered me $24/hour as a data analyst in Chicago", then: /Bluebird/, block: [/Base: \$24 an hour, USD/, /Location: Chicago metro/] },
  { says: "Acme Robotics offered 150k base, Seattle, software engineer, 10% target bonus", then: /Acme Robotics/, block: [/Target bonus: 10% of base \(not guaranteed\)/] },
  { says: "Nimbus offered $150k base as a software engineer in Seattle with $100k in RSUs over 4 years, 1-year cliff", then: /Nimbus/, block: [/Equity, as you wrote it: .*RSUs/] },
  { says: "Granite offered $95k as a data analyst in Chicago", then: /Granite/, block: [/Company: Granite/, /Role: data analyst/] },
  { says: "Shopify offered me 140k as a software engineer in Toronto", then: /Shopify/, block: [/Not sure: the currency of the base \(not stated\)/, /currency not sure/] },
  { says: "Acme Data offered $100k as a data analyst in Chicago, $3,000 relocation, 4% 401k match", then: /Acme Data/, block: [/Benefits, as you wrote them: .*relocation/] },
  { says: "Hollis offered $100k as a data analyst in Chicago. I also have an offer from Ivyline for $110k", then: /Hollis/, block: [/Another offer you mentioned: Ivyline, \$110k/] },
  { says: "My offer letter from Larkspur says $115k base as a data analyst in Chicago, need to answer by Friday", then: /Larkspur/, block: [/Deadline: Friday/] },
  { says: "is $95k good for a data analyst in Chicago", then: /Checking: data analyst/, block: [/Here is how I read your question/, /Base: \$95,000 a year/] },
  { says: "Kestrel offered me 120k as a data analyst in Chicago. Help me negotiate", then: /A counter for Kestrel/, intent: "career_offer_counter", block: [/Company: Kestrel/] },
];
for (const [i, c] of SHOW_YES.entries()) {
  Deno.test(`D-078/offer show-yes ${String(i + 1).padStart(2, "0")}: ${c.says}`, async () => {
    const a = await offerChatTurn({ message: c.says, state: null, now: NOW });
    unconfirmedReply(a, c.says);
    for (const re of c.block) ok(re.test(a.answer!.reply), `block ${re}:\n${a.answer!.reply}`);
    eq(a.state!.offers.every((f) => !f.confirmed), true, "nothing on file is confirmed yet");
    const b = await offerChatTurn({ message: "yes", state: a.state, now: NOW + 60_000, lastReply: a.answer!.reply });
    eq(b.answer?.intent, c.intent ?? "career_offer_benchmark", b.answer?.reply);
    ok(c.then.test(b.answer!.reply), `after the yes: ${c.then}\n${b.answer!.reply}`);
    if (!/is \$95k good/.test(c.says)) {
      const f = b.state!.offers.find((x) => !x.aside)!;
      eq(f.confirmed?.by, "person", "stored with who confirmed it");
      eq(f.confirmed?.at, NOW + 60_000, "and when");
      eq(f.confirmed?.hash, a.state!.shown!.hash, "bound to the block shown");
    }
    eq(b.state?.shown ?? null, null, "the reading is used up");
  });
}

// ---------- 2. show -> correction -> show again -> yes ----------
const CORRECT: { says: string; fix: string; shows: RegExp; then: RegExp }[] = [
  { says: "Cobalt offered $150k as a software engineer in New York", fix: "no, the base is $165k", shows: /Base: \$165,000 a year/, then: /base \$165,000/ },
  { says: "Dunmore offered $135k as a software engineer in Seattle", fix: "actually it's $140k", shows: /Base: \$140,000 a year/, then: /base \$140,000/ },
  { says: "Alder offered $120k base and a $10k signing bonus as a data analyst in Chicago", fix: "sorry, the signing bonus is $12k", shows: /Signing bonus: \$12,000/, then: /signing \$12,000/ },
  { says: "Shopify offered me 140k as a software engineer in Toronto", fix: "it's in CAD", shows: /Base: CAD 140,000 a year/, then: /CAD 140,000/ },
  { says: "Elmstead offered $8,000 as a data analyst in Chicago", fix: "that's per month", shows: /Base: \$8,000 a month/, then: /\$8,000 a month/ },
  { says: "Foxglove offered $120k as a data analyst in New York", fix: "correction: it's $125k", shows: /Base: \$125,000 a year/, then: /base \$125,000/ },
  { says: "Quarry offered $130k as a data analyst in Chicago", fix: "no, $128k", shows: /Base: \$128,000 a year/, then: /base \$128,000/ },
  { says: "Tidewater offered $140,000 as a software engineer in Seattle", fix: "wrong, they raised it to $145k", shows: /Base: \$145,000 a year/, then: /base \$145,000/ },
];
for (const [i, c] of CORRECT.entries()) {
  Deno.test(`D-078/offer correct ${String(i + 1).padStart(2, "0")}: "${c.fix}" shows the reading again; the yes then confirms the corrected one`, async () => {
    const a = await offerChatTurn({ message: c.says, state: null, now: NOW });
    unconfirmedReply(a, c.says);
    const b = await offerChatTurn({ message: c.fix, state: a.state, now: NOW + 60_000 });
    unconfirmedReply(b, c.fix);
    ok(c.shows.test(b.answer!.reply), `the corrected reading ${c.shows}:\n${b.answer!.reply}`);
    ok(b.state!.shown!.hash !== a.state!.shown!.hash, "a new reading, a new hash");
    const y = await offerChatTurn({ message: "yes", state: b.state, now: NOW + 120_000, lastReply: b.answer!.reply });
    eq(y.answer?.intent, "career_offer_benchmark", y.answer?.reply);
    ok(c.then.test(y.answer!.reply), `${c.then}\n${y.answer!.reply}`);
    eq(y.state!.offers.filter((x) => !x.aside).at(-1)!.confirmed?.hash, b.state!.shown!.hash, "the yes confirms the corrected reading");
  });
}
Deno.test("D-078/offer correct 09: a plain no confirms nothing, asks what to change, and the next yes is to that question, not the reading", async () => {
  const { out, state } = await say(["Granite offered $95k as a data analyst in Chicago", "no", "yes"]);
  eq(out[1].answer?.intent, "career_offer_confirm");
  ok(/What should I change\?/.test(out[1].answer!.reply) && !COMPARED.test(out[1].answer!.reply), out[1].answer!.reply);
  ok(out[2].answer === null || out[2].answer.intent !== "career_offer_benchmark", "the yes after the no benchmarks nothing");
  eq(state!.offers[0].confirmed ?? null, null);
});

// ---------- 3. a change after the yes -> unconfirmed, shown again ----------
const AMEND: { says: string; change: string; shows: RegExp }[] = [
  { says: "JPM offered 110k base, 15k signing, NYC, analyst", change: "actually they raised it to $120k", shows: /Base: 120,000|Base: \$120,000/ },
  { says: "Cobalt offered $150k as a software engineer in New York", change: "they bumped the base to $158k", shows: /Base: \$158,000 a year/ },
  { says: "Alder offered $120k base as a data analyst in Chicago", change: "plus a $10k signing bonus", shows: /Signing bonus: \$10,000/ },
  { says: "Granite offered $95k as a data analyst in Chicago", change: "it's in CAD", shows: /Base: CAD 95,000/ },
  { says: "Dunmore offered $135k as a software engineer in Seattle", change: "correction: $132k", shows: /Base: \$132,000 a year/ },
  { says: "Quarry offered $130k as a data analyst in Chicago", change: "they lowered it to $125k", shows: /Base: \$125,000 a year/ },
];
for (const [i, c] of AMEND.entries()) {
  Deno.test(`D-078/offer amend ${String(i + 1).padStart(2, "0")}: "${c.change}" after the yes puts the offer back to unconfirmed; compare and counter wait for a new yes`, async () => {
    const { out, state } = await say([c.says, "yes", c.change]);
    eq(out[1].answer?.intent, "career_offer_benchmark");
    unconfirmedReply(out[2], c.change);
    ok(/That changes the offer you confirmed, so it needs your yes again/.test(out[2].answer!.reply), out[2].answer!.reply);
    ok(c.shows.test(out[2].answer!.reply), `${c.shows}\n${out[2].answer!.reply}`);
    eq(state!.offers.find((x) => !x.aside)!.confirmed ?? null, null, "unconfirmed on file");
    // A request to negotiate now shows the reading again instead of drafting.
    const n = await offerChatTurn({ message: "help me negotiate", state: state, now: NOW + 600_000 });
    unconfirmedReply(n, "help me negotiate");
    ok(/Before I draft a counter, confirm how I read this offer\./.test(n.answer!.reply), n.answer!.reply);
    const y = await offerChatTurn({ message: "yes", state: n.state, now: NOW + 660_000, lastReply: n.answer!.reply });
    eq(y.answer?.intent, "career_offer_counter", "the yes to that reading drafts the counter it was for");
    eq(y.answer!.card!.sent, false);
  });
}

// ---------- 4. a yes that is not to the reading just shown ----------
Deno.test("D-078/offer stray 01: a yes after another turn (a search the router answers) confirms nothing", async () => {
  const { out, state } = await say(["Granite offered $95k as a data analyst in Chicago", "find data analyst jobs in Chicago", "yes"]);
  eq(out[1].answer, null, "the router answers the search");
  eq(out[1].state?.shown ?? null, null, "the reading is dropped");
  ok(out[2].answer === null || !COMPARED.test(out[2].answer.reply), "nothing compared");
  eq(state!.offers[0].confirmed ?? null, null);
});
Deno.test("D-078/offer stray 02: a yes when the reply before it did not show the reading confirms nothing", async () => {
  const a = await offerChatTurn({ message: "Granite offered $95k as a data analyst in Chicago", state: null, now: NOW });
  const b = await offerChatTurn({ message: "yes", state: a.state, now: NOW + 60_000, lastReply: "Want me to search data analyst jobs in Chicago?" });
  eq(b.answer?.status, "not_confirmed", b.answer?.reply);
  ok(!COMPARED.test(b.answer!.reply));
  eq(b.state!.offers[0].confirmed ?? null, null);
});
Deno.test("D-078/offer stray 03: a yes to a reading that has since changed (the offer on file differs from the block shown) confirms nothing", async () => {
  const a = await offerChatTurn({ message: "Granite offered $95k as a data analyst in Chicago", state: null, now: NOW });
  const tampered: OfferChatState = { ...a.state!, offers: a.state!.offers.map((f) => ({ ...f, offer: { ...f.offer, base: 195000 } })) };
  const b = await offerChatTurn({ message: "yes", state: tampered, now: NOW + 60_000 });
  eq(b.answer?.status, "not_confirmed", b.answer?.reply);
  eq(b.state!.offers[0].confirmed ?? null, null);
});
Deno.test("D-078/offer stray 04: a yes a day later confirms nothing", async () => {
  const a = await offerChatTurn({ message: "Granite offered $95k as a data analyst in Chicago", state: null, now: NOW });
  const b = await offerChatTurn({ message: "yes", state: a.state, now: NOW + 25 * 3600_000 });
  ok(b.answer === null || b.answer.intent !== "career_offer_benchmark", b.answer?.reply);
});
Deno.test("D-078/offer stray 05: the handler drops a reading when another handler answered the turn; the yes after confirms nothing", async () => {
  const a = await offerChatTurn({ message: "Granite offered $95k as a data analyst in Chicago", state: null, now: NOW });
  const dropped = { ...a.state!, shown: null }; // handler-career.ts: a turn the offer turn did not run in drops `shown`
  const b = await offerChatTurn({ message: "yes", state: dropped, now: NOW + 60_000 });
  eq(b.answer, null);
  const src = await Deno.readTextFile(new URL("supabase/functions/agent-chat/handler-career.ts", root));
  ok(/else if \(\(ctx as any\)\.offerBenchmark\?\.shown\) \(ctx as any\)\.offerBenchmark = \{ \.\.\.\(ctx as any\)\.offerBenchmark, shown: null \};/.test(src), "the handler drops it");
});
Deno.test("D-078/offer stray 06: a hedged or questioning yes confirms nothing", async () => {
  for (const m of ["yes?", "yeah maybe", "is that right?", "I think so"]) {
    const a = await offerChatTurn({ message: "Granite offered $95k as a data analyst in Chicago", state: null, now: NOW });
    const b = await offerChatTurn({ message: m, state: a.state, now: NOW + 60_000 });
    ok(b.answer === null || b.answer.intent !== "career_offer_benchmark", `${m}: ${b.answer?.reply}`);
    eq(b.state!.offers[0].confirmed ?? null, null, m);
  }
});

// ---------- 5. compare and counter run only on confirmed readings ----------
Deno.test("D-078/offer compare 01: compare shows each unconfirmed reading first; after both yeses it compares", async () => {
  const { out } = await say(["Alder offered $120k base and a $10k signing bonus as a data analyst in Chicago", "Birchwood offered $110k base and a $20k signing bonus as a data analyst in Chicago", "compare my offers", "yes", "yes"]);
  unconfirmedReply(out[2], "compare");
  ok(/Before I compare, confirm how I read the Alder offer \(then 1 more\)\./.test(out[2].answer!.reply), out[2].answer!.reply);
  unconfirmedReply(out[3], "first yes");
  ok(/Company: Birchwood/.test(out[3].answer!.reply), out[3].answer!.reply);
  eq(out[4].answer?.intent, "career_offer_compare");
  ok(/Your 2 offers side by side/.test(out[4].answer!.reply), out[4].answer!.reply);
});
Deno.test("D-078/offer compare 02: the counter cites another offer only once it is confirmed", async () => {
  const { out } = await say(["JPM offered 110k base, 15k signing, NYC, analyst", "yes", "Citi offered me 115k base in New York as an analyst", "help me negotiate with JPM"]);
  eq(out[3].answer?.intent, "career_offer_counter");
  ok(!/Citi/.test(out[3].answer!.card!.body), `an unconfirmed offer is not cited:\n${out[3].answer!.card!.body}`);
  const { out: out2 } = await say(["JPM offered 110k base, 15k signing, NYC, analyst", "yes", "Citi offered me 115k base in New York as an analyst", "yes", "help me negotiate with JPM"]);
  ok(/I have another offer from Citi with a base of \$115,000\./.test(out2[4].answer!.card!.body), out2[4].answer!.card!.body);
});
Deno.test("D-078/offer compare 03: the counter email quotes the figures exactly as confirmed", async () => {
  const { out } = await say(["Kestrel offered me 120k as a data analyst in Chicago", "no, the base is $118,500", "yes", "help me negotiate"]);
  eq(out[3].answer?.intent, "career_offer_counter");
  ok(/\$118,500/.test(out[3].answer!.card!.body) && !/120,000|120k/.test(out[3].answer!.card!.body), out[3].answer!.card!.body);
});
Deno.test("D-078/offer compare 04: the block's hash is the SHA-256 of exactly the block shown", async () => {
  const a = await offerChatTurn({ message: "Granite offered $95k as a data analyst in Chicago", state: null, now: NOW });
  eq(a.state!.shown!.hash, readingHash(a.state!.shown!.block));
  const subtle = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(a.state!.shown!.block)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  eq(readingHash(a.state!.shown!.block), subtle, "the SHA-256 crypto.subtle gives");
  for (const t of ["", "abc", "é".repeat(100), "x".repeat(55), "x".repeat(56), "x".repeat(64)]) eq(readingHash(t), [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join(""), `length ${t.length}`);
  ok(a.answer!.reply.includes(a.state!.shown!.block));
  eq(a.state!.shown!.block, readingBlock(parseOfferWords("Granite offered $95k as a data analyst in Chicago", fixtures), { equity: null, benefits: [], check: false, estimate: false }));
});

// ---------- 6. the brain's tool (WO-036 offer_benchmark) holds the same line ----------
Deno.test("D-078/offer brain 01: offer_benchmark shows the reading; the yes in the next turn, to that reply, benchmarks", async () => {
  const a = offerTurn({ words: "JPM offered 110k base, 15k signing, NYC, analyst", pending: null, now: NOW, data: fixtures });
  eq(a.result.status, "confirm");
  ok(!COMPARED.test(a.result.messages.join("\n")) && a.result.benchmarks.length === 0 && a.result.draft === null);
  const b = offerTurn({ words: "yes", pending: a.pending, now: NOW + 60_000, data: fixtures, lastReply: a.result.messages.join("\n") });
  eq(b.result.status, "benchmarked");
  ok(b.result.draft !== null);
});
Deno.test("D-078/offer brain 02: a yes when the reply before did not show the reading confirms nothing", async () => {
  const a = offerTurn({ words: "JPM offered 110k base, 15k signing, NYC, analyst", pending: null, now: NOW, data: fixtures });
  const b = offerTurn({ words: "yes", pending: a.pending, now: NOW + 60_000, data: fixtures, lastReply: "Want me to look for jobs?" });
  eq(b.result.status, "confirm");
  eq(b.result.draft, null);
});

// ---------- 7. inferred skills: not printed until confirmed ----------
const POSTING = `Data Analyst, Acme Analytics (TEST posting)
Requirements:
- SQL and Python for reporting
- Tableau or Excel dashboards
- Build pipelines with Airflow
Nice to have: Spark, Kubernetes`;
function person(o: { exp: string[]; skills?: string[]; draftSkills?: string[]; expSkills?: string[] }) {
  const p = CareerProfile.createProfile({ basics: { name: "Alex Testcase", email: "alex.testcase@example.test", location: "Chicago, IL" } });
  for (const [i, t] of o.exp.entries()) CareerProfile.addFact(p, { kind: "experience", title: `Analyst, Testco ${i + 1}`, text: t, bullets: [t], start: "2023", end: "2025", ...(i === 0 && o.expSkills ? { skills: o.expSkills } : {}) });
  CareerProfile.addFact(p, { kind: "education", title: "BS Statistics, Test University", text: "BS Statistics, Test University", start: "2019", end: "2023" });
  for (const s of o.skills ?? []) CareerProfile.addFact(p, { kind: "skill", name: s, title: s, text: `Skill: ${s}`, skills: [s], evidence: [], source: "resume-ingest" });
  for (const s of o.draftSkills ?? []) CareerProfile.addFact(p, { kind: "skill", name: s, title: s, text: `Skill: ${s}`, skills: [s], evidence: [], source: "resume-ingest", needs_confirmation: true, status: "draft" });
  return p;
}
const deps = () => ({ render: edgeRenderer(), resumes: memoryResumeStore() });
const skillsPrinted = (doc: any) => doc.sections.flatMap((s: any) => s.lines).filter((l: any) => l.type === "skills").map((l: any) => l.text).join(" | ");
const EXP = "Built ETL pipelines in Python and SQL for the finance team, with Airflow schedules";

// statedSkill: what counts as the person's own statement (12 cases).
const STATED: [string, (p: any) => void, string, boolean][] = [
  ["a confirmed skill fact names it", () => {}, "Python", true],
  ["an alias of a confirmed skill fact", () => {}, "Postgres", true],
  ["experience text only", () => {}, "Airflow", false],
  ["experience text only, another", () => {}, "SQL", false],
  ["a draft skill fact (never confirmed)", (p) => CareerProfile.addFact(p, { kind: "skill", name: "Tableau", title: "Tableau", text: "Skill: Tableau", needs_confirmation: true, status: "draft" }), "Tableau", false],
  ["an inferred skill the person said yes to", (p) => { const f = CareerProfile.addFact(p, CareerProfile.inferredSkillDraft("SQL", ["F-001"])); CareerProfile.confirmFact(p, f.id); }, "SQL", true],
  ["\"my skills are Excel and R\" saved and confirmed", (p) => CareerProfile.addFact(p, { kind: "skill", text: "my skills are Excel and R" }), "Excel", true],
  ["a confirmed experience fact's own skills list", (p) => CareerProfile.addFact(p, { kind: "experience", title: "Intern, Listco", text: "Reporting intern", skills: ["Looker"] }), "Looker", true],
  ["a quarantined skill fact", (p) => CareerProfile.addFact(p, { kind: "skill", name: "Rust", title: "Rust", text: "Skill: Rust", provenance: "owner-delegated answer-all" }), "Rust", false],
  ["a skill never mentioned", () => {}, "Kubernetes", false],
  ["a declined inferred skill (still a draft)", (p) => CareerProfile.addFact(p, CareerProfile.inferredSkillDraft("Airflow", ["F-001"])), "Airflow", false],
  ["case and spacing", () => {}, " python ", true],
];
for (const [i, [why, setup, name, want]] of STATED.entries()) {
  Deno.test(`D-078/skill stated ${String(i + 1).padStart(2, "0")}: ${why} -> ${want}`, () => {
    const p = person({ exp: [EXP], skills: ["Python", "PostgreSQL"] });
    setup(p);
    eq(CareerProfile.statedSkill(p, name), want);
  });
}
// withoutInferredSkills on a Skills line (4 cases).
const LINES: [string, string, string | null, string[]][] = [
  ["inferred names come off, stated ones stay", "Technical skills: Python, SQL, Airflow", "Technical skills: Python", ["SQL", "Airflow"]],
  ["a line of only inferred names goes", "SQL, Airflow", null, ["SQL", "Airflow"]],
  ["a line of only stated names is unchanged", "Python, PostgreSQL", "Python, PostgreSQL", []],
  ["a slash pair counts when each part is stated", "Python/PostgreSQL, SQL", "Python/PostgreSQL", ["SQL"]],
];
for (const [i, [why, text, want, withheld]] of LINES.entries()) {
  Deno.test(`D-078/skill line ${String(i + 1).padStart(2, "0")}: ${why}`, () => {
    const p = person({ exp: [EXP], skills: ["Python", "PostgreSQL"] });
    const r = withoutInferredSkills({ sections: [{ heading: "Skills", lines: [{ text, factIds: ["F-001"], type: "skills" }] }], lines: [] }, p);
    eq(r.resume.sections.flatMap((s: any) => s.lines).map((l: any) => l.text)[0] ?? null, want);
    eq(r.withheld.map((w) => w.name), withheld);
    for (const w of r.withheld) eq(w.factIds, ["F-001"], `${w.name} is cited to the experience that named it`);
  });
}
Deno.test("D-078/skill resume 01: a skill read only from experience text does not print; it is named as withheld with its evidence", async () => {
  const p = person({ exp: [EXP] });
  const r = await tailorForPosting({ userId: "u1", profile: p, posting: { text: POSTING }, deps: deps(), now: NOW });
  ok(r.ok, (r as any).reason);
  if (!r.ok) return;
  ok(!/\bSQL\b|\bPython\b|\bAirflow\b/.test(skillsPrinted(r.detail.doc)), `nothing inferred on the Skills line: ${skillsPrinted(r.detail.doc)}`);
  ok((r.skills_withheld ?? []).some((w) => w.name === "Python" && w.factIds.length === 1), JSON.stringify(r.skills_withheld));
});
Deno.test("D-078/skill resume 02: skills the person stated directly (a confirmed Skills section) print", async () => {
  const p = person({ exp: [EXP], skills: ["Python", "SQL"] });
  const r = await tailorForPosting({ userId: "u1", profile: p, posting: { text: POSTING }, deps: deps(), now: NOW });
  ok(r.ok);
  if (!r.ok) return;
  ok(/\bPython\b/.test(skillsPrinted(r.detail.doc)) && /\bSQL\b/.test(skillsPrinted(r.detail.doc)), skillsPrinted(r.detail.doc));
  ok(!(r.skills_withheld ?? []).some((w) => w.name === "Python" || w.name === "SQL"));
});
Deno.test("D-078/skill resume 03: a skills section still waiting for the person's yes (drafts) does not print", async () => {
  const p = person({ exp: ["Led weekly reporting for the finance team"], draftSkills: ["Python", "SQL"] });
  const r = await tailorForPosting({ userId: "u1", profile: p, posting: { text: POSTING }, deps: deps(), now: NOW });
  ok(r.ok);
  if (!r.ok) return;
  ok(!/\bPython\b|\bSQL\b/.test(skillsPrinted(r.detail.doc)), skillsPrinted(r.detail.doc));
});
function tools() {
  return Object.fromEntries(careerTools({ postings: async () => [], tailor: { posting: async () => null, personas: memoryPersonaStore(), resumes: memoryResumeStore(), render: edgeRenderer() } }).map((x) => [x.name, x]));
}
const ctx = (profile: any, message: string, before?: string) => ({ userId: "00000000-0000-4000-8000-000000000078", threadId: "t1", now: NOW, state: { profile } as Record<string, any>, turn: { message, added: [] as string[], ...(before !== undefined ? { before } : {}) } });
Deno.test("D-078/skill resume 04: the resume path asks once; the yes (confirm_profile_fact) makes them print; a second resume does not ask again", async () => {
  const t = tools(), p = person({ exp: [EXP] });
  const first = await t.tailor_resume.run({ posting_text: POSTING }, ctx(p, "make me a resume for this")) as any;
  // Statistics is read from the degree's own words ("BS Statistics"): text-read too, so it is asked like the others.
  eq(first.skills_question, "I read these skills from your experience: Python, SQL, Statistics: keep them? They are not on your resume until you say yes.");
  ok(first.text.includes(first.skills_question));
  eq(first.skills_to_confirm.map((x: any) => x.name), ["Python", "SQL", "Statistics"]);
  for (const x of first.skills_to_confirm) eq(CareerProfile.getFact(p, x.id).needs_confirmation, true, "a draft until the yes");
  // Asked once: a second resume before any answer does not ask again, and still does not print them.
  const again = await t.tailor_resume.run({ posting_text: POSTING }, ctx(p, "make another one")) as any;
  eq(again.skills_question, undefined);
  // The person's yes, in the next turn, to the reply that showed the question.
  for (const x of first.skills_to_confirm) await t.confirm_profile_fact.run({ id: x.id }, ctx(p, "yes", first.text));
  const r = await tailorForPosting({ userId: "u1", profile: p, posting: { text: POSTING }, deps: deps(), now: NOW });
  ok(r.ok);
  if (!r.ok) return;
  for (const n of ["Python", "SQL", "Statistics"]) ok(new RegExp(`\\b${n}\\b`).test(skillsPrinted(r.detail.doc)), `${n} prints once confirmed: ${skillsPrinted(r.detail.doc)}`);
});
Deno.test("D-078/skill resume 05: a yes in the same turn as the question, or to another reply, confirms no inferred skill", async () => {
  const t = tools(), p = person({ exp: [EXP] });
  const c = ctx(p, "make me a resume for this");
  const first = await t.tailor_resume.run({ posting_text: POSTING }, c) as any;
  const id = first.skills_to_confirm[0].id;
  await assertNode.rejects(() => t.confirm_profile_fact.run({ id }, { ...c, turn: { ...c.turn, message: "yes" } }), /added in this turn/);
  await assertNode.rejects(() => t.confirm_profile_fact.run({ id }, ctx(p, "yes", "Want me to search for data analyst jobs?")), /did not show this fact/);
  eq(CareerProfile.getFact(p, id).needs_confirmation, true);
});
Deno.test("D-078/skill resume 06: an inference the stricter reader does not support (\"never used SQL\") is withheld and not asked", async () => {
  const t = tools(), p = person({ exp: ["Built Python reports for the finance team; I have never used SQL"] });
  const first = await t.tailor_resume.run({ posting_text: POSTING }, ctx(p, "make me a resume for this")) as any;
  ok(!(first.skills_to_confirm ?? []).some((x: any) => x.name === "SQL"), JSON.stringify(first.skills_to_confirm));
});

// ---------- 8. the 1,000 generated offers of research round 2 (D), through the yes ----------
// scenarios-research-r2 D checks the first reply; with the reading shown first, the same oracle runs here on the reply after the
// person's yes too, so the benchmarked path keeps its coverage: the current pay is never said back, and every figure is the
// offer's or a named source's.
Deno.test("D-078/offer generated: 1,000 offers with the current pay beside them, confirmed then benchmarked: no figure but the offer's or a source's", () => {
  const MONEY = /\$\d[\d,]*(?:\.\d+)?k?|\b\d{2,3}k\b/gi;
  const moneyOf = (s: string) => (s.match(MONEY) ?? []).map((m) => { const k = /k$/i.test(m); const n = Number(m.replace(/[$,k]/gi, "")); return k ? n * 1000 : n; });
  const bad: string[] = [];
  let benchmarked = 0;
  for (const [i, c] of offerCases(rng(20261030 + 3), 1000).entries()) {
    const shown = offerTurn({ words: c.words, pending: null, now: NOW });
    const t = shown.result.status === "confirm" ? offerTurn({ words: "yes", pending: shown.pending, now: NOW + 1000, lastReply: shown.result.messages.join("\n") }) : shown;
    if (t.result.status === "benchmarked") benchmarked++;
    for (const r of [shown, t]) {
      const msgs = (r.result.messages ?? []).join("\n");
      if (moneyOf(msgs).includes(c.current * 1000)) bad.push(`#${i} current pay said: ${msgs.slice(0, 160)}`);
      const sourced = new Set<number>([c.base * 1000]);
      for (const b of r.result.benchmarks ?? []) for (const v of Object.values(b as Record<string, unknown>)) if (typeof v === "number") sourced.add(Math.round(v));
      for (const n of moneyOf(msgs)) if (!sourced.has(n) && !(r.result.draft && JSON.stringify(r.result.draft).includes(String(n)))) bad.push(`#${i} $${n} unsourced: ${msgs.slice(0, 160)}`);
    }
  }
  eq(bad.slice(0, 5), []);
  ok(benchmarked >= 900, `most generated offers reach the benchmark after the yes (${benchmarked})`);
});
