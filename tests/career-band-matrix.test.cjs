// MUSE-F-006 (audit 2026-10-22): the bot said its list held no data roles while 48 carried its own Data/ML stamp. Two
// causes, both fixed here:
//   1. the band classifier (121 seniorityBand) matched band words as exact surface tokens, so "internships",
//      "entry-level" and "early careers" bound nothing and fell to "mid". The DISCO-QUALITY phrase matrix (583cc918,
//      repro-band-matrix.cjs) was 15/30. It is the permanent guard here, plus regression cells: precedence, and words
//      that only look like band words.
//   2. the family-ask empty answer said "none of them are <family> roles" even when the list held them and another
//      filter (the level, the place, the profile's hard filters) emptied the answer. It now says which, with counts.
//      A true zero still says none.
// On the base (348c2d4a): matrix 15/30, and the wrong zero.
// Synthetic postings, TEST profile. Check: node --test tests/career-band-matrix.test.cjs
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const D = (n) => require(path.join(root, "packages/domain", n));
const Jobs = D("121-career-jobs.js");
const { CareerHost } = require(path.join(root, "supabase/functions/_shared/career_host.js"));

test("F-006/1 the 30-cell band matrix binds every cell (583cc918's repro, verbatim cells)", () => {
  const FAMILIES = ["software engineering", "data analyst", "financial analyst"];
  const PHRASES = [["intern", "intern"], ["internship", "intern"], ["internships", "intern"], ["entry level", "new_grad"], ["entry-level", "new_grad"], ["early career", "new_grad"], ["early careers", "new_grad"]];
  const TITLES = [["Software Engineering Intern", "intern"], ["Software Engineering Internship", "intern"], ["Software Engineering Internships", "intern"], ["Data Analyst Internships", "intern"],
    ["Finance Internships, Summer 2027", "intern"], ["Entry-Level Software Engineer", "new_grad"], ["Early Careers — Data Analyst", "new_grad"]];
  const cells = [];
  for (const f of FAMILIES) for (const [p, want] of PHRASES) cells.push([`${f} ${p} roles`, "", want]);
  for (const [t, want] of TITLES) cells.push([t, "", want]);
  for (const [p, want] of [["an intern", "intern"], ["internships", "intern"]]) cells.push(["Analyst", `We are hiring ${p} for the team. Responsibilities follow.`, want]);
  assert.equal(cells.length, 30);
  const wrong = cells.filter(([t, j, want]) => Jobs.seniorityBand(t, j) !== want).map(([t, j, want]) => `${t} | ${j.slice(0, 30)} -> ${Jobs.seniorityBand(t, j)} (want ${want})`);
  assert.deepEqual(wrong, [], `${30 - wrong.length}/30 bind`);
});

test("F-006/2 the class, not the word: other plurals and hyphen forms bind; precedence and look-alikes are unchanged", () => {
  const cells = [
    ["Co-op Software Engineer", "intern"], ["Engineering Co-ops 2027", "intern"], ["Interns — Data Team", "intern"], ["Graduate Programs 2027: Analyst", "new_grad"],
    ["New Grads, Software Engineer", "new_grad"], ["Summer Analyst", "intern"], ["Summer Analyst Program Manager", "manager"], ["Internal Auditor", "mid"],
    ["International Sales Manager", "manager"], ["Senior Data Analyst", "senior"], ["Staff Engineer", "staff"], ["Director, Early Careers Recruiting", "director"],
    ["Associate", "junior"], ["Software Engineer", "mid"], ["Vice-President, Banking", "director"],
  ];
  const wrong = cells.filter(([t, want]) => Jobs.seniorityBand(t, "") !== want).map(([t, want]) => `${t} -> ${Jobs.seniorityBand(t, "")} (want ${want})`);
  assert.deepEqual(wrong, []);
});

const host = CareerHost.createCareerHost({ CareerAccess: D("120-career-access.js"), CareerOnboarding: D("130-career-onboarding.js"), CareerRouter: D("142-career-router.js"),
  CareerDoorstep: D("141-career-doorstep.js"), CareerReply: D("140-career-reply.js"), CareerContainment: D("143-career-containment.js") });
const profile = () => D("122-career-profile.js").profileFromData(JSON.parse(fs.readFileSync(path.join(root, "packages/career-data/fixtures/gauntlet/profiles/p1-early-career-swe/profile.json"), "utf8")));
const ask = (message, postings) => host.runTurn(message, host.createTurnCtx({ userId: "u-f006", threadId: "t-f006", now: Date.parse("2026-10-22T15:00:00Z"), profile: profile(), postings }));
const DATA_MID = [1, 2, 3].map((n) => ({ id: `d${n}`, title: "Data Analyst", company: `Datum Synthetic ${n}`, location: "Chicago, IL", remote_terms: "hybrid", requirements: ["SQL", "Python"] }));
const SWE = { id: "s1", title: "Software Engineer", company: "Swe Synthetic", location: "Chicago, IL", remote_terms: "hybrid", requirements: ["Python"] };

test("F-006/3 no wrong zero: the list holds the asked family, the level emptied the answer, and the reply says exactly that", () => {
  const out = ask("find me data analyst internships", [...DATA_MID, SWE]);
  assert.doesNotMatch(out.reply, /none of them are data and machine learning roles/, `the wrong zero: ${out.reply}`);
  assert.match(out.reply, /holds 3 data and machine learning roles \(of 4 scored\)/, out.reply);
  assert.match(out.reply, /3 are not internships/, out.reply);
  assert.equal(((out.result && out.result.shortlist) || []).length, 0, "no cross-family padding: the software role is not served");
  assert.deepEqual(out.result && out.result.family_counts && [out.result.family_counts.onList, out.result.family_counts.band], [3, 3]);
});

test("F-006/4 a true zero still says none; a plural-titled internship is served as one", () => {
  const none = ask("find me data analyst internships", [SWE]);
  assert.match(none.reply, /none of them are data and machine learning roles/, none.reply);
  const plural = ask("find me data analyst internships", [...DATA_MID, { id: "d9", title: "Data Analyst Internships", company: "Plural Synthetic", location: "Chicago, IL", remote_terms: "hybrid", requirements: ["SQL", "Python"] }]);
  const titles = ((plural.result && plural.result.shortlist) || []).map((r) => r.company);
  assert.deepEqual(titles, ["Plural Synthetic"], `the plural-titled internship binds as an internship: ${plural.reply}`);
});

test("F-006/5 the shipped bundles carry both", () => {
  for (const b of ["router_core.career.js"]) {
    const src = fs.readFileSync(path.join(root, "supabase/functions/_shared", b), "utf8");
    assert.match(src, /function bandText\(x\)/, `${b}: one band normalizer`);
    assert.match(src, /I have \$\{label\} roles, but none that match all of your ask\./, `${b}: the honest zero`);
  }
});
