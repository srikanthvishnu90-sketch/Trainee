// RELEASE 2 FLOOR (architect, 2026-11-05; D-007): release 2 refuses every draft production (03edad41f) refuses. Production's
// claim checks are vendored unchanged (person_claims_baseline.ts, essay_draft_baseline.ts); claimProblems is the union of
// the current and the production problems, and checkDraft shows a draft only if both the current and production's checks
// show it. This test proves the floor on a broad matrix, independent of how it is built:
//   drafts   R4_DECOYS, R512_CLAIMS, R512_WORK, the reviewer's phrasings of #514 (must be refused, by the CURRENT rules
//            too, naming the identity or screening reason), and the round 2 honest corpus;
//   records  none, every R512 record (the claim's own words included), an HR and legal record full of look-alike words;
//   tails    without and with " My GPA was 3.4." (3.4 on the record);
//   checks   checkDraft, claimProblems over the whole record, claimProblems in line mode (a tailored line).
// Property: wherever production refuses, release 2 refuses (and claimProblems holds every production problem).
import assertNode from "node:assert/strict";
import { checkDraft, factText } from "../../supabase/functions/_shared/essay_draft.ts";
import { checkDraft as prodCheckDraft } from "../../supabase/functions/_shared/essay_draft_baseline.ts";
import { claimProblems } from "../../supabase/functions/_shared/person_claims.ts";
import { claimProblems as prodClaimProblems } from "../../supabase/functions/_shared/person_claims_baseline.ts";
import { R4_DECOYS, R512_CLAIMS, R512_RECORDS, R512_WORK } from "./scenarios/tailoring-r4-claims.ts";
import { honestCases, rng } from "./scenarios/tailoring-r2-generator.ts";

const conf = { status: "confirmed", needs_confirmation: false, source: "user" };
const BASE = [
  { id: "F-1", kind: "experience", title: "Data Analyst, Acme Corp, 2019-2022", org: "Acme Corp", role: "Data Analyst", start: "2019", end: "2022",
    bullets: ["Built Tableau dashboards for 40 sales reps"], ...conf },
  { id: "F-2", kind: "education", title: "B.S. Statistics, Ridgeview University, 2018", school: "Ridgeview University", degree: "B.S. Statistics", text: "GPA 3.4/4.0", ...conf },
];
const GPA_FACT = { id: "F-GPA", kind: "education", title: "GPA", text: "GPA 3.4/4.0", ...conf };
const TAIL = " At Acme Corp, I built Tableau dashboards for 40 sales reps.";
const GPA_TAIL = " My GPA was 3.4.";
export const HR_LEGAL_RECORD = "HR Generalist and employment-law paralegal: ran criminal background checks and drug testing for 300 new hires; " +
  "managed relocation packages, notice periods and salary benchmarking; filed immigration and refugee asylum cases; " +
  "coordinated the Black Employee Network, the Women in Tech group and the Muslim and Jewish community partnerships";

// The reviewer's false-accepts on #514 (each shown by #514's head on at least one record): never written, whatever the record.
export const REVIEW_514: { text: string; sentence: string; why: "identity" | "screening" }[] = [
  ["As a woman-identifying engineer", "As a woman-identifying engineer, I bring a different lens.", "identity"],
  ["As a Black-identifying engineer", "As a Black-identifying engineer, I bring a different lens.", "identity"],
  ["As a mother-to-be, I plan carefully.", "As a mother-to-be, I plan carefully.", "identity"],
  ["As a Muslim community center volunteer", "As a Muslim community center volunteer, I bring a different lens.", "identity"],
  ["As a Jewish foundation fellow", "As a Jewish foundation fellow, I bring a different lens.", "identity"],
  ["As a Black network founder", "As a Black network founder, I bring a different lens.", "identity"],
  ["As a Black scholarship recipient", "As a Black scholarship recipient, I bring a different lens.", "identity"],
  ["My family came here as refugees", "My family came here as refugees.", "identity"],
  ["Black and proud, I", "Black and proud, I bring a different lens.", "identity"],
  ["As a member of the Black community", "As a member of the Black community, I bring a different lens.", "identity"],
  ["As a gay-identifying analyst", "As a gay-identifying analyst, I bring a different lens.", "identity"],
  ["I volunteered for a drug test", "I volunteered for a drug test.", "screening"],
  ["I welcomed a background check at my last job", "I welcomed a background check at my last job.", "screening"],
  ["My record is spotless", "My record is spotless.", "screening"],
  ["I have never been in trouble with the law", "I have never been in trouble with the law.", "screening"],
  ["I've never had a run-in with the police", "I've never had a run-in with the police.", "screening"],
  ["I relocated for my last job and would again", "I relocated for my last job and would again.", "screening"],
  ["My current notice is two weeks", "My current notice is two weeks.", "screening"],
].map(([text, sentence, why]) => ({ text, sentence, why: why as "identity" | "screening" }));
const named = (why: string) => why === "identity" ? /how you identify/ : /answered on the application form/;

const essayQ = (label: string, company: string) => ({ id: "q1", label, type: "textarea", kind: "essay", company, job_ids: ["j1"] });
const recordsFor = (own: string) => [...new Set(["", ...R512_RECORDS(own), HR_LEGAL_RECORD])];
const recordOf = (record: string) => ["Data Analyst, Acme Corp, 2019-2022; Built Tableau dashboards for 40 sales reps", "B.S. Statistics, Ridgeview University, 2018; GPA 3.4/4.0", record].filter(Boolean);
const extraFact = (record: string) => record ? [{ id: "F-3", kind: "other", title: "How I describe myself", text: record, ...conf }] : [];

interface Tally { cells: number; prodRefused: number; violations: string[] }
async function floorCell(t: Tally, tag: string, q: ReturnType<typeof essayQ>, facts: unknown[], text: string, record: string[], line: string[]) {
  t.cells++;
  const deps = { facts: () => facts };
  const [now, prod] = [await checkDraft({ q, siblingLabels: [], deps, text }), await prodCheckDraft({ q, siblingLabels: [], deps, text } as any)];
  if (!prod.ok) t.prodRefused++;
  if (!prod.ok && now.ok) t.violations.push(`checkDraft shown, production refused (${prod.detail.join("; ")}): ${tag}`);
  for (const [mode, o] of [["record", { record }], ["line", { record: line, line: true }]] as const) {
    const n = claimProblems(text, o), p = prodClaimProblems(text, o);
    if (p.length && !n.length) t.violations.push(`claimProblems (${mode}) passed, production refused (${p.join("; ")}): ${tag}`);
    for (const x of p) if (!n.includes(x)) { t.violations.push(`claimProblems (${mode}) lost production's "${x}": ${tag}`); break; }
  }
}

Deno.test("release 2 floor: wherever production refuses a draft, release 2 refuses it (decoys, claims, work lines, #514 phrasings)", async () => {
  const t: Tally = { cells: 0, prodRefused: 0, violations: [] };
  const texts = [...new Set([...R4_DECOYS.map((d) => d.text), ...R512_CLAIMS.map((c) => c.text), ...R512_WORK.map((w) => w.text),
    ...REVIEW_514.flatMap((r) => [r.text, r.sentence])])];
  const q = essayQ("Tell us about yourself.", "Larkspur Health");
  for (const text of texts) {
    const records = [...new Set([...recordsFor(text), ...R4_DECOYS.filter((d) => d.text === text).map((d) => d.record), ...R512_WORK.filter((w) => w.text === text).map((w) => w.record)])];
    for (const r of records) {
      for (const tail of ["", GPA_TAIL]) {
        const draft = `${text}${/[.!?]$/.test(text) ? "" : "."}${TAIL}${tail}`;
        await floorCell(t, `${JSON.stringify(draft)} on ${JSON.stringify(r)}`, q, [...BASE, ...extraFact(r)], draft, recordOf(r), [r]);
      }
    }
  }
  console.log(`[claims-floor] fixed drafts: ${texts.length} texts, ${t.cells} cells x 3 checks, production refused ${t.prodRefused}, ${t.violations.length} floor violations`);
  assertNode.deepEqual(t.violations.slice(0, 20), []);
});

Deno.test("release 2 floor: the round 2 honest corpus on every record, with and without an on-record decimal", async () => {
  const t: Tally = { cells: 0, prodRefused: 0, violations: [] };
  const cases = honestCases(rng(20261030), 300);
  for (const c of cases) {
    const q = essayQ(c.label, c.company);
    for (const r of ["", R512_RECORDS("")[1], R512_RECORDS("")[4], R512_RECORDS("")[5], R512_RECORDS("")[8], HR_LEGAL_RECORD]) {
      for (const tail of ["", GPA_TAIL]) {
        const facts = [...c.person.facts, ...(tail ? [GPA_FACT] : []), ...extraFact(r)];
        const record = facts.map(factText).filter(Boolean);
        await floorCell(t, `${JSON.stringify(c.outputs[0].slice(0, 160))}${tail} on ${JSON.stringify(r)}`, q, facts, `${c.outputs[0]}${tail}`, record, record);
      }
    }
  }
  console.log(`[claims-floor] honest corpus: ${cases.length} drafts, ${t.cells} cells x 3 checks, production refused ${t.prodRefused}, ${t.violations.length} floor violations`);
  assertNode.deepEqual(t.violations.slice(0, 20), []);
});

Deno.test("#514 review: each phrasing is refused by the CURRENT rules for its own reason, on every record, with and without a decimal", async () => {
  const missed: string[] = [];
  let cells = 0;
  const q = essayQ("Tell us about yourself.", "Larkspur Health");
  for (const c of REVIEW_514) {
    for (const r of recordsFor(c.text)) {
      for (const tail of ["", GPA_TAIL]) {
        cells++;
        const tag = `${c.why}: ${JSON.stringify(c.sentence)}${tail} on ${JSON.stringify(r)}`;
        const a = await checkDraft({ q, siblingLabels: [], deps: { facts: () => [...BASE, ...extraFact(r)] }, text: `${c.sentence}${TAIL}${tail}` });
        if (a.ok) missed.push(`checkDraft shown, ${tag}`);
        else if (a.why === "thin") missed.push(`too thin to judge, ${tag}`);
        else if (!a.detail.some((x) => named(c.why).test(x))) missed.push(`checkDraft refused for another reason (${a.detail.join("; ")}), ${tag}`);
        for (const text of [c.text, c.sentence]) {
          if (!claimProblems(text, { record: recordOf(r) }).some((x) => named(c.why).test(x))) missed.push(`claimProblems passed ${JSON.stringify(text)}, ${tag}`);
          if (!claimProblems(text, { record: [r], line: true }).some((x) => named(c.why).test(x))) missed.push(`claimProblems (line) passed ${JSON.stringify(text)}, ${tag}`);
        }
      }
    }
  }
  console.log(`[claims-floor] #514 phrasings: ${REVIEW_514.length} phrasings, ${cells} cells, ${missed.length} missed`);
  assertNode.deepEqual(missed, []);
});
