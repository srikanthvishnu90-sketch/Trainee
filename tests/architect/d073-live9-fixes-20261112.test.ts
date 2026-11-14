// D-073 (architect, 2026-11-12): the fixes for live-9 (PR #796: batch 1 on trunk 671ba1b7, 4/23 scored turns pass wa-1/d066; CI run
// 43272797730) and the item 10 real-set research re-run on the same trunk (run 43272687366, PASS 15/20: Datadog, Affirm and Toast
// kept only the frame and gave no brief; Stripe and Plaid kept a line under 60% of its words on its cited pages). Each test replays
// what the live runs recorded (the live-9 transcript and its research audits, the real-set recordings and their per-case audits, the
// mirror's Citadel pages) at $0 with a scripted model returning the observed shape. No network, no spend, nothing sent.
//   D73-1  RESEARCH KEPT, NEVER THROWN AWAY (C9 kept 5 and C22 kept 4, both no_sources; item 10 Datadog, Affirm, Toast kept the frame
//          only): every kept, cited line counts; the reply is built from the kept lines when the model's says nothing; the pages' own
//          sentences fill a part the kept lines leave out; C9 answers pay, process and culture each with its source link; the audit
//          records each kept line's section.
//   D73-2  "claim words not in quote" (201 of 416): an inflection, a hyphen, an abbreviation or a small count written as a word is the
//          same word; a changed claim is still dropped; the eval run keeps each dropped line's text and reason (never production);
//          a line under 60% of its words on its pages (item 10 Stripe, Plaid) is never kept.
//   D73-3  C1: a label over 80 characters is put right (its words move into the fact's text); a refused create_file is asked again
//          once with its exact error, even when the turn's other asks were spent.
//   D73-4  C1, C3: the places the person joined with "or" are searched each, though the model's query collapsed them.
//   D73-5  LENGTH (12/23 far over): each shortening pass is given the kind's number and what must stay (figures, caveats).
//   D73-6  C9: the pay restated from an earlier reply carries its place, on the research path too.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/d073-live9-fixes-20261112.test.ts
import assertNode from "node:assert/strict";
import { CareerRouter } from "../../supabase/functions/_shared/router_core.career.js";
import { agentTurn, keepList, payWithSource, shortenedOk } from "../../supabase/functions/agent-chat/career_brain.ts";
import { abbreviated, askedParts, checkLine, enforceMarketReply, ON_PAGES_SHARE, researchMarket, wordsNotInQuote, wordsOnPages } from "../../supabase/functions/_shared/agent/research/market.ts";
import { enforceCompanyReply, researchCompany } from "../../supabase/functions/_shared/agent/research/company.ts";
import { overLimit, replyLength, shownPayPlaces, textLength } from "../../supabase/functions/_shared/agent/turn_notes.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { coerceShape, createFileTool, LABEL_MAX } from "../../supabase/functions/_shared/agent/file_tool.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { REFUSED_FILE_TODO, runAgentTurn } from "../../supabase/functions/_shared/agent/loop.ts";
import { orAlternatives, placeAlternatives } from "../../supabase/functions/_shared/career_search.ts";
import { normalizeUrl } from "../../supabase/functions/_shared/research_sources.ts";
import { lengthFarOver } from "../../evals/mirror/score-conversation.ts";
import { POSTINGS } from "../../evals/mirror/instinct-wa-batch1/world.ts";
import { C9_Q, WEB } from "./helpers/mirror_wa_script.ts";
import { testSupportJudge } from "./support-test-judge.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const DIR = new URL("../../evals/mirror/instinct-wa-batch1/", import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, DIR)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const P: Record<string, string> = Object.fromEntries(read("prompts.jsonl").map((t: any) => [t.id, t.prompt]));
const PERSONA = JSON.parse(Deno.readTextFileSync(new URL("persona.json", DIR)));
// live-9's own turns (the transcript the run recorded, PR #796): replies, traces and research audits.
const LIVE9: Record<string, any> = Object.fromEntries(read("results/live-9/trainee-live-9.jsonl").map((t: any) => [t.id, t]));
// The item 10 live re-run on the same trunk (run 43272687366): the per-case ResearchAudit.
const REAL = JSON.parse(Deno.readTextFileSync(new URL("../../evals/real-sets/research/results/live-43272687366/results.json", import.meta.url)));
const AUDIT: Record<string, any> = Object.fromEntries(REAL.scored.map((x: any) => [x.company, x]));
const NOW = Date.parse("2026-11-12T03:00:00Z");
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const use = (name: string, input: unknown, id = "t1") => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
type Payload = { system: string; messages: any[]; tools: any[] };
function scripted(brain: (p: Payload, n: number) => any, plain: (p: Payload) => string = () => "") {
  const seen: Payload[] = [];
  let n = 0;
  const model = async (p: any) => { seen.push(p); return p.tools?.length ? brain(p, n++) : text(plain(p)); };
  return { model, seen };
}
function personaProfile() {
  const ctx: any = { now: NOW, thread: {} };
  for (const s of PERSONA.setup.slice(0, 2)) CareerRouter.handleChat(s, ctx);
  return ctx.profile;
}
const turn = (message: string, model: any, extra: Record<string, unknown> = {}) =>
  agentTurn({ message, history: [], stores: { profile: personaProfile() }, userId: "u-d073", threadId: "th-d073", now: NOW, model, ...extra } as any);
const readTool = { name: "get_situation_test", effect: "read", description: "read (test)", input_schema: { type: "object", properties: {} }, run: async () => ({ ok: true }) };
const marketDeps = (pages: { url: string; title: string; text: string }[], draft: () => string, extra: Record<string, unknown> = {}) => ({
  search: { id: "t", needsKey: false, search: async () => ({ hits: pages.map((p) => ({ url: p.url, title: p.title, provider: "t", foundAt: NOW })), notes: [], provider: "t" }) },
  read: async () => ({ verified: pages.map((p) => ({ url: p.url, requested: p.url, status: 200, title: p.title, text: p.text, fetchedAt: NOW })), rejected: [] }),
  // Architect amendment (owner decision 2026-11-13: research support check switched on): research needs its judge to keep a line
  // (the deterministic test judge, support-test-judge.ts), in researchMarket and in the brain's research_market alike.
  draft: async () => draft(), layout: "messages" as const, judge: testSupportJudge, ...extra,
});
// Architect amendment (owner decision 2026-11-13: research support check switched on): a Citadel page sentence that does not name
// Citadel ("The base salary range for this role is ...") speaks for Citadel only on a page code knows is Citadel's own, by its
// domain on record (the plan's sites, as the brain passes them); the Citadel research of this file gives it.
const CITADEL_SITES = ["citadel.com"];
// The real-set "cited" check, written out independently of the product (evals/real-sets/research/run.ts scoreLive): every figure of a
// kept line on its cited pages, and at least 60% of its words (four letters or more, by their first five) on them.
function evalCited(line: string, pages: string[]): boolean {
  const flat = (t: string) => String(t ?? "").replace(/\s+/g, " ").toLowerCase();
  const hay = flat(pages.join(" ")).replace(/,/g, "");
  const figs = (String(flat(line)).match(/\d[\d,.]*\d|\d/g) ?? []).map((x) => x.replace(/,/g, "").replace(/\.$/, "")).filter((x) => x.length >= 2);
  const ws = [...new Set((flat(line).match(/[a-z]{4,}/g) ?? []).map((w) => w.slice(0, 5)))];
  return figs.every((f) => hay.includes(f)) && (!ws.length || ws.filter((w) => hay.includes(w)).length / ws.length >= 0.6);
}

// ---------------------------------------------------------------- D73-1 research kept, never thrown away
const CITADEL = Object.entries(WEB).slice(0, 4).map(([url, p]) => ({ url, title: p.title, text: p.text }));
const [POSTING, PROCESS, REDDIT, SECURITIES] = CITADEL.map((p) => p.url);
// live-9 C9's audit (pages 8, drafted 10, kept 5, dropped: claim words not in quote 4, figure not in quote 1; status no_sources),
// replayed in shape on the Citadel pages (the run log keeps no page text): the five summary lines are dropped as live (four worded
// past their quotes, one with a figure its quote lacks) and the five kept lines are conditions and risks naming their pages.
const C9_DRAFT = JSON.stringify({ title: "Citadel new grad SWE", thesis: "Citadel pays well and runs a long process.", summary: [
  { text: "Citadel pays new grads generously, with a large signing bonus.", quote: "The base salary range for this role is $235,000 to $300,000, plus a discretionary bonus.", url: POSTING },
  { text: "Citadel's interview loop is fast and mostly behavioral.", quote: "At Citadel, the overall process takes roughly eight weeks from start to finish.", url: PROCESS },
  { text: "Engineers at Citadel enjoy a relaxed, balanced culture.", quote: "Anonymous posters describe demanding hours and performance pressure at Citadel.", url: REDDIT },
  { text: "Citadel Securities shares its engineering teams and offices with Citadel.", quote: "Citadel Securities is a market maker, a separate firm from Citadel.", url: SECURITIES },
  { text: "Citadel's base salary for new grads is $400,000.", quote: "The base salary range for this role is $235,000 to $300,000, plus a discretionary bonus.", url: POSTING },
], conditions: [
  { text: "The base salary range for this role is $235,000 to $300,000, plus a discretionary bonus.", urls: [POSTING] },
  { text: "The overall process takes roughly eight weeks from start to finish.", urls: [PROCESS] },
  { text: "Citadel Securities is a separate firm from Citadel.", urls: [SECURITIES] },
], risks: [
  { text: "Anonymous posters describe demanding hours and performance pressure at Citadel.", urls: [REDDIT] },
  { text: "Demanding hours and performance pressure at Citadel.", urls: [REDDIT] },
] });
const C9_PLAN = LIVE9.C9.trace.args[0].args;
Deno.test("D73-1 RESEARCH (C9, C22, item 10 Datadog/Affirm/Toast): every kept line counts; the reply is built from them; each asked part gets its sourced line", async () => {
  // What live-9 recorded: lines were kept and the result still said no_sources.
  eq([LIVE9.C9.trace.research.kept, LIVE9.C9.trace.research.drafted, LIVE9.C9.trace.research.status], [5, 10, "no_sources"]);
  eq([LIVE9.C22.trace.research.kept, LIVE9.C22.trace.research.drafted, LIVE9.C22.trace.research.status], [4, 7, "no_sources"]);
  ok(/couldn't confirm anything on Citadel/.test(LIVE9.C9.reply) && !LIVE9.C9.reply.includes("citadel.com"), "live-9 C9: no Citadel content, no Citadel link");
  for (const co of ["Datadog", "Affirm", "Toast"]) eq([AUDIT[co].status, AUDIT[co].research.kept, AUDIT[co].checks.brief], ["no_sources", 1, false], `${co} live`);

  // C9 replayed: the same audit shape, now an answer.
  const r: any = await researchMarket({ question: C9_Q, format: "inline", plan: { queries: C9_PLAN.queries, companies: C9_PLAN.companies, sites: CITADEL_SITES }, deps: marketDeps(CITADEL, () => C9_DRAFT) as any });
  eq(r.status, "ok");
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the five summary lines worded past their
  // quotes (four) or with a figure the quote lacks (one) are no longer dropped: none stands in the model's words; each is shown as
  // its page's own sentence in quotation marks (the support path), so no line of them is lost and none of their wording is kept.
  eq([r.audit.drafted, r.audit.dropped], [10, {}], "the live drop shape, on the support path: every summary line given as its page's sentence");
  ok(r.audit.from_quote >= 5 && r.points.every((p: any) => /^(?:From [^:"]+: )?".*"$/s.test(p.text)), JSON.stringify(r.points));
  ok(!/\$400,000|signing bonus|relaxed|loop is fast|shares its engineering/.test(JSON.stringify([r.points, r.conditions, r.risks])), "no mis-worded claim is kept");
  ok(r.audit.kept >= 5, JSON.stringify(r.audit));
  eq(r.audit.sections.conditions + r.audit.sections.risks, 5, `each kept line's section: ${JSON.stringify(r.audit.sections)}`);
  eq(r.parts.map((p: any) => p.label), ["pay", "interview process", "culture"]);
  // Through the turn, with the reply the model gave live ("I couldn't confirm anything on Citadel ..."): pay, process and culture
  // each answered from a kept line, each with its source link on its own line.
  const s = scripted((_p, n) => n === 0 ? use("research_market", { question: C9_Q, format: "inline", ...C9_PLAN, sites: CITADEL_SITES }) : text(LIVE9.C9.reply));
  const t: any = await agentTurn({ message: P.C9, history: [], stores: { profile: personaProfile() }, userId: "u-d073", threadId: "th-d073", now: NOW, model: s.model, market: marketDeps(CITADEL, () => C9_DRAFT) } as any);
  const paras = t.reply.split(/\n\s*\n/);
  const partOf = (re: RegExp, url: string) => paras.find((x: string) => re.test(x) && x.includes(url));
  ok(partOf(/\$235,000 to \$300,000/, POSTING), `pay with its source:\n${t.reply}`);
  ok(partOf(/eight weeks/, PROCESS), `process with its source:\n${t.reply}`);
  ok(partOf(/demanding hours/i, REDDIT), `culture with its source:\n${t.reply}`);
  ok(!/\$400,000|signing bonus|relaxed/.test(t.reply), "no dropped claim reaches the person");
  eq(t.research.status, "ok");
  eq(t.research.sections.conditions + t.research.sections.risks, 5);

  // A model reply that answers one part gets the other parts' kept lines after it, each with its source.
  const one = enforceMarketReply(`Pay: the base salary range is $235,000 to $300,000 [${r.sources.find((x: any) => x.url === POSTING).n}].`, r);
  ok(one.includes(PROCESS) && one.includes(REDDIT) && one.includes(POSTING), one);

  // C22 replayed (kept 4: readings on the two self-reported pay pages; 3 summary lines dropped as live): an answer, each line labelled
  // as self-reported and carrying its source link.
  const pay = Object.entries(WEB).slice(4, 6).map(([url, p]) => ({ url, title: p.title, text: p.text }));
  const C22_DRAFT = JSON.stringify({ title: "Chicago SWE intern pay", summary: [
    { text: "Chicago SWE interns typically earn about $40 an hour.", quote: "Relativity software engineer interns in Chicago report $32 per hour.", url: pay[0].url },
    { text: "Chicago interns at trading firms are paid the most.", quote: "CME Group software engineer interns in Chicago report $34 per hour.", url: pay[1].url },
    { text: "CME Group pays its interns generously in Chicago.", quote: "CME Group software engineer interns in Chicago report $34 per hour.", url: pay[1].url },
  ], conditions: [{ text: "Relativity software engineer interns in Chicago report $32 per hour.", urls: [pay[0].url] }, { text: "CME Group software engineer interns in Chicago report $34 per hour.", urls: [pay[1].url] }],
  risks: [{ text: "Software engineer interns in Chicago report hourly pay.", urls: [pay[0].url, pay[1].url] }, { text: "Interns report pay in Chicago.", urls: [pay[0].url] }] });
  const q22 = LIVE9.C22.trace.args[0].args;
  const r22: any = await researchMarket({ question: P.C22, format: "inline", plan: { queries: q22.queries }, deps: marketDeps(pay, () => C22_DRAFT) as any });
  eq([r22.status, r22.audit.kept >= 4, r22.audit.drafted], ["ok", true, 7]);
  const a22 = enforceMarketReply(LIVE9.C22.reply, r22);
  ok(/\$32 per hour/.test(a22) && a22.includes(pay[0].url) && /self-reported/.test(a22), a22);

  // Item 10 (Datadog, Affirm, Toast; kept 1 each, the frame): replayed on their recorded pages with the live shape (every fact worded
  // past its quote, a frame that stands). Now a brief: the pages' own sentences that name the company are its business lines, the
  // frame counts too, and every kept line passes the eval's own 60% check.
  for (const [id, co] of [["R06", "Datadog"], ["R09", "Affirm"], ["R14", "Toast"]]) {
    const rec = JSON.parse(Deno.readTextFileSync(new URL(`../../evals/real-sets/research/recorded/${id}.json`, import.meta.url)));
    const pages = (rec.read.verified as any[]).filter((v) => v.status === 200);
    const sentences = pages.flatMap((p) => String(p.text).split(/(?<=[.!?])\s+/).filter((x) => x.length > 40 && x.length < 300).map((x) => ({ x: x.trim(), url: p.url }))).slice(0, 13);
    const draft = JSON.stringify({ title: `${co} brief`, frame: { text: `${co} posts software engineering roles on its job board.`, urls: [pages[0].url] },
      business: sentences.map((s) => ({ text: `${co} heavily invests in groundbreaking proprietary innovation: ${s.x.slice(0, 60)}`, quote: s.x, url: s.url })) });
    const out: any = await researchCompany({ company: co, role: rec.case.role, question: `Research ${co} before my interview.`, plan: rec.plan, now: NOW, format: "inline",
      deps: { search: { id: "r", needsKey: false, search: async () => rec.search }, read: async () => rec.read, draft: async () => draft, judge: testSupportJudge } as any });
    const before = { ...out.audit.dropped };
    eq(out.status, "ok", `${co}: a brief (live: no_sources with the frame kept)`);
    // Architect amendment (owner decision 2026-11-13: research support check switched on): the support path records one drop reason,
    // "unsupported"; and the frame in the model's words ("<co> posts software engineering roles on its job board.") stands only when
    // one sentence of its page says it, which none of these pages does: it is dropped (frame_unsupported), never kept unsaid.
    ok(before.unsupported >= 1 && out.frame === null && before.frame_unsupported === 1 && out.audit.from_pages >= 1, `${co}: ${JSON.stringify(out.audit)}`);
    const byN = (n: number) => pages.find((p) => normalizeUrl(p.url) === normalizeUrl(out.sources.find((x: any) => x.n === n).url)).text;
    for (const l of [...(out.frame ? [out.frame] : []), ...out.business, ...out.questions]) ok(evalCited(l.text, l.cite.map(byN)), `${co}: "${l.text}" passes the eval's cited check`);
    ok(/\[\d\]/.test(enforceCompanyReply("", out)), `${co}: the chat answer cites its sources`);
  }
});

// ---------------------------------------------------------------- D73-2 claim words, the audit's samples, 60% on the pages
Deno.test("D73-2 'claim words not in quote' (201 of 416): only the form of a word is loosened; the eval run keeps each drop's text; a line under 60% on its pages is never kept", async () => {
  eq(REAL.scored.reduce((n: number, x: any) => n + (x.research.dropped.claim_words_not_in_quote ?? 0), 0), 201);
  ok(!JSON.stringify(REAL.scored).includes('"samples"'), "the live results kept no dropped line's text (the cause could not be read back)");
  const pg = (t: string) => ({ url: "https://acme.example/a", requested: "https://acme.example/a", status: 200, title: "Careers", text: t, fetchedAt: NOW } as any);
  const same: [string, string][] = [
    ["Acme runs 3 rounds of interviews.", "Acme runs three rounds of interviews."], // a count as a numeral or a word
    ["Acme hires full time engineers in the US.", "Acme hires full-time engineers in the U.S."], // a hyphen; an abbreviation
    ["Acme applied machine learning to fraud.", "Acme applies ML to fraud"], // an inflection; an abbreviation
    ["Acme is running an ecommerce platform.", "Acme runs an e-commerce platform"], // an inflection; a hyphen
    ["Acme builds AI tools for software engineers.", "Acme builds artificial intelligence tools for SWEs"],
  ];
  for (const [claim, quote] of same) { const c = checkLine(claim, quote, pg(`${quote}.`)); ok(c.ok, `${claim}: ${JSON.stringify(c)}`); }
  // Never a claim the page does not support: another object, another figure, a word the page lacks, "us" (a pronoun) as the US.
  eq(checkLine("Acme Energy installed 41,000 solar panels.", "Acme Energy installed 41,000 home batteries", pg("Acme Energy installed 41,000 home batteries in 2025.")).ok, false);
  eq(checkLine("Acme runs 4 rounds of interviews.", "Acme runs three rounds of interviews.", pg("Acme runs three rounds of interviews.")), { ok: false, why: "figure_not_in_quote" });
  eq(wordsNotInQuote("Acme operates in the US.", "Acme helps us grow", "Acme helps us grow."), ["operat", "usax"]);
  eq(abbreviated("help us"), "help us");
  // The eval run keeps each dropped line (text, quote, reason, section); production never asks for it, so no line text is logged.
  const draft = () => JSON.stringify({ summary: [{ text: "Citadel pays new grads generously.", quote: "The base salary range for this role is $235,000 to $300,000, plus a discretionary bonus.", url: POSTING }] });
  const withS: any = await researchMarket({ question: C9_Q, format: "inline", plan: { queries: ["Citadel pay"], companies: ["Citadel"] }, deps: marketDeps(CITADEL, draft, { auditSamples: true }) as any });
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the support path records one drop reason,
  // "unsupported" (no site on record here, so the posting's sentence, which does not name Citadel, cannot stand in for the line).
  eq(withS.audit.samples[0], { section: "summary", why: "unsupported", text: "Citadel pays new grads generously.", quote: "The base salary range for this role is $235,000 to $300,000, plus a discretionary bonus." });
  const without: any = await researchMarket({ question: C9_Q, format: "inline", plan: { queries: ["Citadel pay"], companies: ["Citadel"] }, deps: marketDeps(CITADEL, draft) as any });
  eq("samples" in without.audit, false);
  const runner = Deno.readTextFileSync(new URL("../../evals/real-sets/research/run.ts", import.meta.url));
  ok(/mode === "live"[\s\S]*auditSamples: true[\s\S]*\$0 replay/.test(runner), "the real-set live run asks for the samples");
  for (const f of ["../../supabase/functions/agent-chat/handler-career.ts", "../../supabase/functions/agent-chat/career_brain.ts"]) ok(!Deno.readTextFileSync(new URL(f, import.meta.url)).includes("auditSamples"), `${f}: production never keeps line text`);
  // Item 10 Stripe, Plaid (cited 18/20): the product keeps no line under 60% of its words on its cited pages.
  eq([AUDIT.Stripe.checks.cited, AUDIT.Plaid.checks.cited], [false, false]);
  const rec = JSON.parse(Deno.readTextFileSync(new URL("../../evals/real-sets/research/recorded/R01.json", import.meta.url)));
  const pages = (rec.read.verified as any[]).filter((v) => v.status === 200);
  const s0 = String(pages[1].text).split(/(?<=[.!?])\s+/).find((x) => x.length > 60 && /Stripe|risk/i.test(x))!.trim();
  const worded = "Stripe's moat is its relentless obsession with developer delight and craftsmanship.";
  ok(wordsOnPages(worded, pages) < ON_PAGES_SHARE && !evalCited(worded, pages.map((p) => p.text)), "the model-worded frame fails the eval's check");
  const out: any = await researchCompany({ company: "Stripe", role: rec.case.role, question: "Research Stripe before my interview.", plan: rec.plan, now: NOW, format: "inline",
    deps: { search: { id: "r", needsKey: false, search: async () => rec.search }, read: async () => rec.read, draft: async () => JSON.stringify({ frame: { text: worded, urls: [pages[0].url] }, business: [{ text: s0, quote: s0, url: pages[1].url }] }), judge: testSupportJudge } as any });
  eq(out.frame, null, "the frame under 60% is dropped");
  eq(out.audit.dropped.frame_unsupported, 1);
  // Architect amendment (owner decision 2026-11-13: research support check switched on): the line that is its page's sentence word
  // for word stands as that sentence, in quotation marks (with "From <host>, a page about Stripe: " when the page lends the name).
  ok(out.status === "ok" && out.business.some((b: any) => b.text === `"${s0}"` || b.text.endsWith(`: "${s0}"`)), JSON.stringify(out.business));
});

// ---------------------------------------------------------------- D73-3 create_file
const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-d073-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
Deno.test("D73-3 C1: a label over 80 characters is put right; a refused create_file is asked again once with its exact error", async () => {
  eq(LIVE9.C1.trace.call_errors.map((e: any) => e.error.split(".")[0]), ["not created: sections[0]"]);
  ok(/sections\[0\]\.items\[0\]\.label: is over 80 characters/.test(LIVE9.C1.trace.call_errors[0].error));
  eq(LIVE9.C1.trace.files, [], "live-9: no File");
  const files = createFileService({ store: memoryFileStore(), env: { get: (k: string) => ENV[k] }, now: () => NOW });
  const tool = createFileTool(files);
  const long = "Apply to PayPal's Software Engineer Intern - Summer 2027 posting in Chicago this week, before it closes on December 6";
  const data = { title: "SWE internship plan", variant: "pipeline", sections: [{ heading: "This week", items: [{ label: long, value: "PayPal, Chicago, IL.", source: "From the posting" }] }] };
  const fixed: any = coerceShape(data);
  const item = fixed.sections[0].items[0];
  ok(item.label.length <= LABEL_MAX && long.startsWith(item.label.replace(/…$/, "")) && item.label.endsWith("…"), item.label);
  eq(item.value, `${long}: PayPal, Chicago, IL.`, "every word the model wrote is still on the page");
  eq(coerceShape({ sections: [{ heading: "h", items: [{ label: "PayPal", value: "Apply.", source: "From you" }] }] }), { sections: [{ heading: "h", items: [{ label: "PayPal", value: "Apply.", source: "From you" }] }] }, "a short label is untouched");
  const ctx = () => ({ userId: "33333333-3333-4333-8333-333333333373", threadId: "t", now: NOW, state: {}, turn: { message: P.C1, added: [], fileLinks: [] as string[], guard: () => [] } });
  const c = ctx();
  const made: any = await tool.run({ kind: "plan_review", data }, c as any);
  ok(made.created && c.turn.fileLinks.length === 1, JSON.stringify(made));
  // A fact with no source is still refused.
  const bad = await tool.run({ kind: "plan_review", data: { title: "Plan", variant: "pipeline", sections: [{ heading: "h", items: [{ label: long, value: "Apply." }] }] } }, ctx() as any).then(() => "", (e) => String(e.message));
  ok(/source is missing/.test(bad), bad);
  // C1 replayed through the turn: search, then create_file with the long label: the File is made on that call.
  const s = scripted((_p, n) => [use("search_jobs", { query: LIVE9.C1.trace.args[0].args.query }), use("create_file", { kind: "plan_review", data }, "t2"), text("One posting came up; the plan is in the file. Nothing was sent.")][n] ?? text("ok"));
  const paypal = POSTINGS.filter((x) => x.company === "PayPal").map((x) => ({ job_id: x.id, company: x.company, title: x.title, location: x.location, url: x.url, description: x.description, first_seen_at: "2026-11-06T00:00:00Z" }));
  const r: any = await turn(P.C1, s.model, { files, postings: async () => paypal });
  eq(r.tool_calls.map((x: any) => [x.name, x.ok, x.error ?? null]), [["search_jobs", true, null], ["create_file", true, null]]);
  eq(r.fileLinks?.length, 1);
  // A refusal (here: a fact with no source) after the turn's two other asks were spent is still asked again, once, with its exact error.
  const todos = ["Do step A first.", "Now do step B."];
  let k = 0;
  const process = (_reply: string, calls: any[]) => {
    const refused = [...calls].reverse().find((x) => x.name === "create_file" && !x.ok);
    if (calls.some((x) => x.name === "create_file" && x.ok)) return null;
    if (refused) return `${REFUSED_FILE_TODO}: ${refused.error}. Fix exactly what that error names.`;
    return todos[Math.min(k++, 1)];
  };
  const fileTool = createFileTool(createFileService({ store: memoryFileStore(), env: { get: (k2: string) => ENV[k2] }, now: () => NOW }));
  const steps = [text("draft 1"), text("draft 2"), use("create_file", { kind: "plan_review", data: { title: "Plan", variant: "pipeline", sections: [{ heading: "h", items: [{ label: "PayPal", value: "Apply." }] }] } }, "f1"), text("draft 3"),
    use("create_file", { kind: "plan_review", data: { title: "Plan", variant: "pipeline", sections: [{ heading: "h", items: [{ label: "PayPal", value: "Apply.", source: "From you" }] }] } }, "f2"), text("The plan is in the file.")];
  const seen: any[] = [];
  let n = 0;
  const out: any = await runAgentTurn({ system: "s", history: [], message: P.C1, tools: [fileTool], ctx: ctx() as any, process,
    model: async (p: any) => { seen.push(JSON.stringify(p)); return (steps[n++] ?? text("x")) as any; } });
  eq(out.tool_calls.map((x: any) => [x.name, x.ok]), [["create_file", false], ["create_file", true]]);
  ok(seen.some((m) => m.includes(REFUSED_FILE_TODO) && m.includes("source is missing")), "the retry carries the exact error");
  eq(out.fileLinks?.length, 1);
});

// ---------------------------------------------------------------- D73-4 or remote
const lexemes = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9+#]+/g) ?? []).map((w) => w.replace(/(ing|ed|es|s)$/, "")));
const dbSearch = (pool: any[]) => async (q: string) => pool.filter((p) => { const have = lexemes(`${p.title} ${p.company} ${p.location} ${p.description}`); return (q.toLowerCase().match(/[a-z0-9+#]+/g) ?? []).filter((w) => !["or", "in", "a", "the", "and"].includes(w)).every((w) => have.has(w.replace(/(ing|ed|es|s)$/, ""))); });
Deno.test("D73-4 C1, C3: the places the person joined with 'or' are searched each, though the model's query has no 'or'", async () => {
  const asked = LIVE9.C1.trace.args[0].args.query;
  eq(asked, "software engineer intern summer 2027 Chicago remote", "live-9: one query, no 'or'");
  ok(!/NVIDIA/.test(LIVE9.C1.reply), "live-9: NVIDIA's remote posting not returned");
  // The persona's goal as live-9's setup-2 saved it ("I saved two drafts for you to confirm: the goal (SWE internship, summer 2027,
  // Chicago or remote)"), from the setup message "I'm looking for a SWE internship for summer 2027, Chicago or remote".
  ok(/the goal \(SWE internship, summer 2027, Chicago or remote\)/.test(LIVE9["setup-2"].reply) && /Chicago or remote/.test(PERSONA.setup[2]));
  const profile = personaProfile();
  profile.facts = [...(profile.facts ?? []), { id: "goal-1", kind: "goal", text: "SWE internship, summer 2027, Chicago or remote", status: "draft" }];
  eq(placeAlternatives(asked, P.C1, profile), "software engineer intern summer 2027 Chicago or remote");
  eq(orAlternatives(placeAlternatives(asked, P.C1, profile)), ["software engineer intern summer 2027 Chicago", "software engineer intern summer 2027 remote"]);
  eq(placeAlternatives("software engineer intern Chicago", P.C3, null), "software engineer intern Chicago or remote", "C3: the person said 'chicago or remote'");
  eq(placeAlternatives("software engineer intern", P.C3, null), "software engineer intern", "no place in the query: nothing added");
  eq(placeAlternatives("data analyst new york", "data analyst roles in new york or boston", null), "data analyst new york", "a two-word place is left as it is");
  eq(placeAlternatives("software engineer intern Chicago", "is this or that better", null), "software engineer intern Chicago");
  const pool = POSTINGS.map((x) => ({ job_id: x.id, company: x.company, title: x.title, location: x.location, url: x.url, description: x.description, first_seen_at: "2026-11-06T00:00:00Z" }));
  const tools = Object.fromEntries(careerTools({ postings: dbSearch(pool) } as any).map((t: any) => [t.name, t]));
  const out: any = await tools.search_jobs.run({ query: asked }, { userId: "u", threadId: "t", now: NOW, state: { profile }, turn: { message: P.C1, added: [] } } as any);
  eq(out.postings.map((x: any) => x.company).sort(), ["NVIDIA", "PayPal"]);
  ok(out.searched_each.some((q: string) => /chicago/i.test(q)) && out.searched_each.some((q: string) => /remote/.test(q)), JSON.stringify(out.searched_each));
  const c3: any = await tools.search_jobs.run({ query: "software engineer intern Chicago" }, { userId: "u", threadId: "t", now: NOW, state: {}, turn: { message: P.C3, added: [] } } as any);
  eq(c3.postings.map((x: any) => x.company).sort(), ["NVIDIA", "PayPal"]);
});

// ---------------------------------------------------------------- D73-5 length
// A shortener that does what it is told: it reads the number the instruction gives and drops whole sentences that carry no figure,
// link, caveat or question until the text is within it (the list written as sentences).
function obedient(long: string, system: string): string {
  const target = Number(/at most (\d+) characters/.exec(system)?.[1] ?? 1e9);
  const ss = long.replace(/^[ \t]*\d{1,2}[.)][ \t]+/gm, "").split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const must = (x: string, k: number) => k === 0 || /\d|https?:\/\/|\[|\?$|\b(?:not|never|nothing|no|haven'?t|couldn'?t|can'?t|don'?t|won'?t|unverified|unconfirmed)\b/i.test(x);
  const keep = ss.map((x, k) => ({ x, m: must(x, k) }));
  for (let k = keep.length - 1; k >= 0 && textLength(keep.map((y) => y.x).join(" ")) > target; k--) if (!keep[k].m) keep.splice(k, 1);
  return keep.map((y) => y.x).join(" ");
}
Deno.test("D73-5 LENGTH (12/23 far over): each pass is given the kind's number and the figures and caveats that must stay", async () => {
  // live-9: shorter texts still over the bound (second pass stopping short of it), and three refused for a dropped caveat or figure.
  for (const id of ["C7", "C12", "C15", "C17", "C20"]) eq([LIVE9[id].trace.shorten.outcome, LIVE9[id].trace.shorten.passes], ["shorter", 2], id);
  eq(["C4", "C6", "C11"].map((id) => LIVE9[id].trace.shorten.why), ["the caveat was dropped", "a figure was dropped (11)", "a figure was dropped (2029)"]);
  // The keep list names what was refused after: C6's "11", C11's "2029", C4's caveat sentence.
  ok(keepList(LIVE9.C6.reply).includes(" 11,") || /\b11\b/.test(keepList(LIVE9.C6.reply)), keepList(LIVE9.C6.reply));
  ok(/\b2029\b/.test(keepList(LIVE9.C11.reply)), keepList(LIVE9.C11.reply));
  ok(/what each of these says/.test(keepList(LIVE9.C4.reply)), keepList(LIVE9.C4.reply));
  // Through the turn: the instruction carries the kind's number (its upper end, inside the scorer's D-066 bound) and the keep list;
  // the second pass is told how far the first fell short. A shortener that follows it lands within the scorer's far bound.
  for (const id of ["C7", "C12", "C15", "C17"]) {
    const long = LIVE9[id].reply, l = replyLength(P[id]);
    const s = scripted((_p, n) => n === 0 ? use("get_situation_test", {}) : text(long), (q) => obedient(String(q.messages[0].content[0].text), q.system));
    const r: any = await turn(P[id], s.model, { capabilities: [readTool] });
    const asks = s.seen.filter((p) => !p.tools?.length).map((p) => p.system);
    ok(asks.length >= 1 && asks.every((x) => x.includes(`at most ${l.upper} characters`)), `${id}: the number is said`);
    ok(/It must keep/.test(asks[0]) || !keepList(long), `${id}: what must stay is said`);
    ok(["accepted", "shorter"].includes(r.shorten.outcome), `${id}: ${JSON.stringify(r.shorten)}`);
    ok(shortenedOk(long, r.reply, Number.POSITIVE_INFINITY), `${id}: faithful`);
    // C12's sentences each carry a figure, a caveat or the boundary, so a shortener that only deletes cannot reach the number; its
    // second pass is told how far it still is. The others reach the kind's number, within the scorer's far bound (live-9: over it).
    if (id === "C12") { eq(r.shorten.passes, 2); ok(/cut at least \d+ more characters/.test(asks[1]), asks[1]); continue; }
    ok(textLength(r.reply) <= overLimit(l) && !lengthFarOver(textLength(r.reply), 0, P[id]).far, `${id}: ${textLength(r.reply)} within ${overLimit(l)} and the scorer's far bound ${lengthFarOver(0, 0, P[id]).bound} (live-9: ${LIVE9[id].trace.shorten.after})`);
  }
});

// ---------------------------------------------------------------- D73-6 the pay's place
Deno.test("D73-6 C9: pay said again from an earlier reply carries its place and link, on the research path too", async () => {
  const said = "The only pay I have is the PayPal SWE internship posting you saw earlier, listed at $28-$49 hourly, and that isn't Citadel.";
  ok(LIVE9.C9.reply.includes(said) && !/Chicago/.test(LIVE9.C9.reply), "live-9 C9: the figure without its place");
  const history = [{ role: "user", content: PERSONA.setup[2] ?? P.C1 }, { role: "assistant", content: LIVE9["setup-2"].reply }];
  const lines = shownPayPlaces(P.C9, history as any);
  ok(lines.some((x) => /\$28-\$49/.test(x.text) && x.place === "Chicago, IL"), JSON.stringify(lines));
  // Architect amendment (owner decision 2026-11-13: research support check switched on): no place is written into a sentence of the
  // model's, and none is taken from an earlier reply's text (review of #807, class 8: a city read from reply text was put on another
  // employer's pay). Pay said again from an earlier reply carries that line's own link after it; the sentence is left as written.
  const out = payWithSource(said, [], lines);
  eq(out, `${said}\n\n${POSTINGS[0].url}`, out);
  eq(payWithSource("Chicago pay is $28-$49 hourly.", [], lines).split("\n")[0], "Chicago pay is $28-$49 hourly.", "a sentence naming the place is left as it is");
  // A posting read this turn: its place goes beside that posting's own link, from that posting's own record (employer, place), never
  // into the model's sentence; a record that names no place gets the link alone.
  eq(payWithSource("PayPal lists $28-$49 an hour.", [{ company: "PayPal", pay: "$28- $49 Hourly (Chicago, Illinois)", url: POSTINGS[0].url, place: "Chicago, IL" }]), `PayPal lists $28-$49 an hour.\n\nPayPal (Chicago, IL): ${POSTINGS[0].url}`);
  eq(payWithSource("PayPal lists $28-$49 an hour.", [{ company: "PayPal", pay: "$28- $49 Hourly (Chicago, Illinois)", url: POSTINGS[0].url }]), `PayPal lists $28-$49 an hour.\n\n${POSTINGS[0].url}`);
  // Through the C9 turn (research found nothing on these pages; the model restates the shown pay): place and link.
  // Architect amendment (owner decision 2026-11-13: research support check switched on): on the research path a shown pay line
  // stands only whole, word for word (enforceMarketReplySupported), with that line's own link; live-9's reworded restatement is
  // removed with every other unsourced sentence (checked here). The model restates the shown line itself; any place it carries is
  // the shown line's own words.
  const shownLine = lines.find((x) => /\$28-\$49/.test(x.text))!;
  const s0 = scripted((_p, n) => n === 0 ? use("research_market", { question: C9_Q, format: "inline", ...C9_PLAN, sites: CITADEL_SITES }) : text(LIVE9.C9.reply));
  const r0: any = await agentTurn({ message: P.C9, history, stores: { profile: personaProfile() }, userId: "u-d073", threadId: "th-d073", now: NOW, model: s0.model, market: marketDeps(CITADEL, () => "{}", { read: async () => ({ verified: [], rejected: [] }) }) } as any);
  ok(!/\$28-\$49|isn't Citadel/.test(r0.reply) && /[A-Za-z]/.test(r0.reply), r0.reply);
  const s = scripted((_p, n) => n === 0 ? use("research_market", { question: C9_Q, format: "inline", ...C9_PLAN, sites: CITADEL_SITES }) : text(`${shownLine.text} I couldn't confirm it.`));
  const r: any = await agentTurn({ message: P.C9, history, stores: { profile: personaProfile() }, userId: "u-d073", threadId: "th-d073", now: NOW, model: s.model, market: marketDeps(CITADEL, () => "{}", { read: async () => ({ verified: [], rejected: [] }) }) } as any);
  const line = r.reply.split(/\n/).find((x: string) => /\$28-\$49/.test(x));
  // (The shown line here, "Pay is listed as $28-$49 hourly.", names no place, and code takes none from reply text: the figure goes
  // with the link of the posting it came from, whose page states the place.)
  ok(line && line.includes(shownLine.text) && !/Chicago/.test(line) && r.reply.includes(POSTINGS[0].url), r.reply);
});
