// Word-vomit benchmark (evals/word-vomit WV34): two offers told in one breath with a pick asked are a comparison of what was
// just said, not one offer. Before: "bluestem said 30 an hour but harborlight offered 27 and its remote which one lol" got
// "Got it: remote, 62,400 (currency not stated). To place it against market pay I need the job title."
import assertNode from "node:assert/strict";
import { offerChatTurn } from "../../supabase/functions/_shared/career_offer_chat.ts";

Deno.test("word-vomit: two stated offers and a pick go on to the brain; one stated offer is still read by code", async () => {
  const two = await offerChatTurn({ message: "bluestem said 30 an hour but harborlight offered 27 and its remote which one lol", state: null, now: Date.now() });
  assertNode.equal(two.answer, null, JSON.stringify(two.answer));
  const one = await offerChatTurn({ message: "I got an offer from JPMorgan for $110k as an analyst in New York", state: null, now: Date.now() });
  assertNode.notEqual(one.answer, null);
});
