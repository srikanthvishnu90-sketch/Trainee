// Word-vomit benchmark (evals/word-vomit WV31): a reminder whose day is said mid-sentence, with more of the ask or a remark after
// it, is a reminder for that day. Before: "remind me to apply to quarry lane by friday and also the copperline one, i keep
// forgetting" was asked back whole ("When should I remind you to apply to quarry lane by friday and also ...?").
import assertNode from "node:assert/strict";
import { reminderAsk } from "../../supabase/functions/_shared/career_reminders.ts";

Deno.test("word-vomit: the day said mid-sentence is the reminder's day; a trailing remark is not what to remind", () => {
  assertNode.deepEqual(reminderAsk("remind me to apply to quarry lane by friday and also the copperline one, i keep forgetting"), { kind: "set", what: "apply to quarry lane and also the copperline one", when: "friday" });
  assertNode.deepEqual(reminderAsk("remind me to apply to quarry lane by friday, i keep forgetting"), { kind: "set", what: "apply to quarry lane", when: "friday" });
  assertNode.deepEqual(reminderAsk("remind me to email dana by tomorrow at 9am"), { kind: "set", what: "email dana", when: "tomorrow at 9am" });
  // Unchanged: a reminder with no day is asked when.
  assertNode.deepEqual(reminderAsk("remind me about the acme interview"), { kind: "when", what: "the acme interview" });
});
