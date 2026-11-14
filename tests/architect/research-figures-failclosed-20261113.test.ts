// deno-lint-ignore-file no-explicit-any require-await
// Research figures fail closed (architect, 2026-11-13, on the independent review of PR #801, squash 60d9a815). Owner: "never give
// blank research answers" AND "verify pay figures with sources": nothing unsourced is shown as verified fact. Word overlap cannot
// see a negation or who a figure is about. What is on by default (every existing architect test still passes, unedited):
//   A  a model-worded line stands only when its page's sentence has the same polarity; otherwise the page's own sentence, word for
//      word, stands in its place, or the line is dropped;
//   B  a reply sentence with a number has the polarity, the level and the kind of work of the kept line its figure is from, or it
//      is removed and the kept line is given;
//   C  a thesis with a number is said by one page sentence or gives way to the first kept line; no thesis restates a reading the
//      File lists as not confirmed;
//   The whole of A, B and C (a line with a number ONLY as its page's own sentence; a reply sentence with a number only when it is
//   such a sentence; no unverified thesis at all) is market.ts FAIL_CLOSED.figures, off because existing architect tests pin a
//   model-worded figure as the expected output; its acceptance test is tests/architect/pending/research-figures-verbatim-20261113.test.ts.
//   D  a pay sentence is about the role asked by its own words or the sentence before it, never by the page's title;
//   E  nothing verified: one sentence that only says it could not be confirmed, then the pages checked; nothing else;
//   F  a reply that came back unfinished is answered from the kept lines when research kept any;
//   G  a place is written beside a pay figure only when nothing in the sentence or the record leaves it in doubt.
// Synthetic pages and figures; no network, no spend, no model.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/research-figures-failclosed-20261113.test.ts
import assertNode from "node:assert/strict";
import { agentTurn, payWithSource } from "../../supabase/functions/agent-chat/career_brain.ts";
import { aboutAsked, enforceMarketReplySupported, researchMarket } from "../../supabase/functions/_shared/agent/research/market.ts";
import { NOT_CONFIRMED } from "../../supabase/functions/_shared/research_reply.ts";
import { INCOMPLETE_REPLY } from "../../supabase/functions/_shared/agent/loop.ts";
import { shownPayPlaces } from "../../supabase/functions/_shared/agent/turn_notes.ts";
import { bodyHtml, textOf, validateKind } from "../../supabase/functions/_shared/file_kinds.ts";
import type { SupportJudge } from "../../supabase/functions/_shared/agent/research/support.ts";
import { testSupportJudge } from "./support-test-judge.ts";
import { truthJudge } from "./support-test-judge-b.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const NOW = Date.parse("2026-11-13T03:00:00Z");
type Page = { url: string; title: string; text: string };
const marketDeps = (pages: Page[], draft: unknown, extra: Record<string, unknown> = {}) => ({
  search: { id: "t", needsKey: false, search: async () => ({ hits: pages.map((p) => ({ url: p.url, title: p.title, provider: "t", foundAt: NOW })), notes: [], provider: "t" }) },
  read: async () => ({ verified: pages.map((p) => ({ url: p.url, requested: p.url, status: 200, title: p.title, text: p.text, fetchedAt: NOW })), rejected: [] }),
  draft: async () => JSON.stringify(draft), ...extra,
});
const ASK = "what do citadel software engineer interns earn";
const URL1 = "https://citadel.example/pay";
const page = (text: string, title = "Citadel compensation notes"): Page[] => [{ url: URL1, title, text }];
// Architect amendment (owner decision 2026-11-13: research support check switched on): research is built with its judge (no judge
// fails closed: nothing stands); a test may give its own page-truth judge in `extra`. The reply is enforced through the awaited form
// with that same judge and the same ask (the synchronous enforceMarketReply lets no sentence of the model's through).
const run = (pages: Page[], draft: unknown, o: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  researchMarket({ question: "Citadel software engineer intern pay", ask: ASK, format: "inline", plan: { queries: ["citadel intern pay"], companies: ["Citadel"] }, deps: marketDeps(pages, draft, { judge: testSupportJudge, ...extra }) as any, ...o } as any) as Promise<any>;
const enf = (reply: string, r: any, o: { ask?: string; judge?: SupportJudge } = {}) => enforceMarketReplySupported(reply, r, [], { judge: o.judge ?? testSupportJudge, ask: o.ask ?? ASK });
// The answer above its source list, sentence by sentence, without the [n] markers.
// Architect amendment (owner decision 2026-11-13: research support check switched on): a page's own sentence is shown in quotation
// marks; a sentence is read without them (and without the "From <host>:" that names a lent quote's page), so every check below on
// "a page sentence, word for word" still reads exactly the page's words.
const bodyOf = (reply: string) => reply.split(/\n\n\[1\] /)[0];
const unquote = (s: string) => s.replace(/^(?:From citadel\.example: )?"([^"]+)"\.?$/, "$1");
const sentencesOf = (reply: string) => bodyOf(reply).split(/(?<=[.!?]["]?(?:\s*\[\d+\])*\.?)\s+/).map((s) => unquote(s.replace(/\s*\[\d+\]/g, "").replace(/\s+([.,])/g, "$1").trim())).filter(Boolean);
// Every sentence that carries a number is a sentence of a page read, word for word.
const figuresVerbatim = (reply: string, pages: Page[]) => { for (const s of sentencesOf(reply)) if (/\d/.test(s)) ok(pages.some((p) => p.text.includes(s.replace(/[.]$/, ""))), `not a page sentence: ${s}\n${reply}`); };
// Never blank: verified lines with their source, or the could-not-confirm sentence with the pages checked.
const neverBlank = (reply: string, r: any) => ok(reply.trim() && reply.includes(URL1) && (r.status === "ok" || /couldn't confirm/.test(reply)), reply);
const CLAIM = "Citadel interns earn $5,000 a week";

Deno.test("item 1 (A): a figure whose page sentence denies it, or says it of someone else, is never shown in the model's words", async () => {
  for (const text of ["Citadel interns do not earn $5,000 a week.", "Unlike interns, senior traders at Citadel earn $5,000 a week.", "Citadel interns never earn $5,000 a week.", "It is false that Citadel interns earn $5,000 a week in pay."]) {
    // As a condition (Trainee's reading, no quote) and as a quoted summary fact.
    // Architect amendment (owner decision 2026-11-13: research support check switched on): per the page truth, none of these pages
    // states the claim (a denial, a "never", "it is false that", the figure of senior traders): the judge says no to it, as the real
    // judge is told to; the word-list test judge cannot read "false" or "unlike interns".
    const judge = truthJudge({ notStated: [CLAIM] });
    for (const draft of [{ summary: [], conditions: [{ text: `${CLAIM}.`, urls: [URL1] }], risks: [] }, { summary: [{ text: `${CLAIM}.`, quote: "$5,000 a week", url: URL1 }], conditions: [], risks: [] }]) {
      const r = await run(page(text), draft, {}, { judge });
      ok(!(r.answerable ?? []).includes(`${CLAIM}.`) && !(r.points ?? []).some((p: any) => p.text === `${CLAIM}.`), `${text}: ${JSON.stringify([r.answerable, r.points])}`);
      for (const reply of ["", `${CLAIM} [1].`, `Good news: ${CLAIM} [1].`]) {
        const a = await enf(reply, r, { judge });
        ok(!sentencesOf(a).some((s) => /5,000/.test(s) && s.replace(/[.]$/, "") !== text.replace(/[.]$/, "")), `${text} / ${reply} ->\n${a}`);
        figuresVerbatim(a, page(text)); neverBlank(a, r);
      }
    }
  }
  // The page's own sentence is what the person reads when the model picked it: verbatim, with its source number.
  const r = await run(page("Citadel interns do not earn $5,000 a week."), { summary: [{ text: `${CLAIM}.`, quote: "$5,000 a week", url: URL1 }], conditions: [], risks: [] });
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the page's own sentence is shown in quotation
  // marks, word for word, with its source number; the model's reading still never stands.
  eq([r.status, r.points.map((p: any) => p.text)], ["ok", ['"Citadel interns do not earn $5,000 a week."']]);
  const a1 = await enf(`${CLAIM} [1].`, r);
  ok(a1.startsWith('"Citadel interns do not earn $5,000 a week." [1].') && !a1.includes(`${CLAIM} [1]`), a1);
});

Deno.test("item 1 (A): a model-worded line with no number does not stand on a sentence of the other polarity", async () => {
  const text = "Citadel does not sponsor visas for interns in the summer program.", claim = "Citadel sponsors visas for interns in the summer program.";
  const r = await run(page(text), { summary: [], conditions: [{ text: claim, urls: [URL1] }], risks: [] }, { ask: "does citadel sponsor visas for interns", question: "Citadel intern visa sponsorship" });
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the model's reading never stands; what
  // stands in its place is the page's own sentence (the denial), word for word in quotation marks.
  eq(r.answerable ?? [], ['"Citadel does not sponsor visas for interns in the summer program."']);
  for (const reply of ["", `${claim.replace(/\.$/, "")} [1].`]) { const a = await enf(reply, r, { ask: "does citadel sponsor visas for interns" }); ok(!a.includes("Citadel sponsors visas"), a); neverBlank(a, r); }
  // The same polarity on both sides stands as before.
  const same = "Citadel sponsors visas for interns in the summer program.";
  const r2 = await run(page(same), { summary: [], conditions: [{ text: same, urls: [URL1] }], risks: [] }, { ask: "does citadel sponsor visas for interns", question: "Citadel intern visa sponsorship" });
  // Architect amendment (owner decision 2026-11-13: research support check switched on): a line that only repeats its page's sentence
  // is that sentence, shown in quotation marks.
  eq(r2.answerable, [`"${same}"`]);
});

Deno.test("item 3 (B): a reply sentence cannot move a kept figure onto someone else; the kept page sentence is given instead", async () => {
  const kept = "Senior traders at Citadel received a signing bonus of $5,000.";
  const r = await run(page(kept), { summary: [{ text: kept, quote: kept, url: URL1 }], conditions: [], risks: [] }, { ask: "what does citadel pay", question: "Citadel pay" });
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the kept line is its page's sentence, shown in
  // quotation marks (sentencesOf reads it without them, so the reply checks below still pin exactly the page's words, once).
  eq(r.points.map((p: any) => p.text), [`"${kept}"`]);
  for (const reply of [`${CLAIM} [1].`, `Interns at Citadel get a signing bonus of $5,000 [1].`, `Citadel software engineers received a signing bonus of $5,000 [1].`]) {
    const a = await enf(reply, r, { ask: "what does citadel pay" });
    eq(sentencesOf(a).filter((s) => /\d/.test(s)), [kept], `${reply} ->\n${a}`);
    ok(a.startsWith(`"${kept}" [1].`) && a.includes(URL1), a);
  }
  // The kept sentence, said as it is, stands once (it is not added again).
  const a = await enf("Senior traders at Citadel received a signing bonus of $5,000 [1].", r, { ask: "what does citadel pay" });
  eq(a.split(kept.replace(/\.$/, "")).length - 1, 1, a);
});

Deno.test("item 2 (C): the brief's thesis is a verified line, never the model's unverified headline, and never what the File lists as not confirmed", async () => {
  const pages = page("Citadel interns earn $5,000 a week. The relocation stipend is $9,000 for interns at Citadel.");
  const bad = "Citadel interns earn $9,000 a week.";
  const draft = (thesis: string) => ({ title: "Citadel intern pay", thesis, summary: [{ text: "Citadel interns earn $5,000 a week.", quote: "Citadel interns earn $5,000 a week.", url: URL1 }],
    conditions: [{ text: bad, urls: [URL1] }], risks: [{ text: "The relocation stipend is $9,000 for interns at Citadel.", urls: [URL1] }] });
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the unconfirmed condition is no longer
  // listed as "not confirmed": no page sentence holds it, so it is dropped, and with no condition left a full brief cannot honestly be
  // made (market.ts): the drafted turn is answered inline, its thesis a page sentence, "$9,000 a week" nowhere. The File rules below
  // are then read on the same page with one more sentence of its own that the draft gives as a condition, so a File is made.
  const STAYS = "The internship at Citadel lasts ten weeks in Chicago.";
  const pages2 = page(`${pages[0].text} ${STAYS}`);
  const draft2 = (thesis: string) => { const d = draft(thesis); return { ...d, conditions: [...d.conditions, { text: STAYS, urls: [URL1] }] }; };
  const unq = (t: string) => String(t ?? "").replace(/^"(.*)"$/s, "$1");
  // The model's headline as the reviewer found it, and the same claim with its figure taken out (still what the File lists as not confirmed).
  for (const thesis of [bad, "Citadel interns earn the stipend every week."]) {
    const none: any[] = [];
    const r0 = await run(pages, draft(thesis), { format: "file" }, { publish: async (d: unknown) => { none.push(d); return { url: "https://trainee.example/file?t=v1.c" }; } });
    eq([r0.status, r0.format, none.length, r0.notes], ["ok", "inline", 0, ["answered inline: the sources did not support a full brief"]]);
    ok(r0.thesis !== thesis && pages[0].text.includes(unq(r0.thesis)) && r0.thesis_cite?.length === 1, `the thesis is a page sentence with its source: ${r0.thesis}`);
    ok(!/9,000 a week|every week/.test(JSON.stringify([r0.thesis, r0.points, r0.conditions, r0.risks, r0.answerable])), JSON.stringify(r0.conditions));
    ok(!/9,000 a week|every week/.test(await enf(thesis, r0)) && !/9,000 a week/.test(await enf("", r0)));
    const published: any[] = [];
    const r = await run(pages2, draft2(thesis), { format: "file" }, { publish: async (d: unknown) => { published.push(d); return { url: "https://trainee.example/file?t=v1.c" }; } });
    eq([r.status, r.format, published.length], ["ok", "file", 1]);
    const d = published[0];
    ok(d.thesis !== thesis && r.thesis === d.thesis, `the model's headline is not the cover: ${d.thesis}`);
    // Architect amendment (owner decision 2026-11-13: research support check switched on): the cover is the page's sentence in
    // quotation marks, word for word, with its one source.
    ok(/^".+"$/.test(d.thesis) && pages2[0].text.includes(unq(d.thesis)) && Array.isArray(d.thesis_cite) && d.thesis_cite.length === 1 && !d.thesis_summary, `a page sentence with its source: ${JSON.stringify([d.thesis, d.thesis_cite, d.thesis_summary])}`);
    // Architect amendment (owner decision 2026-11-13: research support check switched on): what no page sentence holds is dropped, not
    // listed as not confirmed: nothing is marked unconfirmed, and "$9,000 a week" is written nowhere in the File (it was written once,
    // under its own label).
    const unconfirmed = [...d.conditions, ...d.risks].filter((x: any) => x.unconfirmed).map((x: any) => x.text);
    eq(unconfirmed, []);
    const v: any = validateKind("research_brief", d, { now: NOW });
    ok(v.ok, JSON.stringify(v));
    const rec = { id: "f1", userId: "u", kind: "research_brief", data: v.data, state: {}, tag: null, created_at: NOW, expires_at: NOW + 3600_000, revoked_at: null } as any;
    const h = bodyHtml(rec, "fs1." + "a".repeat(64));
    eq(h.split("$9,000 a week").length - 1, 0, "the unconfirmed claim is written nowhere, never on the cover");
    ok(!/class="rb-thesis">[^<]*9,000 a week/.test(h) && !textOf(rec, { now: NOW }).includes("$9,000 a week"));
    // The chat reply on a File turn: the model's headline does not stand there either.
    // Architect amendment (owner decision 2026-11-13: research support check switched on): through the awaited form, with the judge.
    ok(!/9,000 a week|every week/.test(await enf(thesis, r)) && !/9,000 a week/.test(await enf("", r)));
  }
  // A thesis a page sentence says stands as that sentence, cited.
  // Architect amendment (owner decision 2026-11-13: research support check switched on): on the page with a condition it states (above),
  // and shown as the page's sentence in quotation marks.
  const published: any[] = [];
  await run(pages2, draft2("Citadel interns earn $5,000 a week."), { format: "file" }, { publish: async (d: unknown) => { published.push(d); return { url: "https://trainee.example/file?t=v1.c" }; } });
  eq([published[0].thesis, published[0].thesis_cite], ['"Citadel interns earn $5,000 a week."', [1]]);
});

Deno.test("item 7 (D): a page's pay sentence is about the role asked by its own words, never by the page title", async () => {
  const title = "Software Engineer Intern - Citadel";
  const trader = "Quantitative traders earn a base salary of $350,000 in their first year at Citadel.";
  ok(!aboutAsked(trader, title, ASK), "a sentence that names another kind of work is not about the role in the title");
  const pages = page(`${trader} The summer program at Citadel runs for eleven weeks in Chicago.`, title);
  const r = await run(pages, {});
  // Architect amendment (owner decision 2026-11-13: research support check switched on): every reply below is enforced through the
  // awaited form with the judge.
  const a = await enf("", r);
  ok(!/350,000/.test(a) && !/350,000/.test(JSON.stringify(r.points ?? [])), a);
  neverBlank(a, r);
  // The title alone does not make a role-less pay sentence the intern's pay.
  const r2 = await run(page("The base salary for this position is $350,000 a year at Citadel. Citadel hires across many teams every year.", title), {});
  const a2 = await enf("", r2);
  ok(!/350,000/.test(a2), a2);
  // The sentence itself, or the one right before it on the page, names the role and level: it answers.
  const own = "Software engineering interns at Citadel earn $120 an hour.";
  const r3 = await run(page(`Citadel hires across many teams every year. ${own}`, "Citadel careers"), {});
  const a3 = await enf("", r3);
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the page's own sentence, in quotation marks.
  ok(a3.includes('"Software engineering interns at Citadel earn $120 an hour." [1].'), a3);
  const r4 = await run(page("Software engineering interns join Citadel each June. The base salary for this position is $120 an hour at Citadel.", "Citadel careers"), {});
  const a4 = await enf("", r4);
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the page's own sentence, in quotation marks.
  ok(a4.includes('"The base salary for this position is $120 an hour at Citadel." [1].'), a4);
});

const SENIOR = page("Senior traders at Citadel earn a base salary of $350,000.");
const UNSAID = { summary: [{ text: "Citadel interns earn $350,000.", quote: "earn a base salary of $350,000", url: URL1 }], conditions: [{ text: "Citadel interns earn $350,000 a year.", urls: [URL1] }], risks: [] };
const LISTED = "[1] Citadel compensation notes: https://citadel.example/pay (read Nov 13, 2026)";
Deno.test("item 5 (E): nothing verified: one sentence that only says so, then the pages checked; no other sentence of the model's", async () => {
  // Architect amendment (owner decision 2026-11-13: research support check switched on): per the page truth, the senior traders' salary
  // does not answer what interns earn, so the judge does not let that page sentence stand for the question (as the real judge is
  // told to); nothing is verified.
  const judge = truthJudge({ notQuoted: ["Senior traders at Citadel earn a base salary of $350,000."] });
  const r = await run(SENIOR, UNSAID, {}, { judge });
  eq(r.status, "no_sources");
  for (const reply of [
    "I couldn't confirm the exact figure, and Citadel interns are the best paid in the industry.",
    "I can't share links here.",
    "I can't share links here. Citadel interns are the best paid in the industry.",
    "Citadel interns are the best paid in the industry and I couldn't confirm the exact figure.",
    "I couldn't confirm the figure; interns there are paid extremely well.",
    "I don't have time for this.",
  // Architect amendment (owner decision 2026-11-13: research support check switched on): every reply is enforced through the awaited
  // form with the judge; the expectation is unchanged.
  ]) eq(await enf(reply, r, { judge }), `${NOT_CONFIRMED}\n\n${LISTED}`, reply);
  // The model's own sentence stands when that is all it says; a second sentence never rides along.
  // Architect amendment (owner decision 2026-11-13: research support check switched on): a could-not-confirm sentence stands unjudged
  // only in its closed form ("I couldn't confirm it."); one in any other words is code's could-not-confirm line instead. Either way
  // nothing else of the model's rides along, and the pages checked follow.
  const own = "I couldn't confirm it.";
  eq(await enf(own, r, { judge }), `${own}\n\n${LISTED}`);
  eq(await enf(`${own} Citadel is known for high pay. I also couldn't verify the bonus.`, r, { judge }), `${own}\n\n${LISTED}`);
  const worded = "I looked for Citadel's intern pay and couldn't confirm it from the pages I read.";
  eq(await enf(worded, r, { judge }), `${NOT_CONFIRMED}\n\n${LISTED}`);
  eq(await enf(`${worded} Citadel is known for high pay. I also couldn't verify the bonus.`, r, { judge }), `${NOT_CONFIRMED}\n\n${LISTED}`);
});

Deno.test("item 6 (F): the reply came back unfinished and research kept lines: the person gets those lines with their sources", async () => {
  const kept = "Software engineering interns at Citadel earn $120 an hour.";
  const pages = page(`${kept} The summer program at Citadel runs for eleven weeks in Chicago.`, "Citadel careers");
  const draft = { summary: [{ text: kept, quote: kept, url: URL1 }], conditions: [], risks: [] };
  let step = 0;
  // The model's final text is cut off every time (max_tokens with nothing usable): the loop ends the turn as incomplete_reply.
  const model = async (p: any) => !p.tools?.length ? { content: [{ type: "text", text: "" }], stop_reason: "end_turn" } : (++step === 1
    ? { content: [{ type: "tool_use", id: "m1", name: "research_market", input: { question: "Citadel software engineer intern pay", format: "inline", queries: ["citadel intern pay"], companies: ["Citadel"] } }], stop_reason: "tool_use" }
    : { content: [{ type: "text", text: "Citadel interns earn $9,999 a week, the most of any firm." }], stop_reason: "end_turn" });
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the brain's research gets its judge.
  const t: any = await agentTurn({ message: ASK, history: [], stores: { profile: {} }, userId: "u1", threadId: "t1", now: NOW, model, market: marketDeps(pages, draft, { judge: testSupportJudge }) } as any);
  eq(t.stopped, "incomplete_reply", `the scripted turn must end unfinished for this test to mean anything: ${t.reply}`);
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the kept line is the page's own sentence, in
  // quotation marks, with its source.
  ok(t.reply !== INCOMPLETE_REPLY && t.reply.includes('"Software engineering interns at Citadel earn $120 an hour." [1].') && t.reply.includes(URL1) && !/9,999/.test(t.reply), t.reply);
});

Deno.test("item 4 (G): a place is never taken from another line, the person's own city, or a remote role's head office", () => {
  const places = (content: string) => shownPayPlaces("what's the pay", [{ role: "assistant", content }] as any).map((x) => [x.text, x.place]);
  // (a) the only place in the paragraph is another employer's.
  eq(places("Stripe SWE Intern, Chicago, IL: no pay listed.\nPayPal SWE Intern: pay is $28-$49 hourly.\nhttps://jobs.example/paypal"), [["PayPal SWE Intern: pay is $28-$49 hourly.", null]]);
  // (b) the place in the sentence is where the person lives.
  eq(places("Since you live in Madison, Wisconsin, the PayPal pay is $40 hourly for the role in San Jose.\nhttps://jobs.example/paypal").map((x) => x[1]), [null]);
  // (c) a remote role: the head office is not where the pay applies.
  eq(places("PayPal SWE Intern (Remote)\nHQ: San Jose, CA\nThe pay is $40 hourly.\nhttps://jobs.example/paypal").map((x) => x[1]), [null]);
  eq(places("PayPal SWE Intern, remote. Head office in San Jose, CA: pay is $40 hourly.\nhttps://jobs.example/paypal").map((x) => x[1]).includes("San Jose, CA"), false);
});

Deno.test("item 4 (G): one posting read this turn: a sentence about another employer or the person's own job gets no place", () => {
  const paypal = { company: "PayPal", title: "SWE Intern", pay: "$40/hr", url: "https://jobs.example/paypal", place: "Chicago, IL" };
  for (const said of ["IBM pays $40/hr.", "Your current job pays $40 an hour.", "My last job paid $40/hr.", "NVIDIA and AMD pay $40/hr.", "At your internship you earn $40/hr."])
    eq(payWithSource(said, [paypal]).split("\n")[0], said, said);
  // The posting's own sentence still carries its place.
  // Architect amendment (owner decision 2026-11-13: research support check switched on): no place is written into a sentence of the
  // model's; the posting's place goes on its own link line, with its employer and title, all from that one posting's record.
  eq(payWithSource("PayPal pays $40/hr.", [paypal]), "PayPal pays $40/hr.\n\nPayPal, SWE Intern (Chicago, IL): https://jobs.example/paypal");
  eq(payWithSource("The PayPal SWE Intern role pays $40/hr.", [paypal]), "The PayPal SWE Intern role pays $40/hr.\n\nPayPal, SWE Intern (Chicago, IL): https://jobs.example/paypal");
  // The record says several places, or remote with an office: no one place is the pay's.
  // Architect amendment (owner decision 2026-11-13: research support check switched on): nor on the link line: the link alone.
  for (const place of ["San Jose, CA; Austin, TX", "Remote - US or San Jose, CA", "Chicago, IL / New York, NY", "Multiple locations"])
    eq(payWithSource("PayPal pays $40/hr.", [{ ...paypal, place }]), "PayPal pays $40/hr.\n\nhttps://jobs.example/paypal", place);
});

Deno.test("item 8: ARCHITECTURE names where the fixed failure sentences live", async () => {
  const doc = await Deno.readTextFile(new URL("../../docs/architect/ARCHITECTURE.md", import.meta.url));
  const line = doc.split("\n").find((l) => l.startsWith("- No canned prose.")) ?? "";
  ok(/loop\.ts/.test(line) && /research_reply\.ts/.test(line) && /research\/company\.ts/.test(line), line);
});
