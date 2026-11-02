// D-007 at every drafter: the 47 agent-invented "confirmed" facts (the owner's answer-all delegation, bank ids
// F-027..F-079) never feed anything Trainee writes for a person — the card's essay, the tailored resume, the cover letter,
// the cold email. One shared reader decides (CareerProfile.quarantinedFact); each drafter is proven through its own entry
// point with a fake model that records what it was given. A chat profile's own F-027..F-079 (every profile numbers its own
// facts) stays readable. Synthetic values; no real data. No network, no model.
import { CareerProfile, CareerTailor } from "../../supabase/functions/_shared/router_core.career.js";
import { confirmedFacts as essayFacts, draftEssay } from "../../supabase/functions/_shared/essay_draft.ts";
import { confirmed as outreachFacts, draftFor } from "../../supabase/functions/_shared/career_outreach.ts";
import { baseResume, confirmedOnly } from "../../supabase/functions/_shared/career_tailor.ts";

function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}
const MARK = "ZEBRA-INVENTED";
const clean = [
  { id: "F-001", kind: "experience", title: "TEST Analyst", org: "TEST Corp", text: "TEST Analyst at TEST Corp building Python data pipelines", skills: ["Python"], status: "confirmed", needs_confirmation: false },
  { id: "F-002", kind: "education", title: "BS Computer Science", org: "TEST University", text: "BS Computer Science at TEST University, Python and SQL coursework", status: "confirmed", needs_confirmation: false },
  // A chat profile numbers its own facts: this F-033 is the person's own, not the owner's bank's.
  { id: "F-033", kind: "project", title: "TEST Tracker", text: "Built TEST Tracker, a Python app for study groups", skills: ["Python"], status: "confirmed", needs_confirmation: false },
];
const invented = [
  { id: "F-090", kind: "experience", title: `${MARK} Lead`, org: "Delegated Co", text: `${MARK} led Python platform at Delegated Co`, status: "confirmed", needs_confirmation: false, provenance: "owner-delegated 2026-10-17 (answer-all directive)" },
  { factId: "F-041", id: "F-091", kind: "project", title: `${MARK} Project`, text: `${MARK} Python project from the bank`, status: "confirmed", needs_confirmation: false },
  { id: "F-092", kind: "experience", title: `${MARK} Quarantined`, text: `${MARK} Python work flagged`, status: "confirmed", needs_confirmation: false, quarantine: "d007-v1" },
];
const all = [...clean, ...invented];
const profile = () => CareerProfile.createProfile({ id: "TEST-P", basics: { name: "TEST Person", email: "test@example.test" }, facts: structuredClone(all) });
const sawMark = (x: unknown) => JSON.stringify(x ?? null).includes(MARK);

Deno.test("D-007 drafters: one shared reader quarantines by provenance, flag, or the bank's own id field — not a chat profile's own ids", () => {
  const q = (CareerProfile as any).quarantinedFact;
  assert(typeof q === "function", "CareerProfile.quarantinedFact is the shared reader");
  for (const f of invented) assert(q(f), `quarantined: ${JSON.stringify(f)}`);
  for (const f of clean) assert(!q(f), `a chat profile's own fact stays: ${f.id}`);
  assert(!q({ fact_id: "P1-F-040", text: "persona fact" }) && !q({ id: "F-050", text: "chat fact" }));
  const kept = CareerProfile.confirmedFacts(profile()).map((f: any) => f.id).sort().join(",");
  assert(kept === "F-001,F-002,F-033", `confirmedFacts keeps only the person's own: ${kept}`);
});

Deno.test("D-007 drafters: the essay on the card is never given a quarantined fact", async () => {
  assert(!sawMark(essayFacts(all)), "essay_draft.confirmedFacts drops them");
  const given: unknown[] = [];
  await draftEssay({
    q: { id: "q1", label: "Describe a Python project you built", type: "textarea", kind: "essay", company: "TEST Co", job_ids: ["j1"] },
    siblingLabels: [],
    deps: { facts: async () => structuredClone(all), model: async (p: unknown) => { given.push(p); return { text: "TEST draft about TEST Tracker in Python." }; } } as any,
  });
  assert(given.length > 0, "the fake model was asked (enough clean facts)");
  assert(!sawMark(given), "no quarantined fact reached the essay model");
});

Deno.test("D-007 drafters: the cold email is never given a quarantined fact", async () => {
  assert(!sawMark(outreachFacts(all)), "career_outreach.confirmed drops them");
  const given: unknown[] = [];
  await draftFor({
    model: async (p: unknown) => { given.push(p); return { text: "Subject: TEST\n\nTEST body about Python at TEST Corp." }; },
    facts: structuredClone(all),
    // PERSONALIZED OUTREACH (2026-10-31): a first email is written only with something sourced about the recipient (with a
    // title and firm alone the person is asked one question instead, and no model is called), so the recipient carries one.
    r: { name: "TEST Recipient", firm: "TEST Firm", title: "Analyst", school: "", email: "r@example.test", source: "TEST",
      facts: [{ id: "t1", kind: "work", work_kind: "talk", text: "Gave the TEST talk on Python tooling", anchor: "the TEST talk on Python tooling", source_kind: "talk", retrieved_at: "2026-10-20T00:00:00Z" }] },
  });
  assert(given.length > 0, "the fake model was asked");
  assert(!sawMark(given), "no quarantined fact reached the outreach model");
});

Deno.test("D-007 drafters: the tailored resume is built without a quarantined fact", () => {
  const only = confirmedOnly(profile());
  assert(!sawMark(only.facts), "confirmedOnly drops them");
  assert(!sawMark(baseResume(profile())), "the base resume carries none of them");
});

Deno.test("D-007 drafters: the cover letter is written without a quarantined fact", () => {
  // The letter proves fit with the facts selectFacts picks; the invented facts match this posting best (Python, platform,
  // pipelines), so they are what it would pick if it could read them. The outline (AI-banned employers) reads the same.
  const T = CareerTailor as any, jd = T.parseJD("We want a Python platform lead with data pipeline experience.");
  const picked = T.selectFacts(profile(), jd, { limit: 3 });
  assert(picked.length > 0, "the person's own facts are still selected");
  assert(!sawMark(picked), `selected: ${JSON.stringify(picked.map((s: any) => s.fact.id))}`);
  const cir = { company: "TEST Co", facts: [{ text: "TEST Co builds Python tools for schools", source: "TEST posting" }] };
  assert(!sawMark(T.generateCoverLetter(profile(), jd, cir, { role: "Analyst" })), "letter");
  assert(!sawMark(T.generateCoverLetter(profile(), jd, { ...cir, aiPolicy: "ban" }, { role: "Analyst" })), "outline");
});
