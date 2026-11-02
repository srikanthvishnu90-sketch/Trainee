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

Deno.test("readiness ask: the model's question is checked, never replaced by canned prose", async () => {
  const r = applyReadiness({ profile: { basics: {}, facts: [] }, ask: ask() });
  const say = (t: string) => async () => ({ content: [{ type: "text", text: t }] });
  const good = await writeReadinessAsk({ readiness: r, message: "find me data analyst jobs", model: say("Do you have a resume handy you can paste in?") });
  assertNode.equal(good.text, "Do you have a resume handy you can paste in?");
  for (const bad of ["What is your password?", "Send me your resume? And your phone number?", "I applied for you. Want more?", "Check https://x.example/a ok?", "You need 3 things, ok?", "Great question! Resume?", "No question here."]) {
    const w = await writeReadinessAsk({ readiness: r, message: "m", model: say(bad) });
    assertNode.equal(w.text, null, bad);
    assertNode.ok(w.rejected.length > 0);
  }
  assertNode.equal((await writeReadinessAsk({ readiness: r, message: "m", model: null })).text, null);
  assertNode.ok(askProblems("Which level are you aiming for?", { ...r, ask_now: [] }).includes("nothing blocking to ask"));
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
  assertNode.ok(correctedAsk("only remote roles", { lastAsk: ask() }));
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
