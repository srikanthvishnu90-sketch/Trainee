// Networking chat gaps (2026-10-28, flow-chat-journey.test.ts GAP 3 and GAP 4), unit level, no database and no network:
//   GAP 3  "I want to reach people at Stripe" is the people ask "who do I know at Stripe" (the people on file, named), and
//          no chat reply on the networking/outreach paths states a daily number, ramp or cap (NO LIMITS, owner 2026-10-27).
//   GAP 4  "where are my emails" / "what's the status of my emails?" are answered from the send rail's own counts
//          (outreachSendStatus), never by the application-status turn.
import assertNode from "node:assert/strict";
import { emailStatusAsk, outreachStatusTurn } from "../../supabase/functions/_shared/career_send_rail.ts";
import { parseNetworkingAsk } from "../../supabase/functions/_shared/career_networking.ts";
import { statusAsk } from "../../supabase/functions/_shared/career_apply_status.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const ROOT = new URL("../..", import.meta.url).pathname;

Deno.test("GAP 3: 'reach people at X' is the who-do-I-know ask; a draft verb still drafts", () => {
  for (const m of ["I want to reach people at Stripe", "reach people at Stripe", "I'd like to connect with people at Stripe", "please contact someone at Stripe"]) {
    eq(parseNetworkingAsk(m), { kind: "who", firm: "Stripe" }, m);
  }
  eq(parseNetworkingAsk("reach out to people at Stripe")?.kind, "draft", "'reach out to' stays a draft ask");
  eq(parseNetworkingAsk("I want to reach a new role"), null);
});

Deno.test("GAP 3: the chat router states no daily number, ramp or cap for outreach", async () => {
  for (const f of ["supabase/functions/_shared/router_core.career.js", "packages/domain/142-career-router.js", "packages/domain/124-career-outreach.js"]) {
    const src = await Deno.readTextFile(`${ROOT}${f}`);
    for (const re of [/what paces this is your daily number/, /a day in your first week/, /a wave send — inside the daily cap|into sends, inside the daily caps/, /never past 30 a day/, /The caps shape the calendar/, /The per-firm cap is checked twice/]) {
      ok(!re.test(src), `${f}: ${re}`);
    }
  }
});

Deno.test("GAP 4: email status asks are recognized; application and replies asks are not", () => {
  for (const m of ["where are my emails", "Where are my emails?", "what's the status of my emails?", "what’s the status of my outreach emails", "did my emails go out yet?", "email status"]) {
    ok(emailStatusAsk(m), m);
    eq(statusAsk(m), null, `the application-status turn leaves it: ${m}`);
  }
  for (const m of ["where are my applications", "who replied", "what's happened with my outreach", "email Maya at Stripe", "where are my contacts at Stripe"]) {
    ok(!emailStatusAsk(m), m);
  }
});

Deno.test("GAP 4: the answer is the rail's counts plus the approved emails not on the rail", async () => {
  const calls: unknown[] = [];
  const rail = { rpc: (name: string, args: { p: unknown }) => { calls.push([name, args]); return Promise.resolve({ data: { counts: { queued: 1 }, accounts: [] }, error: null }); } };
  const r = await outreachStatusTurn({ message: "where are my emails", userId: "u1", rail, approvedNotQueued: async () => 2 });
  ok(r, "answered");
  eq(calls, [["career_send_status", { p: { user: "u1" } }]]);
  eq(r!.intent, "career_outreach_send_status");
  ok(/0 emails sent from your Gmail, 1 waiting to go\./.test(r!.reply), r!.reply);
  ok(/2 emails you approved are not queued to send yet\./.test(r!.reply), r!.reply);
  ok(!/\d+ a day|daily|cap/i.test(r!.reply), r!.reply);
  const none = await outreachStatusTurn({ message: "what's the status of my emails?", userId: "u1", rail: { rpc: () => Promise.resolve({ data: { counts: {} }, error: null }) } });
  eq([none!.status, none!.reply], ["none", "No approved emails have been queued to send from your Gmail yet."]);
  eq(await outreachStatusTurn({ message: "where are my applications", userId: "u1", rail }), null);
  eq(calls.length, 1, "a message that is not the ask reads nothing");
});
