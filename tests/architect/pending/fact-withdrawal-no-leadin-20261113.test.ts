// PENDING (needs the owner's yes to amend the pinned test D70-3, tests/architect/d070-live7-fixes-20261112.test.ts:186 and :200).
// Review of #790, round 3 (2026-11-13). Code sets a stored fact aside from the person's words in ONE shape only: the whole message
// is the statement. One exception remains, turn_notes.ts d703ListException: after the lead-in "a few things to know:", later
// sentences may follow, because D70-3 asserts a code-side set-aside on exactly such a message. A later sentence can take the
// statement back in words no list can enumerate, so the exception is known-unsafe. The safe behaviour, asserted here: a list
// message is a NOTE to the model (it asks, or corrects through the person's yes) and code sets nothing aside.
// To accept: amend D70-3 (its staleFactsOf assertion at :186 and its draft assertion at :200 become the note's), delete
// d703ListException and its one call in staleFactsOf, and move this file to tests/architect/.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/pending/fact-withdrawal-no-leadin-20261113.test.ts
import assertNode from "node:assert/strict";
import { CareerRouter } from "../../../supabase/functions/_shared/router_core.career.js";
import { agentTurn } from "../../../supabase/functions/agent-chat/career_brain.ts";
import { factCorrectionHints, staleFactsOf } from "../../../supabase/functions/_shared/agent/turn_notes.ts";

const PERSONA = JSON.parse(Deno.readTextFileSync(new URL("../../../evals/mirror/instinct-wa-batch1/persona.json", import.meta.url)));
const NOW = Date.parse("2026-11-13T03:00:00Z");
function personaProfile() {
  const ctx: any = { now: NOW, thread: {} };
  for (const s of PERSONA.setup.slice(0, 2)) CareerRouter.handleChat(s, ctx);
  return ctx.profile;
}
// Take-backs the exception still lets through on trunk today (three of them remain after round 3), and D70-3's own message.
const LISTS = [
  "a few things to know: the 3.9 gpa is outdated. I am reading aloud what my screen shows today.",
  "a few things to know: the 3.9 gpa is outdated. I meant my sophomore year transcript there.",
  "a few things to know: the 3.9 gpa is outdated. My cat walked across the keyboard just now.",
  "a few things to know: the 3.9 gpa on there is out of date, don't reuse it. I am applying to Stripe next week.",
  PERSONA.setup[2],
];

Deno.test("a list message ('a few things to know: ...') sets nothing aside in code: it is a note to the model", async () => {
  for (const m of LISTS) {
    const profile = personaProfile(), before = JSON.stringify(profile), seen: any[] = [];
    assertNode.deepStrictEqual(staleFactsOf(m, profile.facts), [], m);
    assertNode.ok(factCorrectionHints(m, profile.facts).some((f: any) => f.text === "GPA: 3.9"), `a note naming the GPA: ${m}`);
    const r: any = await agentTurn({ message: m, history: [], stores: { profile }, userId: "u", threadId: "t", now: NOW, model: async (p: any) => { seen.push(p); return { content: [{ type: "text", text: "Which GPA should I use?" }], stop_reason: "end_turn" }; } } as any);
    assertNode.equal(JSON.stringify(profile), before, `storage unchanged: ${m}`);
    assertNode.ok(/MAY BE CORRECTING/.test(seen[0].system) && !r.set_aside);
  }
  // The statement alone, as the whole message, is still code's.
  assertNode.deepStrictEqual(staleFactsOf("the 3.9 gpa is outdated", personaProfile().facts).map((f: any) => f.text), ["GPA: 3.9"]);
});
