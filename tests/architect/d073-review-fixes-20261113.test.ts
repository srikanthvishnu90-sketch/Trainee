// D-073 review (architect, 2026-11-13): the fixes for what an independent reading of PR #801 found. The owner's two rules both hold:
// research is never blank, and nothing unsourced is shown as verified fact. Synthetic pages and figures; no network, no spend.
//   R1  a place is written only into the sentence bound to that posting's pay; ambiguous: nothing. The place read back from an
//       earlier reply is the one beside the figure, and "Title, US" is not a place.
//   R2  a model-worded reading with a figure is the answer only when a sentence of its cited page says it; otherwise it is not
//       shown and lends no figure; a pay sentence from a page answers only the role and level asked; with nothing verified the
//       reply says it could not confirm, with the sources checked.
//   R3  "X or Y" in the person's message adds a search alternative only when both sides are places.
//   R4  a denying adverb is not its stem; a spelled count must count the same thing.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/d073-review-fixes-20261113.test.ts
import assertNode from "node:assert/strict";
import { agentTurn, payWithSource } from "../../supabase/functions/agent-chat/career_brain.ts";
import { aboutAsked, checkLine, enforceMarketReply, enforceMarketReplySupported, researchMarket, wordsOnPages } from "../../supabase/functions/_shared/agent/research/market.ts";
import { placeBeside, shownPayPlaces } from "../../supabase/functions/_shared/agent/turn_notes.ts";
import { orAlternatives, placeAlternatives } from "../../supabase/functions/_shared/career_search.ts";
import { supportsClaim, testSupportJudge } from "./support-test-judge.ts";
import type { SupportJudge } from "../../supabase/functions/_shared/agent/research/support.ts";
import { NOT_CONFIRMED } from "../../supabase/functions/_shared/research_reply.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const NOW = Date.parse("2026-11-13T03:00:00Z");
type Page = { url: string; title: string; text: string };
const marketDeps = (pages: Page[], draft: unknown, extra: Record<string, unknown> = {}) => ({
  search: { id: "t", needsKey: false, search: async () => ({ hits: pages.map((p) => ({ url: p.url, title: p.title, provider: "t", foundAt: NOW })), notes: [], provider: "t" }) },
  read: async () => ({ verified: pages.map((p) => ({ url: p.url, requested: p.url, status: 200, title: p.title, text: p.text, fetchedAt: NOW })), rejected: [] }),
  // Architect amendment (owner decision 2026-11-13: research support check switched on): research needs its judge to keep a line;
  // the deterministic test judge (support-test-judge.ts) says yes only when a claim's words and negation are its page sentence's.
  draft: async () => JSON.stringify(draft), judge: testSupportJudge, ...extra,
});

Deno.test("R1 a place goes only into the sentence bound to that posting's pay; an ambiguous sentence gets none", () => {
  const stripe = { company: "Stripe", pay: "$40/hr", url: "https://jobs.example/stripe", place: "Chicago, IL" };
  const paypal = { company: "PayPal", pay: "$40/hr", url: "https://jobs.example/paypal", place: "Seattle, WA" };
  // Architect amendment (owner decision 2026-11-13: research support check switched on; review of #807, class 8): no place is written
  // into a sentence of the model's any more, and none is taken from reply text. A posting's place goes beside that posting's own
  // link, with its employer (and title), from that posting's own record, only when the record names one place. So every sentence
  // below is left as written (no place is ever put on the wrong employer's pay), and the places are on the link lines.
  const two = payWithSource("Stripe pays $40/hr. PayPal pays $40/hr.", [stripe, paypal]);
  eq(two, "Stripe pays $40/hr. PayPal pays $40/hr.\n\nStripe (Chicago, IL): https://jobs.example/stripe\nPayPal (Seattle, WA): https://jobs.example/paypal");
  ok(two.includes(stripe.url) && two.includes(paypal.url), "each still carries its link");
  // One sentence about both employers: no place is written into it; each link line carries its own posting's place.
  eq(payWithSource("Stripe and PayPal both pay $40/hr.", [stripe, paypal]).split("\n")[0], "Stripe and PayPal both pay $40/hr.");
  // One posting read this turn: a sentence about another employer never takes its place; the link line names whose place it is.
  eq(payWithSource("Globex pays $40/hr too.", [stripe]).split("\n")[0], "Globex pays $40/hr too.");
  eq(payWithSource("The pay is $40/hr.", [stripe]), "The pay is $40/hr.\n\nStripe (Chicago, IL): https://jobs.example/stripe");
  eq(payWithSource("The Software Engineer Intern role pays $40/hr.", [{ ...stripe, title: "Software Engineer Intern" }]), "The Software Engineer Intern role pays $40/hr.\n\nStripe, Software Engineer Intern (Chicago, IL): https://jobs.example/stripe");
  // Pay by place: a record whose pay names two places names no one place, so its link goes alone; no sentence gets a place.
  const by = { company: "PayPal", pay: "Chicago, IL: $28-$49; San Jose, CA: $36-$62", url: "https://jobs.example/paypal" };
  eq(payWithSource("PayPal lists $36-$62 an hour.", [by]), "PayPal lists $36-$62 an hour.\n\nhttps://jobs.example/paypal");
  eq(payWithSource("PayPal lists $28-$49 an hour.", [by]), "PayPal lists $28-$49 an hour.\n\nhttps://jobs.example/paypal");
  eq(payWithSource("PayPal lists $28 to $62 an hour.", [by]).split("\n")[0], "PayPal lists $28 to $62 an hour.");
  // Pay this conversation showed: the shown lines' links, never a place read from reply text.
  const shown = [{ text: "Stripe pay is $40 hourly.", url: stripe.url, place: "Chicago, IL" }, { text: "PayPal pay is $40 hourly.", url: paypal.url, place: "Seattle, WA" }];
  eq(payWithSource("Both pay $40 hourly.", [], shown).split("\n")[0], "Both pay $40 hourly.");
  eq(payWithSource("That one pays $40 hourly.", [], shown.slice(0, 1)), "That one pays $40 hourly.\n\nhttps://jobs.example/stripe");
  for (const x of [two, payWithSource("Both pay $40 hourly.", [], shown), payWithSource("That one pays $40 hourly.", [], shown.slice(0, 1))]) ok(!/\$40[^\n]*\((?:Chicago|Seattle)/.test(x.split("\n")[0]), x);

  // The place read back from an earlier reply: the one beside the figure, never the paragraph's first; a title is not a place.
  const para = "1. Stripe, Software Engineer Intern, US (Seattle, WA): pay $50 hourly.\n2. PayPal, SWE Intern (Chicago, IL): pay $28-$49 hourly.";
  eq(placeBeside(para, "PayPal, SWE Intern (Chicago, IL): pay $28-$49 hourly."), "Chicago, IL");
  const history = [{ role: "user", content: "find me internships" }, { role: "assistant", content: `Stripe is in Seattle, WA and PayPal is in Chicago, IL.\nThe PayPal internship pay is $28-$49 hourly.\nhttps://jobs.example/paypal` }];
  eq(shownPayPlaces("what's the pay", history as any).map((x) => x.place), [null], "two places, none beside the figure: no place is taken");
  const titled = [{ role: "assistant", content: "Software Engineer Intern, US\nThe pay is $30 hourly.\nhttps://jobs.example/x" }];
  eq(shownPayPlaces("what's the pay", titled as any).map((x) => x.place), [null], "'Software Engineer Intern, US' is not a place");
  const one = [{ role: "assistant", content: "PayPal SWE Intern, Chicago, IL\nThe pay is $28-$49 hourly.\nhttps://jobs.example/paypal" }];
  eq(shownPayPlaces("what's the pay", one as any).map((x) => x.place), ["Chicago, IL"]);
});

const CITADEL: Page[] = [
  { url: "https://citadel.example/giving", title: "Citadel in the community", text: "Citadel gave $5,000 a week to Chicago food banks during the winter. The firm hosts interns in Chicago each summer for eleven weeks." },
  { url: "https://citadel.example/pay", title: "Citadel compensation notes", text: "Senior engineers at Citadel earn a base salary of $350,000. Volunteers earn praise at Citadel events." },
];
const ASK = "what do citadel software engineer interns earn";
// Architect amendment (owner decision 2026-11-13: research support check switched on): a judge that answers per these pages' truth.
// A claim in the model's words: the test judge's word-and-negation reading. A quote candidate ("the marked text is the page's own
// statement ... and it answers the question: <ask>"): yes only for the page sentences listed as answering that ask. The test judge
// says yes to every quote candidate, which would let "Citadel gave $5,000 a week to Chicago food banks" stand for intern pay.
const oracle = (answers: string[]): SupportJudge => async (cs) => cs.map((c) => {
  const m = /^The marked text "(.*)" is the page's own statement/s.exec(c.claim);
  return (m ? answers.includes(m[1]) : supportsClaim(c.claim, c.source)) ? "yes" : "no";
});
Deno.test("R2 a model-worded reading with a figure is never the verified answer unless a sentence of its page says it", async () => {
  const reading = "Citadel interns earn $5,000 a week.";
  const r: any = await researchMarket({ question: "Citadel software engineer intern pay", ask: ASK, format: "inline", plan: { queries: ["citadel intern pay"], companies: ["Citadel"] },
    deps: marketDeps(CITADEL, { title: "Citadel intern pay", summary: [], conditions: [{ text: reading, urls: [CITADEL[0].url] }], risks: [] }, { judge: oracle([]) }) as any });
  // "$5,000" is on the page (the old rule) and most of the reading's letters are; no sentence of the page says interns earn it.
  eq(r.answerable ?? [], []);
  const a = enforceMarketReply("", r);
  ok(!/5,000|350,000/.test(a), `no unverified figure, and no other level's pay, is shown:\n${a}`);
  // Never blank. Architect amendment (owner decision 2026-11-13: research support check switched on): no sentence of these pages
  // answers what Citadel's interns earn ("The firm hosts interns in Chicago each summer for eleven weeks." says nothing of pay, and
  // the judge is asked whether a unit answers the question), so nothing is verified: code says it could not confirm an answer and
  // lists the pages it checked.
  eq(r.status, "no_sources");
  ok(a.startsWith(NOT_CONFIRMED) && a.includes(CITADEL[0].url), a);
  // The model saying the reading's figure with its page's number does not make it stand.
  ok(!/5,000/.test(enforceMarketReply("Citadel interns earn $5,000 a week [1].", r)));

  // A reading one sentence of its page does say (its figure in that sentence, about the same employer) answers.
  const said = "Senior engineers at Citadel earn a base salary of $350,000.";
  const r2: any = await researchMarket({ question: "Citadel senior software engineer pay", ask: "what do senior engineers at citadel earn", format: "inline", plan: { queries: ["citadel pay"], companies: ["Citadel"] },
    deps: marketDeps(CITADEL, { summary: [], conditions: [{ text: said, urls: [CITADEL[1].url] }], risks: [] }, { judge: oracle([said]) }) as any });
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the reading is its page's sentence word for
  // word, so it stands as that sentence, in quotation marks, citing its page.
  eq(r2.answerable, [`"${said}"`]);
  ok(/\$350,000\." \[1\]/.test(enforceMarketReply("", r2)), enforceMarketReply("", r2));
  // The same figure claimed of another employer or another subject does not.
  for (const t of ["Senior engineers at Globex earn a base salary of $350,000.", "Citadel interns earn a base salary of $350,000."]) {
    const x: any = await researchMarket({ question: "Citadel pay", ask: "what does citadel pay", format: "inline", plan: { queries: ["citadel pay"], companies: ["Citadel"] },
      deps: marketDeps(CITADEL, { summary: [], conditions: [{ text: t, urls: [CITADEL[1].url] }], risks: [] }, { judge: oracle([said]) }) as any });
    eq(x.answerable ?? [], [], t);
    ok(!enforceMarketReply("", x).includes(t.replace(/\.$/, "")), t);
  }

  // A word is on a page as a word, never as letters inside another.
  eq(wordsOnPages("intern", [{ text: "The interest rate rose." }]), 0);
  eq(wordsOnPages("rate", [{ text: "A corporate filing." }]), 0);
  eq(wordsOnPages("interns salaries", [{ text: "Each intern has a salary." }]), 1);
  // A pay sentence is about the role and level asked, or it is not the answer to the pay asked.
  ok(!aboutAsked("Senior engineers at Citadel earn a base salary of $350,000.", "Citadel compensation notes", ASK));
  ok(!aboutAsked("Traders at Citadel earn $200,000.", "Citadel compensation notes", "citadel software engineer pay"));
  ok(aboutAsked("The base salary range for this role is $120 an hour.", "Software Engineer Intern - Citadel", ASK));
  ok(aboutAsked("Software engineering interns earn $120 an hour.", "Citadel careers", ASK));
  ok(aboutAsked("Citadel pays a base salary of $200,000.", "Citadel careers", "what does citadel pay"));
});

Deno.test("R2 nothing verified: the reply says it could not confirm, with the sources checked; never a figure, never blank", async () => {
  const pages: Page[] = [{ url: "https://citadel.example/pay", title: "Citadel compensation notes", text: "Senior traders at Citadel earn a base salary of $350,000." }];
  const draft = { summary: [{ text: "Citadel interns earn $350,000.", quote: "earn a base salary of $350,000", url: pages[0].url }], conditions: [{ text: "Citadel interns earn $350,000 a year.", urls: [pages[0].url] }], risks: [] };
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the judge answers per the page's truth
  // (oracle: the senior traders' salary sentence does not answer what interns earn), and the reply is checked as the brain sends it
  // (enforceMarketReplySupported, with the ask): a could-not-confirm sentence stands only in the closed form ("I couldn't confirm
  // it."); the model's longer one ("I looked for ... and couldn't confirm it from the pages I read.") is replaced by code's own line.
  const r: any = await researchMarket({ question: "Citadel software engineer intern pay", ask: ASK, format: "inline", plan: { queries: ["citadel intern pay"], companies: ["Citadel"] }, deps: marketDeps(pages, draft, { judge: oracle([]) }) as any });
  eq(r.status, "no_sources");
  ok(/couldn't confirm/.test(r.note) && /looked for/.test(r.note));
  eq(r.checked.map((x: any) => x.url), [pages[0].url]);
  const LIST = "[1] Citadel compensation notes: https://citadel.example/pay (read Nov 13, 2026)";
  const a = await enforceMarketReplySupported("Citadel interns earn $350,000 [1]. I couldn't confirm it.", r, [], { judge: oracle([]), ask: ASK });
  eq(a, `I couldn't confirm it.\n\n${LIST}`);
  eq(await enforceMarketReplySupported("Citadel interns earn $350,000 [1]. I looked for Citadel's intern pay and couldn't confirm it from the pages I read.", r, [], { judge: oracle([]), ask: ASK }), `${NOT_CONFIRMED}\n\n${LIST}`);
  // Through the turn: the person gets that sentence and the source checked, and no figure.
  let step = 0;
  const model = async (p: any) => !p.tools?.length ? { content: [{ type: "text", text: "" }], stop_reason: "end_turn" } : (++step === 1
    ? { content: [{ type: "tool_use", id: "m1", name: "research_market", input: { question: "Citadel software engineer intern pay", format: "inline", queries: ["citadel intern pay"], companies: ["Citadel"] } }], stop_reason: "tool_use" }
    : { content: [{ type: "text", text: "I looked for Citadel's intern pay and couldn't confirm it from the pages I read." }], stop_reason: "end_turn" });
  const t: any = await agentTurn({ message: ASK, history: [], stores: { profile: {} }, userId: "u1", threadId: "t1", now: NOW, model, market: marketDeps(pages, draft, { judge: oracle([]) }) } as any);
  ok(/couldn't confirm/.test(t.reply) && t.reply.includes(pages[0].url) && !/350,000/.test(t.reply), t.reply);
  // No page opened at all: nothing was checked, so nothing is listed.
  const none: any = await researchMarket({ question: "Citadel intern pay", format: "inline", plan: { queries: ["x"] }, deps: marketDeps([], draft) as any });
  eq([none.status, none.checked ?? []], ["no_sources", []]);
});

Deno.test("R3 'or' in the person's message adds a search alternative only when both sides are places", () => {
  eq(placeAlternatives("intern chicago", "internships in chicago or should I wait", null), "intern chicago");
  eq(orAlternatives(placeAlternatives("intern chicago", "internships in chicago or should I wait", null)), ["intern chicago"]);
  eq(placeAlternatives("intern chicago", "swe intern roles in chicago or python ones", null), "intern chicago");
  eq(placeAlternatives("intern remote", "remote or am I too late", null), "intern remote");
  // Two places still are alternatives.
  eq(placeAlternatives("intern chicago", "internships in chicago or remote", null), "intern chicago or remote");
  eq(placeAlternatives("analyst boston", "analyst roles in boston or seattle please", null), "analyst boston or seattle");
  eq(placeAlternatives("analyst texas", "analyst roles in texas or illinois", null), "analyst texas or illinois");
});

Deno.test("R4 a denying adverb is not its stem; a spelled count must count the same thing", () => {
  const pg = (t: string) => ({ url: "https://acme.example/a", requested: "https://acme.example/a", status: 200, title: "Careers", text: t, fetchedAt: NOW } as any);
  eq(checkLine("Acme hires interns in winter.", "Acme hardly hires interns in winter.", pg("Acme hardly hires interns in winter.")).ok, false);
  eq(checkLine("Acme hardly hires interns in winter.", "Acme hires interns in winter.", pg("Acme hires interns in winter.")).ok, false);
  eq(checkLine("Acme hardly hires interns in winter.", "Acme hardly hires interns in winter.", pg("Acme hardly hires interns in winter.")).ok, true);
  eq(checkLine("Acme works hard for customers.", "Acme works hard for customers.", pg("Acme works hard for customers.")).ok, true);
  eq(checkLine("Acme runs 3 rounds of interviews.", "Acme runs three rounds of interviews.", pg("Acme runs three rounds of interviews.")).ok, true);
  eq(checkLine("Acme runs 3 rounds of interviews.", "Acme, one of three firms, runs rounds of interviews.", pg("Acme, one of three firms, runs rounds of interviews.")), { ok: false, why: "figure_not_in_quote" });
  eq(checkLine("Acme has 1 office.", "Acme is one of the firms with an office.", pg("Acme is one of the firms with an office.")), { ok: false, why: "figure_not_in_quote" });
});
