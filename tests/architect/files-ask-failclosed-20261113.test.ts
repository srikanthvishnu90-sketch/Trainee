// Review of PR #805 (D-072 follow-up): familyAskOf was a denylist that failed OPEN. A non-null answer HOLDS the brain's turn to
// opening the File, so every unlisted way of saying "stop" sent the person the thing they had asked to stop (the reviewer's 188
// new messages: an opt-out got a File in 45 of 79). It is now an ALLOWLIST of whole-message shapes that fails CLOSED
// (file_family_ask.ts): any word outside a shape is null. $0: no model, no network.
//   FX-1  THE REVIEWER'S CORPUS, group a (opt-out, stop, complaint): null 79 of 79.
//   FX-2  group c (a new thing to make) and group d (not about a File): null, every one.
//   FX-3  group b (see-asks): the honest count that is held to the File, and the exact list of ACCEPTED MISSES (null). A miss is
//         never held to the tool; the allowlist is not stretched for one.
//   FX-4  SIXTY MORE opt-out, stop and negative messages in fresh words (typos, slang, other orders, several sentences, Spanish): null.
//   FX-5  CLOSED TAILS AND CLOSED SECOND CLAUSES: what is on the lists is an ask; one word more is null.
//   FX-6  ROUTING OF A NULL: a message naming a File that the router read as a resume delivery goes to the brain, which has
//         open_record_file but is NOT held to it (reason file_named, never file_family_ask); the remaining router-kept misses are named.
//   FX-7  NO INPUT hangs or throws: 600-character adversarial strings and non-strings.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/files-ask-failclosed-20261113.test.ts
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { stagedDecision } from "../../supabase/functions/agent-chat/career_staged.ts";
import { familyAskOf, fileNamedIn } from "../../supabase/functions/_shared/file_family_ask.ts";
import { NOW } from "./files-records-fixtures.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
type R = [string, string | null];
// ---------------------------------------------------------------- the reviewer's corpus, copied whole (revscr/run.ts)
const A: R[] = [
"no weekly brief","pls no weekly brief","no weekly brief please","weekly brief no thanks","weekly brief not needed","weekly brief nope",
"unsub from weekly brief","unsub weekly brief","kill the weekly brief","drop the weekly brief","ditch the weekly brief","hate the weekly brief",
"weekly brief is annoying","enough weekly brief","get rid of the weekly brief","give the weekly brief a rest","i get the weekly brief too often",
"you shouldn't send me the weekly brief","no need to send me the weekly brief","there's no need to send the weekly summary","you needn't send the weekly digest",
"dnt send me the weekly brief","don t send me the weekly brief","don´t send me the weekly brief","donʼt send me the weekly brief","stpo sending me the weekly brief link",
"I already told you to stop. Why did you send the weekly brief?","the weekly brief link, stop emailing me","the weekly brief file is useless, please make it stop",
"the weekly brief link should not be sent to me","why do i keep getting the weekly brief link","I want to see less of the weekly brief",
"can I see how to get fewer weekly brief emails","send me the weekly brief never","thanks but I'll pass on the weekly brief link",
"i'm sick of the weekly brief","spare me the weekly brief","the weekly brief is spam, I want it gone","About the weekly brief. I'd like you to stop sending those to me",
"take me off the weekly brief list","i want the weekly brief gone","weekly brief - stop","WEEKLY BRIEF STOP","stop it with the weekly brief",
"hold off on the weekly brief","not interested in the weekly brief","id rather not get the weekly brief","weekly brief\nstop","Stop sending these. I mean the weekly brief.",
"quit sending me weekly brief","i dont wanna see the weekly brief ever","please unsubscribe. the weekly brief is too long","show me the weekly brief one last time then cancel it",
"can you see that I unsubscribed from the weekly digest","the weekly summary keeps coming, make it stop","weekly report: enough already","I saw the weekly brief. dont send them",
"erase my profile facts","get rid of my career brief page","wipe my answer library","stop texting me the interview hub link","mute the search plan reminders, I've seen the page",
"isn't there a way to not get the weekly brief","the weekly brief isn't something I want you to send","send the weekly brief to nobody, I'm done","weekly brief? no thanks",
"i never asked for the weekly brief, why send it","turn the weekly brief off","switch off the weekly brief","shut off the weekly brief link","weekly digest, unsubscribe me",
"weekly brief opt-out","can we skip this week's weekly brief","I want out of the weekly brief","less weekly brief please","stop the weekly brief pls thx",
"hey so the weekly brief thing, yeah can you just not","get me off the weekly digest","show me less weekly brief",
].map((m) => [m, null]);
const Bq: R[] = [
["can you show me my career brief","F-01"],["open the career brief for me please","F-01"],["what's in my career brief","F-01"],
["show me the facts you have on file","F-02"],["pull up my profile facts","F-02"],["show me my profile page","F-02"],
["show me the path comparison","F-03"],["open the page comparing my paths","F-03"],["where is my search plan","F-04"],
["send me my search plan link","F-04"],["show me my materials file","F-07"],["show me my cover letter versions","F-07"],
["open my answer library","F-08"],["show me my saved answers","F-08"],["show me the message review","F-12"],["open the page with my outreach draft","F-12"],
["bring up my interview hub","F-13"],["show me my upcoming interviews page","F-13"],["view my weekly digest","F-14"],["send me the weekly report","F-14"],
["show me my counter plan","F-14n"],["open my negotiation page","F-14n"],["show me my offer comparison","F-15"],["show me the page comparing my offers","F-15"],
["I never got my weekly brief","F-14"],["you didn't send it this week, send me my weekly brief","F-14"],["send me my weekly brief, you didn't send it","F-14"],
["show me my weekly brief, I don't get it","F-14"],["open my search plan, i dont like that it's hidden","F-04"],["show me the latest update to my search plan","F-04"],
["can you move on and show me my weekly brief","F-14"],["show me my plan page for negotiation","F-14n"],["show me the doc with my answers for the design role","F-08"],
["send me my interviews page for the research role","F-13"],["show me my weekly brief, I turned off notifications and missed it","F-14"],
["can I see the weekly brief, I don't remember getting it","F-14"],["I just finished the mock, open my interview hub","F-13"],
["I made a decision, show me my offer comparison","F-15"],["let's start: show me my search plan","F-04"],["show me my career brief at the end of the week","F-01"],
["whats in my weekly brief","F-14"],["can i have my weekly brief","F-14"],["I'd like to look at my search plan","F-04"],["can you resend my weekly brief","F-14"],
["haven't received my weekly brief yet","F-14"],["my weekly brief didn't arrive","F-14"],["is my weekly brief ready","F-14"],
["show me my interview hub. I didn't see it last time","F-13"],["I cancelled my gym membership lol, anyway show me my career brief","F-01"],
["show me my career brief, I want to change careers","F-01"],["I can not find my offer comparison","F-15"],["couldn't open my answer library","F-08"],
["show me my weekly brief before I plan anything","F-14"],["open my negotiation plan, I need to prepare a counter","F-14n"],
["I want to edit nothing, just show me my profile facts","F-02"],["show me my path comparison while I think","F-03"],
["not sure where my weekly brief went, send the link","F-14"],["why not just show me my career brief","F-01"],["I can't wait to see my weekly brief","F-14"],
["Show me my interview hub — the last link expired and I couldn't get in","F-13"],
];
const C: R[] = [
"new search plan","need a search plan","a search plan please","outline a search plan","sketch a negotiation plan","making a search plan","rewrite my career brief",
"I want you to give me a search plan for fintech","get me a negotiation plan for the Stripe offer","could you write up a counter plan","let's make a search plan together",
"can you make a new weekly brief for my boss","draft me a fresh career brief","build me another path comparison","create an offer comparison for these two offers",
"redo my search plan","I'd like a brand new search plan","please write my weekly report for work","set up a negotiation plan","work out a counter plan with me",
"can you design a search plan around remote roles","let's plan: I need a search plan for Berlin","show me you can build a search plan","make a new one, my search plan is stale",
].map((m) => [m, null]);
const D: R[] = [
"what is a career brief","how does the interview hub work","do I need a search plan","search plan tips","career brief vs resume",
"I have a doc for my interviews, did you see the news","can you see my profile on the linkedin page","did you see my message on the careers page",
"give me a link to glassdoor so I can compare offers","can you see why my manager wants a weekly report","my boss wants me to send a weekly report",
"I have to give a weekly summary at standup","is a negotiation plan worth it","how long should a weekly report be","what's a path comparison",
"my interviews went badly","how do I compare offers","should I mention negotiation on the phone","the recruiter asked for my materials","what page of my resume should list skills",
"show me jobs that mention weekly report writing","send me the link to the Stripe careers page for my interviews prep","thanks","yes","what did the recruiter's message say about my interviews, I can't see the doc",
].map((m) => [m, null]);

// The see-asks that are NOT one of the shapes: accepted misses. Each has a free clause, a second topic or an unlisted verb, and
// admitting any of them would admit an opt-out worded the same way. Kept exact: a shape change that moves one shows here.
const ACCEPTED_MISSES = [
  "you didn't send it this week, send me my weekly brief", "show me my weekly brief, I don't get it", "open my search plan, i dont like that it's hidden",
  "show me the latest update to my search plan", "can you move on and show me my weekly brief", "show me my plan page for negotiation",
  "show me the doc with my answers for the design role", "send me my interviews page for the research role",
  "show me my weekly brief, I turned off notifications and missed it", "can I see the weekly brief, I don't remember getting it",
  "I just finished the mock, open my interview hub", "I made a decision, show me my offer comparison", "let's start: show me my search plan",
  "show me my career brief at the end of the week", "is my weekly brief ready", "show me my interview hub. I didn't see it last time",
  "I cancelled my gym membership lol, anyway show me my career brief", "show me my career brief, I want to change careers",
  "show me my weekly brief before I plan anything", "open my negotiation plan, I need to prepare a counter", "I want to edit nothing, just show me my profile facts",
  "show me my path comparison while I think", "not sure where my weekly brief went, send the link", "why not just show me my career brief",
  "I can't wait to see my weekly brief", "Show me my interview hub — the last link expired and I couldn't get in",
];

Deno.test("FX-1 THE REVIEWER'S OPT-OUTS, STOPS AND COMPLAINTS (group a): null 79 of 79", () => {
  eq(A.length, 79);
  const got = A.filter(([m]) => familyAskOf(m) !== null).map(([m]) => `${m} -> ${familyAskOf(m)}`);
  eq(got, [], "an opt-out was held to a File");
});

Deno.test("FX-2 A NEW THING TO MAKE (group c) and NOT ABOUT A FILE (group d): null, every one", () => {
  eq([C.length, D.length], [24, 25]);
  eq([...C, ...D].filter(([m]) => familyAskOf(m) !== null).map(([m]) => `${m} -> ${familyAskOf(m)}`), []);
});

Deno.test("FX-3 THE SEE-ASKS (group b): 34 of 60 are held to their File; the 26 accepted misses are null, never another family", () => {
  eq(Bq.length, 60);
  const misses = Bq.filter(([m]) => familyAskOf(m) === null).map(([m]) => m);
  // Never the wrong File.
  for (const [m, f] of Bq) ok(familyAskOf(m) === f || familyAskOf(m) === null, `${m}: ${familyAskOf(m)}, not ${f}`);
  eq(misses, ACCEPTED_MISSES);
  console.log(`FILE ASKS FAIL CLOSED: a ${A.length}/${A.length} null, c ${C.length}/${C.length} null, d ${D.length}/${D.length} null, b ${Bq.length - misses.length}/${Bq.length} held to the File, ${misses.length} accepted misses (null)`);
});

const MORE = [
  // other languages and mixes
  "no me mandes el weekly brief", "no quiero el weekly brief", "deja de mandarme el weekly brief", "ya no me envíes el weekly brief por favor", "basta con el weekly brief",
  "weekly brief no gracias", "para ya el weekly brief", "pas de weekly brief", "kein weekly brief mehr bitte", "weekly brief band karo",
  // typos and text speech
  "dont snd me the weekly brief", "stopp the weekly brief", "sotp sending weekly brief", "plz no mor weekly brief", "weekly brief nah", "nah to the weekly brief",
  "weekly brief = no", "no ty on the weekly brief", "wkly brief? weekly brief is too much tbh", "weekly brief nty", "unsubscibe weekly brief", "cancle my weekly digest",
  "the weekly brief can go", "weekly brief be gone", "bin the weekly brief", "axe the weekly digest", "nuke the weekly report", "86 the weekly brief", "yeet the weekly brief",
  "lose the weekly brief", "scrap the weekly summary", "trash my weekly brief", "chuck the weekly brief", "zero weekly brief from now on", "weekly brief: never again",
  // other word orders
  "the weekly brief, i'm done with it", "send me my weekly brief no longer", "my weekly brief, never", "show me my weekly brief zero more times", "weekly brief again? no",
  "send me my weekly brief? please don't", "my weekly brief not today", "open my weekly brief? i'd rather not", "the weekly brief again, really", "give me my weekly brief less often",
  "show me my search plan never mind", "send me the weekly report nevermind", "my weekly brief is too frequent", "the weekly brief link please no",
  // several sentences
  "Please. No weekly brief.", "I read the weekly brief. It's not for me.", "Show me my weekly brief. Actually don't.", "Send me my weekly brief. Kidding, don't.",
  "My weekly brief. Make it go away.", "Weekly brief again today. I asked you to end these.", "show me my weekly brief, said no one ever",
  // other Files, and what is not a see-ask at all
  "forget my career brief", "i don't need the interview hub link", "the search plan page, i'm over it", "keep my answer library to yourself", "burn my profile facts",
  "my offer comparison is wrong", "the negotiation plan link keeps coming and i hate it", "show me my weekly brief and then end it",
];

Deno.test("FX-4 SIXTY MORE OPT-OUT, STOP AND NEGATIVE MESSAGES in fresh words (typos, slang, other orders, several sentences, Spanish): null", () => {
  ok(MORE.length >= 60, `${MORE.length} messages`);
  eq(new Set([...MORE, ...A.map(([m]) => m)]).size, MORE.length + A.length, "each is new, none is the reviewer's");
  eq(MORE.filter((m) => familyAskOf(m) !== null).map((m) => `${m} -> ${familyAskOf(m)}`), []);
  console.log(`FILE ASKS FAIL CLOSED: ${MORE.length}/${MORE.length} more opt-outs null`);
});

Deno.test("FX-5 CLOSED TAILS AND CLOSED SECOND CLAUSES: what is on the lists is an ask; one word more is null", () => {
  const each = (rows: R[]) => eq(rows.filter(([m, f]) => familyAskOf(m) !== f).map(([m, f]) => `${m}: ${familyAskOf(m)}, not ${f}`), []);
  each([
    // politeness, case, apostrophes, punctuation
    ["Hey, could you please show me my weekly brief? Thanks!", "F-14"], ["pls send me the weekly brief link", "F-14"], ["WHERE’S MY SEARCH PLAN??", "F-04"],
    ["i'd like to see my career brief", "F-01"], ["let me see my interview hub", "F-13"], ["can i have my offer comparison please", "F-15"], ["weekly brief?", "F-14"],
    ["the weekly brief link", "F-14"], ["send me the link to my answer library", "F-08"], ["can you resend my weekly brief", "F-14"],
    // each tail
    ["show me my weekly brief again", "F-14"], ["show me my weekly brief now", "F-14"], ["send me my weekly brief today", "F-14"], ["send me my weekly brief tonight", "F-14"],
    ["send me my weekly brief this morning", "F-14"], ["show me my search plan real quick", "F-04"], ["open my career brief for me", "F-01"], ["send my weekly brief here", "F-14"],
    ["send my weekly brief in chat", "F-14"], ["send me my weekly brief on whatsapp", "F-14"], ["show me my weekly brief by end of day", "F-14"], ["send me my weekly brief when you can", "F-14"],
    // each closed second clause
    ["show me my weekly brief, i can't find it", "F-14"], ["send me my weekly brief. I cannot open the link", "F-14"], ["send me my search plan, i couldn't see the page", "F-04"],
    ["send me the weekly brief link, the old one doesn't work", "F-14"], ["show me my negotiation plan again, the link won't load", "F-14n"], ["send me my career brief, the link isn't opening", "F-01"],
    ["send me my weekly brief, i never got it", "F-14"], ["send me my weekly brief, you didn't send it", "F-14"], ["send me my weekly brief because i lost the link", "F-14"],
    ["I never got my weekly brief", "F-14"], ["can't open my career brief, send me the link", "F-01"], ["my search plan link doesn't open", "F-04"],
    // one word more than a tail
    ["send me the weekly brief never", null], ["show me my weekly brief again never", null], ["show me my weekly brief now and never again", null], ["send me my weekly brief today only", null],
    ["show me my weekly brief and turn it off after", null], ["show me my weekly brief for the last time", null], ["send me my weekly brief on whatsapp not here", null],
    // a second clause that is not on the list
    ["stop. show me my weekly brief", null], ["show me my weekly brief. stop", null], ["show me my weekly brief, i don't want it", null], ["send me my weekly brief, i can't stand it", null],
    ["show me my weekly brief, the link doesn't work and neither do you", null], ["send me my weekly brief, i never wanted it", null], ["show me my weekly brief, you didn't send it and i'm glad", null],
    ["i can't find my weekly brief and i don't care", null], ["i never got my weekly brief, good", null], ["i can't get my weekly brief to stop", null],
    // the verb must ask to SEE it, of Trainee or by the person
    ["can i send my weekly report", null], ["i need to send my weekly report", null], ["can you see my weekly brief", null], ["give me a search plan", null], ["get me a weekly brief", null],
    ["resume my weekly brief", null], ["make me my weekly brief", null], ["how do i open my weekly brief", null], ["should i open my weekly brief", null], ["never show me my weekly brief", null],
    ["do not show me my weekly brief", null], ["don't show me my weekly brief", null], ["please don't open my career brief", null],
  ]);
});

// deno-lint-ignore no-explicit-any
const K = core as any, host = (CareerHost as any).createCareerHost({ CareerAccess: K.CareerAccess, CareerOnboarding: K.CareerOnboarding, CareerRouter: K.CareerRouter, CareerDoorstep: K.CareerDoorstep, CareerReply: K.CareerReply, CareerContainment: K.CareerContainment });
const fresh = () => host.createTurnCtx({ userId: "u-fx", threadId: "t-fx", now: NOW, accountPersistence: true, snapshot: null, account: { epoch: 0, version: 0, paused: false } });
const STAGED = { get: (k: string) => ({ CAREER_BRAIN: "staged" } as Record<string, string>)[k] };
const decide = (message: string) => { const e = console.error; console.error = () => {}; try { return stagedDecision({ env: STAGED, message, ctx: fresh(), host, structured: false }); } finally { console.error = e; } };

Deno.test("FX-6 ROUTING OF A NULL: never file_family_ask; a File named in a 'resume delivery' reading is the brain's, unforced; the router-kept misses are named", () => {
  // No message that is null is ever routed as a File ask (the only route that holds the turn to the tool).
  for (const m of [...A.map(([x]) => x), ...C.map(([x]) => x), ...D.map(([x]) => x), ...MORE, ...ACCEPTED_MISSES]) ok(decide(m).reason !== "file_family_ask", `${m}: routed as a File ask`);
  // The router read "send ... weekly brief" as a resume delivery ("no resume has been tailored"): with a File named and no
  // document to deliver it is the brain's, which has the tool and the settings tools, and familyAskOf is null so it is held to neither.
  for (const m of ["don't forget to send me my weekly brief", "make sure to send me my weekly brief", "you didn't send it this week, send me my weekly brief", "dnt send me the weekly brief", "send me the weekly brief never"]) {
    const d = decide(m);
    eq([familyAskOf(m), fileNamedIn(m), d.brain, d.reason, d.intent], [null, true, true, "file_named", "career_document_delivery"], m);
  }
  // A delivery ask that names no File stays code's.
  ok(!fileNamedIn("send me my resume") && decide("send me my resume").reason !== "file_named");
  // Where the accepted misses go: the brain (open_record_file offered, not held) for all but these, which the router answers as
  // the other thing the message names (a search for the role, an interview prep File).
  const kept = ACCEPTED_MISSES.filter((m) => !decide(m).brain).map((m) => `${m} | ${decide(m).reason} ${decide(m).intent}`);
  eq(kept, ["show me the doc with my answers for the design role | action career_discovery", "send me my interviews page for the research role | code_product prep_brief"]);
  console.log(`FILE ASKS FAIL CLOSED: ${ACCEPTED_MISSES.length - kept.length}/${ACCEPTED_MISSES.length} accepted misses reach the brain with open_record_file offered and not held; ${kept.length} stay the router's`);
});

Deno.test("FX-7 NO INPUT hangs or throws: 600-character adversarial strings and non-strings", () => {
  const adv = [("not ".repeat(140) + "weekly brief ").padEnd(600, "x").slice(0, 600), ("make me a ".repeat(58) + "weekly brief").slice(0, 600), ("can't i get to my the ".repeat(26) + "weekly brief").slice(0, 600),
    ("weekly brief" + " ".repeat(580) + "-").slice(0, 600), "weekly brief" + " - ".repeat(190) + "x", ("weekly brief " + "don't a b ".repeat(58)).slice(0, 600), "weekly brief" + ",".repeat(588),
    ("show me my weekly brief" + " again".repeat(96)).slice(0, 600), ("please ".repeat(80) + "show me my weekly brief").slice(0, 600), ("show me my weekly brief" + ", please".repeat(70)).slice(0, 600),
    ("hey ".repeat(140) + "weekly brief").slice(0, 600), "show me my weekly brief" + ". i can't find it".repeat(30)];
  for (const v of adv) { const t0 = performance.now(); for (let i = 0; i < 20; i++) familyAskOf(v); const ms = (performance.now() - t0) / 20; ok(ms < 20, `${v.slice(0, 40)}...: ${ms.toFixed(2)}ms`); }
  // Repeated tails, politeness or reasons past the small bounds are not a shape.
  eq(adv.map((v) => familyAskOf(v)).filter((f) => f !== null && f !== "F-14"), []);
  eq(familyAskOf("weekly brief" + ",".repeat(588)), "F-14");
  // deno-lint-ignore no-explicit-any
  for (const v of [null, undefined, 42, {}, [], "", " ", "?", "x".repeat(601), "weekly brief".repeat(50)] as any[]) eq(familyAskOf(v), null, String(v).slice(0, 20));
});
