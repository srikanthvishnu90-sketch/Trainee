// #354 review at 8bb9d495 (blocker 1): when the model layers are down (budget paused, no key, an outage) the word list is
// all there is, so it must catch EVERY crisis phrasing trunk's live lists catch. The live lists, verbatim from trunk
// f6eda6499 (125-career-intel.js:650, 139-career-safety.js:101); phrases are generated from each of their alternatives in
// the frames people write them in, and every one trunk catches must be caught by CareerSafety.isDistress.
// The only exceptions are the named idioms the list deliberately treats as work talk (career/professional suicide,
// suicide prevention jobs): listed below, never generated as crisis.
import assertNode from "node:assert/strict";
import { CareerSafety } from "../../supabase/functions/_shared/router_core.career.js";

const LIVE = [/(kill myself|end my life|self[- ]?harm|suicidal|don't want to (be alive|live))/, /\b(kill myself|end it all|self[- ]?harm|suicide|don't want to (?:live|be here)|no reason to (?:live|go on))\b/i];
const live = (t: string) => LIVE[0].test(t.toLowerCase()) || LIVE[1].test(t);
const isDistress = (t: string) => (CareerSafety as { isDistress: (t: string) => boolean }).isDistress(t);
const CORES = ["kill myself", "end my life", "self harm", "self-harm", "selfharm", "suicidal", "don't want to be alive", "don't want to live",
  "end it all", "suicide", "don't want to be here", "no reason to live", "no reason to go on"];
const FRAMES = ["{c}", "i {c}", "i want to {c}", "i'm going to {c}", "i am going to {c} this weekend", "i will {c} tomorrow", "i want to {c} with pills",
  "i'm thinking about {c}", "honestly {c}", "{c} tonight", "i might {c}", "i keep thinking about {c}", "{c} lol", "i feel {c}", "{c}.",
  "i just want to {c} now", "find me jobs. i want to {c}", "i've been {c}", "i'm {c}", "thinking of {c} again", "there is {c}", "is there {c}",
  "i have {c} thoughts", "i {c} because of this job search", "i'm so {c} right now", "{c}, honestly", "I WANT TO {C}", "i really {c}"];
const IDIOMS = ["career suicide", "professional suicide", "suicide prevention", "suicide squad"]; // deliberate work talk (139 BENIGN)

Deno.test("the list catches every crisis phrasing trunk's live lists catch (generated from their alternatives)", () => {
  const phrases = [...new Set(CORES.flatMap((c) => FRAMES.map((f) => f.replace("{c}", c).replace("{C}", c.toUpperCase()))))].filter(live);
  assertNode.ok(phrases.length >= 300, `${phrases.length} generated phrases trunk catches`);
  const missed = phrases.filter((p) => !isDistress(p));
  assertNode.deepStrictEqual(missed, [], `${missed.length} trunk-caught phrases missed`);
});

Deno.test("the review's named regressions and evasions are caught; its false alarms are not", () => {
  for (const m of ["i want to end my life with pills", "i am going to end my life this weekend", "i will end my life tomorrow", "no reason to go on",
    "i want to ki11 myself", "i want to kiII myself", "i want to k!ll myself", "मैं मरना चाहता हूँ", "मुझे आत्महत्या करनी है", "मैं जीना नहीं चाहती"]) assertNode.ok(isDistress(m), m);
  for (const m of ["this commute kills me", "the waiting kills me", "i took 5 meds courses"]) assertNode.ok(!isDistress(m), m);
  for (const m of IDIOMS) assertNode.ok(!isDistress(`would quitting now be ${m}`) || m.includes("squad"), m);
});
