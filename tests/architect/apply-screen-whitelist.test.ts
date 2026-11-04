// F09 round 4 (D-007): every screen question x one shared adversarial list. A yes/no question accepts ONLY the whole message
// yes / y / yeah / yep / no / n / nope (punctuation and case ignored); anything else writes NOTHING and re-asks once with
// "Reply yes or no". Free text only for the place and for "N years". One table-driven parser, so no question is unguarded.
import assert from "node:assert/strict";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import { isYesNoFact, parseScreenAnswer, screenAnswerTurn } from "../../supabase/functions/_shared/career_apply_screen_answer.ts";
import type { ScreenFactKey } from "../../supabase/functions/_shared/career_apply_screen.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const held = [{ job_id: "greenhouse:acme:1", company: "Co1", title: "Analyst", url: "https://boards.greenhouse.io/acme/jobs/1" }];
const FACTS: ScreenFactKey[] = ["sponsorship", "citizenship", "relocation", "location", "years_experience", "education_level"];

const ADVERSARIAL = [
  "I need sponsorship", "I don't need sponsorship", "I do not need sponsorship", "yes I need sponsorship", "No, I need sponsorship", "No I need sponsorship",
  "no, I don't need sponsorship", "Yes, I don't need sponsorship", "I will need sponsorship later", "I need a visa", "I need H-1B sponsorship",
  "US citizen", "I am a US citizen", "I'm a US citizen", "Not a US citizen", "I'm not American", "I'm not a citizen of India", "green card holder",
  "I would not relocate", "I'd rather not relocate", "Not open to relocating", "open to relocating", "happy to relocate", "can't relocate",
  "idk", "I don't know", "maybe", "skip", "Austin", "Austin, TX", "I live in Austin", "3 years", "I have a bachelor's degree",
  "yes please", "No, thanks", "not really", "yes!!! sure", "Y N", "yes no", "yesss", "nope nope", "sure", "ok", "1", "banana", "", "   ",
];
// What each question may accept from the shared list (the right question's own answer); everything else must write nothing.
const OWN: Record<ScreenFactKey, string[]> = {
  sponsorship: [], citizenship: [], relocation: [],
  location: ["Austin", "Austin, TX", "I live in Austin", "banana"], // no gazetteer: any place-shaped word is a place
  years_experience: ["3 years"], education_level: ["I have a bachelor's degree"],
};
const EXACT_YES = ["yes", "Yes", "YES", "y", "Y", "yeah", "Yeah.", "yep", "yes.", " yes ", "Yes!"];
const EXACT_NO = ["no", "No", "NO", "n", "N", "nope", "Nope!", "no.", " no "];

Deno.test("every question x the adversarial list: only its own answer parses", () => {
  for (const fact of FACTS) for (const m of ADVERSARIAL) {
    const got = parseScreenAnswer(fact, m, true);
    if (OWN[fact].includes(m)) assert.ok(got, `${fact} must take its own answer: ${m}`);
    else assert.equal(got, null, `${fact} must write nothing for: ${JSON.stringify(m)} (got ${JSON.stringify(got)})`);
  }
});

Deno.test("yes/no questions take exactly yes or no and write the matching fact; with several questions open a bare yes/no answers none", () => {
  const out = { sponsorship: ["yes", "no"], citizenship: ["yes", "no"], relocation: ["yes", "no"] } as const;
  for (const fact of FACTS.filter(isYesNoFact)) {
    for (const m of EXACT_YES) assert.equal(parseScreenAnswer(fact, m, true)?.value, out[fact as keyof typeof out][0], `${fact}: ${m}`);
    for (const m of EXACT_NO) assert.equal(parseScreenAnswer(fact, m, true)?.value, out[fact as keyof typeof out][1], `${fact}: ${m}`);
    assert.equal(parseScreenAnswer(fact, "yes", false), null);
    assert.equal(parseScreenAnswer(fact, "no", false), null);
  }
  assert.deepEqual(FACTS.filter(isYesNoFact).sort(), ["citizenship", "relocation", "sponsorship"], "the table marks every yes/no question");
  for (const fact of ["location", "years_experience", "education_level"] as const) {
    for (const m of [...EXACT_YES, ...EXACT_NO]) assert.equal(parseScreenAnswer(fact, m, true), null, `${fact} is not a yes/no question: ${m}`);
  }
});

Deno.test("free-text questions: a place is a place, years are 'N years' only", () => {
  for (const m of ["Austin, TX", "I live in Jackson, MS", "I'm in Pass Christian, MS"]) assert.ok(parseScreenAnswer("location", m, true), m);
  for (const m of ["yes", "no", "visa", "US citizen", "citizen of Canada", "I need sponsorship", "sponsorship", "relocation", "Mars", "nowhere"]) assert.equal(parseScreenAnswer("location", m, true), null, m);
  assert.equal(parseScreenAnswer("years_experience", "4 years", true)?.value, 4);
  assert.equal(parseScreenAnswer("years_experience", "about 4 years", true)?.value, 4);
  for (const m of ["4", "four", "a few", "lots", "yes", "I need sponsorship", "4 years of sponsorship", "I live in Austin, 4 years", "2020"]) assert.equal(parseScreenAnswer("years_experience", m, true), null, m);
});

async function turn(message: string, ask: ScreenFactKey[], meta: Record<string, unknown> = {}) {
  const profile: any = CareerProfile.createProfile({});
  let reruns = 0;
  const r = await screenAnswerTurn({
    message, now: NOW, profile, addFact: (p, f) => CareerProfile.addFact(p, f), rerun: async () => { reruns++; return null; },
    last: { intent: "career_apply_queue", meta: { screen_ask: ask.map((fact) => ({ fact, question: `${fact}?` })), screen_held: held, ...meta } },
  });
  return { r, profile, reruns };
}

Deno.test("turn level, every question x the list: nothing is written for the wrong question; asked again once, then held", async () => {
  for (const fact of FACTS) for (const m of ADVERSARIAL) {
    if (OWN[fact].includes(m)) continue;
    const { r, profile, reruns } = await turn(m, [fact]);
    assert.ok(r, `${fact}: ${JSON.stringify(m)}`);
    assert.deepEqual(r!.saved, [], `${fact}: ${JSON.stringify(m)}`);
    assert.equal((profile.facts ?? []).length, 0, `no fact written: ${fact} <- ${JSON.stringify(m)}`);
    assert.equal(reruns, 0);
    assert.equal(r!.status, "asking");
    assert.equal((r!.meta as any).screen_reasked, true);
    if (isYesNoFact(fact)) {
      assert.match(r!.reply, /Reply yes or no/);
      assert.deepEqual((r!.meta as any).screen_buttons, ["Yes", "No"]);
    }
    const again = await turn(m, [fact], { screen_reasked: true });
    assert.equal(again.r!.status, "held");
    assert.equal((again.profile.facts ?? []).length, 0);
  }
});

Deno.test("turn level: exact yes / no and the free-text answers are written for the right question", async () => {
  for (const [fact, m, value] of [["sponsorship", "Yes", "yes"], ["sponsorship", "no.", "no"], ["citizenship", "yep", "yes"], ["citizenship", "N", "no"], ["relocation", "yeah", "yes"], ["relocation", "Nope", "no"],
    ["location", "Austin, TX", "Austin, TX"], ["years_experience", "3 years", 3]] as const) {
    const { r, profile } = await turn(m, [fact]);
    assert.deepEqual(r!.saved, [{ fact, value }], `${fact} <- ${m}`);
    assert.equal(profile.facts.filter((f: any) => f.screen_key === fact).length, 1);
  }
  // several open: a bare yes answers none of them and says so
  const many = await turn("yes", ["sponsorship", "citizenship"]);
  assert.deepEqual(many.r!.saved, []);
  assert.equal(many.r!.status, "which");
  assert.equal((many.profile.facts ?? []).length, 0);
});
