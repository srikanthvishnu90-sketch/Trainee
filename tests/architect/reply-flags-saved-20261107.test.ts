// Greptile on #566/#567: the flag-only reply checks in the agent loop (missing_ack, many_asks, unbacked_promise) must reach
// the saved turn. replyFlagsMeta turns a turn's flags into the meta the career handler saves with the response and the
// assistant message (its agentMeta is spread into the response meta, which the commit stores on the assistant row).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { replyFlagsMeta } from "../../supabase/functions/_shared/agent/loop.ts";

Deno.test("RFS-1 replyFlagsMeta carries the turn's flags, and nothing when there are none", () => {
  assertEquals(replyFlagsMeta({ flags: ["missing_ack", "unbacked_promise"] }), { reply_flags: ["missing_ack", "unbacked_promise"] });
  assertEquals(replyFlagsMeta({ flags: ["many_asks"] }), { reply_flags: ["many_asks"] });
  for (const t of [{}, { flags: [] }, { flags: "missing_ack" }, { flags: [null, "", 3] }, null, undefined]) assertEquals(replyFlagsMeta(t as any), {});
});

Deno.test("RFS-2 the career handler spreads replyFlagsMeta into the agent meta it saves", () => {
  const h = Deno.readTextFileSync(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  const at = h.indexOf('agentMeta = { brain: staged.chosen ? "staged" : "agent"');
  assert(at > 0, "agent meta built");
  assert(/\.\.\.replyFlagsMeta\(turn\b/.test(h.slice(at, h.indexOf("};", at) + 2)), "replyFlagsMeta spread into agentMeta");
  assert(/\.\.\.\(agentMeta \|\| \{\}\)/.test(h), "agentMeta is spread into the response meta");
});
