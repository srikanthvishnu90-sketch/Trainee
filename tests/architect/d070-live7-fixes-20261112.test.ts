// D-070 (architect, 2026-11-12): the fixes for live-7 (PR #789: batch 1 on trunk 44b436f9, 6/24 scored turns pass wa-1/d066) and the
// D-068 real-model measures (real-set research 11/20, d054 memory 40/50, practice G2 19/24 and G3 5/24). Each test reproduces the
// observed failure at $0 from what the live runs recorded (the live-7 transcript, the real-set recordings, the d054 result files'
// replies) with a scripted model returning the observed shape, and names the ruling it serves (P3). No network, no spend, nothing sent.
//   D70-1  research (item 10, C9, C23; owner must-fix "never blank research"): a draft cut off at its token limit keeps its whole
//          lines; a quote that leaves out a page's reference markers is on its page; the company's name may be a line's subject.
//   D70-2  C10 (owner must-fix "don't drop resume experience"): the FIRST tailored version prints every confirmed entry (the ones
//          the posting does not ask for on one line each), on one page, with no skill twice (D-069 aliases).
//   D70-3  setup / G9 (D-007): "the 3.9 gpa on there is outdated, don't reuse it" is a correction of a stored fact: it routes to
//          the brain's correction path and code sets the fact aside, so the GPA is never used again.
//   D70-4  C11, C22 (D-067 (6), owner must-fix (d)): a posting's pay said in a reply carries that posting's link whichever tool
//          read it; pay the conversation already showed is restated with its link.
//   D70-5  G3 (live-7: 13 of 24 far over): the trace records what the length pass did; a numbered list's markers no longer block a
//          faithful shortening; a turn that only made a File or resume is shortened too, its changes said in one line.
//   D70-6  d054 9b (M08, code): the corrected answer is read back once, not twice in two wordings.
//   D70-7  item 11 (G2, G3, G1): a practice question said any way is the question kind (200 to 300 characters) and the brain's;
//          an answer to it is reviewed verdict first.
//   D70-8  C1, C3: "chicago or remote" searches each place; the remote posting is returned (a related role, said to be one).
//   D70-9  C1 (owner must-fix (e)): a refused create_file is asked again with its reason, and the File's link reaches the turn.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/d070-live7-fixes-20261112.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { CareerRouter } from "../../supabase/functions/_shared/router_core.career.js";
import { agentTurn, onlyFileWrites, payWithSource, shortenedOk } from "../../supabase/functions/agent-chat/career_brain.ts";
import { stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { parseDraft, readAlike, RESEARCH_DRAFT_MAX_TOKENS } from "../../supabase/functions/_shared/agent/research/draft_json.ts";
import { enforceCompanyReply, researchCompany } from "../../supabase/functions/_shared/agent/research/company.ts";
import { agrees, enforceMarketReply, researchMarket } from "../../supabase/functions/_shared/agent/research/market.ts";
import { edgeRenderer, memoryResumeStore, tailorForPosting, withListedSkills } from "../../supabase/functions/_shared/career_tailor.ts";
import { askedPartsOf, overLimit, partsMissing, practiceAnswerOf, practiceAskOf, replyKind, replyLength, shownPayOf, staleFactsOf, textLength } from "../../supabase/functions/_shared/agent/turn_notes.ts";
import { orAlternatives, searchAlternatives } from "../../supabase/functions/_shared/career_search.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { capabilityTools } from "../../supabase/functions/_shared/agent/capability_tools.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { POSTINGS } from "../../evals/mirror/instinct-wa-batch1/world.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const DIR = new URL("../../evals/mirror/instinct-wa-batch1/", import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, DIR)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const P: Record<string, string> = Object.fromEntries(read("prompts.jsonl").map((t: any) => [t.id, t.prompt]));
const PERSONA = JSON.parse(Deno.readTextFileSync(new URL("persona.json", DIR)));
// live-7's own replies (the transcript the run recorded, PR #789), used as the brain's observed output.
const LIVE7: Record<string, string> = Object.fromEntries(read("results/live-7/trainee-live-7.jsonl").map((t: any) => [t.id, t.reply]));
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
// The persona's confirmed profile: its resume and its yes, through the router (setup-0, setup-1).
function personaProfile() {
  const ctx: any = { now: NOW, thread: {} };
  for (const s of PERSONA.setup.slice(0, 2)) CareerRouter.handleChat(s, ctx);
  return ctx.profile;
}
const turn = (message: string, model: any, extra: Record<string, unknown> = {}) =>
  agentTurn({ message, history: [], stores: { profile: personaProfile() }, userId: "u-d070", threadId: "th-d070", now: NOW, model, ...extra } as any);

// ---------------------------------------------------------------- D70-1 research
const REC = new URL("../../evals/real-sets/research/", import.meta.url);
const sentencesOf = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length >= 40 && s.length <= 300 && /[a-z]/.test(s) && !/https?:\/\//.test(s));
// The observed shape (real-set live run 43192205798): a full draft (the briefs that stood dropped 14 to 21 lines and kept 2 to 4,
// so the model wrote about 20 to 25 lines), cut where the call's 1,800 output tokens ran out (about 3.6 characters a token).
function cutDraft(pages: { url: string; text: string }[], company: string) {
  const all = pages.flatMap((p) => sentencesOf(p.text).map((s) => ({ text: s, quote: s, url: p.url })));
  const lines = Array.from({ length: 21 }, (_, k) => all[k % all.length]);
  const d = { title: `${company} interview brief`, frame: { text: `${company} hires engineers who work with finance teams.`, urls: [pages[0].url] }, business: lines.slice(0, 6), role: lines.slice(6, 11),
    developments: lines.slice(11, 16).map((l) => ({ ...l, date: "2026" })), competitors: [], tensions: lines.slice(16, 21).map((l) => ({ area: "growth", area_quote: l.quote, a: "speed", b: "risk", urls: [l.url] })), unknowns: ["The team's day-to-day work"] };
  const whole = JSON.stringify(d, null, 1);
  return { whole, cut: whole.slice(0, Math.round(1800 * 3.6)) };
}

Deno.test("D70-1 research (item 10, C9, C23): a cut-off draft keeps its whole sourced lines; never 'none stated anything' after reading pages", async () => {
  const rec = JSON.parse(Deno.readTextFileSync(new URL("recorded/R05.json", REC)));
  const c = rec.case;
  const pages = (rec.read.verified as any[]).filter((v) => v.status === 200).map((v) => ({ url: v.url, text: String(v.text ?? "") }));
  const { whole, cut } = cutDraft(pages, c.company);
  ok(whole.length > cut.length, "the observed draft is longer than the 1,800-token cap");
  assertNode.throws(() => JSON.parse(cut), "before D-070 this draft parsed to nothing, so every line was lost");
  const p = parseDraft(cut);
  eq(p.how, "salvaged");
  ok(Array.isArray(p.value.business) && p.value.business.length >= 3, JSON.stringify(p.value).slice(0, 200));
  ok(p.value.business.every((b: any) => b.text && b.quote && b.url), "only whole items are kept; the cut-off item is left out");
  eq(parseDraft(`Here is the brief:\n${whole}`).how, "whole", "prose before the JSON is not the JSON");
  eq(parseDraft("I can't write that.").value, null);
  const deps = (draft: string) => ({ search: { id: "first_party", needsKey: false, search: async () => rec.search }, read: async () => rec.read, draft: async () => draft });
  const ask = { company: c.company, role: c.role, question: `Research ${c.company} before my interview for the ${c.role} role.`, plan: rec.plan, now: Date.UTC(2026, 10, 12, 15), format: "inline" as const };
  const r: any = await researchCompany({ ...ask, deps: deps(cut) as any });
  eq(r.status, "ok", JSON.stringify(r).slice(0, 300));
  const kept = [...r.business, ...r.role_asks];
  ok(kept.length >= 3 && kept.every((l: any) => l.cite.length > 0), `${kept.length} sourced lines stand`);
  for (const l of kept) { const s = r.sources.find((x: any) => x.n === l.cite[0]); ok(pages.find((pg) => pg.url === s.url)!.text.replace(/\s+/g, " ").includes(l.text), l.text); }
  const reply = enforceCompanyReply("", r);
  ok(/\[1\]/.test(reply) && reply.includes(r.sources[0].url), "the chat answer carries its numbered sources");
  // Every one of the 20 recorded real-set cases (evals/real-sets/research/recorded), its draft cut off before its end: each draft
  // parsed to nothing before D-070 (9 of 20 live briefs were "no_sources"); each now gives a brief from its whole lines.
  for (let k = 1; k <= 20; k++) {
    const rk = JSON.parse(Deno.readTextFileSync(new URL(`recorded/R${String(k).padStart(2, "0")}.json`, REC)));
    const pk = (rk.read.verified as any[]).filter((v) => v.status === 200).map((v) => ({ url: v.url, text: String(v.text ?? "") }));
    const w = cutDraft(pk, rk.case.company).whole, cutK = w.slice(0, Math.floor(w.length * 0.7));
    assertNode.throws(() => JSON.parse(cutK), rk.case.id);
    const rr: any = await researchCompany({ company: rk.case.company, role: rk.case.role, question: `Research ${rk.case.company}.`, plan: rk.plan, now: Date.UTC(2026, 10, 12, 15), format: "inline", deps: { search: { id: "first_party", needsKey: false, search: async () => rk.search }, read: async () => rk.read, draft: async () => cutK } as any });
    eq(rr.status, "ok", `${rk.case.id}: ${rr.blocker ?? ""}`);
  }
  // The cap the draft call now runs at (handler-career.ts and the real-set live run): room for a full brief.
  eq(RESEARCH_DRAFT_MAX_TOKENS, 4000);
  for (const f of ["../../supabase/functions/agent-chat/handler-career.ts", "../../evals/real-sets/research/run.ts"]) ok(/max_tokens: RESEARCH_DRAFT_MAX_TOKENS/.test(Deno.readTextFileSync(new URL(f, import.meta.url))), f);
  // Wikipedia's reference markers and typographic dashes never keep a word-for-word quote off its page.
  const wiki = "Coinbase Global, Inc. is an American company[1] that operates a cryptocurrency exchange platform.[2] It was founded in 2012 by Brian Armstrong and Fred Ehrsam.[3] The company went public on April 14, 2021 – on the Nasdaq.";
  ok(agrees("Coinbase operates a cryptocurrency exchange platform.", "is an American company that operates a cryptocurrency exchange platform.", wiki, "Coinbase"));
  ok(agrees("It went public on April 14, 2021 on the Nasdaq.", "The company went public on April 14, 2021 - on the Nasdaq.", wiki));
  ok(!agrees("Coinbase operates a stock exchange.", "is an American company that operates a cryptocurrency exchange platform.", wiki, "Coinbase"), "the subject is the only word allowed in");
  eq(readAlike("a b—c[12] d[citation needed]"), "a b-c d");
  // C9 (market research, the brain's own turn): culture, pay and process, each a sourced line, from a draft cut at the cap.
  const page = { url: "https://careers.example.test/swe-new-grad", text: "The base salary range for this role is $150,000 to $200,000. The interview process has a first-round interview, then three interviews and team matching. Our culture is described as fast paced, with high standards and direct feedback." };
  const draft = JSON.stringify({ title: "New grad SWE", thesis: "The posting states pay, the interview steps and the culture.", summary: [
    { text: "The base salary range for this role is $150,000 to $200,000.", quote: "The base salary range for this role is $150,000 to $200,000.", url: page.url },
    { text: "The interview process has a first-round interview, then three interviews and team matching.", quote: "The interview process has a first-round interview, then three interviews and team matching.", url: page.url },
    { text: "The culture is described as fast paced, with high standards and direct feedback.", quote: "Our culture is described as fast paced, with high standards and direct feedback.", url: page.url },
    { text: "Engineers there describe long weeks, and teams say the hours vary widely by desk and by season.", quote: "Engineers there describe long", url: page.url }] });
  const m: any = await researchMarket({ question: P.C9, format: "inline", plan: { queries: ["x"] } as any, deps: { search: { id: "t", needsKey: false, search: async () => ({ hits: [{ url: page.url, title: "SWE new grad", provider: "t", foundAt: NOW }], notes: [], provider: "t" }) }, read: async () => ({ verified: [{ url: page.url, requested: page.url, status: 200, title: "SWE new grad", text: page.text, fetchedAt: NOW }], rejected: [] }), draft: async () => draft.slice(0, draft.length - 60), layout: "messages" } as any });
  eq(m.status, "ok", JSON.stringify(m).slice(0, 300));
  eq(m.points.length, 3, "the three whole lines stand; the cut-off fourth is left out");
  const said = enforceMarketReply("Pay: the base salary range for this role is $150,000 to $200,000 [1].\n\nInterview process: a first-round interview, then three interviews and team matching [1].\n\nCulture: described as fast paced, with high standards and direct feedback [1].", m);
  eq(partsMissing(said, askedPartsOf(P.C9)), [], "pay, process and culture are each covered");
  ok((said.match(/https:\/\/careers\.example\.test/g) ?? []).length === 3, "each part with its source link");
});

// ---------------------------------------------------------------- D70-2 tailoring
Deno.test("D70-2 C10 (owner must-fix): the first tailored version keeps every confirmed role, one page, no skill twice", async () => {
  ok(/I dropped Rallyup, Waypoint, Harbor Global, Mindgrove, Elmstead, Ondo/.test(LIVE7.C10) && /repeats TypeScript\/JavaScript/.test(LIVE7.C10), "live-7's C10");
  const profile = personaProfile(), p = POSTINGS[0];
  const r: any = await tailorForPosting({ userId: "00000000-0000-4000-8000-000000001170", profile, posting: { text: `${p.title} at ${p.company}\n\n${p.description}`, job_id: p.id, company: p.company },
    deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW, reviewDraft: true });
  ok(r.ok, JSON.stringify(r).slice(0, 300));
  const printed = new Set(r.detail.doc.lines.flatMap((l: any) => l.factIds || []).map(String));
  const entries = profile.facts.filter((f: any) => ["experience", "project", "education", "leadership", "certification"].includes(f.kind) && f.status === "confirmed");
  ok(entries.length >= 10, `${entries.length} confirmed entries`);
  for (const f of entries) ok(printed.has(String(f.id)), `${f.title || f.text} prints`);
  ok(!r.changes.some((c: any) => c.kind === "drop"), JSON.stringify(r.changes));
  ok(/Every entry on your record prints: the 7 this posting doesn't ask for are one line each/.test(r.changelog), r.changelog);
  // One line each: an entry the posting does not ask for prints no bullet lines.
  for (const l of r.detail.doc.lines.filter((x: any) => x.type === "bullet")) ok(!/Rallyup|Ondo|Elmstead/.test(l.text), l.text);
  const pdf = new TextDecoder("latin1").decode(r.detail.pdf);
  eq((pdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length, 1, "one page");
  const skills = r.detail.doc.lines.find((l: any) => l.type === "skills").text as string;
  eq(skills, "Python, JavaScript, TypeScript, React, SQL");
  ok(!/TypeScript\/JavaScript/.test(skills));
  // The rule itself: an alias or an A/B pair already on the line is not added again; a new skill still is.
  const resume = { sections: [{ heading: "Skills", lines: [{ text: "JS, TypeScript", factIds: ["s1"], type: "skills" }] }] };
  const own = { facts: [{ id: "s2", kind: "skill", name: "TypeScript/JavaScript", status: "confirmed" }, { id: "s3", kind: "skill", name: "JavaScript", status: "confirmed" }, { id: "s4", kind: "skill", name: "SQL", status: "confirmed" }] };
  eq(withListedSkills(resume, own).sections[0].lines[0].text, "JS, TypeScript, SQL");
  // An edited version still keeps every entry with its own lines (D-067 (a), unchanged).
  const e: any = await tailorForPosting({ userId: "00000000-0000-4000-8000-000000001170", profile, posting: { text: `${p.title} at ${p.company}\n\n${p.description}`, job_id: p.id, company: p.company },
    deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW, reviewDraft: true, edits: [{ role: "pixelforge", lines: 1 }] });
  ok(e.ok && /Every other entry on your record still prints/.test(e.changelog), e.changelog);
});

// ---------------------------------------------------------------- D70-3 stale fact
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment });
const STAGED = { get: (k: string) => ({ CAREER_BRAIN: "staged" } as Record<string, string>)[k] };
function hostTurns(turns: string[]) {
  let snap: unknown = null, ctx: any = null;
  const out: { intent: string; reply: string }[] = [];
  for (const m of turns) {
    ctx = host.createTurnCtx({ userId: "u-d070", threadId: "t-d070", now: NOW, snapshot: snap, accountPersistence: true });
    const r = host.runTurn(m, ctx);
    snap = host.extractSnapshot(ctx);
    out.push({ intent: String(r.intent), reply: String(r.reply) });
  }
  return { out, next: () => host.createTurnCtx({ userId: "u-d070", threadId: "t-d070", now: NOW, snapshot: snap, accountPersistence: true }) };
}

Deno.test("D70-3 setup (G9/D-007): 'the 3.9 gpa on there is outdated, don't reuse it' is a correction: routed to the brain, and the GPA is set aside", async () => {
  const said = PERSONA.setup[2];
  const h = hostTurns(PERSONA.setup.slice(0, 2));
  const ctx = h.next();
  const gpa = (ctx.profile.facts as any[]).find((f) => /GPA/.test(String(f.text)));
  ok(gpa && gpa.status === "confirmed", "the GPA was confirmed with the resume");
  eq(staleFactsOf(said, ctx.profile.facts).map((f: any) => f.text), ["GPA: 3.9"]);
  // Before D-070 the router answered it as an internship search (live-7 setup-2: career_internship_discovery).
  eq(host.runTurn(said, h.next()).intent, "career_internship_discovery", "the router's own reading");
  const d = stagedDecision({ env: STAGED, message: said, ctx: h.next(), host, structured: false });
  eq([d.brain, d.reason], [true, "stale_fact_correction"]);
  // Uncertainty is not a withdrawal; nor is a fact the sentence does not name.
  eq(staleFactsOf("Harbor dates on my resume might conflict and I'm not 100% sure of Crestline's name.", ctx.profile.facts), []);
  eq(staleFactsOf("my old school's site is outdated", ctx.profile.facts), []);
  // The brain's turn: code sets the GPA aside before the model runs, and tells it.
  const stores = { profile: ctx.profile };
  const s = scripted(() => text("Got it: the 3.9 GPA is off your record and won't be used. I'm searching SWE internships in Chicago or remote next."));
  const r = await agentTurn({ message: said, history: [], stores, userId: "u-d070", threadId: "th", now: NOW, model: s.model } as any);
  ok(/OUT OF DATE/.test(s.seen[0].system) && /GPA:? 3\.9/.test(s.seen[0].system), "the model is told");
  const after = (stores.profile.facts as any[]).find((f) => f.id === gpa.id);
  eq([after.status, after.needs_confirmation], ["draft", true]);
  ok(after.withdrawn_by_owner?.said.includes("outdated"));
  ok(r.reply.length > 0);
  // Never used again: not in what tailoring and answers run on.
  const p = POSTINGS[0];
  const t: any = await tailorForPosting({ userId: "00000000-0000-4000-8000-000000001170", profile: stores.profile, posting: { text: `${p.title} at ${p.company}\n\n${p.description}`, job_id: p.id, company: p.company },
    deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW, reviewDraft: true });
  ok(t.ok && !JSON.stringify(t.detail.doc.lines).includes("3.9"), "the GPA never prints");
});

// ---------------------------------------------------------------- D70-4 pay with its source
Deno.test("D70-4 C11, C22 (D-067 (6), must-fix (d)): pay from any posting read carries its link; shown pay is restated with its link", async () => {
  const p = POSTINGS[0];
  ok(/For Chicago the pay is \$28-\$49 hourly/.test(LIVE7.C11) && !LIVE7.C11.includes(p.url), "live-7's C11: the figure, no link");
  // C11: the posting was read by inspect_apply_flow (not search_jobs), and the sentence does not name PayPal again.
  const flow = { status: "ok", board: "workday", url: p.url, posting: { title: p.title, company: "PayPal", location: "Chicago, IL", pay: "$28- $49 Hourly (Chicago, Illinois)", deadline: null, deadline_text: null, state: "open" },
    requirements: { required: [], preferred: [] }, questions: null, questions_read: "sign_in", questions_why: "behind sign-in", entry: [], sign_in_required: true, captcha_expected: false, reads: [], why: "", boundary: "Read only." };
  const s = scripted((_p, n) => n === 0 ? use("inspect_apply_flow", { url: p.url }) : text(LIVE7.C11));
  const r = await turn(P.C11, s.model, { applyFlow: async () => flow });
  ok(r.reply.includes(p.url) && /\$28-\$49/.test(r.reply), r.reply);
  eq(payWithSource("PayPal is hiring.", [{ company: "PayPal", pay: "$28-$49", url: p.url }]), "PayPal is hiring.", "no figure, no link");
  eq(payWithSource("The range is $28-$49.", [{ company: "PayPal", pay: "$28-$49", url: p.url }, { company: "NVIDIA", pay: "$40-$60", url: "https://nvidia.example/x" }]), "The range is $28-$49.", "two postings: the sentence must name its employer");
  // C22: the pay C1 showed (with the Workday link) answers the ask; live-7's reply named the posting and gave no figure.
  const history = [{ role: "user", content: P.C1 }, { role: "assistant", content: LIVE7.C1 }];
  const shown = shownPayOf(P.C22, history as any);
  ok(shown.some((l) => /\$28-\$49/.test(l.text) && l.url === p.url), JSON.stringify(shown));
  const restated = "PayPal's Chicago posting lists $28-$49 hourly; that is one posting's range, not a market rate. I don't have a verified going rate beyond it.";
  const s2 = scripted((_p, n) => n === 0 ? text(LIVE7.C22) : text(restated));
  const r2 = await agentTurn({ message: P.C22, history, stores: { profile: personaProfile() }, userId: "u", threadId: "t", now: NOW, model: s2.model } as any);
  ok(s2.seen.some((x) => /already showed pay that answers this ask/.test(x.system)), "one review asks for the shown pay");
  ok(r2.reply.startsWith(restated) && r2.reply.includes(p.url), r2.reply);
});

// ---------------------------------------------------------------- D70-5 length
// A faithful shortener (it only deletes): the list written as sentences (markers removed), then whole sentences without a figure,
// link, boundary, caveat or question dropped from the end until the text is within the bound.
function faithful(long: string, bound: number): string {
  const ss = long.replace(/^[ \t]*\d{1,2}[.)][ \t]+/gm, "").split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const must = (x: string, k: number) => k === 0 || /\d|https?:\/\/|\?$|\b(?:not|never|nothing|no|haven'?t|couldn'?t|can'?t|don'?t|won'?t|unverified|unconfirmed)\b/i.test(x);
  const keep = ss.map((x, k) => ({ x, m: must(x, k) }));
  for (let k = keep.length - 1; k >= 0 && textLength(keep.map((y) => y.x).join(" ")) > bound; k--) if (!keep[k].m) keep.splice(k, 1);
  return keep.map((y) => y.x).join(" ");
}
Deno.test("D70-5 G3: the trace says what the length pass did; list markers no longer block it; a File turn is shortened too", async () => {
  const readTool = { name: "get_situation_test", effect: "read", description: "read (test)", input_schema: { type: "object", properties: {} }, run: async () => ({ ok: true }) };
  let accepted = 0;
  for (const id of ["C11", "C12", "C15", "C17"]) {
    const reply = LIVE7[id], bound = overLimit(replyLength(P[id]));
    ok(textLength(reply) > bound, `${id} was over its bound`);
    const short = faithful(reply, bound);
    const s = scripted((_p, n) => n === 0 ? use("get_situation_test", {}) : text(reply), () => short);
    const r: any = await turn(P[id], s.model, { capabilities: [readTool] });
    eq(r.shorten.ran, true, `${id}: ran`);
    ok(["accepted", "rejected"].includes(r.shorten.outcome) && (r.shorten.outcome === "accepted" || r.shorten.why.length > 0), `${id}: ${JSON.stringify(r.shorten)}`);
    if (r.shorten.outcome === "accepted") { accepted++; eq(r.reply, short); ok(textLength(r.reply) <= bound); }
  }
  // C11 and C15 carry numbered lists: before D-070 their markers ("1." to "5.") were figures the shorter text had to keep.
  ok(shortenedOk("Here is what I need:\n1. Your email.\n2. Your yes. Nothing was sent.", "I need your email and your yes. Nothing was sent.", 200), "a list written as sentences is faithful");
  ok(accepted >= 2, `${accepted} of live-7's four long answers shortened`);
  // Within the bound, or skipped, it says so.
  const s0 = scripted(() => text("Short answer. Nothing was sent."));
  eq(((await turn("what should i do this week?", s0.model)) as any).shorten.outcome, "within");
  // A turn that only made a File (export_tracker, live-7 C16: 714 characters against 550) is shortened, its changes in one line.
  const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-d070-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
  const files = createFileService({ store: memoryFileStore(), env: { get: (k: string) => ENV[k] }, now: () => NOW });
  const caps = capabilityTools({ mail: { applications: async () => [], events: async () => [] } as any, tracking: false, accounts: async () => [], cursor: null, readNow: null, connectUrl: "https://trainee.example/connect", situation: null, snapshot: null, files, people: null, inbox: null, reply: null });
  const c16 = LIVE7.C16, b16 = overLimit(replyLength(P.C16)), short16 = faithful(c16, b16);
  const s16 = scripted((_p, n) => n === 0 ? use("export_tracker", {}) : text(c16), () => short16);
  const r16: any = await agentTurn({ message: P.C16, history: [], stores: { profile: personaProfile() }, userId: "33333333-3333-4333-8333-333333333370", threadId: "th", now: NOW, model: s16.model, capabilities: caps } as any);
  eq(r16.tool_calls.map((c: any) => [c.name, c.ok]), [["export_tracker", true]]);
  ok(onlyFileWrites(r16));
  eq(r16.shorten.ran, true, JSON.stringify(r16.shorten));
  ok(s16.seen.some((x) => !x.tools?.length && /changes in ONE line/.test(x.system)), "the File turn's pass says its changes in one line");
  // A record write is still never shortened.
  ok(!onlyFileWrites({ reply: "x", pending_approvals: [], tool_calls: [{ name: "add_profile_fact", ok: true, effect: "write_own" }, { name: "create_file", ok: true, effect: "write_own" }] } as any));
  // The runner records it (evals/mirror/run-conversation.ts trace.shorten, trace.call_errors).
  const runner = Deno.readTextFileSync(new URL("../../evals/mirror/run-conversation.ts", import.meta.url));
  ok(/shorten: meta\.shorten/.test(runner) && /call_errors:/.test(runner));
});

// ---------------------------------------------------------------- D70-6 memory corrections (d054 9b)
Deno.test("D70-6 d054 M08 (code): the corrected answer first, each fact read back once", () => {
  const { out } = hostTurns(["I will need visa sponsorship", "Actually I don't need visa sponsorship. I'm a US citizen.", "do I need sponsorship?"]);
  const r = out[2].reply;
  ok(/^No: you told me you don't need visa sponsorship\./.test(r), r);
  // d054 run 43194037044, passes 1, 4 and 5: the same record read back twice in two wordings.
  const LIVE = 'No: you told me you don\'t need visa sponsorship.\nOn record: work authorization — "I don\'t need visa sponsorship". On record: you do not need visa sponsorship.';
  eq((LIVE.match(/need visa sponsorship/g) ?? []).length, 3);
  ok(!/On record: you do not need (?:visa )?sponsorship\./.test(r), r);
  eq((r.match(/On record: work authorization — "I don't need visa sponsorship"\./g) ?? []).length, 1, r);
});

// ---------------------------------------------------------------- D70-7 practice
Deno.test("D70-7 item 11 (G2/G3/G1): a practice question said any way is the question kind and the brain's; an answer to it is reviewed verdict first", async () => {
  for (const m of ["mock interview time: one sql question, then wait for me", "give me a real swe interview question on graphs, just one", "one python interview question please, real interview style", "cool, harder one, same topic", P.C5]) {
    ok(practiceAskOf(m), m);
    eq(replyKind(m), "question", m);
  }
  for (const m of [P.C9, P.C17, P.C4, "what's the interview process at stripe?"]) ok(!practiceAskOf(m), m);
  eq(replyLength("mock interview time: one sql question").upper, 300);
  const d = stagedDecision({ env: STAGED, message: "mock interview time: one sql question, wait for my answer", ctx: hostTurns([]).next(), host, structured: false });
  eq(d.brain, true, JSON.stringify(d));
  const history = [{ role: "user", content: P.C5 }, { role: "assistant", content: LIVE7.C5 }];
  ok(practiceAnswerOf(P.C5f1, history as any), "an answer to the question asked");
  ok(!practiceAnswerOf(P.C6, [{ role: "user", content: P.C6 }, { role: "assistant", content: "Nine applications. Want a tracker?" }] as any), "not in a practice session");
  const s = scripted(() => text("Partly right: counting works, but it answers a different question."));
  await agentTurn({ message: P.C5f1, history, stores: { profile: personaProfile() }, userId: "u", threadId: "t", now: NOW, model: s.model } as any);
  ok(/FIRST sentence is your verdict/.test(s.seen[0].system), "the review note");
});

// ---------------------------------------------------------------- D70-8 chicago or remote
Deno.test("D70-8 C1, C3: 'chicago or remote' searches each place, and the remote posting is returned", async () => {
  eq(orAlternatives("software engineer intern chicago or remote"), ["software engineer intern chicago", "software engineer intern remote"]);
  eq(orAlternatives("data analyst"), ["data analyst"]);
  const pool = POSTINGS.map((x) => ({ job_id: x.id, company: x.company, title: x.title, location: x.location, url: x.url, description: x.description, first_seen_at: "2026-11-06T00:00:00Z" }));
  const r = searchAlternatives(pool, orAlternatives("software engineer intern chicago or remote"), null);
  eq(r.postings.map((x) => x.company).sort(), ["NVIDIA", "PayPal"]);
  // Through the tool, with the database search's every-word rule (memoryPostingsDb's rule, career_ingest.ts matchesWords).
  const { searchWords, matchesWords } = await import("../../supabase/functions/_shared/career_ingest.ts");
  const tools = Object.fromEntries(careerTools({ postings: async (q: string) => pool.filter((p) => matchesWords(p, searchWords(q))) } as any).map((t: any) => [t.name, t]));
  const before = pool.filter((p) => matchesWords(p, searchWords("software engineer intern chicago or remote")));
  eq(before.length, 0, "before: every word, chicago AND remote, matched nothing");
  const out: any = await tools.search_jobs.run({ query: "software engineer intern chicago or remote" }, { userId: "u", threadId: "t", now: NOW, state: {} } as any);
  eq(out.postings.map((x: any) => x.company).sort(), ["NVIDIA", "PayPal"]);
  const nv = out.postings.find((x: any) => x.company === "NVIDIA");
  ok(/Remote/.test(nv.location) && /related role/.test(out.note_or), "the remote role, said to be related when its title is not the role asked");
});

// ---------------------------------------------------------------- D70-9 the plan File's link
Deno.test("D70-9 C1 (must-fix (e)): a refused create_file is asked again with its reason, and the File's link reaches the turn", async () => {
  const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
  const files = createFileService({ store: memoryFileStore(), env: { get: (k: string) => ENV[k] }, now: () => NOW });
  const bad = { title: "SWE internship plan", variant: "pipeline", period: "This week", sections: [{ heading: "Apply", items: [{ label: "PayPal", value: "Apply this week." }] }] };
  const good = { ...bad, sections: [{ heading: "Apply", items: [{ label: "PayPal", value: "Apply this week.", source: "From you" }] }] };
  // live-7 C1's calls: search_jobs, then create_file (refused), then a reply with no File; the review then asks again.
  const s = scripted((_p, n) => [use("search_jobs", { query: "software engineer intern" }), use("create_file", { kind: "plan_review", data: bad }, "t2"), text("Search found 1 posting. Fix the GPA line first."),
    use("create_file", { kind: "plan_review", data: good }, "t3"), text("Fix the GPA line, then apply to PayPal; the plan is in the file.")][n] ?? text("ok"));
  const r: any = await turn(P.C1, s.model, { files, postings: async () => [] });
  eq(r.tool_calls.map((c: any) => [c.name, c.ok]), [["search_jobs", true], ["create_file", false], ["create_file", true]]);
  ok(s.seen.some((x) => /Your create_file call was refused/.test(x.system)), "the review names the refusal");
  eq(r.fileLinks?.length, 1);
  ok(r.fileLinks[0].startsWith("https://trainee.example/file?t=v1."));
});
