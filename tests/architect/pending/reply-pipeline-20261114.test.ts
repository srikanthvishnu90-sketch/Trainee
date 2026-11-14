// REPLY PIPELINE (docs/architect/specs/REPLY-PIPELINE.md): evidence ledger, tagged draft, verification against the cited units only,
// one repair pass, the drop and code's fallback line, the task contract. New examples in three domains, none from the mirror set.
import { assert as ok, assertEquals as eq } from "jsr:@std/assert@1";
import { FAIL_CLOSED } from "../../../supabase/functions/_shared/agent/research/market.ts";
import { contractsFor, CONTRACTS, Ledger, runReplyPipeline, stripTags, tagsOf, verifyTagged } from "../../../supabase/functions/_shared/agent/reply_pipeline.ts";
import { testSupportJudge } from "../support-test-judge.ts";

FAIL_CLOSED.support = true;
const yes = async (cs: { claim: string }[]) => cs.map(() => "yes" as const);

// Finance: a New York summer analyst posting read this turn, and a page on bank analyst hours.
function finance() {
  const l = new Ledger();
  l.fromToolResult("get_posting", { posting: { company: "Hudson Ridge Capital", title: "Summer Analyst 2027", location: "New York, NY", pay: "New York, NY: $55 - $60 Hourly", deadline: "2027-01-15", state: "open", url: "https://careers.hudsonridge.example/sa" } });
  l.add("page", "First-year analysts at bulge-bracket banks report working 70 to 80 hours a week.", { host: "wallstreetoasis.example", source: "self_reported", url: "https://wallstreetoasis.example/hours" });
  l.addRecord(["education: Eastbrook College, BA Economics, Expected May 2028", "skill: Excel"], ["city", "phone"]);
  return l;
}
// Nursing: a BLS page unit for Texas, and nothing about the person's licence.
function nursing() {
  const l = new Ledger();
  l.add("page", "Registered nurses in Texas earned a mean hourly wage of $42.85 in May 2024.", { host: "bls.example", source: "official", url: "https://bls.example/oes/tx" });
  l.addRecord(["education: Lone Star Nursing School, ADN, Expected June 2027"], ["licence number"]);
  return l;
}
// A startup's culture: one employee review and a company page.
function startup() {
  const l = new Ledger();
  l.add("page", "Brightloop engineers ship to production every day and own their features end to end.", { host: "brightloop.example", source: "official", url: "https://brightloop.example/eng" });
  l.add("page", "One reviewer said on-call weeks at Brightloop were exhausting.", { host: "reviews.example", source: "anecdote", url: "https://reviews.example/brightloop" });
  return l;
}

Deno.test("ledger: chat tool results, pages and the record (what it lacks included) are numbered units", () => {
  const l = finance();
  ok(l.units.some((u) => u.kind === "chat" && /Hudson Ridge Capital, Summer Analyst 2027 \(New York, NY\): pay New York, NY: \$55 - \$60 Hourly/.test(u.text)));
  ok(l.units.some((u) => u.kind === "chat" && /is open; it closes 2027-01-15/.test(u.text)));
  ok(l.units.some((u) => u.kind === "absent" && u.text === "Not on file: city, phone."));
  ok(/^\[E1\] \(this chat's tool result\)/.test(l.block()));
  eq(tagsOf("Pay is $55-$60 an hour [E1, E2].").ids, ["E1", "E2"]);
  eq(stripTags("Pay is $55-$60 an hour [E1]."), "Pay is $55-$60 an hour.");
});

Deno.test("verify: each clause against the units it cites only; a fact with no tag fails; a hedge needs none", async () => {
  const l = finance();
  const v = await verifyTagged("Hudson Ridge Capital pays $55-$60 an hour in New York [E1], and the posting closes January 15, 2027 [E2]. That's an anecdote, not proof. Analysts work 70 to 80 hours a week. Want me to check the questions?", l, { judge: yes });
  eq(v.failures.map((f) => f.sentence), ["Analysts work 70 to 80 hours a week."]);
  ok(/cites no evidence unit/.test(v.failures[0].reason));
  ok(v.text.startsWith("Hudson Ridge Capital pays $55-$60 an hour in New York, and the posting closes January 15, 2027."), v.text);
  // Citing the wrong unit fails even though another unit holds it, with code's reason naming the specific.
  const w = await verifyTagged("Texas nurses earn a mean of $42.85 an hour [E2].", nursing(), { judge: yes });
  eq(w.text, "");
  ok(/'\$42\.85[^']*' is in no cited unit/.test(w.failures[0].reason), w.failures[0].reason);
});

Deno.test("repair: one call for everything that failed, verified again; what still fails is dropped", async () => {
  let calls = 0, asked = "";
  const repair = async (x: { system: string; user: string }) => { calls++; asked = x.user; return "Registered nurses in Texas earned a mean hourly wage of $42.85 in May 2024 [E1].\nNurses in Texas get a $10,000 signing bonus [E1]."; };
  const out = await runReplyPipeline("Texas nurses make about $50 an hour [E1]. That's an estimate, not proof.", nursing(), { judge: testSupportJudge, repair, ask: "what do nurses make in texas per hour" });
  eq(calls, 1);
  ok(/'\$50[^']*' is in no cited unit/.test(asked), asked);
  ok(out.text.startsWith("Registered nurses in Texas earned a mean hourly wage of $42.85 in May 2024."), out.text);
  ok(!/\$10,000|\$50/.test(out.text), out.text);
  eq(out.dropped.map((f) => f.sentence), ["Nurses in Texas get a $10,000 signing bonus."]);
});

Deno.test("fallback: nothing left answers, so code says what it could not verify and what the ledger holds, with its link", async () => {
  const out = await runReplyPipeline("Hudson Ridge Capital analysts get a $20,000 bonus [E3].", finance(), { judge: yes, repair: async () => "", ask: "what does hudson ridge capital pay summer analysts in new york" });
  ok(out.fallback);
  ok(out.text.startsWith("I couldn't verify an answer to that from what I read. This chat's tool results do hold:"), out.text);
  ok(out.text.includes("$55 - $60 Hourly") && out.text.includes("https://careers.hudsonridge.example/sa"), out.text);
  // A startup culture ask with nothing verified: no figure from anywhere is invented.
  const s = await runReplyPipeline("Brightloop has unlimited vacation [E1].", startup(), { judge: testSupportJudge, ask: "what's the culture like at brightloop" });
  ok(s.fallback && !/unlimited/.test(s.text), s.text);
});

Deno.test("the record: what is not on file is code's to say from the record", async () => {
  const onRecord = (x: string) => /^your city and phone aren't on file\.?$/i.test(x) ? true : /^your education isn't on file\.?$/i.test(x) ? false : null;
  const v = await verifyTagged("Your city and phone aren't on file. Your education isn't on file.", finance(), { judge: yes, onRecord });
  eq(v.text, "Your city and phone aren't on file.");
});

Deno.test("length and the task contract go to the same one repair call; over the limit after it, whole sentences go from the end", async () => {
  const l = startup();
  let user = "";
  const long = "Brightloop engineers ship to production every day [E1]. They own their features end to end [E1]. One reviewer said on-call weeks were exhausting [E2]. That's an anecdote, not proof.";
  const out = await runReplyPipeline(long, l, { judge: yes, repair: async (x) => { user = x.user; return "Brightloop engineers ship daily and own their features [E1]."; }, ask: "what's brightloop's engineering culture", maxChars: 80 });
  ok(/LENGTH: the reply is \d+ characters; the limit is 80/.test(user), user);
  ok(out.text.replace(/\nhttps?:\/\/\S+/g, "").length <= 80, out.text);
  const cs = contractsFor("career_followup_draft", "draft a note asking a nurse manager in houston for a referral");
  eq(cs.map((c) => c.id).sort(), ["answer_first", "draft", "referral"]);
  eq(CONTRACTS.referral.missing("Hi [Name], could we chat about your unit?", ""), "the message never asks for a referral");
  eq(CONTRACTS.requirements.missing("You need: a resume, a transcript, and two references.", ""), null);
  eq(CONTRACTS.answer_first.missing("Great question! Pay is $55 an hour.", ""), "the first sentence is a preamble, not the answer");
});

// ---- review of PR #849 (head 0b6d48c73)
import { normDates, noClaim, personQuestion, splitSentences } from "../../../supabase/functions/_shared/agent/research/support.ts";
import { fallbackLine } from "../../../supabase/functions/_shared/agent/reply_pipeline.ts";

Deno.test("review 3: the tags go, the sources stay: a kept sentence's cited unit link is listed (D-024, D-060)", async () => {
  const l = new Ledger();
  l.add("page", "Citadel software engineering interns are paid $120 an hour.", { host: "citadel.example", source: "official", url: "https://citadel.example/careers/interns" });
  const out = await runReplyPipeline("Citadel software engineering interns are paid $120 an hour [E1].", l, { judge: yes, ask: "what do citadel swe interns make" });
  eq(out.text, "Citadel software engineering interns are paid $120 an hour.\nhttps://citadel.example/careers/interns");
});

Deno.test("review 4: a question goes unjudged only when it asks the person about their own situation", async () => {
  for (const q of ["Which email should go on the resume?", "Want me to check the questions?", "Are you authorized to work without sponsorship?"]) ok(personQuestion(q), q);
  // (a name that is neither the person's record's nor the ask's makes it a claim to judge: re-review of 940195e08)
  // (a place in a question only about their own eligibility or preference stays theirs: the C11 work-authorization question)
  ok(personQuestion("Are you authorized to work in the U.S. without sponsorship?"));
  ok(personQuestion("Are you open to relocating to New York?"));
  ok(!personQuestion("Are you authorized to work at Stripe in New York?"), "an employer named");
  ok(!personQuestion("Are you open to relocating to New York by 2027?"), "a figure");
  for (const q of ["Did you know Stripe stopped sponsoring visas?", "Is Stripe still hiring interns?", "Have you heard that the posting closed?", "Can you believe interns earn $90 an hour?"]) ok(!personQuestion(q), q);
  const v = await verifyTagged("Did you know Stripe stopped sponsoring visas?", startup(), { judge: yes });
  eq(v.text, "");
});

Deno.test("review 5: a caveat is exempt only when it speaks of Trainee's own knowledge; a status word is never exempt", () => {
  for (const s of ["That's an anecdote, not proof.", "I can't verify it.", "I don't have its date.", "Nothing was sent or applied for.", "That's a self-reported figure, not proof."]) ok(noClaim(s), s);
  for (const s of ["That's the official posting, not a scam.", "That's a verified figure, not an estimate.", "This is a legitimate posting.", "That's a real offer, not an example.", "I can't verify it, but it is official."]) ok(!noClaim(s), s);
});

Deno.test("review 6 and 7: abbreviations; day-first dates; a numeric date only in ISO order", () => {
  eq(splitSentences("Applications close Jan. 15, 2027 [E2]. Then more."), ["Applications close Jan. 15, 2027 [E2].", "Then more."]);
  eq(splitSentences("Acme Co. and Beta Ltd. merged vs. Gamma Corp. last year. Next."), ["Acme Co. and Beta Ltd. merged vs. Gamma Corp. last year.", "Next."]);
  eq(normDates("6 December 2026"), "Date20261206");
  eq(normDates("Sunday, 6th December 2026"), "Date20261206");
  eq(normDates("Jan. 15, 2027"), "Date20270115");
  eq(normDates("12/06/2026"), "12/06/2026");
});

Deno.test("review 8: the fallback matches the ask's employer and place both (D73-6)", () => {
  const l = new Ledger();
  l.add("chat", "PayPal, Software Engineer Intern - Summer 2027 (Chicago, IL): pay $28- $49 Hourly", { url: "https://paypal.example/r1" });
  ok(!fallbackLine(l, "what does citadel pay interns in chicago", ["Citadel"]).includes("PayPal"));
  ok(fallbackLine(l, "what does paypal pay interns in chicago").includes("$28- $49"));
  ok(!fallbackLine(l, "what do interns earn").includes("PayPal"), "an ask that names no one lists nothing");
});

Deno.test("review 9: an exact restatement of a strict subset of the unit stands (the place qualifying the figure may be left to the judge)", async () => {
  const l = new Ledger();
  l.add("chat", "Stripe (Chicago, IL): pay $40/hr", { url: "https://stripe.example/j1", places: ["Chicago, IL"] });
  for (const s of ["Stripe pays $40/hr [E1].", "Stripe pays $40/hr in Chicago [E1]."]) eq((await verifyTagged(s, l, { judge: yes })).failures, [], s);
  // A figure that is another employer's never stands.
  const m = new Ledger(); m.add("chat", "Jane Street, Citadel: pay $40/hr"); m.add("chat", "Citadel pays $40/hr; Jane Street pays $50/hr.");
  ok((await verifyTagged("Jane Street pays $40/hr [E1].", m, { judge: yes })).failures.length === 1);
  ok((await verifyTagged("Jane Street pays $40/hr [E2].", m, { judge: yes })).failures.length === 1);
});

// ---- re-review of 940195e08
import { findSupport, indexPages } from "../../../supabase/functions/_shared/agent/research/support.ts";
Deno.test("re-review 1: another employer's 'X, ST' is an owner, never a place (layer A refuses); a located place is a place", () => {
  const holds = (u: string, c: string, places: string[] = []) => !!findSupport(c, indexPages([{ text: u, title: "T", places }]));
  ok(!holds("Citadel interns earn $5,000 a week while Jane Street, NY interns earn $6,000 a week.", "Citadel interns earn $6,000 a week."));
  ok(!holds("Citadel interns earn $5,000 a week while DRW, IL interns earn $6,000 a week.", "Citadel interns earn $6,000 a week."));
  ok(holds("Stripe pays $40/hr in Chicago, IL.", "Stripe pays $40/hr"));
  ok(holds("Stripe (Chicago, IL): pay $40/hr", "Stripe pays $40/hr", ["Chicago, IL"]), "a place the chat's tool results gave");
  ok(!holds("Stripe (Chicago, IL): pay $40/hr", "Stripe pays $40/hr"), "with no location word and no chat place, it stays a possible owner");
});
Deno.test("re-review 2: a question to the person naming a world event, or a name not theirs, is judged", async () => {
  ok(!personQuestion("Are you okay with Stripe's layoffs last month?"));
  ok(!personQuestion("Are you okay with the layoffs last month?"));
  ok(personQuestion("Do you want me to tailor it for Stripe?", "what does stripe pay"));
  const v = await verifyTagged("Are you okay with Stripe's layoffs last month?", startup(), { judge: async (cs) => cs.map(() => "no" as const) });
  eq(v.text, "");
});
