// Item 19 (owner, 2026-10-21 17:10): the graduation month is stated, the graduation YEAR is not. A year read off a
// resume's span ("2025 - 2029") is an assumption: it never fills a form, and a form that forces a year asks for it.
// Through the cloud producer (engine_input.ts) and the one contract (planForm + contractFill), on the shapes a year is
// asked in. Synthetic person only.
import { engineInput } from "../../workers/career-cloud/engine_input.ts";
import { trustedFacts } from "../../scripts/apply.ts";
import { contractFill, planForm } from "../../extension/src/apply_core.ts";
const ok = (v: unknown, why: string) => { if (!v) throw new Error(why); };
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const chat = (id: string, kind: string, text: string, extra: Record<string, unknown> = {}) => ({ id, kind, text, title: "", source: "user", status: "confirmed",
  needs_confirmation: false, provenance: "owner confirmed in chat (2026-10-21T17:10:00.000Z)", confirmation_event_id: "evt-" + id, ...extra });
const row = (n: number, key: string, answer: string) => ({ id: rid(n), user_id: OWNER, key, kind: "fact", answer, state: "answered" });
const opts = (xs: string[]) => xs.map((l) => ({ label: l, value: l }));
const MONTHS = opts(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]);
const YEARS = opts(["2026", "2027", "2028", "2029", "2030"]);
const F = (name: string, label: string, type: string, options: { label: string; value: string }[] = []) => ({ name, label, type, options, required: true });
// The confirmed education fact as the resume gives it: the span's end is the assumed year.
const PROFILE = { user_id: OWNER, facts: [chat("F-001", "education", "B.S. Computer Science and Finance, Synthetic University, 2025 - 2029",
  { title: "B.S. Computer Science and Finance, Synthetic University", start: "2025", end: "2029" })] };
const FORMS: Record<string, { family: string; schema: ReturnType<typeof F>[]; year: string[] }> = {
  greenhouse: { family: "greenhouse", schema: [F("school--0", "School", "select", opts(["Synthetic University"])), F("end-month--0", "End date month", "select", MONTHS), F("end-year--0", "End date year", "select", YEARS)], year: ["end-year--0"] },
  textYear: { family: "lever", schema: [F("q1", "Graduation Year", "text")], year: ["q1"] },
  selectYear: { family: "lever", schema: [F("q2", "Expected graduation year", "select", YEARS)], year: ["q2"] },
  monthYear: { family: "lever", schema: [F("q3", "Expected graduation date (MM/YYYY)", "text")], year: ["q3"] },
  date: { family: "lever", schema: [F("q4", "Graduation date", "text")], year: ["q4"] },
  whatYear: { family: "lever", schema: [F("q5", "What year will you graduate?", "text")], year: ["q5"] },
  classYear: { family: "lever", schema: [F("q6", "Class year", "select", YEARS)], year: ["q6"] },
  endYear: { family: "lever", schema: [F("q7", "Education end year", "text")], year: ["q7"] },
};
function run(rows: unknown[], form: keyof typeof FORMS) {
  const ei = engineInput({ owner: OWNER, profile: PROFILE, rows });
  const m = trustedFacts(JSON.parse(JSON.stringify(ei.facts)), { sha256: "a".repeat(64) });
  const { family, schema } = FORMS[form];
  const plan = planForm({ userId: OWNER, jobId: "job-1", company: "Synthetic Co", family: family as never, schema, answers: m.answers, saved: m.saved, now: Date.parse("2026-10-22T00:00:00Z") });
  const c = contractFill({ schema, plan, manifest: m, resume: null });
  const open = new Set([...plan.needs.map((n) => n.label), ...c.asks.map((a) => a.label)]);
  return { fill: c.fill, open, m };
}
const STATES = { none: [], month: [row(1, "fact:graduation_date", "June")] };

Deno.test("grad year: the resume span's year never fills any form, and every year the form forces stays asked", () => {
  for (const [state, rows] of Object.entries(STATES)) for (const form of Object.keys(FORMS) as (keyof typeof FORMS)[]) {
    const { fill, open, m } = run(rows, form);
    ok(!m.answers.graduation_date || m.answers.graduation_date.factId.startsWith("text-answer:"), `${state}/${form}: a graduation date only from his own answer`);
    for (const p of fill) ok(!/\b2029\b/.test(p.value), `${state}/${form}: ${p.name} was filled with the assumed year (${p.value})`);
    for (const name of FORMS[form].year) {
      const f = FORMS[form].schema.find((x) => x.name === name)!;
      ok(!fill.some((p) => p.name === name), `${state}/${form}: "${f.label}" was filled (${fill.find((p) => p.name === name)?.value}) without a stated year`);
      ok(open.has(f.label), `${state}/${form}: "${f.label}" is required and must be asked`);
    }
  }
});

Deno.test("grad year: the stated month still fills the month, and nothing else", () => {
  const { fill } = run(STATES.month, "greenhouse");
  ok(fill.some((p) => p.name === "end-month--0" && p.value === "June"), "the stated month answers the month box");
  ok(!fill.some((p) => p.name === "end-year--0"), "the year box is not completed from anywhere");
});

Deno.test("grad year: once he states the year, the year boxes take it from his answer, never from the resume", () => {
  // "What year will you graduate?" and "Education end year" are not in the question map: asked (test 1), never filled.
  // A year list (selectYear, Greenhouse's end-year) is asked again even then: the contract allows only an option equal to
  // the answer's words ("2030" is not "June 2030"). Safe; ask-once friction, left for its own order.
  for (const form of ["textYear"] as const) {
    const { fill } = run([row(1, "fact:graduation_date", "June 2030")], form);
    const p = fill.find((x) => x.name === FORMS[form].year[0]);
    ok(p && /\b2030\b/.test(p.value) && p.factId === `text-answer:${rid(1)}`, `${form}: his stated year fills it, by his row (${JSON.stringify(p)})`);
  }
});

Deno.test("grad year: a year-shaped rule does not touch other year questions (years of experience)", () => {
  const schema = [F("q8", "Total years of experience", "text")];
  const ei = engineInput({ owner: OWNER, profile: {}, rows: [row(2, "fact:years_experience", "1")] });
  const m = trustedFacts(JSON.parse(JSON.stringify(ei.facts)), { sha256: "a".repeat(64) });
  const plan = planForm({ userId: OWNER, jobId: "job-1", company: "Synthetic Co", family: "lever" as never, schema, answers: m.answers, saved: m.saved, now: Date.parse("2026-10-22T00:00:00Z") });
  const c = contractFill({ schema, plan, manifest: m, resume: null });
  ok(c.fill.some((p) => p.name === "q8" && p.value === "1"), `years of experience still fills (${JSON.stringify(c.fill)})`);
});
