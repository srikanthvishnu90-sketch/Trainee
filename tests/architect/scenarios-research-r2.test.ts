// RESEARCH, COMPANY ANSWERS AND INTERVIEW PREP, ROUND 2 (architect, 2026-10-30; owner rule D-007, never invent a fact).
// ~10,000 seeded scenarios (tests/architect/scenarios/research-r2-generator.ts) through the product's own code, every model
// and search a deterministic fake (adversarial ones included), on a fixed clock. Round 1 is scenarios-research.test.ts; the
// sampled end-to-end run through the production handler on real Postgres is flow-scenarios-research-r2.test.ts.
//   A  threads    4,000 conversations (1 to 4 turns) through the career host's turn, no profile and a confirmed resume:
//                 interview prep (tomorrow, a firm with and without a file, behavioural / case / technical / coding tracks,
//                 "what should I ask them?"), pay asks, comparisons, a firm's news, people, offices and rating, longer firm
//                 names, and follow-ups (pronouns, a switch of firm, a firm they say not to apply to). Every firm a reply is
//                 about was named in the conversation; a follow-up stays on the thread's firm; a filed firm is never said to
//                 have no file; what no file holds (news, people, offices, a rating) is said plainly; no number without a
//                 source; the person's current pay is never said back.
//   B  mock       2,000 mock interviews (text, and voice transcripts) whose answers carry a key, a password, an identity
//                 number or an invented claim: no secret is kept or said; a claim is only ever quoted as theirs; a firm with
//                 no record is said to have none; the pre-interview brief claims nothing about a firm with no record.
//   C  invites    1,000 interview invites: the company and the people are only what the invite states.
//   D  offers     1,000 texted offers with the person's current pay beside them: every figure is the offer's or a named
//                 source's, each with its link; the current pay is never said back.
//   E  searches   2,000 open questions over a scripted search carrying a fake "official" pay table, a fake recruiter email or
//                 phone line, and injected text: none of it reaches the brief; a repeated question searches nothing; a failed
//                 search is searched again next time; a day budget that runs out mid-conversation stops every later call
//                 before it is made; every search reserved its worst case first and asked for at most one tool call.
// No network, no model, no database.
//   deno test -A --no-check tests/architect/scenarios-research-r2.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { AWS_KEY, conversations, FAKE_HOSTS, IDS, inviteCases, KEYS, mockCases, offerCases, PASSWORDS, r2Facts, rng, SK_PROJ, type Conversation } from "./scenarios/research-r2-generator.ts";
import { r2Violations } from "./scenarios/research-r2-oracle.ts";
import { QUESTIONS } from "./scenarios/research-generator.ts";
import { brief as interviewBrief, next as mockNext, start as mockStart, voiceDebrief } from "../../supabase/functions/_shared/career_mock.ts";
import { extractInvite, inviteBrief } from "../../supabase/functions/_shared/career_invite.ts";
import { redactIdentity } from "../../supabase/functions/_shared/identity_redact.ts";
import { offerTurn } from "../../supabase/functions/_shared/career_offer.ts";
import { researchCareerQuestion } from "../../supabase/functions/_shared/agent/research/index.ts";
import { memoryGroundCache, openAiGroundSearch, type GroundSearch } from "../../supabase/functions/_shared/agent/research/ground.ts";
import { responsesWorst, WEB_SEARCH_MAX_CALLS } from "../../supabase/functions/_shared/model_gateway.ts";
import { memoryBudgetGate } from "../../supabase/functions/_shared/model_budget.ts";
import { DEFAULT_SEARCH_MODEL } from "../../supabase/functions/_shared/career_people_provider.ts";

const SEED = 20261030;
const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const P = (core as any).CareerProfile;
const host = (CareerHost as any).createCareerHost(core);
const NOW = Date.parse("2026-10-30T15:00:00Z");

type Fails = Map<string, string[]>;
const fail = (f: Fails, family: string, line: string) => { if (!f.has(family)) f.set(family, []); f.get(family)!.push(line); };
function report(f: Fails, total: number, what: string) {
  const n = [...f.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[research-r2] ${what}: ${total} scenarios, ${n} failures`];
  for (const [k, xs] of f) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 4)) lines.push(`    ${x}`); }
  console.log(lines.join("\n"));
  assertNode.equal(n, 0, `${what}: ${n} of ${total} failed (see the report above)`);
}

// ------------------------------------------------------------------------------------------------ A: threads
function newCtx(profile: boolean) {
  const ctx = host.createTurnCtx({ userId: "TEST-rs2", threadId: "t-rs2", now: NOW, accountPersistence: true, snapshot: null, account: { epoch: 0, version: 0, paused: false }, postings: [] });
  if (profile) { const p = P.createProfile({ id: "TEST-rs2" }); P.ingestResume(p, RESUME); for (const fct of p.facts) P.confirmFact(p, fct.id); ctx.profile = p; }
  return ctx;
}
export function runConversation(c: Conversation, profile: boolean): { text: string; intent: string; reply: string }[] {
  const ctx = newCtx(profile);
  return c.turns.map((t) => { const r = host.runTurn(t.text, ctx); return { text: t.text, intent: String(r.intent ?? ""), reply: String(r.reply ?? "") }; });
}
Deno.test("A. 4,000 conversations through the career host: named firms only, follow-ups on the thread's firm, a filed firm never 'no file', what no file holds said plainly", () => {
  const cases = conversations(rng(SEED), 4000);
  const f: Fails = new Map();
  const fams = new Map<string, number>();
  let turns = 0;
  for (const [i, c] of cases.entries()) {
    fams.set(c.family, (fams.get(c.family) ?? 0) + 1);
    const profile = i % 3 === 0;
    const out = runConversation(c, profile);
    for (const [k, t] of c.turns.entries()) {
      turns++;
      const said = c.turns.slice(0, k + 1).map((x) => x.text);
      for (const v of r2Violations(said, t, out[k].reply, out[k].intent)) fail(f, `${profile ? "resume" : "no-resume"}:${c.family}:${v.split(":")[0]}`, `${JSON.stringify(said)} -> ${out[k].intent}: ${v} | ${out[k].reply.split("\n")[0].slice(0, 160)}`);
    }
  }
  console.log(`[research-r2] threads: ${cases.length} conversations, ${turns} turns; ${[...fams].sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);
  report(f, cases.length, "threads");
});

// The bugs found on trunk, as typed (input → expected; trunk's reply in the comment).
Deno.test("the reported thread bugs (input → expected → actual on trunk)", () => {
  const conv = (texts: string[]) => runConversation({ family: "row", turns: texts.map((text) => ({ text, checks: [] })) }, false).map((x) => x.reply);
  const head = (r: string) => r.split("\n")[0];
  // trunk: "Microsoft Research Asia" in a look-for / culture / pay frame → "I may have missed what you meant" (round 1's not-fixed list)
  for (const ask of ["what does Microsoft Research Asia look for", "what's Microsoft Research Asia's culture like", "how much does Microsoft Research Asia pay"]) assertNode.match(conv([ask])[0], /^Microsoft Research Asia has no company file yet/, ask);
  // trunk: "Stripe has no company file yet" (false) to a follow-up about Stripe
  for (const fu of ["what about their London office?", "what's their culture like?"]) {
    const [, r] = conv(["tell me about Stripe", fu]);
    assertNode.doesNotMatch(r, /has no company file/, `${fu}: ${head(r)}`);
    assertNode.match(head(r), /^Stripe/, fu);
  }
  assertNode.match(conv(["tell me about Stripe", "what about their London office?"])[1], /holds nothing on a London office/);
  // trunk: "I'm not sure which part of your search that's about"
  assertNode.match(conv(["tell me about Stripe", "is it a good place to work?"])[1], /^Stripe: no rating on record/);
  // trunk: only Ramp ("The Ramp thesis", "The Ramp file"); only JPMorgan; null; "Goldman Sachs versus Morgan: ... the other does not"
  for (const [ask, want] of [["Stripe vs Ramp for me", "Stripe versus Ramp"], ["should I work at Stripe or Ramp?", "Stripe versus Ramp"], ["Goldman or JPMorgan, which is better for me?", "Goldman Sachs versus JPMorganChase"],
    ["McKinsey vs BCG vs Bain", "McKinsey & Company, Boston Consulting Group versus Bain & Company"], ["compare Goldman Sachs and Morgan Stanley", "Goldman Sachs versus Morgan Stanley"]] as const) {
    const r = conv([ask])[0];
    assertNode.ok(head(r).startsWith(`${want}: what each file supports`), `${ask}: ${head(r)}`);
    assertNode.doesNotMatch(r, /has no company file|the other does not/, ask);
  }
  // trunk: the file summary, as if it answered the question
  assertNode.match(conv(["any layoffs at Google recently?"])[0], /^Google: no news on record[^\n]*\nThe Google file holds no news/);
  assertNode.match(conv(["who is the CEO of Stripe?"])[0], /The Stripe file names no people/);
  assertNode.match(conv(["who's the recruiter for Goldman Sachs summer analyst?"])[0], /The Goldman Sachs file names no people/);
  assertNode.match(conv(["is Palantir a good company to work for?"])[0], /no rating or employee reviews/);
  // trunk: the file's bar ("The McKinsey & Company file — ..."), never the comp section
  assertNode.match(head(conv(["how much do McKinsey business analysts make?"])[0]), /^McKinsey & Company comp, from the file\.$/);
  // trunk: "Company: not supplied yet — flagged, not invented" though the ask named it
  for (const [ask, firm] of [["prep me for my interview at Acme Robotics tomorrow", "Acme Robotics"], ["I have an interview at Microsoft Research Asia tomorrow, prep me", "Microsoft Research Asia"]]) {
    const r = conv([ask])[0];
    assertNode.doesNotMatch(r, /Company: not supplied yet/, ask);
    // 1v1 (2026-11-01): the missing details are said in plain words (Q94); the oracle's nofile-said forms.
    assertNode.match(r, new RegExp(`${firm} has no company file|nothing (?:in this plan |here )?is about how ${firm}`), ask);
  }
  // trunk: "Your finance question: Walk me through the three financial statements" for a tech firm's technical round
  for (const ask of ["prep me for a technical interview at Google", "prep me for a technical interview at Palantir"]) assertNode.doesNotMatch(conv([ask])[0], /finance question|three financial statements/, ask);
  assertNode.match(conv(["prep me for a technical interview at Goldman Sachs"])[0], /finance question/);
  // trunk: "Your coding question: Book canon : *Cracking the Coding Interview*"
  assertNode.doesNotMatch(conv(["prep me for a coding interview at Stripe"])[0], /Book canon/i);
  // trunk: the catch-all; and Stripe's interview section
  assertNode.match(conv(["prep me for my Stripe interview", "what should I ask them?"])[1], /^Your questions to ask/);
  assertNode.match(conv(["help me prep for my BCG interview tomorrow", "what should I ask them at the end?"])[1], /^Your questions to ask/);
  assertNode.match(conv(["what should I ask at the end of my Stripe interview?"])[0], /^Your questions to ask/);
});

// ------------------------------------------------------------------------------------------------ B: mock interviews
const QUOTED = /"[^"\n]*"|“[^”\n]*”/g;
const CLAIM_WORDS = /50 engineers|youngest VP|payments system Stripe uses/;
Deno.test("B. 2,000 mock interviews whose answers carry keys, passwords, identity numbers or invented claims: nothing secret kept or said, claims only quoted", () => {
  const cases = mockCases(rng(SEED + 1), 2000);
  const f: Fails = new Map();
  const secretsIn = (t: string, xs: string[]) => xs.filter((x) => t.includes(x));
  const all = [...KEYS, ...PASSWORDS, ...IDS];
  for (const [i, c] of cases.entries()) {
    const tag = `[${c.family}] #${i}`;
    const s0 = mockStart({ role: c.role, company: c.company, now: NOW + i * 60_000 });
    const replies = [s0.reply];
    let st = s0.state;
    for (const a of c.answers) { const r = mockNext(st, a, NOW + i * 60_000 + 30_000); replies.push(r.reply); st = r.state; if (r.done) break; }
    const kept = JSON.stringify(st);
    for (const x of secretsIn(kept, all)) fail(f, "secret-kept", `${tag}: ${x}`);
    for (const r of replies) for (const x of secretsIn(r, all)) fail(f, "secret-said", `${tag}: ${x} | ${r.slice(0, 160)}`);
    // An invented claim is only ever quoted as theirs, never said as a fact.
    for (const r of replies) if (CLAIM_WORDS.test(r.replace(QUOTED, ""))) fail(f, "claim-as-fact", `${tag}: ${r.slice(0, 200)}`);
    // The firm: only the one they named; with no record, said.
    if (c.company && !/Stripe|Goldman|Google/.test(c.company) && st.company !== c.company && !st.record) fail(f, "company", `${tag}: ${st.company} for ${c.company}`);
    if (c.company && !st.record && !st.patterns && !s0.reply.includes(`No record for ${c.company}`)) fail(f, "no-record-unsaid", `${tag}: ${s0.reply.slice(0, 200)}`);
    // The voice debrief: the same answers as a transcript.
    const turns = c.answers.flatMap((a, n) => [{ who: "interviewer" as const, text: `Question ${n + 1}. ${s0.state.questions[n]?.q ?? ""}` }, { who: "candidate" as const, text: a }]);
    const v = voiceDebrief(s0.state, turns, NOW + i * 60_000 + 600_000);
    for (const x of secretsIn(JSON.stringify(v.state) + v.reply, all)) fail(f, "voice-secret", `${tag}: ${x}`);
    if (CLAIM_WORDS.test(v.reply.replace(QUOTED, ""))) fail(f, "voice-claim-as-fact", `${tag}: ${v.reply.slice(0, 200)}`);
    // The pre-interview brief: a firm with no record is said to have none, and no other firm is claimed.
    if (c.company) {
      const b = interviewBrief({ company: c.company, role: c.role });
      if (!b.has_record && !/No record for/.test(b.questions_note)) fail(f, "brief-no-record", `${tag}: ${b.questions_note}`);
      if (!b.has_record && b.plan.some((p: string) => /Goldman|McKinsey|Google|Stripe/.test(p) && !p.includes(c.company!))) fail(f, "brief-other-firm", `${tag}: ${b.plan.join(" | ")}`);
    }
  }
  report(f, cases.length, "mock");
});

Deno.test("the reported mock bug: a key, a password or an SSN in an answer was kept and quoted back (input → expected → actual on trunk)", () => {
  let st = mockStart({ role: "software engineer", company: "Stripe", now: NOW }).state;
  const answers = [`I stored the deploy key ${SK_PROJ} in the repo by mistake, then rotated it and cut leaks by 40%.`, "I built a dashboard in SQL for 3 teams; my password is hunter2!",
    "My SSN is 123-45-6789 and I cut runtime from 10 minutes to 2 minutes.", "fine", "I led a team of 4 and shipped a week early.", "I wrote 30 tests."];
  let reply = "";
  for (const a of answers) { const r = mockNext(st, a, NOW + 60_000); st = r.state; reply += r.reply; if (r.done) break; }
  // trunk: 'Strongest: Q2 "I built a dashboard in SQL for 3 teams; my password is hunter2!"' and the key and SSN kept in the record
  assertNode.ok(!/sk-proj-|hunter2|123-45-6789/.test(reply + JSON.stringify(st)), reply);
  assertNode.match(reply, /I removed a key, password or ID number from that answer/);
});

Deno.test("the reported chat-log bug: a pasted key reached the chat log (agent_messages) word for word (input → expected → actual on trunk)", () => {
  for (const k of KEYS) {
    const r = redactIdentity(`for the mock: I kept our key ${k} in the config and cut load time 25%.`);
    // trunk: kept as typed (the input redaction removed only identity numbers, passwords and codes)
    assertNode.ok(!r.text.includes(k) && r.removed.includes("key"), `${k}: ${r.text}`);
    assertNode.match(r.text, /cut load time 25%/);
  }
  // not a key: words and short ids stay
  for (const keep of ["my sk-1 form", "task-42 is done", "the eyJ prefix means a JWT"]) assertNode.equal(redactIdentity(keep).text, keep);
});

// ------------------------------------------------------------------------------------------------ C: invites
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
Deno.test("C. 1,000 interview invites: the company and the people are only what the invite states", () => {
  const cases = inviteCases(rng(SEED + 2), 1000);
  const f: Fails = new Map();
  for (const [i, c] of cases.entries()) {
    const tag = `[${c.family}] #${i} ${JSON.stringify(c.text.slice(0, 90))}`;
    const inv = extractInvite({ text: c.text, sentAt: NOW });
    const plainCo = (v: string | null) => (v ?? "").replace(/[.,]+$/, "").trim();
    if (inv.company && plainCo(inv.company) !== plainCo(c.company)) fail(f, "company-invented", `${tag}: ${inv.company}`);
    if (c.company && !inv.company) fail(f, `company-missed:${c.family.split(":")[1]}`, tag);
    for (const p of inv.interviewers) if (!c.people.includes(p.name)) fail(f, "person-invented", `${tag}: ${p.name}`);
    const b = inviteBrief(inv, { now: NOW, postings: [], tz: "America/New_York" });
    const text = b.texts.join("\n");
    if (EMAIL.test(text)) fail(f, "email-in-brief", tag);
    for (const p of ["Priya Natarajan", "Marcus Lee", "Dana Whitfield", "Ken Okafor"]) if (text.includes(p) && !c.people.includes(p)) fail(f, "person-in-brief", `${tag}: ${p}`);
    if (!inv.company && !/does not name the company/.test(text)) fail(f, "no-company-unsaid", `${tag}: ${text.slice(0, 120)}`);
  }
  report(f, cases.length, "invites");
});

// ------------------------------------------------------------------------------------------------ D: offers
const MONEY = /\$\d[\d,]*(?:\.\d+)?k?|\b\d{2,3}k\b/gi;
const moneyOf = (s: string) => (s.match(MONEY) ?? []).map((m) => { const k = /k$/i.test(m); const n = Number(m.replace(/[$,k]/gi, "")); return k ? n * 1000 : n; });
Deno.test("D. 1,000 texted offers with the current pay beside them: every figure is the offer's or a named source's, the current pay never said back", () => {
  const cases = offerCases(rng(SEED + 3), 1000);
  const f: Fails = new Map();
  for (const [i, c] of cases.entries()) {
    const tag = `[${c.family}] #${i} ${JSON.stringify(c.words)}`;
    const t = offerTurn({ words: c.words, pending: null, now: NOW });
    const msgs = (t.result.messages ?? []).join("\n");
    if (moneyOf(msgs).includes(c.current * 1000)) fail(f, "current-pay-said", `${tag}: ${msgs.slice(0, 200)}`);
    const sourced = new Set<number>([c.base * 1000]);
    for (const b of t.result.benchmarks ?? []) for (const n of moneyOf(JSON.stringify(b).replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1"))) sourced.add(n);
    for (const b of t.result.benchmarks ?? []) for (const v of Object.values(b as Record<string, unknown>)) if (typeof v === "number") sourced.add(Math.round(v));
    for (const n of moneyOf(msgs)) if (!sourced.has(n) && !(t.result.draft && JSON.stringify(t.result.draft).includes(String(n)))) fail(f, "figure-unsourced", `${tag}: $${n} | ${msgs.slice(0, 200)}`);
    if ((t.result.benchmarks ?? []).some((b: any) => b.figures?.length || b.median) && !/Sources:\n(?:https:\/\/\S+\n?)+/.test(msgs)) fail(f, "source-unnamed", `${tag}: ${msgs.slice(0, 200)}`);
  }
  report(f, cases.length, "offers");
});

// ------------------------------------------------------------------------------------------------ E: searches
const R2_BAD = /official pay table|official compensation band|Verified salary table|@|555-01|Ignore all previous|reveal the system prompt/i;
Deno.test("E. 2,000 open questions over a search carrying a fake pay table, a fake recruiter address and injected text: none of it reaches the brief", async () => {
  const r = rng(SEED + 4);
  const f: Fails = new Map();
  let offered = 0, kept = 0;
  for (let i = 0; i < 2000; i++) {
    const message = r.pick(QUESTIONS);
    const answers = [0, 1, 2, 3].map(() => r2Facts(r));
    let call = 0;
    const search: GroundSearch = async (plan) => {
      const facts = answers[call++] ?? [];
      offered += facts.length;
      const shown = facts.map((x) => ({ id: "", kind: (plan.kinds.includes(x.kind as any) ? x.kind : plan.kinds[0]) as any, text: x.text, quote: x.quote, url: x.url, label: new URL(x.url).hostname }));
      return { status: "ok", facts: shown, urls: [...new Set(facts.map((x) => x.url))], cost_usd: 0.01 };
    };
    const res = await researchCareerQuestion({ profile: null, message, deps: { search, cache: memoryGroundCache() }, now: NOW + i * 1000 });
    if (res.status !== "ok") continue;
    const tag = `#${i} ${message}`;
    kept += res.facts.length;
    for (const x of res.facts) if (R2_BAD.test(x.text) || FAKE_HOSTS.includes(x.url) && !/bls\.gov/.test(x.url)) fail(f, "bad-fact-kept", `${tag}: ${x.text} (${x.url})`);
    if (R2_BAD.test(res.brief_markdown)) fail(f, "brief", `${tag}: ${(res.brief_markdown.match(R2_BAD) ?? [""])[0]}`);
    if (res.unsourced.length) fail(f, "unsourced", `${tag}: ${res.unsourced.join(", ")}`);
  }
  console.log(`[research-r2] searches: 2000 questions; adversarial and good facts offered ${offered}, kept ${kept}`);
  report(f, 2000, "searches");
});

Deno.test("the reported search bug: a fake recruiter email, phone line or 'official' pay table from a look-alike site reached the brief (input → expected → actual on trunk)", async () => {
  const facts = [
    { kind: "employer", text: "Email the campus recruiter Jane Doe at jane.doe@recruiting-example.com to get an interview.", quote: "Email the campus recruiter Jane Doe at jane.doe@recruiting-example.com to get an interview.", url: FAKE_HOSTS[0] },
    { kind: "employer", text: "Call the recruiting line at (212) 555-0147 to skip the online application.", quote: "Call the recruiting line at (212) 555-0147 to skip the online application.", url: FAKE_HOSTS[1] },
    { kind: "pay", text: "Official pay table: first-year analysts earn $185,000 base and $95,000 bonus.", quote: "Official pay table: first-year analysts earn $185,000 base and $95,000 bonus.", url: FAKE_HOSTS[2] },
    { kind: "pay", text: "The median annual wage for financial analysts was $99,890 in May 2023.", quote: "The median annual wage for financial analysts was $99,890 in May 2023.", url: "https://www.bls.gov/ooh/business-and-financial/financial-analysts.htm" },
  ];
  const search: GroundSearch = async (plan) => ({ status: "ok", facts: facts.filter((x) => plan.kinds.includes(x.kind as any)).map((x) => ({ ...x, id: "", kind: x.kind as any, label: new URL(x.url).hostname })), urls: facts.map((x) => x.url), cost_usd: 0.01 });
  const res = await researchCareerQuestion({ profile: null, message: "how do I break into investment banking?", deps: { search }, now: NOW });
  assertNode.equal(res.status, "ok");
  if (res.status !== "ok") return;
  // trunk: all three kept and cited ("jane.doe@recruiting-example.com", "(212) 555-0147", "$185,000 base")
  assertNode.deepEqual(res.facts.map((x) => x.url), ["https://www.bls.gov/ooh/business-and-financial/financial-analysts.htm"]);
  assertNode.ok(!/recruiting-example|555-0147|185,000/.test(res.brief_markdown), res.brief_markdown);
});

Deno.test("E2. repeated, failed-then-retried and over-budget questions mid-conversation: no search on a cached answer, a failed one searched again, nothing called past the budget, reserved first, one tool call", async () => {
  const saved = Deno.env.get("MODEL_BUDGET_PAUSED");
  Deno.env.delete("MODEL_BUDGET_PAUSED");
  const f: Fails = new Map();
  const r = rng(SEED + 5);
  // The gateway says "[model] budget limit" on each refusal; quiet here, restored after.
  const loud = console.error;
  console.error = (...a: unknown[]) => { if (!/^\[model\] budget limit/.test(String(a[0] ?? ""))) loud(...a); };
  let convs = 0, calls = 0, refused = 0, cachedNoCall = 0;
  try {
    const worst1 = responsesWorst(DEFAULT_SEARCH_MODEL, { tool_choice: "required", max_tool_calls: 1, max_output_tokens: 1400, include: ["web_search_call.action.sources"], tools: [{ type: "web_search" }], input: "x".repeat(700) }).micros;
    for (let k = 0; k < 150; k++) {
      convs++;
      // One person's conversation: 6 questions (some repeated), a day budget that fits a few searches, an outage on some.
      const inner = memoryBudgetGate(worst1 * r.int(1, 12) + r.int(0, worst1 - 1));
      let okReserves = 0, refusals = 0;
      const gate = { ...inner, reserve: async (m: number, meta: any) => { const x = await inner.reserve(m, meta); if (x.ok) okReserves++; else refusals++; return x; } };
      const sent: { body: any; reserved: number }[] = [];
      let outage = r.next() < 0.3 ? r.int(1, 4) : 0;
      const fetchFake = (async (_u: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        sent.push({ body, reserved: inner.snapshot().reserved });
        if (outage > 0) { outage--; return new Response(JSON.stringify({ error: { message: "scripted outage" } }), { status: 500, headers: { "content-type": "application/json" } }); }
        const good = { kind: "pay", text: "The median annual wage for financial analysts was $99,890 in May 2023.", quote: "The median annual wage for financial analysts was $99,890 in May 2023.", url: "https://www.bls.gov/ooh/business-and-financial/financial-analysts.htm" };
        const kinds = String(body.input).match(/"kind":"([^"]+)"/)?.[1].split("|") ?? ["pay"];
        const output = [{ type: "web_search_call", action: { type: "search", sources: [{ url: good.url }] } }, { type: "message", content: [{ type: "output_text", text: JSON.stringify({ facts: [{ ...good, kind: kinds.includes("pay") ? "pay" : kinds[0] }] }), annotations: [] }] }];
        return new Response(JSON.stringify({ output, usage: { input_tokens: 1200, output_tokens: 150 } }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const search = openAiGroundSearch({ fetch: fetchFake, apiKey: "sk-test-not-real", model: DEFAULT_SEARCH_MODEL, budget: gate });
      const cache = memoryGroundCache();
      const asked = new Set<string>();
      for (let q = 0; q < 6; q++) {
        const message = asked.size && r.next() < 0.4 ? r.pick([...asked]) : r.pick(QUESTIONS);
        const before = sent.length, refusedBefore = refusals;
        const res = await researchCareerQuestion({ profile: null, message, deps: { search, cache }, now: NOW + k * 100_000 + q * 1000 });
        const tag = `conv ${k} q${q} ${JSON.stringify(message)}`;
        const made = sent.length - before;
        calls += made;
        asked.add(message);
        if (res.status !== "ok") continue;
        if (res.grounding.from_cache) { if (made) fail(f, "cached-called", `${tag}: ${made}`); else cachedNoCall++; }
        if (refusals > refusedBefore) {
          refused++;
          // a search the budget refused is said in the brief ("not completed"), never silently skipped
          if (!/not completed|could not|couldn't|not verif/i.test(res.brief_markdown)) fail(f, "unverified-unsaid", `${tag}: ${res.brief_markdown.slice(0, 200)}`);
        }
        // every request went out after its own reservation, for at least its worst case, with one tool call
        for (const s of sent.slice(before)) {
          const w = responsesWorst(DEFAULT_SEARCH_MODEL, s.body).micros;
          if (s.reserved < w) fail(f, "reserved-before", `${tag}: ${s.reserved} reserved, worst case ${w}`);
          if (!(Number(s.body.max_tool_calls) >= 1 && Number(s.body.max_tool_calls) <= WEB_SEARCH_MAX_CALLS)) fail(f, "max-tool-calls", `${tag}: ${s.body.max_tool_calls}`);
        }
        if (sent.length !== okReserves) fail(f, "call-without-reservation", `${tag}: ${sent.length} requests, ${okReserves} reservations`);
        const snap = inner.snapshot();
        if (snap.reserved !== 0) fail(f, "left-open", `${tag}: ${JSON.stringify(snap)}`);
        if (snap.spent > snap.limit) fail(f, "over-limit", `${tag}: ${JSON.stringify(snap)}`);
      }
    }
  } finally {
    console.error = loud;
    if (saved === undefined) Deno.env.delete("MODEL_BUDGET_PAUSED"); else Deno.env.set("MODEL_BUDGET_PAUSED", saved);
  }
  console.log(`[research-r2] budget: ${convs} conversations; requests ${calls}, answered from the cache with no call ${cachedNoCall}, questions that met the day's limit ${refused}`);
  assertNode.ok(cachedNoCall > 0 && refused > 0, "each path ran");
  report(f, convs, "budget");
});

Deno.test("a failed search is searched again on the next ask; a complete one is not (the cache keeps only complete answers)", async () => {
  const cache = memoryGroundCache();
  let calls = 0, fail1 = true;
  const search: GroundSearch = async (plan) => {
    calls++;
    if (fail1) return { status: "error", detail: "scripted outage" };
    const good = { kind: plan.kinds[0], text: "The median annual wage for financial analysts was $99,890 in May 2023.", quote: "The median annual wage for financial analysts was $99,890 in May 2023.", url: "https://www.bls.gov/ooh/business-and-financial/financial-analysts.htm" };
    return { status: "ok", facts: [{ ...good, id: "", label: "bls.gov" } as any], urls: [good.url], cost_usd: 0.01 };
  };
  const ask = (n: number) => researchCareerQuestion({ profile: null, message: "how do I break into investment banking?", deps: { search, cache }, now: NOW + n });
  const a = await ask(1);
  assertNode.ok(a.status === "ok" && calls > 0 && /not completed/.test(a.brief_markdown), "the outage is said");
  fail1 = false;
  const n1 = calls;
  const b = await ask(2);
  assertNode.ok(b.status === "ok" && calls > n1 && !b.grounding.from_cache, "searched again after the failure");
  const n2 = calls;
  const c = await ask(3);
  assertNode.ok(c.status === "ok" && calls === n2 && c.grounding.from_cache, "the complete answer is cached");
});
