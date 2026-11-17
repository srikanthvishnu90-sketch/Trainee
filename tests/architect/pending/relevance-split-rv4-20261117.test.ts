// Gap #8 split, review rv4 (2026-11-17; probe rv4-cd/probes/d_go.ts): relevantTo goes through the SAME guard for ambiguous tokens
// (AMBIGUOUS_SKILLS, TECH_CONTEXT) that parseJD uses, so "Go-to-Market", "go live" and "R&D" are no Go or R.
//   CU-2d  an entry that names Go or R only inside go-to-market, go live or R&D is not relevant to a Go / R posting, and goes
//          under Additional Experience; an entry that names them as languages is relevant
//   CU-2e  the one guard: the posting side drops the same phrases; a skills list that names the skill itself still counts
//   deno test -A --no-check tests/architect/pending/relevance-split-rv4-20261117.test.ts
import assertNode from "node:assert/strict";
import { CareerTailor } from "../../../supabase/functions/_shared/router_core.career.js";
import { relevanceSplit, relevantTo } from "../../../supabase/functions/_shared/career_tailor.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const heads = (r: any) => r.sections.map((s: any) => `${s.heading}: ${s.lines.map((l: any) => l.factIds[0]).join(",")}`).join(" || ");
const split = (facts: any[], jd: string) => {
  const resume = { sections: [{ heading: "Experience", lines: facts.map((f) => ({ type: "entry", text: f.text, factIds: [f.id] })) }] };
  const j = CareerTailor.parseJD(jd);
  return { j, rel: [...relevantTo(j, { facts }, facts.map((f) => f.id))].sort(), out: heads(relevanceSplit(resume, j, { facts })) };
};

Deno.test("CU-2d Go-to-Market, go live and R&D are no Go or R: those entries are Additional Experience", () => {
  const g1 = split([
    { id: "gtm", kind: "experience", text: "Elmstead, Go-to-Market Intern (2026): ran go-to-market campaigns and partner outreach." },
    { id: "py", kind: "experience", text: "Pixelforge, Software Intern (2025): built backend services in Python." },
    { id: "cafe", kind: "experience", text: "Cafe Uno, Barista (2024): opened and closed the store." },
    { id: "tutor", kind: "experience", text: "Lakeshore Tutoring, Tutor (2023): tutored calculus." },
  ], "Backend Engineer Intern at Initech\n\nRequirements: Go, Python, PostgreSQL.");
  eq(g1.j.mustHaveSkills.includes("Go"), true, "the posting does ask for Go");
  eq(g1.rel, ["py"], "Go-to-Market is not Go");
  eq(g1.out, "Relevant Experience: py || Additional Experience: gtm,cafe,tutor");
  const g2 = split([
    { id: "sales", kind: "experience", text: "Northwind, Sales Associate (2026): helped customers go live and tracked deals." },
    { id: "rd", kind: "experience", text: "Acme, R&D Assistant (2025): ran lab experiments." },
    { id: "swe", kind: "experience", text: "Pixelforge, Software Intern (2024): wrote services in Go and R." },
    { id: "cafe", kind: "experience", text: "Cafe Uno, Barista (2023)." },
  ], "Data Engineer Intern at Initech\n\nRequirements: Go, R, SQL.");
  eq(g2.rel, ["swe"], "go live is not Go, R&D is not R");
  eq(g2.out, "Relevant Experience: swe || Additional Experience: sales,rd,cafe");
});

Deno.test("CU-2e one guard for both sides: the phrases are no skill in a posting either; a listed skill that is the skill counts", () => {
  for (const t of ["Elmstead, Go-to-Market Intern: ran go-to-market campaigns.", "Helped customers go live.", "Acme, R&D Assistant: ran lab experiments.", "Go-getter wanted for sales."]) {
    eq(CareerTailor.skillsInContext(t).filter((x: string) => x === "Go" || x === "R"), [], t);
  }
  eq(CareerTailor.skillsInContext("Wrote backend services in Go and R."), ["Go", "R"].filter((x) => CareerTailor.skillsInText("Wrote backend services in Go and R.").includes(x)));
  eq(CareerTailor.skillsInContext("Ran lab experiments.", ["Go"]).includes("Go"), true, "a skills list item that is the skill itself");
  eq(CareerTailor.skillsInContext("Ran lab experiments.", ["R&D"]).includes("R"), false, "a skills list item R&D is no R");
  const jd = CareerTailor.parseJD("Growth Intern at Initech\n\nRequirements: experience on a go-to-market team, R&D exposure, Excel.");
  eq([...(jd.mustHaveSkills || []), ...(jd.niceToHaveSkills || [])].filter((x: string) => x === "Go" || x === "R"), [], "the posting side drops them too");
});
