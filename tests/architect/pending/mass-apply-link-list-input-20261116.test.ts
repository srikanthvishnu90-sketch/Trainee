// MASS APPLY CONVERSATIONS (2026-11-16, eval MA14): pasting 122 posting links was refused "message too long" (HTTP 400, the
// 4,000-character cap). A list of links now passes (chat_input.ts linkList); prose over the cap, a huge paste, an oversized
// link or too many links are still refused.
import assertNode from "node:assert/strict";
import { chatInput, LINK_LIST_MAX_LINKS } from "../../../supabase/functions/agent-chat/_shared/chat_input.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const links = (n: number) => Array.from({ length: n }, (_, i) => `https://boards.greenhouse.io/co${i}co/jobs/${8000 + i}`).join("\n");
Deno.test("122 pasted links pass the cap; everything else over it is refused as before", () => {
  const ask = `apply to all of these:\n${links(122)}`;
  eq(ask.length > 4000, true);
  eq(chatInput(ask, null, 4000).ok, true);
  eq(chatInput("x".repeat(4001), null, 4000), { ok: false, error: "message too long" });
  eq(chatInput(`${"please ".repeat(100)}\n${links(122)}`, null, 4000).ok, false, "a long text around the links");
  eq(chatInput(links(LINK_LIST_MAX_LINKS + 1), null, 4000).ok, false, "too many links");
  eq(chatInput(`apply to these:\n${links(122)}\nhttps://x.example/${"a".repeat(600)}`, null, 4000).ok, false, "an oversized link");
});
