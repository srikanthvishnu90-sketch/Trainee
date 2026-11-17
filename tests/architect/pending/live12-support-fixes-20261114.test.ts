// Live-12 support-check fixes (product, $0, flag on, no network): the splitter, dates, sentences that make no claim, clauses, the
// record check and this chat's tool results as source units.
import { assert as ok, assertEquals as eq } from "jsr:@std/assert@1";
import { FAIL_CLOSED } from "../../../supabase/functions/_shared/agent/research/market.ts";
import { clausesOf, hardParts, keepSupported, noClaim, normDates, quotable, splitSentences } from "../../../supabase/functions/_shared/agent/research/support.ts";
import { testSupportJudge } from "../support-test-judge.ts";

FAIL_CLOSED.support = true;

Deno.test("item 3: the splitter never ends a sentence at an abbreviation (C11: 'without sponsorship?' sent alone)", () => {
  eq(splitSentences("I don't have your status on file, so are you authorized to work in the U.S. without sponsorship? Next."),
    ["I don't have your status on file, so are you authorized to work in the U.S. without sponsorship?", "Next."]);
  eq(splitSentences("Offices in the U.K. and the U.S.A. open at 9 a.m. on weekdays. Then more."), ["Offices in the U.K. and the U.S.A. open at 9 a.m. on weekdays.", "Then more."]);
  eq(splitSentences("Use a header, e.g. name and email. Acme Inc. hires interns."), ["Use a header, e.g. name and email.", "Acme Inc. hires interns."]);
  eq(splitSentences("It closes at 5 p.m. Apply early."), ["It closes at 5 p.m. Apply early."]); // ("p.m." ends no sentence, as written)
});

Deno.test("item 4: a full date is one token however it is written", () => {
  const t = "Date20261206";
  for (const d of ["Sunday, December 6th, 2026", "December 6, 2026", "Dec 6, 2026", "2026-12-06"]) eq(normDates(d), t, d);
  eq(normDates("December 7, 2026") === t, false);
  ok(hardParts("Applications are open through Sunday, December 6th, 2026").names.some((r) => r.join(" ") === "date20261206"));
});

Deno.test("item 2: a hedge, a caveat or a 'nothing was sent' line is not a claim; a claim about the world with no name or figure still is", () => {
  for (const s of ["That's an anecdote, not proof.", "Nothing was sent or applied for.", "Resume text only, nothing sent.", "That's a self-reported figure, not proof."]) ok(noClaim(s), s);
  for (const s of ["Hospitals have stopped checking licences.", "Citadel is under federal investigation.", "citadel does not pay interns", "The posting is closed.",
    "I'd treat $28 as a floor.", "That's one internship posting, not a market rate.", "I found that recruiters reject two-page resumes.", "Recruiters reject two-page resumes outright.", "That's why Citadel pays more.", "Is it open?"]) ok(!noClaim(s), s);
});

Deno.test("item 5: a sentence of joined clauses is read clause by clause, each on its own unit", async () => {
  eq(clausesOf("Applications are open through Sunday, December 6th, 2026, and Chicago pay is $28-$49 an hour."), ["Applications are open through Sunday, December 6th, 2026", "Chicago pay is $28-$49 an hour"]);
  const units = [{ text: "PayPal's posting is open; it closes 2026-12-06.", title: "Read from the posting this turn" }, { text: "Chicago, Illinois: $28- $49 Hourly", title: "Posting record" }];
  const k = await keepSupported("Applications are open through December 6, 2026, and Chicago pay is $28-$49 an hour.", units, { judge: async (cs) => cs.map(() => "yes") });
  eq(k.removed, [], JSON.stringify(k));
  // No clause stands on two units: a clause joining the deadline and the pay is refused.
  const k2 = await keepSupported("Chicago pay of $28-$49 an hour closes December 6, 2026.", units, { judge: async (cs) => cs.map(() => "yes") });
  eq(k2.text, "");
  // Every clause must stand: one unsupported clause removes the sentence.
  const k3 = await keepSupported("Chicago pay is $28-$49 an hour, and Citadel pays $95 an hour.", units, { judge: testSupportJudge });
  eq(k3.text, "");
});

Deno.test("item 6: what is or is not on the record is code's check, not layer A's", async () => {
  const onRecord = (s: string) => /aren't on file$/.test(s.replace(/[.]$/, "")) ? !/phone/.test("education: Lakeshore University") : null;
  const k = await keepSupported("Your city and phone aren't on file.", [{ text: "education: Lakeshore University", one: true }], { judge: async (cs) => cs.map(() => "no"), onRecord });
  eq(k.text, "Your city and phone aren't on file.");
  const k2 = await keepSupported("Your education isn't on file.", [{ text: "education: Lakeshore University", one: true }], { judge: async (cs) => cs.map(() => "yes"), onRecord: () => false });
  eq(k2.text, "");
});

Deno.test("item 1: a fragment of a page's argument and its markdown are never shown as a quote", () => {
  ok(!quotable("So I don't read Chicago developer salary data as trivia."));
  ok(!quotable("Mostly because Citadel engineers do work on trading, risk, market-data and investment infrastructure."));
  ok(quotable("Employees at Citadel with New Grad experience earn an average of $391k."));
});
