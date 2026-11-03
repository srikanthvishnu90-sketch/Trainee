// COMPETITIVE-BAR G5 / B2: a tailored resume, cover letter or form answer never adds a skill, employer, title, date or
// number the person did not confirm. Mutation: an injected "Led a team of 12 ..." is refused, at the guard and at the
// tailoring output boundary (tailorForPosting), where nothing is rendered, stored or linked.
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";
import assert, { deepStrictEqual as eq } from "node:assert/strict";
import { CareerProfile, CareerRender, CareerTailor } from "../../supabase/functions/_shared/router_core.career.js";
import { guardFormAnswer, guardMaterials } from "../../supabase/functions/_shared/career_materials_guard.ts";
import { memoryResumeStore, renderWith, tailorForPosting } from "../../supabase/functions/_shared/career_tailor.ts";

const R = (CareerRender as any).withRuntime({ zlib, crypto, Buffer });
const RESUME_TEXT = await Deno.readTextFile(new URL("../../packages/career-data/fixtures/test-resume.txt", import.meta.url));
function profile() {
  const head = RESUME_TEXT.split("\n").map((l) => l.trim()).filter(Boolean);
  const p = CareerProfile.createProfile({ basics: { name: head[1].replace(/\s*\(TEST\)\s*$/, ""), email: /[\w.]+@[\w.]+/.exec(RESUME_TEXT)![0], location: "Chicago, IL" } });
  CareerProfile.ingestResume(p, { text: RESUME_TEXT, fileName: "test-resume.txt" });
  for (const f of p.facts) CareerProfile.confirmFact(p, f.id);
  return p;
}
const POSTING = `Data Analyst, Acme Analytics (TEST posting)\nRequirements:\n- SQL, Python and Tableau\n- Build dashboards\n- Terraform a plus`;
const INJECTED = "Led a team of 12 engineers at Google as Senior Manager since 2015 using Terraform";

Deno.test("guard: the injected line is refused for each invented part; the person's own lines pass", () => {
  const p = profile();
  const real = (CareerProfile.confirmedFacts(p) as any[]).find((f) => f.bullets?.length);
  const ok = guardMaterials([{ text: real.bullets[0], factIds: [real.id] }], p);
  assert(ok.ok, JSON.stringify(ok.refused));
  const bad = guardMaterials([{ text: INJECTED, factIds: [real.id] }], p);
  assert(!bad.ok);
  const why = bad.refused[0].reasons.join(" | ");
  for (const part of ['number "12"', 'name "Google"', 'title "Senior"', 'date "2015"', 'skill "Terraform"', "leadership claim"]) assert(why.includes(part), `missing ${part}: ${why}`);
  // A draft is not a fact: its words never vouch for a line.
  CareerProfile.addFact(p, { kind: "experience", title: "Engineer, Google", text: "Led a team of 12", needs_confirmation: true, status: "draft" });
  assert(!guardMaterials([INJECTED], p).ok);
});

Deno.test("guard: a form answer may not claim years or tools the person did not confirm", () => {
  const p = profile();
  assert(!guardFormAnswer("I have 8 years of Terraform experience.", p, ["3"]).ok);
  assert(guardFormAnswer("I have 3 years of experience.", p, ["3"]).ok);
});

Deno.test("boundary: tailorForPosting refuses a document carrying an injected line; nothing is rendered or stored", async () => {
  const p = profile();
  let rendered = 0;
  const store = memoryResumeStore();
  const render = async (doc: any) => { rendered++; return renderWith(R, "test")(doc); };
  // A defective assembler: the real tailoring, then one bullet with an invented claim, cited to a real fact.
  const tailor = (prof: any, jd: any, opts: any) => {
    const t = CareerTailor.tailorResume(prof, jd, opts);
    const at = t.resume.lines.findIndex((l: any) => l.type === "bullet");
    // Subtle on purpose: the person's own bullet with an invented leadership claim in front. 123's audit lets it through
    // (every other word is on the fact); this guard does not.
    const own = String(t.resume.lines[at].text);
    const line = { ...t.resume.lines[at], text: `Led and ${own.charAt(0).toLowerCase()}${own.slice(1)}` };
    t.resume.lines.splice(at + 1, 0, line);
    for (const s of t.resume.sections || []) { const i = s.lines.findIndex((l: any) => l.text === t.resume.lines[at].text); if (i >= 0) { s.lines.splice(i + 1, 0, line); break; } }
    return t;
  };
  const r = await tailorForPosting({ userId: "u-guard", profile: p, posting: { text: POSTING, company: "Acme" }, deps: { render, resumes: store, tailor }, now: Date.UTC(2026, 9, 28) });
  eq([r.ok, (r as any).refused], [false, "truth_audit"]);
  eq([rendered, store.files.size], [0, 0]);
  // The faithful tailoring still ships.
  const good = await tailorForPosting({ userId: "u-guard", profile: p, posting: { text: POSTING, company: "Acme" }, deps: { render, resumes: store }, now: Date.UTC(2026, 9, 28) });
  assert(good.ok, JSON.stringify(good));
});
