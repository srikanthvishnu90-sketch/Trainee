// F09 review fix: the screen reads the facts the product REALLY holds. Profile facts are { kind, text } (the profile builder,
// packages/domain/122-career-profile.js, normalizeFact: no `value`, no `key`); the router's stated facts are { kind, value }.
// These tests build facts with CareerProfile itself (addFact / ingestResume / confirmFact / confirmedFacts), never a hand-written
// { key, value } fixture, and then walk the question -> answer -> saved fact -> screen loop.
import assert from "node:assert/strict";
import { CareerProfile } from "../../supabase/functions/_shared/router_core.career.js";
import { applyManyTurn, type ShortlistEntry } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../supabase/functions/_shared/career_apply_want.ts";
import { chatScreenFacts, gatePicks, screenFactsFrom } from "../../supabase/functions/_shared/career_apply_gate.ts";
import { parseScreenAnswer, saveScreenFact, screenAnswerTurn, screenMeta } from "../../supabase/functions/_shared/career_apply_screen_answer.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const day = (n: number) => new Date(NOW - n * 86400000).toISOString();
const rec = (n: number, extra: Record<string, unknown> = {}) => ({
  job_id: `greenhouse:acme:${n}`, company: `Co${n}`, title: "Analyst", location: "Austin, TX", url: `https://boards.greenhouse.io/acme/jobs/${n}`,
  description: "SQL and Python. This is an in-office role.", posted_at: day(3), closed_at: null, ...extra,
});

// What the agent's add_profile_fact does: a draft in the person's words, then confirmed on their yes.
function profileWith(words: [kind: string, text: string][], draft: [string, string][] = []) {
  const p = CareerProfile.createProfile({});
  for (const [kind, text] of words) { const f = CareerProfile.addFact(p, { kind, text, needs_confirmation: true, status: "draft" }); CareerProfile.confirmFact(p, f.id); }
  for (const [kind, text] of draft) CareerProfile.addFact(p, { kind, text, needs_confirmation: true, status: "draft" });
  return p;
}
const screenOf = (p: any, stated: any[] = []) => screenFactsFrom(chatScreenFacts(CareerProfile.confirmedFacts(p), stated));

Deno.test("real profile facts: a confirmed location, sponsorship, relocation, degree and years map into the screen", () => {
  const p = profileWith([
    ["location", "I live in Austin, TX"], ["eligibility", "I do not need visa sponsorship"], ["eligibility", "I am a US citizen"],
    ["preference", "I'm not open to relocating"], ["education", "B.S. Computer Science, UT Austin, 2022"],
    ["profile", "3 years of professional experience in analytics"], ["skill", "SQL"],
  ]);
  assert.equal(p.facts[0].value, undefined, "a real profile fact has no value");
  const f = screenOf(p);
  assert.equal(f.location?.value, "Austin, TX");
  assert.equal(f.sponsorship?.value, "no");
  assert.equal(f.citizenship?.value, "yes");
  assert.equal(f.relocation?.value, "no");
  assert.equal(f.education_level?.value, "bachelor");
  assert.equal(f.years_experience?.value, "3");
  assert.deepEqual(f.skills?.value, ["SQL"]);
});

Deno.test("real profile facts: drafts, wants and other people's words are no facts", () => {
  const p = profileWith([["location", "Looking for roles in Denver"], ["goal", "Senior data analyst in Seattle"], ["eligibility", "My wife is a US citizen"]],
    [["location", "I live in Boston"], ["education", "PhD in physics"]]);
  const f = screenOf(p);
  assert.equal(f.location, undefined);
  assert.equal(f.citizenship, undefined);
  assert.equal(f.education_level, undefined);
  const q = profileWith([["education", "MBA, expected 2027"], ["education", "B.A. History, 2019"]]);
  assert.equal(screenOf(q).education_level?.value, "bachelor");
});

Deno.test("a resume ingested and confirmed reads as education and skills; its job dates are not added up into years", () => {
  const p = CareerProfile.createProfile({});
  const r = CareerProfile.ingestResume(p, { text: "Experience\n- Data Analyst at Acme, 2020 - 2024\nEducation\n- M.S. Statistics, UT Austin, 2020\nSkills\n- SQL\n- Python", fileName: "r.txt", mimeType: "text/plain" }, { now: new Date(NOW).toISOString() });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(Object.keys(screenOf(p)), [], "unconfirmed drafts read as nothing");
  for (const id of r.added_fact_ids) CareerProfile.confirmFact(p, id);
  const f = screenOf(p);
  assert.equal(f.education_level?.value, "master");
  assert.ok((f.skills?.value as string[]).includes("SQL"));
  assert.equal(f.years_experience, undefined);
});

Deno.test("stated facts from the router (geography, sponsorship, citizenship) read too", () => {
  const f = screenOf(CareerProfile.createProfile({}), [{ kind: "geography", value: "Austin, TX", evidence: "I'm in Austin, TX" }, { kind: "sponsorship", value: "no" }, { kind: "name", value: "Sam" }]);
  assert.equal(f.location?.value, "Austin, TX");
  assert.equal(f.sponsorship?.value, "no");
  assert.equal(Object.keys(f).length, 2);
});

Deno.test("production path: a confirmed location is no longer ignored, so an in-person posting there is not held", () => {
  const p = profileWith([["location", "I live in Austin, TX"], ["eligibility", "I am a US citizen"]]);
  const g = gatePicks([{ ...rec(1), content: rec(1) } as any], { facts: chatScreenFacts(CareerProfile.confirmedFacts(p)), now: NOW });
  assert.equal(g.ok.length, 1, JSON.stringify(g.held));
  assert.equal(g.asks.length, 0);
  // Owner ruling (round 6): no confirmed location is NOT a reason to hold or ask. The posting proceeds, labeled "not checked".
  const none = gatePicks([{ ...rec(1), content: rec(1) } as any], { facts: [], now: NOW });
  assert.equal(none.ok.length, 1);
  assert.equal(none.held.length, 0);
  assert.equal(none.asks.length, 0);
  assert.deepEqual(none.unchecked.map((u) => u.facts), [["location"]]);
});

const asked = (fact: string) => ({ intent: "career_apply_queue", meta: { screen_ask: [{ fact, question: "q" }], screen_held: [] } });

Deno.test("answers parse only when they answer: commands, questions and chatter are left alone", () => {
  assert.deepEqual(parseScreenAnswer("location", "I live in Austin, TX", true)?.value, "Austin, TX");
  assert.deepEqual(parseScreenAnswer("location", "Austin, TX", true)?.value, "Austin, TX");
  assert.equal(parseScreenAnswer("location", "apply to the top 3 instead", true), null);
  assert.equal(parseScreenAnswer("location", "what jobs are in Austin?", true), null);
  assert.equal(parseScreenAnswer("location", "thanks", true), null);
  assert.equal(parseScreenAnswer("sponsorship", "yes", true)?.value, "yes");
  assert.equal(parseScreenAnswer("sponsorship", "no, I don't need sponsorship", true), null, "a phrase is not a no (round 4: exact yes/no only)");
  assert.equal(parseScreenAnswer("sponsorship", "No.", true)?.value, "no");
  assert.equal(parseScreenAnswer("sponsorship", "banana", true), null);
  assert.equal(parseScreenAnswer("years_experience", "about 4 years", true)?.value, 4);
  assert.equal(parseScreenAnswer("years_experience", "I live in Austin", true), null);
  assert.equal(parseScreenAnswer("education_level", "master's degree", true)?.value, "master");
  assert.equal(parseScreenAnswer("citizenship", "no", true)?.value, "no");
  assert.equal(parseScreenAnswer("relocation", "no", true)?.value, "no");
});

Deno.test("question -> answer -> saved confirmed fact -> the screen reads it and the held posting is queued", async () => {
  // Round 6: the only question the screen asks is relocation, and only when a CONFIRMED home exists, the posting is in person somewhere else
  // and the person has not said whether they would move. Unknown location / sponsorship / etc. never hold.
  const profile: any = CareerProfile.createProfile({});
  const wants = memoryWantStore();
  const RECS = { a: rec(1), b: rec(2, { description: "We do not provide visa sponsorship. In-office." }) };
  const turn = (message: string, facts: any[], shortlist: ShortlistEntry[]) => applyManyTurn({
    message, userId: "u1", now: NOW, wants, apps: async () => [], facts, shortlist, postings: { search: async () => [] },
    posting: async (id) => Object.values(RECS).find((r) => r.job_id === id) ?? null,
  });
  const list = Object.values(RECS).map((r) => ({ id: r.job_id, title: r.title, company: r.company, location: r.location, url: r.url }));
  const addFact = (p: any, f: any) => CareerProfile.addFact(p, f);
  // 0. Nothing confirmed at all: both proceed (and are queued), nothing is asked.
  const r0 = await turn("apply to all of them", chatScreenFacts(CareerProfile.confirmedFacts(profile)), list);
  assert.equal(r0!.screen!.counts.held, 0, r0!.reply);
  assert.equal(r0!.screen!.asks.length, 0);
  assert.equal(wants.dump().u1?.length, 2, "unknown facts never hold a posting");
  wants.dump(); // (the store is per test; use a fresh one for the held path)
  const wants2 = memoryWantStore();
  const turn2 = (message: string, facts: any[], shortlist: ShortlistEntry[]) => applyManyTurn({
    message, userId: "u1", now: NOW, wants: wants2, apps: async () => [], facts, shortlist, postings: { search: async () => [] },
    posting: async (id) => Object.values(RECS).find((r) => r.job_id === id) ?? null,
  });
  // 1. A confirmed home in another city and a confirmed "I need sponsorship": b is knocked out at once ("we do not provide sponsorship");
  //    a is in person in Austin, relocation unknown: held, with ONE question.
  saveScreenFact(profile, addFact, "location", { value: "Chicago, IL", text: "Lives in Chicago, IL" }, "Chicago, IL", new Date(NOW).toISOString());
  saveScreenFact(profile, addFact, "sponsorship", { value: "yes", text: "Needs visa sponsorship" }, "yes", new Date(NOW).toISOString());
  const r1 = await turn2("apply to all of them", chatScreenFacts(CareerProfile.confirmedFacts(profile)), list);
  assert.equal(r1!.screen!.counts.held, 1, r1!.reply);
  assert.equal(r1!.screen!.dropped.length, 1);
  const meta = screenMeta(r1!.screen)!;
  assert.deepEqual((meta.screen_ask as any[]).map((a) => a.fact), ["relocation"]);
  assert.equal((meta.screen_ask as any[])[0].question, "Would you relocate for this role? Reply yes or no.");
  assert.deepEqual(meta.screen_buttons, ["Yes", "No"]);
  assert.deepEqual(wants2.dump().u1 ?? [], []);
  // 2. A sentence is not an answer: nothing is written, asked again once. An exact "yes" is: a confirmed profile fact in the real shape.
  const rerun = (held: any[]) => turn2("apply to all of them", chatScreenFacts(CareerProfile.confirmedFacts(profile)), held.map((h) => ({ id: h.job_id, title: h.title, company: h.company, location: "", url: h.url })));
  const sentence = await screenAnswerTurn({ message: "I would move for this role", now: NOW, last: { intent: "career_apply_queue", meta }, profile, addFact, rerun });
  assert.deepEqual(sentence!.saved, []);
  assert.equal(CareerProfile.confirmedFacts(profile).filter((f: any) => f.screen_key === "relocation").length, 0);
  const a = await screenAnswerTurn({ message: "yes", now: NOW, last: { intent: "career_apply_queue", meta: sentence!.meta as any }, profile, addFact, rerun });
  assert.ok(a, "the answer is taken");
  assert.deepEqual(a!.saved, [{ fact: "relocation", value: "yes" }]);
  const kept = CareerProfile.confirmedFacts(profile).filter((f: any) => f.screen_key === "relocation");
  assert.equal(kept.length, 1);
  assert.ok(kept.every((f: any) => f.status === "confirmed" && f.needs_confirmation === false && f.source === "screen_answer" && f.evidence[0].includes("yes")));
  // 3. The screen reads it now: posting a is queued, nothing is asked again.
  assert.equal(wants2.dump().u1?.length, 1, a!.reply);
  assert.match(a!.reply, /Saved \(/);
  assert.equal(screenMeta((a as any).screen), null);
  // 4. And a later turn, from the profile alone, no longer asks.
  const f = screenOf(profile);
  assert.equal(f.location?.value, "Chicago, IL");
  assert.equal(f.sponsorship?.value, "yes");
  // 5. A correction replaces the earlier answer rather than adding a second one.
  saveScreenFact(profile, addFact, "location", { value: "Denver, CO", text: "Lives in Denver, CO" }, "Denver, CO", new Date(NOW).toISOString());
  assert.equal(screenOf(profile).location?.value, "Denver, CO");
  assert.equal(profile.facts.filter((x: any) => x.screen_key === "location").length, 1);
});

Deno.test("a message that does not answer saves nothing and falls through; a bare yes with several questions open asks which", async () => {
  const profile: any = CareerProfile.createProfile({});
  const dep = (message: string, ask: string[]) => screenAnswerTurn({ message, now: NOW, profile, addFact: (p, f) => CareerProfile.addFact(p, f),
    last: { intent: "career_apply_queue", meta: { screen_ask: ask.map((fact) => ({ fact, question: `${fact}?` })), screen_held: [] } } });
  assert.equal(await dep("apply to the top 3", ["location"]), null);
  assert.equal(await dep("what is the weather", ["sponsorship"]), null);
  assert.equal(profile.facts.length, 0);
  const w = await dep("yes", ["location", "sponsorship"]);
  assert.equal(w!.status, "which");
  assert.equal(profile.facts.length, 0);
  assert.equal(await screenAnswerTurn({ message: "Austin", now: NOW, profile, addFact: (p, f) => CareerProfile.addFact(p, f), last: { intent: null, meta: {} } }), null);
});
