// Word-vomit benchmark (evals/word-vomit WV34, WV36): a question texted with no "?" and not at the start of the message is a
// question. Before: "bluestem said 30 an hour but harborlight offered 27 and its remote which one lol" got the router's
// "Got it: remote, 62,400 ... I need the job title", and "they offered me 3000 a month is that 18 an hour or what" got
// "Noted — a offer landed" from the tracker, which recorded nothing. Both are the brain's, with the router's answer as data.
import assertNode from "node:assert/strict";
import { questionShaped, questionTurn } from "../../supabase/functions/agent-chat/career_staged.ts";

Deno.test("word-vomit: unpunctuated questions read as questions; instructions do not", () => {
  for (const m of ["bluestem said 30 an hour but harborlight offered 27 and its remote which one lol", "they offered me 3000 a month is that 18 an hour or what",
    "i got two offers, which one should i take", "they want an answer by monday so should i ask for more time"]) assertNode.equal(questionShaped(m), true, m);
  for (const m of ["find me data jobs in chicago", "apply to the second one", "yes do it", "send it to dana", "remind me friday to apply to quarry lane"]) assertNode.equal(questionShaped(m), false, m);
});
Deno.test("word-vomit: the offer question and a tracker reply that recorded nothing go to the brain; a recorded tracker move stays code's", () => {
  assertNode.equal(questionTurn("bluestem said 30 an hour but harborlight offered 27 and its remote which one lol", "career_offer_ask", { resultStatus: "awaiting_user", sends: 0 }), true);
  assertNode.equal(questionTurn("they offered me 3000 a month is that 18 an hour or what", "tracking_status", { resultStatus: "awaiting_user", sends: 0 }), true);
  assertNode.equal(questionTurn("they offered me 3000 a month is that 18 an hour or what", "tracking_status", { resultStatus: "completed", sends: 0, application: { company: "Acme" } }), false);
  assertNode.equal(questionTurn("did my acme application go through?", "tracking_status", { resultStatus: "completed", sends: 0 }), false);
});
