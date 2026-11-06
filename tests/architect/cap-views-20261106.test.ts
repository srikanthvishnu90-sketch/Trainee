// PR-5 (b)/(c), 2026-11-06: over the per-person daily cap the brain is not tried and code serves real views.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { spendCap, spendLimitsFromEnv, LIMIT_NOTE } from "../../supabase/functions/_shared/career_spend_cap.ts";
import { CHANNEL_REPLIES } from "../../supabase/functions/_shared/channel.ts";
import { rewrites } from "../../supabase/functions/_shared/career_reply_writer.ts";
import { APPROVAL_RULES, capPausedView, capViewFor, isApprovalQuestion, isHelpAsk, CAP_APPROVAL_INTENT, CAP_HELP_INTENT } from "../../supabase/functions/agent-chat/cap_views.ts";

const D5 = "does a text yes send my application, or must I tap a card? what if an answer changes after approval?";
const env = (v: Record<string, string>) => ({ get: (k: string) => v[k] });
let modelCalls = 0;
const model = (() => { modelCalls++; return Promise.reject(new Error("no model call may be made")); }) as never;
const capped = (usd_micros: number) => spendCap({ read: async () => ({ usd_micros, calls: 1 }), limits: spendLimitsFromEnv(env({})), call: model });

Deno.test("exhausted() is true at the limit, false under it, and never calls the model", async () => {
  assertEquals(await capped(50_000).exhausted(), "limit");
  assertEquals(await capped(1_000).exhausted(), null);
  assertEquals(await spendCap({ read: async () => { throw new Error("db"); }, limits: spendLimitsFromEnv(env({})), call: model }).exhausted(), "unread");
  assertEquals(await spendCap({ read: async () => ({ usd_micros: 0, calls: 0 }), limits: spendLimitsFromEnv(env({ CAREER_MODEL_DAILY_USD: "0" })), call: model }).exhausted(), "limit");
  assertEquals(modelCalls, 0);
});

Deno.test("/help over the cap: the help text, the limit note and what still works, no catch-all", () => {
  for (const m of ["/help", "help", "Help!", "/HELP"]) {
    assert(isHelpAsk(m), m);
    const v = capViewFor(m, { now: Date.parse("2026-11-06T12:00:00Z") })!;
    assertEquals(v.intent, CAP_HELP_INTENT);
    assertStringIncludes(v.reply, CHANNEL_REPLIES.help);
    assertStringIncludes(v.reply, LIMIT_NOTE);
    assertStringIncludes(v.reply, "still work");
    assert(!v.reply.includes("I'm not sure which part"));
  }
  assert(!isHelpAsk("help me find a job in Austin"));
});

Deno.test("the approval question over the cap returns every rule", () => {
  assert(isApprovalQuestion(D5));
  const v = capViewFor(D5, { now: 0 })!;
  assertEquals(v.intent, CAP_APPROVAL_INTENT);
  for (const rule of APPROVAL_RULES) assertStringIncludes(v.reply, rule);
  for (const must of ["tap", "10 minutes", "hash", "changed after it was approved", "never approved by that yes", "only opens the card"]) assertStringIncludes(v.reply.toLowerCase(), must.toLowerCase());
  assertStringIncludes(v.reply, LIMIT_NOTE);
});

Deno.test("orders and other questions are not approval-rule views", () => {
  for (const m of ["yes", "approve 2", "apply to the data analyst role at Stripe", "send it", "what jobs are open in Austin?", "yes except 3"]) assertEquals(capViewFor(m, { now: 0 }), null, m);
});

Deno.test("the paused view names the reset time and what still works", () => {
  const v = capPausedView({ now: Date.parse("2026-11-06T23:30:00Z") });
  assertEquals(v.reply.startsWith("AI answers are paused until 2026-11-07 00:00 UTC; these still work:"), true);
  assert(!v.reply.includes("I'm not sure which part"));
});

Deno.test("the reply writer never rewrites a cap view", () => {
  assertEquals(rewrites({ intent: CAP_APPROVAL_INTENT, reply: "x", handler: "cap_view" }, null, { structured: false }), false);
});

Deno.test("the handler asks exhausted() before trying the brain", async () => {
  const src = await Deno.readTextFile(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  const i = src.indexOf("await spend.exhausted()");
  assert(i > 0 && i < src.indexOf("const meter = ledger.track(newMeter())", i - 200) + 1);
  assertStringIncludes(src, "capViewFor(message");
});

Deno.test("a crisis message over the cap gets the 988 reply, with zero model calls", async () => {
  const { crisisReply } = await import("../../supabase/functions/agent-chat/crisis.ts");
  const text = "I don't want to live anymore";
  assert(crisisReply(text));
  assertEquals(await capped(50_000).exhausted(), "limit");
  assertEquals(modelCalls, 0);
  const src = await Deno.readTextFile(new URL("../../supabase/functions/agent-chat/handler-career.ts", import.meta.url));
  const i = src.indexOf("const capCrisis = crisisReply(message)");
  const j = src.indexOf("capViewFor(message", i);
  assert(i > 0 && j > i && j - i < 700, "crisisReply is consulted before capViewFor in the cap branch");
});
