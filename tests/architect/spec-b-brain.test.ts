// SPEC B (owner PRD 2.2, 2.3, 3.3, 6.5): the brain knows exactly what an application needs from CONFIRMED facts only and asks
// the single most consequential gap; a correction replaces the search's constraint; every count comes from row states and
// "applied" only for an evidenced submission. Pure units: no network, no model, no database. The end-state proof of the
// corrections and the role-ask invariant is the task eval (evals/career/tasks, T45 to T54).
import assertNode from "node:assert/strict";
import { applyReadiness, isSecretField, NEED_ORDER, readinessFacts } from "../../supabase/functions/_shared/apply_readiness.ts";
import { askProblems, writeReadinessAsk } from "../../supabase/functions/_shared/readiness_ask.ts";
import { applySummary, appliedAllowed, overclaims, summaryFacts, WORDS } from "../../supabase/functions/_shared/apply_status_summary.ts";
import { applyCorrection, correctedAsk, correctionOf } from "../../supabase/functions/_shared/search_correction.ts";
import { hasLimits, outsideLimits } from "../../supabase/functions/_shared/posting_constraints.ts";
import { factCheck, factsForTurn } from "../../supabase/functions/_shared/career_reply_writer.ts";

const fact = (o: Record<string, unknown>) => ({ id: "F-" + Math.random().toString(36).slice(2, 6), needs_confirmation: false, status: "confirmed", ...o });
const resume = [fact({ kind: "experience", text: "Analyst at Acme, 2023-2025" }), fact({ kind: "education", text: "BS Finance, DePaul" })];
const profile = (extra: Record<string, unknown> = {}, facts: unknown[] = resume) => ({ basics: { name: "Vish S", email: "v@example.test", phone: null, location: "Chicago" }, facts, preferences: {}, constraints: {}, ...extra });
const ask = (o: Record<string, unknown> = {}) => ({ role: "data analyst", place: "Chicago", remote: false, limits: { bands: null, pay: null, company: null, term: null, needsSponsor: false }, ...o }) as any;

Deno.test("readiness: nothing confirmed -> resume first, then authorization; ordered by consequence", () => {
  const r = applyReadiness({ profile: { basics: {}, facts: [] }, ask: ask({ place: null }) });
  assertNode.equal(r.ready, false);
  assertNode.deepEqual(r.missing.map((m) => m.key).slice(0, 2), ["resume", "work_authorization"]);
  assertNode.equal(r.ask_now[0].key, "resume");
  assertNode.ok(r.ask_now.length <= 2);
  // missing items follow NEED_ORDER
  const idx = r.missing.map((m) => NEED_ORDER.indexOf(m.key));
  assertNode.deepEqual(idx, [...idx].sort((a, b) => a - b));
});

Deno.test("readiness: unconfirmed, quarantined or generated facts never count as known", () => {
  const draft = [fact({ kind: "experience", text: "x", needs_confirmation: true }), fact({ kind: "eligibility", name: "Work authorization (US)", value: "Yes", country: "US", needs_confirmation: true }),
    fact({ kind: "eligibility", name: "Work authorization (US)", value: "Yes", country: "US", source: "agent" })];
  const r = applyReadiness({ profile: profile({}, draft), ask: ask() });
  assertNode.ok(r.missing.some((m) => m.key === "resume"));
  assertNode.ok(r.missing.some((m) => m.key === "work_authorization"), "an inferred or unconfirmed authorization is missing");
  // basics are not a confirmation by themselves: with no confirmed resume the contact lines are missing too
  assertNode.ok(["full_name", "email"].every((k) => r.missing.some((m) => m.key === k)));
});

Deno.test("readiness: a confirmed resume carries name, email and the location line; phone stays missing", () => {
  const r = applyReadiness({ profile: profile(), ask: ask() });
  assertNode.ok(r.known.includes("resume") && r.known.includes("full_name") && r.known.includes("email") && r.known.includes("location"));
  assertNode.ok(r.missing.some((m) => m.key === "phone"));
});

Deno.test("readiness: work authorization is never inferred from residence, citizenship or a non-US scope", () => {
  const near = [...resume, fact({ kind: "profile", name: "Country", value: "United States", text: "my country is United States" }),
    fact({ kind: "eligibility", name: "Work authorization (US)", value: "Yes", country: "Canada" }), fact({ kind: "other", text: "I am a citizen" })];
  assertNode.ok(applyReadiness({ profile: profile({}, near), ask: ask() }).missing.some((m) => m.key === "work_authorization"));
  const ok = [...resume, fact({ kind: "eligibility", name: "Work authorization (US)", value: "Yes", country: "US" })];
  const r = applyReadiness({ profile: profile({}, ok), ask: ask() });
  assertNode.ok(r.known.includes("work_authorization"));
  assertNode.ok(!r.ask_now.some((m) => m.key === "work_authorization"));
});

Deno.test("readiness: remote scope, seniority and salary floor are asked only when they matter", () => {
  const base = { profile: profile() };
  assertNode.ok(!applyReadiness({ ...base, ask: ask({ remote: false }) }).missing.some((m) => m.key === "remote_scope"), "no remote wanted, no scope question");
  assertNode.ok(applyReadiness({ ...base, ask: ask({ remote: true, remoteOnly: true, place: null }) }).missing.some((m) => m.key === "remote_scope"));
  assertNode.ok(!applyReadiness({ ...base, ask: ask({ remote: true, remoteOnly: false, place: "Canada" }) }).missing.some((m) => m.key === "remote_scope"), "remote in a named place or remote-or-local is scoped by the words said now");
  assertNode.ok(applyReadiness({ ...base, ask: ask() }).missing.some((m) => m.key === "seniority"));
  assertNode.ok(!applyReadiness({ ...base, ask: ask({ limits: { bands: ["intern"] } }) }).missing.some((m) => m.key === "seniority"));
  assertNode.ok(!applyReadiness({ ...base, ask: ask() }).missing.some((m) => m.key === "salary_floor"), "pay not made hard: no floor question");
  assertNode.ok(applyReadiness({ ...base, ask: ask(), salaryHard: true }).missing.some((m) => m.key === "salary_floor"));
  assertNode.ok(!applyReadiness({ ...base, ask: ask({ limits: { pay: { amount: 80000, period: "year" } } }), salaryHard: true }).missing.some((m) => m.key === "salary_floor"));
});

Deno.test("readiness: secrets are never missing items and never asked in chat", () => {
  for (const f of ["Password", "One-time code", "SSN", "Social Security number", "Card number", "Passport number", "2FA code"]) assertNode.ok(isSecretField(f), f);
  assertNode.ok(!isSecretField("Phone number") && !isSecretField("Email"));
  const r = applyReadiness({ profile: { basics: {}, facts: [] }, ask: ask(), formFields: ["Email", "Password", "SSN", "One-time code"] });
  assertNode.deepEqual(r.secure_only.sort(), ["One-time code", "Password", "SSN"]);
  assertNode.ok(r.missing.every((m) => !isSecretField(m.label)) && r.ask_now.every((m) => !isSecretField(m.label)));
  assertNode.ok(readinessFacts(r).includes("never ask for those in chat"));
});

Deno.test("readiness: at most two asks, the first is the most consequential, and a ready profile asks nothing", () => {
  const r = applyReadiness({ profile: profile(), ask: ask({ remote: true, remoteOnly: true, place: null }) });
  assertNode.ok(r.ask_now.length <= 2);
  assertNode.equal(r.ask_now[0].key, r.missing.find((m) => m.blocks === "apply" || m.key === "seniority")!.key);
  const full = profile({ basics: { name: "V S", email: "v@example.test", phone: "+1 312 555 0100", location: "Chicago" } },
    [...resume, fact({ kind: "eligibility", name: "Work authorization (US)", value: "Yes", country: "US" }), fact({ kind: "eligibility", name: "Sponsorship needed", value: "No" })]);
  const done = applyReadiness({ profile: full, ask: ask({ limits: { bands: ["junior"] } }) });
  assertNode.equal(done.ready, true);
  assertNode.equal(done.ask_now.length, 0);
});

const tag = (key: string, q: string) => JSON.stringify({ key, question: q });
const sayRaw = (t: string) => async () => ({ content: [{ type: "text", text: t }] });
const needs = (keys: string[]) => ({ ready: false, known: [], missing: [], ask_now: keys.map((key) => ({ key, label: key === "work_authorization" ? "work authorization (US)" : key.replace("_", " "), why: "", rank: 1, chat: true, blocks: "apply" })), secure_only: [], rule: "" }) as any;

Deno.test("readiness ask: the model's question is checked, never replaced by canned prose", async () => {
  const r = applyReadiness({ profile: { basics: {}, facts: [] }, ask: ask() });
  const good = await writeReadinessAsk({ readiness: r, message: "find me data analyst jobs", model: sayRaw(tag("resume", "Do you have a resume handy you can paste in?")) });
  assertNode.equal(good.text, "Do you have a resume handy you can paste in?");
  for (const bad of ["What is your password?", "Send me your resume? And your phone number?", "I applied for you. Want more?", "Check https://x.example/a ok?", "You need 3 things, ok?", "Great question! Resume?", "No question here."]) {
    const w = await writeReadinessAsk({ readiness: r, message: "m", model: sayRaw(tag("resume", bad)) });
    assertNode.equal(w.text, null, bad);
    assertNode.ok(w.rejected.length > 0);
  }
  assertNode.equal((await writeReadinessAsk({ readiness: r, message: "m", model: null })).text, null);
  assertNode.equal((await writeReadinessAsk({ readiness: r, message: "m", model: sayRaw("Do you have a resume?") })).text, null, "an untagged question is dropped");
  assertNode.equal((await writeReadinessAsk({ readiness: r, message: "m", model: sayRaw(tag("work_authorization", "Do you have a resume?")) })).text, null, "tagged with another need");
  assertNode.ok(askProblems("Which level are you aiming for?", { ...r, ask_now: [] }).includes("nothing blocking to ask"));
});

Deno.test("readiness ask: the review's probes are all rejected, whatever they are tagged", () => {
  const wa = needs(["work_authorization"]), sp = needs(["sponsorship"]);
  const probes: [string, any][] = [
    ["Are you authorized to work in the US, and what's your date of birth?", wa],
    ["What's the code they emailed you?", wa],
    ["What is your LinkedIn login, so I can check your profile?", wa],
    ["Can you share your Social-Security number? Are you authorized to work in the US?", wa],
    ["Since you're a US citizen, do you need sponsorship?", sp],
    ["Are you a US citizen? Reply here and I will start applying right away.", wa],
    ["Do you have a veteran status or disability, and are you authorized to work?", wa],
    ["Which is it: www.example.com ? Are you authorized to work in the US", wa],
    ["Are you authorized to work in the US and what is your gender?", wa],
    ["As a US citizen, are you authorized to work here?", wa],
    ["Do you need sponsorship? I will submit once you say.", sp],
    ["Are you authorized to work in the US? I can queue the applications after.", wa],
    ["What's your mother's maiden name? Do you need sponsorship?", sp],
  ];
  for (const [q, r] of probes) assertNode.ok(askProblems(q, r, r.ask_now[0].key, "find data analyst jobs").length > 0, q);
});

Deno.test("readiness ask: a good question for each need passes", () => {
  const good: Record<string, string> = {
    resume: "Do you have a resume you can paste in here?",
    work_authorization: "Are you legally authorized to work in the US?",
    sponsorship: "Would you need visa sponsorship for a job here?",
    remote_scope: "For remote roles, should they be open to your country only, or anywhere?",
    seniority: "What level are you aiming for, internship or full-time?",
    location: "Which city or area should I focus on?",
    email: "What email should go on your applications?",
    phone: "What phone number should forms use for you?",
    full_name: "What full name should go on your applications?",
    salary_floor: "What is the lowest salary you would take?",
  };
  for (const [k, q] of Object.entries(good)) assertNode.deepEqual(askProblems(q, needs([k]), k, "find data analyst jobs in Chicago"), [], q);
  // a good question about one need is not good for another
  assertNode.ok(askProblems(good.resume, needs(["sponsorship"]), "sponsorship", "x").length > 0);
});

Deno.test("correction: remote only replaces the place; the old place is not kept", () => {
  for (const m of ["only remote roles", "remote only", "just remote", "Actually, only remote please"]) assertNode.ok(correctionOf(m)?.remoteOnly, m);
  const prev = ask({ place: "Chicago", remote: false });
  const { ask: next, changes } = applyCorrection(prev, correctionOf("only remote roles")!);
  assertNode.equal(next.remote, true); assertNode.equal(next.remoteOnly, true); assertNode.equal(next.place, null);
  assertNode.equal(next.role, "data analyst"); assertNode.deepEqual(changes, ["remote_only"]);
  const back = applyCorrection(next, correctionOf("not remote")!).ask;
  assertNode.equal(back.remote, false); assertNode.equal(back.remoteOnly, false);
});

Deno.test("correction: individual contributor only drops manager levels, keeps the rest, and filters postings", () => {
  for (const m of ["only individual contributor roles", "only individual-contributor roles, no manager roles", "no managers", "IC only", "no people management"]) assertNode.ok(correctionOf(m)?.contributorOnly, m);
  const prev = ask({ limits: { bands: ["senior", "manager"], pay: { amount: 90000, period: "year" }, company: null, term: null, needsSponsor: false } });
  const { ask: next } = applyCorrection(prev, correctionOf("only individual contributor roles")!);
  assertNode.deepEqual(next.limits.bands, ["senior"]);
  assertNode.deepEqual(next.limits.pay, { amount: 90000, period: "year" }, "constraints the correction does not touch stay");
  assertNode.ok(hasLimits(next.limits));
  assertNode.equal(outsideLimits({ title: "Engineering Manager", description: "Manage a team of engineers." }, next.limits), "level");
  const noBands = applyCorrection(ask(), correctionOf("no manager roles")!).ask;
  assertNode.equal(outsideLimits({ title: "Engineering Manager", description: "Manage a team of engineers." }, noBands.limits), "level");
  assertNode.equal(outsideLimits({ title: "Data Analyst", description: "SQL." }, noBands.limits), null);
});

Deno.test("correction: only a correction of a last search; an ordinary ask or a question is not one", () => {
  for (const m of ["find remote data analyst jobs", "is this remote?", "what about remote work generally?", "apply to these", "hello"]) assertNode.equal(correctionOf(m), null, m);
  assertNode.equal(correctedAsk("only remote roles", { lastParams: { roleText: "x" } }), null, "no last ask to correct");
  const NOW = 1_800_000_000_000;
  assertNode.ok(correctedAsk("only remote roles", { lastAsk: ask(), lastAskAt: NOW - 60_000 }, NOW));
  assertNode.equal(correctedAsk("only remote roles", { lastAsk: ask(), lastAskAt: NOW - 31 * 60_000 }, NOW), null, "a search older than 30 minutes is not corrected");
  assertNode.equal(correctedAsk("only remote roles", { lastAsk: ask() }, NOW), null, "no time on the ask: not recent");
  assertNode.equal(correctedAsk("only remote roles", { lastAsk: null, lastAskAt: null }, NOW), null, "a non-search turn cleared it");
});

Deno.test("status summary: every count derives from row states and adds up", () => {
  const rows = [{ state: "confirmed" }, { state: "confirmed" }, { state: "submitted_unconfirmed" }, { state: "unknown_outcome" }, { state: "needs_user" }, { state: "queued" }, { state: "driving" }, { state: "failed" }, { state: "not_submitted" }, { state: "something_new" }];
  const s = applySummary(rows, { prepared: 3 });
  assertNode.equal(s.total, 13);
  assertNode.deepEqual(s.counts, { prepared: 3, approved: 1, started: 1, submitted_confirmed: 2, still_checking: 3, needs_you: 1, not_sent: 2 });
  assertNode.equal(WORDS.reduce((n, w) => n + s.counts[w], 0), s.total, "each row counted once");
  assertNode.equal(s.applied_ok, 2);
  assertNode.equal(s.submitted_not_confirmed, 1);
  assertNode.equal(applySummary([]).total, 0);
});

Deno.test('status summary: "applied" is produced for nothing but an evidenced submission', () => {
  for (const st of ["queued", "driving", "submitted_unconfirmed", "unknown_outcome", "needs_user", "failed", "not_submitted", "wat"]) assertNode.equal(appliedAllowed(st), false, st);
  assertNode.equal(appliedAllowed("confirmed"), true);
  const none = applySummary([{ state: "queued" }, { state: "submitted_unconfirmed" }], { prepared: 2 });
  assertNode.equal(none.applied_ok, 0);
  assertNode.ok(overclaims("I applied to 2 roles for you.", none).length > 0);
  assertNode.ok(overclaims("2 are submitted and confirmed.", none).length > 0);
  assertNode.deepEqual(overclaims("Nothing is applied yet; 1 is approved and 2 are prepared.", none), []);
  const one = applySummary([{ state: "confirmed" }, { state: "queued" }]);
  assertNode.deepEqual(overclaims("1 is submitted and confirmed, 1 is approved.", one), []);
  assertNode.ok(overclaims("2 applications confirmed.", one).length > 0);
});

Deno.test("reply writer: a count or an 'applied' beyond the row states is rejected; the real counts pass", () => {
  const s = applySummary([{ state: "confirmed" }, { state: "queued" }, { state: "queued" }]);
  const facts = factsForTurn({ reply: "Your applications.", counts: summaryFacts(s), appliedOk: s.applied_ok });
  assertNode.deepEqual(factCheck("1 is submitted and confirmed and 2 are approved.", facts), []);
  assertNode.ok(factCheck("I applied to all 3 of them.", facts).length > 0);
  const none = applySummary([{ state: "queued" }]);
  const f2 = factsForTurn({ reply: "Your applications.", counts: summaryFacts(none), appliedOk: none.applied_ok });
  assertNode.ok(factCheck("You have applied to 1 role.", f2).length > 0);
  assertNode.ok(summaryFacts(none).includes("None is submitted and confirmed"));
});

Deno.test("correction: only the WHOLE message is one; inside a longer sentence it changes nothing", () => {
  for (const m of ["no management consulting", "I am not a manager yet", "no director of engineering", "skip managers when you look at the Chicago ones", "I want product manager roles, no director level",
    "not a manager", "only senior roles", "I would like a data analyst job but no managers please, in Chicago", "no managers at Acme", "exclude management consulting firms"]) assertNode.equal(correctionOf(m)?.contributorOnly ?? false, false, m);
  for (const m of ["only individual contributor roles, no manager roles", "no managers", "skip managers", "Actually, no manager roles please", "IC only"]) assertNode.ok(correctionOf(m)?.contributorOnly, m);
});

Deno.test("correction: a manager title in the role keeps its manager level", () => {
  const prev = ask({ role: "product manager", limits: { bands: ["manager"], pay: null, company: null, term: null, needsSponsor: false } });
  const { ask: next } = applyCorrection(prev, correctionOf("no director roles")!.contributorOnly ? { contributorOnly: true } : {});
  assertNode.deepEqual(next.limits.bands, ["manager"], "the manager band of a manager role stays");
  assertNode.ok(!next.limits.notBands.includes("manager") && next.limits.notBands.includes("director"));
});

Deno.test("correction: remote only then not remote restores the original place", () => {
  const first = applyCorrection(ask({ place: "Chicago" }), correctionOf("only remote roles")!).ask;
  assertNode.equal(first.place, null); assertNode.equal(first.prevPlace, "Chicago");
  const back = applyCorrection(first, correctionOf("actually no remote")!).ask;
  assertNode.equal(back.place, "Chicago"); assertNode.equal(back.remote, false); assertNode.equal(back.prevPlace, null);
});

Deno.test("readiness: a profile rebuilt from stated facts counts as nothing known", () => {
  const stated = profile({ _fromStatedFacts: true }, [...resume, fact({ kind: "eligibility", name: "Work authorization (US)", value: "Yes", country: "US" })]);
  const r = applyReadiness({ profile: stated, ask: ask() });
  assertNode.deepEqual(r.known.filter((k) => k !== "remote_scope" && k !== "salary_floor" && k !== "location"), []);
  assertNode.equal(r.ask_now[0].key, "resume");
});

Deno.test("readiness: work authorization needs an explicit confirmation (status confirmed and needs_confirmation false)", () => {
  const elig = { kind: "eligibility", name: "Work authorization (US)", value: "Yes", country: "US" };
  const loose = [...resume, { id: "x", ...elig }];                                    // no flags at all
  assertNode.ok(!applyReadiness({ profile: profile({}, loose), ask: ask() }).known.includes("work_authorization"));
  const half = [...resume, { id: "y", ...elig, status: "confirmed" }];                // no needs_confirmation
  assertNode.ok(!applyReadiness({ profile: profile({}, half), ask: ask() }).known.includes("work_authorization"));
  const full = [...resume, fact(elig)];
  assertNode.ok(applyReadiness({ profile: profile({}, full), ask: ask() }).known.includes("work_authorization"));
});

Deno.test("readiness: a negated or on-site remote mention is not a wish for remote; a pending resume line suppresses the resume ask", () => {
  const neg = [...resume, fact({ kind: "preference", text: "I do not want remote roles" })];
  assertNode.ok(!applyReadiness({ profile: profile({}, neg), ask: ask() }).missing.some((m) => m.key === "remote_scope"));
  const pro = [...resume, fact({ kind: "goal", text: "remote data analyst" })];
  assertNode.ok(applyReadiness({ profile: profile({}, pro), ask: ask({ remote: undefined }) }).missing.some((m) => m.key === "remote_scope"));
  assertNode.ok(!applyReadiness({ profile: profile({}, pro), ask: ask({ remote: false }) }).missing.some((m) => m.key === "remote_scope"), "stated on-site");
  const none = { basics: {}, facts: [] };
  assertNode.equal(applyReadiness({ profile: none, ask: ask() }).ask_now[0].key, "resume");
  assertNode.equal(applyReadiness({ profile: none, ask: ask(), resumeLinePending: true }).ask_now.length, 0);
});

Deno.test("status summary: an emailed code is sent-but-unfinished (still checking); overclaims in words and 'both'", () => {
  const s = applySummary([{ state: "needs_user", reason: "email_code" }, { state: "needs_user", reason: "needs_answers" }, { state: "confirmed" }]);
  assertNode.equal(s.counts.still_checking, 1); assertNode.equal(s.counts.needs_you, 1); assertNode.equal(s.submitted_not_confirmed, 1);
  const f = summaryFacts(s);
  assertNode.ok(/across all applications/.test(f) && /1 submitted, not confirmed yet/.test(f));
  const none = applySummary([{ state: "queued" }, { state: "confirmed" }]);
  assertNode.ok(overclaims("Two applications are confirmed.", none).length > 0);
  assertNode.ok(overclaims("Both are confirmed.", none).length > 0);
  assertNode.ok(overclaims("Three were submitted and confirmed.", none).length > 0);
  assertNode.equal(overclaims("One is confirmed.", none).length, 0);
});
