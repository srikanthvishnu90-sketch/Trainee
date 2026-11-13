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
import { orAlternatives } from "../../supabase/functions/_shared/career_search.ts";
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
  { id: "g", kind: "education", title: "GPA: 3.9", status: "confirmed" },
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
  ["the 3.9 gpa on there is outdated, don't reuse it", "withdraw", "g"],
  ["My 3.9 GPA is out of date.", "withdraw", "g"],
  ["GPA 3.9 is no longer accurate", "withdraw", "g"],
  ["fyi the 3.9 gpa isn't accurate anymore", "withdraw", "g"],
  ["Please remove the 3.9 GPA from my profile", "withdraw", "g"],
  ["delete the gpa 3.9 from my record", "withdraw", "g"],
  ["the 3.9 gpa on my resume is wrong now", "withdraw", "g"],
  ["the phone 312-555-0100 is no longer current", "withdraw", "ph"],
  [PERSONA.setup[2], "withdraw", "g"],
  ["Heads up: my 3.9 gpa is outdated. Can you find SWE internships in Chicago?", "withdraw", "g"],
  // a correction code cannot pin to one whole fact, or one about a role or a skill: the model's, through their confirmation
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
  // Put back: never on a "yes" to the reply that said it was set aside (that yes answers something else) ...
  const tools = Object.fromEntries(careerTools({ postings: async () => [] } as any).map((t: any) => [t.name, t]));
  const ctxFor = (message: string, before: string) => ({ userId: "u-fw", threadId: "th", now: NOW + 60_000, state: stores, turn: { message, added: [], before } }) as any;
  await assertNode.rejects(() => tools.confirm_profile_fact.run({ id: gpa.id }, ctxFor("yes", r.reply)), /not confirmed/);
  eq(gpa.status, "draft");
  // ... only on their yes to a question that shows the fact.
  await tools.confirm_profile_fact.run({ id: gpa.id }, ctxFor("yes", "Put GPA: 3.9 back on your record?"));
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
  ["goldman sachs or stripe", ["goldman sachs", "stripe"]],
  ["jane street or two sigma intern", ["jane street intern", "two sigma intern"]],
  ["jp morgan or bank of america analyst", ["jp morgan analyst", "bank of america analyst"]],
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
