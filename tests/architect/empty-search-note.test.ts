// Dev-set H025/H034/H035 (brain-eval run 42133215450): after an empty search the staged brain led with the empty result,
// asked two or three things at once, and pointed at "the role names above" that were never delivered (the loop delivers the
// text after the last tool result). The empty search_jobs result carries how it is used; a result with postings does not.
import { assert, assertEquals as eq } from "jsr:@std/assert@1";
import { careerTools, EMPTY_SEARCH_NOTE } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { careerSystemPrompt } from "../../supabase/functions/_shared/agent/prompt.ts";

const ctx = { userId: "u", threadId: "t", now: 0, state: {} } as any;

Deno.test("empty search: the result is empty and carries the note, word for word", async () => {
  const t = careerTools({ postings: async () => [] }).find((x) => x.name === "search_jobs")!;
  const r: any = await t.run({ query: "software intern" }, ctx);
  eq(r.postings, []);
  eq(r.total, 0);
  eq(r.source, "none");
  eq(r.note, EMPTY_SEARCH_NOTE);
});

Deno.test("empty search note: restate earlier roles, acknowledgement or roles first, one question at most", () => {
  assert(/only the reply you write after this result/.test(EMPTY_SEARCH_NOTE));
  assert(/restate in this reply any roles or routes/.test(EMPTY_SEARCH_NOTE));
  assert(/overwhelmed, stressed or stuck \(acknowledge that first\)/.test(EMPTY_SEARCH_NOTE));
  assert(/two to four roles/.test(EMPTY_SEARCH_NOTE));
  assert(/at most ONE question/.test(EMPTY_SEARCH_NOTE));
});

Deno.test("prompt: the nothing-found rule yields to acknowledgement and roles, with one question at most", () => {
  assert(/Nothing found: say so plainly \(after any acknowledgement or roles the rules above put first, and with one question at\s+most\)/.test(careerSystemPrompt("2026-11-06")));
});
