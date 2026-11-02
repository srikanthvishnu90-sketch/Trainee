// TAILORING, LETTERS AND FORM ANSWERS, ROUND 3 (architect, 2026-11-02; owner rule D-007, never invent a fact; never submit
// what the person did not approve). ~10,800 seeded scenarios on a FRESH seed (tests/architect/scenarios/tailoring-r3-generator.ts)
// in categories rounds 1 and 2 did not have, each through the product's own code with no model, network, database or clock:
//   lookalike  "authorized to work?" and "will you require sponsorship?" (and citizenship, permanence, five languages): each
//              only from the fact that says it (planBatch, career_apply.ts)
//   numeric    years with a tool, years in total, GPAs on another scale or of another kind, pay in thousands / a month / an
//              hour / another currency, years from dates never stated as years: a number only as the person stated it
//   dropdown   options that do not include the person's value, only words around it ("Female" for "Male", "Top Secret" for
//              "Secret", "Indiana" for "India", "MBA" for a master's, "Portland, Maine" for a Portland in Oregon): asked, by
//              the planner (answer_options.ts chooseOption), by the texting side (checkAnswer) and by the browser fill
//              engine (workers/career-browser/ats-fill.cjs matchOption)
//   eeo        voluntary questions: blank (optional) or asked (required) unless the person said otherwise; their "decline"
//              only onto a decline option, in the planner and in the fill engine (decide)
//   correction a fact corrected after a payload was planned: every field the fact filled changes, and the payload hash the
//              person approved with the old value never matches again; a correction the form never used changes nothing
//   letter     a cover letter naming another employer as the one applied to, another role, or a skill not on the record:
//              never shown (essay_draft.ts checkDraft and draftEssay); honest letters naming former employers in the past
//              tense always are
//   inject     a line written for an AI in the question or beside it: never drafted, the model never called; a draft that
//              is an instruction or says it is an AI: never shown, in any case; a question ABOUT AI is drafted as usual
//   cap        the form's own length limit: an answer over it is never saved (checkAnswer), planned (planBatch) or cut
//              (draftEssay, a reply stopped mid-number included); one inside it is kept word for word
//   twice      the same question twice on one form: two wordings get one answer; one label on two questions gets none
//   deno test -A --no-check tests/architect/scenarios-tailoring-r3.test.ts
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { planBatch, normLabel, type FormField } from "../../supabase/functions/_shared/career_apply.ts";
import { chooseOption } from "../../supabase/functions/_shared/answer_options.ts";
import { checkAnswer, type OpenQuestion } from "../../supabase/functions/_shared/career_apply_questions.ts";
import { checkDraft, draftEssay } from "../../supabase/functions/_shared/essay_draft.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { planForm } from "../../extension/src/apply_core.ts";
import {
  type Ans, capCases, dropdownCases, eeoCases, type FieldCase, INJECTED_SIBLINGS, injectCases, letterCases, lookalikeCases, numericCases, rng,
} from "./scenarios/tailoring-r3-generator.ts";

const require = createRequire(import.meta.url);
const ats = require("../../workers/career-browser/ats-fill.cjs");
const SEED = 20261102;
const NOW = Date.parse("2026-11-02T15:00:00Z");
type Fails = Map<string, string[]>;
const fail = (f: Fails, family: string, line: string) => { if (!f.has(family)) f.set(family, []); f.get(family)!.push(line); };
export const TOTALS: Record<string, number> = {};
function report(f: Fails, total: number, what: string, extra = "") {
  const n = [...f.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[tailoring-r3] ${what}: ${total} scenarios, ${n} failures${extra ? `; ${extra}` : ""}`];
  for (const [k, xs] of [...f].sort((a, b) => b[1].length - a[1].length)) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    ${x}`); }
  console.log(lines.join("\n"));
  return n;
}
const field = (label: string, type: string, options: string[], name = "q", required = true): FormField =>
  ({ name, label, type, required, options: options.map((l) => ({ label: l, value: l })) });
const plan = (fields: FormField[], answers: Record<string, Ans>, saved: Record<string, Ans> = {}, location = "Chicago, IL", job = "j1") =>
  planBatch({ userId: "u-r3", postings: [{ job_id: job, company: "Larkspur Health", title: "Data Analyst", fields, location, url: `https://boards.example.test/${job}` }], answers, saved, log: [], now: NOW });
const filledOf = (p: ReturnType<typeof plan>, name = "q") => p.ready[0]?.fields.find((x) => x.name === name) ?? null;
const YES = /^(yes|sí|si|oui|ja|sim)$/i, NO = /^(no|non|nein|não|nee)$/i;
const ynOf = (s: string) => (YES.test(s.trim()) ? "Yes" : NO.test(s.trim()) ? "No" : null);
const fakeModel = (outputs: string[], stop = "end_turn") => {
  let calls = 0;
  return { model: async (_: unknown) => ({ content: [{ type: "text", text: outputs[Math.min(calls++, outputs.length - 1)] }], stop_reason: stop }), calls: () => calls };
};
const openQ = (label: string, type: string, options: string[], kind = "essay"): OpenQuestion =>
  ({ id: "q1", key: `label:${normLabel(label).slice(0, 40)}`, kind, label, type, options, company: "Larkspur Health", job_ids: ["j1"], misfit: false, answer: null });

Deno.test("look-alike questions: work rights, sponsorship and citizenship each only from the fact that says it", () => {
  const cases = lookalikeCases(rng(SEED), 1500);
  const f: Fails = new Map();
  let filled = 0;
  for (const c of cases) {
    const got = filledOf(plan([field(c.field.label, c.field.type, c.field.options)], c.answers, c.saved, c.location));
    const tag = `${JSON.stringify(c.field.label)} facts=${JSON.stringify(Object.fromEntries(Object.entries(c.answers).filter(([k]) => /auth|spons|citiz/.test(k)).map(([k, v]) => [k, v.value])))}`;
    if (!got) continue;
    filled++;
    if (!c.allowed.includes(got.factId)) fail(f, `${c.family}:wrong-fact`, `${tag} -> "${got.value}" from ${got.factId}`);
    else if (c.expect === null) fail(f, `${c.family}:no-fact-says-it`, `${tag} -> "${got.value}" from ${got.factId}`);
    else if (ynOf(got.value) !== c.expect) fail(f, `${c.family}:wrong-answer`, `${tag} -> "${got.value}", the facts say ${c.expect}`);
  }
  TOTALS.lookalike = cases.length;
  assertNode.equal(report(f, cases.length, "look-alike questions", `${filled} filled, the rest asked`), 0);
});

Deno.test("numbers: years, GPAs and pay only as the person stated them, for the question that asks exactly that", () => {
  const cases = numericCases(rng(SEED + 1), 1500);
  const f: Fails = new Map();
  for (const c of cases) {
    const got = filledOf(plan([field(c.field.label, c.field.type, c.field.options)], c.answers));
    const tag = JSON.stringify(c.field.label);
    if (!got) { if (c.expect !== null && c.family !== "numeric:total-years") fail(f, `${c.family}:asked-with-the-fact`, `${tag} asked though "${c.expect}" is stated`); continue; }
    if (!c.allowed.includes(got.factId)) fail(f, `${c.family}:filled`, `${tag} -> "${got.value}" from ${got.factId}`);
    else if (got.value !== c.expect) fail(f, `${c.family}:changed`, `${tag} -> "${got.value}", stated "${c.expect}"`);
  }
  TOTALS.numeric = cases.length;
  assertNode.equal(report(f, cases.length, "numeric questions"), 0);
});

Deno.test("dropdowns without the person's value: asked by the planner, the texting side and the fill engine, never the nearest", () => {
  const cases = dropdownCases(rng(SEED + 2), 2000);
  const f: Fails = new Map();
  let ownPicked = 0, ownPresent = 0;
  for (const c of cases) {
    const answers: Record<string, Ans> = { [c.fact]: { value: c.value, factId: `fact:${c.fact}` }, ...(c.location ? { location: { value: c.location, factId: "fact:location" } } : {}) };
    const tag = `${c.fact}=${c.value} options=${JSON.stringify(c.options)}${c.location ? ` location=${c.location}` : ""}`;
    // the planner, through the whole form path
    const got = filledOf(plan([field(c.label, "multi_value_single_select", c.options)], answers));
    if (c.own) ownPresent++;
    if (got && got.value !== c.own) fail(f, `${c.family}:planner-nearest`, `${tag} -> "${got.value}"`);
    if (got && got.value === c.own) ownPicked++;
    // the option chooser alone
    const ch = chooseOption(c.fact, c.value, c.options.map((l) => ({ label: l, value: l })), c.label);
    if (ch !== null && ch !== c.own) fail(f, `${c.family}:chooseOption-nearest`, `${tag} -> "${ch}"`);
    // the person typing their own value as the answer
    const typed = checkAnswer(openQ(c.label, "multi_value_single_select", c.options, "fact"), c.value);
    if (typed.ok && typed.value !== c.own) fail(f, `${c.family}:typed-nearest`, `${tag} typed "${c.value}" -> saved "${typed.value}"`);
    // the browser fill engine, with the value approved on the card
    const m = ats.matchOption(c.options, c.value);
    if (!m.error && c.options[m.index] !== c.own) fail(f, `${c.family}:fill-engine-nearest`, `${tag} -> "${c.options[m.index]}"`);
  }
  TOTALS.dropdown = cases.length;
  assertNode.equal(report(f, cases.length, "dropdowns without the value", `own option present ${ownPresent}, picked ${ownPicked}`), 0);
});

Deno.test("voluntary questions: blank or asked unless the person said otherwise; a decline only onto a decline option", () => {
  const cases = eeoCases(rng(SEED + 3), 800);
  const f: Fails = new Map();
  const DECL = /decline|prefer not|don't wish|do not want|not to answer|rather not/i;
  for (const c of cases) {
    const answers: Record<string, Ans> = { full_name: { value: "Alex Testcase", factId: "fact:full_name" }, ...(c.eeo ? { eeo: { value: c.eeo, factId: "fact:eeo" } } : {}) };
    const fl = { ...field(c.label, "multi_value_single_select", c.options), required: c.required };
    const p = plan([fl], answers);
    const got = filledOf(p);
    const tag = `${JSON.stringify(c.label)} eeo=${c.eeo} required=${c.required}`;
    if (!c.eeo && got) fail(f, "eeo:filled-without-an-answer", `${tag} -> "${got.value}"`);
    if (c.eeo && got && !DECL.test(got.value)) fail(f, "eeo:decline-became-an-answer", `${tag} -> "${got.value}"`);
    if (!got && c.required && !p.needs.length) fail(f, "eeo:required-left-silently", tag);
    // the fill engine on the same question
    const d = { kind: "select", label: c.label, required: c.required, eeo: true, options: c.options.map((l, i) => ({ i, label: l, value: l })) };
    const dec = ats.decide(d, { facts: c.eeo ? { eeo_policy: "decline" } : {}, answers: {}, labelCount: new Map() });
    if (!c.eeo && dec.status === "fill") fail(f, "eeo:engine-filled-without-an-answer", `${tag} -> ${JSON.stringify(dec)}`);
    if (!c.eeo && c.required && dec.status !== "ask") fail(f, "eeo:engine-required-not-asked", `${tag} -> ${JSON.stringify(dec)}`);
    if (c.eeo && dec.status === "fill" && dec.pick !== "decline") fail(f, "eeo:engine-not-decline", `${tag} -> ${JSON.stringify(dec)}`);
  }
  TOTALS.eeo = cases.length;
  assertNode.equal(report(f, cases.length, "voluntary questions"), 0);
});

Deno.test("a corrected fact: every field it filled changes and the approved payload hash never matches again", async () => {
  const r = rng(SEED + 4);
  const f: Fails = new Map();
  const N = 1000;
  let changed = 0, untouched = 0;
  const FORM = [field("Desired salary", "input_text", [], "pay"), field("GPA", "input_text", [], "gpa"), field("Will you now or in the future require visa sponsorship?", "multi_value_single_select", ["Yes", "No"], "spons"),
    field("How many years of professional experience do you have in total?", "number", [], "years"), field("Email", "input_text", [], "email")];
  const NEXT: Record<string, (v: string) => string> = {
    salary_expectation: (v) => String(Number(v) + 5000), gpa: (v) => (v === "3.8" ? "3.6" : "3.8"), sponsorship: (v) => (v === "Yes" ? "No" : "Yes"),
    years_experience: (v) => String(Number(v) + 1), email: (v) => v.replace("@", ".new@"), city: () => "Denver",
  };
  for (let i = 0; i < N; i++) {
    const answers: Record<string, Ans> = {
      salary_expectation: { value: String(r.int(60, 190) * 1000), factId: "fact:salary_expectation" }, gpa: { value: r.pick(["3.8", "3.6"]), factId: "fact:gpa" },
      sponsorship: { value: r.pick(["Yes", "No"]), factId: "fact:sponsorship" }, years_experience: { value: String(r.int(1, 12)), factId: "fact:years_experience" },
      email: { value: `person${i}@example.test`, factId: "fact:email" }, city: { value: "Chicago", factId: "fact:city" },
    };
    const form = FORM.filter(() => r.next() < 0.7);
    if (!form.length) form.push(FORM[0]);
    const payload = (a: Record<string, Ans>) => {
      const p = plan(form.map((x) => ({ ...x, required: false })), a);
      return { version: 1, user_id: "u-r3", job_id: "j1", company: "Larkspur Health", url: "https://boards.example.test/j1", fields: (p.ready[0]?.fields ?? []).map((x) => ({ ...x })),
        privacy_epoch: 0, account_version: 7, expires_at: "2026-11-03T15:00:00Z" };
    };
    const before = payload(answers), approved = await hashApplyPayload(before);
    const which = r.pick(Object.keys(NEXT));
    const corrected = { ...answers, [which]: { value: NEXT[which](answers[which].value), factId: answers[which].factId } };
    const after = payload(corrected), now = await hashApplyPayload(after);
    const used = before.fields.filter((x) => x.factId === `fact:${which}`);
    const tag = `${which}: ${answers[which].value} -> ${corrected[which].value} on [${form.map((x) => x.name)}]`;
    if (used.length) {
      changed++;
      if (now === approved) fail(f, "correction:hash-still-matches", tag);
      for (const u of used) {
        const a2 = after.fields.find((x) => x.name === u.name);
        if (a2 && a2.value === u.value) fail(f, "correction:old-value-kept", `${tag}: ${u.name} still "${u.value}"`);
      }
    } else {
      untouched++;
      if (now !== approved) fail(f, "correction:unused-fact-changed-the-payload", tag);
    }
  }
  TOTALS.correction = N;
  assertNode.equal(report(f, N, "corrections after planning", `${changed} payloads used the corrected fact, ${untouched} did not`), 0);
});

Deno.test("cover letters: another employer, another role or an unconfirmed skill is never shown; honest letters always are", async () => {
  const cases = letterCases(rng(SEED + 5), 1500);
  const f: Fails = new Map();
  let honest = 0, thin = 0;
  for (const c of cases) {
    const q = { id: "q1", label: `Cover letter for the ${c.title} role at ${c.company} (max 500 characters)`, type: "textarea", kind: "essay", company: c.company, job_ids: ["j1"] };
    const facts = c.person.facts;
    const a = await checkDraft({ q, siblingLabels: [], deps: { facts: () => facts }, text: c.text });
    if (!a.ok && a.why === "thin") { thin++; continue; }
    const tag = `${JSON.stringify(c.text.slice(0, 220))} for ${c.title} at ${c.company}`;
    if (c.bad && a.ok) fail(f, `${c.family}:shown`, `${tag} (names ${c.bad})`);
    if (!c.bad) { honest++; if (!a.ok) fail(f, `${c.family}:honest-refused`, `${tag} -> ${a.why}: ${a.detail.join("; ")}`); }
    if (c.bad) {
      // drafted: the bad letter first, an honest one after; only the honest one is ever shown
      const ok = `At ${c.person.exps[0].org}, I ${c.person.exps[0].bullets[0].charAt(0).toLowerCase()}${c.person.exps[0].bullets[0].slice(1).replace(/\.$/, "")}. I want to bring the same care to ${c.company}.`;
      const d = await draftEssay({ q, siblingLabels: [], deps: { model: fakeModel([c.text, ok]).model, facts: () => facts } });
      if (d.ok && d.text !== ok) fail(f, `${c.family}:drafted`, `${tag} -> shown ${JSON.stringify(d.text.slice(0, 160))}`);
      if (!d.ok && d.why !== "thin") fail(f, `${c.family}:honest-retry-refused`, `${tag} -> ${d.why}: ${d.detail.join("; ")}`);
    }
  }
  TOTALS.letter = cases.length;
  assertNode.equal(report(f, cases.length, "cover letters", `${honest} honest letters checked, ${thin} too thin to draft`), 0);
});

Deno.test("prompt injection: a line written for an AI is never followed; a draft that is no answer is never shown", async () => {
  const cases = injectCases(rng(SEED + 6), 1000);
  const f: Fails = new Map();
  let drafted = 0;
  const r = rng(SEED + 66);
  for (const c of cases) {
    const q = { id: "q1", label: c.label, type: "textarea", kind: "essay", company: c.company, job_ids: ["j1"] };
    const siblings = c.where === "sibling" ? [`Additional information. ${r.pick(INJECTED_SIBLINGS)}`] : [];
    const m = fakeModel(c.outputs);
    const d = await draftEssay({ q, siblingLabels: siblings, deps: { model: m.model, facts: () => c.person.facts } });
    const tag = `${JSON.stringify(c.label.slice(0, 160))}${siblings.length ? ` beside ${JSON.stringify(siblings[0])}` : ""}`;
    if (c.injected) {
      if (m.calls() !== 0) fail(f, `${c.family}:model-called`, tag);
      if (d.ok) fail(f, `${c.family}:drafted`, `${tag} -> ${JSON.stringify(d.text.slice(0, 120))}`);
      else if (d.why !== "policy") fail(f, `${c.family}:not-refused-as-policy`, `${tag} -> ${d.why}`);
      const a = await checkDraft({ q, siblingLabels: siblings, deps: { facts: () => c.person.facts }, text: c.outputs[0] });
      if (a.ok) fail(f, `${c.family}:ahead-shown`, tag);
    } else if (c.notAnswer) {
      if (d.ok) fail(f, `${c.family}:shown`, `${tag} -> ${JSON.stringify(d.text.slice(-140))}`);
    } else if (!d.ok && d.why !== "thin") fail(f, `${c.family}:control-refused`, `${tag} -> ${d.why}: ${d.detail.join("; ")}`);
    else if (d.ok) drafted++;
  }
  TOTALS.inject = cases.length;
  assertNode.equal(report(f, cases.length, "prompt injection", `${drafted} questions about AI drafted as usual`), 0);
});

Deno.test("length limits: over the form's own limit is never saved, planned or cut; inside it is kept word for word", async () => {
  const cases = capCases(rng(SEED + 7), 1000);
  const f: Fails = new Map();
  const p0 = (await import("./scenarios/tailoring-r3-generator.ts")).personR2(rng(SEED + 77), 7);
  for (const [i, c] of cases.entries()) {
    const tag = `${JSON.stringify(c.label)} (${c.text.length} chars, ${c.text.split(/\s+/).length} words)`;
    const typed = checkAnswer(openQ(c.label, "textarea", []), c.text);
    if (c.over && typed.ok) fail(f, `${c.family}:typed-saved`, tag);
    if (!c.over && (!typed.ok || typed.value !== c.text)) fail(f, `${c.family}:typed-refused-or-changed`, `${tag} -> ${JSON.stringify(typed)}`);
    const saved = { [normLabel(c.label)]: { value: c.text, factId: `text-answer:${i}` } };
    const got = filledOf(plan([field(c.label, "textarea", [])], {}, saved));
    if (c.over && got) fail(f, `${c.family}:planned`, `${tag} -> ${got.value.length} chars planned`);
    if (!c.over && got?.value !== c.text) fail(f, `${c.family}:planned-changed`, `${tag} -> ${JSON.stringify(got?.value?.slice(0, 80))}`);
    if (i % 4 === 0) {
      // the drafter: a reply over the limit twice, or stopped by the token limit mid-number, is never cut and shown
      const q = { id: "q1", label: c.label, type: "textarea", kind: "essay", company: "Larkspur Health", job_ids: ["j1"] };
      let long = c.text;
      while (long.length <= (c.limit.chars ?? 0) * 1.2 || long.split(/\s+/).length <= (c.limit.words ?? 0) * 1.2) long = `${long} ${c.text}`;
      const d = await draftEssay({ q, siblingLabels: [], deps: { model: fakeModel([long, long]).model, facts: () => p0.facts } });
      if (d.ok) fail(f, `${c.family}:drafter-shown-over`, `${tag} -> ${d.text.length} chars`);
      const cut = await draftEssay({ q, siblingLabels: [], deps: { model: fakeModel(["I cut the close from 9 days to 6 and raised accuracy by 4"], "max_tokens").model, facts: () => p0.facts } });
      if (cut.ok) fail(f, `${c.family}:drafter-shown-cut`, `${tag} -> ${JSON.stringify(cut.text)}`);
    }
  }
  TOTALS.cap = cases.length;
  assertNode.equal(report(f, cases.length, "length limits"), 0);
});

Deno.test("the same question twice on one form: two wordings get one answer; one label on two questions gets none", () => {
  const r = rng(SEED + 8);
  const f: Fails = new Map();
  const N = 500;
  const PAIRS: [string, string, string, string[]][] = [
    ["sponsorship", "Will you now or in the future require visa sponsorship?", "Do you need sponsorship to work for us in the United States?", ["Yes", "No"]],
    ["work_authorization", "Are you legally authorized to work in the United States?", "Are you authorized to work in the US?", ["Yes", "No"]],
    ["salary_expectation", "Desired salary", "What are your salary expectations?", []],
    ["email", "Email", "Email address", []],
  ];
  for (let i = 0; i < N; i++) {
    const [k, l1, l2, os] = r.pick(PAIRS);
    const value = os.length ? r.pick(os) : k === "email" ? `p${i}@example.test` : String(r.int(70, 180) * 1000);
    const answers: Record<string, Ans> = { [k]: { value, factId: `fact:${k}` } };
    // an older saved answer under the second wording that disagrees with the fact
    const other = os.length ? os.find((x) => x !== value)! : k === "email" ? `old${i}@example.test` : String(Number(value) + 10000);
    const saved = r.next() < 0.5 ? { [normLabel(l2)]: { value: other, factId: `text-answer:${i}` } } : {};
    const t = os.length ? "multi_value_single_select" : "input_text";
    const p = plan([field(l1, t, os, "a"), field(l2, t, os, "b")], answers, saved);
    const a = filledOf(p, "a"), b = filledOf(p, "b");
    const tag = `${k}=${value}${Object.keys(saved).length ? ` (saved "${other}" for the 2nd wording)` : ""}`;
    if (a && b && a.value !== b.value) fail(f, "twice:two-wordings-disagree", `${tag} -> "${a.value}" / "${b.value}"`);
    // one label on two questions (a references block's "Phone"): neither is filled from it
    const one = k === "email" ? "Email" : l1;
    const pf = planForm({ userId: "u", jobId: "j1", company: "Larkspur Health", family: "greenhouse" as any, schema: [field(one, t, os, "x1", false), field(one, t, os, "x2", false)], answers, saved: {}, now: NOW });
    if (pf.fill.length) fail(f, "twice:one-label-two-questions-planner", `${JSON.stringify(one)} -> ${JSON.stringify(pf.fill.map((x) => x.value))}`);
    const d = { kind: os.length ? "select" : "text", label: one, required: false, eeo: false, options: os.map((l, j) => ({ i: j, label: l, value: l })) };
    const dec = ats.decide(d, { facts: { email: `p${i}@example.test` }, answers: { [one]: value }, labelCount: new Map([[ats.norm(one), 2]]) });
    if (dec.status === "fill") fail(f, "twice:one-label-two-questions-engine", `${JSON.stringify(one)} -> ${JSON.stringify(dec)}`);
  }
  TOTALS.twice = N;
  assertNode.equal(report(f, N, "the same question twice"), 0);
});
