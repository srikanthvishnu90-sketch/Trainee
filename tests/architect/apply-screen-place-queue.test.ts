// F09 round 5: (a) a place is a recognizable place, not "three" or "high school"; (b) the screen asks ONE question at a time
// (no "answer them in one message" the parser would reject), including from older replies that carry several.
import assert from "node:assert/strict";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import { parseScreenAnswer, screenAnswerTurn, screenMeta } from "../../supabase/functions/_shared/career_apply_screen_answer.ts";
import { gateSummary } from "../../supabase/functions/_shared/career_apply_gate.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const loc = (m: string) => parseScreenAnswer("location", m, true)?.value ?? null;

Deno.test("a place must look like a place: number words, schools and generic nouns are not", () => {
  for (const m of ["three", "Three", "twenty", "ten", "one two", "high school", "High School", "college", "bachelor's degree", "masters", "a degree", "the city", "my house", "something", "a place", "job", "42", "3rd", "10001 5", "123 Main", "the", "student", "PhD"]) {
    assert.equal(loc(m), null, `not a place: ${m}`);
  }
  for (const m of ["Austin", "austin", "Austin, TX", "New York City", "San Francisco, CA", "I live in Austin, TX", "Three Rivers, MI", "College Station, TX", "Salt Lake City", "Pass Christian, MS", "remote", "Remote"]) {
    assert.ok(loc(m), `a place: ${m}`);
  }
  assert.equal(loc("remote"), "remote");
  assert.equal(loc("I want remote work"), null, "a preference is not where they live");
});

Deno.test("turn level: 'three' and 'high school' under the location question write nothing and re-ask once", async () => {
  for (const m of ["three", "high school"]) {
    const profile: any = CareerProfile.createProfile({});
    const r = await screenAnswerTurn({ message: m, now: NOW, profile, addFact: (p, f) => CareerProfile.addFact(p, f),
      last: { intent: "career_apply_queue", meta: { screen_ask: [{ fact: "location", question: "Where do you live?" }], screen_held: [] } } });
    assert.ok(r, m);
    assert.deepEqual(r!.saved, []);
    assert.equal((profile.facts ?? []).length, 0);
    assert.equal(r!.status, "asking");
    assert.equal((r!.meta as any).screen_reasked, true);
  }
});

const ASKS = [{ fact: "location", question: "Where do you live?", keys: [] }, { fact: "sponsorship", question: "Will you need visa sponsorship?", keys: [] }, { fact: "citizenship", question: "Are you a US citizen?", keys: [] }];
const HELD = [{ job_id: "a", company: "Co", title: "T", url: "https://x.example/a", facts: ["location", "sponsorship", "citizenship"] }];

Deno.test("the screen puts ONE question to the person at a time: the reply text, the meta and the buttons", () => {
  const gate: any = { ok: [], dropped: [], held: HELD, asks: ASKS, counts: { total: 1, ok: 0, dropped: 0, held: 1, by_kind: {} } };
  const meta = screenMeta(gate)!;
  assert.deepEqual((meta.screen_ask as any[]).map((a) => a.fact), ["location"]);
  assert.equal((meta.screen_held as any[]).length, 1, "every held posting still waits");
  const text = gateSummary(gate);
  assert.ok(text.includes("Where do you live?"));
  assert.ok(!text.includes("visa sponsorship") && !text.includes("US citizen"), text);
  const yn = screenMeta({ ...gate, asks: ASKS.slice(1) })!;
  assert.deepEqual((yn.screen_ask as any[]).map((a) => a.fact), ["sponsorship"]);
  assert.deepEqual(yn.screen_buttons, ["Yes", "No"]);
});

Deno.test("an older reply with several questions open: a bare yes / no is answered by asking the first, never by 'answer them in one message'", async () => {
  for (const m of ["yes", "no", "idk"]) {
    const profile: any = CareerProfile.createProfile({});
    const r = await screenAnswerTurn({ message: m, now: NOW, profile, addFact: (p, f) => CareerProfile.addFact(p, f),
      last: { intent: "career_apply_queue", meta: { screen_ask: ASKS.slice(1).map((a) => ({ fact: a.fact, question: a.question })), screen_held: [] } } });
    assert.ok(r, m);
    assert.deepEqual(r!.saved, []);
    assert.equal((profile.facts ?? []).length, 0);
    assert.ok(r!.reply.includes("Will you need visa sponsorship?"), r!.reply);
    assert.ok(!/one message|for example/i.test(r!.reply), r!.reply);
    assert.ok(!r!.reply.includes("US citizen"), "only the first question is put");
    assert.deepEqual((r!.meta as any).screen_ask.map((a: any) => a.fact), ["sponsorship"]);
    assert.deepEqual((r!.meta as any).screen_buttons, ["Yes", "No"]);
  }
  // and the one question asked is answerable by exactly yes / no
  const profile: any = CareerProfile.createProfile({});
  const first = await screenAnswerTurn({ message: "yes", now: NOW, profile, addFact: (p, f) => CareerProfile.addFact(p, f),
    last: { intent: "career_apply_queue", meta: { screen_ask: ASKS.slice(1).map((a) => ({ fact: a.fact, question: a.question })), screen_held: [] } } });
  const next = await screenAnswerTurn({ message: "yes", now: NOW, profile, addFact: (p, f) => CareerProfile.addFact(p, f), last: { intent: "career_apply_queue", meta: first!.meta as any } });
  assert.deepEqual(next!.saved, [{ fact: "sponsorship", value: "yes" }]);
});
