// Word-vomit benchmark (evals/word-vomit WV14, WV18): the apply-all offer's yes as people text it. Before, "ya do it" and
// "yes!!! omg finally ok go 🙏" were not a yes to the offer and went to the brain, which cannot approve, though a card read
// the same words as yes (approval_words.ts). D-MS-1's list still approves nothing.
import assertNode from "node:assert/strict";
import { isApplyAllYes, isConditionalYes } from "../../supabase/functions/_shared/apply_all_yes.ts";

Deno.test("word-vomit: a yes with an explicit act or excitement on it is the offer's yes", () => {
  for (const m of ["ya do it", "yes!!! omg finally ok go 🙏", "yeah go for it", "ok do it", "yes pls", "yep send them all", "finally yes"]) assertNode.equal(isApplyAllYes(m), true, m);
});
Deno.test("word-vomit: D-MS-1's non-answers and a yes with a condition still approve nothing", () => {
  for (const m of ["ok", "okay", "sure", "sounds good", "absolutely", "definitely", "ya", "maybe", "yes?", "yeah maybe", "\u{1F44D}", "yes what is the salary?", "ya ya", "omg", "go", "ok go",
    "yes but not TEST Web", "yes but skip the second one", "yes omg wait", "yes finally but not acme"]) assertNode.equal(isApplyAllYes(m), false, m);
  assertNode.equal(isConditionalYes("yes but skip the second one"), true);
});
