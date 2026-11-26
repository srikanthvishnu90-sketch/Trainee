// Product fixes found while amending the tests for the research support check switched on (owner decision 2026-11-13), group B's
// report: $0, flag on, no network. Red on origin/ag/research-support-on (b0610b78c), green here.
import { assert as ok, assertEquals as eq } from "jsr:@std/assert@1";
import { FAIL_CLOSED } from "../../../supabase/functions/_shared/agent/research/market.ts";
import { researchCompany } from "../../../supabase/functions/_shared/agent/research/company.ts";
import { stripUrls } from "../../../supabase/functions/_shared/agent/research/reply.ts";
import { decide, indexPages, type SupportJudge } from "../../../supabase/functions/_shared/agent/research/support.ts";
import { NOW, world as world0 } from "../../helpers/research_company_web.ts";
import { supportsClaim, testSupportJudge } from "../support-test-judge.ts";

FAIL_CLOSED.support = true;
const world = () => { const w = world0(); w.deps = { ...w.deps, judge: testSupportJudge }; return w; };
const T1 = "I have an interview at Stripe next week. Help me prepare.";
const plan = { queries: ["Stripe"], companies: ["Stripe"], sites: ["stripe.example"] };

Deno.test("fix 1: a link at a sentence's end keeps the sentence's full stop when it is taken out", () => {
  eq(stripUrls("I put it in the file https://evil.example/x. What role are you interviewing for?"), "I put it in the file. What role are you interviewing for?");
  eq(stripUrls("See www.evil.example/a, then reply."), "See, then reply.");
  eq(stripUrls("Read [the page](https://evil.example/x). Then ask."), "Read the page. Then ask.");
  eq(stripUrls("Visit https://evil.example/x"), "Visit");
});

Deno.test("fix 2 and 3: developments are one line per page unit; questions, unknowns and the labelled reading are kept, unjudged, under their own code checks", async () => {
  const w = world();
  const r: any = await researchCompany({ company: "Stripe", role: "Data analyst internship", question: T1, plan, deps: w.deps, now: NOW });
  eq(r.status, "ok");
  const texts = r.developments.map((d: any) => d.text);
  eq(texts.length, new Set(texts).size, "no development twice");
  eq(texts.length, 2);
  ok(r.questions.length >= 1 && r.questions.every((q: any) => /^Your team is working on .+\. How do you decide between .+ and .+\?$/.test(q.text)), JSON.stringify(r.questions));
  ok(r.unknowns.length >= 1, "the model's unknowns are shown");
  ok(r.frame && /payments plus software/.test(r.frame.text), "Trainee's labelled reading is shown");
  // Still never an unchecked figure or an invented initiative (each keeps its own code check).
  ok(!/crypto|3%|acceptance rate|revenue was|reached a \$1 billion/i.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 400));
  // focus "questions" for the hiring manager: the questions are built, so the File has its section.
  const r3: any = await researchCompany({ company: "Stripe", role: "Data analyst internship", question: "more questions for the hiring manager", focus: "questions", audience: "hiring manager", plan, deps: w.deps, now: NOW } as any);
  eq(r3.status, "ok");
  ok(r3.questions.length >= 2, JSON.stringify(r3.questions));
});

Deno.test("fix 3: \"none stated anything the brief could quote\" is said only when drafted lines were judged and refused", async () => {
  const empty = world(); empty.deps = { ...empty.deps, draft: async () => "{}" };
  const a: any = await researchCompany({ company: "Stripe", question: T1, plan, deps: empty.deps, now: NOW, focus: "competitors" } as any);
  if (a.status === "no_sources") ok(!/none stated anything the brief could quote/.test(a.blocker), a.blocker);
  const no = world(); no.deps = { ...no.deps, judge: async (cs) => cs.map(() => "no" as const), draft: async () => JSON.stringify({ competitors: [{ name: "Adyen", text: "Adyen competes with Stripe.", quote: "Adyen", url: "https://stripe.example/" }] }) };
  const b: any = await researchCompany({ company: "Stripe", question: T1, plan, deps: no.deps, now: NOW, focus: "competitors" } as any);
  if (b.status === "no_sources") ok(/none stated anything the brief could quote/.test(b.blocker), b.blocker);
  ok(a.status === "no_sources" || b.status === "no_sources", "at least one case reaches the blocker");
});

Deno.test("fix 4: the unit the draft cited is tried first; when the claim is refused, that unit (not the header) is offered as the quote", async () => {
  const page = "Posting on Zentrafin's Greenhouse job board (token zentrafin): Data Analyst Intern, Chicago, IL. The posting says: You will build dashboards for the payments team and define metrics for checkout conversion.";
  const idx = indexPages([{ text: page, title: "Data Analyst Intern", url: "https://boards-api.greenhouse.io/v1/boards/zentrafin/jobs/4401?content=true" }], undefined, ["Zentrafin"], { ask: "what does a data analyst intern do" });
  const seen: string[] = [];
  const judge: SupportJudge = async (cs) => cs.map((c) => { seen.push(c.source); return /^The marked text "The posting says/.test(c.claim) ? "yes" : "no"; });
  const [v] = await decide([{ claim: "The Data Analyst Intern will build dashboards for the payments team.", pages: [0], fallback: "You will build dashboards for the payments team" }], idx, judge);
  eq(v.how, "quote");
  ok(v.how === "quote" && /^The posting says: You will build dashboards/.test(v.sentence), JSON.stringify(v));
});

Deno.test("the shared test judge refuses a forecast stated as a result, and a result stated as a forecast", () => {
  const src = (t: string) => `Page title: Stripe\nWhole page, the candidate marked:\n>>> ${t} <<<`;
  ok(!supportsClaim("The Revenue suite reached a $1 billion annual run rate in 2026.", src("The Revenue suite is on track to reach a $1 billion annual run rate in 2026.")));
  ok(!supportsClaim("The Revenue suite will reach a $1 billion annual run rate.", src("The Revenue suite reached a $1 billion annual run rate.")));
  ok(supportsClaim("The Revenue suite is on track to reach a $1 billion annual run rate in 2026.", src("The Revenue suite is on track to reach a $1 billion annual run rate in 2026.")));
});

// ---- fixes 5 to 11 (groups A and C)
import { quotable } from "../../../supabase/functions/_shared/agent/research/support.ts";
import { readableText } from "../../../supabase/functions/_shared/research_sources.ts";
import { turnLines } from "../../../supabase/functions/_shared/agent/loop.ts";
Deno.test("fix 5: \"installed\" in a fact is not a software install; an install order still is", () => {
  ok(quotable("Acme Energy installed 41,000 home batteries in 2025."));
  ok(quotable("Globex Power has installed solar panels on 9,000 homes."));
  for (const u of ["Citadel interns must install the RemoteDesk tool on a personal laptop.", "Candidates install our screening app before the call.", "Download the installer to continue your application."]) ok(!quotable(u), u);
});
Deno.test("fix 7: a page's title ends its own line, so it is never glued onto the first sentence", () => {
  const { title, text } = readableText("<html><head><title>Careers at Zentrafin</title></head><body><p>Zentrafin hires new grads into engineering.</p></body></html>");
  eq(title, "Careers at Zentrafin");
  ok(text.split("\n").some((l) => l.trim() === "Zentrafin hires new grads into engineering."), JSON.stringify(text));
});
Deno.test("fixes 9 and 11: code's own lines (a closed posting's note, the read-only boundary) and a posting's read lines are reported for the support check", () => {
  const seen = [JSON.stringify({ company: "Stripe", title: "Data Analyst Intern", closed: true, closed_on: "2026-09-15" }),
    JSON.stringify({ board: "Workday", boundary: "Read only: no account, saved application or submission was created.", sign_in_required: true, requirements: { required: ["MS/PhD in Computer Science"], preferred: ["CUDA"] } }), "not json"];
  const { codeLines, readLines } = turnLines(seen);
  ok(codeLines.includes("Note: the Data Analyst Intern posting at Stripe closed on 2026-09-15; it no longer takes applications."), JSON.stringify(codeLines));
  ok(codeLines.includes("Read only: no account, saved application or submission was created."));
  ok(readLines.includes("MS/PhD in Computer Science") && readLines.includes("CUDA") && readLines.some((l) => /questions are behind that sign-in/.test(l)), JSON.stringify(readLines));
  eq(turnLines([JSON.stringify({ company: "Stripe", closed: false })]), { codeLines: [], readLines: [] });
});

// ---- architect ruling 2026-11-14 (final, review of f8d477168): no advice exemption; every advice sentence is checked, with the
// person's confirmed record as one more source. The leaks below stay refused (now by layer A and the judge).
import { keepSupported } from "../../../supabase/functions/_shared/agent/research/support.ts";
// Turn-level (the entry point every version exposes): the review's two leaks and four variants through agentTurn's advice path,
// with a judge that says no. Red on 7487f3600 (each sentence was kept unjudged), green here.
import { agentTurn } from "../../../supabase/functions/agent-chat/career_brain.ts";
const aSay = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const aUse = (name: string, input: unknown) => ({ content: [{ type: "tool_use", id: "t1", name, input }], stop_reason: "tool_use" });
const GUIDE_URL = "https://careers.stateuniversity.edu/resume";
const guideSearch = async () => ({ status: "ok", facts: [{ id: "", kind: "program", text: "Goldman Sachs and other banks read the top third of a resume first; keep it to one page.", quote: "Goldman Sachs and other banks read the top third of a resume first; keep it to one page.", url: GUIDE_URL, label: "State University career center" }], urls: [GUIDE_URL], cost_usd: 0.01 });
const FACTS = [{ id: "F-1", kind: "education", text: "Lakeshore University, BS Computer Science and Finance, Expected June 2029", status: "confirmed" }, { id: "F-2", kind: "skill", text: "Skill: SQL", name: "SQL", status: "confirmed", unproven: true }, { id: "F-3", kind: "skill", text: "Skill: Python", name: "Python", status: "confirmed" }];
const adviceTurn = (history: { role: string; content: string }[], reply: string, extra: any[] = []) => agentTurn({ message: "what goes at the top of my resume?", history, stores: { profile: { facts: [...structuredClone(FACTS), ...extra] } }, userId: "u", threadId: "t", now: Date.parse("2026-11-14T00:00:00Z"), knowledge: true,
  market: { judge: async (cs: any[]) => cs.map(() => "no") }, model: (() => { let n = 0; return async (p: any) => p.tools?.length ? [aUse("research_career_question", { question: "what goes at the top of my resume?", kind: "advice", query: "resume top" }), aSay(reply)][Math.min(n++, 1)] : aSay(""); })(), research: { search: guideSearch } } as any) as Promise<any>;
Deno.test("advice at the turn: the review's leaks are judged and refused (no exemption; the record is a source)", async () => {
  const cases: [string, any[], { role: string; content: string }[], string, RegExp][] = [
    ["repro: heard", [], [{ role: "user", content: "I heard Citadel pays $10k a week." }], "Citadel pays interns $10k a week, which is the top of the market.", /Citadel|10k/],
    ["repro: guide name", [], [{ role: "user", content: "My internship pays $120 an hour." }], "Goldman Sachs pays $120 an hour to interns.", /Goldman|120/],
    ["leak: a friend's employer", [{ id: "F-9", kind: "other", text: "My friend at Citadel earns $10k a week", status: "confirmed" }], [], "Citadel interns earn $10k a week.", /Citadel|10k/],
    ["leak: a skill's vendor", [{ id: "F-9", kind: "skill", text: "Skill: Palantir Foundry", name: "Palantir Foundry", status: "confirmed" }], [], "Palantir values Foundry experience.", /values/],
    ["leak: a skill as an employer", [{ id: "F-9", kind: "skill", text: "Skill: Snowflake", name: "Snowflake", status: "confirmed" }], [], "Snowflake looks for Snowflake skills in new grads.", /looks for/],
    ["leak: a record figure as a market claim", [{ id: "F-9", kind: "offer", text: "Offer: $120,000 in Chicago", status: "confirmed" }], [], "$120,000 is a strong number for a new grad.", /strong/],
    ["leak: a record GPA as a cutoff", [{ id: "F-9", kind: "other", text: "GPA: 3.7", status: "confirmed" }], [], "A 3.7 GPA clears the cutoff.", /cutoff/],
    ["leak: an unconfirmed figure asserted", [], [{ role: "user", content: "My GPA is 3.4." }], "Put your 3.4 GPA next to Lakeshore University.", /3\.4/],
    ["leak: a market claim", [], [], "SQL is the most requested skill at every bank this year.", /most requested/],
    // review of 3c0a85b2f: a clause after the instruction, in any form
    ["clause: which", [], [], "Mention SQL, which data teams want now.", /want now/],
    ["clause: and say", [], [], "Move SQL up and say data teams want it now.", /want it now/],
    ["clause: because", [], [], "Lead with SQL because data teams want it now.", /want it now/],
    ["clause: since", [], [], "Put SQL first, since it is what data teams ask for.", /ask for/],
    ["clause: so", [], [], "Put SQL first so recruiters see it.", /recruiters see/],
    ["clause: to", [], [], "List SQL first to beat other applicants.", /beat other/],
    // review of 1f3f5f18a: record words recombined, a fact about someone else, a ":" clause (fixtures whose words the old allowlist let through)
    ["recombined: another employer", [{ id: "F-9", kind: "experience", text: "Robinhood, Engineer, led a team of 4", status: "confirmed" }, { id: "F-10", kind: "other", name: "Citadel friend", text: "My friend at Citadel earns $10k a week", status: "confirmed" }], [], "Led a team of 4 at Citadel.", /Citadel/],
    ["a friend's fact", [{ id: "F-10", kind: "experience", text: "Citadel friend earns $10k a week", status: "confirmed" }], [], "Mention Citadel earns $10k a week.", /10k/],
    ["a ':' figure", [{ id: "F-11", kind: "experience", text: "Stripe, Intern, salary $120,000", status: "confirmed" }], [], "Mention your Stripe salary: $120,000.", /120,000/],
    ["recombined: a project claim", [{ id: "F-13", kind: "experience", text: "Stripe, Intern, trading bot returned 12%", status: "confirmed" }], [], "Mention the trading bot returned 12% at Stripe.", /12%/],
  ];
  for (const [name, extra, history, reply, bad] of cases) {
    const t = await adviceTurn(history, reply, extra);
    ok(!bad.test(t.reply), `${name}: ${t.reply}`);
  }
  // Review of 78603b243: a further clause after the instruction, and a draft fact kept rather than removed, are judged.
  for (const [name, reply, bad] of [["a ':' clause", "Mention SQL: it is what data teams want now.", /what data teams want/], ["a ';' clause", "Drop Python; Python is dying.", /dying/],
    ["a dash clause", "Move SQL up — data teams want it now.", /want it now/], ["a draft kept", "Leave the 3.9 GPA in.", /3\.9/]] as const) {
    const t = await adviceTurn([], reply, [{ id: "F-8", kind: "other", text: "GPA: 3.9", name: "GPA", gpa: "3.9", status: "draft", needs_confirmation: true }]);
    ok(!bad.test(t.reply), `${name}: ${t.reply}`);
  }
  ok(!(await adviceTurn([], "Put Citadel first.", [{ id: "F-10", kind: "other", text: "My friend at Citadel earns $10k a week", status: "confirmed" }])).reply.includes("Put Citadel first."), "not their employer");
});
Deno.test("advice: the record is one source passage the judge sees, and a draft is never a source for a sentence that keeps it", async () => {
  const seen: string[] = [];
  const judge = async (cs: any[]) => cs.map((c: any) => { seen.push(c.source); return "yes"; });
  const t = await agentTurn({ message: "what goes at the top of my resume?", history: [], stores: { profile: { facts: [
    { id: "F-1", kind: "experience", text: "Robinhood, Software engineering intern", status: "confirmed" }, { id: "F-2", kind: "experience", text: "Stripe, Team lead", status: "confirmed" },
    { id: "F-3", kind: "other", text: "GPA: 3.9", name: "GPA", gpa: "3.9", status: "draft", needs_confirmation: true }] } }, userId: "u", threadId: "t", now: Date.parse("2026-11-14T00:00:00Z"), knowledge: true,
    market: { judge }, model: (() => { let n = 0; return async (p: any) => p.tools?.length ? [aUse("research_career_question", { question: "x", kind: "advice", query: "resume top" }), aSay("List Software engineering intern at Stripe. Your Robinhood role was Software engineering intern. Leave the 3.9 GPA in.")][Math.min(n++, 1)] : aSay(""); })(), research: { search: guideSearch } } as any) as any;
  // (A recombination now passes layer A on the one record unit and is the judge's to refuse: the ruling test below, with a judge
  // that reads line by line.)
  ok(!/3\.9/.test(t.reply), `a draft is no source: ${t.reply}`);
  ok(seen.some((x) => /The person's confirmed record/.test(x) && /experience: Robinhood, Software engineering intern/.test(x)), `record passage seen: ${seen.length} ${t.reply}`);
});
// Ruling (MP-1 C4): the record is one passage and one layer-A unit; a judge that reads it line by line refuses a recombination; the
// person's drafts are read only for a sentence that removes or updates them.
const perLine: SupportJudge = async (cs) => cs.map((c) => {
  const m = /^>>> (.*) <<<$/m.exec(c.source)?.[1] ?? "";
  const ws = (t: string) => (t.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.\/-]*/gu) ?? []).map((w) => w.replace(/[.]$/, "")).filter((w) => !["the", "a", "an", "your", "you", "have", "was", "is", "at", "list", "mention", "put", "leave", "off", "outdated", "remove", "drop", "of", "and"].includes(w));
  return m.split(" | ").some((line) => ws(c.claim).every((w) => ws(line).includes(w))) ? "yes" : "no";
});
const RECORD = [{ id: "R-1", kind: "experience", text: "Robinhood, Software engineering intern", status: "confirmed" }, { id: "R-2", kind: "experience", text: "Stripe, Team lead", status: "confirmed" },
  { id: "R-3", kind: "experience", text: "Citadel, Quant researcher", status: "confirmed" }, { id: "R-4", kind: "other", name: "GPA", gpa: "3.9", text: "GPA: 3.9", status: "draft", needs_confirmation: true }];
const recordTurn = (reply: string) => agentTurn({ message: "what goes at the top of my resume?", history: [], stores: { profile: { facts: structuredClone(RECORD) } }, userId: "u", threadId: "t", now: Date.parse("2026-11-14T00:00:00Z"), knowledge: true,
  market: { judge: perLine }, model: (() => { let n = 0; return async (p: any) => p.tools?.length ? [aUse("research_career_question", { question: "x", kind: "advice", query: "resume top" }), aSay(reply)][Math.min(n++, 1)] : aSay(""); })(), research: { search: guideSearch } } as any) as Promise<any>;
Deno.test("ruling: a recombination of record lines passes layer A but a line-reading judge refuses it; a draft only for its removal", async () => {
  for (const bad of ["List Software engineering intern at Stripe.", "Mention Team lead at Robinhood.", "Remove Citadel, then list Quant intern at Citadel.", "You have a 3.9 GPA."]) {
    const t = await recordTurn(bad);
    ok(!t.reply.includes(bad), `${bad} => ${t.reply}`);
  }
  for (const good of ["Mention Robinhood, Software engineering intern.", "Leave the 3.9 GPA off."]) {
    const t = await recordTurn(good);
    ok(t.reply.includes(good), `${good} => ${t.reply}`);
  }
});
// Ruling on 3ad157b2e: an advice sentence may stand on the cited guide and the confirmed record together (layer A: names and figures
// in the record, the other content words in the guide or the record, at least one the guide's); the judge reads both.
const GUIDE2 = "Start with your name and contact links, then education with your school, degree and expected graduation date, followed by a short technical skills section.";
const guide2Search = async () => ({ status: "ok", facts: [{ id: "", kind: "program", text: GUIDE2, quote: GUIDE2, url: GUIDE_URL, label: "Student guide" }], urls: [GUIDE_URL], cost_usd: 0.01 });
// A judge for the joint passage that reads what a careful judge would: every word in the guide or a record line (instruction words
// aside), and no role joined to an employer from another line.
import { mirrorJudgeAnswer } from "../helpers/mirror_stub_judge.ts";
const jointJudge: SupportJudge = async (cs) => JSON.parse(mirrorJudgeAnswer(JSON.stringify(cs)));
const jointTurn = (reply: string, facts: any[]) => agentTurn({ message: "what goes at the top of my resume?", history: [], stores: { profile: { facts: structuredClone(facts) } }, userId: "u", threadId: "t", now: Date.parse("2026-11-14T00:00:00Z"), knowledge: true,
  market: { judge: jointJudge }, model: (() => { let n = 0; return async (p: any) => p.tools?.length ? [aUse("research_career_question", { question: "x", kind: "advice", query: "resume top" }), aSay(reply)][Math.min(n++, 1)] : aSay(""); })(), research: { search: guide2Search } } as any) as Promise<any>;
const MINE = [{ id: "J-1", kind: "education", text: "Lakeshore University, BS Computer Science and Finance, Expected June 2029", status: "confirmed" }, { id: "J-2", kind: "skill", text: "Skill: SQL", name: "SQL", status: "confirmed" },
  { id: "J-3", kind: "experience", text: "Robinhood, Software engineering intern", status: "confirmed" }, { id: "J-4", kind: "experience", text: "Stripe, Team lead", status: "confirmed" },
  { id: "J-5", kind: "other", text: "My friend at Citadel earns $10k a week", status: "confirmed" }, { id: "J-6", kind: "other", name: "GPA", gpa: "3.9", text: "GPA: 3.9", status: "draft", needs_confirmation: true }];
Deno.test("ruling: joint guide + record support for advice; never for a recombination, a draft, hearsay or a claim the guide does not make", async () => {
  const good = "Start with your name and contact links, then education with Lakeshore University, BS Computer Science and Finance, Expected June 2029, followed by a short technical skills section with SQL.";
  ok((await jointTurn(good, MINE)).reply.includes(good), "the guide's layout with the record's items stands");
  for (const bad of ["List Software engineering intern at Stripe.", "Mention Team lead at Robinhood first in your skills section.", "You have a 3.9 GPA.", "Citadel interns earn $10k a week.", "SQL is the most requested skill at every bank.", "Start with your name and contact links, then your Citadel internship."]) {
    const t = await jointTurn(bad, MINE);
    ok(!t.reply.includes(bad), `${bad} => ${t.reply}`);
  }
});

// Ruling 2026-11-14 (live-10): a small fixed table of career abbreviations in layer A; never beyond it, never a figure.
import { findSupport as fs2, indexPages as ip2, nameFoundIn } from "../../../supabase/functions/_shared/agent/research/support.ts";
Deno.test("abbreviations: MRR, SWE and GPA are found by their expansions; a false figure with one is still refused", () => {
  ok(nameFoundIn("MRR", "peak $9k monthly recurring revenue") && nameFoundIn("swe", "software engineering intern") && nameFoundIn("software engineer", "a SWE role"));
  ok(!nameFoundIn("QA", "quality assurance"), "nothing beyond the table");
  const rec = ip2([{ text: "experience: Pixelforge, Founder (2023-2025): hand-coded 70+ React websites for clients; peak $9k monthly recurring revenue.", title: "The person's confirmed record:", one: true }]);
  ok(!!fs2("Pixelforge reached $9k MRR.", rec), "the record's own figure, with the abbreviation");
  ok(!fs2("Pixelforge reached an MRR of $20k.", rec), "a figure the record does not give is refused");
});

// Ruling 2026-11-14 (live-10 C1): a count in a reply sentence stands when it is a count code knows this turn, for that noun only.
Deno.test("a count code knows this turn: \"one posting\" with one result stands; \"three postings\" with one result is refused", async () => {
  const one = [{ job_id: "c1", company: "Acme", title: "Software Engineer Intern", location: "Chicago, IL", url: "https://jobs.example/acme/1", description: "Software engineer intern role.", pay: "$40 an hour" }];
  const run = (reply: string) => agentTurn({ message: "find me a software engineer internship", history: [], stores: { profile: { facts: [] } }, userId: "u", threadId: "t", now: Date.parse("2026-11-14T00:00:00Z"),
    market: { judge: async (cs: any[]) => cs.map(() => "yes") }, postings: async () => one,
    model: (() => { let n = 0; return async (p: any) => p.tools?.length ? [aUse("search_jobs", { query: "software engineer intern" }), aSay(reply)][Math.min(n++, 1)] : aSay(""); })() } as any) as Promise<any>;
  const a = await run("The search found one posting.");
  ok(a.reply.includes("The search found one posting."), a.reply);
  const b = await run("The search found three postings.");
  ok(!b.reply.includes("three postings"), b.reply);
});
