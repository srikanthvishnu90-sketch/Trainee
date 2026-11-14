// D-071 (architect, 2026-11-12): the fixes for live-8 (PR #791: batch 1 on trunk 44183b35, 5/24 scored turns pass wa-1/d066; CI run
// 43211904644) and the item 10 real-set research re-run on the same trunk (run 43212037007, PASS 15/20: Coinbase, Brex, Gusto, Toast
// and Notion opened 5 to 10 pages each and kept no line). Each test replays what the live runs recorded (the live-8 transcript, the
// real-set recordings, the mirror's Citadel pages) at $0 with a scripted model returning the observed shape. No network, no spend,
// nothing sent.
//   D71-1  LENGTH (14/24 far over): a faithful shorter text is used even when still over the bound, with one second pass toward it;
//          C4, C11, C12, C17, C20 replayed; a turn the pass does not run on says why (C9 had no reason).
//   D71-2  RESEARCH (C9, C23; item 10): a line the model words as "Citadel's posting lists ...", "The posting says ...", or with a
//          possessive subject stands; a line that only rewords its quote stands as the page's own sentence; a draft that gives no
//          line still gives the pages' own sentences; the trace says drafted / kept / dropped by reason (turn meta, real-set results).
//   D71-3  C1: create_file takes the sections the model sent in another shape; a fact with no source is still refused, with the
//          kind's exact shape; the plan File is made on the first call.
//   D71-4  C1, C3: "chicago or remote" returns NVIDIA's remote posting on a whole-word search (the database's rule); the search's
//          words are in the trace.
//   D71-5  C10, C20: dated entries newest first even beside undated ones; education where the technical template puts it.
//   D71-6  C20: an edit is said against the version that was delivered (Waypoint was printed in v1: never "added back").
//   D71-7  C6: the number of applications is the record's (counts), never the model's own count.
//   D71-8  C22: a going-rate ask runs sourced research beside the posting pay already shown.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/d071-live8-fixes-20261112.test.ts
import assertNode from "node:assert/strict";
import { CareerRouter } from "../../supabase/functions/_shared/router_core.career.js";
import { agentTurn, applicationCount, marketRateAskOf, processCheck, shortenedOk } from "../../supabase/functions/agent-chat/career_brain.ts";
import { checkLine, enforceMarketReply, researchMarket, withoutAttribution } from "../../supabase/functions/_shared/agent/research/market.ts";
import { attributedTestSupportJudge, testSupportJudge } from "./support-test-judge.ts";
import { researchCompany } from "../../supabase/functions/_shared/agent/research/company.ts";
import { contentWords } from "../../supabase/functions/_shared/agent/research/guard.ts";
import { readAlike } from "../../supabase/functions/_shared/agent/research/draft_json.ts";
import { edgeRenderer, memoryResumeStore, tailorForPosting } from "../../supabase/functions/_shared/career_tailor.ts";
import { entryStart, newestFirst } from "../../supabase/functions/_shared/career_resume_design.ts";
import { askedPartsOf, overLimit, partsMissing, replyLength, textLength } from "../../supabase/functions/_shared/agent/turn_notes.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { capabilityTools } from "../../supabase/functions/_shared/agent/capability_tools.ts";
import { coerceShape, createFileTool } from "../../supabase/functions/_shared/agent/file_tool.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { lengthFarOver } from "../../evals/mirror/score-conversation.ts";
import { POSTINGS } from "../../evals/mirror/instinct-wa-batch1/world.ts";
import { C9_Q, CITADEL_QUERIES, WEB } from "./helpers/mirror_wa_script.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const DIR = new URL("../../evals/mirror/instinct-wa-batch1/", import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, DIR)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const P: Record<string, string> = Object.fromEntries(read("prompts.jsonl").map((t: any) => [t.id, t.prompt]));
const PERSONA = JSON.parse(Deno.readTextFileSync(new URL("persona.json", DIR)));
// live-8's own turns (the transcript the run recorded, PR #791): replies and traces, used as the brain's observed output.
const LIVE8: Record<string, any> = Object.fromEntries(read("results/live-8/trainee-live-8.jsonl").map((t: any) => [t.id, t]));
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
  agentTurn({ message, history: [], stores: { profile: personaProfile() }, userId: "u-d071", threadId: "th-d071", now: NOW, model, ...extra } as any);
const readTool = { name: "get_situation_test", effect: "read", description: "read (test)", input_schema: { type: "object", properties: {} }, run: async () => ({ ok: true }) };

// ---------------------------------------------------------------- D71-1 length
// A faithful shortener (it only deletes): the list written as sentences, then whole sentences that carry no figure, link,
// [placeholder], boundary, caveat or question dropped from the end until the text is within the bound (or nothing more can go).
function faithful(long: string, bound: number): string {
  const ss = long.replace(/^[ \t]*\d{1,2}[.)][ \t]+/gm, "").split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const must = (x: string, k: number) => k === 0 || /\d|https?:\/\/|\[|\?$|\b(?:not|never|nothing|no|haven'?t|couldn'?t|can'?t|don'?t|won'?t|unverified|unconfirmed)\b/i.test(x);
  const keep = ss.map((x, k) => ({ x, m: must(x, k) }));
  for (let k = keep.length - 1; k >= 0 && textLength(keep.map((y) => y.x).join(" ")) > bound; k--) if (!keep[k].m) keep.splice(k, 1);
  return keep.map((y) => y.x).join(" ");
}
Deno.test("D71-1 LENGTH: a faithful shorter text is used even when still over the bound (one second pass toward it); every turn says why it was or was not shortened", async () => {
  // live-8: the pass ran on 14 turns and refused 11 shorter texts only because they were still over the bound (C4 602 > 550).
  for (const id of ["C4", "C11", "C12", "C17"]) eq([LIVE8[id].trace.shorten.outcome, /still over the bound/.test(LIVE8[id].trace.shorten.why)], ["rejected", true], `${id} live-8`);
  eq(LIVE8.C9.trace.shorten, { ran: false, why: "", outcome: "not_run" }, "C9: no reason recorded");
  const cut: Record<string, number> = {};
  for (const id of ["C4", "C11", "C12", "C17"]) {
    const long = LIVE8[id].reply, bound = overLimit(replyLength(P[id])), short = faithful(long, bound);
    ok(textLength(long) > bound && textLength(short) < textLength(long) && shortenedOk(long, short, Number.POSITIVE_INFINITY), `${id}: the stand-in is faithful`);
    // The shortener is handed the reply as the turn's guards left it; the stand-in shortens whatever it is handed.
    let handed = "";
    const s = scripted((_p, n) => n === 0 ? use("get_situation_test", {}) : text(long), (q) => { const t = String(q.messages[0].content[0].text); handed ||= t; return faithful(t, bound); });
    const r: any = await turn(P[id], s.model, { capabilities: [readTool] });
    const want = faithful(handed, bound);
    eq(r.reply, want, `${id}: the shorter faithful text is sent`);
    eq(r.shorten.ran, true);
    eq(r.shorten.outcome, textLength(want) <= bound ? "accepted" : "shorter", `${id}: ${JSON.stringify(r.shorten)}`);
    if (textLength(want) > bound) { eq(r.shorten.passes, 2, `${id}: one more pass toward the bound`); ok(/still over the bound/.test(r.shorten.why)); }
    cut[id] = Math.round(100 - (100 * textLength(want)) / textLength(handed));
  }
  // C4's shorter text (596 here; 602 live) is within the scorer's far bound (625), so the turn passes length; the others are 9% to 63% shorter.
  const c4 = faithful(LIVE8.C4.reply, overLimit(replyLength(P.C4)));
  ok(!lengthFarOver(textLength(c4), 0, P.C4).far && lengthFarOver(textLength(LIVE8.C4.reply), 0, P.C4).far, `C4 ${textLength(c4)}`);
  ok(cut.C11 >= 15 && cut.C12 >= 15 && cut.C17 >= 15, JSON.stringify(cut));
  // C20 (tailor_resume: a File turn) is shortened too, its [your email] placeholder kept.
  const p = POSTINGS[0];
  const tailor = { posting: async () => ({ job_id: p.id, title: p.title, company: p.company, description: p.description }), personas: { get: async () => ({ items: [], active: null }), put: async () => {} } as any, resumes: memoryResumeStore(), render: edgeRenderer(), deliver: () => {} };
  const long20 = LIVE8.C20.reply, short20 = faithful(long20, overLimit(replyLength(P.C20)));
  ok(short20.includes("[your email]") && shortenedOk(long20, short20, Number.POSITIVE_INFINITY));
  const s20 = scripted((_p, n) => n === 0 ? use("tailor_resume", { job_id: p.id, edits: [{ role: "pixelforge", lines: 1 }, { role: "waypoint", lines: 3 }] }) : text(long20), () => short20);
  const r20: any = await agentTurn({ message: P.C20, history: [], stores: { profile: personaProfile() }, userId: "00000000-0000-4000-8000-000000001171", threadId: "th", now: NOW, model: s20.model, tailor } as any);
  eq(r20.tool_calls.map((c: any) => [c.name, c.ok]), [["tailor_resume", true]]);
  ok(["accepted", "shorter"].includes(r20.shorten.outcome) && textLength(r20.reply) < textLength(long20) * 0.85, JSON.stringify(r20.shorten));
  // A shorter text that drops a figure, a link or a placeholder is still refused, and the reason is recorded.
  const s3 = scripted((_p, n) => n === 0 ? use("get_situation_test", {}) : text(LIVE8.C11.reply), () => "Workday needs your own account, your email and your work authorization. Nothing was applied for.");
  const r3: any = await turn(P.C11, s3.model, { capabilities: [readTool] });
  eq(r3.shorten.outcome, "rejected");
  ok(textLength(r3.reply) > 600 && !/^Workday needs your own account/.test(r3.reply), "the long reply stands");
  ok(/dropped/.test(r3.shorten.why), r3.shorten.why);
  // C9 (research laid out in code) says why the pass did not run.
  const m = await marketTurn(P.C9, [], (n) => n === 0 ? use("research_market", { question: C9_Q, format: "inline", companies: ["Citadel"], sites: CITADEL_SITES, queries: CITADEL_QUERIES }) : text("Pay: the base salary range is $235,000 to $300,000 [1]."));
  eq([m.r.shorten.ran, m.r.shorten.outcome], [false, "not_run"]);
  ok(/research reply/.test(m.r.shorten.why), m.r.shorten.why);
});

// ---------------------------------------------------------------- D71-2 research
const REC = new URL("../../evals/real-sets/research/", import.meta.url);
const sentencesOf = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length >= 40 && s.length <= 300 && /[a-z]/.test(s) && !/https?:\/\//.test(s));
// How the drafting model words a line it quotes word for word (the forms the guard used to drop): the source named ("The posting
// says ..."), the company as a possessive subject ("Brex's mission is ..."), or as the subject of the page's "we".
function modelLines(company: string, pages: { url: string; text: string }[]) {
  const out: { text: string; quote: string; url: string }[] = [];
  for (const p of pages) for (const s0 of sentencesOf(p.text)) {
    if (out.length >= 9) break;
    const s = s0.replace(/^The posting says:\s*/, "");
    const our = /^Our\s+/.test(s) ? s.replace(/^Our\s+/, `${company}'s `) : null;
    const we = /^We(?:'re| are)\s+/.test(s) ? s.replace(/^We(?:'re| are)\s+/, `${company} is `) : null;
    out.push({ text: our ?? we ?? `The posting says ${s.charAt(0).toLowerCase()}${s.slice(1)}`, quote: s, url: p.url });
  }
  return out;
}
const marketDeps = (pages: { url: string; title: string; text: string }[], draft: (user: string) => string) => ({
  search: { id: "t", needsKey: false, search: async () => ({ hits: pages.map((p) => ({ url: p.url, title: p.title, provider: "t", foundAt: NOW })), notes: [], provider: "t" }) },
  read: async () => ({ verified: pages.map((p) => ({ url: p.url, requested: p.url, status: 200, title: p.title, text: p.text, fetchedAt: NOW })), rejected: [] }),
  draft: async (payload: any) => draft(payload.messages[0].content), layout: "messages" as const,
  // Architect amendment (owner decision 2026-11-13: research support check switched on): research needs its judge to keep a line
  // (the deterministic test judge, support-test-judge.ts), in researchMarket and in the brain's research_market alike.
  judge: testSupportJudge,
});
// Architect amendment (owner decision 2026-11-13: research support check switched on): a page sentence that does not name Citadel
// ("The base salary range for this role is ...") speaks for Citadel only on a page code knows is Citadel's own: its domain on
// record (the plan's sites, as the brain passes them). Every Citadel research call of this file gives it.
const CITADEL_SITES = ["citadel.com"];
const CITADEL = Object.entries(WEB).slice(0, 4).map(([url, p]) => ({ url, title: p.title, text: p.text }));
// The C9 draft as a model words it from the Citadel pages (the Instinct benchmark's sources, tests/architect/helpers/mirror_wa_script.ts;
// the live-8 run log records no page text): each quote word for word, each claim in the model's own framing.
const C9_DRAFT = JSON.stringify({ title: "Citadel new grad SWE", thesis: "Citadel's posting states pay; its own page describes the process.", summary: [
  { text: "Citadel's posting lists a base salary range of $235,000 to $300,000, plus a discretionary bonus.", quote: "The base salary range for this role is $235,000 to $300,000, plus a discretionary bonus.", url: CITADEL[0].url },
  { text: "Citadel says its engineering interview process takes roughly eight weeks from start to finish.", quote: "At Citadel, the overall process takes roughly eight weeks from start to finish.", url: CITADEL[1].url },
  { text: "Anonymous posters describe demanding hours and performance pressure at Citadel.", quote: "Anonymous posters describe demanding hours and performance pressure at Citadel.", url: CITADEL[2].url },
  { text: "Citadel Securities is a market maker, a separate firm from Citadel.", quote: "Citadel Securities is a market maker, a separate firm from Citadel.", url: CITADEL[3].url },
] });
async function marketTurn(message: string, history: any[], brain: (n: number) => any, draft: (u: string) => string = () => C9_DRAFT) {
  const s = scripted((_p, n) => brain(n));
  const r: any = await agentTurn({ message, history, stores: { profile: personaProfile() }, userId: "u-d071", threadId: "th-d071", now: NOW, model: s.model, market: marketDeps(CITADEL, draft) } as any);
  return { r, s };
}
Deno.test("D71-2 RESEARCH (C9, C23, item 10): lines worded the way the model words them stand on their pages; no read page leaves research without its sourced parts; the trace says why", async () => {
  // The guard's old reading of these claims (before D-071): the possessive and the attribution words were claim words no quote had.
  ok([...contentWords("Coinbase's mission")].includes([...contentWords("Coinbase")][0]), "a possessive is its word");
  eq(withoutAttribution("Citadel's posting lists a base salary range of $235,000."), "a base salary range of $235,000.");
  eq(withoutAttribution("The posting says the team ships weekly."), "the team ships weekly.");
  eq(withoutAttribution("According to its careers page, interns rotate."), "interns rotate.");
  // C9: research_market on the Citadel pages; pay, process and culture each stand with their source link.
  const r: any = await researchMarket({ question: C9_Q, format: "inline", plan: { queries: CITADEL_QUERIES, companies: ["Citadel"], sites: CITADEL_SITES } as any, deps: marketDeps(CITADEL, () => C9_DRAFT) as any });
  eq(r.status, "ok", JSON.stringify(r).slice(0, 400));
  eq(r.points.length, 4, JSON.stringify(r.audit));
  eq([r.audit.drafted, r.audit.kept, r.audit.dropped], [4, 4, {}]);
  const said = enforceMarketReply(["Pay: Citadel's posting lists a base salary range of $235,000 to $300,000, plus a discretionary bonus [1].", "Interview process: about eight weeks from start to finish [2].",
    "Culture: anonymous posters describe demanding hours and performance pressure, anecdotes rather than proof [3]."].join("\n\n"), r);
  eq(partsMissing(said, askedPartsOf(P.C9)), [], said);
  for (const u of CITADEL.slice(0, 3)) ok(said.includes(u.url), `${u.url} is under its part`);
  // A figure the quote does not have, a page never read, and a line naming another employer than its quote are still dropped.
  const pg = (i: number): any => ({ url: CITADEL[i].url, requested: CITADEL[i].url, status: 200, title: CITADEL[i].title, text: CITADEL[i].text, fetchedAt: NOW });
  eq(checkLine("Citadel's posting lists a base salary of $400,000.", "The base salary range for this role is $235,000 to $300,000, plus a discretionary bonus.", pg(0), "Citadel"), { ok: false, why: "figure_not_in_quote" });
  eq(checkLine("Citadel pays $235,000.", "The base salary range for this role is $235,000 to $300,000", null), { ok: false, why: "page_not_read" });
  eq(checkLine("Acme Energy installed 41,000 solar panels.", "Acme Energy installed 41,000 home batteries in 2025", { url: "https://acme.example/r", requested: "https://acme.example/r", status: 200, title: "Annual report", text: "Acme Energy installed 41,000 home batteries in 2025.", fetchedAt: NOW } as any).ok, false, "a changed object is never a rewording");
  eq(checkLine("Jane Street describes demanding hours and performance pressure.", "Anonymous posters describe demanding hours and performance pressure at Citadel.", pg(2), "").ok, false, "another employer's name is never a rewording");
  // A line that only rewords its quote stands as the page's own sentence, word for word.
  eq(checkLine("Anonymous posters report demanding hours, with performance pressure at Citadel.", "Anonymous posters describe demanding hours and performance pressure at Citadel.", pg(2), "Citadel"),
    { ok: true, text: "Anonymous posters describe demanding hours and performance pressure at Citadel.", via: "quote" });
  // A draft that gives no line at all (live: the trace could not say) still gives the pages' own sentences, each with its source.
  const empty: any = await researchMarket({ question: C9_Q, format: "inline", plan: { queries: CITADEL_QUERIES, companies: ["Citadel"], sites: CITADEL_SITES } as any, deps: marketDeps(CITADEL, () => "I can't write that.") as any });
  eq(empty.status, "ok");
  ok(empty.points.length >= 2 && empty.audit.from_pages === empty.points.length && empty.audit.parse === "failed", JSON.stringify(empty.audit));
  // Architect amendment (owner decision 2026-11-13: research support check switched on): a page's own sentence is shown as what it
  // is, in quotation marks; inside the marks it is still that page's text.
  const unq = (t: string) => t.replace(/^(?:From [^:"]+: )?"(.*)"$/s, "$1");
  for (const p of empty.points) ok(/^(?:From [^:"]+: )?".*"$/s.test(p.text) && CITADEL.some((c) => c.text === unq(p.text)), p.text);
  // The turn's meta carries the trace (handler meta `research`; the mirror runner's trace.research).
  const t = await marketTurn(P.C9, [], (n) => n === 0 ? use("research_market", { question: C9_Q, format: "inline", companies: ["Citadel"], sites: CITADEL_SITES, queries: CITADEL_QUERIES }) : text("Pay: Citadel's posting lists a base salary range of $235,000 to $300,000 [1]."));
  eq([t.r.research.kind, t.r.research.status, t.r.research.drafted, t.r.research.kept], ["market", "ok", 4, 4]);
  for (const f of ["../../supabase/functions/agent-chat/handler-career.ts", "../../evals/mirror/run-conversation.ts"]) ok(/research: \(turn as any\)\.research|research: meta\.research/.test(Deno.readTextFileSync(new URL(f, import.meta.url))), f);
  // Item 10: the five companies that kept nothing live, replayed on their recorded pages with lines worded as the model words them.
  for (const id of ["R05", "R08", "R10", "R14", "R18"]) {
    const rec = JSON.parse(Deno.readTextFileSync(new URL(`recorded/${id}.json`, REC)));
    const pages = (rec.read.verified as any[]).filter((v) => v.status === 200).map((v) => ({ url: v.url, text: String(v.text ?? "") }));
    const lines = modelLines(rec.case.company, pages);
    // Architect amendment (owner decision 2026-11-13: research support check switched on): these lines name their source ("The
    // posting says ..."); the judge reads "the posting says X" as stated exactly when the page states X (attributedTestSupportJudge).
    const d = JSON.stringify({ title: rec.case.company, business: lines.slice(0, 6), role: lines.slice(6, 9), developments: [], competitors: [], tensions: [], unknowns: [] });
    const rr: any = await researchCompany({ company: rec.case.company, role: rec.case.role, question: `Research ${rec.case.company}.`, plan: rec.plan, now: Date.UTC(2026, 10, 12, 15), format: "inline", deps: { search: { id: "first_party", needsKey: false, search: async () => rec.search }, read: async () => rec.read, draft: async () => d, judge: attributedTestSupportJudge } as any });
    eq(rr.status, "ok", `${id}: ${rr.blocker ?? ""}`);
    ok(rr.business.length + rr.role_asks.length >= 3 && rr.audit.drafted === lines.length, `${id}: ${JSON.stringify(rr.audit)}`);
    for (const l of [...rr.business, ...rr.role_asks]) { const src = rr.sources.find((x: any) => x.n === l.cite[0]); ok(src && pages.some((pg) => pg.url === src.url), `${id}: ${l.text}`); }
    // With no draft line at all, the pages' own sentences that name the company.
    const none: any = await researchCompany({ company: rec.case.company, role: rec.case.role, question: `Research ${rec.case.company}.`, plan: rec.plan, now: Date.UTC(2026, 10, 12, 15), format: "inline", deps: { search: { id: "first_party", needsKey: false, search: async () => rec.search }, read: async () => rec.read, draft: async () => "", judge: testSupportJudge } as any });
    eq(none.status, "ok", `${id} with no draft: ${none.blocker ?? ""}`);
    ok(none.business.length >= 1 && none.audit.from_pages === none.business.length, JSON.stringify(none.audit));
    // Architect amendment (owner decision 2026-11-13: research support check switched on): the page's sentence is shown in quotation
    // marks (with "From <host>, a page about <Employer>: " when the page lends the name); inside the marks, word for word.
    for (const l of none.business) ok(/^(?:From [^:"]+: )?".*"$/s.test(l.text) && pages.some((pg) => readAlike(pg.text).replace(/\s+/g, " ").includes(unq(l.text))), `${id}: word for word from its page: ${l.text}`);
  }
  // The real-set results record the trace (evals/real-sets/research/run.ts).
  ok(/research: r\.audit/.test(Deno.readTextFileSync(new URL("run.ts", REC))));
});

// ---------------------------------------------------------------- D71-3 create_file
Deno.test("D71-3 C1: create_file takes the plan in the shape the model sent; a fact with no source is still refused, with the exact shape", async () => {
  eq(LIVE8.C1.trace.call_errors, [{ name: "create_file", error: "not created: sections: must be a list" }]);
  const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-d071-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
  const files = createFileService({ store: memoryFileStore(), env: { get: (k: string) => ENV[k] }, now: () => NOW });
  const tool = createFileTool(files);
  const item = { label: "PayPal", value: "Apply this week.", source: "From you" };
  const ctx = () => ({ userId: "33333333-3333-4333-8333-333333333371", threadId: "t", now: NOW, state: {}, turn: { message: P.C1, added: [], fileLinks: [] as string[], guard: () => [] } });
  const shapes: Record<string, unknown> = {
    "sections as JSON text": { title: "SWE internship plan", variant: "pipeline", sections: JSON.stringify([{ heading: "This week", items: [item] }]) },
    "one section object": { title: "SWE internship plan", variant: "pipeline", sections: { heading: "This week", items: [item] } },
    "sections keyed by heading": { title: "SWE internship plan", variant: "pipeline", sections: { "This week": [item], "Next week": item } },
    "the whole data as JSON text": JSON.stringify({ title: "SWE internship plan", variant: "pipeline", sections: [{ heading: "This week", items: [item] }] }),
  };
  for (const [name, data] of Object.entries(shapes)) {
    const c = ctx();
    const out: any = await tool.run({ kind: "plan_review", data }, c as any);
    ok(out.created && c.turn.fileLinks.length === 1, name);
  }
  eq(coerceShape({ sections: { "This week": [item] } }), { sections: [{ heading: "This week", items: [item] }] });
  // Nothing is invented: a fact with no source is refused, and the refusal says exactly what the kind takes.
  const bad = await tool.run({ kind: "plan_review", data: { title: "Plan", variant: "pipeline", sections: { heading: "This week", items: [{ label: "PayPal", value: "Apply." }] } } }, ctx() as any).then(() => "", (e) => String(e.message));
  ok(/source is missing/.test(bad) && /"sections": \[\{"heading"/.test(bad), bad);
  const notList = await tool.run({ kind: "plan_review", data: { title: "Plan", variant: "pipeline", sections: 7 } }, ctx() as any).then(() => "", (e) => String(e.message));
  ok(/sections: must be a list \(a JSON array\), got number/.test(notList), notList);
  // C1 replayed: search, then create_file with sections as one object: the File is made on the first call.
  const s = scripted((_p, n) => [use("search_jobs", { query: "software engineer intern chicago or remote" }), use("create_file", { kind: "plan_review", data: shapes["one section object"] }, "t2"), text("Search found 1 posting. The plan is in the file.")][n] ?? text("ok"));
  const r: any = await turn(P.C1, s.model, { files, postings: async () => [] });
  eq(r.tool_calls.map((c: any) => [c.name, c.ok]), [["search_jobs", true], ["create_file", true]]);
  eq(r.fileLinks?.length, 1);
});

// ---------------------------------------------------------------- D71-4 chicago or remote
// The database's rule (Postgres full-text search, english): whole words and their stems; "intern" is not in "internal".
const lexemes = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9+#]+/g) ?? []).map((w) => w.replace(/(ing|ed|es|s)$/, "")));
const dbSearch = (pool: any[]) => async (q: string) => pool.filter((p) => { const have = lexemes(`${p.title} ${p.company} ${p.location} ${p.description}`); return (q.toLowerCase().match(/[a-z0-9+#]+/g) ?? []).filter((w) => !["or", "in", "a", "the", "and"].includes(w)).every((w) => have.has(w.replace(/(ing|ed|es|s)$/, ""))); });
Deno.test("D71-4 C1, C3: 'chicago or remote' returns NVIDIA's remote posting on the database's whole-word search; the search words are in the trace", async () => {
  ok(/I didn't find any remote SWE internships/.test(LIVE8["setup-2"].reply) && /nothing remote turned up/.test(LIVE8.C1.reply), "live-8: no remote posting");
  const pool = POSTINGS.map((x) => ({ job_id: x.id, company: x.company, title: x.title, location: x.location, url: x.url, description: x.description, first_seen_at: "2026-11-06T00:00:00Z" }));
  const db = dbSearch(pool);
  eq((await db("software engineer intern remote")).length, 0, "the cause: NVIDIA's role is not an internship, and 'intern' is no word on it");
  eq((await db("software engineer remote")).map((p) => p.company), ["NVIDIA"]);
  const tools = Object.fromEntries(careerTools({ postings: db } as any).map((t: any) => [t.name, t]));
  const out: any = await tools.search_jobs.run({ query: "software engineer intern chicago or remote" }, { userId: "u", threadId: "t", now: NOW, state: {} } as any);
  eq(out.postings.map((x: any) => x.company).sort(), ["NVIDIA", "PayPal"]);
  eq(out.relaxed_each, [{ asked: "software engineer intern remote", searched: "software engineer remote" }]);
  ok(/may not be the exact role/.test(out.note_relaxed));
  // The alternative itself (the place) is never what is dropped.
  ok(out.searched_each.every((q: string) => /chicago|remote/.test(q)));
  // The trace: what each search asked.
  const s = scripted((_p, n) => n === 0 ? use("search_jobs", { query: "software engineer intern chicago or remote" }) : text("Two postings: PayPal in Chicago and NVIDIA's remote role (related, not an internship)."));
  const r: any = await turn(P.C3, s.model, { postings: db });
  eq(r.tool_calls[0].args, { query: "software engineer intern chicago or remote" });
});

// ---------------------------------------------------------------- D71-5 order
Deno.test("D71-5 C10, C20: dated entries newest first beside undated ones; education where the technical template puts it", async () => {
  const pdf10 = LIVE8.C10.trace.documents[0].text as string;
  ok(pdf10.indexOf("Pixelforge") < pdf10.indexOf("Mindgrove") && pdf10.indexOf("EDUCATION") > pdf10.indexOf("EXPERIENCE"), "live-8 C10: 2023 above 2026, education last");
  eq(entryStart("Pixelforge, Founder (2023-2025): hand-coded 70+ React websites for clients."), 2023 * 12);
  eq(entryStart("Mindgrove AI Research, Researcher (August 2026 - present): research on AI continuity and memory."), 2026 * 12 + 8);
  eq(entryStart("Ridership Dashboard (TEST project)"), null);
  const profile = personaProfile(), p = POSTINGS[0];
  const r: any = await tailorForPosting({ userId: "00000000-0000-4000-8000-000000001171", profile, posting: { text: `${p.title} at ${p.company}\n\n${p.description}`, job_id: p.id, company: p.company },
    deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW, reviewDraft: true });
  ok(r.ok, JSON.stringify(r).slice(0, 300));
  const sections = [...new Set(r.detail.doc.lines.map((l: any) => l.section))];
  // Education's place for a software posting is the technical template's (RESUME-TEMPLATES T03 Engineer: skills > experience >
  // projects > education; pinned by tests/architect/wo-028-tailor.test.ts, where the tailor leads with experience): after Experience.
  ok(sections.indexOf("Experience") < sections.indexOf("Education") && sections.indexOf("Skills") < sections.indexOf("Experience"), JSON.stringify(sections));
  const exp = r.detail.doc.lines.filter((l: any) => l.section === "Experience" && l.type === "entry").map((l: any) => l.text as string);
  const at = (w: string) => exp.findIndex((x: string) => x.startsWith(w));
  ok(at("Elmstead") < at("Mindgrove") && at("Mindgrove") < at("Crestline") && at("Crestline") < at("Pixelforge"), exp.join(" | "));
  // Undated entries keep their places; nothing is dropped or reworded.
  eq(exp.length, 9);
  // The rule itself: dated entries are ordered among the places dated entries hold.
  const e = (text: string) => ({ text, type: "entry", factIds: [text] });
  const out = newestFirst({ sections: [{ heading: "Experience", lines: [e("A (2023-2025): x."), e("B, undated: y."), e("C (August 2026 - present): z.")] }] });
  eq(out.sections[0].lines.map((l: any) => l.text[0]), ["C", "B", "A"]);
});

// ---------------------------------------------------------------- D71-6 the changelog
Deno.test("D71-6 C20: an edit is said against the version delivered; an entry v1 printed is never 'added back'", async () => {
  ok(/Waypoint is now added back/.test(LIVE8.C20.reply) && LIVE8.C10.trace.documents[0].text.includes("Waypoint, Solo founder (part-time)"), "live-8: v1 printed Waypoint, v2 said it was added back");
  const profile = personaProfile(), p = POSTINGS[0];
  const base = { userId: "00000000-0000-4000-8000-000000001171", profile, posting: { text: `${p.title} at ${p.company}\n\n${p.description}`, job_id: p.id, company: p.company }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW, reviewDraft: true };
  const v1: any = await tailorForPosting(base as any);
  const v1Lines = v1.detail.doc.lines.map((l: any) => l.text as string);
  ok(v1Lines.some((l: string) => l.startsWith("Waypoint")));
  const v2: any = await tailorForPosting({ ...base, edits: [{ role: "pixelforge", lines: 1 }, { role: "waypoint", lines: 3 }] } as any);
  const w = v2.edits.find((x: any) => x.role === "waypoint");
  eq([w.added_back, w.before, w.now, w.led, w.expand_short], [false, 1, 1, true, true], JSON.stringify(w));
  ok(!/added back/.test(v2.changelog) && /Waypoint, Solo founder \(part-time\): kept at 1 detail line, now first in its section/.test(v2.changelog), v2.changelog);
  // Every line of v2 is v1's words (the edit moves and splits lines; it adds none).
  const v1Words = v1Lines.join(" ");
  for (const l of v2.detail.doc.lines) ok(v1Words.includes(String(l.text).replace(/\.$/, "")), l.text);
});

// ---------------------------------------------------------------- D71-7 counts
Deno.test("D71-7 C6: the number of applications is the record's count, never the model's own", async () => {
  ok(/shows 8 applications/.test(LIVE8.C6.reply) && /miscounted 8 above/.test(LIVE8.C6.reply), "live-8 C6");
  const fixed = applicationCount(LIVE8.C6.reply, 9);
  ok(/shows 9 applications/.test(fixed) && !/miscount|Nine is right/i.test(fixed) && (fixed.match(/^\d\. /gm) ?? []).length === 9, fixed);
  eq(applicationCount("You have 9 applications and 1 researched role.", 9), "You have 9 applications and 1 researched role.");
  // The tool gives the count; code holds the reply to it.
  const CO = ["Apparel Co", "Finance Co", "Startup Co", "Shirt Co", "Gym Co", "Grill Co", "Coffee Co", "Golf Co", "Bank A"];
  const apps = CO.map((c, i) => ({ ref: `track:a${i}`, company: c, role: "Role", stage: "Submitted", source: "tracker" as const, applied_at: new Date(NOW - (i + 1) * 3_600_000).toISOString(), events: [] }));
  const caps = capabilityTools({ mail: { applications: async () => apps, events: async () => [] } as any, tracking: false, accounts: async () => [], cursor: null, readNow: null, connectUrl: "https://trainee.example/connect", situation: null, snapshot: null, files: null, people: null, inbox: null, reply: null });
  const tool = caps.find((t) => t.name === "read_application_mail")!;
  const out: any = await tool.run({}, { userId: "u", threadId: "t", now: NOW, state: {}, turn: { message: P.C6, added: [] } } as any);
  eq(out.counts.applied, out.applied.length);
  ok(/Say the numbers in counts exactly/.test(out.note));
  const s = scripted((_p, n) => n === 0 ? use("read_application_mail", {}) : text(LIVE8.C6.reply.replace("9. Bank A", "9. Bank A").replace(/\d+ applications/, `${out.counts.applied - 1} applications`)));
  const r: any = await turn(P.C6, s.model, { capabilities: caps });
  ok(new RegExp(`shows ${out.counts.applied} applications`).test(r.reply) && !/miscount/i.test(r.reply), r.reply);
});

// ---------------------------------------------------------------- D71-8 market rate
Deno.test("D71-8 C22: a going-rate ask runs sourced research beside the posting pay already shown", async () => {
  ok(/I can pull public pay data/.test(LIVE8.C22.reply) && LIVE8.C22.trace.called.length === 0, "live-8 C22: no research ran");
  for (const m of [P.C22, "what's the market rate for data analysts in austin", "how much do new grad swes make in nyc"]) ok(marketRateAskOf(m), m);
  for (const m of [P.C7, P.C11, "what does the paypal posting pay?", P.C13]) ok(!marketRateAskOf(m), m);
  const check = processCheck({ draftAsk: false, planSearch: false, parts: [], marketRate: true })!;
  ok(/research_market now/.test(check(LIVE8.C22.reply, []) ?? ""));
  eq(check(LIVE8.C22.reply, [{ name: "research_market", ok: true }]), null);
  // The turn: the model answers with the posting pay only; code asks for research once; the research runs.
  const levels = Object.entries(WEB).slice(4, 6).map(([url, p]) => ({ url, title: p.title, text: p.text }));
  const draft = JSON.stringify({ title: "SWE intern pay, Chicago", summary: levels.map((p) => ({ text: p.text, quote: p.text, url: p.url })) });
  const s = scripted((p, n) => n === 0 ? text(LIVE8.C22.reply) : n === 1 ? use("research_market", { question: P.C22, format: "inline", queries: ["software engineer intern hourly pay Chicago"] })
    : text("Self-reported intern pay in Chicago: Relativity interns report $32 per hour [1] and CME Group interns $34 per hour [2], self-reported and can lag."));
  const r: any = await agentTurn({ message: P.C22, history: [], stores: { profile: personaProfile() }, userId: "u-d071", threadId: "th", now: NOW, model: s.model, market: marketDeps(levels, () => draft) } as any);
  ok(s.seen.some((x) => /They asked for the going rate/.test(x.system)), "code asked for research once");
  ok(r.tool_calls.some((c: any) => c.name === "research_market" && c.ok), JSON.stringify(r.tool_calls));
  ok(/\$32/.test(r.reply) && r.reply.includes(levels[0].url), r.reply);
});
