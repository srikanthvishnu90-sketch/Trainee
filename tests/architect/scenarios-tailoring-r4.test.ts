// TAILORING, LETTERS AND FORM ANSWERS, ROUND 4 (architect, 2026-11-05; owner rule D-007, never invent a fact; the text
// sent is the text the person approved). ~10,000 seeded scenarios on a FRESH seed (tests/architect/scenarios/tailoring-r4-generator.ts)
// in categories rounds 1-3 did not have, each through the product's own code with a scripted fake model (no real model, no
// network, no database, no clock):
//   echo       the question's own words said as the person's experience ("Describe your experience with Fivetran" -> "At
//              Acme Corp, I used Fivetran ..."; "in a HIPAA-regulated environment"): never shown (checkDraft, draftEssay);
//              the same word in a wish, a negation or as the posting's own team, or on the person's record: shown
//   upgrade    a title upgraded with a word the record holds elsewhere ("presented to senior leadership" -> "Senior Data
//              Analyst"), a degree past a look-alike ("master data cleanup" -> "a master's degree"), a GPA moved onto another
//              number on the record, an employer's dates moved onto the graduation year: never shown, in an essay or a
//              tailored line (guardMaterials); the record's own title, degree, GPA and dates: shown
//   screening  prose answering what the person never answered (criminal history, a background check, a drug test,
//              relocation, a start date, a salary, sponsorship, work rights, disability, how they identify): never shown;
//              sponsorship, work rights, disability on their record: shown; the rest never, the form asks (review of #507)
//   batch      a cover letter drafted for one posting of a batch, checked for another posting of it (the prepare-ahead
//              re-check): never shown when it names the other employer or role; the posting's own letter always is
//   eeo        a texted answer to one voluntary question (disability, veteran, ethnicity, gender identity) never answers
//              another, here or at the next employer; every voluntary question on a form is asked on its own
//   compound   a yes/no fact never answers a question that asks more ("a driver's license AND reliable transportation", "18
//              AND able to lift 50 pounds", a CDL): asked, and the answer stays with that posting
//   reuse      an answer given for one wording never fills a subtly different question at the next employer (another city,
//              another number of days, C++ / C#, another currency, another clearance level, felony / misdemeanour ...)
//   maxlength  the field's own limit as the card sends it (an ATS input's maxlength): a draft over it never shown or cut
//   correction a draft written ahead, re-checked after the person corrected the fact it used: never shown with the old value
//   told       what the person reads when a draft is refused or a question is left: no draft shown, nothing said as saved,
//              the question still open; every required question left blank is in the list they are asked
//   deno test -A --no-check tests/architect/scenarios-tailoring-r4.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { checkDraft, draftEssay, draftReply, type DraftOutcome } from "../../supabase/functions/_shared/essay_draft.ts";
import { guardMaterials } from "../../supabase/functions/_shared/career_materials_guard.ts";
import { claimProblems } from "../../supabase/functions/_shared/person_claims.ts";
import { factStaysHere, normLabel, planBatch, type FormField } from "../../supabase/functions/_shared/career_apply.ts";
import { answerKey } from "../../supabase/functions/_shared/question_map.ts";
import { factsWithTextAnswers, questionsToStore } from "../../workers/career-browser/ask-once.ts";
import {
  batchCases, COMPOUND, type DraftCase, echoCases, EEO_QUESTIONS, person, REUSE, rng, said, screeningCases, upgradeCases,
} from "./scenarios/tailoring-r4-generator.ts";

const P = (core as any).CareerProfile;
const SEED = 20261105;
const NOW = Date.parse("2026-11-05T15:00:00Z");
type Fails = Map<string, string[]>;
const fail = (f: Fails, family: string, line: string) => { if (!f.has(family)) f.set(family, []); f.get(family)!.push(line); };
import { R4_DECOYS, R512_CLAIMS, R512_RECORDS, R512_WORK } from "./scenarios/tailoring-r4-claims.ts";
export { R4_DECOYS, R512_CLAIMS, R512_RECORDS, R512_WORK };
export const TOTALS: Record<string, number> = {};
function report(f: Fails, total: number, what: string, extra = "") {
  const n = [...f.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[tailoring-r4] ${what}: ${total} scenarios, ${n} failures${extra ? `; ${extra}` : ""}`];
  for (const [k, xs] of [...f].sort((a, b) => b[1].length - a[1].length)) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    ${x}`); }
  console.log(lines.join("\n"));
  return n;
}
const fakeModel = (outputs: string[], stop = "end_turn") => {
  let calls = 0;
  return { model: async (_: unknown) => ({ content: [{ type: "text", text: outputs[Math.min(calls++, outputs.length - 1)] }], stop_reason: stop }), calls: () => calls };
};
const essayQ = (label: string, company: string) => ({ id: "q1", label, type: "textarea", kind: "essay", company, job_ids: ["j1"] });
const field = (label: string, options: string[], name = "q", required = true): FormField =>
  ({ name, label, type: options.length ? "multi_value_single_select" : "input_text", required, options: options.map((l) => ({ label: l, value: l })) });
const plan = (fields: FormField[], answers: Record<string, any>, saved: Record<string, any> = {}, job = "j1", company = "Larkspur Health") =>
  planBatch({ userId: "u-r4", postings: [{ job_id: job, company, title: "Data Analyst", fields, location: "Chicago, IL", url: `https://boards.example.test/${job}` }], answers, saved, log: [], now: NOW });
const BASE = { full_name: { value: "Alex Testcase", factId: "fact:full_name" }, location: { value: "Chicago, IL", factId: "fact:location" } };

// What the person reads after a refused draft: no draft, nothing said as saved, the question still theirs, and never the
// refused sentence itself.
function toldProblems(n: number, q: ReturnType<typeof essayQ>, d: DraftOutcome, refused: string): string[] {
  const out: string[] = [];
  const reply = draftReply(n, q, d);
  if (/^Draft for/.test(reply)) out.push("a refusal reads as a draft");
  if (/\bsaved (it|your answer)\b|\bis saved\b/i.test(reply)) out.push("a refusal says something was saved");
  if (!reply.includes(`"${n}"`)) out.push("the refusal does not say how to answer it themselves");
  for (const s of refused.split(/(?<=[.!?])\s+/).filter((x) => x.length > 25)) if (reply.includes(s)) out.push(`the refused sentence is quoted back: ${JSON.stringify(s)}`);
  return out;
}

// RELEASE 2 FLOOR (architect, 2026-11-05; D-007): release 2 refuses every draft production (03edad41f) refuses, and
// production refuses an honest decimal ("a 3.6 GPA" read as "3." and "6"). An honest draft holding a decimal is counted
// (deferred), not failed, while the floor stands; strict = true is the "after release 2" check (ignored tests below).
const honestDecimal = (text: string) => /\d\.\d/.test(text);
async function draftBattery(name: string, cases: DraftCase[], f: Fails, strict = false) {
  let shown = 0, refused = 0, thin = 0, drafted = 0, deferred = 0;
  for (const [i, c] of cases.entries()) {
    const q = essayQ(c.label, c.company);
    const a = await checkDraft({ q, siblingLabels: [], deps: { facts: () => c.p.facts }, text: c.text });
    if (!a.ok && a.why === "thin") { thin++; continue; }
    const tag = `${JSON.stringify(c.text.slice(0, 200))} for ${JSON.stringify(c.label)}`;
    if (c.bad && a.ok) fail(f, `${c.family}:shown`, `${tag} (${c.bad} is not on the record)`);
    if (!c.bad && !a.ok) {
      if (!strict && honestDecimal(c.text)) deferred++;
      else fail(f, `${c.family}:honest-refused`, `${tag} -> ${a.why}: ${a.detail.join("; ")}`);
    }
    if (a.ok) shown++; else refused++;
    if (c.bad && i % 3 === 0) {
      // the drafter: the planted draft first, an honest one after; only the honest one is ever shown
      const d = await draftEssay({ q, siblingLabels: [], deps: { model: fakeModel([c.text, c.honest]).model, facts: () => c.p.facts } });
      if (d.ok && d.text !== c.honest) fail(f, `${c.family}:drafted`, `${tag} -> shown ${JSON.stringify(d.text.slice(0, 160))}`);
      if (!d.ok && d.why !== "thin") {
        if (!strict && honestDecimal(c.honest)) deferred++;
        else fail(f, `${c.family}:honest-retry-refused`, `${tag} -> ${d.why}: ${d.detail.join("; ")}`);
      }
      if (d.ok) drafted++;
      // told: the planted draft twice, so nothing passes
      const twice = await draftEssay({ q, siblingLabels: [], deps: { model: fakeModel([c.text, c.text]).model, facts: () => c.p.facts } });
      if (twice.ok) fail(f, `${c.family}:shown-twice`, tag);
      else for (const x of toldProblems(i % 9 + 1, q, twice, c.text)) fail(f, `${c.family}:told`, `${tag}: ${x}`);
    }
  }
  return `${shown} shown, ${refused} refused, ${thin} too thin, ${drafted} honest retries shown` +
    (deferred ? `, ${deferred} honest drafts with a decimal refused by the release 2 floor (shown after release 2)` : "");
}

Deno.test("echo: the question's own words are never said as the person's experience; named otherwise, they pass", async () => {
  const cases = echoCases(rng(SEED), 2000);
  const f: Fails = new Map();
  const extra = await draftBattery("echo", cases, f);
  TOTALS.echo = cases.length;
  assertNode.equal(report(f, cases.length, "the posting's words as experience", extra), 0);
});

Deno.test("upgrade: a title, degree, GPA or date never moves past the record, in an essay or a tailored line", async () => {
  const cases = upgradeCases(rng(SEED + 1), 2000);
  const f: Fails = new Map();
  const extra = await draftBattery("upgrade", cases, f);
  // a tailored line: the entry's title with the upgrade (citing the entry), and the entry as it is
  let lines = 0;
  for (const c of cases.filter((x) => x.family.startsWith("upgrade:title"))) {
    const e = c.p.exps[0];
    const prof = P.createProfile({ id: "profile-r4", basics: { name: "Alex Testcase", email: "alex@example.test" } });
    for (const x of c.p.facts) P.addFact(prof, x, { keepId: true });
    const up = c.bad ? c.bad.replace(/^\w/, (x) => x.toUpperCase()).replace(/ (\w)/g, (_, x) => ` ${x.toUpperCase()}`) : null;
    if (up) {
      const g = guardMaterials([{ text: `${up}, ${e.org}, ${e.start}-${e.end}`, factIds: [e.id] }], prof);
      if (g.ok) fail(f, `${c.family}:line-printed`, `"${up}, ${e.org}" printed for a ${e.role}`);
    }
    const own = guardMaterials([{ text: `${e.role}, ${e.org}, ${e.start}-${e.end}`, factIds: [e.id] }, { text: `${e.bullets[0]}`, factIds: [e.id] }], prof);
    if (!own.ok) fail(f, "upgrade:title:own-line-refused", `${e.role}, ${e.org}: ${JSON.stringify(own.refused)}`);
    lines++;
  }
  TOTALS.upgrade = cases.length;
  assertNode.equal(report(f, cases.length, "upgrades", `${extra}; ${lines} tailored entries checked`), 0);
});

Deno.test({ name: "after release 2: honest decimals in the upgrade battery are shown (#507)", ignore: true, fn: async () => {
  const cases = upgradeCases(rng(SEED + 1), 2000);
  const f: Fails = new Map();
  const extra = await draftBattery("upgrade", cases, f, true);
  assertNode.equal(report(f, cases.length, "upgrades (strict, after release 2)", extra), 0);
} });

Deno.test("screening: criminal history, relocation, a start date, pay, work rights or identity only as the person said it", async () => {
  const cases = screeningCases(rng(SEED + 2), 1500);
  const f: Fails = new Map();
  const extra = await draftBattery("screening", cases, f);
  TOTALS.screening = cases.length;
  assertNode.equal(report(f, cases.length, "screening answers in prose", extra), 0);
});

Deno.test("batch: a letter for one posting is never shown for another posting of the same batch", async () => {
  const cases = batchCases(rng(SEED + 3), 1200);
  const f: Fails = new Map();
  let own = 0, other = 0;
  for (const c of cases) {
    const b = c.postings[c.to];
    const q = essayQ(`Cover letter for the ${b.title} role at ${b.company}`, b.company);
    const a = await checkDraft({ q, siblingLabels: [], deps: { facts: () => c.p.facts }, text: c.text });
    if (!a.ok && a.why === "thin") continue;
    const tag = `${JSON.stringify(c.text.slice(-120))} drafted for ${c.postings[c.from].title} at ${c.postings[c.from].company}, checked for ${b.title} at ${b.company}`;
    if (c.bad) { other++; if (a.ok) fail(f, `${c.family}:shown`, tag); }
    else { own++; if (!a.ok) fail(f, `${c.family}:own-refused`, `${tag} -> ${a.why}: ${a.detail.join("; ")}`); }
  }
  TOTALS.batch = cases.length;
  assertNode.equal(report(f, cases.length, "letters across a batch", `${own} checked for their own posting, ${other} for another`), 0);
});

Deno.test("eeo: one voluntary answer never answers another, here or at the next employer; each is asked on its own", () => {
  const r = rng(SEED + 4);
  const f: Fails = new Map();
  const N = 1000;
  let filledOwn = 0;
  for (let i = 0; i < N; i++) {
    const qs = [...EEO_QUESTIONS].sort(() => r.next() - 0.5).slice(0, r.int(2, 4));
    const posting = `greenhouse:larkspur:${i}`;
    const result = { posting, company: "Larkspur Health", location: "Chicago, IL", questions: qs.map(([label, options]) => ({ label, type: "multi_value_single_select", options })) };
    const stored = questionsToStore(result, { facts: {}, answered: new Set() }).questions as { key: string; label: string; options: string[] }[];
    const tag = `[${qs.map((x) => x[0]).join(" | ")}]`;
    if (stored.length !== qs.length) fail(f, "eeo:not-each-asked", `${tag} -> ${stored.length} stored: ${stored.map((x) => x.key).join(", ")}`);
    for (const s of stored) if (!s.key.startsWith("job:")) fail(f, "eeo:answer-travels", `${JSON.stringify(s.label)} kept under ${s.key}`);
    // the person answers one of them
    const pick = r.int(0, stored.length - 1), s = stored[pick];
    const value = r.pick(s.options);
    const facts = factsWithTextAnswers({ answers: { ...BASE }, saved: {} }, [{ id: `a${i}`, key: s.key, kind: "fact", answer: value }]);
    // the same form again (this posting): only that question is filled, with that value
    const here = plan(qs.map(([l, o], k) => field(l, o, `e${k}`, false)), facts.answers, facts.saved, posting);
    for (const x of here.ready[0]?.fields ?? []) {
      if (x.label !== s.label) fail(f, "eeo:another-question-filled", `${tag}: "${value}" for ${JSON.stringify(s.label)} filled ${JSON.stringify(x.label)} with "${x.value}"`);
      else if (x.value !== value) fail(f, "eeo:own-changed", `${JSON.stringify(s.label)} "${value}" -> "${x.value}"`);
      else filledOwn++;
    }
    // the next employer: no voluntary question is filled from it
    const next = plan(EEO_QUESTIONS.map(([l, o], k) => field(l, o, `n${k}`, false)), facts.answers, facts.saved, `greenhouse:quarry:${i}`, "Quarry Bank");
    for (const x of next.ready[0]?.fields ?? []) fail(f, "eeo:next-employer-filled", `"${value}" for ${JSON.stringify(s.label)} at Larkspur filled ${JSON.stringify(x.label)} at Quarry with "${x.value}"`);
    // a voluntary fact kept before this round (one yes or no for all of them) answers none; a decline only a decline
    const legacy = r.pick(["Yes", "No", "decline"]);
    const old = plan(EEO_QUESTIONS.map(([l, o], k) => field(l, o, `o${k}`, false)), { ...BASE, eeo: { value: legacy, factId: "fact:eeo" } }, {}, `greenhouse:otter:${i}`, "Otter Freight");
    for (const x of old.ready[0]?.fields ?? []) {
      if (legacy !== "decline") fail(f, "eeo:legacy-yes-no-filled", `eeo="${legacy}" filled ${JSON.stringify(x.label)} with "${x.value}"`);
      else if (!/decline|don't wish|prefer not/i.test(x.value)) fail(f, "eeo:decline-became-an-answer", `${JSON.stringify(x.label)} -> "${x.value}"`);
    }
    // a required voluntary question left blank is in the list the person is asked
    const req = plan([field(qs[0][0], qs[0][1], "r0", true)], { ...BASE }, {}, `greenhouse:fern:${i}`, "Fernway Labs");
    if (req.ready.length || !req.needs.some((n) => n.label === qs[0][0])) fail(f, "eeo:required-left-silently", `${JSON.stringify(qs[0][0])}: ${JSON.stringify(req.needs)}`);
  }
  TOTALS.eeo = N;
  assertNode.equal(report(f, N, "voluntary answers", `${filledOwn} filled with the person's own answer at their own posting`), 0);
});

Deno.test("compound: a yes/no fact never answers a question that asks more; the person's answer to it stays with that posting", () => {
  const r = rng(SEED + 5);
  const f: Fails = new Map();
  const N = 800;
  let base = 0;
  for (let i = 0; i < N; i++) {
    const [fact, plain, more] = r.pick(COMPOUND);
    const value = r.pick(["Yes", "No"]);
    const answers = { ...BASE, [fact]: { value, factId: `fact:${fact}` } };
    const q = r.pick(more);
    const got = plan([field(q, ["Yes", "No"])], answers).ready[0]?.fields[0];
    if (got) fail(f, `compound:${fact}:filled`, `${JSON.stringify(q)} -> "${got.value}" from ${fact}=${value}`);
    const fl = field(q, ["Yes", "No"]);
    const here = factStaysHere(fl, "Chicago, IL", answers);
    const key = answerKey(fl, `job${i}`, { haveFact: true, here });
    if (!key.startsWith("job:")) fail(f, `compound:${fact}:answer-travels`, `${JSON.stringify(q)} kept under ${key}`);
    // the plain question is still answered from the fact (a control)
    const p0 = plan([field(plain, ["Yes", "No"])], answers).ready[0]?.fields[0];
    if (p0?.value !== value) fail(f, `compound:${fact}:plain-not-filled`, `${JSON.stringify(plain)} -> ${JSON.stringify(p0)} with ${fact}=${value}`);
    else base++;
  }
  TOTALS.compound = N;
  assertNode.equal(report(f, N, "compound questions", `${base} plain questions filled from the fact`), 0);
});

Deno.test("reuse: an answer for one wording never fills a subtly different question at the next employer", () => {
  const r = rng(SEED + 6);
  const f: Fails = new Map();
  const N = 1000;
  let same = 0;
  for (let i = 0; i < N; i++) {
    const [a, b, os, value] = r.pick(REUSE);
    const fa = field(a, os);
    const key = answerKey(fa, `jobA${i}`, { here: factStaysHere(fa, "Chicago, IL", BASE) });
    const facts = factsWithTextAnswers({ answers: { ...BASE }, saved: {} }, [{ id: `t${i}`, key, kind: "", answer: value }]);
    const got = plan([field(b, os)], facts.answers, facts.saved, `jobB${i}`, "Quarry Bank").ready[0]?.fields[0];
    if (got && got.factId === `text-answer:t${i}`) fail(f, "reuse:other-question-filled", `"${value}" for ${JSON.stringify(a)} filled ${JSON.stringify(b)}`);
    // the planner's own last resort (an answer kept by the exact label) never crosses a different question
    if (normLabel(a) === normLabel(b)) fail(f, "reuse:labels-collide", `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    // the same wording at the next employer: filled only when the answer may travel (not one kept to its posting)
    const again = plan([field(a, os)], facts.answers, facts.saved, `jobC${i}`, "Otter Freight").ready[0]?.fields[0];
    if (again && key.startsWith("job:")) fail(f, "reuse:posting-answer-travelled", `${JSON.stringify(a)} -> "${again.value}" at another employer`);
    if (again) same++;
  }
  TOTALS.reuse = N;
  assertNode.equal(report(f, N, "answers reused across employers", `${same} identical questions answered again`), 0);
});

Deno.test("maxlength: a draft over the field's own limit (as the card sends it) is never shown or cut; inside it, word for word", async () => {
  const r = rng(SEED + 7);
  const f: Fails = new Map();
  const N = 600;
  let inside = 0;
  for (let i = 0; i < N; i++) {
    const p = person(r), e = p.exps[0], e2 = p.exps[p.exps.length - 1];
    const text = `At ${e.org}, I ${said(e.bullets[0])}. At ${e2.org}, I ${said(e2.bullets[e2.bullets.length > 1 ? 1 : 0])}.`;
    const cap = r.pick([80, 120, 150, 255, 500]);
    const q = essayQ(r.pick(["Why are you interested in this role?", "Tell us about a project you are proud of.", "Additional information"]), "Larkspur Health");
    const limitText = `max ${cap} characters`;
    const d = await draftEssay({ q, siblingLabels: [], limitText, deps: { model: fakeModel([text, text]).model, facts: () => p.facts } });
    const c = await checkDraft({ q, siblingLabels: [], limitText, deps: { facts: () => p.facts }, text });
    const tag = `${text.length} chars into a ${cap}-character field`;
    if (text.length > cap) {
      if (d.ok) fail(f, "maxlength:drafted-over", `${tag} -> ${d.text.length} chars shown`);
      if (c.ok) fail(f, "maxlength:ahead-over", tag);
      if (!d.ok && d.why === "too_long" && !/limit/.test(draftReply(1, q, d))) fail(f, "maxlength:told", `${tag}: ${draftReply(1, q, d)}`);
    } else {
      inside++;
      if (!d.ok || d.text !== text) fail(f, "maxlength:inside-changed", `${tag} -> ${JSON.stringify(d)}`);
      if (!c.ok) fail(f, "maxlength:ahead-inside-refused", `${tag} -> ${c.why}`);
    }
  }
  TOTALS.maxlength = N;
  assertNode.equal(report(f, N, "field limits", `${inside} inside their limit`), 0);
});

Deno.test("correction: a draft written ahead is never shown after the person corrected the fact it used", async () => {
  const r = rng(SEED + 8);
  const f: Fails = new Map();
  const N = 600;
  let refused = 0, kept = 0;
  for (let i = 0; i < N; i++) {
    const p = person(r), e = p.exps[0];
    const q = essayQ("Tell us about a project you are proud of.", "Larkspur Health");
    const text = `At ${e.org}, I ${said(e.bullets[0])}. At ${p.exps[p.exps.length - 1].org}, I ${said(p.exps[p.exps.length - 1].bullets[0])}.`;
    const before = await checkDraft({ q, siblingLabels: [], deps: { facts: () => p.facts }, text });
    if (!before.ok) { if (before.why !== "thin") fail(f, "correction:honest-refused-before", `${JSON.stringify(text)} -> ${before.detail.join("; ")}`); continue; }
    const old = /\d+/.exec(e.bullets[0])![0];
    const touch = r.next() < 0.6;
    const fixed = p.facts.map((x) => x.id !== (touch ? e.id : "F-9") ? x : touch
      ? { ...x, bullets: x.bullets.map((b: string, k: number) => k === 0 ? b.replace(old, String(Number(old) + 100)) : b), text: x.text.replace(old, String(Number(old) + 100)) }
      : { ...x, text: x.text.replace(/\d\.\d/, "3.1") });
    const elsewhere = fixed.some((x) => JSON.stringify(x).includes(old) && x.id !== e.id) || fixed.find((x) => x.id === e.id)!.bullets.slice(1).some((b: string) => new RegExp(`\\b${old}\\b`).test(b)) || new RegExp(`\\b${old}\\b`).test(`${e.start} ${e.end}`);
    const after = await checkDraft({ q, siblingLabels: [], deps: { facts: () => fixed }, text });
    if (touch && !elsewhere) { refused++; if (after.ok) fail(f, "correction:old-value-shown", `${old} -> ${Number(old) + 100}: ${JSON.stringify(text)}`); }
    if (!touch) { kept++; if (!after.ok) fail(f, "correction:unrelated-fix-refused", `${JSON.stringify(text)} -> ${after.why}: ${after.detail.join("; ")}`); }
  }
  TOTALS.correction = N;
  assertNode.equal(report(f, N, "drafts re-checked after a correction", `${refused} used the corrected number, ${kept} corrections elsewhere`), 0);
});

Deno.test("told: every required question left blank is asked by its own words; optional voluntary ones are left, never guessed", () => {
  const r = rng(SEED + 9);
  const f: Fails = new Map();
  const N = 500;
  for (let i = 0; i < N; i++) {
    const asks = [
      ...[...EEO_QUESTIONS].sort(() => r.next() - 0.5).slice(0, 2).map(([l, o], k) => field(l, o, `v${k}`, r.next() < 0.5)),
      ...[...COMPOUND[r.int(0, 1)][2]].sort(() => r.next() - 0.5).slice(0, 1).map((l) => field(l, ["Yes", "No"], "c0", true)),
      field("Have you ever been convicted of a felony?", ["Yes", "No"], "crim", r.next() < 0.5),
      field("Will you now or in the future require visa sponsorship?", ["Yes", "No"], "spons", true),
    ];
    const answers = { ...BASE, drivers_license: { value: "Yes", factId: "fact:drivers_license" }, over_18: { value: "Yes", factId: "fact:over_18" } };
    const p = plan(asks, answers, {}, `job${i}`);
    const filled = new Set((p.ready[0]?.fields ?? []).map((x) => x.name));
    for (const a of asks) {
      if (filled.has(a.name)) fail(f, "told:never-answered-filled", `${JSON.stringify(a.label)} filled`);
      else if (a.required && !p.needs.some((n) => n.label === a.label)) fail(f, "told:required-not-asked", `${JSON.stringify(a.label)} left out of ${JSON.stringify(p.needs.map((n) => n.label))}`);
    }
    if (p.ready.length) fail(f, "told:prepared-with-blanks", `${asks.filter((a) => a.required).length} required questions unanswered`);
    if (!p.skipped.some((s) => s.reason === "needs_answers")) fail(f, "told:no-reason", JSON.stringify(p.skipped));
  }
  TOTALS.told = N;
  assertNode.equal(report(f, N, "what the person is asked"), 0);
});

// Each bug round 4 found, as the smallest case that showed it on trunk (e1b9bff58).
Deno.test("round 4 regressions: one case per bug, each as trunk got it wrong", async () => {
  const conf = { status: "confirmed", needs_confirmation: false, source: "user" };
  const facts = [
    { id: "F-1", kind: "experience", title: "Data Analyst, Acme Corp, 2019-2022", org: "Acme Corp", role: "Data Analyst", start: "2019", end: "2022",
      bullets: ["Built Tableau dashboards for 40 sales reps", "Presented weekly findings to senior leadership", "Owned the master data cleanup for the CRM", "Cut dashboard load time by 3.8 seconds"], ...conf },
    { id: "F-2", kind: "education", title: "B.S. Statistics, Ridgeview University, 2018", school: "Ridgeview University", degree: "B.S. Statistics", text: "GPA 3.4/4.0", ...conf },
    { id: "F-3", kind: "other", title: "First-generation college student", text: "First-generation college student", ...conf },
  ];
  const shown = async (label: string, text: string) => (await checkDraft({ q: essayQ(label, "Larkspur Health"), siblingLabels: [], deps: { facts: () => facts }, text })).ok;
  const tail = " At Acme Corp, I built Tableau dashboards for 40 sales reps.";
  // person_claims.ts: a title upgraded by a word the record holds elsewhere
  assertNode.equal(await shown("Tell us about yourself.", `As a Senior Data Analyst at Acme Corp, I built Tableau dashboards for 40 sales reps.`), false);
  // person_claims.ts: the question's own words as experience
  assertNode.equal(await shown("Describe your experience with Fivetran.", `At Acme Corp, I used Fivetran to load CRM data.${tail}`), false);
  assertNode.equal(await shown("Tell us about your work in a HIPAA-regulated environment.", `At Acme Corp, I built Tableau dashboards for 40 sales reps in a HIPAA-regulated environment.`), false);
  assertNode.equal(await shown("Describe your experience with Fivetran.", `I have not used Fivetran yet.${tail}`), true);
  // person_claims.ts: screening answers in prose
  assertNode.equal(await shown("Tell us about yourself.", `I have never been convicted of a crime.${tail}`), false);
  assertNode.equal(await shown("Tell us about yourself.", `I can start immediately.${tail}`), false);
  assertNode.equal(await shown("Tell us about yourself.", `I am looking for a salary in the low six figures.${tail}`), false);
  // person_claims.ts: a date moved onto another entry, a GPA moved onto another number, a degree past "master data"
  assertNode.equal(await shown("Tell us about yourself.", `I worked at Acme Corp from 2018 to 2022, where I built Tableau dashboards for 40 sales reps.`), false);
  assertNode.equal(await shown("Tell us about yourself.", `I graduated from Ridgeview University with a 3.8 GPA.${tail}`), false);
  assertNode.equal(await shown("Tell us about yourself.", `I hold a Master of Science in Statistics from Ridgeview University.${tail}`), false);
  // essay_draft.ts: an honest decimal (the record's own GPA) was read as two numbers and refused. RELEASE 2 FLOOR (D-007):
  // production refuses it, so release 2 does too (the check that it is shown is the ignored "after release 2" test below).
  assertNode.equal(await shown("Tell us about yourself.", `I graduated from Ridgeview University with a 3.4 GPA.${tail}`), false);
  // person_claims.ts: how they identify said "as a ..." (review of #507: never written, even with the fact on record; the
  // form's own voluntary question asks it)
  assertNode.equal(await shown("Tell us about yourself.", `As a first-generation college student, I worked hard.${tail}`), false);
  // question_map.ts / career_apply.ts: one voluntary answer filled every other voluntary question
  const dis = field("Do you have a disability?", ["Yes", "No", "I don't wish to answer"]);
  assertNode.ok(answerKey(dis, "jobA").startsWith("job:"));
  const lgbt = field("Do you consider yourself a member of the LGBTQ+ community?", ["Yes", "No", "Prefer not to say"]);
  assertNode.ok(answerKey(lgbt, "jobA").startsWith("job:"));
  const legacy = plan([field("Are you a protected veteran?", ["Yes", "No", "I don't wish to answer"], "v", false)], { ...BASE, eeo: { value: "No", factId: "fact:eeo" } });
  assertNode.deepEqual(legacy.ready[0]?.fields ?? [], []);
  const stored = questionsToStore({ posting: "p1", company: "Larkspur Health", questions: EEO_QUESTIONS.slice(0, 3).map(([label, options]) => ({ label, type: "select", options })) }, { facts: {}, answered: new Set() });
  assertNode.equal(stored.questions.length, 3);
  // career_apply.ts beyondFact: a yes to one thing answered a question that asks two
  const lic = { ...BASE, drivers_license: { value: "Yes", factId: "fact:drivers_license" }, over_18: { value: "Yes", factId: "fact:over_18" } };
  assertNode.equal(plan([field("Do you have a valid driver's license and reliable transportation?", ["Yes", "No"])], lic).ready.length, 0);
  assertNode.equal(plan([field("Do you have a valid commercial driver's license (CDL)?", ["Yes", "No"])], lic).ready.length, 0);
  assertNode.equal(plan([field("Are you at least 18 years of age and able to lift 50 pounds?", ["Yes", "No"])], lic).ready.length, 0);
  assertNode.equal(plan([field("Do you have a valid driver's license?", ["Yes", "No"])], lic).ready[0]?.fields[0]?.value, "Yes");
  // career_apply.ts normLabel: "C++" and "C#", "$" and "€" were one label
  assertNode.notEqual(normLabel("Years of experience with C++"), normLabel("Years of experience with C#"));
  assertNode.notEqual(normLabel("Desired salary ($)"), normLabel("Desired salary (€)"));
  const cpp = plan([field("Years of experience with C#", [])], { ...BASE }, { [normLabel("Years of experience with C++")]: { value: "6", factId: "text-answer:x" } });
  assertNode.equal(cpp.ready.length, 0);
});

Deno.test({ name: "after release 2: an honest decimal (the record's own GPA) is shown (#507)", ignore: true, fn: async () => {
  const conf = { status: "confirmed", needs_confirmation: false, source: "user" };
  const facts = [
    { id: "F-1", kind: "experience", title: "Data Analyst, Acme Corp, 2019-2022", org: "Acme Corp", role: "Data Analyst", start: "2019", end: "2022",
      bullets: ["Built Tableau dashboards for 40 sales reps", "Presented weekly findings to senior leadership", "Owned the master data cleanup for the CRM", "Cut dashboard load time by 3.8 seconds"], ...conf },
    { id: "F-2", kind: "education", title: "B.S. Statistics, Ridgeview University, 2018", school: "Ridgeview University", degree: "B.S. Statistics", text: "GPA 3.4/4.0", ...conf },
  ];
  const text = "I graduated from Ridgeview University with a 3.4 GPA. At Acme Corp, I built Tableau dashboards for 40 sales reps.";
  assertNode.equal((await checkDraft({ q: essayQ("Tell us about yourself.", "Larkspur Health"), siblingLabels: [], deps: { facts: () => facts }, text })).ok, true);
} });

// Review of #507 (2026-11-05, architect decision on rv57): round 4's fixes for an honest identity and for screening answers
// accepted a word on the record in another sense, and every word match tried after them accepted others. A record of strings
// cannot tell a confirmed identity answer from free text, so "As a / I am a <identity>" is never written; a screening answer
// (criminal history, a background check, a drug test, relocation, a start date, pay) is never written either: the form asks
// each on its own. Each decoy below was shown at #507's head (66faf5c32) or at #512's first head (6e8db93bd).
Deno.test("review of #507: an identity or a screening answer is never written into prose, whatever the record holds", async () => {
  const conf = { status: "confirmed", needs_confirmation: false, source: "user" };
  const base = [{ id: "F-1", kind: "experience", title: "Data Analyst, Acme Corp, 2019-2022", org: "Acme Corp", role: "Data Analyst", start: "2019", end: "2022",
    bullets: ["Built Tableau dashboards for 40 sales reps"], ...conf },
    { id: "F-2", kind: "education", title: "B.S. Statistics, Ridgeview University, 2018", school: "Ridgeview University", degree: "B.S. Statistics", text: "GPA 3.4/4.0", ...conf }];
  const tail = " At Acme Corp, I built Tableau dashboards for 40 sales reps.";
  const shown = async (text: string, record: string) => {
    const a = await checkDraft({ q: essayQ("Tell us about yourself.", "Larkspur Health"), siblingLabels: [],
      deps: { facts: () => [...base, { id: "F-3", kind: "other", title: "How I describe myself", text: record, ...conf }] }, text: `${text}${tail}` });
    assertNode.notEqual(a.ok ? "" : a.why, "thin", `${JSON.stringify(text)}: too few facts to judge`);
    return a.ok;
  };
  const recordOf = (record: string) => ["Data Analyst, Acme Corp, 2019-2022; Built Tableau dashboards for 40 sales reps", "B.S. Statistics, Ridgeview University, 2018; GPA 3.4/4.0", record];
  // the control: the honest line alone is shown, so a refusal below is the claim's
  assertNode.equal(await shown(tail.trim(), "Black and white film photography"), true);
  for (const d of R4_DECOYS) {
    assertNode.equal(await shown(d.text, d.record), false, `${d.why}: ${JSON.stringify(d.text)} shown on ${JSON.stringify(d.record)}`);
    assertNode.notDeepEqual(claimProblems(d.text, { record: recordOf(d.record) }), [], `${d.why}: ${JSON.stringify(d.text)} passed on ${JSON.stringify(d.record)}`);
  }
});

// Review of #512 (2026-11-05, architect decision, D-007): "As a / I am a <identity>" missed every other way of saying who
// the person is, the record-word exemption still let "As a Hispanic analyst" through on "Member, Hispanic Scholarship Fund",
// screening answers in other words got through, and honest work lines were refused for their topic words. Each claim below
// was shown at #512's head (19c8c2888) on at least one record, several only once an honest on-record decimal ("My GPA was
// 3.4.") is in the same draft. Never written in prose, whatever the record holds: race or ethnicity, religion, sexual
// orientation or gender identity, immigration or national origin, family or parental status, first-generation status, and
// every screening answer. Disability, veteran status and work rights still follow the record (unchanged).
// The records each claim is tried on: none, look-alike words, the claim's own numbers, the identity words on an
// organisation, and the claim itself in the person's own words.
// Work the person did, on their record: never a screening answer, never refused for its topic words.
// RELEASE 2 FLOOR (architect, 2026-11-05; D-007): release 2 refuses every draft production (03edad41f) refuses, and
// production refuses an honest on-record decimal ("My GPA was 3.4." splits into "3." and "4"). So for release 2 the claims
// below are refused with and without the decimal tail, and the honest drafts and work lines are shown without it; with it,
// they are shown only after release 2 (the ignored test below, kept so the loosening comes back with its proof).
const R512_TAIL_DECIMAL = " At Acme Corp, I built Tableau dashboards for 40 sales reps. My GPA was 3.4.";
const R512_TAIL_PLAIN = " At Acme Corp, I built Tableau dashboards for 40 sales reps.";
Deno.test("review of #512: identity and screening answers in any phrasing are never written; work the person did is", async () => {
  for (const tail of [R512_TAIL_DECIMAL, R512_TAIL_PLAIN]) await review512(tail, { refusals: true, accepts: tail === R512_TAIL_PLAIN });
});
Deno.test({ name: "after release 2: with an honest on-record decimal in the draft, the honest draft and work lines are shown (#507, #514)", ignore: true, fn: async () => {
  await review512(R512_TAIL_DECIMAL, { refusals: false, accepts: true });
} });
async function review512(tail: string, run: { refusals: boolean; accepts: boolean }) {
  const conf = { status: "confirmed", needs_confirmation: false, source: "user" };
  const base = [{ id: "F-1", kind: "experience", title: "Data Analyst, Acme Corp, 2019-2022", org: "Acme Corp", role: "Data Analyst", start: "2019", end: "2022",
    bullets: ["Built Tableau dashboards for 40 sales reps"], ...conf },
    { id: "F-2", kind: "education", title: "B.S. Statistics, Ridgeview University, 2018", school: "Ridgeview University", degree: "B.S. Statistics", text: "GPA 3.4/4.0", ...conf }];
  // tail: R512_TAIL_DECIMAL holds an honest on-record decimal (#507 fixed decimals, which unmasked several of these)
  const draft = async (text: string, record: string) => {
    const facts = record ? [...base, { id: "F-3", kind: "other", title: "How I describe myself", text: record, ...conf }] : base;
    const a = await checkDraft({ q: essayQ("Tell us about yourself.", "Larkspur Health"), siblingLabels: [], deps: { facts: () => facts }, text: `${text}${tail}` });
    assertNode.notEqual(a.ok ? "" : a.why, "thin", `${JSON.stringify(text)}: too few facts to judge`);
    return a;
  };
  const recordOf = (record: string) => ["Data Analyst, Acme Corp, 2019-2022; Built Tableau dashboards for 40 sales reps", "B.S. Statistics, Ridgeview University, 2018; GPA 3.4/4.0", record].filter(Boolean);
  const named = (why: string) => why === "identity" ? /how you identify/ : /answered on the application form/;
  // the control: the honest draft alone is shown on every record
  if (run.accepts) for (const r of R512_RECORDS("")) assertNode.equal((await draft("", r)).ok, true, `the honest draft was refused on ${JSON.stringify(r)}`);
  const missed: string[] = [];
  for (const c of run.refusals ? R512_CLAIMS : []) {
    for (const r of R512_RECORDS(c.text)) {
      const tag = `${c.why}: ${JSON.stringify(c.text)} on ${JSON.stringify(r)}`;
      const a = await draft(c.text, r);
      if (a.ok) missed.push(`checkDraft shown, ${tag}`);
      else if (!a.detail.some((x) => named(c.why).test(x))) missed.push(`checkDraft refused for another reason (${a.detail.join("; ")}), ${tag}`);
      if (!claimProblems(c.text, { record: recordOf(r) }).some((x) => named(c.why).test(x))) missed.push(`claimProblems passed, ${tag}`);
      if (!claimProblems(c.text, { record: [r], line: true }).some((x) => named(c.why).test(x))) missed.push(`claimProblems (line) passed, ${tag}`);
    }
  }
  assertNode.deepEqual(missed, []);
  for (const w of run.accepts ? R512_WORK : []) {
    const a = await draft(w.text, w.record);
    assertNode.equal(a.ok, true, `${JSON.stringify(w.text)} refused: ${a.ok ? "" : a.detail.join("; ")}`);
    assertNode.deepEqual(claimProblems(w.text, { record: recordOf(w.record) }), []);
    assertNode.deepEqual(claimProblems(w.text.replace(/^I (\w)/, (_, x) => x.toUpperCase()).replace(/\.$/, ""), { record: [w.record], line: true }), []);
  }
  // the same words as the person's own answer are still refused
  if (!run.refusals) return;
  assertNode.equal((await draft("I passed a background check.", "Ran background checks for 300 new hires")).ok, false);
  assertNode.equal((await draft("I have never failed a drug test.", "Coordinated drug testing for 300 drivers")).ok, false);
  assertNode.equal((await draft("I prosecuted felony cases, and I have no felony convictions.", "Prosecuted felony cases in the Felony Trial Unit")).ok, false);
}
