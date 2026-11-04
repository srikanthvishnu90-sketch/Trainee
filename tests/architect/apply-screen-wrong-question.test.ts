// F09 round-3 review: an answer is saved only to the question it answers. Strict per-question parsers; a message that answers
// another question, or contradicts itself ("No, I need sponsorship"), writes NOTHING and the question is re-asked once (D-007).
import assert from "node:assert/strict";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import { parseScreenAnswer, screenAnswerTurn } from "../../supabase/functions/_shared/career_apply_screen_answer.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const held = [{ job_id: "greenhouse:acme:1", company: "Co1", title: "Analyst", url: "https://boards.greenhouse.io/acme/jobs/1" }];

Deno.test("a location question takes only a place", () => {
  for (const m of ["I need sponsorship", "No, I need sponsorship", "I need a visa", "I will need H-1B sponsorship", "yes", "no", "No, I don't", "I'm a US citizen",
    "I have 5 years of experience", "I have a bachelor's degree", "I would not relocate", "open to relocation", "Yes, in Austin"]) {
    assert.equal(parseScreenAnswer("location", m, true), null, `location must not take: ${m}`);
  }
  assert.equal(parseScreenAnswer("location", "Austin, TX", true)?.value, "Austin, TX");
  assert.equal(parseScreenAnswer("location", "I live in Jackson, MS", true)?.value, "Jackson, MS");
  assert.equal(parseScreenAnswer("location", "I'm in Pass Christian, MS", true)?.value, "Pass Christian, MS");
});

Deno.test("sponsorship: a leading no / yes must agree with what follows", () => {
  const v = (m: string, alone = true) => parseScreenAnswer("sponsorship", m, alone)?.value ?? null;
  for (const m of ["No, I need sponsorship", "No I need sponsorship", "no, I will need a visa", "Yes, I don't need sponsorship", "yes, no sponsorship needed",
    "no, but I will need sponsorship later", "I don't need it now but I will need sponsorship later", "No, I'm moving to Texas", "Yes, I live in Austin", "I need a job"]) {
    assert.equal(v(m), null, `ambiguous or off-topic, nothing written: ${m}`);
  }
  // Round 4 (whitelist): only the whole message yes/y/yeah/yep/no/n/nope answers; every phrase that used to be read now writes nothing.
  for (const m of ["No, thanks", "No, I don't", "No, I don't need sponsorship", "No sponsorship needed", "no, no sponsorship needed", "I do not need sponsorship", "I need no sponsorship",
    "without sponsorship", "No need for a visa", "yes please", "yes, I need sponsorship", "I need sponsorship", "I will need a visa", "Yes, I do", "I require H-1B sponsorship"]) {
    assert.equal(v(m), null, `a phrase is not an answer: ${m}`);
  }
  for (const m of ["No", "no.", "Nope", "N"]) assert.equal(v(m), "no", m);
  for (const m of ["Yes", "yes!", "Yeah", "y"]) assert.equal(v(m), "yes", m);
  assert.equal(v("No", false), null, "with several questions open a bare no answers none");
});

Deno.test("turn level: wrong-question answers write nothing, re-ask once, then hold", async () => {
  const run = async (message: string, ask: string[], meta: Record<string, unknown> = {}) => {
    const profile: any = CareerProfile.createProfile({});
    let reruns = 0;
    const r = await screenAnswerTurn({
      message, now: NOW, profile, addFact: (p, f) => CareerProfile.addFact(p, f), rerun: async () => { reruns++; return null; },
      last: { intent: "career_apply_queue", meta: { screen_ask: ask.map((fact) => ({ fact, question: `${fact}?` })), screen_held: held, ...meta } },
    });
    return { r, profile, reruns };
  };
  const cases: [string, string][] = [["I need sponsorship", "location"], ["No, I need sponsorship", "location"], ["No, I need sponsorship", "sponsorship"],
    ["No, I will need sponsorship in a few months though", "sponsorship"], ["Austin, TX", "sponsorship"], ["yes", "location"]];
  for (const [m, f] of cases) {
    const { r, profile, reruns } = await run(m, [f]);
    assert.ok(r, m);
    assert.deepEqual(r!.saved, [], `${f} <- ${m}`);
    assert.equal((profile.facts ?? []).length, 0, `no fact written: ${f} <- ${m}`);
    assert.equal(reruns, 0);
    assert.equal(r!.status, "asking");
    assert.equal((r!.meta as any).screen_reasked, true);
    const again = await run(m, [f], { screen_reasked: true });
    assert.equal(again.r!.status, "held", "asked once, then the postings stay held");
    assert.equal((again.profile.facts ?? []).length, 0);
  }
  const phrase = await run("No, I don't need sponsorship", ["sponsorship"]);
  assert.deepEqual(phrase.r!.saved, [], "a phrase writes nothing");
  assert.equal(phrase.r!.status, "asking");
  const ok = await run("No", ["sponsorship"]);
  assert.deepEqual(ok.r!.saved, [{ fact: "sponsorship", value: "no" }]);
  const ok2 = await run("Austin, TX", ["location"]);
  assert.deepEqual(ok2.r!.saved, [{ fact: "location", value: "Austin, TX" }]);
});
