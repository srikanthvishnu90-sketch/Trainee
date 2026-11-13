// Review of #790 (D-070), 2026-11-13: fixes for the three findings of the independent review, each reproduced here first.
//   FW-1  BLOCKER (owner must-fix "resume edits never drop experience"; D-007): code set a CONFIRMED fact back to a draft on a regex
//         guess over the person's message ("Please don't put the 2024 hackathon first on my resume" withdrew the Acme internship,
//         which then left every resume). Code now fails closed. It sets a fact aside only when one clause of the message is nothing
//         but that fact (every value of it, a figure no other fact holds), an explicit statement that it is wrong, out of date or to
//         be removed from the profile, and filler; never a role, project or skill; never a question, a negation, reported speech or a
//         layout ask. Everything else changes NOTHING in storage and reaches the model as a note (it asks, or uses
//         correct_profile_fact, which waits for the person's yes). A set-aside is said in the reply and can be put back.
//   FW-2  MAJOR: "frontend engineer san francisco or new york" searched "... san francisco york" and "... san new york".
//   FW-3  MINOR: the changelog said "Same as your base resume" while entries had lost their detail lines.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/fact-withdrawal-failclosed-20261113.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { CareerRouter } from "../../supabase/functions/_shared/router_core.career.js";
import { agentTurn } from "../../supabase/functions/agent-chat/career_brain.ts";
import { stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import * as notes from "../../supabase/functions/_shared/agent/turn_notes.ts";
import * as searchMod from "../../supabase/functions/_shared/career_search.ts";
const { orAlternatives } = searchMod, orSearchFn = (searchMod as any).orSearch ?? ((q: string) => ({ queries: orAlternatives(q), groups: [["?"]], not_searched: [] }));
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { edgeRenderer, memoryResumeStore, tailorForPosting } from "../../supabase/functions/_shared/career_tailor.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const NOW = Date.parse("2026-11-13T03:00:00Z");
const PERSONA = JSON.parse(Deno.readTextFileSync(new URL("../../evals/mirror/instinct-wa-batch1/persona.json", import.meta.url)));
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
const { staleFactsOf } = notes;
// The note-only reading (added by the fix): the confirmed facts a message MAY be correcting. Nothing is changed for these.
const hints = (m: string, facts: any[]): any[] => (notes as any).factCorrectionHints?.(m, facts) ?? [];

// The review's fixture facts (its stale.ts), and the persona's real confirmed record (resume, then "Yes, that's my resume").
const FIX = () => [
  { id: "e1", kind: "experience", title: "Software Engineering Intern, Acme (Jun 2024 - Aug 2024)", text: "Built dashboards for 900 analysts", status: "confirmed" },
  { id: "e2", kind: "experience", title: "Finance Intern, Example Capital", text: "Modeled 120 deals", status: "confirmed" },
  { id: "g", kind: "other", section: "gpa", name: "GPA", title: "GPA 3.9", text: "GPA: 3.9", status: "confirmed" },
  { id: "ed", kind: "education", title: "Education: BS Computer Science, State University, 2026", status: "confirmed" },
  { id: "ph", kind: "contact", title: "Phone: 312-555-0100", status: "confirmed" },
  { id: "sk", kind: "skill", name: "Python", title: "Skills: Python, SQL", status: "confirmed" },
];
function personaProfile() {
  const ctx: any = { now: NOW, thread: {} };
  for (const s of PERSONA.setup.slice(0, 2)) CareerRouter.handleChat(s, ctx);
  return ctx.profile;
}
const ids = (fs: any[]) => fs.map((f) => String(f.id)).sort();

// ---------------------------------------------------------------- FW-1 the hostile table: nothing is withdrawn
const HOSTILE: string[] = [
  // the review's four reproductions
  "Please don't put the 2024 hackathon first on my resume",
  "My friend said don't put GPA under 3.5; mine is 3.9 so keep it",
  "Don't use the Acme posting from 2026, find me newer ones",
  "don't include a cover letter for the Stripe one, my skills speak for themselves",
  // ordering and layout asks
  "don't put the 3.9 gpa at the top, move it under education",
  "Don't list my skills before my experience",
  "never put education first, lead with the Acme internship",
  "stop putting Python last in the skills line",
  "don't show the GPA 3.9 in bold",
  "Don't include the 2026 graduation date on the first line, put it on the right",
  "please don't use two columns for the skills section",
  "Don't put my phone 312-555-0100 in the header, put it in the footer",
  "the layout is outdated, use a modern template but keep the 3.9 gpa",
  "remove the 3.9 gpa from this resume version",
  "take the 3.9 gpa off the first page",
  "don't list my phone on the resume, and by the way my education is fine",
  // negated verbs about other objects
  "never use Comic Sans; my GPA is 3.9",
  "Stop using emojis. Also is 120 applications too many?",
  "don't use the 2025 template, it's ugly",
  "That Example Capital posting is outdated, don't use it",
  "the job board link from 2024 is no longer valid",
  "don't list jobs that want a 3.9 or higher",
  "Stop showing me roles that need Python and SQL",
  "my old address isn't current anymore but my education section is good",
  "my old school's site is outdated",
  "don't include the Stripe posting in the 120 I asked for",
  "The salary data you used is out of date, the 900 figure is wrong",
  "version 3.9 of the template is outdated",
  "the 3.9 gpa requirement at Citadel is outdated",
  "python is outdated",
  "my skills are outdated, what should I learn?",
  "my phone is outdated, I need a new one",
  "my education is no longer current with industry trends",
  // quoted or reported advice
  "A recruiter told me a 3.9 gpa is outdated as a filter, is that true?",
  'the career center says "the 3.9 gpa is outdated" about someone else\'s resume',
  "My mom thinks my phone number 312-555-0100 is wrong but it's right",
  "Reddit says listing Python is outdated, should I keep it?",
  "He said: the 3.9 gpa is outdated.",
  '"the 3.9 gpa is outdated"',
  "my advisor wrote that GPA 3.9 is no longer accurate for honors, she meant the cutoff",
  // hypotheticals
  "If my 3.9 gpa were outdated, what would you do?",
  "Suppose the 3.9 is no longer accurate, would that hurt me?",
  "What if I said my Acme internship is no longer true?",
  "would you remove the 3.9 gpa from my profile if I asked?",
  "imagine my phone 312-555-0100 is out of date, how would recruiters reach me",
  // "don't forget to include", "don't remove"
  "don't forget to include the 3.9 gpa",
  "Don't remove the 3.9 GPA from my profile",
  "never remove my Acme internship, it's my best experience",
  "don't forget to list Python and SQL",
  "do not delete the GPA 3.9 from my record",
  "don't stop using the 3.9 gpa",
  "please don't take the 3.9 gpa off my record",
  "the 3.9 gpa is not outdated",
  "my 3.9 gpa isn't wrong, keep it",
  "The 3.9 gpa is outdated. Just kidding, keep it.",
  // dates and figures that match several facts, or none
  "the 2026 one is outdated",
  "2024 is outdated",
  "anything from 2025 is no longer current",
  "the 2026 stuff is wrong now",
  "GPA 3.5 is outdated",
  "the 3.9 gpa and the phone 312-555-0100 are outdated",
  // questions
  "Is it true that a 3.9 is no longer accurate as a cutoff at Citadel?",
  "is my 3.9 gpa outdated?",
  "Is the 3.9 gpa out of date",
  "should I remove the 3.9 gpa from my profile?",
  "Can you delete the GPA 3.9 from my record or is that a bad idea?",
  "the 3.9 gpa is outdated?",
  // a role is never set aside by code, however plainly said (the model asks; the person's yes decides)
  "Software Engineering Intern, Acme (Jun 2024 - Aug 2024) is outdated",
  "remove Pixelforge from my profile",
  "the Skills: Python, SQL line is outdated",
];

Deno.test("FW-1 the hostile table: no message withdraws a fact (pure reading, the review's facts and the persona's real record)", () => {
  ok(HOSTILE.length >= 50, `${HOSTILE.length} hostile messages`);
  const persona = personaProfile().facts, bad: string[] = [];
  for (const m of HOSTILE) {
    const a = ids(staleFactsOf(m, FIX())), b = ids(staleFactsOf(m, persona));
    if (a.length || b.length) bad.push(`${JSON.stringify(m)} => ${JSON.stringify([...a, ...b])}`);
  }
  eq(bad, [], `${bad.length} of ${HOSTILE.length} hostile messages withdrew a fact`);
});

Deno.test("FW-1 the hostile table through the brain turn: storage is byte-for-byte unchanged, and the model is never told a fact was set aside", async () => {
  const bad: string[] = [];
  for (const m of HOSTILE) {
    for (const facts of [FIX(), null]) {
      const profile = personaProfile();
      if (facts) profile.facts = facts;
      const before = JSON.stringify(profile), stores = { profile }, seen: any[] = [];
      const r: any = await agentTurn({ message: m, history: [], stores, userId: "u-fw", threadId: "th", now: NOW, model: async (p: any) => { seen.push(p); return text("Okay."); } } as any);
      if (JSON.stringify(stores.profile) !== before) bad.push(`changed storage: ${JSON.stringify(m)}`);
      if (seen.some((p) => /already set it aside/.test(String(p.system)))) bad.push(`told the model a fact was set aside: ${JSON.stringify(m)}`);
      if (r.set_aside?.length || /Set aside/.test(String(r.reply))) bad.push(`reported a set-aside: ${JSON.stringify(m)}`);
    }
  }
  eq(bad, []);
});

// ---------------------------------------------------------------- FW-1 true corrections: the right fact, or a note
// "withdraw": code sets exactly this fact aside. "note": storage is unchanged and the model is told which fact they may mean.
const TRUE: [string, "withdraw" | "note", string][] = [
  [PERSONA.setup[2], "withdraw", "g"],
  ["the 3.9 gpa on there is outdated, don't reuse it", "withdraw", "g"],
  ["My 3.9 GPA is out of date.", "withdraw", "g"],
  ["the gpa 3.9 on my resume is outdated", "withdraw", "g"],
  ["my 3.9 gpa is no longer correct, do not use it", "withdraw", "g"],
  // round 2 (review of the fix): only the statements D70-3 and its neighbours need; every other one is the model's, as a note
  ["GPA 3.9 is no longer accurate", "note", "g"],
  ["fyi the 3.9 gpa isn't accurate anymore", "note", "g"],
  ["Please remove the 3.9 GPA from my profile", "note", "g"],
  ["the 3.9 gpa on my resume is wrong now", "note", "g"],
  ["the phone 312-555-0100 is no longer current", "note", "ph"],
  ["Heads up: my 3.9 gpa is outdated. Can you find SWE internships in Chicago?", "note", "g"],
  ["my gpa is outdated, it's 3.7 now", "note", "g"],
  ["The 3.9 is outdated, my GPA is 3.7 after this semester", "note", "g"],
  ["don't use the 3.9 gpa anymore", "note", "g"],
  ["my phone number is out of date, the new one is 312-555-0199", "note", "ph"],
  ["the education line is wrong now, I graduate in 2027 not 2026", "note", "ed"],
  ["Python and SQL are outdated, my skills are now Rust and Go", "note", "sk"],
  ["the Acme internship dates are no longer accurate, it ended in Sep 2024", "note", "e1"],
  ["Software Engineering Intern at Acme is no longer accurate", "note", "e1"],
  ["Finance Intern at Example Capital is wrong now, I never finished it", "note", "e2"],
  ["The Acme internship is outdated, please remove it from my profile", "note", "e1"],
];

Deno.test("FW-1 true corrections: each withdraws exactly the right fact, or changes nothing and reaches the model as a note", async () => {
  ok(TRUE.length >= 15, `${TRUE.length} true corrections`);
  const bad: string[] = [];
  for (const [m, how, id] of TRUE) {
    const facts = FIX(), w = ids(staleFactsOf(m, facts)), h = ids(hints(m, facts));
    if (how === "withdraw" && JSON.stringify(w) !== JSON.stringify([id])) bad.push(`${JSON.stringify(m)}: withdrew ${JSON.stringify(w)}, wanted [${id}]`);
    if (how === "note" && (w.length || !h.includes(id))) bad.push(`${JSON.stringify(m)}: withdrew ${JSON.stringify(w)}, note names ${JSON.stringify(h)}, wanted a note naming ${id}`);
    if (how !== "note") continue;
    // Through the turn: nothing in storage changes, and the model is told what they may be correcting and that nothing was changed.
    const profile = personaProfile();
    profile.facts = facts;
    const before = JSON.stringify(profile), stores = { profile }, seen: any[] = [];
    await agentTurn({ message: m, history: [], stores, userId: "u-fw", threadId: "th", now: NOW, model: async (p: any) => { seen.push(p); return text("Which one do you mean?"); } } as any);
    if (JSON.stringify(stores.profile) !== before) bad.push(`${JSON.stringify(m)}: a note-only correction changed storage`);
    const title = String(facts.find((f) => f.id === id)!.title);
    if (how === "note" && id === "g" && !hints(m, personaProfile().facts).some((f: any) => f.text === "GPA: 3.9")) bad.push(`${JSON.stringify(m)}: no note on the persona's real record`);
    if (!/MAY BE CORRECTING/.test(seen[0].system) || !seen[0].system.includes(JSON.stringify(title)) || !/nothing (?:was|has been) changed/i.test(seen[0].system)) bad.push(`${JSON.stringify(m)}: the model was not given the note naming ${title}`);
  }
  eq(bad, []);
});

// ---------------------------------------------------------------- FW-1 a withdrawal is said, and can be put back
Deno.test("FW-1 a set-aside is stated in the reply (which fact), is recorded with what it was, and comes back only on the person's yes to it", async () => {
  const profile = personaProfile(), stores = { profile };
  const gpa = (profile.facts as any[]).find((f) => /GPA/.test(String(f.text)));
  // The model's reply does not name the fact: the turn's own line does, in the fact's words.
  const r: any = await agentTurn({ message: PERSONA.setup[2], history: [], stores, userId: "u-fw", threadId: "th", now: NOW, model: async () => text("Got it. I'm searching SWE internships next.") } as any);
  eq(r.set_aside, [{ id: gpa.id, text: "GPA: 3.9" }], "the turn reports the fact set aside");
  ok(r.reply.includes("GPA: 3.9") && /set aside/i.test(r.reply), `the person is told which fact: ${r.reply}`);
  eq([gpa.status, gpa.needs_confirmation], ["draft", true]);
  eq(gpa.withdrawn_by_owner.was, { status: "confirmed", needs_confirmation: false }, "what it was is kept, so it can be put back");
  // A reply that already names the fact is left as the model wrote it.
  const p2 = personaProfile();
  const said = "Got it: the 3.9 GPA is off your record and won't be used.";
  const r2: any = await agentTurn({ message: PERSONA.setup[2], history: [], stores: { profile: p2 }, userId: "u-fw", threadId: "th", now: NOW, model: async () => text(said) } as any);
  eq(r2.reply, said);
  // Put back (round 2): only on a yes to the turn code marked as having asked about THIS fact (restore_ask, kept in the message's
  // meta); never by the fact's words in the question before.
  const tools = Object.fromEntries(careerTools({ postings: async () => [] } as any).map((t: any) => [t.name, t]));
  const ctxFor = (message: string, before: string, restoreAsk?: unknown) => ({ userId: "u-fw", threadId: "th", now: NOW + 60_000, state: stores, restoreAsk, turn: { message, added: [], before } }) as any;
  for (const before of [r.reply, "Put GPA: 3.9 back on your record?", "Should I leave GPA 3.9 off the Stripe application?", "Apply to Citadel (requires GPA 3.9 or higher)?", ""]) {
    await assertNode.rejects(() => tools.confirm_profile_fact.run({ id: gpa.id }, ctxFor("yes", before)), /not confirmed/, before);
    await assertNode.rejects(() => tools.confirm_profile_fact.run({ id: gpa.id }, ctxFor("yes", before, { fact_id: "F-999" })), /not confirmed/, before);
    eq(gpa.status, "draft");
  }
  await assertNode.rejects(() => tools.confirm_profile_fact.run({ id: gpa.id }, ctxFor("maybe", "Is GPA: 3.9 right again?", { fact_id: gpa.id })), /not confirmed/);
  // The marker is set by code: the model tried to put the fact back, was refused, and its reply asks about that fact.
  let n = 0;
  const asked: any = await agentTurn({ message: "actually can you put my gpa back", history: [], stores, userId: "u-fw", threadId: "th", now: NOW + 30_000,
    model: async (p: any) => p.tools?.length && n++ === 0 ? { content: [{ type: "tool_use", id: "t1", name: "confirm_profile_fact", input: { id: gpa.id } }], stop_reason: "tool_use" } : text("Is GPA: 3.9 right again?") } as any);
  eq(asked.restore_ask, { fact_id: gpa.id }, "the turn carries the marker");
  eq(gpa.status, "draft");
  n = 0;
  const yes: any = await agentTurn({ message: "yes", history: [{ role: "user", content: "actually can you put my gpa back" }, { role: "assistant", content: asked.reply }], restoreAsk: asked.restore_ask, stores, userId: "u-fw", threadId: "th", now: NOW + 60_000,
    model: async (p: any) => p.tools?.length && n++ === 0 ? { content: [{ type: "tool_use", id: "t1", name: "confirm_profile_fact", input: { id: gpa.id } }], stop_reason: "tool_use" } : text("GPA: 3.9 is back on your record.") } as any);
  ok(yes.tool_calls.some((c: any) => c.name === "confirm_profile_fact" && c.ok), JSON.stringify(yes.tool_calls));
  eq([gpa.status, gpa.needs_confirmation, gpa.withdrawn_by_owner], ["confirmed", false, undefined]);
});

// ---------------------------------------------------------------- FW-1 routing: unchanged for a correction, and the reason is honest
const host = (CareerHost as any).createCareerHost({ CareerAccess: (core as any).CareerAccess, CareerOnboarding: (core as any).CareerOnboarding, CareerRouter: (core as any).CareerRouter, CareerDoorstep: (core as any).CareerDoorstep, CareerReply: (core as any).CareerReply, CareerContainment: (core as any).CareerContainment, CareerDossier: (core as any).CareerDossier });
const STAGED = { get: (k: string) => ({ CAREER_BRAIN: "staged" } as Record<string, string>)[k] };
Deno.test("FW-1 routing: a message that may correct a fact is the brain's, named as a possible correction (not as a withdrawal)", () => {
  let snap: unknown = null;
  for (const m of PERSONA.setup.slice(0, 2)) { const c = host.createTurnCtx({ userId: "u-fw", threadId: "t-fw", now: NOW, snapshot: snap, accountPersistence: true }); host.runTurn(m, c); snap = host.extractSnapshot(c); }
  const next = () => host.createTurnCtx({ userId: "u-fw", threadId: "t-fw", now: NOW, snapshot: snap, accountPersistence: true });
  const d = (m: string) => { const x = stagedDecision({ env: STAGED, message: m, ctx: next(), host, structured: false }); return [x.brain, x.reason]; };
  eq(d(PERSONA.setup[2]), [true, "stale_fact_correction"]);
  eq(d("don't use the 3.9 gpa anymore"), [true, "possible_fact_correction"]);
  eq(d("Please don't put the 2025 hackathon first on my resume"), [true, "possible_fact_correction"]);
});

// ---------------------------------------------------------------- FW-2 "or" keeps multi-word places and employers whole
const OR: [string, string[]][] = [
  // the review's two reproductions
  ["frontend engineer san francisco or new york", ["frontend engineer san francisco", "frontend engineer new york"]],
  ["morgan stanley or goldman sachs analyst", ["morgan stanley analyst", "goldman sachs analyst"]],
  ["morgan stanley or goldman sachs", ["morgan stanley", "goldman sachs"]],
  // what already worked stays as it was
  ["software engineer intern chicago or remote", ["software engineer intern chicago", "software engineer intern remote"]],
  ["SWE internship in Chicago or remote", ["SWE internship in Chicago", "SWE internship in remote"]],
  ["data or product analyst new york", ["data analyst new york", "product analyst new york"]],
  ["R or Python analyst", ["R analyst", "Python analyst"]],
  ["data analyst", ["data analyst"]],
  ["software engineer intern summer 2027 Chicago or remote", ["software engineer intern summer 2027 Chicago", "software engineer intern summer 2027 remote"]],
  // multi-word places on either side, or both
  ["swe intern new york or chicago", ["swe intern new york", "swe intern chicago"]],
  ["swe intern chicago or new york", ["swe intern chicago", "swe intern new york"]],
  ["new york or san francisco data analyst", ["new york data analyst", "san francisco data analyst"]],
  ["product manager los angeles or salt lake city", ["product manager los angeles", "product manager salt lake city"]],
  ["remote or new york software engineer", ["remote software engineer", "new york software engineer"]],
  ["data analyst in san francisco or remote", ["data analyst in san francisco", "data analyst in remote"]],
  ["analyst new york or san francisco or remote", ["analyst new york", "analyst san francisco", "analyst remote"]],
  ["engineer chicago or austin or remote", ["engineer chicago", "engineer austin", "engineer remote"]],
  ["designer london or new york", ["designer london", "designer new york"]],
  ["swe intern san jose or remote", ["swe intern san jose", "swe intern remote"]],
  ["swe intern remote or san jose", ["swe intern remote", "swe intern san jose"]],
  ["chicago or new york city product analyst", ["chicago product analyst", "new york city product analyst"]],
  // employers: whole on both sides; a shared role after them goes to each
  ["stripe or goldman sachs", ["stripe", "goldman sachs"]],
  ["react or vue frontend", ["react frontend", "vue frontend"]],
  ["goldman sachs or stripe", ["goldman sachs", "stripe"]],
  ["jane street or two sigma intern", ["jane street intern", "two sigma intern"]],
  ["jp morgan or bank of america analyst", ["jp morgan analyst", "bank of america analyst"]],
  ["oracle or salesforce account executive", ["oracle account executive", "salesforce account executive"]],
  ["labor or employment lawyer", ["labor lawyer", "employment lawyer"]],
  ["PM or TPM google", ["PM google", "TPM google"]],
  ["google or meta software engineer intern summer 2027", ["google software engineer intern summer 2027", "meta software engineer intern summer 2027"]],
  ["part-time or full-time barista portland", ["part-time barista portland", "full-time barista portland"]],
  ["backend engineer (python or go) remote", ["backend engineer python remote", "backend engineer go remote"]],
  ["software engineer at google or at meta", ["software engineer at google", "software engineer at meta"]],
  ["analyst at morgan stanley or at goldman sachs in new york", ["analyst at morgan stanley in new york", "analyst at goldman sachs in new york"]],
  ["quant trader or quant researcher or quant developer", ["quant trader", "quant researcher", "quant developer"]],
  ["investment banking or private equity analyst new york", ["investment banking analyst new york", "private equity analyst new york"]],
  ["machine learning engineer or data scientist san francisco bay area", ["machine learning engineer san francisco bay area", "data scientist san francisco bay area"]],
  ["intern or new grad swe in sf or nyc", ["intern swe in sf", "new grad swe in sf", "intern swe in nyc", "new grad swe in nyc"]],
  ["data analyst san francisco or san jose or oakland", ["data analyst san francisco", "data analyst san jose", "data analyst oakland"]],
  ["finance intern new york, ny or boston, ma", ["finance intern new york, ny", "finance intern boston, ma"]],
  ["data engineer either remote or in denver", ["data engineer remote", "data engineer in denver"]],
  ["python and/or java developer chicago", ["python developer chicago", "java developer chicago"]],
  ["summer 2027 or fall 2027 swe intern", ["summer 2027 swe intern", "fall 2027 swe intern"]],
  ["part time or full time barista", ["part time barista", "full time barista"]],
  ["doctor or nurse practitioner portland oregon", ["doctor portland oregon", "nurse practitioner portland oregon"]],
  ["Software Engineer OR Data Engineer", ["Software Engineer", "Data Engineer"]],
  ["chicago or", ["chicago or"]],
  ["or", ["or"]],
  ["stripe or square engineer", ["stripe engineer", "square engineer"]],
  // roles: each side keeps its own words when both are whole roles; one shared head word goes to each
  ["data analyst or product manager", ["data analyst", "product manager"]],
  ["frontend engineer or designer", ["frontend engineer", "designer"]],
  ["software engineer intern python or java", ["software engineer intern python", "software engineer intern java"]],
  ["java or python or go developer", ["java developer", "python developer", "go developer"]],
  ["data analyst or product manager chicago", ["data analyst chicago", "product manager chicago"]],
  ["frontend or backend engineer san francisco or new york", ["frontend engineer san francisco", "backend engineer san francisco", "frontend engineer new york", "backend engineer new york"]],
  // not an alternative at all
  ["orlando marketing coordinator", ["orlando marketing coordinator"]],
];
Deno.test("FW-2 'or' alternatives: multi-word places and employer names stay whole on both sides, and no alternative mixes the two sides' words", () => {
  ok(OR.length >= 25, `${OR.length} cases`);
  const bad: string[] = [];
  for (const [q, want] of OR) {
    const got = orAlternatives(q);
    if (JSON.stringify([...got].sort()) !== JSON.stringify([...want].sort())) bad.push(`${JSON.stringify(q)} => ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
  }
  eq(bad, []);
});

// ---------------------------------------------------------------- FW-3 the changelog never says "same" over shortened entries
Deno.test("FW-3 a version whose entries lost their detail lines says so, and which, instead of 'Same as your base resume'", async () => {
  const facts = [
    { id: "x1", kind: "experience", title: "Line Cook, Harbor Diner (2023 - 2024)", text: "Line Cook, Harbor Diner (2023 - 2024)", bullets: ["Ran the grill station for 200 covers a night", "Trained 4 new cooks"], status: "confirmed", needs_confirmation: false },
    { id: "x2", kind: "experience", title: "Lifeguard, City Pool (2022)", text: "Lifeguard, City Pool (2022)", bullets: ["Watched a 25 meter pool"], status: "confirmed", needs_confirmation: false },
    { id: "x3", kind: "experience", title: "Cashier, Corner Market (2021)", text: "Cashier, Corner Market (2021)", bullets: ["Handled the register on weekends"], status: "confirmed", needs_confirmation: false },
    { id: "x6", kind: "experience", title: "Barista, Bean House (2020)", text: "Barista, Bean House (2020)", bullets: ["Made 300 drinks a shift", "Opened the store"], status: "confirmed", needs_confirmation: false },
    { id: "x7", kind: "experience", title: "Tutor, Math Lab (2019)", text: "Tutor, Math Lab (2019)", bullets: ["Tutored 12 students in algebra"], status: "confirmed", needs_confirmation: false },
  ];
  const profile = { basics: { name: "Sam Rivera", email: "sam@example.com" }, facts };
  const t: any = await tailorForPosting({ userId: "00000000-0000-4000-8000-000000001171", profile, posting: { text: "Quantum Researcher at Example Labs\n\nWe study superconducting qubits.", company: "Example Labs" },
    deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW, reviewDraft: true });
  ok(t.ok, JSON.stringify(t).slice(0, 300));
  const printed = t.detail.doc.lines.map((l: any) => l.text);
  const lost = facts.flatMap((f) => f.bullets).filter((b) => !printed.includes(b));
  ok(lost.length > 0, "the fixture: entries this posting does not ask for print without their detail lines");
  ok(!/Same as your base resume/.test(t.changelog), `not the same as the base resume: ${t.changelog}`);
  for (const f of facts.filter((x) => x.bullets.some((b) => lost.includes(b)))) ok(t.changelog.includes(f.title.replace(/\s*\(.*$/, "").split(",")[0]), `names ${f.title}: ${t.changelog}`);
  ok(!t.changelog.includes("\n") && t.changelog.length <= 300 && !/[*#`_]/.test(t.changelog), "still one plain line");
  eq(t.shortened.length, facts.filter((x) => x.bullets.some((b) => lost.includes(b))).length, "the result names every shortened entry");
});

// ================================================================ ROUND 2 (adversarial review of the fix, 2026-11-13)
const REVIEW_MSGS: string[] = Deno.readTextFileSync(new URL("./fixtures/fact-withdrawal-review-msgs.txt", import.meta.url)).split("\n===\n").map((x) => x.replace(/\\n/g, "\n")).filter((x) => x.trim());
// The reviewer's record (its a1.ts): every kind a resume prints, a contact, a work authorisation, and two scores.
const REVIEW_FACTS = () => [
  { id: "ed", kind: "education", title: "Lakeshore University, BS Computer Science, Expected June 2029", text: "Lakeshore University, BS Computer Science, Expected June 2029" },
  { id: "gpa", kind: "other", title: "GPA 3.9", text: "GPA: 3.9", name: "GPA", section: "gpa" },
  { id: "grad", kind: "other", title: "Graduation: May 2027", text: "Graduation: May 2027", name: "Graduation" },
  { id: "visa", kind: "other", title: "Work authorization: F-1 OPT", text: "Work authorization: F-1 OPT", name: "Work authorization" },
  { id: "ph", kind: "contact", title: "Phone: 312-555-0100", text: "Phone: 312-555-0100" },
  { id: "em", kind: "contact", title: "Email: sam77@example.com", text: "Email: sam77@example.com" },
  { id: "loc", kind: "other", title: "Location: Chicago, IL 60614", text: "Location: Chicago, IL 60614" },
  { id: "aw", kind: "award", title: "Award: Dean's List 2023", text: "Award: Dean's List 2023" },
  { id: "cert", kind: "certification", title: "AWS Cloud Practitioner (2022)", text: "AWS Cloud Practitioner (2022)" },
  { id: "lead", kind: "leadership", title: "President, Chess Club (2021)", text: "President, Chess Club (2021)" },
  { id: "e1", kind: "experience", title: "Software Engineering Intern, Acme (Jun 2024 - Aug 2024)", text: "Software Engineering Intern, Acme (Jun 2024 - Aug 2024)" },
  { id: "e2", kind: "experience", title: "Finance Intern, Example Capital (2024 - 2025)", text: "Finance Intern, Example Capital (2024 - 2025)" },
  { id: "pr", kind: "project", title: "Hackathon winner 2024: route planner", text: "Hackathon winner 2024: route planner" },
  { id: "sk", kind: "skill", name: "Python", title: "Python", text: "Skill: Python" },
  { id: "sat", kind: "other", title: "SAT: 1540", text: "SAT: 1540" },
].map((f) => ({ ...f, status: "confirmed", needs_confirmation: false }));
// The one shape code may act on, written here independently of the product's reader: the whole message is one sentence, a score
// by its label and value, one of three statements, and nothing else (the tail D70-3's message carries is allowed).
const ONE_SHAPE = /^(?:the |my )?(?:(?:gpa 3\.9|3\.9 gpa)|(?:sat 1540|1540 sat))(?: on there| on my resume| on the resume)? is (?:outdated|out of date|no longer (?:right|correct|true))(?:, (?:don't|do not) (?:reuse|use) it)?\.?$/i;
const HOSTILE2: string[] = [
  // more than one sentence, or a trailing fragment
  "The 3.9 gpa is outdated. Lol no.", "The 3.9 gpa is outdated. Not.", "The 3.9 gpa is outdated. I made that up.", "The 3.9 gpa is outdated. I lied.", "Okay. The 3.9 gpa is outdated.",
  "the 3.9 gpa is outdated\nsaid no one ever", "the 3.9 gpa is outdated, right", "the 3.9 gpa is outdated maybe", "the 3.9 gpa is outdated i think", "the 3.9 gpa is outdated or not",
  "the 3.9 gpa is outdated on linkedin", "the 3.9 gpa is outdated for quant firms", "the 3.9 gpa is outdated lol", "the 3.9 gpa is outdated /s", "the 3.9 gpa is outdated (not)",
  // questions and question marks of any script, quotation marks of any kind, symbols
  "the 3.9 gpa is outdated?", "The 3.9 GPA is outdated？", "¿the 3.9 gpa is outdated", "the 3.9 gpa is outdated;", "the 3.9 gpa is outdated?!", "'the 3.9 gpa is outdated'", "\"the 3.9 gpa is outdated\"",
  "‘the 3.9 gpa is outdated’", "“the 3.9 gpa is outdated”", "«the 3.9 gpa is outdated»", "`the 3.9 gpa is outdated`", "3.9 gpa != outdated", "3.9 gpa ≠ outdated", "¬ the 3.9 gpa is outdated", "GPA 3.9 → outdated",
  "the 3.9 gpa is outdated 😂", "the 3.9 gpa is outdated ;)", "the 3.9 gpa is outdated!", "- the 3.9 gpa is outdated", "1. the 3.9 gpa is outdated", "> the 3.9 gpa is outdated", "the 3.9 gpa is outdated...",
  // another language, a negation or a doubt, a third party, a task aimed at the text
  "my 3.9 gpa не outdated", "我的 gpa 3.9 不是 outdated", "el gpa 3.9 está outdated", "the 3.9 gpa is not outdated", "the 3.9 gpa isn't outdated", "the 3.9 gpa is never outdated", "the 3.9 gpa is hardly outdated",
  "no the 3.9 gpa is outdated", "if the 3.9 gpa is outdated", "whether the 3.9 gpa is outdated", "i think the 3.9 gpa is outdated", "she said the 3.9 gpa is outdated", "the recruiter says the 3.9 gpa is outdated",
  "my brother's 3.9 gpa is outdated", "his 3.9 gpa is outdated", "their gpa 3.9 is outdated", "someone's 3.9 gpa is outdated", "my friend claimed the 3.9 gpa is outdated", "according to my advisor the 3.9 gpa is outdated",
  "translate the 3.9 gpa is outdated", "proofread the 3.9 gpa is outdated", "rewrite the 3.9 gpa is outdated", "pretend the 3.9 gpa is outdated", "imagine the 3.9 gpa is outdated", "suppose the 3.9 gpa is outdated",
  "say the 3.9 gpa is outdated", "repeat the 3.9 gpa is outdated", "He wrote: the 3.9 gpa is outdated",
  // a word the reader cannot classify, the fact without its label or its value, a statement trunk lacked
  "a 3.9 gpa is outdated", "that 3.9 gpa is outdated", "the 3.9 gpa on this resume is outdated", "the 3.9 gpa in there is outdated", "the 3.9 gpa thing is outdated", "the 3.9 is outdated", "3.9 is outdated", "my gpa is outdated",
  "the gpa 3.5 is outdated", "the 3.9 gpa is wrong", "the 3.9 gpa is old", "the 3.9 gpa is stale now", "remove the 3.9 gpa from my profile", "delete the gpa 3.9 from my record", "the 3.9 gpa is no longer accurate",
  "the 3.9 gpa is outdated, don't reuse it or else", "the 3.9 gpa is outdated, don't reuse it. That's what my recruiter claimed anyway.",
  "a few things to know: the 3.9 gpa on there is outdated, don't reuse it. Just kidding.", "a few things to know: the 3.9 gpa on there is outdated, don't reuse it. It is right.",
  "a few things to know: my mom said the 3.9 gpa on there is outdated, don't reuse it. I'm looking for a SWE internship for summer 2027.",
  // a kind code never sets aside, however exactly it is said
  "the phone 312-555-0100 is outdated", "my email sam77@example.com is outdated", "the work authorization F-1 OPT is outdated", "graduation May 2027 is outdated", "the location Chicago, IL 60614 is outdated",
  "AWS Cloud Practitioner (2022) is outdated", "President, Chess Club (2021) is outdated", "Award: Dean's List 2023 is outdated", "Lakeshore University, BS Computer Science, Expected June 2029 is outdated", "Skill: Python is outdated",
];
Deno.test("FW-A the reviewer's 176 and 60+ more: code sets a fact aside only for the one shape, and only a score (GPA, a test score)", () => {
  ok(REVIEW_MSGS.length >= 176 && HOSTILE2.length >= 60, `${REVIEW_MSGS.length} + ${HOSTILE2.length}`);
  const bad: string[] = [];
  let withdrew = 0;
  for (const m of [...REVIEW_MSGS, ...HOSTILE2, ...HOSTILE]) for (const facts of [REVIEW_FACTS(), FIX(), personaProfile().facts]) {
    const w = staleFactsOf(m, facts as any[]);
    if (!w.length) continue;
    withdrew++;
    const k = String((w[0] as any).text ?? (w[0] as any).title);
    if (!ONE_SHAPE.test(m.trim()) || w.length !== 1 || !/^(?:GPA|SAT): [\d.]+$/.test(k)) bad.push(`${JSON.stringify(m)} => ${k}`);
  }
  eq(bad, []);
  eq(HOSTILE2.filter((m) => ONE_SHAPE.test(m.trim())), [], "none of the hostile messages is the one shape");
  // The shape itself still works, for a score, on the real record and on the reviewer's.
  for (const m of ["the 3.9 gpa is outdated", "My GPA 3.9 on my resume is no longer true, do not use it.", "the 3.9 gpa on there is outdated, don't reuse it"]) eq(ids(staleFactsOf(m, REVIEW_FACTS())), ["gpa"], m);
  eq(ids(staleFactsOf("my sat 1540 is out of date", REVIEW_FACTS())), ["sat"]);
  console.log(`  FW-A: ${REVIEW_MSGS.length} reviewer + ${HOSTILE2.length} + ${HOSTILE.length} hostile messages x 3 records: ${withdrew} withdrawals, ${bad.length} outside the one shape; filler words: ${JSON.stringify((notes as any).SET_ASIDE_FILLER)}`);
});

Deno.test("FW-A through the turn: none of the reviewer's reproductions changes storage", async () => {
  const MS = ["My mom keeps saying this. The 3.9 GPA is wrong. She is confused, it's right.", "The 3.9 GPA is wrong. That's what the recruiter claimed but he's mistaken.", "the 3.9 gpa is wrong?!", "The 3.9 GPA is outdated？", "3.9 gpa != outdated", "my 3.9 gpa не outdated",
    "'the 3.9 gpa is outdated'", "on my brother's resume. the 3.9 gpa is wrong.", "Translate to Spanish. The 3.9 gpa is outdated.", "Proofread this sentence for me. The 3.9 gpa is outdated.", "Pretend you're a recruiter. The 3.9 gpa is outdated. How do you respond", "The 3.9 gpa is outdated. Lol no.",
    "in that resume the 3.9 gpa is wrong", "President, Chess Club (2021) is outdated", "AWS Cloud Practitioner (2022) is old", "Lakeshore University, BS Computer Science and Finance, Expected June 2029 is wrong", "F-1 OPT is wrong", "My advisor wrote: 'Fix your file. The 3.9 GPA is wrong. Call me.'"];
  const bad: string[] = [];
  for (const m of MS) {
    const profile = personaProfile();
    profile.facts.push(...REVIEW_FACTS().filter((f) => ["lead", "cert", "visa"].includes(f.id)));
    const before = JSON.stringify(profile);
    const r: any = await agentTurn({ message: m, history: [], stores: { profile }, userId: "u-fw", threadId: "th", now: NOW, model: async () => text("Okay.") } as any);
    if (JSON.stringify(profile) !== before || r.set_aside) bad.push(m);
  }
  eq(bad, []);
});

// ---------------------------------------------------------------- FW-C the reply says it: label, value and a set-aside word together
Deno.test("FW-C a set-aside counts as said only with the fact's label, its value and a set-aside word in one sentence; an unfinished turn says it first and does not contradict it", async () => {
  const said = (notes as any) && (await import("../../supabase/functions/agent-chat/career_brain.ts")).setAsideSaid as (r: string, f: string[]) => string;
  const LINE = /Set aside, not deleted[^\n]*GPA: 3\.9/;
  for (const r of ["Found 3.9k roles for you in Chicago.", "Found 39 roles; top pays $3.9/hr more.", "Your GPA is now off your record and I will not use it.", "Noted. Your GPA came up at 3.9 of the postings.", "The 3.9 GPA is strong for Citadel."]) ok(LINE.test(said(r, ["GPA: 3.9"])), `appended after: ${r}`);
  for (const r of ["Got it: the 3.9 GPA is off your record and won't be used.", "I set aside your GPA of 3.9. Searching next.", "Your GPA (3.9) is no longer used."]) eq(said(r, ["GPA: 3.9"]), r);
  // The turn did not finish: the fact goes first, and the code line after it does not say nothing was saved.
  const profile = personaProfile();
  const r: any = await agentTurn({ message: "the 3.9 gpa is outdated", history: [], stores: { profile }, userId: "u-fw", threadId: "th", now: NOW, model: async () => ({ content: [{ type: "text", text: "" }], stop_reason: "max_tokens" }) } as any);
  ok(r.stopped !== "final" && r.set_aside?.length === 1, `${r.stopped} ${JSON.stringify(r.set_aside)}`);
  ok(/^Set aside, not deleted[^\n]*GPA: 3\.9/.test(r.reply), r.reply);
  ok(!/Nothing was sent, saved or submitted|nothing was saved/i.test(r.reply), `no contradiction: ${r.reply}`);
});

// ---------------------------------------------------------------- FW-D a resume names what is waiting for a yes
Deno.test("FW-D a fact corrected (waiting for their yes) or set aside that no longer prints is named in the changelog", async () => {
  const profile = personaProfile(), facts = profile.facts as any[];
  const tools = Object.fromEntries(careerTools({ postings: async () => [] } as any).map((t: any) => [t.name, t]));
  const said = "Crestline Partners was a private equity internship in 2024, not 2025";
  const crest = facts.find((f) => /Crestline/.test(f.text));
  await tools.correct_profile_fact.run({ id: crest.id, text: "Crestline Partners, Private equity intern (2024): Python data tooling." }, { userId: "u-fw", threadId: "th", now: NOW, state: { profile }, turn: { message: said, added: [], before: "" } } as any);
  eq(crest.status, "draft");
  const t: any = await tailorForPosting({ userId: "00000000-0000-4000-8000-000000001172", profile, posting: { text: "Software Engineer Intern at Example Labs\n\nPython, React, SQL.", company: "Example Labs" }, deps: { render: edgeRenderer(), resumes: memoryResumeStore() }, now: NOW, reviewDraft: true });
  ok(t.ok && !JSON.stringify(t.detail.doc.lines).includes("Crestline"), "the entry is off the resume until they confirm the change");
  ok(/Crestline Partners/.test(t.changelog) && /confirm/.test(t.changelog), `the changelog names it: ${t.changelog}`);
  eq(t.held_back?.length, 1);
});

// ---------------------------------------------------------------- FW-E the "or" invariants, over every case
const REVIEW_OR = ["Portland or Seattle", "NY or NJ", "remote or hybrid", "intern or new grad swe in sf or nyc", "data scientist or ml engineer at google or meta in london or dublin", "swe intern oregon or washington", "orlando or tampa marketing coordinator", "oracle or salesforce account executive", "software engineer for oracle or sap", "and/or", "data and/or product analyst", "python and/or java developer chicago", "SWE INTERN CHICAGO OR REMOTE", "Data Analyst New York Or Boston", "nurse or doctor", "frontend or backend or fullstack engineer", "frontend or backend or fullstack or mobile or devops engineer", "quant trader or quant researcher or quant developer", "investment banking analyst or private equity analyst", "investment banking or private equity analyst new york", "ux designer or ui designer or product designer remote", "software engineer google or meta", "software engineer at google or meta", "software engineer at google or at meta", "google or meta software engineer intern summer 2027", "machine learning engineer or data scientist san francisco bay area", "new grad or intern swe", "intern or new grad", "swe in sf or nyc", "product manager seattle or portland or remote", "research assistant boston or cambridge", "mechanical engineer detroit or ann arbor", "consultant mckinsey or bain or bcg", "mckinsey or bain or bcg consultant chicago", "summer 2027 or fall 2027 swe intern", "part time or full time barista", "part-time or full-time barista portland", "c++ or rust engineer", "c# or .net developer austin", "go or rust", "or", "or remote", "chicago or", "chicago or or remote", "senior or staff engineer", "junior or mid level data analyst in new york or remote", "marketing or sales", "marketing or sales associate los angeles or san diego", "accountant kansas city or st louis", "teacher washington dc or baltimore", "swe intern washington dc or new york city", "data analyst san francisco or san jose or oakland", "hardware or software engineer intern", "software engineer new york or los angeles or chicago or austin or remote", "finance intern nyc or sf", "finance intern new york, ny or boston, ma", "PM or TPM google", "analyst at morgan stanley or at goldman sachs in new york", "data engineer either remote or in denver", "backend engineer (python or go) remote", "labor or employment lawyer", "editor or writer or reporter new orleans", "oregon health or kaiser permanente nurse", "doctor or nurse practitioner portland oregon", "Software Engineer OR Data Engineer"];
// What trunk (ba9ae2402) answered rightly on the reviewer's 65: none of these may change.
const TRUNK_RIGHT: [string, string[]][] = [
  ["Portland or Seattle", ["Portland", "Seattle"]], ["NY or NJ", ["NY", "NJ"]], ["remote or hybrid", ["remote", "hybrid"]], ["swe intern oregon or washington", ["swe intern oregon", "swe intern washington"]],
  ["orlando or tampa marketing coordinator", ["orlando marketing coordinator", "tampa marketing coordinator"]], ["oracle or salesforce account executive", ["oracle account executive", "salesforce account executive"]],
  ["software engineer for oracle or sap", ["software engineer for oracle", "software engineer for sap"]], ["SWE INTERN CHICAGO OR REMOTE", ["SWE INTERN CHICAGO", "SWE INTERN REMOTE"]], ["nurse or doctor", ["nurse", "doctor"]],
  ["frontend or backend or fullstack engineer", ["frontend engineer", "backend engineer", "fullstack engineer"]], ["software engineer google or meta", ["software engineer google", "software engineer meta"]],
  ["software engineer at google or meta", ["software engineer at google", "software engineer at meta"]], ["google or meta software engineer intern summer 2027", ["google software engineer intern summer 2027", "meta software engineer intern summer 2027"]],
  ["swe in sf or nyc", ["swe in sf", "swe in nyc"]], ["product manager seattle or portland or remote", ["product manager seattle", "product manager portland", "product manager remote"]],
  ["research assistant boston or cambridge", ["research assistant boston", "research assistant cambridge"]], ["consultant mckinsey or bain or bcg", ["consultant mckinsey", "consultant bain", "consultant bcg"]],
  ["mckinsey or bain or bcg consultant chicago", ["mckinsey consultant chicago", "bain consultant chicago", "bcg consultant chicago"]], ["part-time or full-time barista portland", ["part-time barista portland", "full-time barista portland"]],
  ["c++ or rust engineer", ["c++ engineer", "rust engineer"]], ["c# or .net developer austin", ["c# developer austin", ".net developer austin"]], ["go or rust", ["go", "rust"]], ["or", ["or"]], ["or remote", ["or remote"]], ["chicago or", ["chicago or"]],
  ["senior or staff engineer", ["senior engineer", "staff engineer"]], ["marketing or sales", ["marketing", "sales"]], ["hardware or software engineer intern", ["hardware engineer intern", "software engineer intern"]],
  ["finance intern nyc or sf", ["finance intern nyc", "finance intern sf"]], ["PM or TPM google", ["PM google", "TPM google"]], ["labor or employment lawyer", ["labor lawyer", "employment lawyer"]],
  ["editor or writer or reporter new orleans", ["editor new orleans", "writer new orleans", "reporter new orleans"]], ["and/or", ["and/or"]],
];
Deno.test("FW-E 'or': every word searched, no query mixes two sides of one 'or', shared words in every query, at most four with the rest named; no regression against trunk", () => {
  const search = (q: string): { queries: string[]; groups: string[][]; not_searched: string[] } => (notes as any) && (orSearchFn as any)(q);
  const wordsOf = (t: string) => t.toLowerCase().replace(/[(),]/g, " ").split(/\s+/).filter((w) => w && w !== "or" && w !== "and/or" && w !== "either");
  const has = (q: string, alt: string) => ` ${wordsOf(q).join(" ")} `.includes(` ${wordsOf(alt).join(" ")} `);
  const bad: string[] = [];
  for (const q of [...REVIEW_OR, ...OR.map((x) => x[0])]) {
    const r = search(q), all = [...r.queries, ...r.not_searched];
    if (r.queries.length > 4) bad.push(`${q}: ${r.queries.length} queries`);
    if (!r.groups.length) { if (JSON.stringify(r.queries) !== JSON.stringify([q.replace(/\s+/g, " ").trim()])) bad.push(`${q}: no alternatives, but ${JSON.stringify(r.queries)}`); continue; }
    // (i) every content word of the query is in a search, or in one named as not searched; with at most four alternatives a group, in a search.
    for (const w of wordsOf(q)) if (!all.some((x) => wordsOf(x).includes(w))) bad.push(`${q}: "${w}" is in no query`);
    if (r.groups.every((g) => g.length <= 4)) for (const w of wordsOf(q)) if (!r.queries.some((x) => wordsOf(x).includes(w))) bad.push(`${q}: "${w}" is searched by no query (${JSON.stringify(r.queries)})`);
    const inAlts = new Set(r.groups.flat().flatMap(wordsOf));
    for (const x of all) {
      // (ii) exactly one alternative of each group; (iii) every word outside the alternatives.
      for (const g of r.groups) if (g.filter((a) => has(x, a) && !g.some((b) => b !== a && has(b, a) && has(x, b))).length !== 1) bad.push(`${q}: ${JSON.stringify(x)} does not hold exactly one of ${JSON.stringify(g)}`);
      for (const w of wordsOf(q)) if (!inAlts.has(w) && !wordsOf(x).includes(w)) bad.push(`${q}: ${JSON.stringify(x)} lost the shared word "${w}"`);
    }
    // (iv) nothing dropped in silence: the searches and the ones not searched are the whole cross-product.
    if (all.length !== r.groups.reduce((n, g) => n * g.length, 1)) bad.push(`${q}: ${all.length} of ${r.groups.reduce((n, g) => n * g.length, 1)} combinations accounted for`);
  }
  for (const [q, want] of TRUNK_RIGHT) if (JSON.stringify(orAlternatives(q)) !== JSON.stringify(want)) bad.push(`regression against trunk: ${q} => ${JSON.stringify(orAlternatives(q))}`);
  eq(bad, []);
  const big = search("data scientist or ml engineer at google or meta in london or dublin");
  eq([big.queries.length, big.not_searched.length], [4, 4]);
  ok(big.queries.some((x) => /dublin/.test(x)) && big.queries.some((x) => /ml engineer/.test(x)) && big.queries.some((x) => /meta/.test(x)), JSON.stringify(big.queries));
  eq(search("frontend or backend or fullstack or mobile or devops engineer").not_searched, ["devops engineer"]);
});

// ---------------------------------------------------------------- FW-F a card turn sets nothing aside; an approval made before a change cannot submit
Deno.test("FW-F a turn whose reply is a card leaves the fact as it was; a packet approved before a fact was set aside or corrected is refused at submit", async () => {
  // The card turn: the model drafts a message (its reply is the draft card), so the turn cannot say a fact was set aside.
  const profile = personaProfile(), gpa = (profile.facts as any[]).find((f) => /GPA/.test(String(f.text)));
  let n = 0;
  const r: any = await agentTurn({ message: "the 3.9 gpa is outdated", history: [], stores: { profile }, userId: "u-fw", threadId: "th", now: NOW,
    model: async (p: any) => p.tools?.length && n++ === 0 ? { content: [{ type: "tool_use", id: "t1", name: "draft_followup", input: { kind: "note", recipient: "", body: "Hi [Name], thank you for your time this week." } }], stop_reason: "tool_use" } : text("Here is the draft.") } as any);
  ok(r.show, `the fixture: this turn's reply is a card (${JSON.stringify(r.tool_calls)})`);
  eq([gpa.status, gpa.needs_confirmation, gpa.withdrawn_by_owner, r.set_aside], ["confirmed", false, undefined, undefined]);
  // Submit: the packet is bound to the facts it was prepared from (141 factBinding); after a set-aside, or a correction, it is stale.
  const D = (core as any).CareerDoorstep;
  for (const change of ["set aside", "corrected"]) {
    const p = personaProfile(), state = { ...D.factBinding(p), submission: { status: "approved" } };
    eq(D.checkSubmitGuards({ profile: p }, state)?.code ?? null, null, "before the change the packet may go");
    if (change === "set aside") await agentTurn({ message: "the 3.9 gpa is outdated", history: [], stores: { profile: p }, userId: "u-fw", threadId: "th", now: NOW, model: async () => text("The 3.9 GPA is set aside.") } as any);
    else {
      const tools = Object.fromEntries(careerTools({ postings: async () => [] } as any).map((t: any) => [t.name, t]));
      const f = (p.facts as any[]).find((x) => /GPA/.test(String(x.text)));
      await tools.correct_profile_fact.run({ id: f.id, text: "GPA: 3.7" }, { userId: "u-fw", threadId: "th", now: NOW, state: { profile: p }, turn: { message: "my GPA is 3.7 now", added: [], before: "" } } as any);
    }
    eq(D.checkSubmitGuards({ profile: p }, state)?.code, "stale_packet_facts", `after the fact was ${change}`);
  }
});
