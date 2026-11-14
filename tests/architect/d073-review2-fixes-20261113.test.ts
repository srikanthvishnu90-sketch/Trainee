// deno-lint-ignore-file no-explicit-any require-await
// D-073 review, second round (architect, 2026-11-13): the two gaps the first round left. Synthetic pages and figures; no network,
// no spend, no model.
//   G1  research read pages and none supports an answer (no_sources with `checked`): the person is ALWAYS told that it could not be
//       confirmed and which pages were checked (title and link), whatever the model wrote: an empty draft, claims only, or only a pay
//       line already shown. Company research has the same rule. With no page opened, the plain no-source line stands as before.
//   G2  the research brief File shows a condition or a risk among the others only when a sentence of its cited page says it (the
//       check the chat reply uses: market.ts saidBy / checkLine, `answerable`); any other reading is under its own "not confirmed"
//       label, in its own list, each line tagged. The chat reply and the File agree.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/d073-review2-fixes-20261113.test.ts
import assertNode from "node:assert/strict";
import { agentTurn, nonEmptyReply } from "../../supabase/functions/agent-chat/career_brain.ts";
import { enforceMarketReply, enforceMarketReplySupported, researchMarket } from "../../supabase/functions/_shared/agent/research/market.ts";
import { enforceCompanyReply, enforceCompanyReplySupported, researchCompany } from "../../supabase/functions/_shared/agent/research/company.ts";
import { supportsClaim, testSupportJudge } from "./support-test-judge.ts";
import type { SupportJudge } from "../../supabase/functions/_shared/agent/research/support.ts";
import { NO_SOURCES, NOT_CONFIRMED } from "../../supabase/functions/_shared/research_reply.ts";
import { bodyHtml, textOf, UNCONFIRMED_HEAD, UNCONFIRMED_TAG, validateKind } from "../../supabase/functions/_shared/file_kinds.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const NOW = Date.parse("2026-11-13T03:00:00Z");
type Page = { url: string; title: string; text: string };
const marketDeps = (pages: Page[], draft: unknown, extra: Record<string, unknown> = {}) => ({
  search: { id: "t", needsKey: false, search: async () => ({ hits: pages.map((p) => ({ url: p.url, title: p.title, provider: "t", foundAt: NOW })), notes: [], provider: "t" }) },
  read: async () => ({ verified: pages.map((p) => ({ url: p.url, requested: p.url, status: 200, title: p.title, text: p.text, fetchedAt: NOW })), rejected: [] }),
  // Architect amendment (owner decision 2026-11-13: research support check switched on): research needs its judge to keep a line
  // (the deterministic test judge, support-test-judge.ts, unless a test gives its own).
  draft: async () => JSON.stringify(draft), judge: testSupportJudge, ...extra,
});
// Architect amendment (owner decision 2026-11-13: research support check switched on): a judge that answers per these pages' truth.
// A claim in the model's words: the test judge's word-and-negation reading. A quote candidate ("the marked text is the page's own
// statement ... and it answers the question: <ask>"): yes only for the page sentences listed as answering the ask. (The test judge
// says yes to every quote candidate, which would let the senior traders' salary stand for what interns earn.)
const oracle = (answers: string[]): SupportJudge => async (cs) => cs.map((c) => {
  const m = /^The marked text "(.*)" is the page's own statement/s.exec(c.claim);
  return (m ? answers.includes(m[1]) : supportsClaim(c.claim, c.source)) ? "yes" : "no";
});
const ASK = "what do citadel software engineer interns earn";
const PAGES: Page[] = [{ url: "https://citadel.example/pay", title: "Citadel compensation notes", text: "Senior traders at Citadel earn a base salary of $350,000." }];
const DRAFT = { summary: [{ text: "Citadel interns earn $350,000.", quote: "earn a base salary of $350,000", url: PAGES[0].url }], conditions: [{ text: "Citadel interns earn $350,000 a year.", urls: [PAGES[0].url] }], risks: [] };
const LISTED = "[1] Citadel compensation notes: https://citadel.example/pay (read Nov 13, 2026)";
// Architect amendment (owner decision 2026-11-13: research support check switched on): no sentence of PAGES answers what interns
// earn, so the Citadel research is judged by the page-truth judge (with no judge at all the result would be the judge-outage path).
const market = (extra: Record<string, unknown> = {}, pages = PAGES) => researchMarket({ question: "Citadel software engineer intern pay", ask: ASK, format: "inline", plan: { queries: ["citadel intern pay"], companies: ["Citadel"] }, deps: marketDeps(pages, DRAFT, { judge: oracle([]), ...extra }) as any }) as Promise<any>;
const supported = (reply: string, r: any, shown: { text: string; url: string | null }[] = []) => enforceMarketReplySupported(reply, r, shown, { judge: oracle([]), ask: ASK });

Deno.test("G1 market: pages read, nothing verified: the reply always says it could not be confirmed and lists the pages checked", async () => {
  const r = await market();
  eq([r.status, r.checked.map((x: any) => x.url)], ["no_sources", [PAGES[0].url]]);
  // Whatever the model wrote without a "couldn't confirm" sentence of its own: nothing, a claim, a claim with a citation, a hedge.
  for (const draft of ["", "Citadel interns earn $350,000 [1].", "Citadel pays interns very well.", "I couldn't confirm it, but interns earn about $350,000.", "Here is what I found: https://evil.example/x"]) {
    eq(enforceMarketReply(draft, r), `${NOT_CONFIRMED}\n\n${LISTED}`, JSON.stringify(draft));
    // Architect amendment (owner decision 2026-11-13: research support check switched on): the same as the brain sends it.
    eq(await supported(draft, r), `${NOT_CONFIRMED}\n\n${LISTED}`, JSON.stringify(draft));
  }
  ok(/couldn't confirm/.test(NOT_CONFIRMED) && !/\d/.test(NOT_CONFIRMED), "the failure sentence says so and carries no figure");
  // The model's own sentence saying so still stands as written, with the same list (the first round's behaviour, unchanged).
  // Architect amendment (owner decision 2026-11-13: research support check switched on): checked as the brain sends it, a
  // could-not-confirm sentence stands unjudged only in the closed form ("I couldn't confirm it."); a longer one is replaced by code's.
  eq(await supported("I couldn't confirm it.", r), `I couldn't confirm it.\n\n${LISTED}`);
  eq(await supported("I looked for Citadel's intern pay and couldn't confirm it from the pages I read.", r), `${NOT_CONFIRMED}\n\n${LISTED}`);
  // A pay line this conversation already showed stays with its link; that research confirmed nothing is still said, with the pages.
  // Architect amendment (same): a shown line stands only whole, word for word; a reworded one ("PayPal pays $40 hourly.") does not.
  const shown = [{ text: "The PayPal internship pay is $40 hourly.", url: "https://jobs.example/paypal" }];
  const a = await supported("The PayPal internship pay is $40 hourly.", r, shown);
  eq(a, `The PayPal internship pay is $40 hourly.\nhttps://jobs.example/paypal\n\n${NOT_CONFIRMED}\n\n${LISTED}`);
  eq(await supported("PayPal pays $40 hourly.", r, shown), `${NOT_CONFIRMED}\n\n${LISTED}`);
  // The messages layout: the sentence, then each checked page's link on its own line.
  const rm = await market({ layout: "messages" });
  eq(enforceMarketReply("Citadel interns earn $350,000.", rm), `${NOT_CONFIRMED}\n${PAGES[0].url}`);
  // No page opened: nothing was checked, nothing is listed, and the plain no-source line stands.
  const none = await market({}, []);
  eq([none.status, none.checked ?? [], enforceMarketReply("Interns earn a lot.", none)], ["no_sources", [], NO_SOURCES]);
});

Deno.test("G1 through the turn: a claim-only reply, and an empty one, both end as 'could not confirm' with the page checked", async () => {
  for (const final of ["Citadel interns earn $350,000 a year.", ""]) {
    let step = 0;
    const model = async (p: any) => !p.tools?.length ? { content: [{ type: "text", text: "" }], stop_reason: "end_turn" } : (++step === 1
      ? { content: [{ type: "tool_use", id: "m1", name: "research_market", input: { question: "Citadel software engineer intern pay", format: "inline", queries: ["citadel intern pay"], companies: ["Citadel"] } }], stop_reason: "tool_use" }
      : { content: [{ type: "text", text: final }], stop_reason: "end_turn" });
    // Architect amendment (owner decision 2026-11-13: research support check switched on): the page-truth judge (above).
    const t: any = await agentTurn({ message: ASK, history: [], stores: { profile: {} }, userId: "u1", threadId: "t1", now: NOW, model, market: marketDeps(PAGES, DRAFT, { judge: oracle([]) }) } as any);
    ok(/couldn't confirm/.test(t.reply) && t.reply.includes(PAGES[0].url) && t.reply.includes("Citadel compensation notes") && !/350,000/.test(t.reply), `${JSON.stringify(final)} -> ${t.reply}`);
  }
  const r = await market();
  eq(nonEmptyReply({ reply: "", show: undefined, tool_calls: [] } as any, r), `${NOT_CONFIRMED}\n\n${LISTED}`);
});

Deno.test("G1 company research: pages opened and nothing quotable: the reply says so and lists the pages, whatever the model wrote", async () => {
  const pages: Page[] = [{ url: "https://zentrafin.example/", title: "Welcome", text: "Cookies help this site work. Accept all cookies to continue." }];
  const run = (role: string | null) => researchCompany({ company: "Zentrafin", role, question: "Research Zentrafin before my interview.", plan: { queries: ["Zentrafin"], companies: ["Zentrafin"] }, now: NOW, format: "inline", deps: marketDeps(pages, {}) as any }) as Promise<any>;
  const r = await run("data analyst intern");
  eq([r.status, r.checked.map((x: any) => [x.title, x.url])], ["no_sources", [["Welcome", pages[0].url]]]);
  const list = "[1] Welcome: https://zentrafin.example/ (read Nov 13, 2026)";
  for (const draft of ["", "Zentrafin is a fast-growing fintech with 5,000 staff.", "Apply on their careers page."]) {
    const a = enforceCompanyReply(draft, r);
    ok(a.startsWith("I couldn't do this research: 1 page(s) about Zentrafin were opened, but none stated anything the brief could quote.") && a.endsWith(`\n\n${list}`) && !/5,000|fintech|Apply on/.test(a), `${JSON.stringify(draft)} -> ${a}`);
  }
  // Architect amendment (owner decision 2026-11-13: research support check switched on): checked as the brain sends it
  // (enforceCompanyReplySupported), a could-not-find sentence stands unjudged only in the closed form ("I couldn't find it."); the
  // model's longer one is replaced by code's blocker sentence, with the pages.
  const companyAsk = "Research Zentrafin before my interview.";
  eq(await enforceCompanyReplySupported("I couldn't find it.", r, { judge: testSupportJudge, ask: companyAsk }), `I couldn't find it.\n\n${list}`);
  const longer = await enforceCompanyReplySupported("I couldn't find anything I could quote about Zentrafin.", r, { judge: testSupportJudge, ask: companyAsk });
  ok(longer.startsWith("I couldn't do this research: 1 page(s) about Zentrafin were opened, but none stated anything the brief could quote.") && longer.endsWith(`\n\n${list}`), longer);
  eq(nonEmptyReply({ reply: "", show: undefined, tool_calls: [] } as any, r), enforceCompanyReply("", r));
  // Role unknown and the reply is only the role question: the blocker is said first, the question stays, the page is listed.
  // Architect amendment (owner decision 2026-11-13: research support check switched on): as the brain sends it (the role question in
  // its closed form stands; the sync form, which cannot ask the judge, keeps no sentence of the model's).
  const q = await run(null), aq = await enforceCompanyReplySupported("Which role are you interviewing for?", q, { judge: testSupportJudge, ask: companyAsk });
  ok(aq.startsWith("I couldn't do this research:") && aq.includes("Which role are you interviewing for?") && aq.endsWith(list), aq);
});

// One page whose sentences say the summary lines and ONE of the readings; the other readings are the model's own.
const BATT: Page[] = [
  { url: "https://research.example/batteries", title: "Battery price survey", text: "Battery pack prices fell 20% in 2024. Utilities pay homes for stored power at peak hours." },
  { url: "https://utility.example/tariffs", title: "Storage tariffs", text: "The state board reviews the storage tariff every year." },
];
const SAID = "Utilities pay homes for stored power at peak hours.", NOT_SAID = ["Pack prices keep falling through next year.", "A tariff change could remove most of the bill savings."];
const BRIEF = { title: "Home batteries", thesis: "Battery pack prices fell and utilities pay for stored power.",
  summary: [{ text: "Battery pack prices fell 20% in 2024.", quote: "Battery pack prices fell 20% in 2024.", url: BATT[0].url }],
  conditions: [{ text: SAID, urls: [BATT[0].url] }, { text: NOT_SAID[0], urls: [BATT[0].url] }], risks: [{ text: NOT_SAID[1], urls: [BATT[1].url] }] };

Deno.test("G2 the brief File lists a reading as a condition or risk only when a page sentence says it; the rest are apart, labelled not confirmed; chat and File agree", async () => {
  const published: any[] = [];
  const ask = { question: "What would change the market for home batteries?", plan: { queries: ["home battery market"] } };
  const r: any = await researchMarket({ ...ask, format: "file", deps: marketDeps(BATT, BRIEF, { publish: async (d: unknown) => { published.push(d); return { url: "https://trainee.example/file?t=v1.g2" }; } }) as any });
  eq([r.status, r.format, published.length], ["ok", "file", 1]);
  // Architect amendment (owner decision 2026-11-13: research support check switched on): on the support path a reading reaches the
  // File (or the chat) only as a sentence of its page: the one its page says stands as that sentence, in quotation marks; NOT_SAID[0]
  // has no page sentence and is dropped; NOT_SAID[1] fails the judge and its page's own sentence stands in its place, quoted. So no
  // reading the pages do not say is in the File at all, and the File and the chat agree on every reading.
  const TARIFF = "The state board reviews the storage tariff every year.";
  eq(r.answerable, [`"${SAID}"`, `"${TARIFF}"`], "the chat's check: each reading kept is its page's own sentence");
  const d0 = published[0];
  eq([...d0.conditions, ...d0.risks].map((x: any) => [x.text, x.unconfirmed === true]), [[`"${SAID}"`, false], [`"${TARIFF}"`, false]]);
  eq([...d0.conditions, ...d0.risks].filter((x: any) => !x.unconfirmed).map((x: any) => x.text), r.answerable, "File and chat agree on which readings stand");
  for (const t of NOT_SAID) ok(!JSON.stringify(d0).includes(t.replace(/\.$/, "")), `${t} is nowhere in the File`);
  ok(validateKind("research_brief", d0, { now: NOW }).ok);
  // The File's own rule for a reading marked not confirmed (a brief code marks; none is made on the support path) still holds: the
  // same brief with the readings marked as before renders them apart, labelled, in their own list.
  const d = { ...d0, conditions: [{ text: SAID, cite: [1] }, { text: NOT_SAID[0], cite: [1], unconfirmed: true }], risks: [{ text: NOT_SAID[1], cite: [2], unconfirmed: true }] };
  eq([...d.conditions, ...d.risks].map((x: any) => [x.text, x.unconfirmed === true]), [[SAID, false], [NOT_SAID[0], true], [NOT_SAID[1], true]]);
  const v: any = validateKind("research_brief", d, { now: NOW });
  ok(v.ok, JSON.stringify(v));
  eq([...v.data.conditions, ...v.data.risks].map((x: any) => x.unconfirmed === true), [false, true, true], "the mark survives the kind's validation");
  // Only code's `true` is a mark, and only on a reading; anything else is not kept.
  const odd: any = validateKind("research_brief", { ...d, summary: d.summary.map((s: any) => ({ ...s, unconfirmed: true })), conditions: d.conditions.map((c: any) => ({ ...c, unconfirmed: "no" })) }, { now: NOW });
  ok(odd.ok && odd.data.summary.every((s: any) => !("unconfirmed" in s)) && odd.data.conditions.every((c: any) => !("unconfirmed" in c)));

  const rec = { id: "f1", userId: "u", kind: "research_brief", data: v.data, state: {}, tag: null, created_at: NOW, expires_at: NOW + 3600_000, revoked_at: null } as any;
  const h = bodyHtml(rec, "fs1." + "a".repeat(64));
  const section = (head: string) => { const a = h.indexOf(`<h2>${head}</h2>`); ok(a >= 0, head); return h.slice(a, h.indexOf("</section>", a)); };
  const cond = section("What would have to be true"), risk = section("Risks");
  const li = (sec: string, text: string) => { const m = new RegExp(`<li><span class="rb-t">${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*?</li>`).exec(sec); ok(m, text); return { at: m!.index, html: m![0] }; };
  const head = (sec: string) => sec.indexOf(UNCONFIRMED_HEAD.replace(/'/g, "&#39;")) >= 0 ? sec.indexOf(UNCONFIRMED_HEAD.replace(/'/g, "&#39;")) : sec.indexOf(UNCONFIRMED_HEAD);
  ok(/not confirmed/i.test(UNCONFIRMED_HEAD) && /not confirmed/i.test(UNCONFIRMED_TAG));
  // Conditions: the said one first, in the plain list, tagged "Trainee's reading" only; then the label; then the other, in its own list.
  ok(head(cond) > 0 && li(cond, SAID).at < head(cond) && li(cond, NOT_SAID[0]).at > head(cond), cond);
  ok(!/not confirmed/i.test(li(cond, SAID).html) && /not confirmed/i.test(li(cond, NOT_SAID[0]).html));
  eq((cond.match(/<ul class="rb-list/g) ?? []).length, 2, "two lists: never one mixed list");
  ok(cond.indexOf('<ul class="rb-list rb-unconfirmed">') > head(cond) && cond.indexOf("</ul>") < head(cond));
  // Risks: the only risk is not said by its page, so nothing is listed outside the "not confirmed" list.
  ok(head(risk) > 0 && li(risk, NOT_SAID[1]).at > head(risk) && /not confirmed/i.test(li(risk, NOT_SAID[1]).html), risk);
  eq((risk.match(/<ul class="rb-list/g) ?? []).length, 1);
  // Nowhere else on the page (the summary, the cover) is an unconfirmed reading written.
  for (const t of NOT_SAID) eq(h.split(t).length - 1, 1, t);
  // The text twin says the same.
  const lines = textOf(rec, { now: NOW }).split("\n");
  const at = (s: string) => { const k = lines.findIndex((l) => l.includes(s)); ok(k >= 0, s); return k; };
  ok(lines[at(SAID)].endsWith("[Trainee's reading]") && lines[at(NOT_SAID[0])].endsWith(`[${UNCONFIRMED_TAG}]`) && lines[at(NOT_SAID[1])].endsWith(`[${UNCONFIRMED_TAG}]`));
  ok(at(SAID) < lines.indexOf(UNCONFIRMED_HEAD) && lines.indexOf(UNCONFIRMED_HEAD) < at(NOT_SAID[0]) && lines.lastIndexOf(UNCONFIRMED_HEAD) === at(NOT_SAID[1]) - 1 && lines.lastIndexOf(UNCONFIRMED_HEAD) > at("## Risks"));

  // The chat answer from the same pages and draft: the said reading may be stated; an unconfirmed one never is, whatever the model wrote.
  const ri: any = await researchMarket({ ...ask, format: "inline", deps: marketDeps(BATT, BRIEF) as any });
  eq(ri.answerable, r.answerable);
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the reply as the brain sends it, too.
  for (const draft of ["", `${NOT_SAID[0].replace(/\.$/, "")} [1]. ${NOT_SAID[1].replace(/\.$/, "")} [2].`]) {
    for (const a of [enforceMarketReply(draft, ri), await enforceMarketReplySupported(draft, ri, [], { judge: testSupportJudge, ask: ask.question })])
      for (const t of NOT_SAID) ok(!a.includes(t.replace(/\.$/, "")), `${t}\n${a}`);
  }
  // The reading its page says may be stated, with its source: as that page's sentence, in quotation marks.
  const saidA = await enforceMarketReplySupported(`${SAID.replace(/\.$/, "")} [1].`, ri, [], { judge: testSupportJudge, ask: ask.question });
  ok(saidA.startsWith(`"${SAID}" [1].`) && saidA.includes(BATT[0].url), saidA);
  // A brief made before this mark (no `unconfirmed` on any line) renders as it did: one list per section, no label.
  const old: any = validateKind("research_brief", { ...d, conditions: d.conditions.map(({ unconfirmed: _u, ...c }: any) => c), risks: d.risks.map(({ unconfirmed: _u, ...c }: any) => c) }, { now: NOW });
  ok(old.ok && !bodyHtml({ ...rec, data: old.data }, "fs1." + "a".repeat(64)).includes("rb-unconfirmed"));
});
