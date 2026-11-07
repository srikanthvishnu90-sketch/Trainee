// Greptile on #566: the flag-only reply checks in the agent loop (missing_ack, many_asks, unbacked_promise) must reach the
// saved turn. The loop returns them as `flags`; the career handler copies them into the agent meta as `reply_flags`, which
// is stored with the response and the assistant message.
import { assert } from "jsr:@std/assert@1";

const here = new URL(".", import.meta.url);
const read = (p: string) => Deno.readTextFileSync(new URL(p, here));

Deno.test("RFS-1 the agent loop returns its reply flags", () => {
  const loop = read("../../supabase/functions/_shared/agent/loop.ts");
  assert(/\.\.\.\(flags\.length \? \{ flags \} : \{\}\)/.test(loop), "loop.ts returns flags");
});

Deno.test("RFS-2 the career handler copies the flags into the saved agent meta", () => {
  const h = read("../../supabase/functions/agent-chat/handler-career.ts");
  const at = h.indexOf('agentMeta = { brain: staged.chosen ? "staged" : "agent"');
  assert(at > 0, "agent meta built");
  const stmt = h.slice(at, h.indexOf("};", at) + 2);
  assert(/reply_flags:\s*\(turn as \{ flags: string\[\] \}\)\.flags/.test(stmt), `reply_flags copied: ${stmt.slice(0, 400)}`);
});
